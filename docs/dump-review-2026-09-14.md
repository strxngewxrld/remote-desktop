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
