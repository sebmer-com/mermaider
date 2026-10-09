import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { minimatch } from "minimatch";
import ts from "typescript";
import { sha256 } from "./util.js";
import type { Config, Evidence, SourceFile } from "./types.js";

const ignored = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.local/**",
  "**/.mermaider/cache/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/vendor/**",
];
const extensions =
  /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|sql|md|graphql|prisma)$/i;
export async function safePath(
  root: string,
  relative: string,
): Promise<string> {
  if (
    !relative ||
    nodePath.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some((x) => x === "" || x === "." || x === ".." || x === ".git")
  )
    throw new Error(`Unsafe repository path: ${relative}`);
  const target = nodePath.resolve(root, relative);
  if (!target.startsWith(nodePath.resolve(root) + nodePath.sep))
    throw new Error(`Path leaves repository: ${relative}`);
  let current = nodePath.resolve(root);
  for (const part of relative.split("/")) {
    current = nodePath.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Symlink paths are not supported: ${relative}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}
export function git(root: string, args: string[]): string | null {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      maxBuffer: 32 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return null;
  }
}
export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]) || nodePath.resolve(cwd);
}
export function outputPaths(
  config: Config,
): Array<{ path: string; block?: string }> {
  return [
    { path: config.html || `${config.outputDir}/index.html` },
    ...config.diagrams.flatMap((s) => {
      const name = s.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      return s.output
        ? [
            { path: s.output.markdown, block: s.output.block },
            ...(s.output.mermaid ? [{ path: s.output.mermaid }] : []),
          ]
        : [
            { path: `${config.outputDir}/${name}.md` },
            { path: `${config.outputDir}/${name}.mmd` },
          ];
    }),
  ];
}
export function markers(block: string): { start: string; end: string } {
  return {
    start: `<!-- mermaider:${block}:start -->`,
    end: `<!-- mermaider:${block}:end -->`,
  };
}
export function managedContent(
  text: string,
  block: string,
): { before: string; content: string; after: string } {
  const { start, end } = markers(block);
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (
    a < 0 ||
    b < a ||
    text.indexOf(start, a + start.length) >= 0 ||
    text.indexOf(end, b + end.length) >= 0
  )
    throw new Error(`Missing, repeated or reversed Mermaider block ${block}`);
  return {
    before: text.slice(0, a + start.length),
    content: text.slice(a + start.length, b),
    after: text.slice(b),
  };
}
async function walk(root: string, dir = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(nodePath.join(root, dir), {
    withFileTypes: true,
  })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (
      ignored.some((g) =>
        minimatch(path + (entry.isDirectory() ? "/x" : ""), g, { dot: true }),
      )
    )
      continue;
    if (entry.isDirectory()) result.push(...(await walk(root, path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
export async function readSources(
  root: string,
  config: Config,
): Promise<SourceFile[]> {
  const raw = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const paths =
    raw === null ? await walk(root) : raw.split("\0").filter(Boolean);
  const outputs = outputPaths(config);
  const files: SourceFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (
      path === ".mermaider/manifest.json" ||
      ignored.some((g) => minimatch(path, g, { dot: true }))
    )
      continue;
    if (
      !extensions.test(path) ||
      (!path.startsWith(".mermaider/") &&
        (!config.include.some((g) => minimatch(path, g, { dot: true })) ||
          config.exclude.some((g) => minimatch(path, g, { dot: true }))))
    )
      continue;
    const owned = outputs.filter((o) => o.path === path);
    if (owned.some((o) => !o.block)) continue;
    try {
      const absolute = await safePath(root, path);
      const stat = await fs.stat(absolute);
      if (stat.size > 10 * 1024 * 1024)
        throw new Error(`Source exceeds 10 MiB limit: ${path}`);
      let content = await fs.readFile(absolute, "utf8");
      for (const output of owned) {
        const part = managedContent(content, output.block!);
        content = part.before + "\n" + part.after;
      }
      files.push({ path, content });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return files;
}
export async function evidenceFor(
  root: string,
  path: string,
  symbol?: string,
): Promise<Evidence> {
  const content = await fs.readFile(await safePath(root, path), "utf8");
  if (!symbol) return { path, sha256: sha256(content) };
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: ts.Node[] = [];
  const visit = (node: ts.Node, parents: string[]) => {
    let name: string | undefined;
    const declaration =
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isModuleDeclaration(node);
    if (
      declaration &&
      "name" in node &&
      node.name &&
      typeof node.name === "object" &&
      "getText" in node.name
    )
      name = (node.name as ts.Node).getText(source).replace(/^['"]|['"]$/g, "");
    const chain = name ? [...parents, name] : parents;
    if (name && (name === symbol || chain.join(".") === symbol))
      found.push(node);
    ts.forEachChild(node, (n) => visit(n, chain));
  };
  visit(source, []);
  if (found.length !== 1)
    throw new Error(
      `Symbol ${symbol} in ${path} resolves to ${found.length} declarations; use a unique qualified symbol`,
    );
  return {
    path,
    symbol,
    line:
      source.getLineAndCharacterOfPosition(found[0].getStart(source)).line + 1,
    sha256: sha256(found[0].getText(source)),
  };
}
