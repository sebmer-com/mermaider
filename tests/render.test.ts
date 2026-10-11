import test from "node:test";
import assert from "node:assert/strict";
import { renderMermaid, validateMermaid } from "../src/render.js";
import type { Diagram } from "../src/types.js";

const evidence = [{ path: "src/workflow.ts", line: 12 }];

function flow(): Diagram {
  return {
    id: "deployment",
    title: "Deployment lifecycle",
    family: "process",
    syntax: "flowchart",
    provenance: "curated",
    context: "implemented",
    nodes: [
      {
        id: "start",
        label:
          'Review the pending <candidate> & "activation" receipt [before] publishing #42 and `release`',
        evidence,
      },
      {
        id: "done",
        label:
          "Keep the previously active deployment available until the replacement is confirmed healthy",
        evidence,
      },
    ],
    edges: [
      {
        id: "activate",
        from: "start",
        to: "done",
        label:
          'Continue only when the candidate is healthy & its "authorization" remains valid',
        evidence,
      },
    ],
  };
}

function plainLabel(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

test("long node and edge labels wrap without changing their text or breaking Mermaid syntax", async () => {
  const diagram = flow();
  const source = renderMermaid(diagram);
  await validateMermaid(source);

  const nodes = [...source.matchAll(/\["([^"]*)"\]/g)].map((m) => m[1]!);
  const edges = [...source.matchAll(/\|"([^"]*)"\|/g)].map((m) => m[1]!);
  assert.equal(nodes.length, diagram.nodes.length);
  assert.equal(edges.length, diagram.edges.length);
  for (const value of [...nodes, ...edges]) assert.ok(value.includes("<br/>"));
  assert.deepEqual(
    nodes.map(plainLabel).sort(),
    diagram.nodes.map((node) => node.label).sort(),
  );
  assert.deepEqual(
    edges.map(plainLabel),
    diagram.edges.map((edge) => edge.label),
  );
  assert.ok(!source.includes("<candidate>"));
  assert.ok(!source.includes("`release`"));
});

test("wrapped output remains byte-identical when source collection order changes", () => {
  const original = flow();
  const reversed = {
    ...original,
    nodes: [...original.nodes].reverse(),
    edges: [...original.edges].reverse(),
  };
  assert.equal(renderMermaid(original), renderMermaid(reversed));
  assert.equal(renderMermaid(original), renderMermaid(original));
});

test("multiline input labels remain ordinary quoted labels with literal markup escaped", async () => {
  const diagram = flow();
  const original =
    "1. Read the receipt\n2. Check **authorization**\n3. Reject <script>alert(1)</script>";
  diagram.nodes[0]!.label = original;
  const source = renderMermaid(diagram);
  await validateMermaid(source);
  const values = [...source.matchAll(/\["([^"]*)"\]/g)].map((m) =>
    plainLabel(m[1]!),
  );
  assert.ok(values.includes(original.replace(/\s+/g, " ")));
  assert.ok(
    source.includes("receipt<br/>2. Check **authorization**<br/>3. Reject"),
  );
  assert.ok(!source.includes("<script>"));
  assert.ok(!source.includes('"`'));
});
