import { test } from "node:test";
import assert from "node:assert/strict";
import { codeExtractor } from "../src/extractors/code.js";

test("resolves static relative imports and preserves unresolved/dynamic evidence", () => {
  const files = [
    {
      path: "src/main.ts",
      content: `import type { Item } from './model.js';\nexport { run } from './runner';\nconst extra = import(variable);\nimport x from '@app/service';`,
    },
    { path: "src/model.ts", content: "export interface Item { id: string }" },
    { path: "src/runner.ts", content: "export const run = () => 1;" },
  ];
  const result = codeExtractor.extract(files);
  const diagram = result.diagrams.find(
    (item) => item.id === "code:dependencies",
  )!;
  assert.ok(diagram.nodes.some((item) => item.label === "src/model.ts"));
  assert.ok(diagram.nodes.some((item) => item.label === "src/runner.ts"));
  assert.ok(
    diagram.nodes.some(
      (item) =>
        item.label === "@app/service" && item.kind === "import-specifier",
    ),
  );
  assert.equal(diagram.edges.length, 3);
  assert.equal(
    diagram.edges.find((item) => item.label === "imports type")!.evidence[0]
      .line,
    1,
  );
  assert.ok(
    result.diagnostics.some((item) => item.code === "CODE_DYNAMIC_IMPORT"),
  );
  assert.deepEqual(result, codeExtractor.extract([...files].reverse()));
});

test("workflow diagram declares ownership only, explicitly flags loops and dynamic names", () => {
  const result = codeExtractor.extract([
    {
      path: "src/workflow.ts",
      content: `
import type { WorkflowStep } from 'cloudflare:workers';
async function deploy(step: WorkflowStep) {
  await step.do('prepare', async () => {});
  for (let retry = 0; retry < 3; retry++) await step.sleep(\`retry-\${retry}\`, '1 second');
  if (ready) await step.do('activate', async () => {});
}
function ordinary(step: SomeOtherType) { step.do('not-a-workflow'); }
`,
    },
  ]);
  const diagram = result.diagrams.find(
    (item) => item.id === "code:workflow:src/workflow.ts",
  )!;
  assert.equal(diagram.edges.length, 3);
  assert.equal(new Set(diagram.edges.map((edge) => edge.from)).size, 1);
  assert.ok(diagram.edges.every((edge) => edge.kind === "declaration"));
  assert.ok(!diagram.nodes.some((node) => node.label === "not-a-workflow"));
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "CODE_DYNAMIC_WORKFLOW_STEP",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "CODE_WORKFLOW_BRANCH_OR_LOOP",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "CODE_WORKFLOW_STRUCTURE_ONLY",
    ),
  );
});

test("states are literal inventories with no invented transitions", () => {
  const result = codeExtractor.extract([
    {
      path: "src/states.ts",
      content: `
export type DeploymentStatus = 'queued' | 'ready' | ImportedStatus;
export enum Mode { Draft, Live }
export type Color = 'red' | 'green';
`,
    },
  ]);
  const status = result.diagrams.find((item) =>
    item.id.endsWith(":DeploymentStatus"),
  )!;
  assert.deepEqual(
    status.nodes.map((item) => item.label),
    ["queued", "ready"],
  );
  assert.equal(status.edges.length, 0);
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "CODE_PARTIAL_STATE_VALUES",
    ),
  );
  assert.equal(
    result.diagrams.filter((item) => item.family === "states").length,
    2,
  );
  assert.ok(result.diagrams.every((item) => item.edges.length === 0));
});

test("workflow import aliases and class scopes remain distinct without attributing shadowed receivers", () => {
  const result = codeExtractor.extract([
    {
      path: "jobs.ts",
      content: `
import type { WorkflowStep as Step } from 'cloudflare:workers';
class First { async run(step: Step) { await step.do('work', () => {}); const helper = (step: Other) => step.do('shadow'); } }
class Second { async run(step: Step) { await step.do('work', () => {}); } }
`,
    },
  ]);
  const diagram = result.diagrams.find((item) => item.family === "pipeline")!;
  assert.equal(diagram.nodes.length, 4);
  assert.equal(new Set(diagram.nodes.map((node) => node.id)).size, 4);
  assert.deepEqual(
    diagram.nodes
      .filter((node) => node.kind === "workflow-function")
      .map((node) => node.label),
    ["First.run", "Second.run"],
  );
  assert.ok(!diagram.nodes.some((node) => node.label === "shadow"));
});
