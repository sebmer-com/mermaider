# Runnable example

[`basic/`](basic/) is a small, public, synthetic repository for trying Mermaider. It has no credentials or connection to a deployed application. Its TypeScript defines a signup service with injected dependencies; its Wrangler resources and CI jobs are illustrative declarations. Run Mermaider against the fixture, not the application itself.

The saved selection maintains four diagrams:

| View            | Source                                                   | What it establishes                                                          |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Architecture    | `wrangler.jsonc`                                         | Declared Worker, D1 database, and queue resources                            |
| Pipeline        | `.github/workflows/ci.yml`                               | The `package` job depends on `validate`; both jobs only print messages       |
| Data            | `migrations/001_accounts.sql`                            | Reconstructed accounts and verification-token tables, keys, and relationship |
| Signup sequence | `src/signup.ts` and `.mermaider/models/signup-flow.json` | Reviewed order of the successful new-account path                            |

Discovery also finds the `AccountStatus` values. They are deliberately unselected: an enum supplies possible values, not lifecycle transitions. The architecture does not prove that the injected TypeScript dependencies use the declared Cloudflare resources. No deployment or runtime behavior is verified.

## Try it in a separate repository

First build the Mermaider checkout using the [installation guide](../docs/installation.md). These commands start at its root and work in macOS or Linux shells:

```sh
mermaider_root="$(pwd)"
example_root="$(mktemp -d /tmp/mermaider-basic.XXXXXX)"
cp -R "$mermaider_root/examples/basic/." "$example_root/"
git -C "$example_root" init --quiet

node "$mermaider_root/dist/cli.js" discover --repo "$example_root"
node "$mermaider_root/dist/cli.js" update --repo "$example_root"
node "$mermaider_root/dist/cli.js" check --repo "$example_root"
```

Use the separate temporary repository: `--repo` resolves a directory inside an existing Git checkout to that checkout's root. Passing `examples/basic` directly from the Mermaider checkout would target Mermaider itself.

Open `docs/mermaider/index.html` inside the temporary repository in a browser. The same directory contains Markdown and Mermaid source for the four views. The fixture ships configuration and source models; generated output is created by `update` for the installed tool version. No fixture dependencies need to be installed and no fixture code needs to run. SQLite schema extraction uses Node.js 22.13 or later's built-in SQLite support to reconstruct the schema in memory.

`check` should pass with a `SUCCESS_PATH_ONLY` coverage warning. The signup model excludes invalid-email and duplicate-account branches, dependency failures, and concurrent requests. In the source, insertion finishes before sending to the queue; a send failure can therefore leave a stored account. There is no transaction or retry. The warning keeps that boundary visible in the generated documentation.

Verified with this checkout: `update` and `check` passed for all four selections; another `update` changed no paths and preserved identical output bytes. The generated HTML contained four diagram sections and inline scripts without remote script sources. Changing `registerAccount` made `check` fail on stale semantic evidence; restoring it made the check pass. These checks do not execute the signup service or verify a deployment.

## Try a source change

Edit `registerAccount` in the temporary copy, then run `check` again. A changed declaration should invalidate its recorded evidence. Read the implementation and correct every affected sequence claim before refreshing its evidence:

```sh
node "$mermaider_root/dist/cli.js" evidence \
  --repo "$example_root" --path src/signup.ts --symbol registerAccount
```

Copy the returned evidence object into each affected `evidence` array only after reviewing the associated claim. Keep `review` as `proposed` if any claim remains unsupported. Then run `update`, `check`, and inspect the generated diagrams. A current checksum is not proof that a semantic model is correct.
