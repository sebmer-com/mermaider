import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HookStatus } from "./types.js";

const exec = promisify(execFile);
const PROVIDERS = new Set(["codex", "claude", "cursor", "gemini"]);
type Phase = "requested" | "running" | "succeeded" | "failed";
type Event = "start" | "begin" | "tool" | "stop";
const INSTRUCTION_PREFIX = "Mermaider has detected outdated selected diagrams";
interface Attempt {
  fingerprint: string;
  head: string | null;
  phase: Phase;
  session: string;
  turn?: string;
  reminded: boolean;
}
interface State {
  version: 1;
  observedHead: string | null;
  attempts: Attempt[];
  turns?: { session: string; id: string; continued: boolean }[];
}
export interface HookDependencies {
  getStatus(root: string): Promise<HookStatus>;
  env?: NodeJS.ProcessEnv;
  reportError?(message: string): void;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function eventType(
  provider: string,
  input: Record<string, unknown>,
): Event | null {
  const event = text(
    input.hook_event_name ||
      input.hookEventName ||
      input.eventName ||
      input.event,
  );
  if (event === "SessionStart" || event === "sessionStart") return "start";
  if (["UserPromptSubmit", "beforeSubmitPrompt", "BeforeAgent"].includes(event))
    return "begin";
  if (
    [
      "PostToolUse",
      "PostToolUseFailure",
      "postToolUse",
      "postToolUseFailure",
      "AfterTool",
    ].includes(event)
  )
    return "tool";
  if (
    event === "Stop" ||
    (provider === "cursor" && event === "stop") ||
    (provider === "gemini" && event === "AfterAgent")
  )
    return "stop";
  return null;
}
function restricted(input: Record<string, unknown>): boolean {
  const modes = [
    input.permission_mode,
    input.permissionMode,
    input.mode,
    input.execution_mode,
    input.executionMode,
    input.sandbox_mode,
    input.sandboxMode,
    input.approval_mode,
    input.composer_mode,
  ];
  if (
    modes.some((value) =>
      ["plan", "read-only", "readonly", "read_only", "ask"].includes(
        text(value).toLowerCase(),
      ),
    )
  )
    return true;
  return (
    input.read_only === true ||
    input.readOnly === true ||
    input.interrupted === true ||
    input.is_interrupt === true ||
    input.user_interrupted === true ||
    ["aborted", "cancelled", "canceled", "interrupted", "error"].includes(
      text(input.status).toLowerCase(),
    )
  );
}
function isMermaiderWorker(input: Record<string, unknown>): boolean {
  return /^mermaider(?::|[-/]|$)/.test(
    text(input.agent_type || input.agentType || input.subagent_type),
  );
}
function invokesMermaider(input: Record<string, unknown>): boolean {
  const tool = text(input.tool_name || input.toolName);
  const args = object(input.tool_input || input.toolInput);
  return (
    tool === "Skill" &&
    /^\/?mermaider(?::|[-/])/.test(text(args.skill || args.name))
  );
}
function response(
  provider: string,
  event: Event,
  message: string,
): Record<string, unknown> {
  if (provider === "cursor")
    return event === "stop"
      ? { followup_message: message }
      : { additional_context: message };
  if (provider === "gemini")
    return event === "stop"
      ? { decision: "deny", reason: message }
      : {
          hookSpecificOutput: {
            hookEventName: event === "start" ? "SessionStart" : "AfterTool",
            additionalContext: message,
          },
        };
  if (event === "stop") return { decision: "block", reason: message };
  return {
    hookSpecificOutput: {
      hookEventName: event === "start" ? "SessionStart" : "PostToolUse",
      additionalContext: message,
    },
  };
}

async function git(root: string, ...args: string[]): Promise<string> {
  // An inherited Git environment may still point at a different worktree.
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete env[key];
  return (
    await exec("git", ["-C", root, ...args], {
      env,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
async function locations(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<{ root: string; directory: string }> {
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots
    : [];
  const cwd =
    env.MERMAIDER_REPO ||
    text(input.cwd || input.workspace_root || input.workspaceRoot) ||
    env.CURSOR_PROJECT_DIR ||
    (roots.length === 1 ? text(roots[0]) : "");
  if (!cwd) throw new Error("No repository location in hook input");
  const root = await realpath(await git(cwd, "rev-parse", "--show-toplevel"));
  const common = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const key = createHash("sha256").update(root).digest("hex");
  const data =
    env.MERMAIDER_HOOK_DATA || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  return {
    root,
    directory: path.join(data || common, "mermaider", "hooks", key),
  };
}
async function readState(filename: string): Promise<State | null> {
  try {
    const data = JSON.parse(await readFile(filename, "utf8")) as State;
    const invalid = () =>
      Object.assign(new Error("Invalid private hook state"), {
        code: "INVALID_STATE",
      });
    if (!data || data.version !== 1 || !Array.isArray(data.attempts))
      throw invalid();
    if (
      data.attempts.some(
        (a) =>
          typeof a.fingerprint !== "string" ||
          typeof a.session !== "string" ||
          !["requested", "running", "succeeded", "failed"].includes(a.phase),
      )
    )
      throw invalid();
    if (
      data.turns !== undefined &&
      (!Array.isArray(data.turns) ||
        data.turns.some(
          (turn) =>
            typeof turn.session !== "string" ||
            typeof turn.id !== "string" ||
            typeof turn.continued !== "boolean",
        ))
    )
      throw invalid();
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error("Invalid private hook state"), {
        code: "INVALID_STATE",
      });
    throw error;
  }
}
async function saveState(filename: string, state: State): Promise<void> {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state) + "\n", { mode: 0o600 });
    await rename(temp, filename);
  } finally {
    await rm(temp, { force: true });
  }
}
async function acquire(
  directory: string,
): Promise<(() => Promise<void>) | null> {
  const lock = path.join(directory, "lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A crashed/killed hook must not disable updates forever. Five minutes is
    // much longer than the configured short native-hook timeout.
    try {
      if (Date.now() - (await stat(lock)).mtimeMs < 300_000) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const abandoned = `${lock}.${randomUUID()}.abandoned`;
    try {
      await rename(lock, abandoned);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    await rm(abandoned, { recursive: true, force: true });
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  }
  return () => rm(lock, { recursive: true, force: true });
}
function instruction(status: HookStatus): string {
  return (
    `${INSTRUCTION_PREFIX} (input ${status.fingerprint}). ` +
    `Invoke the Mermaider update skill using the existing repository configuration. ` +
    `Inspect the relevant changes, update source-backed models where needed, then run Mermaider update and check. ` +
    `The status describes the current working tree; do not assume it is a clean commit snapshot. ` +
    `Limit writes to the configured Mermaider models and diagram outputs, plus narrowly required repository ` +
    `documentation-review records for files you actually reviewed. Preserve unrelated changes ` +
    `and follow the user's existing commit instructions. Resolve reported model problems only within that scope; ` +
    `if the update remains blocked, report the reason and stop. ` +
    (status.reason ? `Status: ${status.reason}` : "")
  );
}

/** Native adapters only inspect status and return feedback; they never launch an LLM or write diagrams. */
export function createHookHandler(dependencies: HookDependencies) {
  return async function handle(
    provider: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (
      !PROVIDERS.has(provider) ||
      restricted(input) ||
      isMermaiderWorker(input)
    )
      return {};
    const event = eventType(provider, input);
    if (!event) return {};
    // Cursor submits our Stop feedback as a new prompt. It is a continuation,
    // never permission to reset the per-turn loop guard.
    if (event === "begin" && text(input.prompt).startsWith(INSTRUCTION_PREFIX))
      return {};
    const reply = (message: string) => {
      const result = response(provider, event, message);
      if (
        input.hook_event_name === "PostToolUseFailure" &&
        (provider === "claude" || provider === "codex")
      ) {
        object(result.hookSpecificOutput).hookEventName = "PostToolUseFailure";
      }
      return result;
    };
    let configured = false;
    try {
      const { root, directory } = await locations(
        input,
        dependencies.env || process.env,
      );
      const status = await dependencies.getStatus(root);
      if (!status.configured) return {};
      configured = true;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await acquire(directory);
      if (!release) return {};
      try {
        const filename = path.join(directory, "state.json");
        const previous = await readState(filename);
        const state: State = previous || {
          version: 1,
          observedHead: null,
          attempts: [],
        };
        const changedHead = status.head !== state.observedHead;
        const session =
          text(input.session_id || input.sessionId || input.conversation_id) ||
          "unknown-session";
        const externalTurn = text(
          input.turn_id || input.turnId || input.generation_id,
        );
        const continuation =
          input.stop_hook_active === true ||
          input.stopHookActive === true ||
          (typeof input.loop_count === "number" && input.loop_count > 0);
        const turns = (state.turns ||= []);
        let turn = turns.find((value) => value.session === session);
        if (!turn) {
          turn = {
            session,
            id: externalTurn || randomUUID(),
            continued: false,
          };
          turns.push(turn);
        } else if (
          event === "begin" ||
          (externalTurn && externalTurn !== turn.id && !continuation)
        ) {
          turn.id = externalTurn || randomUUID();
          turn.continued = false;
        }
        let attempt = state.attempts.find(
          (item) => item.fingerprint === status.fingerprint,
        );
        const sameTurn = () =>
          attempt?.session === session && attempt.turn === turn.id;
        const save = () =>
          saveState(filename, {
            ...state,
            attempts: state.attempts.slice(-16),
            turns: turns.slice(-16),
          });
        if (event === "begin") {
          await save();
          return {};
        }
        state.observedHead = status.head;

        if (status.current) {
          if (!attempt) {
            attempt = {
              fingerprint: status.fingerprint,
              head: status.head,
              phase: "succeeded",
              session,
              turn: turn.id,
              reminded: false,
            };
            state.attempts.push(attempt);
          } else attempt.phase = "succeeded";
          await save();
          return {};
        }
        // Commit mode is an event gate, not a promise to analyze a clean SHA.
        // Session start reconciles stale diagrams left by an earlier session.
        if (
          status.trigger === "commit" &&
          event !== "start" &&
          !changedHead &&
          !attempt
        ) {
          await save();
          return {};
        }
        if (status.trigger === "commit" && status.head === null) {
          await save();
          return {};
        }

        if (attempt?.phase === "succeeded") {
          // Same inputs can still have missing/tampered generated outputs.
          attempt.phase = "requested";
          attempt.session = session;
          attempt.turn = turn.id;
          attempt.reminded = false;
          await save();
          if (event !== "stop") return reply(instruction(status));
        }
        if (event === "stop") {
          if (continuation || turn.continued) {
            if (attempt && attempt.phase !== "failed") attempt.phase = "failed";
            await save();
            return {};
          }
          if (
            attempt &&
            sameTurn() &&
            (attempt.reminded || attempt.phase === "failed")
          ) {
            await save();
            return {};
          }
          if (!attempt) {
            attempt = {
              fingerprint: status.fingerprint,
              head: status.head,
              phase: "requested",
              session,
              turn: turn.id,
              reminded: true,
            };
            state.attempts.push(attempt);
          } else
            Object.assign(attempt, {
              phase: "requested",
              session,
              turn: turn.id,
              reminded: true,
            });
          turn.continued = true;
          await save();
          return reply(instruction(status));
        }
        if (attempt && sameTurn()) {
          if (invokesMermaider(input) && attempt.phase === "requested")
            attempt.phase = "running";
          await save();
          return {};
        }
        // Each fingerprint is tracked independently, so a newer change is not
        // lost merely because an older fingerprint is already being handled.
        if (!attempt) {
          attempt = {
            fingerprint: status.fingerprint,
            head: status.head,
            phase: "requested",
            session,
            turn: turn.id,
            reminded: false,
          };
          state.attempts.push(attempt);
        } else
          Object.assign(attempt, {
            phase: "requested",
            session,
            turn: turn.id,
            reminded: false,
          });
        await save();
        return reply(instruction(status));
      } finally {
        await release();
      }
    } catch (error) {
      // Keep the turn moving. Only configured repositories surface failures;
      // stderr is diagnostic output, never another maintenance instruction.
      if (configured) {
        const code = text((error as NodeJS.ErrnoException).code);
        const detail = /^[A-Z_]+$/.test(code) ? ` (${code})` : "";
        const message = `Mermaider could not access its private hook state${detail}. Automatic notice skipped; run mermaider check manually and repair the hook-state location.\n`;
        (
          dependencies.reportError ||
          ((message) => {
            process.stderr.write(message);
          })
        )(message);
      }
      return {};
    }
  };
}

export const handleHook = createHookHandler({
  getStatus: async (root) => (await import("./engine.js")).getHookStatus(root),
});
