# Design and v1 boundaries

Mermaider has three layers:

1. **Facts:** static extractors read repository text and emit nodes, relationships, evidence, and coverage diagnostics. They never import or execute application code.
2. **Meaning:** the coding agent writes source-backed semantic models for selected business processes and transitions. Models record whether their claims have been reviewed and whether they concern implemented, planned, or observed behavior.
3. **Presentation:** deterministic rendering turns the selected facts/models into an offline HTML diagram collection plus Mermaid and Markdown sources, with stable IDs, sorting, and source links. Sequence message order is meaningful and retained.

The CLI can run without an LLM. Updating a semantic model requires an agent or human to interpret the implementation. There is no hidden API call, background agent, auto-commit, auto-push, or deployment step.

## Supported extraction

| Source                          | V1 output and limits                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Actions YAML             | Job nodes and literal `needs` dependencies. Conditions and reusable workflows are labeled; matrix execution and invoked scripts are not expanded.                                                                                                |
| Wrangler JSON/JSONC             | Declared resources and bindings per configuration/environment. Declared references do not establish deployment identity or live resource existence. Environment inheritance is not fully resolved. Wrangler TOML produces a coverage diagnostic. |
| `package.json` and `Cargo.toml` | Declared dependencies, supported local/workspace references, and qualifiers. These are declarations, not full package-manager or lockfile resolution.                                                                                            |
| TypeScript/JavaScript           | Static imports, declared status values, and recognized `WorkflowStep` calls. Imports are not a call graph; value lists are not transitions; step ownership is not execution order.                                                               |
| SQL schema/migrations           | Supported declarative schema operations applied in migration order. Dynamic SQL and unsupported operations remain visible as diagnostics; review them before relying on the data model.                                                          |

Other technologies can be represented with curated models and explicit evidence. Broad automatic extraction from every framework is outside v1. The skill's discovery catalogue may include useful candidates that require semantic modeling rather than claiming extractor coverage.

## Evidence and review

Nodes and relationships carry source references. Reviewed curated models require source checksums. Evidence can cover a whole file or a uniquely resolved TypeScript declaration; declaration-level evidence narrows the review affected by unrelated edits. It does not prove that the whole runtime behavior is captured.

Freshness and review answer different questions. A fresh, syntax-valid diagram can still omit a behavior or reflect a mistaken interpretation. A declaration in a repository does not establish what is deployed. Unsupported or ambiguous source syntax produces a diagnostic instead of a guessed edge.

## Native hook lifecycle

The native hook reads current repository state, not shell-command strings. It returns compact context to the current coding-agent session; the skill performs any authorized maintenance. The completion hook has a bounded continuation guard. Local state prevents repeating the same request, and update locking prevents cooperative Mermaider writers from overlapping. The engine checks source state again before finalizing an update.

Hooks observe client-reported planning, permission, and cancellation flags. They cannot infer every client mode from absent event fields. The skill therefore independently enforces the active session's read/write boundaries. Failures are reported without unbounded blocking, and manual CLI checks remain available.

Codex and Claude configurations are separate because client protocols differ. Cursor and Gemini are prepared adapters whose actual client installation remains experimental. Protocol tests and a real client handing the request to the skill are separate acceptance layers; see [installation smoke checks](installation.md#verify-a-native-installation).

## Extending Mermaider

An extractor implements `Extractor` from the public types: a stable `id` and `extract(SourceFile[])` returning `Extraction`. Add synthetic fixtures that demonstrate new behavior and unsupported cases, preserve evidence, and keep extraction independent of application execution. Changes to extraction/rendering are fingerprinted as tool changes and require regenerated outputs.

New native clients should adapt the common hook status into the client's documented event schema, preserve bounded continuation and permission handling, and pass both contract tests and an actual client smoke check before being described as supported.

Superpowers can supply an optional outer workflow for scoping, implementation, and verification. Mermaider owns only the selected diagram contract and maintenance cycle. Local repository documentation rules and the user's current task determine how resulting changes are committed.
