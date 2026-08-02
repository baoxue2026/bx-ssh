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
