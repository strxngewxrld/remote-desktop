# Dateien und Ordner vom RDP-Server in den Finder kopieren

Die macOS-Extension übernimmt kopierte Dateien und Ordner aus der aktiven
RDP-Sitzung in die Datei-Zwischenablage des Mac.

1. In der RDP-Sitzung im Windows-Explorer Dateien oder Ordner markieren und
   **Kopieren** wählen beziehungsweise Strg+C drücken.
2. Warten, bis die VS-Code-Statusleiste **Dateien bereit – im Finder mit Cmd+V
   einfügen** meldet.
3. Im Finder den Zielordner öffnen und **Cmd+V** drücken.

Mehrere Dateien, Umlaute, verschachtelte Ordner, leere Ordner und leere Dateien
werden unterstützt. Die Originaldateien auf dem Server bleiben erhalten.

Die Zwischenablage muss aktiviert sein. Ihre Richtung muss **beide Richtungen**
oder **Remote → lokal** erlauben. `rdp.clipboard.maxFileSizeMb` begrenzt die
Gesamtgröße eines Kopiervorgangs; die Vorgabe beträgt 64 MiB, maximal 256 MiB.
Die Übertragung unterstützt bis zu 4.096 Einträge einschließlich Ordnern.

Während der Übertragung die Remote-Zwischenablage nicht ändern. Ein neuer
Kopiervorgang oder eine unterbrochene Verbindung bricht den laufenden Empfang
ab. Ändert sich die lokale Zwischenablage während des Empfangs, wird sie nicht
mit den inzwischen eingetroffenen Dateien überschrieben; erneut kopieren.
Fehler erscheinen als Meldung und im RDP-Ausgabeprotokoll.

Die Dateien werden vor dem Einfügen in einem privaten temporären Verzeichnis
auf dem Mac zwischengespeichert. Der Finder erhält lokale Dateiobjekte. Die
zuletzt empfangenen Dateien bleiben auch nach dem Schließen des RDP-Tabs
verfügbar. Bei einem späteren Datei-Kopiervorgang werden ältere
Zwischenspeicher nach 30 Minuten entfernt; nach einem Beenden von VS Code
können temporäre Dateien bis zur Betriebssystembereinigung zurückbleiben.

Diese Finder-Anbindung setzt einen lokalen macOS-Extension-Host voraus.
Bei Ausführung der Extension auf einem SSH-/Container-Host oder im Browser
wird keine Datei-Zwischenablage auf dem Mac eingerichtet.

Der vorhandene Branch `feat/clip-files` enthält ältere Vorarbeiten zur
Gegenrichtung Client → Server. Der Empfang samt Finder-Anbindung liegt auf
`feat/clipboard-downloads`, ausgehend vom aktuellen Kerberos-Stand auf `main`.

## Prüfung am 23.10.2026

Auf `feat/clipboard-downloads` bestanden 814 Protokolltests und 538
Extension-Tests (1.352 insgesamt), Typprüfung und die VSIX-Paketprüfung.

Der aktuelle Client wurde vom Mac über Kerberos mit dem Windows-AD-Testserver
verbunden. In der interaktiven Windows-Sitzung wurde eine echte Dateiablage mit
`FileDropList` angelegt. Der Server lieferte sechs Deskriptoren einschließlich
Ordnern sowie Dateiinhalt in 64-KiB-Blöcken. Die native macOS-Zwischenablage
enthielt anschließend drei Dateiobjekte.

Die empfangenen Testdaten wurden außerdem per Cmd+V in einem separaten
Finder-Fenster eingefügt. Geprüft wurden eine UTF-8-Datei mit Umlauten im Namen,
eine leere Datei und ein Ordner mit leerem Unterordner und einer binären Datei
von 200.000 Byte. Alle SHA-256-Prüfsummen stimmen mit dem Server überein.

Die Testsitzung wurde abgemeldet und der temporäre Testbenutzer deaktiviert.
Die vorhandene Administrator-Sitzung blieb bestehen. Die Prüfergebnisse und
Testprotokolle liegen lokal unter `.git/kerberos-lab/`:
`clipboard-live.log`, `finder-paste-result.json`, `clipboard-tests-final.log`,
`clipboard-extension-tests-final.log`, `clipboard-typecheck-final.log`,
`clipboard-package.log` und `clipboard-account-cleanup.log`.
