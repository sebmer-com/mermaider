import path from "node:path";
import { parseDocument, LineCounter } from "yaml";
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type ParseError,
  type Node as JsonNode,
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { minimatch } from "minimatch";
import type {
  Diagram,
  Diagnostic,
  Evidence,
  Extraction,
  Extractor,
  SourceFile,
} from "../types.js";
import { stableId } from "../util.js";

type ObjectValue = Record<string, unknown>;
type Parsed = {
  file: SourceFile;
  value: ObjectValue;
  at: (keys: (string | number)[]) => Evidence;
};
const object = (v: unknown): ObjectValue | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as ObjectValue)
    : undefined;
const entries = (v: unknown): [string, unknown][] =>
  Object.entries(object(v) ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"));
const dynamic = (v: string) => /\$\{|\{\{|<[^>]+>/.test(v);
const literal = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !dynamic(v);
const lineAt = (file: SourceFile, offset: number): Evidence => ({
  path: file.path,
  line: file.content.slice(0, offset).split("\n").length,
});
const evidence = (file: SourceFile): Evidence => ({ path: file.path, line: 1 });

function diagram(
  prefix: string,
  file: SourceFile,
  title: string,
  family: Diagram["family"],
  suffix = "",
): Diagram {
  return {
    id: stableId(prefix, file.path + suffix),
    title,
    family,
    syntax: "flowchart",
    provenance: "extracted",
    context: "implemented",
    nodes: [],
    edges: [],
    diagnostics: [],
  };
}
function warn(
  d: Diagram,
  code: string,
  message: string,
  file: SourceFile,
): void {
  d.diagnostics!.push({
    code,
    message,
    severity: "warning",
    path: file.path,
    diagramId: d.id,
  });
}
function node(
  d: Diagram,
  key: string,
  label: string,
  kind: string,
  refs: Evidence[],
): string {
  const id = stableId("n", `${d.id}:${key}`);
  if (!d.nodes.some((n) => n.id === id))
    d.nodes.push({ id, label, kind, evidence: refs });
  return id;
}
function edge(
  d: Diagram,
  from: string,
  to: string,
  label: string,
  refs: Evidence[],
  key = label,
): void {
  const id = stableId("e", `${d.id}:${from}:${to}:${key}`);
  if (!d.edges.some((e) => e.id === id))
    d.edges.push({ id, from, to, label, evidence: refs });
}
function parseJson(file: SourceFile, comments: boolean): Parsed {
  const errors: ParseError[] = [];
  const tree = parseTree(file.content, errors, {
    allowTrailingComma: comments,
    disallowComments: !comments,
  });
  if (!tree || errors.length)
    throw new Error(
      "Invalid JSON" +
        (comments ? "/JSONC" : "") +
        ` (${errors.length} syntax error(s))`,
    );
  const value = object(getNodeValue(tree));
  if (!value) throw new Error("Expected a top-level object");
  return {
    file,
    value,
    at: (keys) =>
      lineAt(file, (findNodeAtLocation(tree as JsonNode, keys) ?? tree).offset),
  };
}

function github(file: SourceFile): Diagram {
  const lines = new LineCounter();
  const doc = parseDocument(file.content, { lineCounter: lines });
  if (doc.errors.length) throw new Error("Invalid workflow YAML");
  const value = object(doc.toJS({ maxAliasCount: 100 }));
  if (!value) throw new Error("Expected a workflow mapping");
  const d = diagram(
    "ci",
    file,
    `${typeof value.name === "string" ? value.name : file.path} — declared CI jobs`,
    "pipeline",
  );
  const at = (keys: string[]): Evidence => {
    const parsed = doc.getIn(keys, true) as
      | { range?: [number, number, number] }
      | undefined;
    return parsed?.range
      ? { path: file.path, line: lines.linePos(parsed.range[0]).line }
      : evidence(file);
  };
  if (doc.warnings.length)
    warn(
      d,
      "yaml-warnings",
      "Workflow YAML contains parser warnings; review unsupported tags or constructs.",
      file,
    );
  const jobs = object(value.jobs);
  if (!jobs) {
    warn(
      d,
      "workflow-jobs-unresolved",
      "No static jobs mapping was found.",
      file,
    );
    return d;
  }
  const ids = new Map<string, string>();
  for (const [name, raw] of entries(jobs)) {
    const job = object(raw);
    const parts = [name];
    if (job?.name && typeof job.name === "string" && job.name !== name)
      parts.push(job.name);
    if (job?.if !== undefined) {
      const condition = String(job.if);
      const normalized = `if: ${condition.replace(/\s+/g, " ").trim()}`;
      parts.push(
        normalized.length > 100 ? normalized.slice(0, 99) + "…" : normalized,
      );
      if (normalized.length > 100 || /[\r\n]/.test(condition)) {
        const reference = at(["jobs", name, "if"]);
        warn(
          d,
          "workflow-condition-detail",
          `Job ${name} has a compacted condition label; exact condition from ${file.path}:${reference.line ?? 1}:\n${condition}`,
          file,
        );
      }
    }
    if (job?.uses !== undefined) parts.push(`reusable: ${String(job.uses)}`);
    if (object(job?.strategy)?.matrix !== undefined)
      parts.push("matrix (not expanded)");
    ids.set(
      name,
      node(d, `job:${name}`, parts.join("\n"), "job", [at(["jobs", name])]),
    );
    if (!job)
      warn(
        d,
        "workflow-job-unresolved",
        `Job ${name} is not a static mapping.`,
        file,
      );
  }
  for (const [name, raw] of entries(jobs)) {
    const needs = object(raw)?.needs;
    if (needs === undefined) continue;
    for (const dep of Array.isArray(needs) ? needs : [needs]) {
      if (!literal(dep)) {
        warn(
          d,
          "workflow-needs-unresolved",
          `Job ${name} has a dynamic or unsupported needs value; no dependency was inferred.`,
          file,
        );
        continue;
      }
      let from = ids.get(dep);
      if (!from) {
        from = node(
          d,
          `missing-job:${dep}`,
          `${dep}\n(undeclared job)`,
          "unresolved",
          [at(["jobs", name, "needs"])],
        );
        warn(
          d,
          "workflow-missing-job",
          `Job ${name} refers to undeclared job ${dep}.`,
          file,
        );
      }
      edge(d, from, ids.get(name)!, "needs", [at(["jobs", name, "needs"])]);
    }
  }
  return d;
}

const resourceArrays: [string, string, string[]][] = [
  ["d1_databases", "D1 database", ["database_name"]],
  ["r2_buckets", "R2 bucket", ["bucket_name"]],
  ["kv_namespaces", "KV namespace", []],
  ["hyperdrive", "Hyperdrive", []],
  ["vectorize", "Vectorize index", ["index_name"]],
  ["services", "Worker service", ["service", "entrypoint"]],
  ["workflows", "Workflow", ["name", "class_name", "script_name"]],
  ["vpc_services", "VPC service", []],
  ["analytics_engine_datasets", "Analytics dataset", ["dataset"]],
  ["dispatch_namespaces", "Dispatch namespace", ["namespace"]],
  ["pipelines", "Pipeline", ["pipeline"]],
  ["send_email", "Email binding", []],
  ["ratelimits", "Rate limiter", []],
  ["mtls_certificates", "mTLS certificate", []],
];

function wrangler(parsed: Parsed, all: Parsed[]): Diagram[] {
  const { file, value, at } = parsed;
  const scopes: [string, ObjectValue, (string | number)[]][] = [
    ["", value, []],
  ];
  for (const [name, raw] of entries(value.env)) {
    scopes.push([name, object(raw) ?? {}, ["env", name]]);
  }
  return scopes.map(([environment, config, prefix]) => {
    const template =
      /(?:^|[./_-])(example|template)(?:[./_-]|$)/i.test(file.path) ||
      (typeof config.name === "string" && dynamic(config.name));
    const title = `${file.path}${environment ? ` — env ${environment}` : ""} — declared resources${template ? " (template)" : ""}`;
    const d = diagram(
      "architecture",
      file,
      title,
      "architecture",
      environment ? `#env:${environment}` : "",
    );
    const worker = node(
      d,
      "worker",
      `${typeof config.name === "string" ? config.name : "Worker"}${environment ? ` [${environment}]` : ""}\n${template ? "configuration template" : "declared configuration"}`,
      "worker",
      [at([...prefix, "name"])],
    );
    if (!environment && value.env !== undefined && !object(value.env))
      warn(
        d,
        "wrangler-environment-unresolved",
        "env is not a static environment mapping.",
        file,
      );
    if (environment && !object(object(value.env)?.[environment]))
      warn(
        d,
        "wrangler-environment-unresolved",
        `Environment ${environment} is not a static object.`,
        file,
      );
    if (environment)
      warn(
        d,
        "wrangler-environment-view",
        "This view contains declarations in this environment block only; inheritance and overrides are not resolved.",
        file,
      );
    const addResource = (
      raw: unknown,
      keys: (string | number)[],
      kind: string,
      fields: string[],
      defaultName?: string,
    ) => {
      const binding = object(raw);
      if (!binding) {
        warn(
          d,
          "wrangler-binding-unresolved",
          `Unsupported ${kind} declaration at ${keys.join(".")}.`,
          file,
        );
        return;
      }
      const name =
        binding.binding ?? binding.name ?? binding.class_name ?? defaultName;
      if (typeof name !== "string") {
        warn(
          d,
          "wrangler-binding-unresolved",
          `${kind} has no static binding/name at ${keys.join(".")}.`,
          file,
        );
      }
      const parts = [kind, typeof name === "string" ? name : "(unnamed)"];
      for (const field of fields)
        if (typeof binding[field] === "string" && binding[field] !== name)
          parts.push(`${field}: ${binding[field]}`);
      const resource = node(d, keys.join("."), parts.join("\n"), "resource", [
        at(keys),
      ]);
      edge(d, worker, resource, "declares", [at(keys)]);
      if (
        [name, ...fields.map((field) => binding[field])].some(
          (v) => typeof v === "string" && dynamic(v),
        )
      ) {
        warn(
          d,
          "wrangler-placeholder",
          `Resource at ${keys.join(".")} contains a placeholder; its deployed target is unknown.`,
          file,
        );
      }
      const target =
        kind === "Worker service"
          ? binding.service
          : kind === "Durable Object" || kind === "Workflow"
            ? binding.script_name
            : undefined;
      if (literal(target)) {
        // A source match proves a named declaration, not a live deployment or an environment choice.
        const matches = all.filter(
          (p) =>
            p.value.name === target &&
            !environment &&
            !/\b(example|template)\b/i.test(p.file.path),
        );
        const targetId = node(
          d,
          `worker-reference:${target}`,
          `${target}\nWorker reference`,
          "worker-reference",
          [at(keys), ...matches.map((p) => p.at(["name"]))],
        );
        edge(d, resource, targetId, "references worker", [at(keys)]);
        if (matches.length > 1)
          warn(
            d,
            "wrangler-worker-ambiguous",
            `Multiple configurations declare Worker ${target}; deployment identity is unresolved.`,
            file,
          );
      }
    };
    for (const [key, kind, fields] of resourceArrays) {
      const resources = config[key];
      if (resources === undefined) continue;
      if (!Array.isArray(resources)) {
        warn(
          d,
          "wrangler-binding-unresolved",
          `${key} is not a static array.`,
          file,
        );
        continue;
      }
      resources.forEach((raw, i) =>
        addResource(raw, [...prefix, key, i], kind, fields),
      );
    }
    const durable = object(config.durable_objects)?.bindings;
    if (durable !== undefined && !Array.isArray(durable))
      warn(
        d,
        "wrangler-binding-unresolved",
        "durable_objects.bindings is not a static array.",
        file,
      );
    if (Array.isArray(durable))
      durable.forEach((raw, i) =>
        addResource(
          raw,
          [...prefix, "durable_objects", "bindings", i],
          "Durable Object",
          ["class_name", "script_name"],
        ),
      );
    for (const key of ["ai", "browser", "images", "assets", "version_metadata"])
      if (config[key] !== undefined)
        addResource(config[key], [...prefix, key], key, [], key);
    for (const [key, label] of [
      ["producers", "produces to"],
      ["consumers", "consumes from"],
    ]) {
      const queues = object(config.queues)?.[key];
      if (queues !== undefined && !Array.isArray(queues))
        warn(
          d,
          "wrangler-binding-unresolved",
          `queues.${key} is not a static array.`,
          file,
        );
      if (Array.isArray(queues))
        queues.forEach((raw, i) => {
          const queue = object(raw);
          const keys = [...prefix, "queues", key, i];
          if (!literal(queue?.queue))
            warn(
              d,
              "wrangler-queue-unresolved",
              `Queue ${key} declaration has no literal queue name.`,
              file,
            );
          const q = node(
            d,
            keys.join("."),
            `Queue\n${typeof queue?.queue === "string" ? queue.queue : "(unresolved)"}${typeof queue?.binding === "string" ? `\n${queue.binding}` : ""}`,
            "queue",
            [at(keys)],
          );
          edge(d, worker, q, label, [at(keys)]);
        });
    }
    const containers = config.containers;
    if (containers !== undefined && !Array.isArray(containers))
      warn(
        d,
        "wrangler-binding-unresolved",
        "containers is not a static array.",
        file,
      );
    if (Array.isArray(containers))
      containers.forEach((raw, i) =>
        addResource(raw, [...prefix, "containers", i], "Container", [
          "class_name",
        ]),
      );
    const crons = object(config.triggers)?.crons;
    if (Array.isArray(crons))
      crons.forEach((cron, i) => {
        const keys = [...prefix, "triggers", "crons", i];
        if (typeof cron !== "string") {
          warn(
            d,
            "wrangler-cron-unresolved",
            "A cron schedule is not a string.",
            file,
          );
          return;
        }
        const c = node(d, keys.join("."), `Cron\n${cron}`, "schedule", [
          at(keys),
        ]);
        edge(d, c, worker, "scheduled event", [at(keys)]);
      });
    return d;
  });
}

function npm(parsed: Parsed, manifests: Parsed[]): Diagram {
  const { file, value, at } = parsed;
  const name = typeof value.name === "string" ? value.name : file.path;
  const d = diagram(
    "npm",
    file,
    `${name} — declared npm dependencies`,
    "dependencies",
  );
  const root = node(d, "package", name, "package", [at(["name"])]);
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (value[section] !== undefined && !object(value[section]))
      warn(
        d,
        "npm-dependencies-unresolved",
        `${section} is not a static object.`,
        file,
      );
    for (const [dep, spec] of entries(value[section])) {
      const refs = [at([section, dep])];
      if (typeof spec !== "string") {
        warn(
          d,
          "npm-dependency-unresolved",
          `${section}.${dep} has an unsupported version declaration.`,
          file,
        );
        continue;
      }
      let matches: Parsed[] = [];
      let kind = "external-package";
      if (/^(?:file|link):/.test(spec)) {
        const target = path.posix.normalize(
          path.posix.join(
            path.posix.dirname(file.path),
            spec.slice(spec.indexOf(":") + 1),
            "package.json",
          ),
        );
        matches = manifests.filter((p) => p.file.path === target);
        kind = matches.length ? "local-package" : "unresolved-package";
        if (!matches.length)
          warn(
            d,
            "npm-local-unresolved",
            `${dep} points to a local package that is not among the input manifests.`,
            file,
          );
      } else {
        matches = manifests.filter(
          (p) => p.value.name === dep && p.file.path !== file.path,
        );
        // Matching a package name is deliberately not a claim about package-manager resolution.
        if (matches.length === 1)
          kind = spec.startsWith("workspace:")
            ? "workspace-package"
            : "repository-package-candidate";
        if (matches.length > 1)
          warn(
            d,
            "npm-package-ambiguous",
            `Several input manifests declare ${dep}; local resolution is ambiguous.`,
            file,
          );
        if (spec.startsWith("workspace:") && matches.length !== 1) {
          kind = "unresolved-package";
          warn(
            d,
            "npm-workspace-unresolved",
            `${dep} has no unique workspace package among input manifests.`,
            file,
          );
        }
      }
      if (matches.length === 1) refs.push(matches[0].at(["name"]));
      const suffix =
        kind === "repository-package-candidate"
          ? "\n(repository match; resolution unverified)"
          : "";
      const n = node(
        d,
        `dependency:${dep}:${section}`,
        `${dep}${suffix}`,
        kind,
        refs,
      );
      // URLs can contain credentials; dependency declarations never echo URLs into diagrams.
      const safeSpec = /(?:https?:|git(?:\+[^:]+)?:|ssh:|@[^\s]+:)/.test(spec)
        ? "(remote source)"
        : spec;
      edge(d, root, n, `${section}: ${safeSpec}`, [at([section, dep])]);
    }
  }
  return d;
}

function toml(file: SourceFile): Parsed {
  let value: ObjectValue | undefined;
  try {
    value = object(parseToml(file.content));
  } catch {
    throw new Error("Invalid TOML");
  }
  if (!value) throw new Error("Expected a TOML table");
  return {
    file,
    value,
    at: (keys) => {
      // TOML tables can use dotted or quoted keys; omit a guessed line when no exact section matches.
      const lines = file.content.split("\n");
      const table = keys.slice(0, -1).join(".");
      let inside = table === "";
      for (let i = 0; i < lines.length; i++) {
        const header = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (header) inside = header[1] === table;
        if (
          inside &&
          lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] === keys.at(-1)
        )
          return { path: file.path, line: i + 1 };
      }
      return { path: file.path };
    },
  };
}

function cargo(parsed: Parsed, manifests: Parsed[]): Diagram {
  const { file, value, at } = parsed;
  const pkg = object(value.package);
  const name =
    typeof pkg?.name === "string" ? pkg.name : `${file.path} (workspace)`;
  const d = diagram(
    "cargo",
    file,
    `${name} — declared Cargo dependencies`,
    "dependencies",
  );
  const root = node(d, "package", name, pkg ? "package" : "workspace", [
    at(["package", "name"]),
  ]);
  const groups: [string[], unknown][] = [];
  for (const section of [
    "dependencies",
    "dev-dependencies",
    "build-dependencies",
  ])
    if (value[section] !== undefined) groups.push([[section], value[section]]);
  for (const [target, raw] of entries(value.target))
    for (const section of [
      "dependencies",
      "dev-dependencies",
      "build-dependencies",
    ]) {
      const dependencies = object(raw)?.[section];
      if (dependencies !== undefined)
        groups.push([["target", target, section], dependencies]);
    }
  const workspace = object(value.workspace);
  if (workspace?.dependencies !== undefined)
    groups.push([["workspace", "dependencies"], workspace.dependencies]);
  if (workspace) {
    const members = workspace.members;
    if (
      members !== undefined &&
      (!Array.isArray(members) || members.some((x) => typeof x !== "string"))
    )
      warn(
        d,
        "cargo-members-unresolved",
        "Workspace members are not a static string array.",
        file,
      );
    const excludes = Array.isArray(workspace.exclude)
      ? workspace.exclude.filter((x): x is string => typeof x === "string")
      : [];
    if (Array.isArray(members))
      for (const [i, member] of members.entries()) {
        if (typeof member !== "string") continue;
        const matches = manifests.filter((p) => {
          const relative =
            path.posix.relative(
              path.posix.dirname(file.path),
              path.posix.dirname(p.file.path),
            ) || ".";
          return (
            p !== parsed &&
            minimatch(relative, member) &&
            !excludes.some((x) => minimatch(relative, x))
          );
        });
        if (!matches.length)
          warn(
            d,
            "cargo-member-unresolved",
            `Workspace member pattern ${member} has no manifest among input files.`,
            file,
          );
        for (const memberManifest of matches) {
          const memberName = object(memberManifest.value.package)?.name;
          const n = node(
            d,
            `member:${memberManifest.file.path}`,
            typeof memberName === "string"
              ? memberName
              : memberManifest.file.path,
            "workspace-package",
            [
              at(["workspace", "members"]),
              memberManifest.at(["package", "name"]),
            ],
          );
          edge(
            d,
            root,
            n,
            "declares workspace member",
            [at(["workspace", "members"])],
            `member:${i}`,
          );
        }
      }
  }
  for (const [keys, raw] of groups) {
    if (!object(raw))
      warn(
        d,
        "cargo-dependencies-unresolved",
        `${keys.join(".")} is not a static table.`,
        file,
      );
    for (const [alias, spec] of entries(raw)) {
      const refs = [at([...keys, alias])];
      let declaration = object(spec);
      let base = file.path;
      if (declaration?.workspace === true) {
        const explicitWorkspace =
          typeof pkg?.workspace === "string"
            ? path.posix.normalize(
                path.posix.join(
                  path.posix.dirname(file.path),
                  pkg.workspace,
                  "Cargo.toml",
                ),
              )
            : undefined;
        const candidates = manifests
          .filter((p) => {
            if (!object(p.value.workspace)) return false;
            if (explicitWorkspace) return p.file.path === explicitWorkspace;
            const relative = path.posix.relative(
              path.posix.dirname(p.file.path),
              file.path,
            );
            return relative !== ".." && !relative.startsWith("../");
          })
          .sort((a, b) => b.file.path.length - a.file.path.length);
        let owner: Parsed | undefined = candidates[0];
        if (owner && owner !== parsed) {
          const relative = path.posix.relative(
            path.posix.dirname(owner.file.path),
            path.posix.dirname(file.path),
          );
          const excluded = object(owner.value.workspace)?.exclude;
          if (
            Array.isArray(excluded) &&
            excluded.some(
              (x) => typeof x === "string" && minimatch(relative, x),
            )
          )
            owner = undefined;
        }
        const inherited = object(owner?.value.workspace)?.dependencies;
        const inheritedSpec = object(inherited)?.[alias];
        if (!owner || inheritedSpec === undefined)
          warn(
            d,
            "cargo-workspace-unresolved",
            `Cannot resolve inherited dependency ${alias} from input workspace declarations.`,
            file,
          );
        else {
          declaration =
            object(inheritedSpec) ??
            (typeof inheritedSpec === "string"
              ? { version: inheritedSpec }
              : undefined);
          base = owner.file.path;
          refs.push(owner.at(["workspace", "dependencies", alias]));
        }
      }
      if (typeof spec !== "string" && !object(spec)) {
        warn(
          d,
          "cargo-dependency-unresolved",
          `Unsupported dependency declaration for ${alias}.`,
          file,
        );
        continue;
      }
      const packageName =
        typeof declaration?.package === "string" ? declaration.package : alias;
      let kind = "external-package";
      if (typeof declaration?.path === "string") {
        const target = path.posix.normalize(
          path.posix.join(
            path.posix.dirname(base),
            declaration.path,
            "Cargo.toml",
          ),
        );
        const match = manifests.find((p) => p.file.path === target);
        kind = match ? "local-package" : "unresolved-package";
        if (match) refs.push(match.at(["package", "name"]));
        else
          warn(
            d,
            "cargo-local-unresolved",
            `${alias} points to a local package outside the input manifests.`,
            file,
          );
      } else if (
        object(spec)?.workspace === true &&
        !declaration?.version &&
        !declaration?.git
      )
        kind = "unresolved-package";
      const n = node(
        d,
        `dependency:${keys.join(".")}:${alias}`,
        alias === packageName ? alias : `${alias}\npackage: ${packageName}`,
        kind,
        refs,
      );
      const qualifiers = [keys.join(" / ")];
      if (typeof spec === "string") qualifiers.push(spec);
      if (typeof declaration?.version === "string")
        qualifiers.push(declaration.version);
      if (declaration?.git) qualifiers.push("git source");
      if (object(spec)?.optional === true || declaration?.optional === true)
        qualifiers.push("optional");
      if (object(spec)?.workspace === true)
        qualifiers.push("workspace inherited");
      edge(d, root, n, qualifiers.join(": "), refs);
    }
  }
  return d;
}

export const infrastructureExtractor: Extractor = {
  id: "infrastructure",
  extract(files: SourceFile[]): Extraction {
    const diagrams: Diagram[] = [];
    const diagnostics: Diagnostic[] = [];
    const npmFiles: Parsed[] = [],
      cargoFiles: Parsed[] = [],
      wranglerFiles: Parsed[] = [];
    const failure = (file: SourceFile, error: unknown) =>
      diagnostics.push({
        code: "infrastructure-parse-error",
        severity: "error",
        path: file.path,
        message:
          error instanceof Error
            ? error.message
            : "Could not parse infrastructure declaration",
      });
    for (const file of [...files].sort((a, b) =>
      a.path.localeCompare(b.path, "en"),
    )) {
      try {
        if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path))
          diagrams.push(github(file));
        else if (/(?:^|\/)package\.json$/.test(file.path))
          npmFiles.push(parseJson(file, false));
        else if (/(?:^|\/)Cargo\.toml$/.test(file.path))
          cargoFiles.push(toml(file));
        else if (/(?:^|\/)wrangler(?:\.[^/]+)?\.jsonc?$/.test(file.path))
          wranglerFiles.push(parseJson(file, true));
        else if (/(?:^|\/)wrangler(?:\.[^/]+)?\.toml$/.test(file.path))
          diagnostics.push({
            code: "wrangler-toml-unsupported",
            severity: "warning",
            path: file.path,
            message:
              "Wrangler TOML extraction is not supported; only JSON/JSONC declarations are extracted.",
          });
      } catch (error) {
        failure(file, error);
      }
    }
    for (const [sources, extract] of [
      [npmFiles, (p: Parsed) => [npm(p, npmFiles)]],
      [cargoFiles, (p: Parsed) => [cargo(p, cargoFiles)]],
      [wranglerFiles, (p: Parsed) => wrangler(p, wranglerFiles)],
    ] as const)
      for (const parsed of sources) {
        try {
          diagrams.push(...extract(parsed));
        } catch (error) {
          failure(parsed.file, error);
        }
      }
    for (const d of diagrams) {
      d.nodes.sort((a, b) => a.id.localeCompare(b.id, "en"));
      d.edges.sort((a, b) => a.id.localeCompare(b.id, "en"));
      diagnostics.push(...(d.diagnostics ?? []));
    }
    return {
      diagrams: diagrams.sort((a, b) => a.id.localeCompare(b.id, "en")),
      diagnostics,
    };
  },
};
