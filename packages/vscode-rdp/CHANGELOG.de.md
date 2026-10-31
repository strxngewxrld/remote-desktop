# Änderungsprotokoll

## [Unveröffentlicht]

- Fenstergröße: Die Desktopauflösung folgt dem Panel jetzt beim Start, bei Größenänderungen, beim Herausziehen des Tabs in ein eigenes Fenster und beim Wechsel auf einen Monitor mit anderer Pixeldichte; Größen, die vor dem Öffnen von Display Control eintreffen, werden nachgeholt. Neuer Befehl `RDP: Auflösung an Fenster anpassen` (`rdp.fitResolution`, auch als Knopf in der Titelleiste) übernimmt die Fenstergröße einmalig, auch bei ausgeschaltetem `rdp.dynamicResolution` oder fester Auflösung; ohne Display Control wird angeboten, neu zu verbinden.

- Verbindungsüberwachung: Nach 15 s Stille sendet die Sitzung ein 1×1-Refresh-Rect; bleibt die Antwort aus (oder nach einem Ruhezustand-Uhrensprung), erscheint „Keine Antwort vom Server“ mit Knopf zum Neuverbinden und einer Warnung in der Statusleiste. Getrennt wird nie von selbst. `ts-rdp` bietet dazu die Optionen `liveness` und die Ereignisse `unresponsive`/`responsive`.

- Abgelehnte Anmeldung: Ein gespeichertes Passwort wird nicht mehr gelöscht, wenn der Server es ablehnt. `0xc000006d` mit gespeichertem Passwort wird einmal nach 5 s wiederholt (ein startender Server kann Anmeldungen noch nicht prüfen); andere Codes nie. Danach fragt der nächste Verbindungsaufbau, ob das gespeicherte Passwort erneut verwendet oder ein neues eingegeben wird. Bekannte NTSTATUS-Codes werden auf Deutsch erklärt; `RdpAuthError` trägt `ntStatus`.

- Dateien in der Zwischenablage: Ordner (rekursiv, auch leere) und Zeitstempel in beide Richtungen; Dateien über 64 MB und über 4 GiB werden von/auf die Platte gestreamt statt im Speicher gehalten. Unter macOS lassen sich im Finder kopierte Ordner in die Sitzung einfügen. `rdp.clipboard.maxFileSizeMb` hat jetzt den Vorgabewert 4096 und erlaubt bis zu 102400.

- macOS: Dateien und Ordner im Remote-Explorer kopieren und im Finder mit Cmd+V einfügen; erhält verschachtelte und leere Ordner, mit Größenbegrenzung und Abbruch bei Änderungen.

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
