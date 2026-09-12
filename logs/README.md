# logs/ – Diagnosematerial

Hier liegen Mitschnitte, die beim Untersuchen der Graphics Pipeline
(MS-RDPEGFX) entstanden sind. Sie gehören **nicht** zum Build und werden von
keinem Test gelesen; sie sind Belegmaterial und werden deshalb von `.gitignore`
ausgeschlossen. Der Ordner selbst bleibt bestehen.

| Datei | Herkunft |
|---|---|
| `winlog.txt` | Ausgabe von `tools/Sammle-RdpDiagnose.ps1`, auf dem Server ausgeführt: RDS-Ereignisprotokolle, Richtlinien- und Registry-Werte rund um WDDM/RemoteFX, Grafikadapter. |
| `dump.txt` | Protokollausgabe der Extension selbst (Ausgabekanal „RDP“) aus einem Verbindungsversuch. |
| `com.microsoft.rdc.macos_*.log` | Log des offiziellen Microsoft-Remote-Desktop-Clients für macOS – die Vergleichsspur, an der sich ablesen lässt, was ein funktionierender Client tut. |

## Neues Material sammeln

Auf dem Windows-Server, in einer PowerShell **mit erhöhten Rechten**:

```powershell
.\tools\Sammle-RdpDiagnose.ps1 -Minuten 5 -Ausgabe .\logs\winlog.txt
```

Ohne `-Minuten` wartet das Skript auf den Verbindungsversuch und wertet danach
aus. Es liest nur, es ändert nichts.

Die Extension-Seite liefert `RDP: Protokoll anzeigen` (Einstellung
`rdp.logLevel` auf `debug` oder `trace`).
