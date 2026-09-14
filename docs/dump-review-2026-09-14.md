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

## Dump 12:46: Laufwerk angekündigt, Zugriff auf `\\tsclient\V` scheitert

Windows bestätigt um 12:47:11 erstmals das Laufwerk. RDPSND hat damit den
fehlenden Geräte-Handshake behoben. Der Screenshot nennt jedoch `V` statt
des vollständigen Freigabenamens. Die bisherige UTF-16LE-Kodierung erzeugt
bereits nach dem ersten Zeichen ein Nullbyte. Für Windows-Kompatibilität
wird DeviceData jetzt wie bei [FreeRDP](https://github.com/FreeRDP/FreeRDP/blob/master/channels/drive/client/drive_main.c)
als nullterminierter UTF-8-Name übertragen. Leerzeichen und unzulässige
Pfadzeichen werden ersetzt; aus `VS Code` wird `VS_Code`.
MS-RDPEFS bezeichnet dieses Feld als Unicode; die bisher daraus abgeleitete
UTF-16LE-Annahme wird für dieses Feld korrigiert. Andere Unicode-Felder,
insbesondere Dateipfade und Client Name, bleiben UTF-16LE.

Zudem startet Windows den Geräte-Handshake während einer offenen Freigabefrage
erneut. Im Dump folgen zwei Geräteankündigungen. Eine Generation pro Handshake
verhindert jetzt, dass eine verspätete Freigabeantwort des alten Handshakes
erneut Geräte anmeldet oder den Zustand des neuen Ablaufs verändert.

Die Sitzung ist laut Dump ausdrücklich nur lesend freigegeben. Schreibzugriff
ist implementiert: Im verwendeten Extension-Development-Host
`rdp.driveRedirection.access` auf `readWrite` setzen, neu verbinden und die
zusätzliche Schreibfreigabe bestätigen. Die sichere globale Vorgabe bleibt
`readOnly`; ausgeschlossene Dateien bleiben auch mit Schreibrecht unsichtbar.

Diese Korrekturen benötigen noch den Windows-Livetest. Der vollständige
Netzwerk-Testlauf wurde vom Freigabesystem wegen eines Nutzungslimits abgelehnt;
Build, Typecheck und separate Unit-Tests ohne Netzwerk wurden ausgeführt.

## Dump 14:27: I/O erreicht den Client, Öffnen scheitert weiterhin

Der korrigierte Freigabename `VS_Code` erscheint im Screenshot und wird im
Dump bestätigt. Anders als im Null-Byte-Dump folgen jetzt zahlreiche
eingehende RDPDR-Nachrichten mit 56 bis 82 Byte sowie Antworten mit 20, 21,
42 und 56 Byte. Die Größen passen zu Create-, Close- und Metadatenoperationen;
ohne protokollierte Anfrageart/Status ist dies allein noch kein Beweis für
deren erfolgreichen Abschluss. Die aktuelle Sitzung läuft weiterhin nur lesend.

Für die verbleibende Fehlersuche ergänzt `drive-v5-io` die ersten 100
I/O-Anfragen/-Antworten um Operation, Geräte-ID, Handle, Completion-ID,
Informationsklasse und Antwortstatus. Weitere Fehlerantworten werden ebenfalls
protokolliert (ausgenommen reguläres Ende der Verzeichnisaufzählung).
Dateipfade und Nutzdaten werden in diesen Diagnosezeilen nicht ausgegeben.
Ein Test prüft erfolgreiche Create-Antworten und das Ausbleiben von Dateipfaden.

Kein weiterer Protokoll-Fix aus bloßen Paketgrößen abgeleitet. Für die konkrete
Ursache werden nach erneutem F5-Start und einem Öffnungsversuch die Zeilen
`RDPDR I/O Anfrage` und `RDPDR I/O Antwort` benötigt.

Die frühere Freigabesperre ist beim erneuten Versuch nicht mehr aufgetreten:
Die vollständige Testsuite wurde diesmal erfolgreich ausgeführt (720
Bibliotheks- und 469 Extension-Tests). Die ausstehenden Änderungen wurden
zusammen mit der I/O-Diagnose committed. Der Windows-Livezugriff bleibt offen.
