# G0-09 Risk Register and Release Decision

- Assessment date: 2026-08-03
- Owner: Project maintainer
- Decision: **Conditional Go**

## RA-001: RSA private-key authentication timing side channel

- **Identifier:** `RUSTSEC-2023-0071`, `rsa 0.10.0-rc.18`, through `russh 0.62.5 -> rsa`.
- **Impact:** An attacker able to repeatedly observe RSA decryption/signing timing near the same process could recover partial private-key information. This is not direct unauthenticated remote takeover, but client-side RSA private-key authentication increases exposure.
- **Reason:** Phase one requires OpenSSH RSA private-key compatibility, and current `russh` has no fixed upstream release. Removing it would break an accepted authentication requirement.
- **Mitigation:** Recommend Ed25519 by default; never log private keys or authentication material; verify host fingerprints; protect imported keys with the OS keyring and separate encryption; do not use RSA keys for unattended bulk jobs.
- **Accepted scope:** Phase-one client compatibility only. It does not permit weaker host verification or broader Tauri command permissions.
- **Owner/review:** Project maintainer, 2026-09-03 or an upstream fix, whichever comes first.
- **Closure:** Upgrade `russh`/`rsa` to a fixed release and pass the complete test suite, or remove RSA private-key authentication. Then remove the matching `deny.toml` exception.

## RA-002: GTK3/glib and proc-macro-error transitive dependencies

- **Identifiers:** `RUSTSEC-2024-0370`, `RUSTSEC-2024-0411` through `RUSTSEC-2024-0420`, and `RUSTSEC-2024-0429`.
- **Impact:** Maintenance and historical soundness advisories in GTK3 bindings and macro crates, primarily in the Linux WebKit/Tauri build path.
- **Reason:** Tauri 2.11.5's Linux WebKit path still resolves `gtk 0.18` and `glib 0.18`. These crates are absent from the Windows installer.
- **Mitigation:** Build Linux only on official runners with system packages, expose no additional FFI, keep cargo-deny reporting active, and prioritize the GTK4/WebKit path during Tauri upgrades.
- **Owner/review:** Project maintainer, 2026-09-03.
- **Closure:** Upgrade the Tauri/wry tree so the advisories disappear, or stop Linux packaging and update the policy.

## RA-003: UNIC dependencies under Tauri urlpattern

- **Identifiers:** `RUSTSEC-2025-0075`, `RUSTSEC-2025-0080`, `RUSTSEC-2025-0081`, `RUSTSEC-2025-0098`, and `RUSTSEC-2025-0100`, through `tauri-utils -> urlpattern -> unic-*`.
- **Impact:** Maintenance advisories in transitive WebView URL-pattern parsing dependencies. BX SSH does not call these crates directly.
- **Mitigation/review:** Do not treat URL-pattern parsing as an authorization decision. Prioritize removing the path in a Tauri update and review by 2026-09-03.

## RA-004: Unmaintained paste build-time macro

- **Identifier:** `RUSTSEC-2024-0436`, `paste 1.0.15`, through `specta 2.0.0-rc.22 -> paste`.
- **Impact:** The crate is unmaintained, but the advisory does not describe a vulnerability. It is used while compiling Specta macros and is not part of the BX SSH runtime command or data path.
- **Reason:** The pinned Specta/Tauri Specta versions require this crate, and there is no fixed compatible Specta release. Removing Specta would remove the reviewed Rust-to-TypeScript IPC generation established for phase one.
- **Mitigation:** Keep exact Specta compatibility versions and `Cargo.lock`; verify registry checksums and sources in CI; regenerate bindings and reject any diff on every contract change; do not use `paste` directly in application code.
- **Owner/review:** Project maintainer, 2026-09-03 or a compatible upstream release, whichever comes first.
- **Closure:** Upgrade Specta to a compatible release without `paste`, regenerate IPC bindings, pass all Rust/frontend/E2E gates, and remove the matching `deny.toml` exception.

## Release conditions

Apart from the four registered groups above, Rust advisories, high-severity npm audit, production licenses, full-history secret scan, and SBOM generation must pass. A real leaked key, unsigned update, host-fingerprint bypass, or high-severity production advisory immediately changes the decision to **No-Go**.
