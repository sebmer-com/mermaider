import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export interface FrameworkDetection {
  framework: "superpowers" | "oh-my-codex" | "mixed" | "none";
  outputDir: string;
  evidence: string[];
}

/** Repository-local hints only. The caller must preserve explicit user/configuration choices. */
export async function detectFramework(
  root: string,
): Promise<FrameworkDetection> {
  const evidence = new Set<string>();
  let superpowers = false;
  let omx = false;
  const inspect = async (relative: string) => {
    let current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) return null;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR"
        )
          return null;
        throw error;
      }
    }
    return lstat(current);
  };
  for (const relative of ["docs/superpowers", ".superpowers"]) {
    if ((await inspect(relative))?.isDirectory()) {
      superpowers = true;
      evidence.add(relative);
    }
  }
  for (const relative of [".omx", "omx_wiki"]) {
    if ((await inspect(relative))?.isDirectory()) {
      omx = true;
      evidence.add(relative);
    }
  }
  for (const relative of [
    "AGENTS.md",
    "CLAUDE.md",
    ".codex/config.toml",
    ".claude/settings.json",
    ".agents/plugins/marketplace.json",
  ]) {
    const metadata = await inspect(relative);
    if (!metadata?.isFile() || metadata.size > 256 * 1024) continue;
    const content = await readFile(path.join(root, relative), "utf8");
    if (/\bsuperpowers(?::|\/|\b)/i.test(content)) {
      superpowers = true;
      evidence.add(relative);
    }
    if (/\boh[- ]?my[- ]?codex\b|<!--\s*OMX:|\.omx\//i.test(content)) {
      omx = true;
      evidence.add(relative);
    }
  }
  const framework =
    superpowers && omx
      ? "mixed"
      : superpowers
        ? "superpowers"
        : omx
          ? "oh-my-codex"
          : "none";
  const architecture =
    (await inspect("docs/architecture"))?.isDirectory() === true;
  if (architecture) evidence.add("docs/architecture");
  return {
    framework,
    outputDir: architecture
      ? "docs/architecture/mermaider"
      : framework === "superpowers"
        ? "docs/superpowers/mermaider"
        : "docs/mermaider",
    evidence: [...evidence].sort(),
  };
}
