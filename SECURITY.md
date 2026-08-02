# Security Policy

BX SSH handles credentials, private keys, host identities, terminal input, and remote files. Security reports must be handled privately.

## Supported Versions

Before the first public release, security fixes are applied to `main`. After releases begin, the latest supported release line and `main` will receive fixes; the exact version table will be maintained here.

## Reporting a Vulnerability

Do not create a public GitHub issue, discussion, or pull request for a suspected vulnerability or leaked secret.

Use [GitHub Private Vulnerability Reporting](https://github.com/baoxue2026/bx-ssh/security/advisories/new). Include:

- affected version or commit;
- operating system and environment;
- reproduction steps or proof of concept;
- impact and realistic attack scenario;
- suggested mitigation, if known;
- whether the issue is already public.

Maintainers should acknowledge a complete report within 3 business days and provide an initial triage result within 7 business days. Timelines may change with severity and reproduction complexity.

## Reporting a Conduct Incident

Conduct incidents must also be reported privately. Use the same [private reporting form](https://github.com/baoxue2026/bx-ssh/security/advisories/new), prefix the title with `[Conduct]`, and include:

- the accounts or people involved;
- when and where the incident occurred;
- links, screenshots, or other relevant evidence;
- any immediate safety or privacy concern.

Conduct reports are handled as community moderation matters under [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), not as security advisories. Maintainers must limit access to the report and avoid disclosing the reporter's identity without permission, except when required by law or necessary to address an immediate safety risk.

## Coordinated Disclosure

Please allow maintainers time to reproduce, fix, test, and release the issue before public disclosure. Credit will be offered unless the reporter requests anonymity or the report is abusive, fabricated, or obtained through harmful activity.

## Secret Exposure

If a credential or signing key is committed:

1. Revoke or rotate it immediately.
2. Determine where it was used and review access logs.
3. Remove it from the current tree.
4. Coordinate history rewriting only after rotation.
5. Invalidate affected artifacts and publish an incident note when users may be impacted.

Deleting a secret in a later commit does not remove it from Git history.
