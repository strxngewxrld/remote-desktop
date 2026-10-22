# Übernahme aus Report Builder

Verglichen wurden die lokalen Repositories am 22.10.2026. Report Builder bleibt unverändert.

| Bereich | Report Builder | Remote Desktop nach Übernahme |
| --- | --- | --- |
| CI | Windows/Linux, Typprüfung, Unit- und VS-Code-Tests, VSIX-Artefakte | Windows/Linux/macOS für beide Workspace-Pakete, VS-Code-Tests auf Englisch und Deutsch; Live-RDP/AD bleibt separater Labortest |
| Packaging | Frischer Build, festes Artefaktverzeichnis, Allowlist und ZIP-Prüfung | `npm run package`, exakt geprüfte Laufzeitdateien, Bundle-Importprüfung |
| Dokumentation | Dokumentprüfung, Handbücher und Changelog im Paket | Englische/deutsche Übersicht, Changelog und Notices; deutsche Bedienung und Problemlösung offline |
| Einstieg | Native Walkthroughs und Hilfebefehle | Vier Schritte mit Aktionen, Offline-Hilfe, Updates und Lizenzhinweisen |
| Publishing | Publisher `Tom-Knueppel`, GitHub-Packages-Skript | Gleicher Publisher, gemeinsamer Paketpfad für GitHub Packages und Release-Workflow |
| Lizenzen | Notices für tatsächlich gebündelte Fremdpakete | Aus esbuild-Inputs generierte Notices mit vollständigen Lizenztexten; Paketcheck vergleicht den Inhalt |
| Updates | GitHub-Releaseprüfung, Installation, Öffnen, Überspringen | Gleicher Ablauf mit manueller Prüfung, abschaltbarer Startprüfung und Berücksichtigung entfernter Hosts |

## Bewusste Grenzen

Die bestehende deutsche Bedienoberfläche wird beibehalten. Eine vollständige
englische Lokalisierung wie in Report Builder ist noch nicht umgesetzt.
Die Erweiterungsbeschreibung verwendet `package.nls.json` und `package.nls.de.json`.
Übersicht, Änderungsprotokoll und Lizenzhinweise folgen der VS-Code-Sprache;
deutsche Sprachvarianten öffnen die deutsche Fassung. Rechtliche Lizenztexte
bleiben in beiden Dokumentfassungen im Original erhalten.
Marketplace-Installationen können den Updateweg von VS Code verwenden. Zusätzlich
steht die GitHub-Releaseprüfung für manuell installierte VSIX-Dateien bereit.

Die Tests gegen einen echten Windows-RDP-Server und AD-Kerberos benötigen das
vorhandene Labor und laufen nicht auf öffentlichen CI-Runnern. Siehe
[Windows-E2E](windows-e2e.md) und [AD/Kerberos](ad-kerberos.md).

Ein lokaler Paketcheck ersetzt keinen erfolgreichen GitHub-Actions-Lauf.
Der [Testleitfaden](TESTING.md) hält die lokal ausgeführten Prüfungen fest.
Veröffentlichung und benötigte Repository-Konfiguration sind in
[RELEASING.md](RELEASING.md) beschrieben.
