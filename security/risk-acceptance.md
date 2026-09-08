# G0-09 Risk Register and Release Decision

- Assessment date: 2026-09-08
- Owner: Project maintainer
- Decision: **Conditional Go**

## Review evidence (2026-09-08)

This review retains the existing scope for development and validation until
2026-09-22. RC publication still requires every phase-one acceptance suite and
the signed release evidence. It does not accept additional npm vulnerabilities.

The registry metadata and the locked dependency graph were checked again:

- [russh 0.63.2](https://crates.io/crates/russh/0.63.2), published September 3,
  still pins `rsa =0.10.0-rc.18`. RustSec RUSTSEC-2023-0071 still has no patched
  version. Upgrading russh alone therefore does not close RA-001.
- [Tauri 2.11.5](https://crates.io/crates/tauri/2.11.5) remains the latest stable
  Tauri release and still depends on GTK 0.18 for Linux. The locked `glib 0.18.5`
  is outside RUSTSEC-2024-0429's affected range; that resolved advisory is not
  an active exception.
- [tauri-utils 2.9.3](https://crates.io/crates/tauri-utils/2.9.3) requires
  `urlpattern ^0.3`. Although urlpattern 0.6 removes UNIC, it cannot satisfy
  that dependency without an upstream Tauri change.
- [Specta 2.0.0-rc.25](https://crates.io/crates/specta/2.0.0-rc.25) still declares
  `paste`. The current generator remains pinned as a compatible set; a generator
  migration must demonstrate that function reflection no longer pulls in paste
  and must preserve the generated IPC contract.
- [css-value 0.0.1](https://www.npmjs.com/package/css-value) remains the only
  published version and has no declared package license. `pnpm why` limits its
  use to WebdriverIO development dependencies. Its existing exception is
  reviewed below as RA-005.

The next review is deliberately limited to two weeks. Remove each exception
as soon as a compatible upstream fix is verified; the expiry gate blocks on
the review date, including for development-only npm license exceptions.

## RA-001: RSA private-key authentication timing side channel

- **Identifier:** `RUSTSEC-2023-0071`, `rsa 0.10.0-rc.18`, through `russh 0.62.5 -> rsa`.
- **Impact:** An attacker able to repeatedly observe RSA decryption/signing timing near the same process could recover partial private-key information. This is not direct unauthenticated remote takeover, but client-side RSA private-key authentication increases exposure.
- **Reason:** Phase one requires OpenSSH RSA private-key compatibility, and current `russh` has no fixed upstream release. Removing it would break an accepted authentication requirement.
- **Mitigation:** Recommend Ed25519 by default; never log private keys or authentication material; verify host fingerprints; protect imported keys with the OS keyring and separate encryption; do not use RSA keys for unattended bulk jobs.
- **Accepted scope:** Phase-one client compatibility only. It does not permit weaker host verification or broader Tauri command permissions.
- **Owner/review:** Project maintainer, 2026-09-22 or an upstream fix, whichever comes first.
- **Closure:** Upgrade `russh`/`rsa` to a fixed release and pass the complete test suite, or remove RSA private-key authentication. Then remove the matching `deny.toml` exception.

## RA-002: GTK3/glib and proc-macro-error transitive dependencies

- **Identifiers:** `RUSTSEC-2024-0370`, `RUSTSEC-2024-0411` through `RUSTSEC-2024-0420`.
- **Impact:** Maintenance and historical soundness advisories in GTK3 bindings and macro crates, primarily in the Linux WebKit/Tauri build path.
- **Reason:** Tauri 2.11.5's Linux WebKit path still resolves `gtk 0.18` and `glib 0.18`. These crates are absent from the Windows installer.
- **Mitigation:** Build Linux only on official runners with system packages, expose no additional FFI, keep cargo-deny reporting active, and prioritize the GTK4/WebKit path during Tauri upgrades.
- **Owner/review:** Project maintainer, 2026-09-22.
- **Closure:** Upgrade the Tauri/wry tree so the advisories disappear, or stop Linux packaging and update the policy.

## RA-003: UNIC dependencies under Tauri urlpattern

- **Identifiers:** `RUSTSEC-2025-0075`, `RUSTSEC-2025-0080`, `RUSTSEC-2025-0081`, `RUSTSEC-2025-0098`, and `RUSTSEC-2025-0100`, through `tauri-utils -> urlpattern -> unic-*`.
- **Impact:** Maintenance advisories in transitive WebView URL-pattern parsing dependencies. BX SSH does not call these crates directly.
- **Mitigation/review:** Do not treat URL-pattern parsing as an authorization decision. Prioritize removing the path in a Tauri update and review by 2026-09-22.

## RA-004: Unmaintained paste build-time macro

- **Identifier:** `RUSTSEC-2024-0436`, `paste 1.0.15`, through `specta 2.0.0-rc.22 -> paste`.
- **Impact:** The crate is unmaintained, but the advisory does not describe a vulnerability. It is used while compiling Specta macros and is not part of the BX SSH runtime command or data path.
- **Reason:** The pinned Specta/Tauri Specta versions require this crate, and there is no fixed compatible Specta release. Removing Specta would remove the reviewed Rust-to-TypeScript IPC generation established for phase one.
- **Mitigation:** Keep exact Specta compatibility versions and `Cargo.lock`; verify registry checksums and sources in CI; regenerate bindings and reject any diff on every contract change; do not use `paste` directly in application code.
- **Owner/review:** Project maintainer, 2026-09-22 or a compatible upstream release, whichever comes first.
- **Closure:** Upgrade Specta to a compatible release without `paste`, regenerate IPC bindings, pass all Rust/frontend/E2E gates, and remove the matching `deny.toml` exception.

## RA-005: css-value development dependency with undeclared license

- **Identifier:** `css-value 0.0.1`, through `webdriverio`.
- **Impact:** Missing license metadata in a test-only transitive package; this
  exception grants no right to copy its code into the application or ship it.
- **Mitigation:** Restrict the exception to this exact version, `Unknown` license
  and development scope. Production license checks remain strict.
- **Owner/review:** Project maintainer, 2026-09-22.
- **Closure:** Replace the WebdriverIO dependency path or verify an upstream
  release with license metadata, then remove the npm policy exception.

## Release conditions

Apart from the five registered groups above, Rust advisories, high-severity npm audit, production licenses, full-history secret scan, and SBOM generation must pass. A real leaked key, unsigned update, host-fingerprint bypass, or high-severity production advisory immediately changes the decision to **No-Go**.
