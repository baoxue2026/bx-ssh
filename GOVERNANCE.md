# Repository Governance

BX SSH maintains a small, reviewable, and auditable Git history. These rules apply to maintainers and external contributors.

## Branches

- `main` is the only long-lived branch and must remain buildable.
- All changes enter `main` through pull requests.
- Direct pushes, force pushes, and branch deletion are blocked on `main`.
- Working branches use `<type>/<issue>-<description>`, for example `feat/123-terminal-search`.
- Branch names use lowercase ASCII, numbers, slashes, and hyphens.

## Commits

Commits follow Conventional Commits:

```text
<type>(<scope>): <简短中文说明>
```

Examples:

```text
feat(ssh): 增加主机指纹校验状态
fix(sftp): 修复取消传输后句柄未释放的问题
docs(repo): 补充公开发布流程
chore(deps): 更新 Tauri 工作区依赖
```

The `type` and `scope` remain lowercase English for automation; the summary is Chinese. Preferred types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`.

Each commit must represent one coherent change. Do not mix feature behavior with unrelated formatting, dependency updates, generated output, or independent fixes.

## Pull Requests

- PR titles follow the same Conventional Commit format.
- External contributors may initially use English, but maintainers normalize the final squash title to a Chinese summary.
- Every behavior change links an issue and explains the problem, solution, risk, test evidence, and data or security impact.
- UI evidence must redact credentials, private keys, hostnames, usernames, IP addresses, local paths, and terminal contents.
- Required checks and reviews must pass before merge.
- Squash Merge is the default so one PR becomes one coherent `main` commit.

## Authorship and Contributions

- Contributors use individual Git identities; shared identities and fabricated attribution are prohibited.
- Co-authored work retains accurate `Co-authored-by:` trailers.
- BX SSH uses Apache License 2.0. Unless explicitly stated otherwise, intentional contributions are submitted under the same terms according to Section 5.
- The project currently does not require a separate CLA or DCO.
- Contributors remain responsible for reviewing, testing, and licensing AI-assisted work.

## Releases

- Versions follow Semantic Versioning.
- Preview releases use `v0.x.y`; prereleases use suffixes such as `-alpha.1`, `-beta.1`, and `-rc.1`.
- Release tags are annotated, signed, immutable, and point to validated commits on `main`.
- `CHANGELOG.md` keeps an `[Unreleased]` section and records user-visible changes.
- Build artifacts, SBOMs, signatures, symbols, and test reports are generated and archived by CI, not committed to source control.

## Sensitive Data

Never commit passwords, private keys, tokens, signing material, real databases, host inventories, logs, diagnostics, or user data.

If a secret reaches Git history:

1. Revoke or rotate it immediately.
2. Determine its exposure and affected systems.
3. Remove it from the current tree.
4. Coordinate history rewriting only after rotation.
5. Invalidate affected builds and notify contributors when required.

Deleting a secret in a later commit does not remove it from history. Public history is rewritten only for incidents such as secret or personal-data exposure, never to hide ordinary mistakes.
