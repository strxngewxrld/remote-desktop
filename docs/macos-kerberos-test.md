# macOS Kerberos test against the AD lab

Date: 22 October 2026 (Europe/Berlin).

The current main working tree supports password-based Kerberos on macOS and
Linux, alongside the existing Windows SSPI provider. Full Kerberos desktop
sessions from the Mac to the real AD server succeeded after installing KB5129235 and restarting
the server. Both tunneled and direct RDP connections activated successfully
and delivered decoded desktop graphics. Before the repair, Kerberos and NTLM
both stalled after the licensing response.

## Implementation and local validation

The historical `feature/kerberos` implementation was selectively adapted to
main's current `SecurityContext` API; the historical branch was not merged.
The library accepts optional `kerberos.realm` and `kerberos.kdc` overrides.
The extension exposes `rdp.kerberosRealm` and `rdp.kerberosKdc`.

The integration preserves strict fallback behavior: invalid credentials,
transport failures, integrity failures and cancellation cannot trigger an
NTLM fallback. Automatic fallback is allowed only before sending an RDP
authentication token, for locally unavailable Kerberos or an unknown service
principal. Explicit Kerberos continues to require Kerberos.

The port also adds bounded KDC TCP framing, cancellation, ticket target and
expiry validation, bounded PBKDF2 work, mutual-authentication timestamp checks,
64-bit GSS sequence numbers and replay/direction/integrity checks.

Validation of the final source:

- 793 library tests and 531 extension tests passed, with no failures or skips.
- Workspace type checking passed.
- VSIX packaging, documentation checks and packaged activation validation passed.
- Artifact: `artifacts/vscode-rdp-1.0.0.vsix`.

Tests include fragmented/malformed KDC replies, cancellation, authentication
error classification, GSS integrity and replay rejection, and the current
CredSSP exchange against an independent mock acceptor. These unit tests are
separate from the live AD evidence below.

## Live environment and results

- Client: macOS, Node.js 24.22.0.
- Server: `152.89.239.193`, `win-udec6vtsf3u.rdp.test`.
- Existing domain: `rdp.test`, NetBIOS `RDPTEST`.
- AD DS, KDC, DNS and AD Web Services were already configured and running.
- Dedicated non-administrator test account: `rdp-mac-6b23b1@rdp.test`.
  It received Remote Desktop Users membership and its own RDP logon right.
- The original branch (`f6411c5`) was tested first in an isolated worktree;
  the current main implementation was then tested independently.

The current main client completed Kerberos CredSSP and joined the MCS
channels. An authentication-only probe deliberately stopped at that point,
before desktop activation, and verified `authenticationMechanism ===
'kerberos'`. A live negative test with automatic mechanism selection and an
incorrect password was rejected without an NTLM fallback.

Windows independently recorded successful events 4768 (TGT), 4769 (service
ticket, status `0x0`, encryption type `0x12`) and 4624 (network logon type 3,
authentication package `Kerberos`) for the dedicated account during the
initial live tests. The service principal was
`TERMSRV/win-udec6vtsf3u.rdp.test`.

Before the server repair, full-session tests with both implementations
reached license PDU `0xff`
but timed out before Demand Active. NTLM reproduced the failure, as did a
direct RDP connection without the RDP tunnel. No decoded desktop tiles or
successful interactive session were observed. Session queries also hung,
although Remote Desktop services reported Running; server logs contained
session-creation timeout events.

KDC traffic used an authenticated SSH tunnel. RDP was tested through that
tunnel and directly. Name resolution overrides applied only to the test
process; Mac DNS and hosts files were unchanged. TLS fingerprints were pinned
to the certificate obtained by the initial probe for each connection. This
checks connection consistency, not independent CA trust of that certificate.

## Server diagnosis and completed repair

Before the repair the server reported Windows Server 2025 build
**26100.33438**, corresponding to
[KB5122871](https://support.microsoft.com/en-us/servicing/os/windows-server/2026/09/kb5122871-windows-server-2025-security-update).
Microsoft documents RDS connection/sign-in failures and unresponsive tools
after this update, fixed by
[KB5129235, build 26100.33451](https://support.microsoft.com/en-us/servicing/os/windows-server/2026/09/kb5129235-windows-server-2025-update).
The installed build and observed symptoms matched this issue. Applying the
Microsoft fix and restarting restored full desktop sessions in both network
paths; no RDP handshake code changes were needed for that recovery.

`tools/Repair-RdpAdLab.ps1` provides separate Status, Prepare and Install
operations for the inspected build. Prepare only downloads and verifies;
Install uses DISM with `/NoRestart`. A restart requires a separate action.
The official catalog package was downloaded, staged on the server under
`C:\ProgramData\RdpKerberosLab\Updates\KB5129235`, and verified there:

- Size: 2,048,732,707 bytes.
- SHA1 from the Microsoft catalog: `3e0946284249f1976424b6fe01b3520d267a4dc9`.
- SHA256: `c42cb3a8c7641b07077be38023685ff5fd27b48416bf065d5883bd98c88cec6e`.
- Authenticode status: Valid; signer: Microsoft Corporation.

With explicit user approval, DISM installed the update successfully (exit
3010, restart required), followed by a server restart. The post-restart build
is **26100.33451**. AD DS, KDC, DNS and AD Web Services passed service/domain/DNS
checks. The formerly unresponsive session query now returns promptly.

The final macOS tests against the current main implementation passed:

- RDP through SSH: activated 1024×768 desktop, 924 decoded image tiles.
- Direct RDP to the server, with KDC traffic through SSH: activated desktop,
  543 decoded image tiles; reconnected to the same test session.
- Incorrect password with automatic mechanism selection: authentication
  rejected, no NTLM fallback.
- Windows Security events independently confirmed Kerberos network logon
  (4624, type 3), successful AES256 TGT/service tickets (4768/4769), and an
  interactive logon (4624, type 10). RDS events 21/22 confirmed session logon
  and shell start; event 25 confirmed reconnection.

SQL Express was started again and passed an integrated-authentication
`SELECT 1` probe. Business Central also reached Running; its startup logs
confirmed a connection to the application and tenant database. Both services retain
Automatic startup. These checks do not constitute a complete Business Central
application workflow test.

## Credentials and diagnostic evidence

The administrator password was read from macOS Keychain and held in memory
for SSH authentication. The generated test password is in Keychain under
service `remote-desktop-kerberos-macos-test`, account
`rdp-mac-6b23b1@rdp.test`. Neither password was written into repository files,
command-line arguments or logs. The temporary account was disabled after
testing; the server confirmed `Enabled: false`, and test session 2 was
logged off. Its password remains in Keychain for a follow-up test.

Evidence is in `.git/kerberos-lab/`, outside versioned source:
`final-tests.log`, `final-typecheck.log`, `main-package.log`,
`main-macos-real-auth-only.log`, `main-macos-real-negative.log`,
`main-macos-real-kerberos-direct.log`, `server-auth-events.json`,
`rds-diagnostics.json`, `rds-system.json`, `account-cleanup-final.log`,
`update-prepare-final.log`, `updates/verified-package.json`,
`update-install.log`, `update-restart.log`, `post-update-status.json`,
`post-update-kerberos-tunnel.log`, `post-update-auth-events.log`,
`post-update-sql.log`, `post-update-services.log` and
`post-update-account-cleanup.log`.
