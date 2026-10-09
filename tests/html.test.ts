import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderHtml } from "../src/html.js";
import type { Diagram } from "../src/types.js";

test("offline gallery escapes inputs and its search and size controls change the actual view", async () => {
  const diagram: Diagram = {
    id: "sample",
    title: "Sample <script>alert(1)</script>",
    family: "architecture",
    syntax: "flowchart",
    context: "implemented",
    provenance: "extracted",
    nodes: [{ id: "a", label: "A", evidence: [{ path: "source.ts" }] }],
    edges: [],
  };
  const html = await renderHtml(
    [{ diagram, mermaid: 'flowchart LR\n A["hello"]\n', projected: false }],
    () => "./source.ts",
  );
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const document = dom.window.document;
  assert.equal(document.querySelectorAll("script").length, 2);
  assert.equal(document.querySelectorAll("script[src],link[href]").length, 0);
  assert.equal(document.querySelector("h2")?.textContent, diagram.title);
  const pre = document.querySelector(".mermaid")!;
  pre.innerHTML = '<svg width="100%" viewBox="0 0 1800 600"></svg>';
  (dom.window as any).mermaid = { initialize: () => {}, run: async () => {} };
  dom.window.eval(document.querySelectorAll("script")[1].textContent!);
  const button = document.querySelector("button")!;
  button.click();
  assert.equal(
    (document.querySelector("svg") as SVGElement).style.width,
    "1800px",
  );
  assert.equal(button.textContent, "Fit width");
  button.click();
  assert.equal((document.querySelector("svg") as SVGElement).style.width, "");
  const input = document.querySelector("input")!;
  input.value = "absent";
  input.dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelector("section")!.hidden, true);
  (document.querySelector("nav a") as HTMLElement).click();
  assert.equal(input.value, "");
  assert.equal(document.querySelector("section")!.hidden, false);
  input.value = "sample";
  input.dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelector("section")!.hidden, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.documentElement.dataset.rendered, "true");
  dom.window.close();
});
