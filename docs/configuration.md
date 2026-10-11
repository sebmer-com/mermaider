# Configuration and existing documentation

`.mermaider/config.json` is the versioned contract for a target repository. Run `discover` first; use its IDs rather than guessing extractor-generated IDs. `init --select id-one,id-two` selects those diagrams. Alternatively, `init --families architecture,pipeline,data` selects the diagrams currently discovered in those families. `--output <directory>` sets the docs output location; otherwise initialization uses [repository/framework hints](frameworks.md).

The configuration supports these fields:

```json
{
  "version": 1,
  "include": [
    "src/**",
    "migrations/**",
    ".github/workflows/**",
    "wrangler.jsonc",
    "package.json"
  ],
  "exclude": ["src/generated/**", "plugins/**"],
  "outputDir": "docs/mermaider",
  "audience": "both",
  "detail": "both",
  "diagrams": [
    { "id": "code:dependencies" },
    { "id": "signup-flow", "model": ".mermaider/models/signup-flow.json" }
  ],
  "hooks": { "enabled": true, "trigger": "changes" }
}
```

This example assumes the repository has TypeScript imports and a separately authored `signup-flow` model. Replace the diagram selection with your discovered IDs and actual models. Missing selected IDs or evidence are failures, not a request to silently drop a diagram.

`include` defaults to `['**/*']`; `exclude` defaults to `[]`. Choose globs broad enough to include future files relevant to a diagram. `.mermaider` configuration/models are included as control inputs. Git repositories use tracked and non-ignored untracked files; other directories are walked directly. V1 reads supported text extensions, excludes dependency/build/cache directories and common secret files, does not follow symlinks, and rejects source files larger than 10 MiB. An ignored file is not automatically part of analysis because it exists on disk.

`audience` accepts `overview`, `technical`, or `both`; `detail` accepts `overview`, `detailed`, or `both`. Both can be set globally and overridden on individual diagram selections, preserving mixed needs such as a product-facing architecture overview and a detailed technical signup sequence. These settings preserve choices for the skill; they do not make an LLM interpretation deterministic or automatically simplify the graph.

## Selecting a readable subset

A selection may include `title`, `navLabel`, `focus`, and `attributes`:

```json
{
  "id": "your-discovered-schema-id",
  "title": "Accounts and projects",
  "navLabel": "Accounts",
  "focus": ["accounts", "projects", "memberships"],
  "attributes": "keys"
}
```

Use actual exact node labels or IDs returned by discovery for `focus`. The generated view includes the selected nodes and relationships between them, and identifies itself as a projection. `attributes` accepts `all`, `keys`, or `none`; it controls displayed ER attributes. It does not remove facts from source extraction or redefine the database schema. Prefer several coherent topics to a diagram containing hundreds of tables.

`navLabel` is an optional short label for the HTML navigation. Use a few familiar, distinctive words such as `Architecture`, `Deploy`, or `Accounts`; when omitted, the viewer derives a compact label from the title. The full `title` remains the diagram heading. A navigation label changes presentation only: it does not rename the diagram ID, modify evidence, or change generated Mermaid relationships.

Diagram IDs must be unique within the configuration. A selection may instead point to an agent-authored model with `model`. See [semantic models](../skills/mermaider/references/models.md) for evidence and review requirements.

## HTML collection, source files, and managed blocks

Every successful update generates a self-contained HTML viewer for **all selected diagrams**, with the bundled Mermaid runtime for offline viewing. By default it is `<outputDir>/index.html`. An optional top-level `html` property can select another repository-relative `.html` path in the chosen docs folder; HTML generation cannot be disabled. Open this file for visual review and use it as the primary handoff to readers.

The viewer displays one active diagram in a dedicated viewport. Navigation switches that view, with a compact selector on phones. **Fit**, **−**, **+**, and **100%** adjust its SVG scale; drag or use arrow keys to pan, and Ctrl-wheel to zoom. The full title stays visible while **Notes & scope** and **Sources & Mermaid** are collapsed until opened. These controls affect only the browser view, not the saved graph or its freshness state.

In addition to HTML, without an `output` mapping each selection receives `.md` and `.mmd` files under `outputDir`. An explicit mapping can put both source files elsewhere:

```json
{
  "id": "signup-flow",
  "model": ".mermaider/models/signup-flow.json",
  "output": {
    "markdown": "docs/accounts.md",
    "block": "signup",
    "mermaid": "docs/diagrams/signup.mmd"
  }
}
```

Place the following markers around the section Mermaider may maintain:

```html
<!-- mermaider:signup:start -->
<!-- mermaider:signup:end -->
```

Only content between those exact markers is replaced. Start with an empty block: first-time generation refuses to overwrite existing unowned content. Missing, duplicate, or reversed markers fail the update. Prose outside the block remains part of source fingerprints, so an edited explanation can trigger review. `mermaid` is optional on an explicit mapping. Without `block`, the mapped Markdown file is wholly generated; choose a new destination. After generation, local edits to owned content are also protected against automatic replacement and must be reconciled deliberately.

Paths must be repository-relative and cannot escape the repository, traverse `.git`, or go through symlinks. Generated output is excluded at the exact file or managed-block boundary; the entire documentation directory is not implicitly ignored.

## Freshness and local state

The generated `.mermaider/manifest.json` records the inputs/output state used by `check`. Version it with the configuration, models, HTML viewer, and diagram sources. Content fingerprints include the tool's implementation, configuration, discovered input paths and contents; an added relevant file can invalidate the current result. Explicit semantic evidence is fingerprinted even when its file falls outside normal source globs. Evidence cannot reference a model or generated output as its own proof. Generated timestamps are avoided so repeated runs remain byte-identical.

`hooks.enabled` can disable automatic reminders without disabling CLI use. `hooks.trigger` selects:

- `changes`: consider selected source changes at eligible lifecycle events.
- `commit`: defer ordinary in-session reminders until Git HEAD changes; the next session can still discover outstanding maintenance. Analysis still reads the current working tree, including uncommitted changes, rather than checking out a clean commit snapshot.

Hooks also avoid repeated notification for an unchanged pending state and permit at most one extra completion pass per user turn across fingerprint changes. A genuine new user prompt can reset that allowance; generated follow-up instructions do not. Hook state lives in the provider's plugin data directory when available, otherwise in Git's common directory, keyed by worktree. Update locks also live in the Git directory; non-Git CLI usage falls back to `.mermaider/cache/`, which should be ignored. A pending/failed attempt is never a successful manifest update. Do not reset live locks or continuation state just to force another attempt.
