# Änderungsprotokoll

## [Unveröffentlicht]

- Kerberos auf macOS/Linux über die integrierte TypeScript-Implementierung; explizite AD-Realm-/KDC-Einstellungen und Replay-Schutz bei unverändertem Windows-SSPI und strikten Rückfallregeln.

## [1.0.0]

- Remote-Desktop-Sitzungen in VS Code mit TLS und NLA (NTLMv2 und Kerberos unter Windows), Verbindungsordnern und Zugangsdaten-Profilen.
- Textzwischenablage, Einfügen von Dateien vom Arbeitsplatz zum Server, Laufwerksumleitung für Arbeitsbereichsordner und dynamische Auflösung.
- Geführter Einstieg, deutsches Offline-Anwenderhandbuch und Hilfe bei Verbindungsproblemen.
- Deutsche Erweiterungsbeschreibung, Übersicht, Änderungsprotokoll und Lizenzhinweise; die Dokumentbefehle wählen die Fassung anhand der VS-Code-Sprache.
- Updates über GitHub Releases: abschaltbare Startprüfung, manuelle Prüfung, Installation nach ausdrücklicher Auswahl, Release-Links und Überspringen einzelner Versionen. Entfernte Hosts verwenden die Release-Seite.
- Automatisch erzeugte Lizenzhinweise mit vollständigen Lizenztexten der tatsächlich gebündelten Pakete, offline über Befehlspalette und Einstieg erreichbar.
- Publisher-ID: `Tom-Knueppel.vscode-rdp` (bisherige Entwicklungsinstallationen: `local.vscode-rdp`).
- Geprüftes VSIX-Packaging, CI für Windows und Linux sowie manuell gestarteter Release-Workflow.

Audio, RD Gateway, RemoteApp und die Ausstellung gerätebezogener RDS-Zugriffslizenzen (Per-Device CALs) werden nicht unterstützt.
