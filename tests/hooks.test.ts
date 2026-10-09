import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createHookHandler } from "../src/hooks.js";
import type { HookStatus } from "../src/types.js";

const exec = promisify(execFile);
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  patch: Partial<HookStatus> = {},
) {
  const temp = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mermaider hooks ")),
  );
  t.after(() => rm(temp, { recursive: true, force: true }));
  await exec("git", ["init", "-q", temp]);
  let status: HookStatus = {
    configured: true,
    fingerprint: "source-a",
    current: false,
    blocked: false,
    reason: "Selected diagrams are stale",
    head: "commit-a",
    trigger: "changes",
    ...patch,
  };
  const roots: string[] = [];
  const handler = createHookHandler({
    env: {},
    getStatus: async (root) => {
      roots.push(root);
      return { ...status };
    },
  });
  const input = (
    event = "PostToolUse",
    extra: Record<string, unknown> = {},
  ) => ({
    cwd: temp,
    session_id: "session-a",
    hook_event_name: event,
    ...extra,
  });
  const statePath = path.join(
    temp,
    ".git",
    "mermaider",
    "hooks",
    createHash("sha256").update(temp).digest("hex"),
    "state.json",
  );
  return {
    temp,
    handler,
    input,
    roots,
    statePath,
    set: (patch: Partial<HookStatus>) => {
      status = { ...status, ...patch };
    },
  };
}
function context(result: Record<string, unknown>): string {
  return String(
    (result.hookSpecificOutput as Record<string, unknown>)?.additionalContext ||
      "",
  );
}

test("Codex hook asks the existing agent once; a changed input is not lost while the first is pending", async (t) => {
  const f = await fixture(t);
  assert.match(
    context(await f.handler("codex", f.input())),
    /Mermaider update skill/,
  );
  assert.deepEqual(await f.handler("codex", f.input()), {});
  f.set({ fingerprint: "source-b" });
  assert.match(context(await f.handler("codex", f.input())), /source-b/);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.deepEqual(
    state.attempts.map((a: { fingerprint: string }) => a.fingerprint),
    ["source-a", "source-b"],
  );
  assert.equal(
    (await exec("git", ["-C", f.temp, "status", "--porcelain"])).stdout,
    "",
  );
});

test("Stop continues at most once for an unchanged fingerprint in a session", async (t) => {
  const f = await fixture(t);
  await f.handler("claude", f.input());
  assert.equal((await f.handler("claude", f.input("Stop"))).decision, "block");
  assert.deepEqual(await f.handler("claude", f.input("Stop")), {});
  assert.deepEqual(
    await f.handler("claude", f.input("Stop", { stop_hook_active: true })),
    {},
  );
  assert.deepEqual(await f.handler("claude", f.input()), {});
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.attempts[0].phase, "failed");
  assert.match(
    context(
      await f.handler(
        "claude",
        f.input("SessionStart", { session_id: "session-b" }),
      ),
    ),
    /source-a/,
  );
});

test("a Stop hook already continuing the agent never creates another continuation", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.handler("codex", f.input("Stop", { stop_hook_active: true })),
    {},
  );
});

test("changing fingerprints cannot reset a turn continuation budget, but a real next prompt can", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.handler("claude", f.input("Stop"))).decision, "block");
  f.set({ fingerprint: "source-b" });
  assert.match(context(await f.handler("claude", f.input())), /source-b/);
  assert.deepEqual(await f.handler("claude", f.input("Stop")), {});
  await f.handler(
    "claude",
    f.input("UserPromptSubmit", { prompt: "Continue the maintenance work." }),
  );
  assert.match(context(await f.handler("claude", f.input())), /source-b/);
  assert.equal((await f.handler("claude", f.input("Stop"))).decision, "block");
});

test("generated follow-up prompts cannot reset the continuation budget", async (t) => {
  const f = await fixture(t);
  const first = await f.handler("cursor", f.input("stop"));
  await f.handler(
    "cursor",
    f.input("beforeSubmitPrompt", { prompt: first.followup_message }),
  );
  f.set({ fingerprint: "source-b" });
  assert.deepEqual(await f.handler("cursor", f.input("stop")), {});
});

test("native turn identifiers allow a later human turn without session-wide suppression", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.handler("codex", f.input("Stop", { turn_id: "turn-a" }))).decision,
    "block",
  );
  assert.deepEqual(
    await f.handler(
      "codex",
      f.input("Stop", { turn_id: "turn-b", stop_hook_active: true }),
    ),
    {},
  );
  assert.equal(
    (await f.handler("codex", f.input("Stop", { turn_id: "turn-c" }))).decision,
    "block",
  );
});

test("success quiets the hook; missing generated files can be repaired with identical source inputs", async (t) => {
  const f = await fixture(t);
  await f.handler("claude", f.input());
  f.set({ current: true });
  assert.deepEqual(await f.handler("claude", f.input("Stop")), {});
  assert.equal(
    JSON.parse(await readFile(f.statePath, "utf8")).attempts[0].phase,
    "succeeded",
  );
  f.set({ current: false, reason: "Generated file missing" });
  assert.match(
    context(await f.handler("claude", f.input())),
    /Generated file missing/,
  );
  assert.deepEqual(await f.handler("claude", f.input()), {});
});

test("hooks do not inspect or mutate when plan/read-only/interrupted or inside their own worker", async (t) => {
  const f = await fixture(t);
  for (const fields of [
    { permission_mode: "plan" },
    { sandbox_mode: "read-only" },
    { composer_mode: "ask" },
    { interrupted: true },
    { is_interrupt: true },
    { status: "aborted" },
    { agent_type: "mermaider:update" },
  ]) {
    assert.deepEqual(await f.handler("claude", f.input("Stop", fields)), {});
  }
  assert.equal(f.roots.length, 0);
  assert.equal(
    (await readdir(path.join(f.temp, ".git"))).includes("mermaider"),
    false,
  );
});

test("unconfigured repositories are silent and leave no hook state", async (t) => {
  const f = await fixture(t, { configured: false });
  assert.deepEqual(await f.handler("claude", f.input()), {});
  assert.equal(
    (await readdir(path.join(f.temp, ".git"))).includes("mermaider"),
    false,
  );
});

test("configured private-state filesystem failures are visible without a blocking response", async (t) => {
  const f = await fixture(t);
  const data = path.join(f.temp, ".git", "not-a-directory");
  await writeFile(data, "occupied");
  const diagnostics: string[] = [];
  const status: HookStatus = {
    configured: true,
    current: false,
    blocked: false,
    fingerprint: "f",
    head: null,
    reason: "",
  };
  const handler = createHookHandler({
    env: { MERMAIDER_HOOK_DATA: data },
    getStatus: async () => status,
    reportError: (message) => diagnostics.push(message),
  });
  assert.deepEqual(await handler("claude", f.input("Stop")), {});
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /private hook state.*Automatic notice skipped/);
  assert.match(diagnostics[0], /mermaider check manually/);
  diagnostics.length = 0;
  status.configured = false;
  assert.deepEqual(await handler("claude", f.input()), {});
  assert.deepEqual(
    await handler("claude", f.input("Stop", { cwd: "/missing-repo" })),
    {},
  );
  assert.equal(diagnostics.length, 0);
});

test("corrupt private state reports a nonblocking diagnostic and is preserved instead of resetting the guard", async (t) => {
  const f = await fixture(t);
  await f.handler("claude", f.input());
  await writeFile(f.statePath, "{broken");
  const diagnostics: string[] = [];
  const handler = createHookHandler({
    env: {},
    getStatus: async () => ({
      configured: true,
      current: false,
      blocked: false,
      fingerprint: "source-a",
      head: "commit-a",
      reason: "",
    }),
    reportError: (message) => diagnostics.push(message),
  });
  assert.deepEqual(await handler("claude", f.input("Stop")), {});
  assert.match(diagnostics[0], /INVALID_STATE/);
  assert.equal(await readFile(f.statePath, "utf8"), "{broken");
});

test("blocked semantic models generate one actionable request, not an unbounded error loop", async (t) => {
  const f = await fixture(t, {
    blocked: true,
    reason: "Model needs semantic review",
  });
  assert.match(
    context(await f.handler("claude", f.input())),
    /semantic review/,
  );
  assert.deepEqual(await f.handler("claude", f.input()), {});
  assert.equal((await f.handler("claude", f.input("Stop"))).decision, "block");
  assert.deepEqual(
    await f.handler("claude", f.input("Stop", { stop_hook_active: true })),
    {},
  );
});

test("commit trigger ignores uncommitted drift then detects changed HEAD without parsing command text", async (t) => {
  const f = await fixture(t, { current: true, trigger: "commit" });
  await f.handler("claude", f.input("SessionStart"));
  f.set({ current: false, fingerprint: "source-b" });
  assert.deepEqual(await f.handler("claude", f.input()), {});
  assert.deepEqual(await f.handler("claude", f.input("Stop")), {});
  f.set({ head: "commit-b" });
  await f.handler(
    "claude",
    f.input("UserPromptSubmit", { prompt: "Review the new commit." }),
  );
  assert.match(
    context(
      await f.handler(
        "claude",
        f.input("PostToolUse", { tool_name: "OtherTool", tool_input: {} }),
      ),
    ),
    /source-b/,
  );
});

test("SessionStart reconciles stale previous-session outputs, and commit mode waits in an unborn repository", async (t) => {
  const f = await fixture(t, { trigger: "commit", head: null });
  assert.deepEqual(await f.handler("claude", f.input("SessionStart")), {});
  f.set({ head: "first-commit" });
  assert.match(
    context(await f.handler("claude", f.input("SessionStart"))),
    /source-a/,
  );
});

test("concurrent native events emit a single request", async (t) => {
  const f = await fixture(t);
  const outputs = await Promise.all(
    Array.from({ length: 8 }, () => f.handler("codex", f.input())),
  );
  assert.equal(
    outputs.filter((item) => Object.keys(item).length > 0).length,
    1,
  );
});

test("an observed skill invocation enters running state; changes during it still receive feedback", async (t) => {
  const f = await fixture(t);
  await f.handler("claude", f.input());
  await f.handler(
    "claude",
    f.input("PostToolUse", {
      tool_name: "Skill",
      tool_input: { skill: "mermaider:update" },
    }),
  );
  assert.equal(
    JSON.parse(await readFile(f.statePath, "utf8")).attempts[0].phase,
    "running",
  );
  f.set({ fingerprint: "source-b" });
  assert.match(context(await f.handler("claude", f.input())), /source-b/);
});

test("failure feedback preserves its native event name", async (t) => {
  const f = await fixture(t);
  const output = await f.handler("claude", f.input("PostToolUseFailure"));
  assert.equal(
    (output.hookSpecificOutput as Record<string, unknown>).hookEventName,
    "PostToolUseFailure",
  );
});

test("experimental Cursor and Gemini adapters return their distinct response contracts", async (t) => {
  const cursor = await fixture(t);
  assert.match(
    String(
      (await cursor.handler("cursor", cursor.input("sessionStart")))
        .additional_context,
    ),
    /Mermaider/,
  );
  assert.match(
    String(
      (await cursor.handler("cursor", cursor.input("stop", { loop_count: 0 })))
        .followup_message,
    ),
    /Mermaider/,
  );
  assert.deepEqual(
    await cursor.handler("cursor", cursor.input("stop", { loop_count: 1 })),
    {},
  );
  const gemini = await fixture(t);
  const result = await gemini.handler("gemini", gemini.input("AfterTool"));
  assert.equal(
    (result.hookSpecificOutput as Record<string, unknown>).hookEventName,
    "AfterTool",
  );
  assert.equal(
    (await gemini.handler("gemini", gemini.input("AfterAgent"))).decision,
    "deny",
  );
});

test("MERMAIDER_REPO selects the configured repository and state can live in provider private data", async (t) => {
  const f = await fixture(t);
  let actualRoot = "";
  const handler = createHookHandler({
    env: {
      MERMAIDER_REPO: f.temp,
      PLUGIN_DATA: path.join(f.temp, ".git", "plugin-data"),
    },
    getStatus: async (root) => {
      actualRoot = root;
      return {
        configured: true,
        current: false,
        blocked: false,
        fingerprint: "f",
        head: null,
        reason: "",
      };
    },
  });
  assert.match(
    context(
      await handler("codex", f.input("PostToolUse", { cwd: "/missing" })),
    ),
    /Mermaider/,
  );
  assert.equal(actualRoot, f.temp);
  assert.deepEqual(await handler("unsupported", f.input()), {});
});

test("linked worktrees use separate state keys in the common Git directory", async (t) => {
  const f = await fixture(t);
  await exec("git", [
    "-C",
    f.temp,
    "-c",
    "user.name=Mermaider Test",
    "-c",
    "user.email=tests@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const linked = path.join(f.temp, "linked");
  await exec("git", [
    "-C",
    f.temp,
    "worktree",
    "add",
    "--detach",
    linked,
    "HEAD",
  ]);
  assert.match(context(await f.handler("claude", f.input())), /Mermaider/);
  assert.match(
    context(await f.handler("claude", f.input("PostToolUse", { cwd: linked }))),
    /Mermaider/,
  );
  assert.equal(
    (await readdir(path.join(f.temp, ".git", "mermaider", "hooks"))).length,
    2,
  );
});

test("bootstrap fails open with JSON and installation guidance when the plugin has not been built", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.temp, "hooks"));
  const bootstrap = path.join(f.temp, "hooks", "run.mjs");
  await copyFile(new URL("../hooks/run.mjs", import.meta.url), bootstrap);
  const result = await exec(process.execPath, [bootstrap, "codex"]);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.match(result.stderr, /npm ci and npm run build/);
  assert.equal((await readdir(f.temp)).includes("node_modules"), false);
});

test("bootstrap loads the sibling built CLI with the correct provider without changing working directory", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.temp, "hooks"));
  await mkdir(path.join(f.temp, "dist"));
  const bootstrap = path.join(f.temp, "hooks", "run.mjs");
  await copyFile(new URL("../hooks/run.mjs", import.meta.url), bootstrap);
  await writeFile(
    path.join(f.temp, "dist", "cli.js"),
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));",
  );
  const result = await exec(process.execPath, [bootstrap, "claude"], {
    cwd: f.temp,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["hook", "--provider", "claude"],
    cwd: f.temp,
  });
  assert.equal(result.stderr, "");
});
