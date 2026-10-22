# Changelog

## [Unreleased]

- Kerberos on macOS/Linux through the built-in TypeScript provider; explicit AD realm/KDC settings and replay protection, retaining Windows SSPI and strict fallback rules.

## [1.0.0]

- Remote Desktop sessions in VS Code with TLS, NLA (NTLMv2 and Windows Kerberos), connection folders and credential profiles.
- Clipboard text, local-to-remote file paste, workspace drive redirection and dynamic resolution.
- Guided getting started, offline German user manual and troubleshooting commands.
- German extension description, overview, changelog and notices, selected by VS Code locale when opened through the documentation commands.
- GitHub Release updates: optional startup check, manual check, explicit VSIX installation, release links and skipped versions; remote hosts use the release page.
- Generated notices include full license texts of packages actually bundled; notices are accessible offline from the command palette and walkthrough.
- Publisher identity: `Tom-Knueppel.vscode-rdp` (previous development builds: `local.vscode-rdp`).
- Verified VSIX packaging, Windows/Linux CI and a manually triggered release workflow.

Audio, RD Gateway, RemoteApp and Per-Device RDS CAL issuance are not supported.
