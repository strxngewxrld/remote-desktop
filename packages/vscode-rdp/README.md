# Remote Desktop (RDP) for VS Code

Open Remote Desktop sessions in a VS Code editor, with a TypeScript RDP client
and no native runtime modules. The interface and offline help are currently German.

[Deutsche Übersicht](README.de.md) · [Anwenderhandbuch](docs/ANWENDERHANDBUCH.md) ·
[Troubleshooting (Deutsch)](docs/TROUBLESHOOTING.md) · [Changelog](CHANGELOG.md)

## Get started

1. Install the extension from a supplied VSIX using **Extensions: Install from VSIX…**.
2. Open the Remote Desktop sidebar, then **Verbindung hinzufügen** to save a server,
   or run **RDP: Verbinden mit…** for a one-off session.
3. Enter `host` or `host:port` and your username (optionally `DOMAIN\user`).
4. Verify the server certificate fingerprint before signing in. Passwords can be
   saved in VS Code SecretStorage.

Run **RDP: Erste Schritte** for the guided setup, **RDP: Anwenderhandbuch öffnen**
for offline help, or **RDP: Hilfe bei Verbindungsproblemen** for troubleshooting.

## Features

- TLS and NLA with NTLMv2; automatic Kerberos selection on Windows, macOS and Linux when available.
- Saved connections, nested folders, inherited settings, tags, colors and credential profiles.
- Dynamic resolution, additional monitors, screenshots and automatic reconnect.
- Clipboard text in both directions; files pasted from the local machine to the remote session.
- Workspace folders redirected as a drive, read-only by default and subject to approval.
- Import and export of `.rdp` files.

## Where connections originate

The RDP socket runs in the VS Code extension host. With Remote-SSH, WSL or containers,
that is the remote host, so it must be able to reach the server. Redirected workspace
folders also belong to that host. Run **RDP: Laufzeitumgebung anzeigen (lokal oder entfernt)**
to check the actual connection origin.

## Requirements and limits

A desktop VS Code client and a reachable RDP server with TLS/NLA are required.
Windows Kerberos additionally needs a Windows extension host, PowerShell 7, a server
FQDN and AD connectivity. macOS/Linux use the built-in TypeScript Kerberos
provider: use a UPN (`user@ad.example.com`) or set `rdp.kerberosRealm`. Optional
`rdp.kerberosKdc` entries (`host` and `port`) override AD DNS discovery.

Audio, RD Gateway, RemoteApp, AVC444 and Per-Device RDS CAL issuance are not supported.
Additional monitors are placed to the right. H.264 AVC420 depends on WebCodecs.
Folder paste and remote-to-local file clipboard transfer are not supported.

## Upgrading development builds

The extension ID is now `Tom-Knueppel.vscode-rdp`. Remove the old `local.vscode-rdp`
build first. User connection settings remain; passwords must be saved again and
drive permissions approved again because the extension identity changed.

## Updates

**RDP: Nach Updates suchen** checks for a newer stable GitHub Release. Choose
Install, Open Release or Skip This Version. Installation always requires an
explicit action; active sessions are never restarted automatically.
Startup checks are enabled by default and can be disabled using
`rdp.checkForUpdates: false`. Manual checks ignore a previously skipped version.

The check sends a request to the repository's public GitHub Releases API from
the extension host. It does not send saved connections or credentials.
Offline/API failures do not interrupt activation. Draft and prerelease versions
are ignored; a matching VSIX is checked against GitHub's SHA-256 digest when supplied.
Private repositories requiring authentication are not supported by this check.

In Remote-SSH, WSL and containers, use Open Release and install the downloaded
VSIX in the intended VS Code window. Marketplace updates remain available
through VS Code's extension management.

## Support and license

Use **RDP: Protokoll anzeigen** to inspect connection failures. Before sharing a log,
review it for private hostnames, usernames and other sensitive information.
Report problems using the repository issue tracker linked in the extension details.

MIT. See [third-party notices](THIRD_PARTY_NOTICES.md).
**RDP: Lizenzhinweise öffnen** opens the generated notices and included license texts offline.
**RDP: Übersicht öffnen** and **RDP: Änderungsprotokoll öffnen** open the overview and
changelog. These three documentation commands use German versions for German VS Code
locales (including regional variants) and English versions otherwise. Original license
texts remain unchanged.
