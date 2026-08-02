# Contributing to BX SSH

Thank you for contributing to BX SSH. The project values small, reviewable changes, explicit security boundaries, and a readable Git history.

## Before Contributing

- Search existing issues and pull requests before opening a new one.
- Use the issue templates for bug reports and feature requests.
- Do not open a public issue for a vulnerability or leaked secret. Follow [SECURITY.md](SECURITY.md).

## Contribution License

BX SSH is licensed under the Apache License 2.0. Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in BX SSH is provided under the same Apache License 2.0 terms, as described in Section 5 of the license.

Only submit work that you have the right to license. Do not copy code, assets, fonts, documentation, or test data from an incompatible or unknown source. The project does not currently require a separate CLA or DCO sign-off.

## Development Workflow

1. Create or reference an issue for behavior changes.
2. Branch from the latest `main` using the naming rules below.
3. Keep the change focused and add tests in proportion to its risk.
4. Rebase on `main` before final review when necessary.
5. Open a pull request using a Conventional Commit title.
6. Resolve review comments without rewriting unrelated code.

Branch names use lowercase ASCII and hyphens:

```text
feat/123-terminal-search
fix/456-sftp-cancel-race
docs/78-update-security-policy
chore/dependency-audit
```

Allowed prefixes are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `release`.

## Commit Messages

Commits follow Conventional Commits:

```text
<type>(<scope>): <short imperative summary>
```

Examples:

```text
feat(ssh): 增加主机指纹校验状态
fix(sftp): 修复取消传输后句柄未释放的问题
docs(repo): 补充公开发布流程
chore(deps): 更新 Tauri 工作区依赖
```

Keep `type` and `scope` in lowercase English so automation can parse them, but write the summary after the colon in Chinese. The commit body should normally use Chinese; English technical terms may be retained when translating them would reduce precision.

External contributors may open a pull request with an English title or description. Before squash merge, a maintainer must normalize the final commit title to the Chinese-summary format used by `main`.

Preferred scopes are `desktop`, `ui`, `ssh`, `sftp`, `persistence`, `platform`, `contracts`, `deps`, `release`, `docs`, and `repo`.

Configure the repository commit template locally:

```powershell
git config commit.template .gitmessage
```

Each commit must be atomic: it should represent one coherent behavior, fix, refactor, or documentation change. Do not mix generated files, formatting churn, dependency upgrades, and feature behavior unless they are inseparable.

Use trailers when applicable:

```text
Refs: #123
Fixes: #456
Co-authored-by: Name <email@example.com>
BREAKING CHANGE: connection records require schema version 4
```

Do not fabricate authorship, use shared Git identities, or remove another contributor's attribution.

## Pull Requests

- The PR title must follow the same Conventional Commit format. Before squash merge, its final summary must be Chinese because it becomes the `main` commit.
- Explain the problem, behavior change, risks, test evidence, and data/security impact.
- Include screenshots only for visible UI changes and redact hostnames, usernames, paths, and credentials.
- Link the issue using `Fixes #123` when the PR fully resolves it.
- Keep generated build output and local test artifacts out of Git.
- Maintainers use squash merge by default. Direct pushes and force-pushes to `main` are prohibited.

## Quality and Security

Before requesting review, run the formatting, static analysis, unit, integration, and relevant end-to-end checks provided by the workspace. The exact commands will be added when the production scaffold is initialized.

Changes involving SSH authentication, host keys, credentials, local paths, SQL migrations, updates, or release signing require an explicit security review section in the PR.

Never commit:

- passwords, private keys, tokens, certificates with private material, or signing keys;
- real user databases, logs, diagnostics, host inventories, or `known_hosts` files;
- build artifacts, dependency directories, test reports, or exported release packages.

If a secret reaches Git history, rotate or revoke it immediately before attempting history cleanup. Follow the incident procedure in [GOVERNANCE.md](GOVERNANCE.md).

## Review Standard

A pull request is ready to merge only when:

- required CI checks pass;
- required reviewers approve it;
- discussions are resolved;
- tests and documentation match the behavior;
- migration and compatibility effects are explicit;
- the branch contains no secret, unrelated change, or generated artifact.
