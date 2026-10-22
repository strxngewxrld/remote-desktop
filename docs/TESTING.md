# Tests und lokale Validierung

## Teststufen

| Befehl | Prüft | Voraussetzungen |
| --- | --- | --- |
| `npm run typecheck` | Beide TypeScript-Workspace-Pakete; baut vorher die von der Extension benötigten Library-Deklarationen | npm-Abhängigkeiten installiert; kein vorheriger Build nötig |
| `npm test` | Protokoll, Codecs, Mock-RDP-Server und Extension gegen VS-Code-Attrappe | OpenSSL im PATH, lokale Testports verfügbar |
| `npm run build` | Library und gebündelte Extension | Node.js und npm |
| `npm run test:vscode` | Aktivierung, Manifestbefehle, Webview-Renderer und Seitenleiste | Desktop-Sitzung oder xvfb, VS Code lokal oder Downloadzugriff |
| `npm run package` | Frischer Build, Dokumentlinks und geprüftes VSIX | Gesperrte vsce-Entwicklungsabhängigkeit installiert |
| `npm run check:package` | Zuletzt gebautes VSIX inklusive Aktivierung des archivierten Bundles | Artefakt und Build-Metadaten unter `out/` vorhanden |
| `npm run test:tooling` | Notice-Generierung inklusive vollständiger Lizenztexte und fehlender Lizenzen | Keine Netzwerkzugriffe |

Für lokale VS-Code-Tests kann `VSCODE_TEST_PATH` auf eine vorhandene
VS-Code-Installation zeigen. Ohne diese Variable lädt der Runner die stabile
Version. `VSCODE_TESTVERSION` wählt alternativ eine konkrete Downloadversion.

CI führt diese Stufen unter Windows, Linux und macOS mit Node.js 24 aus. Die
VS-Code-Tests unter Linux verwenden `xvfb-run`; unter Windows und macOS starten
sie direkt, jeweils auf Englisch und Deutsch. VSIX-Dateien werden je
Betriebssystem als Workflow-Artefakte bereitgestellt.

Unter macOS liegt das isolierte VS-Code-Benutzerprofil in einem kurzen,
temporären Verzeichnis unter `/tmp/rdp-vsc-*`. Der vollständige Checkout-Pfad
auf GitHub-Runnern überschreitet sonst die Längengrenze für Unix-Sockets und
VS Code bricht bereits vor dem ersten Test mit `listen EINVAL` ab.
Sprachpaketinstallation und Testfenster verwenden ausdrücklich dasselbe Profil.

## Lokal geprüft am 22.10.2026

Windows, Node.js 26.8.1, installierter VS-Code-Desktop und OpenSSL aus Git for Windows:

- Typprüfung beider Pakete erfolgreich.
- 745 Library-Tests und zuletzt 531 Extension-Tests erfolgreich, keine übersprungenen Tests.
- Zwei Tooling-Tests zur Notice-Generierung erfolgreich. Updatefälle prüfen u. a.
  Versionsvergleich, Quellen, Prüfsummen, übersprungene Versionen, Offlinebetrieb
  sowie ausdrücklich gewählte Installation und Bereinigung der temporären Datei.
- 12 Tests im echten VS-Code-Extension-Host mit deutscher Sprache erfolgreich, einschließlich lokalisierter Beschreibung, Installer-Befehl
  und mitgelieferter Walkthrough-Medien. Die Updateinstallation selbst wurde simuliert;
  es wurde kein öffentliches Release heruntergeladen oder installiert.
- VSIX wird einschließlich der archivierten Bundle-Aktivierung und aller
  Manifestbefehle geprüft, ohne npm-Laufzeitabhängigkeiten nachzuladen.
- Dokumentlinks, Workflow-YAML-Syntax und Übereinstimmung von Workspace-Manifests
  mit dem Lockfile geprüft.

Die lokalen Protokolle liegen unter `logs/release-*.log` und werden nicht
committet. Ein entfernter GitHub-Actions-Lauf sowie ein Upload zu Marketplace
oder GitHub wurden nicht durchgeführt.

Sprachwahl lokal prüfen: `VSCODE_TEST_LANGUAGE=de` für den VS-Code-Testlauf
setzen (unter PowerShell `$env:VSCODE_TEST_LANGUAGE = 'de'`). CI prüft beide
Sprachvarianten. Die Dokumentbefehle werden zusätzlich gegen `de`, `de-AT`,
`en` und einen englischen Sprachrückfall getestet; der Paketcheck prüft beide
Beschreibungstabellen und die generierten Lizenzhinweise in beiden Sprachen.

Vor dem deutschen Test installiert die Testkonfiguration das offizielle deutsche
Sprachpaket und registriert dessen Übersetzungsdateien im isolierten Testprofil.
So ist Deutsch bereits beim ersten Fensterstart verfügbar. Der deutsche Lauf
deaktiviert das Sprachpaket nicht mit `--disable-extensions`. Eine vom aufrufenden
VS-Code-Fenster geerbte Sprachkonfiguration wird im Testprozess zurückgesetzt.
Die Tests prüfen weiterhin ausdrücklich `vscode.env.language === 'de'`;
ein englischer Rückfall gilt als Fehler. Build und beide Sprachläufe wurden
zusätzlich in CI-Reihenfolge mit einem frischen Testprofil geprüft.

## Echte RDP-Server und AD

Die Mock- und VS-Code-Tests ersetzen keinen Live-Test gegen Windows bzw. AD.
Für diese Stufe die vorhandenen Anleitungen
[Windows-E2E](windows-e2e.md) und [AD/Kerberos](ad-kerberos.md) verwenden.
Diese Labortests wurden im Rahmen der CI-/Packaging-Übernahme nicht erneut ausgeführt.
