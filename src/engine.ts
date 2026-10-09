import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseConfig, defaultConfig } from "./config.js";
import {
  readSources,
  safePath,
  git,
  outputPaths,
  managedContent,
  markers,
  evidenceFor,
} from "./files.js";
import { stableJson, sha256 } from "./util.js";
import {
  renderMermaid,
  renderMarkdown,
  validateMermaid,
  diagramEvidence,
} from "./render.js";
import { renderHtml, type HtmlView } from "./html.js";
import { detectFramework } from "./framework.js";
import { infrastructureExtractor } from "./extractors/infrastructure.js";
import { codeExtractor } from "./extractors/code.js";
import { databaseExtractor } from "./extractors/database.js";
import type {
  Config,
  Diagnostic,
  Diagram,
  Extraction,
  HookStatus,
  RunResult,
  Selection,
  SourceFile,
} from "./types.js";

export const VERSION = "0.1.0";
const CONFIG = ".mermaider/config.json",
  MANIFEST = ".mermaider/manifest.json";
const extractors = [infrastructureExtractor, codeExtractor, databaseExtractor];
type Artifact = { path: string; content: string; block?: string };
function sourceLink(output: string, source: string, line?: number): string {
  const relative = path.posix.relative(path.posix.dirname(output), source);
  return (
    encodeURI(relative.startsWith(".") ? relative : "./" + relative).replace(
      /#/g,
      "%23",
    ) + (line ? `#L${line}` : "")
  );
}
type Manifest = {
  version: 1;
  toolVersion: string;
  fingerprint: string;
  files: Array<{ path: string; block?: string; sha256: string }>;
  diagrams: string[];
};
const evidenceSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    symbol: z.string().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const nodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    kind: z.string().optional(),
    evidence: z.array(evidenceSchema),
    attributes: z
      .array(
        z
          .object({
            name: z.string(),
            type: z.string(),
            key: z.enum(["PK", "FK", "UK"]).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const edgeSchema = z
  .object({
    id: z.string().min(1),
    from: z.string(),
    to: z.string(),
    label: z.string().optional(),
    kind: z.string().optional(),
    evidence: z.array(evidenceSchema),
    cardinality: z
      .object({
        from: z.enum(["||", "|o", "o|", "}o", "}|", "o{", "|{"]),
        to: z.enum(["||", "|o", "o|", "}o", "}|", "o{", "|{"]),
      })
      .optional(),
  })
  .strict();
const diagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["warning", "error"]),
  path: z.string().optional(),
  diagramId: z.string().optional(),
});
const diagramSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    family: z.enum([
      "architecture",
      "dependencies",
      "pipeline",
      "data",
      "states",
      "process",
    ]),
    syntax: z.enum(["flowchart", "sequence", "state", "er"]),
    direction: z.enum(["LR", "TD"]).optional(),
    provenance: z.enum(["extracted", "curated"]),
    context: z.enum(["implemented", "planned", "observed"]),
    nodes: z.array(nodeSchema),
    edges: z.array(edgeSchema),
    steps: z
      .array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            label: z.string(),
            kind: z.enum(["message", "reply"]).optional(),
            evidence: z.array(evidenceSchema),
          })
          .strict(),
      )
      .optional(),
    diagnostics: z.array(diagnosticSchema).optional(),
  })
  .strict();
const modelSchema = z
  .object({
    version: z.literal(1),
    review: z.enum(["proposed", "reviewed"]),
    diagram: diagramSchema,
  })
  .strict();

export async function loadConfig(root: string): Promise<Config | null> {
  try {
    return parseConfig(
      JSON.parse(await fs.readFile(await safePath(root, CONFIG), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function readManifest(root: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(
      await fs.readFile(await safePath(root, MANIFEST), "utf8"),
    ) as Manifest;
    if (
      m.version !== 1 ||
      !Array.isArray(m.files) ||
      !Array.isArray(m.diagrams) ||
      !m.diagrams.every((d) => typeof d === "string") ||
      typeof m.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.fingerprint) ||
      typeof m.toolVersion !== "string"
    )
      throw new Error("Invalid Mermaider manifest");
    for (const f of m.files) {
      if (
        !f ||
        typeof f.path !== "string" ||
        typeof f.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        (f.block !== undefined &&
          (typeof f.block !== "string" || !/^[a-zA-Z0-9_-]+$/.test(f.block)))
      )
        throw new Error("Invalid Mermaider manifest file entry");
      await safePath(root, f.path);
    }
    return m;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function toolDigest(): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const result: Array<[string, string]> = [];
  for (const child of ["", "extractors"]) {
    for (const f of (await fs.readdir(path.join(dir, child)))
      .filter((f) => /\.(?:ts|js)$/.test(f))
      .sort()) {
      result.push([
        `${child}/${f}`,
        sha256(await fs.readFile(path.join(dir, child, f))),
      ]);
    }
  }
  const skillRoot = path.resolve(dir, "../skills/mermaider");
  for (const f of ["package.json", "package-lock.json"]) {
    try {
      result.push([f, sha256(await fs.readFile(path.resolve(dir, "..", f)))]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const collect = async (base: string, prefix = ""): Promise<void> => {
    try {
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        const key = prefix + entry.name;
        if (entry.isDirectory())
          await collect(path.join(base, entry.name), key + "/");
        else if (entry.isFile())
          result.push([
            "skill/" + key,
            sha256(await fs.readFile(path.join(base, entry.name))),
          ]);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  };
  await collect(skillRoot);
  return sha256(
    stableJson(result.sort(([a], [b]) => a.localeCompare(b, "en"))),
  );
}
async function inputs(
  root: string,
  config: Config,
): Promise<{ files: SourceFile[]; fingerprint: string }> {
  const files = await readSources(root, config);
  // Explicit models are inputs even if a repository ignore file hides .mermaider.
  for (const s of config.diagrams)
    if (s.model && !files.some((f) => f.path === s.model))
      files.push({
        path: s.model,
        content: await fs.readFile(await safePath(root, s.model), "utf8"),
      });
  // Reviewed evidence is always an input, even outside discovery globs or .gitignore.
  const owned = new Set(outputPaths(config).map((o) => o.path));
  for (const s of config.diagrams)
    if (s.model) {
      const model = modelSchema.parse(
        JSON.parse(files.find((f) => f.path === s.model)!.content),
      );
      for (const e of diagramEvidence(model.diagram)) {
        if (
          owned.has(e.path) ||
          e.path === MANIFEST ||
          e.path.startsWith(".mermaider/")
        )
          throw new Error(
            `Semantic evidence must not depend on Mermaider's own outputs or models: ${e.path}`,
          );
        if (!files.some((f) => f.path === e.path))
          files.push({
            path: e.path,
            content: await fs.readFile(await safePath(root, e.path), "utf8"),
          });
      }
    }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    files,
    fingerprint: sha256(
      stableJson({
        version: VERSION,
        tool: await toolDigest(),
        config,
        files: files
          .filter((f) => f.path !== CONFIG)
          .map((f) => [f.path, sha256(f.content)]),
      }),
    ),
  };
}
export async function getInputFingerprint(root: string): Promise<string> {
  const c = await loadConfig(root);
  if (!c) throw new Error("Mermaider is not configured");
  return (await inputs(root, c)).fingerprint;
}
function extract(files: SourceFile[]): Extraction {
  const result: Extraction = { diagrams: [], diagnostics: [] };
  for (const extractor of extractors) {
    const partial = extractor.extract(
      files.filter((f) => !f.path.startsWith(".mermaider/")),
    );
    result.diagrams.push(...partial.diagrams);
    result.diagnostics.push(...partial.diagnostics);
  }
  result.diagrams.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return result;
}
export async function discover(root: string): Promise<Extraction> {
  const config = (await loadConfig(root)) || defaultConfig();
  return extract(await readSources(root, config));
}
export async function initialize(
  root: string,
  options: { families?: string[]; select?: string[]; output?: string } = {},
): Promise<Config> {
  if (await loadConfig(root))
    throw new Error(
      "Mermaider is already configured; edit its selected scope instead of overwriting it",
    );
  const config = defaultConfig();
  config.outputDir = options.output || (await detectFramework(root)).outputDir;
  const candidates = (await discover(root)).diagrams;
  const selected = options.select
    ? candidates.filter((d) => options.select!.includes(d.id))
    : candidates.filter((d) =>
        (options.families || ["architecture", "pipeline"]).includes(d.family),
      );
  if (options.select?.some((id) => !candidates.some((d) => d.id === id)))
    throw new Error("A selected diagram ID was not discovered");
  config.diagrams = selected.map((d) => ({ id: d.id }));
  config.audience = "both";
  config.detail = "both";
  parseConfig(config);
  const absolute = await safePath(root, CONFIG);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, stableJson(config), { flag: "wx" });
  return config;
}

function validateGraph(d: Diagram): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const ids = new Set(d.nodes.map((n) => n.id));
  const error = (code: string, message: string) =>
    issues.push({ code, message, severity: "error", diagramId: d.id });
  if (ids.size !== d.nodes.length)
    error("DUPLICATE_NODE", "Node IDs must be unique");
  if (new Set(d.edges.map((e) => e.id)).size !== d.edges.length)
    error("DUPLICATE_EDGE", "Edge IDs must be unique");
  if (!d.nodes.length) error("EMPTY_DIAGRAM", "Diagram has no nodes");
  for (const e of [...d.edges, ...(d.steps || [])])
    if (!ids.has(e.from) || !ids.has(e.to))
      error("DANGLING_EDGE", `Unknown endpoint ${e.from} -> ${e.to}`);
  for (const item of [...d.nodes, ...d.edges, ...(d.steps || [])])
    if (!item.evidence.length)
      error(
        "MISSING_EVIDENCE",
        "Every node and relationship requires source evidence",
      );
  return issues;
}
function project(d: Diagram, s: Selection): Diagram {
  let nodes = d.nodes;
  if (s.focus) {
    for (const value of s.focus)
      if (!nodes.some((n) => n.id === value || n.label === value))
        throw new Error(`Projection ${d.id} references unknown node ${value}`);
    nodes = nodes.filter(
      (n) => s.focus!.includes(n.id) || s.focus!.includes(n.label),
    );
  }
  if (s.attributes)
    nodes = nodes.map((n) => ({
      ...n,
      attributes:
        s.attributes === "none"
          ? []
          : s.attributes === "keys"
            ? n.attributes?.filter((a) => a.key)
            : n.attributes,
    }));
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...d,
    title: s.title || d.title,
    nodes,
    edges: d.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    steps: d.steps?.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}
async function prepare(
  root: string,
  config: Config,
  files: SourceFile[],
): Promise<{
  artifacts: Artifact[];
  diagnostics: Diagnostic[];
  diagrams: string[];
}> {
  const extracted = extract(files),
    artifacts: Artifact[] = [],
    diagnostics: Diagnostic[] = [],
    diagrams: string[] = [],
    htmlViews: HtmlView[] = [];
  if (!config.diagrams.length)
    diagnostics.push({
      code: "EMPTY_SCOPE",
      message: "No diagrams selected; run discover and choose a scope",
      severity: "error",
    });
  for (const selection of config.diagrams) {
    try {
      let diagram: Diagram;
      if (selection.model) {
        const model = modelSchema.parse(
          JSON.parse(
            await fs.readFile(await safePath(root, selection.model), "utf8"),
          ),
        );
        if (model.review !== "reviewed")
          throw new Error(`Model ${selection.model} requires semantic review`);
        if (model.diagram.provenance !== "curated")
          throw new Error("Semantic models must declare curated provenance");
        if (model.diagram.id !== selection.id)
          throw new Error("Selected ID must match model diagram ID");
        diagram = model.diagram;
        for (const e of diagramEvidence(diagram)) {
          if (!e.sha256)
            throw new Error(`Missing reviewed source hash: ${e.path}`);
          const current = await evidenceFor(root, e.path, e.symbol);
          if (current.sha256 !== e.sha256)
            throw new Error(
              `Semantic evidence changed: ${e.path}${e.symbol ? ` (${e.symbol})` : ""}; read the change and review the relationship before updating its hash`,
            );
          if (current.line) e.line = current.line;
        }
      } else {
        const found = extracted.diagrams.find((d) => d.id === selection.id);
        if (!found)
          throw new Error(
            `Selected diagram ${selection.id} is no longer discoverable`,
          );
        diagram = diagramSchema.parse(found);
      }
      // Validate full graph before projection; filtering must not hide broken references.
      diagnostics.push(
        ...validateGraph(diagram),
        ...(diagram.diagnostics || []).map((x) => ({
          ...x,
          diagramId: diagram.id,
        })),
        ...extracted.diagnostics.filter((x) => x.diagramId === diagram.id),
      );
      diagram = project(diagram, selection);
      diagnostics.push(...validateGraph(diagram));
      if (
        diagnostics.some(
          (x) => x.diagramId === diagram.id && x.severity === "error",
        )
      )
        continue;
      const mermaid = renderMermaid(diagram);
      await validateMermaid(mermaid);
      htmlViews.push({ diagram, mermaid, projected: Boolean(selection.focus) });
      const name = selection.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const md = selection.output?.markdown || `${config.outputDir}/${name}.md`;
      if (!md.endsWith(".md"))
        throw new Error("Markdown outputs must end in .md");
      const mmd = selection.output
        ? selection.output.mermaid
        : `${config.outputDir}/${name}.mmd`;
      if (mmd && !mmd.endsWith(".mmd"))
        throw new Error("Mermaid outputs must end in .mmd");
      const markdown = renderMarkdown(
        diagram,
        mermaid,
        (e) => sourceLink(md, e.path, e.line),
        Boolean(selection.focus),
      );
      artifacts.push({
        path: md,
        block: selection.output?.block,
        content: selection.output?.block ? "\n" + markdown : markdown,
      });
      if (mmd) artifacts.push({ path: mmd, content: mermaid });
      diagrams.push(diagram.id);
    } catch (e) {
      diagnostics.push({
        code: "DIAGRAM_INVALID",
        message: (e as Error).message,
        severity: "error",
        diagramId: selection.id,
      });
    }
  }
  if (htmlViews.length) {
    const html = config.html || `${config.outputDir}/index.html`;
    artifacts.push({
      path: html,
      content: await renderHtml(htmlViews, (e) =>
        sourceLink(html, e.path, e.line),
      ),
    });
  }
  const seen = new Set<string>();
  for (const a of artifacts) {
    const key = a.path + "#" + (a.block || "");
    if (
      seen.has(key) ||
      artifacts.some(
        (b) => b !== a && b.path === a.path && (!a.block || !b.block),
      )
    )
      diagnostics.push({
        code: "OUTPUT_COLLISION",
        message: `Multiple selections own ${a.path}`,
        severity: "error",
      });
    seen.add(key);
    await safePath(root, a.path);
  }
  return { artifacts, diagnostics, diagrams };
}
async function artifactContent(
  root: string,
  a: { path: string; block?: string },
): Promise<string | null> {
  try {
    const text = await fs.readFile(await safePath(root, a.path), "utf8");
    return a.block ? managedContent(text, a.block).content : text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function lock(root: string): Promise<() => Promise<void>> {
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  const base = common
    ? path.resolve(root, common)
    : path.join(root, ".mermaider/cache");
  const lockpath = path.join(
    base,
    `mermaider-${sha256(path.resolve(root)).slice(0, 12)}.lock`,
  );
  await fs.mkdir(base, { recursive: true });
  try {
    await fs.writeFile(lockpath, `${process.pid}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let alive = true;
    try {
      const pid = Number((await fs.readFile(lockpath, "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Malformed lock; inspect it before removal");
      try {
        process.kill(pid, 0);
      } catch (x) {
        if ((x as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw x;
      }
    } catch (x) {
      throw new Error(
        `Mermaider lock requires inspection: ${(x as Error).message}`,
      );
    }
    if (alive)
      throw new Error(
        "Another Mermaider update is running for this working tree",
      );
    await fs.unlink(lockpath);
    await fs.writeFile(lockpath, `${process.pid}\n`, { flag: "wx" });
  }
  return async () => {
    await fs.unlink(lockpath);
  };
}
export async function run(root: string, write = false): Promise<RunResult> {
  const config = await loadConfig(root);
  if (!config)
    throw new Error(
      "Mermaider is not configured; run discover, then init with the selected scope",
    );
  const release = write ? await lock(root) : async () => {};
  try {
    const input = await inputs(root, config),
      old = await readManifest(root);
    const prepared = await prepare(root, config, input.files);
    const result: RunResult = {
      ok: false,
      fingerprint: input.fingerprint,
      diagrams: prepared.diagrams,
      changed: [],
      diagnostics: prepared.diagnostics,
    };
    if (result.diagnostics.some((d) => d.severity === "error")) return result;
    const snapshots = new Map<string, string | null>();
    const writes = new Map<string, string>();
    for (const a of prepared.artifacts) {
      const full = await fs
        .readFile(await safePath(root, a.path), "utf8")
        .catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
      if (!snapshots.has(a.path)) snapshots.set(a.path, full);
      const current = a.block
        ? full === null
          ? null
          : managedContent(full, a.block).content
        : full;
      if (current === a.content) continue;
      result.changed.push(a.path);
      if (write) {
        const previous = old?.files.find(
          (f) => f.path === a.path && f.block === a.block,
        );
        if (
          current !== null &&
          (!previous || sha256(current) !== previous.sha256)
        ) {
          // An explicitly configured empty managed region is the only adoption case.
          if (!(a.block && current.trim() === "")) {
            result.diagnostics.push({
              code: "OUTPUT_MODIFIED",
              message: `Refusing to overwrite unowned or edited output ${a.path}`,
              severity: "error",
              path: a.path,
            });
            continue;
          }
        }
        if (a.block) {
          if (full === null) {
            result.diagnostics.push({
              code: "BLOCK_MISSING",
              message: `Create the explicitly owned block ${a.block} in ${a.path} first`,
              severity: "error",
            });
            continue;
          }
          const parts = managedContent(writes.get(a.path) ?? full, a.block);
          writes.set(a.path, parts.before + a.content + parts.after);
        } else writes.set(a.path, a.content);
      }
    }
    const manifest: Manifest = {
      version: 1,
      toolVersion: VERSION,
      fingerprint: input.fingerprint,
      diagrams: prepared.diagrams,
      files: prepared.artifacts
        .map((a) => ({
          path: a.path,
          ...(a.block ? { block: a.block } : {}),
          sha256: sha256(a.content),
        }))
        .sort(
          (a, b) =>
            a.path.localeCompare(b.path, "en") ||
            (a.block || "").localeCompare(b.block || "", "en"),
        ),
    };
    const manifestText = stableJson(manifest);
    const oldManifest = await fs
      .readFile(await safePath(root, MANIFEST), "utf8")
      .catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    if (oldManifest !== manifestText) result.changed.push(MANIFEST);
    if (write && !result.diagnostics.some((d) => d.severity === "error")) {
      const currentConfig = await loadConfig(root);
      if (
        !currentConfig ||
        (await inputs(root, currentConfig)).fingerprint !== input.fingerprint
      )
        throw new Error(
          "Sources or configuration changed during analysis; rerun on the new state",
        );
      for (const [p, oldText] of snapshots) {
        const now = await fs
          .readFile(await safePath(root, p), "utf8")
          .catch((e) => {
            if (e.code === "ENOENT") return null;
            throw e;
          });
        if (now !== oldText)
          throw new Error(`Output changed during analysis: ${p}`);
      }
      // Each write is atomic. Manifest goes last: a crash cannot certify partial output.
      for (const [p, content] of [
        ...writes,
        [MANIFEST, manifestText] as [string, string],
      ]) {
        const target = await safePath(root, p);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.mermaider-${process.pid}.tmp`;
        try {
          await fs.writeFile(temporary, content, { flag: "wx" });
          await fs.rename(temporary, target);
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
      }
    }
    if (!write && result.changed.length)
      result.diagnostics.push({
        code: "STALE_OUTPUT",
        message:
          "Generated documentation differs from the current selected inputs; run update",
        severity: "error",
      });
    result.changed = [...new Set(result.changed)].sort();
    result.ok = !result.diagnostics.some((d) => d.severity === "error");
    return result;
  } finally {
    await release();
  }
}
export const update = (root: string) => run(root, true);
export const check = (root: string) => run(root, false);
export async function getHookStatus(root: string): Promise<HookStatus> {
  const head = git(root, ["rev-parse", "HEAD"]);
  try {
    const config = await loadConfig(root);
    if (!config || !config.hooks.enabled)
      return {
        configured: false,
        fingerprint: "",
        current: true,
        blocked: false,
        reason: "Mermaider hooks are not enabled for this repository",
        head,
      };
    const fingerprint = (await inputs(root, config)).fingerprint;
    const manifest = await readManifest(root);
    const ownership = (entries: Array<{ path: string; block?: string }>) =>
      entries.map((e) => `${e.path}#${e.block || ""}`).sort();
    let current =
      manifest?.fingerprint === fingerprint &&
      manifest.toolVersion === VERSION &&
      stableJson(ownership(manifest.files)) ===
        stableJson(ownership(outputPaths(config))) &&
      stableJson(manifest.diagrams) ===
        stableJson(config.diagrams.map((s) => s.id));
    if (current)
      for (const artifact of manifest!.files) {
        const content = await artifactContent(root, artifact);
        if (content === null || sha256(content) !== artifact.sha256) {
          current = false;
          break;
        }
      }
    return {
      configured: true,
      fingerprint,
      current: Boolean(current),
      blocked: false,
      reason: current
        ? "Diagrams match the selected inputs"
        : "Selected diagrams need source review and regeneration",
      head,
      trigger: config.hooks.trigger,
    };
  } catch (e) {
    return {
      configured: true,
      fingerprint: sha256(String(e)),
      current: false,
      blocked: true,
      reason: (e as Error).message,
      head,
    };
  }
}
export { evidenceFor } from "./files.js";
