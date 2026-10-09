# HTML placement with agent frameworks

Mermaider always saves the selected diagram collection as HTML. The skill chooses its documentation location with the user, and maintenance preserves that saved location. Markdown/Mermaid files remain available for diffs and integration into existing chapters.

## Placement order

1. Follow the user's explicit destination, saved `.mermaider/config.json`, and the repository's established documentation rules. Pass `init --output <directory>` when those rules imply a location the default detector cannot understand.
2. If `docs/architecture/` already exists, the default is `docs/architecture/mermaider/index.html`.
3. For a repository using Superpowers, otherwise use `docs/superpowers/mermaider/index.html`.
4. For Oh My Codex or a repository with no framework-specific docs convention, use `docs/mermaider/index.html`.

When both frameworks are detected, initialization uses the neutral `docs/mermaider` default unless an architecture directory exists. The skill resolves any conflicting repository guidance before saving a new selection. A globally installed framework alone does not move project documentation.

The deterministic detector uses repository-local directories and small guidance/configuration files as hints, and returns its evidence. It does not execute framework setup, change framework settings, or create framework runtime state. Its suggestion is a default; explicit output choices take priority.

## What the upstream conventions actually say

**Superpowers** stores implementation plans under `docs/superpowers/plans/` and design specs under `docs/superpowers/specs/`. Mermaider's `docs/superpowers/mermaider/` is our sibling-directory convention for maintained current-state diagrams. It is not an upstream requirement, and diagrams do not overwrite dated plans or specs. [Writing plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md), [Brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md).

**Oh My Codex (OMX)** keeps runtime state and plans under `.omx/`; its optional project wiki stores Markdown knowledge under `omx_wiki/`. The inspected upstream documentation does not define an HTML documentation directory. Mermaider therefore follows an actual repository docs convention if present and otherwise uses `docs/mermaider`. It does not invent `.omx/docs` or write HTML into wiki indexes. [OMX README](https://github.com/Yeachan-Heo/oh-my-codex), [Plan skill](https://github.com/Yeachan-Heo/oh-my-codex/blob/main/skills/plan/SKILL.md), [Project wiki storage](https://github.com/Yeachan-Heo/oh-my-codex/blob/main/docs/reference/project-wiki.md).

These integrations compose with the active agent's workflow. Mermaider remains standalone, and repository/user instructions determine whether resulting documentation changes are committed together with code or separately.
