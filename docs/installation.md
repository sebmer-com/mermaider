# Install the skill and native hooks

Mermaider 0.1 is distributed as source. Build the checkout before enabling hooks; plugin installation does not install Node dependencies or compile TypeScript. Requires Node.js 22.13 or later, including the built-in SQLite support used for schema replay.

```sh
git clone https://github.com/sebmer-com/mermaider.git
cd mermaider
npm ci
npm run build
```

Use the built folder for the integrations below. Keep `node_modules`, `dist`, `skills`, manifests, and `hooks` available in the actual installed location. A client may copy or cache a plugin without its ignored build/dependency directories; inspect the resolved installed folder and run `npm ci` plus `npm run build` there when needed before enabling hooks. When updating, rebuild that installation before restarting the client. Pin a Git commit when you need identical tool versions across a team.

## Codex desktop: local plugin marketplace

The package contains the portable `plugin.json` and a `.codex-plugin/plugin.json` compatibility manifest. Both select `hooks/codex.json`; there is no default `hooks/hooks.json` to load a second time. The checkout also contains `.agents/plugins/marketplace.json`, named `mermaider-local`, which points at the checkout itself for local authoring and tests.

Follow Codex's [local plugin installation](https://developers.openai.com/plugins/build/plugins) mechanism. One concrete repository-scoped layout is:

```text
your-repository/
  .agents/plugins/marketplace.json
  plugins/mermaider/                 # built checkout, including dependencies
```

Clone and build Mermaider in `plugins/mermaider`, or copy an already-built checkout there. Keep this tool installation out of application source analysis and version control as appropriate for your project. Merge the following entry into an existing marketplace, preserving other entries. For a new marketplace, use:

```json
{
  "name": "local-tools",
  "interface": { "displayName": "Local developer tools" },
  "plugins": [
    {
      "name": "mermaider",
      "source": { "source": "local", "path": "./plugins/mermaider" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Developer Tools"
    }
  ]
}
```

The source path is relative to the repository root, not to `.agents/plugins`. Restart the desktop app, choose the local marketplace in the Plugins Directory, install Mermaider, and start a fresh chat. Review and trust its hooks through the client before expecting automatic reminders. Enabling a plugin does not itself trust its hooks. Do not edit a trust store to bypass the review.

Optionally merge this setting into `.codex/config.toml` to enable the plugin for the trusted project:

```toml
[plugins."mermaider@local-tools"]
enabled = true
```

For a personal installation the documented equivalent is `~/.agents/plugins/marketplace.json`, with a local source such as `./.codex/plugins/mermaider` relative to the home marketplace root. Do not overwrite an existing catalog or settings file.

The [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) describes supported local surfaces and trust controls. Cloud-orchestrated Work does not load these local command hooks. Plugins with lifecycle hooks use manual/local distribution and are not eligible for the universal public plugin directory. A public GitHub repository is a separate distribution channel.

## Claude Code: load the built folder

Use Claude Code's [local plugin development mechanism](https://code.claude.com/docs/en/plugins):

```sh
cd /absolute/path/to/your-repository
claude --plugin-dir /absolute/path/to/mermaider
```

Invoke `/mermaider:mermaider` or ask Claude to use Mermaider. The `.claude-plugin/plugin.json` manifest points at `hooks/claude.json`. Existing user/project hooks are retained. Reload/restart the session after plugin changes and follow the client's hook review and trust prompts.

This local-folder workflow avoids assuming that a GitHub marketplace installation will run `npm ci` or a build. To distribute through your own marketplace, distribute a prepared installation and verify its dependencies at the installed path. See the official [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).

## Skill-only use

An agent can read `skills/mermaider/SKILL.md` from the built checkout and invoke `dist/cli.js` directly. Keep the full checkout path available, because copying only `SKILL.md` loses its model reference and executable location. Skill-only use has no automatic lifecycle reminders.

## Cursor and Gemini

The repository includes experimental provider handling and example hook configurations for future integration. They are not a claim of a tested end-to-end client installation. Keep them disabled until you validate the exact installed client schema, trust handling, and the smoke checks below.

## Verify a native installation

Use a disposable Git repository and the target client's ordinary permissions. These steps exercise behavior that protocol tests alone cannot prove:

1. Ask the installed skill to discover the repository. Choose one diagram, generate it, run `check` successfully, and open the resulting docs `index.html` to verify actual rendering.
2. Change a selected input file and create a commit if `hooks.trigger` is `commit`. At the next matching event, confirm that the agent receives a Mermaider maintenance request naming the skill and runner.
3. Let the current agent review/update/check the diagram. Confirm the output changes, and the next event is quiet when the repository is current.
4. Introduce an invalid or stale model. Confirm the agent reports the check failure, completion requests at most one extra pass per user turn even when the source fingerprint changes, and later completion is not trapped in a loop. A genuine new user prompt may allow a new attempt.
5. Repeat a pending-update event in plan/read-only mode and after a cancellation. Confirm there is no forced write or nested agent process.
6. Check that existing hooks still run, and that a diagram-only commit does not retrigger maintenance.

Record the client version, platform, permission mode, and results. Mermaider's tests validate adapter input/output contracts; only this client exercise validates actual skill handoff.

Verified during development with **Claude Code 2.1.281**: a stale fixture triggered SessionStart context, the client invoked `mermaider:mermaider`, refreshed the diagram and HTML collection, and completed `check`. The fixture's source and configuration stayed unchanged; the session used ordinary `dontAsk` permissions rather than bypass mode. Codex protocol tests cover its adapter; record a separate live Codex result before claiming the same end-to-end client verification.

For a source-only onboarding exercise, copy [the synthetic example](../examples/README.md) to a separate directory and initialize its own Git repository. `--repo` resolves the containing Git root, so pointing it directly at `examples/basic` inside this checkout would analyze Mermaider itself.

## Troubleshooting

- **Missing runner/dependencies:** build the installed checkout, not another clone, and confirm `node` is available to the client's hook process.
- **No reminder:** check hook trust, `.mermaider/config.json`, `hooks.enabled`, trigger mode, and whether the client supports local hooks. Hooks remain inactive until a repository has configuration.
- **Stale semantic evidence:** inspect the changed implementation and adjust claims before replacing hashes. Do not clear the failure by only changing the review flag.
- **Another update is running:** allow it to finish; do not remove a live lock to force concurrent writes.
- **Client hook failure:** retain the visible error and use `check` manually. Do not work around the client's permission/trust controls.
