# Changelog

All notable changes to BX SSH will be documented in this file.

The format follows Keep a Changelog, and release versions follow Semantic Versioning.

## [Unreleased]

### Added

- Initial open-source repository governance, contribution, security, and conduct policies.
- Apache License 2.0 and project attribution notice.
- Tauri, React, pnpm, and Cargo production workspace with cross-platform CI checks.
- SSH host-key probing and strict SHA-256 verification with password and private-key authentication.
- Interactive SSH shell and PTY validation with resize, binary streaming, exit status, and xterm.js rendering.
- Bounded terminal output batching with binary IPC, xterm.js acknowledgements, and session-level backpressure.
- Full terminal buffer reset between sessions so large scrollback allocations can be reclaimed.
- SSH keepalives preserve idle interactive sessions without treating operation timeouts as connection lifetime limits.
- Independent SFTP sessions with directory browsing, atomic streaming uploads and downloads, SHA-256 integrity verification, stable command errors, and a responsive desktop validation view.
- SQLCipher database encryption with random system-stored data keys, transactional migrations, Argon2id password fallback, and independently encrypted imported private keys.
- Unsigned Windows, macOS, and Linux prototype packaging with installation-bundle size reports and enforced desktop size budgets.
- Signed full-package update checks and installation with tamper and wrong-key rejection validation.
- OpenSSH compatibility testing across Ubuntu 22.04, Ubuntu 24.04, Debian 12, Rocky Linux 9, and Windows Server 2025, covering Ed25519, ECDSA P-256, RSA-SHA2, password, public-key, and keyboard-interactive authentication.
- Debug-only Tauri end-to-end testing on Windows, macOS, and Linux with keyboard workflows, Windows viewport/DPI profiles, WCAG 2.1 A/AA reports, and isolated test permissions.
- Credential, host-fingerprint, CSP, command-boundary, path-traversal, external-link, and log-redaction security controls are validated by a dedicated regression gate.
- Startup, multi-session, terminal-output, memory, and SFTP performance budgets are captured by a dedicated regression gate and report schema.
- A 24-hour stability, sleep/wake, network interruption, reconnect, and resource-leak protocol is enforced through a versioned budget and report validator.
- G0-09 security and supply-chain gates with Rust/npm vulnerability and license checks, full-history secret scanning, CycloneDX SBOM archival, automated dependency updates, and a threat model.
