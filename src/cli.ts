#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  discover,
  initialize,
  update,
  check,
  evidenceFor,
  VERSION,
} from "./engine.js";
import { repoRoot } from "./files.js";
import { stableJson } from "./util.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      families: { type: "string" },
      select: { type: "string" },
      output: { type: "string" },
      path: { type: "string" },
      symbol: { type: "string" },
      provider: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help || !command) {
    console.log(
      "Mermaider: discover | init | update | check | evidence | hook\n\n--repo <directory>  --json\ninit: --families architecture,pipeline,data --select <ids> --output <directory>\nevidence: --path <relative-source> [--symbol <qualified-name>]\nhook: --provider codex|claude|cursor|gemini (JSON stdin)",
    );
    return;
  }
  if (command === "hook") {
    let raw = "";
    for await (const part of process.stdin) raw += part;
    const { handleHook } = await import("./hooks.js");
    const result = await handleHook(
      values.provider || "codex",
      JSON.parse(raw || "{}"),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const root = repoRoot(values.repo || process.cwd());
  if (command === "discover") {
    const result = await discover(root);
    if (values.json) console.log(stableJson(result));
    else {
      for (const d of result.diagrams)
        console.log(
          `${d.id}\t${d.family}\t${d.title} (${d.nodes.length} nodes)`,
        );
      for (const d of result.diagnostics)
        console.error(`${d.severity}: ${d.message}`);
    }
  } else if (command === "init")
    console.log(
      stableJson(
        await initialize(root, {
          families: values.families?.split(","),
          select: values.select?.split(","),
          output: values.output,
        }),
      ),
    );
  else if (command === "evidence") {
    if (!values.path) throw new Error("evidence requires --path");
    console.log(
      stableJson(await evidenceFor(root, values.path, values.symbol)),
    );
  } else if (command === "update" || command === "check") {
    const result = await (command === "update" ? update(root) : check(root));
    if (values.json) console.log(stableJson(result));
    else {
      console.log(
        `${result.ok ? "OK" : "Needs attention"}: ${result.diagrams.length} diagrams, ${result.changed.length} changed paths`,
      );
      for (const d of result.diagnostics)
        console.log(`${d.severity} ${d.code}: ${d.message}`);
    }
    if (!result.ok) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
}
main().catch((error) => {
  console.error(`Mermaider: ${error.message}`);
  process.exitCode = 1;
});
