import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { renderHtml, type HtmlView } from "../src/html.js";
import { renderMermaid } from "../src/render.js";
import type { Diagram } from "../src/types.js";

function diagram(id: string, title: string): Diagram {
  return {
    id,
    title,
    family: "architecture",
    syntax: "flowchart",
    context: "implemented",
    provenance: "extracted",
    nodes: [{ id: "a", label: title, evidence: [{ path: "source.ts" }] }],
    edges: [],
  };
}

function views(): HtmlView[] {
  return [
    {
      diagram: diagram(
        "alpha",
        "Alpha architecture: declared application resources (overview)",
      ),
      navLabel: "App map",
      mermaid: 'flowchart LR\n A["AlphaOnly"] --> B["AlphaTarget"]\n',
      projected: false,
    },
    {
      diagram: diagram(
        "beta",
        "Beta deployment pipeline and resource relationships: declared dependencies",
      ),
      mermaid: 'flowchart LR\n C["BetaOnly"] --> D["BetaTarget"]\n',
      projected: true,
    },
  ];
}

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function gallery(
  t: { after(fn: () => void): void },
  options: {
    initialIndex?: number;
    realBundle?: boolean;
    views?: HtmlView[];
    svgSize?: { width: number; height: number };
    fonts?: { ready: Promise<void>; release(): void };
  } = {},
) {
  const entries = options.views || views();
  const html = await renderHtml(entries, () => "./source.ts");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://mermaider.test/docs/index.html",
  });
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  const { document } = dom.window;
  const scripts = document.querySelectorAll("script");
  assert.equal(scripts.length, 2);
  assert.equal(document.querySelectorAll("script[src],link[href]").length, 0);
  const links = [
    ...document.querySelectorAll<HTMLAnchorElement>("nav a[data-diagram]"),
  ];
  const panels = [...document.querySelectorAll<HTMLElement>(".diagram-panel")];
  assert.equal(links.length, entries.length);
  assert.equal(panels.length, entries.length);
  if (options.initialIndex !== undefined) {
    dom.window.history.replaceState(
      null,
      "",
      links[options.initialIndex]!.hash,
    );
  }
  for (const canvas of document.querySelectorAll<HTMLElement>(".canvas")) {
    canvas.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 500,
      width: 800,
      height: 500,
      toJSON: () => ({}),
    });
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 500,
    });
  }
  const records = {
    initialized: {} as Record<string, unknown>,
    calls: [] as { id: string; source: string }[],
    bound: [] as string[],
    maxConcurrent: 0,
  };
  if (options.fonts) {
    Object.defineProperty(document, "fonts", {
      value: { ready: options.fonts.ready },
    });
  }
  if (options.realBundle) {
    // Exercise the actual pinned renderer and SVG-ID allocation. This shim
    // measures text for layout; native browser checks cover visual geometry.
    Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
      configurable: true,
      value() {
        return {
          x: 0,
          y: 0,
          width: Math.max(40, (this.textContent || "").length * 8),
          height: 24,
        };
      },
    });
    Object.defineProperty(
      dom.window.SVGElement.prototype,
      "getComputedTextLength",
      {
        configurable: true,
        value() {
          return (this.textContent || "").length * 8;
        },
      },
    );
    dom.window.Date.now = () => 1000;
    new Script(scripts[0]!.textContent!).runInContext(
      dom.getInternalVMContext(),
    );
  } else {
    let active = 0;
    let currentSource = "";
    (dom.window as unknown as { mermaid: unknown }).mermaid = {
      initialize(configuration: Record<string, unknown>) {
        records.initialized = configuration;
      },
      async render(id: string, source: string) {
        active++;
        records.maxConcurrent = Math.max(records.maxConcurrent, active);
        records.calls.push({ id, source });
        currentSource = source.includes("AlphaOnly") ? "AlphaOnly" : "BetaOnly";
        // Concurrent rendering would overwrite shared Mermaid graph state
        // before the first graph's awaited layout finishes.
        await new Promise((resolve) => setTimeout(resolve, 10));
        const marker = currentSource;
        active--;
        return {
          svg: `<svg id="${id}" viewBox="0 0 ${options.svgSize?.width || 1000} ${options.svgSize?.height || 800}"><text>${marker}</text></svg>`,
          bindFunctions(container: Element) {
            records.bound.push(
              container.querySelector("svg text")!.textContent!,
            );
          },
        };
      },
    };
  }
  new Script(scripts[scripts.length - 1]!.textContent!).runInContext(
    dom.getInternalVMContext(),
  );
  if (options.fonts) {
    await Promise.resolve();
    assert.equal(
      records.calls.length,
      0,
      "SVG measurement started before fonts became ready",
    );
    options.fonts.release();
  }
  await until(
    () => document.documentElement.dataset.rendered === "true",
    "gallery rendering did not complete",
  );
  return { dom, document, entries, panels, links, records };
}

function visiblePanels(panels: HTMLElement[]): HTMLElement[] {
  return panels.filter((panel) => !panel.hidden);
}

function button(panel: HTMLElement, label: string): HTMLButtonElement {
  const result = panel.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  assert.ok(result, `missing ${label} control`);
  return result;
}

function transform(panel: HTMLElement): {
  x: number;
  y: number;
  scale: number;
} {
  const value =
    panel.querySelector<HTMLElement>(".canvas-plane")!.style.transform;
  const translation = /translate\(\s*([-\d.]+)px[, ]+\s*([-\d.]+)px\s*\)/.exec(
    value,
  );
  const scale = /scale\(\s*([-\d.]+)\s*\)/.exec(value);
  assert.ok(
    translation && scale,
    `canvas is missing a translate/scale transform: ${value}`,
  );
  return {
    x: Number(translation[1]),
    y: Number(translation[2]),
    scale: Number(scale[1]),
  };
}

test("graphs render sequentially with distinct SVG identities and never share another graph's content", async (t) => {
  const { panels, records } = await gallery(t);
  assert.equal(records.maxConcurrent, 1);
  assert.equal(records.calls.length, 2);
  assert.equal(new Set(records.calls.map((call) => call.id)).size, 2);
  assert.deepEqual(
    panels.map(
      (panel) => panel.querySelector(".diagram-svg svg text")?.textContent,
    ),
    ["AlphaOnly", "BetaOnly"],
  );
  assert.deepEqual(records.bound, ["AlphaOnly", "BetaOnly"]);
  for (const panel of panels) assert.equal(panel.dataset.rendered, "true");
});

test("SVG rendering waits for local fonts when the browser exposes font readiness", async (t) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { records } = await gallery(t, { fonts: { ready, release } });
  assert.equal(records.calls.length, 2);
});

test("the pinned Mermaid bundle keeps graph contents and SVG ids isolated when the clock is frozen", async (t) => {
  const { panels } = await gallery(t, { realBundle: true });
  const first = panels[0]!.querySelector(".diagram-svg svg");
  const second = panels[1]!.querySelector(".diagram-svg svg");
  assert.ok(
    first && second,
    panels.map((panel) => panel.textContent).join("\n"),
  );
  assert.match(first.textContent!, /AlphaOnly/);
  assert.doesNotMatch(first.textContent!, /BetaOnly/);
  assert.match(second.textContent!, /BetaOnly/);
  assert.doesNotMatch(second.textContent!, /AlphaOnly/);
  const firstIds = new Set([
    first.id,
    ...[...first.querySelectorAll("[id]")].map((item) => item.id),
  ]);
  const secondIds = [
    second.id,
    ...[...second.querySelectorAll("[id]")].map((item) => item.id),
  ];
  assert.equal(secondIds.filter((id) => firstIds.has(id)).length, 0);
});

test("hash navigation and browser back/forward keep exactly one selected view visible", async (t) => {
  const { dom, panels, links } = await gallery(t);
  assert.deepEqual(visiblePanels(panels), [panels[0]]);
  assert.equal(links[0]!.getAttribute("aria-current"), "page");
  links[1]!.click();
  await until(
    () => dom.window.location.hash === links[1]!.hash && !panels[1]!.hidden,
    "second view was not selected",
  );
  assert.deepEqual(visiblePanels(panels), [panels[1]]);
  assert.equal(links[1]!.getAttribute("aria-current"), "page");
  assert.equal(links[0]!.hasAttribute("aria-current"), false);
  dom.window.history.back();
  await until(
    () => !panels[0]!.hidden,
    "back navigation did not select the first view",
  );
  assert.deepEqual(visiblePanels(panels), [panels[0]]);
  dom.window.history.forward();
  await until(
    () => !panels[1]!.hidden,
    "forward navigation did not select the second view",
  );
  assert.deepEqual(visiblePanels(panels), [panels[1]]);
});

test("deep links select the matching view and the compact picker changes that selection", async (t) => {
  const { dom, document, panels, links } = await gallery(t, {
    initialIndex: 1,
  });
  assert.deepEqual(visiblePanels(panels), [panels[1]]);
  const picker = document.querySelector<HTMLSelectElement>("#diagram-picker")!;
  assert.equal(picker.getAttribute("aria-label"), "Choose diagram");
  picker.value = panels[0]!.id;
  picker.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await until(
    () => !panels[0]!.hidden,
    "picker did not change the selected view",
  );
  assert.equal(dom.window.location.hash, links[0]!.hash);
  assert.deepEqual(visiblePanels(panels), [panels[0]]);
});

test("navigation labels are short while filtering affects only navigation and reports no matches", async (t) => {
  const { dom, document, panels, links } = await gallery(t);
  assert.equal(
    links[0]!.querySelector(".nav-label")!.textContent!.trim(),
    "App map",
  );
  assert.ok(
    links[1]!.querySelector(".nav-label")!.textContent!.trim().length <= 32,
  );
  assert.match(
    links[1]!.querySelector(".nav-label")!.textContent!,
    /^Beta deployment/,
  );
  assert.equal(
    panels[1]!.querySelector("h1,h2")!.textContent,
    views()[1]!.diagram.title,
  );
  const input = document.querySelector<HTMLInputElement>("#diagram-search")!;
  const status = document.querySelector<HTMLElement>("#nav-empty")!;
  assert.equal(status.getAttribute("role"), "status");
  input.value = "Beta";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(links[0]!.hidden, true);
  assert.equal(links[1]!.hidden, false);
  assert.deepEqual(visiblePanels(panels), [panels[0]]);
  input.value = "no matching diagram exists";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(
    links.every((link) => link.hidden),
    true,
  );
  assert.equal(status.hidden, false);
  assert.match(status.textContent!, /no .*diagram|no .*match/i);
  assert.deepEqual(visiblePanels(panels), [panels[0]]);
  input.value = "";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(status.hidden, true);
  assert.equal(
    links.every((link) => !link.hidden),
    true,
  );
});

test("Fit, zoom, actual size and keyboard panning change the rendered canvas transform", async (t) => {
  const { dom, panels } = await gallery(t);
  const panel = panels[0]!;
  const canvas = panel.querySelector<HTMLElement>(".canvas")!;
  assert.equal(canvas.tabIndex, 0);
  assert.equal(canvas.getAttribute("role"), "region");
  assert.match(canvas.getAttribute("aria-label")!, /^Diagram canvas:/);
  const initial = transform(panel);
  assert.ok(initial.scale >= 0.75 && initial.scale < 1);
  button(panel, "Zoom in").click();
  const zoomed = transform(panel);
  assert.ok(zoomed.scale > initial.scale);
  button(panel, "Zoom out").click();
  assert.ok(transform(panel).scale < zoomed.scale);
  button(panel, "Actual size").click();
  assert.equal(transform(panel).scale, 1);
  assert.equal(panel.querySelector(".zoom-level")!.textContent!.trim(), "100%");
  const beforePan = transform(panel);
  canvas.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    }),
  );
  const afterPan = transform(panel);
  assert.notEqual(afterPan.x, beforePan.x);
  assert.equal(afterPan.y, beforePan.y);
  assert.equal(afterPan.scale, 1);
  button(panel, "Fit diagram").click();
  const fitted = transform(panel);
  assert.equal(fitted.scale, 0.555);
  assert.ok(Math.abs(fitted.x - 122.5) < 1e-9);
  assert.ok(Math.abs(fitted.y - 28) < 1e-9);
  assert.ok(fitted.scale < initial.scale);
});

test("large diagrams open at a readable scale while Fit explicitly shows the complete graph", async (t) => {
  const { panels } = await gallery(t, {
    svgSize: { width: 3000, height: 2400 },
  });
  const panel = panels[0]!;
  assert.ok(transform(panel).scale >= 0.75);
  button(panel, "Fit diagram").click();
  const fitted = transform(panel);
  assert.ok(fitted.scale < 0.25);
  assert.ok(fitted.x >= 0 && fitted.y >= 0);
  assert.ok(fitted.x + 3000 * fitted.scale <= 800);
  assert.ok(fitted.y + 2400 * fitted.scale <= 500);
});

test("process views focus their entry node instead of a more connected wait state", async (t) => {
  const process: Diagram = {
    ...diagram("process-focus", "Deployment process"),
    family: "process",
    nodes: [
      { id: "entry", label: "Start deployment", evidence: [] },
      { id: "dispatch", label: "Dispatch work", evidence: [] },
      { id: "work", label: "Run work", evidence: [] },
      { id: "other", label: "Run other work", evidence: [] },
      { id: "wait", label: "Wait for updates", evidence: [] },
    ],
    edges: [
      ["entry", "dispatch"],
      ["dispatch", "work"],
      ["dispatch", "other"],
      ["dispatch", "wait"],
      ["work", "wait"],
      ["other", "wait"],
      ["wait", "work"],
    ].map(([from, to], index) => ({
      id: `edge-${index}`,
      from: from!,
      to: to!,
      evidence: [],
    })),
  };
  const { panels } = await gallery(t, {
    realBundle: true,
    views: [
      { diagram: process, mermaid: renderMermaid(process), projected: false },
    ],
  });
  const panel = panels[0]!;
  assert.equal(panel.dataset.direction, "TD");
  const focus = panel.querySelector(
    `.diagram-svg .node[id*="${panel.dataset.focus}"]`,
  );
  assert.ok(focus);
  assert.match(focus.textContent!, /Start deployment/);
  assert.doesNotMatch(focus.textContent!, /Wait for updates/);
});

test("pointer dragging pans the selected canvas without moving another view", async (t) => {
  const { dom, panels } = await gallery(t);
  const canvas = panels[0]!.querySelector<HTMLElement>(".canvas")!;
  const before = transform(panels[0]!);
  const otherPlane = panels[1]!.querySelector<HTMLElement>(".canvas-plane")!;
  const otherBefore = otherPlane.style.transform;
  Object.assign(canvas, { setPointerCapture() {}, releasePointerCapture() {} });
  const pointer = (type: string, x: number, y: number) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    canvas.dispatchEvent(event);
  };
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 145, 130);
  pointer("pointerup", 145, 130);
  const after = transform(panels[0]!);
  assert.equal(after.x - before.x, 45);
  assert.equal(after.y - before.y, 30);
  assert.equal(after.scale, before.scale);
  assert.equal(otherPlane.style.transform, otherBefore);
});

test("untrusted titles and labels remain text in the portable page", async (t) => {
  const entries = views();
  entries[0]!.diagram.title =
    'A <script>window.injected=true</script> & "title"';
  entries[0]!.navLabel = '<img src=x onerror="window.injected=true">';
  const { document, dom, panels, links } = await gallery(t, { views: entries });
  assert.equal(
    panels[0]!.querySelector("h1,h2")!.textContent,
    entries[0]!.diagram.title,
  );
  assert.equal(
    links[0]!.querySelector(".nav-label")!.textContent,
    entries[0]!.navLabel,
  );
  assert.equal(document.querySelectorAll("img,[onerror]").length, 0);
  assert.equal(
    (dom.window as unknown as { injected?: boolean }).injected,
    undefined,
  );
});
