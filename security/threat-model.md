# BX SSH Threat Model

Version: G0-09 (2026-08-03)

## Assets and trust boundaries

- **Local secrets:** SSH passwords, private keys, database data keys, Argon2id-derived material, update public keys, and host fingerprints. Secrets may only enter SQLCipher or the operating-system credential store. They must not enter React state, ordinary logs, crash reports, Git, or installers.
- **WebView and Rust:** React/WebView is a low-trust input surface. Rust owns SSH, filesystem, database, update, and credential-store operations. Tauri commands, events, and channels are cross-boundary APIs and require explicit DTOs, capabilities, and size/path validation.
- **Remote network:** SSH servers and network attackers are untrusted. Connections must verify host public-key fingerprints. First connections and changed fingerprints require explicit user confirmation and must never be silently accepted.
- **Update path:** Manifests, signed bundles, and download hosts are untrusted inputs. Only a complete package with a valid configured-key signature and matching version, platform, and architecture is accepted. Failure preserves the current version and reports the cause.
- **Build supply chain:** GitHub Actions, pnpm/Cargo registries, Action references, runner environments, and release keys are high-value boundaries. Workflows use least privilege, full commit SHAs, lockfiles, and SBOMs. Release private keys only come from a protected environment.

## Primary abuse cases and controls

| Scenario                                         | Control                                                                                                                          | Verification evidence                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WebView injection forges a Tauri call            | Minimal capabilities; Rust-side authorization, type, and size checks; no arbitrary shell API exposed to the frontend             | `capabilities/default.json`, Rust command tests                 |
| A network attacker replaces an SSH host          | SHA-256 host fingerprints, changed-host warnings, and explicit user confirmation                                                 | `crates/ssh-core/src/fingerprint.rs`, OpenSSH integration tests |
| A local attacker extracts passwords or keys      | OS keyring, SQLCipher random data key, separately encrypted imported keys, and no secret echo in UI                              | `crates/persistence` tests and log review                       |
| SFTP input traverses paths or overwrites files   | Normalized remote paths, bounded local destinations, temporary writes followed by atomic replacement, and overwrite confirmation | `crates/ssh-core/src/sftp.rs`, integrity tests                  |
| Terminal output triggers an unsafe action        | xterm text rendering, bounded OSC/link handling and output batches, and user-initiated URL/clipboard operations                  | `apps/desktop/src/components/TerminalPane.tsx`                  |
| Multiline paste executes commands unexpectedly   | Paste preview/confirmation, no implicit execution of newline input, and separated terminal input/output paths                    | End-to-end and manual acceptance tests                          |
| An update is replaced or downgraded              | Ed25519/minisign signature verification, version and architecture binding, and failure rollback                                  | `apps/desktop/src-tauri/src/update.rs`, update validator        |
| CI leaks a key or imports a malicious dependency | Actions pinned to SHAs; lockfiles; cargo-deny, pnpm audit, license, Gitleaks, and SBOM gates; isolated release environment       | `.github/workflows/security.yml`                                |

## Explicitly untrusted phase-one input

ANSI/OSC sequences, remote filenames, SFTP content, hostnames, update JSON, license metadata, test capabilities, and all GitHub issue/PR content are untrusted. Every new command, export format, or update source must add boundary documentation and tests.

## Residual risk

`russh` currently includes a RustSec timing-side-channel advisory in an unfixed `rsa` release. Linux Tauri builds also inherit maintenance advisories from GTK3/glib and urlpattern dependencies. These are time-boxed in `security/risk-acceptance.md` and are not considered fixed.
