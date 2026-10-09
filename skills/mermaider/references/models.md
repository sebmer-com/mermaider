# Source-backed semantic models

Use a model when a useful process or state relationship requires interpretation. Extracted diagrams already carry their own facts; do not copy them into hand-maintained models without a reason.

Each `.mermaider/models/<name>.json` file has this shape:

```json
{
  "version": 1,
  "review": "proposed",
  "diagram": {
    "id": "signup-flow",
    "title": "Account registration",
    "family": "process",
    "syntax": "sequence",
    "provenance": "curated",
    "context": "implemented",
    "nodes": [
      {
        "id": "registration-handler",
        "label": "Registration handler",
        "evidence": [
          {
            "path": "src/accounts/register.ts",
            "symbol": "registerAccount",
            "sha256": "replace-with-the-command-output"
          }
        ]
      },
      {
        "id": "accounts-database",
        "label": "Accounts database",
        "evidence": [
          {
            "path": "src/accounts/register.ts",
            "symbol": "registerAccount",
            "sha256": "replace-with-the-command-output"
          }
        ]
      }
    ],
    "edges": [],
    "steps": [
      {
        "from": "registration-handler",
        "to": "accounts-database",
        "label": "Insert account",
        "evidence": [
          {
            "path": "src/accounts/register.ts",
            "symbol": "registerAccount",
            "sha256": "replace-with-the-command-output"
          }
        ]
      }
    ]
  }
}
```

This synthetic example illustrates the complete structure, including **evidence arrays** on every claim. The path, symbol, hashes, and claimed insertion must be replaced with facts from the inspected repository. The placeholder hashes are intentionally invalid. Select the completed model in `.mermaider/config.json`:

```json
{ "id": "signup-flow", "model": ".mermaider/models/signup-flow.json" }
```

## Fields

| Field        | Values or meaning                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `review`     | `proposed` or `reviewed`; the latter asserts that the agent checked the model against sources                 |
| `family`     | `architecture`, `dependencies`, `pipeline`, `data`, `states`, `process`                                       |
| `syntax`     | `flowchart`, `sequence`, `state`, `er`                                                                        |
| `provenance` | `curated` for agent-authored models; `extracted` for extractor output                                         |
| `context`    | `implemented`, `planned`, or `observed`; use separate diagrams when these differ                              |
| `nodes`      | Objects containing stable `id`, human-readable `label`, `evidence`, optional `kind` and `attributes`          |
| `edges`      | Objects containing stable `id`, `from`, `to`, `evidence`, optional `label`, `kind`, and ER `cardinality`      |
| `steps`      | Ordered sequence messages with `from`, `to`, `label`, `evidence`, and optional `kind: "message"` or `"reply"` |

Use stable domain IDs so cosmetic label changes do not change identity. Relationship endpoints reference node IDs. A sequence's steps preserve temporal order; do not alphabetize them. For ER attributes use `name`, `type`, and optional `key: "PK"`, `"FK"`, or `"UK"`. ER cardinality uses `from` and `to` Mermaid cardinality strings, such as `"||"` and `"o{"`.

## Evidence is required for claims

Attach evidence to every node, edge, and sequence step:

```json
{
  "path": "src/accounts/register.ts",
  "line": 42,
  "symbol": "registerAccount",
  "sha256": "actual-sha256-from-the-evidence-command"
}
```

The example hash is a placeholder to replace with an actual checksum. `path` is relative to the target repository. `line` helps a reviewer locate the claim. Without `symbol`, the hash covers the whole file. With `symbol`, it covers the uniquely resolved TypeScript declaration; qualify ambiguous names, for example `Provisioner.run`. Use `evidence --path <file> --symbol <name>` for that exact declaration after reviewing it, or omit `--symbol` to record file-level evidence. Do not mix file hashes with symbol references, copy a stale hash, or automatically re-stamp every reference. A checksum establishes source identity, not that a claim follows from it.

For a sequence, inspect call sites, handlers, awaited operations, conditions, and error paths. For a state diagram, locate transition logic, not just enum declarations. Cite each claimed relation with the source that establishes it. Where dynamic behavior cannot be established, simplify to the supported claim and explain the missing coverage. Represent planned behavior from explicitly selected design sources as `planned`. Runtime observations require supplied trace or operational evidence and `observed` context; source declarations alone are `implemented`.

Mark a model `reviewed` only after examining every claim and the relevant changes. If sources disappeared, declarations are ambiguous, or required paths are excluded from source selection, fix the model/scope or keep it proposed and explain why. A failed check must remain visible.
