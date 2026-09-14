# Laufwerks-Handshake und Tab-Icons

## Neuer Dump

Der lokale Dump zeigt zwei Verbindungsaufbauten um 08:40:47 und 08:41:58.
In beiden wird `rdpdr` angemeldet und der Kanal als bereit protokolliert
(Zeilen 28 und 4022). Es folgen keine `RDPDR:`-Handshake-Meldungen,
keine Geräteankündigung und keine Bestätigung des Laufwerks. Der TLS-Fallback
gelingt jeweils; er erklärt das fehlende Laufwerk nicht.

## Reproduzierter Clientfehler

`nextMcsPayload()` gab während Lizenzierung und Aktivierung Nutzdaten jedes
MCS-Kanals zurück, ohne die Kanalnummer zu prüfen. Ein frühes RDPDR Server
Announce konnte dadurch als I/O-PDU behandelt und in der Aktivierungsphase
verworfen werden. Der Server wartet anschließend vergeblich auf eine Antwort.

Ein Integrationstest sendet Server Announce bereits beim Client Info PDU
über eine echte lokale TLS/MCS-Verbindung. Vor der Korrektur scheitert er mit
Timeout beim Warten auf die RDPDR-Antwort. Mit der Korrektur werden frühe
Kanaldaten nach `connect` zugestellt; der Test prüft Geräteankündigung und
erfolgreiche Gerätebestätigung. Der Puffer ist auf 16 MiB und 4096 Frames
begrenzt und wird beim TLS-Retry zurückgesetzt.

Das Fehlerbild passt zum Dump; dieser protokolliert die zuvor verworfenen
Nachrichten allerdings nicht und beweist daher deren Ankunftszeit nicht.
Das Mapping auf dem echten Windows-Server muss nach Aktualisierung und
Neuverbinden bestätigt werden. Neue Diagnosemeldungen zeigen früh gepufferte
Kanäle, ohne deren Inhalte auszugeben.

## Icons

Die Emoji-Titel wurden durch sieben mitgelieferte SVG-Icons ersetzt, die sich
in Farbe und Form unterscheiden. Damit entfallen dynamische Dateierzeugung
und Abhängigkeit vom globalStorage-Verzeichnis. Der Titel bleibt unverändert.
Die globale Einstellung `workbench.editor.showIcons` muss aktiviert sein;
VS Code reicht andernfalls `hideIcon` an die Tab-Anzeige weiter, auch wenn die
Extension ein Icon liefert. Die Einstellung wird nicht automatisch geändert.

Quelle: [VS Code Tab-Renderer](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts).

Automatisiert geprüft werden unveränderte Titel, Icon-Pfade ohne Dateischreiben,
alle sieben SVG-Assets und unterschiedliche Formen. Ein visueller Test im
installierten VS Code bleibt erforderlich.

Abschlussprüfung: Build und Typecheck erfolgreich; 715 Bibliotheks- und
468 Extension-Tests bestanden, keine Fehlschläge.

## Weiterhin fehlendes Mapping nach erneutem F5-Start

Der Nutzer bestätigt F5 als Startweg. `launch.json` ruft `npm: build` auf;
dieser baut zuerst `ts-rdp/dist` und danach das Extension-Bundle. Die geprüften
Windows-Registry-Werte zeigen keine Sperre an den beiden abgefragten Stellen
(Policy-Wert fehlt, RDP-Tcp `fDisableCdm=0`). Damit ist weder ein alter VSIX-Stand
noch eine Sperre an diesen Stellen die belegte Ursache.

Der Dump um 09:01 enthält weiterhin keine RDPDR-Handshake-Meldungen. Ergänzt
wurde deshalb Diagnose, kein weiterer spekulativer Protokoll-Fix:

- `Client-Build`: UTC-Zeitpunkt des Bundler-Aufrufs, Diagnosekennung `drive-v3`
  und Extension-Pfad. Bei Watch gilt der Zeitpunkt des Watch-Starts.
- Die Kanal-Bereitmeldung enthält die Zahl der geöffneten Workspace-Ordner.
- Nach acht Sekunden meldet `Laufwerk-Diagnose` empfangene Kanalbytes und
  erreichte Handshake-Schritte; die Meldung funktioniert auch bei sichtbarem
  Desktop, unabhängig vom Grafik-Watchdog.
- Timer werden bei Trennung, Neuaufbau und Dispose beendet. Die Diagnose
  protokolliert keine Passwörter, Dateiinhalte oder Dateinamen.

Für die nächste Eingrenzung: F5-Sitzung vollständig stoppen, erneut starten,
verbinden, mindestens zehn Sekunden warten und den neuen Dump prüfen. Noch
keine bestätigte Ursache für den verbleibenden Fehler am echten Server.

## Dump 12:40: fehlender RDPSND-Kompatibilitätskanal

Der neue Dump bestätigt `drive-v3`, den richtigen Extension-Pfad und einen
Workspace-Ordner. Nach acht Sekunden sind auf `rdpdr` **0 Byte** eingegangen;
alle Handshake-Schritte sind aus. Somit fehlt bereits Server Announce, nicht
erst die Zustimmung oder das Lesen der Repository-Dateien.

Für Windows ist eine Abhängigkeit der Geräteumleitung vom zusätzlichen
`rdpsnd`-Kanal dokumentiert: [FreeRDP Plugins](https://github.com/FreeRDP/FreeRDP/wiki/Plugins).
[Apache Guacamole](https://github.com/apache/guacamole-server/blob/main/src/protocols/rdp/rdp.c)
lädt deshalb bei Laufwerksumleitung beide Kanäle, auch ohne Audiowiedergabe.
Unsere Extension meldete bisher nur `rdpdr` an. Das ist eine zum beobachteten
Stillstand passende Kompatibilitätslücke; die Bestätigung am echten Server
steht noch aus.

Bei aktivierter Laufwerksumleitung wird jetzt zusätzlich `rdpsnd` angemeldet.
Ein minimaler Handler beantwortet Audioformat-/Versionsaushandlung mit einer
leeren Formatliste und deaktiviertem UDP, sowie gegebenenfalls Quality Mode
und Training. Es werden keine Audioformate akzeptiert oder Audiodaten an das
Webview weitergegeben. Bei deaktivierter Laufwerksumleitung bleiben beide
Kanäle abgemeldet. Referenz: [MS-RDPEA Client Audio Formats](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/d58d4d57-cb36-453a-866f-86beacc6d79b).

Neue Kennung: `drive-v4-rdpsnd`. Beim nächsten F5-Start muss die Kanalliste
auch `rdpsnd` enthalten. Erwarteter Fortschritt: `RDPDR: Server-Version`,
Freigabe-Rückfrage und Gerätebestätigung. Ein neuer Integrationstest modelliert
einen Server, der RDPDR erst nach RDPSND-Aushandlung startet; zusätzlich prüfen
Unit-Tests leere Formatlisten, Quality Mode, Training und fehlerhafte Längen.

Prüfergebnis: Build und Typecheck erfolgreich; 717 Bibliotheks- und 469
Extension-Tests bestanden, einschließlich des neuen RDPSND/RDPDR-Ablaufs.
