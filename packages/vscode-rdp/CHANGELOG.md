# Changelog

## [Unreleased]

## [1.1.0]

- macOS: `Ctrl+Option+Shift+Delete` sends Ctrl+Alt+Del, as in Microsoft's Windows App; `Ctrl+Alt+End` keeps working.

- Transfers: file downloads read up to four 1-MiB ranges concurrently, preserving output order and bounded read-ahead. Channel fragments share TCP/TLS writes; fragmented incoming frames use reserved buffer capacity. Bitmap rendering and webview delivery avoid additional pixel copies. The 15 s transfer timeout counts from the last response, so queued parallel ranges no longer abort slow links. A rejected sign-in is logged without a stack trace.

- macOS keyboard: synthetic input modifier flags work without separate modifier key events. The extension host releases held keys on focus loss and monitor-window closure if the webview no longer delivers key-up events.

- Window size: the desktop resolution now follows the panel at start-up, on resize, when the tab is moved into its own window and when the window moves to a monitor with a different pixel density; sizes that arrive before Display Control is open are applied afterwards. New command `RDP: Fit Resolution to Window` (`rdp.fitResolution`, also a title-bar button) applies the window size once, even with `rdp.dynamicResolution` off or a fixed resolution; without Display Control it offers to reconnect.

- Connection watch: after 15 s of silence the session sends a 1x1 Refresh Rect; if nothing comes back (or after a sleep/wake clock jump) it shows "No response from server" with a reconnect button and a warning status bar. It never disconnects by itself. `ts-rdp` exposes this as `liveness` options and `unresponsive`/`responsive` events.

- Rejected sign-in: a saved password is no longer deleted when the server rejects it. `0xc000006d` with a saved password is retried once after 5 s (a starting server cannot verify logons yet); other codes are never retried. Afterwards the next connect asks whether to reuse the saved password or enter a new one. Known NTSTATUS codes are explained in German; `RdpAuthError` carries `ntStatus`.

- Clipboard files: folders (recursive, including empty ones) and timestamps in both directions; files above 64 MB and above 4 GiB stream from/to disk instead of memory. On macOS, folders copied in Finder can be pasted into the session. `rdp.clipboard.maxFileSizeMb` now defaults to 4096 and allows up to 102400.

- macOS: copy files and folders in the remote Explorer and paste them into Finder with Cmd+V; preserves nested and empty folders, with bounded transfers and cancellation.

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
