## Development workflow

Requirements for all code changes:

- use red/green TDD as the internal development methodology; pausing for approval of tests before implementation is not required
- update README and other relevant docs for completeness when any package receives new functionality or other notable changes
- all functions, classes and properties need docstrings

## Source control

- If writing a commit/revision message, use conventional commit format, but do not include the name of the package in parens.Example: if fixing a bug in vmpi, just do `fix: <description>`, not `fix(vmpi): description`


## Release Please

This repo uses [release-please](https://github.com/googleapis/release-please) in monorepo mode. Each package under `packages/` is versioned independently. Key rules:

- **Commits are attributed to packages by the files they touch.** A commit that changes files in `packages/vmpi/` will only bump vmpi's version. A commit with no files changed (empty commit) is attributed to *all* packages and will trigger a version bump for every package — avoid this.
- **Never use empty commits to surface a change for a specific package.** Instead, make the actual change touch at least one file inside the target package directory (e.g. a trivial whitespace fix, or re-export). If you must use an empty commit, know it will bump all packages.
- **To fix a PR #132-style over-bump:** check out the `release-please--branches--main` branch, restore non-target packages' `package.json` and `CHANGELOG.md` from `main`, update `.release-please-manifest.json` to keep those packages at their current released versions, commit, and force-push the branch.