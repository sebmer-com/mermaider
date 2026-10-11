/** Stable interchange types. Extractors read text; they must never import application code. */
export const FAMILIES = [
  "architecture",
  "dependencies",
  "pipeline",
  "data",
  "states",
  "process",
] as const;
export type Family = (typeof FAMILIES)[number];
export type Syntax = "flowchart" | "sequence" | "state" | "er";
export interface Evidence {
  path: string;
  line?: number;
  symbol?: string;
  sha256?: string;
}
export interface Diagnostic {
  code: string;
  message: string;
  severity: "warning" | "error";
  path?: string;
  diagramId?: string;
}
export interface Attribute {
  name: string;
  type: string;
  key?: "PK" | "FK" | "UK";
}
export interface GraphNode {
  id: string;
  label: string;
  kind?: string;
  evidence: Evidence[];
  attributes?: Attribute[];
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: string;
  evidence: Evidence[];
  cardinality?: { from: string; to: string };
}
export interface SequenceStep {
  from: string;
  to: string;
  label: string;
  kind?: "message" | "reply";
  evidence: Evidence[];
}
export interface Diagram {
  id: string;
  title: string;
  family: Family;
  syntax: Syntax;
  direction?: "LR" | "TD";
  provenance: "extracted" | "curated";
  context: "implemented" | "planned" | "observed";
  nodes: GraphNode[];
  edges: GraphEdge[];
  steps?: SequenceStep[];
  diagnostics?: Diagnostic[];
}
export interface SourceFile {
  path: string;
  content: string;
}
export interface Extraction {
  diagrams: Diagram[];
  diagnostics: Diagnostic[];
}
export interface Extractor {
  id: string;
  extract(files: SourceFile[]): Extraction;
}
export interface Selection {
  id: string;
  title?: string;
  navLabel?: string;
  model?: string;
  audience?: "overview" | "technical" | "both";
  detail?: "overview" | "detailed" | "both";
  focus?: string[];
  attributes?: "all" | "keys" | "none";
  output?: { markdown: string; mermaid?: string; block?: string };
}
export interface Config {
  version: 1;
  include: string[];
  exclude: string[];
  outputDir: string;
  html?: string;
  audience?: "overview" | "technical" | "both";
  detail?: "overview" | "detailed" | "both";
  diagrams: Selection[];
  hooks: { enabled: boolean; trigger: "commit" | "changes" };
}
export interface SemanticModel {
  version: 1;
  review: "proposed" | "reviewed";
  diagram: Diagram;
}
export interface HookStatus {
  configured: boolean;
  fingerprint: string;
  current: boolean;
  blocked: boolean;
  reason: string;
  head: string | null;
  trigger?: "commit" | "changes";
}
export interface RunResult {
  ok: boolean;
  fingerprint: string;
  diagrams: string[];
  changed: string[];
  diagnostics: Diagnostic[];
}
