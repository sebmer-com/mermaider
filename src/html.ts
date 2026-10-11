import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Diagram, Evidence } from "./types.js";
import { diagramEvidence } from "./render.js";
import { stableId } from "./util.js";
import { brandFonts } from "./brand.js";
import { VIEWER_STYLES } from "./viewer-styles.js";
import { VIEWER_SCRIPT } from "./viewer.js";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let bundle: Promise<string> | undefined;
export async function mermaidBrowserBundle(): Promise<string> {
  if (!bundle) {
    const directory = path.dirname(
      createRequire(import.meta.url).resolve("mermaid"),
    );
    bundle = Promise.all([
      fs.readFile(path.join(directory, "mermaid.min.js"), "utf8"),
      fs.readFile(path.join(directory, "../LICENSE"), "utf8"),
    ]).then(
      ([script, license]) =>
        `/*! Mermaid license\n${license.replace(/\*\//g, "* /")}\n*/\n` +
        script
          .replace(/\/\/# sourceMappingURL=.*$/gm, "")
          .replace(/<\/script/gi, "<\\/script"),
    );
  }
  return bundle;
}
export interface HtmlView {
  diagram: Diagram;
  mermaid: string;
  projected: boolean;
  navLabel?: string;
}
export function navigationLabel(view: HtmlView): string {
  if (view.navLabel?.trim()) return view.navLabel.trim();
  const compact = view.diagram.title
    .split(":")[0]
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim();
  if (compact.length <= 32) return compact;
  const shortened = compact.slice(0, 31).replace(/\s+\S*$/, "");
  return (shortened || compact.slice(0, 31)).trimEnd() + "…";
}
/** One selected SVG at a time. Assets are embedded for an offline, portable docs file. */
export async function renderHtml(
  views: HtmlView[],
  link: (e: Evidence) => string,
): Promise<string> {
  const anchor = (d: Diagram) => stableId("diagram", d.id);
  const familyNames: Record<string, string> = {
    architecture: "Architecture",
    dependencies: "Dependencies",
    pipeline: "Pipeline",
    data: "Data model",
    states: "States",
    process: "Process",
  };
  const navigation = views
    .map(
      (view, index) =>
        `<a href="#${anchor(view.diagram)}" data-diagram="${anchor(view.diagram)}" data-search="${escape((view.diagram.title + " " + navigationLabel(view)).toLowerCase())}" title="${escape(view.diagram.title)}"><span class="nav-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><span class="nav-label">${escape(navigationLabel(view))}</span></a>`,
    )
    .join("\n");
  const options = views
    .map(
      (view) =>
        `<option value="${anchor(view.diagram)}">${escape(navigationLabel(view))}</option>`,
    )
    .join("");
  const focusNode = (d: Diagram) => {
    const degree = new Map(d.nodes.map((n) => [n.id, 0]));
    const incoming = new Set(d.edges.map((e) => e.to));
    for (const edge of d.edges) {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    }
    const roots =
      d.family === "process" || d.family === "pipeline"
        ? d.nodes.filter((n) => !incoming.has(n.id))
        : [];
    return [...(roots.length ? roots : d.nodes)].sort(
      (a, b) =>
        (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
        a.id.localeCompare(b.id, "en"),
    )[0];
  };
  const panels = views
    .map(
      ({
        diagram: d,
        mermaid,
        projected,
      }) => `<section class="diagram-panel" id="${anchor(d)}" data-title="${escape(d.title)}" data-family="${d.family}" data-direction="${d.direction || (d.family === "process" ? "TD" : "LR")}" data-focus="${focusNode(d) ? stableId("n", focusNode(d).id) : ""}" hidden>
<div class="diagram-header"><h1>${escape(d.title)}</h1><p class="diagram-description">${escape(familyNames[d.family] || d.family)} · ${d.provenance === "curated" ? "Reviewed process model" : "Declared source structure"} · ${escape(d.context)}${projected ? " · Selected view" : ""}</p></div>
<div class="toolbar"><span class="toolbar-hint">Drag to move · Ctrl + scroll to zoom</span><div class="zoom-controls" aria-label="Diagram controls"><button class="zoom-symbol" type="button" aria-label="Zoom out" title="Zoom out" disabled>−</button><output class="zoom-level" aria-label="Zoom level">—</output><button class="zoom-symbol" type="button" aria-label="Zoom in" title="Zoom in" disabled>+</button><span class="control-rule" aria-hidden="true"></span><button type="button" aria-label="Fit diagram" title="Fit the whole diagram (0)" disabled>Fit</button><button type="button" aria-label="Actual size" title="Actual size (1)" disabled>100%</button></div></div>
<div class="canvas" role="region" tabindex="0" aria-label="Diagram canvas: ${escape(d.title)}"><div class="canvas-plane"><div class="diagram-svg"></div></div><div class="render-loading" role="status" aria-live="polite">Rendering diagram…</div></div>
<div class="diagram-details"><details><summary>Notes &amp; scope${d.diagnostics?.length ? ` <span>${d.diagnostics.length} ${d.diagnostics.length === 1 ? "note" : "notes"}</span>` : ""}</summary><p>${projected ? "This is an explicitly selected subset of the source model. " : ""}${d.context === "planned" ? "This view describes planned behavior. " : d.context === "observed" ? "This view is based on recorded observations. " : "This view describes repository implementation or configuration. "}Freshness checks track source evidence; they do not prove live deployment or every semantic interpretation.</p>${d.diagnostics?.length ? `<ul class="scope-list">${d.diagnostics.map((x) => `<li>${escape(x.message)}</li>`).join("")}</ul>` : ""}</details>
<details><summary>Sources &amp; Mermaid</summary><p class="detail-label">Source evidence</p><ul class="evidence-list">${diagramEvidence(
        d,
      )
        .map(
          (e) =>
            `<li><a href="${escape(link(e))}">${escape(e.path)}${e.symbol ? ` · ${escape(e.symbol)}` : ""}${e.line ? `:${e.line}` : ""}</a></li>`,
        )
        .join(
          "",
        )}</ul><p class="detail-label">Mermaid source</p><pre class="source mermaid-source">${escape(mermaid)}</pre></details></div></section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#ffffff"><title>Mermaider · Repository diagrams</title><style>${await brandFonts()}\n${VIEWER_STYLES}</style></head><body>
<a class="skip-link" href="#main">Skip to diagram</a><aside class="sidebar"><a class="wordmark" href="#${views[0] ? anchor(views[0].diagram) : "main"}" translate="no">Mermaider</a><p class="byline">diagrams, made clear.</p><div class="desktop-navigation"><div class="nav-heading"><span>Diagrams</span><span>${String(views.length).padStart(2, "0")}</span></div><label class="utility" for="diagram-search">Find a diagram</label><input class="nav-search" id="diagram-search" name="diagram-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search…"><nav class="nav-links" aria-label="Diagrams">${navigation}</nav><p class="nav-empty" id="nav-empty" role="status" hidden>No matching diagrams.</p></div><div class="mobile-picker"><label for="diagram-picker">Choose diagram</label><select id="diagram-picker" aria-label="Choose diagram">${options}</select></div><div class="credit">A tool by <a href="https://sebmer.com/brand/" translate="no">Seb Builds</a><br>Saved HTML · works offline</div></aside>
<main id="main" tabindex="-1"><div class="page-heading utility"><span>Repository diagrams</span><span id="view-position">01 / ${String(views.length).padStart(2, "0")}</span></div><noscript><p class="noscript">Enable JavaScript to view the interactive diagrams. Their Mermaid source remains below.</p><style>.diagram-panel[hidden]{display:block!important}.canvas,.toolbar{display:none}</style></noscript>${panels}<footer class="footer">Mermaider · Source-grounded diagrams · Seb Builds</footer></main>
<script>${await mermaidBrowserBundle()}</script><script>${VIEWER_SCRIPT}</script></body></html>\n`;
}
