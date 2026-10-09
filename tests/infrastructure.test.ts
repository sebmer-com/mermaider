import test from "node:test";
import assert from "node:assert/strict";
import { infrastructureExtractor } from "../src/extractors/infrastructure.js";
import type { Diagram, SourceFile } from "../src/types.js";
import { stableId } from "../src/util.js";

const source = (path: string, content: string): SourceFile => ({
  path,
  content,
});
const json = (path: string, value: unknown): SourceFile =>
  source(path, JSON.stringify(value, null, 2));
const extract = (...files: SourceFile[]) =>
  infrastructureExtractor.extract(files);
function endpoints(d: Diagram) {
  return d.edges.map((e) => [
    d.nodes.find((n) => n.id === e.from)!.label,
    d.nodes.find((n) => n.id === e.to)!.label,
    e.label,
  ]);
}

test("CI shows only explicit needs edges, retaining conditions and reusable/matrix context", () => {
  const file = source(
    ".github/workflows/release.yml",
    `name: Release
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
  unrelated:
    runs-on: ubuntu-latest
  test:
    needs: build
    if: github.event_name == 'pull_request'
    uses: org/repo/.github/workflows/test.yml@v1
  publish:
    needs: [build, test]
    runs-on: ubuntu-latest
`,
  );
  const { diagrams, diagnostics } = extract(file);
  assert.equal(diagnostics.length, 0);
  assert.equal(diagrams.length, 1);
  const d = diagrams[0];
  assert.equal(d.id, stableId("ci", file.path));
  assert.equal(d.nodes.length, 4);
  assert.equal(d.edges.length, 3);
  assert.ok(d.nodes.some((n) => n.label.includes("matrix (not expanded)")));
  assert.ok(
    d.nodes.some(
      (n) => n.label.includes("if:") && n.label.includes("reusable:"),
    ),
  );
  assert.ok(
    endpoints(d).every(([a, b]) => a !== "unrelated" && b !== "unrelated"),
  );
  assert.ok(d.edges.every((e) => e.evidence[0].line! > 1));
});

test("CI reports dynamic and undeclared needs instead of inventing successful execution", () => {
  const { diagrams, diagnostics } = extract(
    source(
      ".github/workflows/dynamic.yaml",
      `jobs:
  dynamic:
    needs: ${"$"}{{ inputs.prerequisite }}
  invalid:
    needs: missing
`,
    ),
  );
  assert.equal(diagrams[0].edges.length, 1);
  assert.ok(diagrams[0].nodes.some((n) => n.kind === "unresolved"));
  assert.deepEqual(diagnostics.map((d) => d.code).sort(), [
    "workflow-missing-job",
    "workflow-needs-unresolved",
  ]);
});

test("Wrangler JSONC exposes bindings as declarations, templates, scopes and static Worker references", () => {
  const input = source(
    "apps/web/wrangler.example.jsonc",
    `{
  // Synthetic template, never imported or executed.
  "name": "web",
  "d1_databases": [{"binding": "DB", "database_name": "sample"}],
  "r2_buckets": [{"binding": "FILES", "bucket_name": "<BUCKET>"}],
  "hyperdrive": [{"binding": "PG", "id": "opaque-id"}],
  "durable_objects": {"bindings": [{"name": "SESSIONS", "class_name": "Session", "script_name": "api"}]},
  "services": [{"binding": "API", "service": "api"}],
  "workflows": [{"binding": "RELEASE", "name": "release", "class_name": "Release"}],
  "queues": {"producers": [{"binding": "OUT", "queue": "jobs"}], "consumers": [{"queue": "jobs"}]},
  "triggers": {"crons": ["0 * * * *"]},
  "env": {"preview": {"name": "preview-web", "r2_buckets": [{"binding": "FILES", "bucket_name": "preview"}]}},
  "vars": {"PASSWORD": "synthetic-value-that-must-not-appear"},
}`,
  );
  const { diagrams, diagnostics } = extract(
    input,
    json("apps/api/wrangler.json", { name: "api" }),
  );
  assert.equal(diagrams.length, 3);
  const main = diagrams.find(
    (d) => d.id === stableId("architecture", input.path),
  )!;
  assert.match(main.title, /template/);
  assert.ok(main.nodes.some((n) => n.label.includes("D1 database")));
  assert.ok(main.nodes.some((n) => n.label.includes("Hyperdrive")));
  assert.ok(main.edges.some((e) => e.label === "scheduled event"));
  assert.ok(main.edges.some((e) => e.label === "produces to"));
  assert.ok(main.edges.some((e) => e.label === "consumes from"));
  const ref = main.nodes.find((n) => n.kind === "worker-reference")!;
  assert.ok(ref.evidence.some((e) => e.path === "apps/api/wrangler.json"));
  const preview = diagrams.find((d) => d.title.includes("env preview"))!;
  assert.equal(
    preview.nodes.length,
    2,
    "environment must not pretend root bindings were inherited",
  );
  assert.ok(diagnostics.some((d) => d.code === "wrangler-placeholder"));
  assert.ok(diagnostics.some((d) => d.code === "wrangler-environment-view"));
  assert.ok(
    !JSON.stringify(diagrams).includes("synthetic-value-that-must-not-appear"),
  );
  assert.ok(!JSON.stringify(diagrams).includes("opaque-id"));
});

test("Wrangler malformed resource arrays remain visible diagnostics", () => {
  const { diagrams, diagnostics } = extract(
    json("wrangler.jsonc", {
      name: "broken",
      services: "${SERVICES}",
      queues: { consumers: [{ queue: "${QUEUE}" }] },
    }),
  );
  assert.equal(diagrams.length, 1);
  assert.ok(diagnostics.some((d) => d.code === "wrangler-binding-unresolved"));
  assert.ok(diagnostics.some((d) => d.code === "wrangler-queue-unresolved"));
});

test("Workflow script_name creates a source-evidenced cross-Worker reference only for a static target", () => {
  const result = extract(
    json("apps/client/wrangler.jsonc", {
      name: "client",
      workflows: [
        {
          binding: "BUILD",
          name: "build",
          class_name: "Build",
          script_name: "runner",
        },
        {
          binding: "UNKNOWN",
          name: "unknown",
          class_name: "Build",
          script_name: "${WORKER}",
        },
      ],
    }),
    json("apps/runner/wrangler.jsonc", { name: "runner" }),
  );
  const client = result.diagrams.find(
    (d) => d.id === stableId("architecture", "apps/client/wrangler.jsonc"),
  )!;
  const links = client.edges.filter((e) => e.label === "references worker");
  assert.equal(links.length, 1);
  const workflow = client.nodes.find((n) => n.id === links[0].from)!;
  assert.ok(workflow.label.includes("script_name: runner"));
  const target = client.nodes.find((n) => n.id === links[0].to)!;
  assert.ok(
    target.evidence.some((e) => e.path === "apps/runner/wrangler.jsonc"),
  );
  assert.ok(
    links[0].evidence.some((e) => e.path === "apps/client/wrangler.jsonc"),
  );
  assert.ok(result.diagnostics.some((d) => d.code === "wrangler-placeholder"));
});

test("CI compacts multiline conditions to 100 characters and preserves the exact source condition", () => {
  const condition =
    "github.ref == 'refs/heads/main' &&\n(needs.build.outputs.image == 'true' || needs.build.outputs.runtime == 'true') &&\ngithub.event_name == 'push'\n";
  const content = `jobs:\n  publish:\n    if: |\n${condition
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n")}\n    runs-on: ubuntu-latest\n`;
  const result = extract(source(".github/workflows/long.yml", content));
  const label = result.diagrams[0].nodes[0].label
    .split("\n")
    .find((line) => line.startsWith("if:"))!;
  assert.equal(label.length, 100);
  assert.ok(label.endsWith("…"));
  const detail = result.diagnostics.find(
    (d) => d.code === "workflow-condition-detail",
  )!;
  assert.ok(detail.message.endsWith(condition));
  assert.ok(detail.message.includes(".github/workflows/long.yml:3"));
  assert.equal(result.diagrams[0].edges.length, 0);
});

test("npm diagrams distinguish declared local/workspace dependencies and unverified name matches", () => {
  const result = extract(
    json("apps/app/package.json", {
      name: "app",
      dependencies: {
        local: "file:../../packages/local",
        shared: "workspace:*",
        candidate: "^1.0.0",
        external: "^2.0.0",
        missing: "workspace:*",
      },
      devDependencies: { tooling: "^1.0.0" },
      peerDependencies: { peer: "*" },
    }),
    json("packages/local/package.json", { name: "local" }),
    json("packages/shared/package.json", { name: "shared" }),
    json("packages/candidate/package.json", {
      name: "candidate",
      version: "1.0.0",
    }),
  );
  const d = result.diagrams.find(
    (d) => d.id === stableId("npm", "apps/app/package.json"),
  )!;
  assert.equal(d.nodes.find((n) => n.label === "local")!.kind, "local-package");
  assert.equal(
    d.nodes.find((n) => n.label === "shared")!.kind,
    "workspace-package",
  );
  assert.equal(
    d.nodes.find((n) => n.label.startsWith("candidate"))!.kind,
    "repository-package-candidate",
  );
  assert.equal(
    d.nodes.find((n) => n.label === "external")!.kind,
    "external-package",
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "npm-workspace-unresolved"),
  );
  assert.ok(d.edges.some((e) => e.label?.startsWith("peerDependencies:")));
});

test("npm remote declarations never print credentials embedded in a source URL", () => {
  const { diagrams } = extract(
    json("package.json", {
      name: "safe",
      dependencies: {
        remote: "https://fake-token@example.invalid/package.tgz",
      },
    }),
  );
  assert.ok(!JSON.stringify(diagrams).includes("fake-token"));
  assert.match(diagrams[0].edges[0].label!, /remote source/);
});

test("Cargo resolves workspace path dependencies and preserves target/build/optional distinctions", () => {
  const result = extract(
    source(
      "Cargo.toml",
      `[workspace]
members = ["crates/*"]
[workspace.dependencies]
shared = { path = "crates/shared" }
remote = "1"
`,
    ),
    source(
      "crates/app/Cargo.toml",
      `[package]
name = "app"
version = "0.1.0"
[dependencies]
shared = { workspace = true }
remote = { workspace = true, optional = true }
alias = { package = "real-name", version = "2" }
[build-dependencies]
builder = "1"
[target.'cfg(unix)'.dependencies]
unix-only = "1"
`,
    ),
    source(
      "crates/shared/Cargo.toml",
      `[package]
name = "shared"
version = "0.1.0"
`,
    ),
  );
  assert.deepEqual(result.diagnostics, []);
  const root = result.diagrams.find(
    (d) => d.id === stableId("cargo", "Cargo.toml"),
  )!;
  assert.equal(
    root.edges.filter((e) => e.label === "declares workspace member").length,
    2,
  );
  const app = result.diagrams.find(
    (d) => d.id === stableId("cargo", "crates/app/Cargo.toml"),
  )!;
  const shared = app.nodes.find((n) => n.label === "shared")!;
  assert.equal(shared.kind, "local-package");
  assert.equal(shared.evidence.length, 3);
  assert.ok(
    app.edges.some(
      (e) =>
        e.label?.includes("workspace inherited") &&
        e.label.includes("optional"),
    ),
  );
  assert.ok(app.edges.some((e) => e.label?.includes("cfg(unix)")));
  assert.ok(app.nodes.some((n) => n.label.includes("real-name")));
  assert.ok(app.edges.some((e) => e.label?.startsWith("build-dependencies")));
});

test("Cargo absent local/workspace dependencies and excluded member patterns are reported", () => {
  const result = extract(
    source(
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/ignored"]\n',
    ),
    source(
      "crates/app/Cargo.toml",
      '[package]\nname = "app"\n[dependencies]\nmissing = { workspace = true }\nlocal = { path = "../absent" }\n',
    ),
    source("crates/ignored/Cargo.toml", '[package]\nname = "ignored"\n'),
  );
  const root = result.diagrams.find(
    (d) => d.id === stableId("cargo", "Cargo.toml"),
  )!;
  assert.equal(
    root.edges.filter((e) => e.label === "declares workspace member").length,
    1,
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "cargo-workspace-unresolved"),
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "cargo-local-unresolved"),
  );
});

test("Cargo root package inherits its own workspace while excluded packages cannot", () => {
  const result = extract(
    source(
      "Cargo.toml",
      '[package]\nname = "root"\n[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/ignored"]\n[workspace.dependencies]\nshared = "1"\n[dependencies]\nshared = { workspace = true }\n',
    ),
    source(
      "crates/ignored/Cargo.toml",
      '[package]\nname = "ignored"\n[dependencies]\nshared = { workspace = true }\n',
    ),
  );
  const root = result.diagrams.find(
    (d) => d.id === stableId("cargo", "Cargo.toml"),
  )!;
  assert.ok(
    root.edges.some((e) => e.label === "dependencies: 1: workspace inherited"),
  );
  assert.ok(
    result.diagnostics.some(
      (d) =>
        d.code === "cargo-workspace-unresolved" &&
        d.path === "crates/ignored/Cargo.toml",
    ),
  );
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "cargo-workspace-unresolved" && d.path === "Cargo.toml",
    ),
  );
});

test("malformed files are isolated, unsupported TOML explicit, and all relationships are evidenced", () => {
  const result = extract(
    source("broken/package.json", "{oops"),
    source("bad/Cargo.toml", "invalid="),
    source(".github/workflows/bad.yml", "jobs: [oops"),
    source("wrangler.toml", 'name = "legacy"'),
    json("good/package.json", {
      name: "valid",
      dependencies: { library: "1" },
    }),
  );
  assert.equal(result.diagrams.length, 1);
  assert.equal(
    result.diagnostics.filter((d) => d.severity === "error").length,
    3,
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "wrangler-toml-unsupported"),
  );
  for (const d of result.diagrams)
    for (const item of [...d.nodes, ...d.edges])
      assert.ok(item.evidence.length && item.evidence.every((e) => e.path));
});

test("input ordering does not affect canonical diagrams and no source module is executed", () => {
  const files = [
    json("package.json", {
      name: "root",
      scripts: { prepare: "touch MUST_NOT_RUN" },
      dependencies: { z: "1", a: "2" },
    }),
    source(
      "Cargo.toml",
      '[package]\nname = "rust"\n[dependencies]\nz = "1"\na = "2"\n',
    ),
    source(
      ".github/workflows/check.yaml",
      "jobs:\n  b:\n    needs: a\n  a:\n    runs-on: ubuntu-latest\n",
    ),
  ];
  assert.deepEqual(extract(...files), extract(...files.reverse()));
});
