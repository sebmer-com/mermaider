#!/usr/bin/env node
// Bootstrap only: never install packages, build source, or start a second agent.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const provider = process.argv[2];
const entry = new URL("../dist/cli.js", import.meta.url);
if (!["codex", "claude", "cursor", "gemini"].includes(provider)) {
  process.stdout.write("{}\n");
} else {
  try {
    await access(entry);
    process.argv = [
      process.execPath,
      fileURLToPath(entry),
      "hook",
      "--provider",
      provider,
    ];
    await import(entry.href);
  } catch (error) {
    process.stderr.write(
      `Mermaider hook unavailable: ${error.message}. Build the installed checkout with npm ci and npm run build.\n`,
    );
    process.stdout.write("{}\n");
  }
}
