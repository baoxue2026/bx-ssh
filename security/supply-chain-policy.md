# BX SSH Supply-chain Security Policy

Version: G0-09 (2026-08-03)

## Required gates

Every pull request and push to `main` must pass these checks:

1. `cargo-deny 0.20.2` checks RustSec advisories, licenses, and registry/source provenance.
2. `pnpm audit --registry=https://registry.npmjs.org --audit-level high` blocks high and critical npm advisories. CI does not depend on a local mirror's audit API.
3. `scripts/check-npm-licenses.mjs --production` restricts release dependencies to licenses in `security/npm-license-policy.json`.
4. The same script checks development dependencies. `css-value@0.0.1` is the existing WebdriverIO-only exception; new Unknown licenses and expired exceptions are blocked.
5. Gitleaks scans the complete Git history and fails on a detected secret.
6. Syft 1.50.0 creates a CycloneDX JSON SBOM, verifies Cargo and npm components, and archives it for 14 days.
7. Pull requests also run GitHub Dependency Review, which blocks high-severity vulnerabilities and prohibited licenses.

Every GitHub Action uses a full commit SHA with a readable version comment. `Cargo.lock` and `pnpm-lock.yaml` are committed, and CI uses frozen/locked installation. Dependabot checks Cargo, npm, and Actions weekly.

## License policy

The Rust allowlist is in `deny.toml` and contains the permissive licenses encountered in the three-platform Cargo graph. Linux GTK/WebKit system libraries are dynamically linked and remain subject to their system-package licenses. The formal phase-one target is Windows; Linux and macOS packages still need their applicable third-party notices.

Production npm dependencies are limited to MIT, ISC, Apache-2.0, and `Apache-2.0 OR MIT`. Development tools are reported separately. Unknown licenses cannot enter a production bundle or be newly introduced, and the current exception requires review within 30 days.

## Keys and build artifacts

Release signing private keys may only come from a GitHub Environment secret or an offline release host. They must not be written to the repository, artifacts, caches, or ordinary logs. Update-signing tests use ephemeral CI keys whose artifacts expire with the job retention period.

SBOMs, test reports, and bundle-size reports may be archived. They must not contain databases, credentials, private keys, logs, or runtime data. `artifacts/` remains excluded by `.gitignore`.

## Updates and exceptions

Security updates are upgraded directly where possible, followed by frontend, Rust, OpenSSH, and Tauri E2E verification. When an upgrade is impossible, the maintainer must record the dependency path, exploit conditions, mitigation, owner, review date, and closure condition in `security/risk-acceptance.md`. A matching minimal `deny.toml` exception is required. An expired exception restores blocking status.
