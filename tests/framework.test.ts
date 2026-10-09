import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectFramework } from "../src/framework.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mermaider-framework-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("plain repository uses the docs fallback and does not infer a globally installed framework", async () =>
  fixture(async (root) => {
    assert.deepEqual(await detectFramework(root), {
      framework: "none",
      outputDir: "docs/mermaider",
      evidence: [],
    });
  }));

test("Superpowers repository uses a sibling documentation directory rather than plans or specs", async () =>
  fixture(async (root) => {
    await mkdir(path.join(root, "docs/superpowers/plans"), { recursive: true });
    const result = await detectFramework(root);
    assert.equal(result.framework, "superpowers");
    assert.equal(result.outputDir, "docs/superpowers/mermaider");
    assert.deepEqual(result.evidence, ["docs/superpowers"]);
  }));

test("OMX project guidance is recognized without treating runtime storage as output", async () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, "AGENTS.md"),
      "# oh-my-codex\n<!-- OMX:RUNTIME:START -->\n",
    );
    const result = await detectFramework(root);
    assert.equal(result.framework, "oh-my-codex");
    assert.equal(result.outputDir, "docs/mermaider");
    assert.deepEqual(result.evidence, ["AGENTS.md"]);
  }));

test("existing architecture documentation wins and mixed frameworks otherwise use neutral docs", async () =>
  fixture(async (root) => {
    await mkdir(path.join(root, ".omx"));
    await mkdir(path.join(root, ".superpowers"));
    assert.equal((await detectFramework(root)).outputDir, "docs/mermaider");
    await mkdir(path.join(root, "docs/architecture"), { recursive: true });
    const result = await detectFramework(root);
    assert.equal(result.framework, "mixed");
    assert.equal(result.outputDir, "docs/architecture/mermaider");
  }));

test("framework discovery neither follows symlinks nor reads large guidance files", async () =>
  fixture(async (root) => {
    await mkdir(path.join(root, "outside/superpowers"), { recursive: true });
    await symlink(path.join(root, "outside"), path.join(root, "docs"), "dir");
    await writeFile(
      path.join(root, "AGENTS.md"),
      "# superpowers\n" + "x".repeat(256 * 1024),
    );
    assert.deepEqual(await detectFramework(root), {
      framework: "none",
      outputDir: "docs/mermaider",
      evidence: [],
    });
  }));
