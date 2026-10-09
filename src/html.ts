import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Diagram, Evidence } from "./types.js";
import { diagramEvidence } from "./render.js";
import { stableId } from "./util.js";

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
}
/** A single portable HTML document: no server, remote CDN, or network request is needed. */
export async function renderHtml(
  views: HtmlView[],
  link: (e: Evidence) => string,
): Promise<string> {
  const anchor = (d: Diagram) => stableId("diagram", d.id);
  const navigation = views
    .map(
      (v) => `<a href="#${anchor(v.diagram)}">${escape(v.diagram.title)}</a>`,
    )
    .join("\n");
  const sections = views
    .map(
      ({
        diagram: d,
        mermaid,
        projected,
      }) => `<section id="${anchor(d)}" data-title="${escape(d.title.toLowerCase())}">
<header><div><span class="eyebrow">${escape(d.family)} · ${escape(d.context)} · ${escape(d.provenance)}</span><h2>${escape(d.title)}</h2></div><button type="button" class="size-toggle" aria-label="Toggle full size for ${escape(d.title)}">Full size</button></header>
${projected ? '<p class="note">Selected subset of the source model.</p>' : ""}
${d.diagnostics?.length ? `<aside class="notes"><strong>Coverage notes</strong><ul>${d.diagnostics.map((x) => `<li>${escape(x.code)}: ${escape(x.message)}</li>`).join("")}</ul></aside>` : ""}
<div class="canvas"><pre class="mermaid">${escape(mermaid)}</pre></div>
<details><summary>Mermaid source and evidence</summary><pre class="source">${escape(mermaid)}</pre><ul>${diagramEvidence(
        d,
      )
        .map(
          (e) =>
            `<li><a href="${escape(link(e))}">${escape(e.path)}${e.symbol ? ` · ${escape(e.symbol)}` : ""}${e.line ? `:${e.line}` : ""}</a></li>`,
        )
        .join("")}</ul></details>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mermaider · Repository diagrams</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17242a;background:#f3f5f4}*{box-sizing:border-box}body{margin:0}a{color:#156f60}aside.sidebar{position:fixed;inset:0 auto 0 0;width:260px;padding:32px 20px;background:#172b29;color:#eef4f1;overflow:auto}.brand{font-size:25px;font-weight:750;letter-spacing:-1px}.subtitle{font-size:13px;line-height:1.6;opacity:.75}nav{display:grid;gap:8px;margin-top:24px}nav a{color:inherit;font-size:13px;text-decoration:none;padding:9px;border-radius:6px}nav a:hover{background:#ffffff14}main{margin-left:260px;padding:36px;max-width:1700px}h1{font-size:32px;letter-spacing:-1px;margin:0 0 8px}p{line-height:1.6}.intro{max-width:850px;color:#516360}.search{width:100%;padding:12px 14px;border:1px solid #d4ddd9;border-radius:8px;font:inherit;margin:16px 0 26px}section{background:white;border:1px solid #dce4df;border-radius:12px;margin-bottom:28px;padding:24px;scroll-margin-top:20px}section[hidden]{display:none}header{display:flex;gap:16px;justify-content:space-between;align-items:flex-start}h2{font-size:20px;margin:7px 0 15px;overflow-wrap:anywhere}.eyebrow{text-transform:uppercase;font-size:10px;letter-spacing:1.2px;color:#54796d}button{font:inherit;font-size:12px;white-space:nowrap;padding:8px 12px;border:1px solid #cbd8d2;background:#f5f8f6;border-radius:6px;cursor:pointer}.canvas{overflow:auto;min-height:80px;padding:18px 0}.mermaid{margin:0;text-align:center}.canvas svg{height:auto;max-width:100%!important}.full-size .canvas svg{max-width:none!important}details{border-top:1px solid #e4eae6;padding-top:16px;font-size:13px;color:#466057}summary{cursor:pointer;font-weight:600}.source{font:12px/1.65 ui-monospace,monospace;overflow:auto;background:#f4f7f5;padding:16px;border-radius:6px}.note,.notes{font-size:13px;color:#665423;background:#fffae9;padding:12px;border-radius:6px}.render-error{color:#9c2d2d;white-space:pre-wrap}footer{font-size:12px;color:#62756e;padding:10px 0 30px}@media(max-width:850px){aside.sidebar{position:static;width:auto;padding:22px}nav{display:flex;flex-wrap:wrap;margin-top:10px}main{margin-left:0;padding:20px}section{padding:16px}h1{font-size:27px}}@media print{aside.sidebar,.search,button{display:none}main{margin:0;padding:0}section{break-inside:avoid;border:0}details{display:none}}
</style></head><body><aside class="sidebar"><div class="brand">Mermaider</div><p class="subtitle">Source-grounded repository diagrams.<br>Portable, offline HTML.</p><nav aria-label="Diagrams">${navigation}</nav></aside><main><h1>Repository diagrams</h1><p class="intro">${views.length} selected views. Generated from declared source structure and reviewed models. Freshness is checked separately from semantic correctness and live deployment.</p><label for="search">Find a diagram</label><input class="search" id="search" type="search" placeholder="Search diagram titles…">${sections}<footer>Generated by Mermaider · Mermaid is bundled locally under its MIT license. No external services are contacted.</footer></main>
<script>${await mermaidBrowserBundle()}</script>
<script>
mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral',fontFamily:'Arial, sans-serif',flowchart:{htmlLabels:false},maxTextSize:1000000,maxEdges:10000,suppressErrorRendering:true});
Promise.all(Array.from(document.querySelectorAll('.mermaid')).map(async function(node){try{await mermaid.run({nodes:[node]});}catch(error){node.classList.add('render-error');node.textContent='Diagram rendering failed: '+String(error);}})).then(function(){document.documentElement.dataset.rendered='true';});
document.querySelectorAll('.size-toggle').forEach(function(button){button.addEventListener('click',function(){var section=button.closest('section');var full=section.classList.toggle('full-size');section.querySelectorAll('svg').forEach(function(svg){var width=Number((svg.getAttribute('viewBox')||'').trim().split(/\\s+/)[2]);svg.style.width=full&&width>0?width+'px':'';});button.textContent=full?'Fit width':'Full size';});});
document.getElementById('search').addEventListener('input',function(event){var query=event.target.value.toLowerCase();document.querySelectorAll('section[data-title]').forEach(function(section){section.hidden=!section.dataset.title.includes(query);});});
document.querySelectorAll('nav a').forEach(function(link){link.addEventListener('click',function(){document.getElementById('search').value='';document.querySelectorAll('section[data-title]').forEach(function(section){section.hidden=false;});});});
</script></body></html>\n`;
}
