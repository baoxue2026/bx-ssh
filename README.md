# BX SSH

BX SSH is an open-source desktop SSH client focused on secure connection management, terminal workflows, and SFTP file transfer.

The project is currently building its production workspace and technical-validation baseline.

## Current Direction

- Desktop: Tauri 2
- Core: Rust and Tokio
- UI: React 18, TypeScript, Vite, Ant Design 5
- Terminal: xterm.js
- SSH/SFTP: russh and russh-sftp are the current candidates and remain under compatibility validation
- Storage: SQLCipher with operating-system credential storage
- First release platform: Windows x64

## Governance

Repository, commit, pull-request, and release rules are documented in [GOVERNANCE.md](GOVERNANCE.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Security reports must follow [SECURITY.md](SECURITY.md) and must not be filed as public issues.

## Development

The workspace requires Node.js 22, pnpm 10, the pinned Rust toolchain, and the native prerequisites documented by Tauri for the target operating system.

```powershell
pnpm install
pnpm dev
```

Run all local quality checks before opening a pull request:

```powershell
pnpm check
```

## License

BX SSH is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
