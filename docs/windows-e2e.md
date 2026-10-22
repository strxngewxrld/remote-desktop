# Windows-Prüfung vom 22.10.2026

Getestet auf Windows Server 2025 (Build 26100, x64), VS Code 1.143.0,
Node 26.8.1 und npm 11.19.0. Die interaktive Prüfung erfolgte über Windows MCP,
zuerst im Extension Development Host, anschließend mit dem installierten VSIX.
Alle Profile und Testserver lagen isoliert unter `.vscode-test`; das normale
VS-Code-Profil wurde nicht verändert.

## Ergebnis

| Prüfung | Ergebnis |
| --- | --- |
| Protokoll-, Codec- und TLS/NLA-Tests | 729 bestanden, keine übersprungen |
| Extension-Tests | 500 bestanden, keine übersprungen |
| Integration im echten Extension Host/Renderer | 10 bestanden |
| Build und Typprüfung | bestanden |
| VSIX erstellen, isoliert installieren und verbinden | bestanden |

Die Rendererprüfung bestätigt jedes von 20 aufeinanderfolgenden Vollbildern
einzeln. Zusätzlich werden 20 Vollbilder als Burst gesendet; anschließend müssen
eine neue Ping-Antwort und ein PNG-Screenshot mit der erwarteten Größe eintreffen.
Alte Antworten können nach der Korrektur nicht erneut einen späteren Testschritt
bestätigen.

## Gefundene und behobene Fehler

1. **Windows-Checkout ohne Symlinks:** `test/ts-rdp-quelle` wurde von Git als
   Textdatei ausgecheckt; drei Testdateien konnten den RDP-Testserver nicht
   importieren. `prepare-tests.mjs` kopiert nun die benötigten Quellen in einen
   ignorierten Testordner. Der versionierte Symlink entfällt.
2. **Nicht registrierte Manifest-Befehle:** `rdp.toggleDiagnostics` und
   `rdp.toggleClipboardPanel` fehlten vor der ersten Sitzung und nach dem
   Schließen der letzten Sitzung. Die Befehle werden nun bei der Aktivierung
   registriert und mit dem Extension-Kontext entsorgt.
3. **Windows-Kürzel hatten eine Doppelwirkung:** `Strg+Alt+V` öffnete das lokale
   Zwischenablage-Feld und schickte gleichzeitig `V` an den RDP-Server. Die
   auslösenden Tasten für `Strg+Alt+V` und `Strg+Alt+Ende` bleiben jetzt beim Host.
   Der Fehler und die Korrektur wurden anhand der empfangenen Scancodes bestätigt.
4. **Lasttest konnte alte Antworten wiederverwenden:** Der Testhelfer lieferte
   bei wiederholtem Warten auf `painted` dieselbe erste Nachricht. Antworten
   werden jetzt verbraucht; abgelaufene Wartevorgänge werden entfernt.

## Interaktiv geprüfte Abläufe

| Ablauf | Beobachtung |
| --- | --- |
| Verbindung anlegen, deutsches Layout und Anzeigename mit Umlaut | gespeichert und in der Seitenleiste sichtbar |
| Zertifikat ablehnen | verständlicher Abbruch mit erneutem Verbindungsversuch |
| Zertifikat vertrauen und merken | bei späterem Öffnen keine erneute Rückfrage |
| NLA mit Testbenutzer, Passwort merken | erfolgreiche Anmeldung; Wiederöffnung ohne Passwortdialog |
| Bildübertragung und laufende Kacheln | drei Farbflächen und wechselnde Markierung korrekt dargestellt |
| Erneut verbinden | neuer TLS/NLA-Aufbau und neue Bildübertragung |
| Linke/rechte Maustaste, Bewegung und Mausrad | passende Koordinaten und Ereignisse am Server |
| A, Strg+A, F2, F8, Tab und Pfeiltaste | passende Scancodes einschließlich Tastendruck und Loslassen |
| Strg+Alt+V | Feld öffnet; nach der Korrektur kein V am Server |
| Strg+Alt+Ende | Strg+Alt+Entf am Server; kein zusätzliches Ende |
| Zwischenablage lokal → remote | `Windows E2E lokal: äöü €` und zweite Zeile am Server |
| Zwischenablage remote → lokal | `Remote Windows E2E: äöü €` in der Windows-Zwischenablage |
| Zwischenablage-Feld, Strg+Enter | Feldinhalt am Server |
| Diagnose-Overlay | Werte und RTT aktualisieren sich |
| Fenster verkleinern | 800×600 wird auf 676×507 skaliert; Sitzung läuft weiter |
| Screenshot speichern | gültiges 800×600-PNG, auch bei Leerzeichen und Umlaut im Windows-Pfad |
| Zusätzlicher Monitor ohne EDISP-Unterstützung | verständliche Warnung; Sitzung bleibt nutzbar |
| Ordner mit Umlaut anlegen und Verbindung verschieben | persistente Baumstruktur korrekt |
| .rdp exportieren und wieder importieren | Host, Port und Benutzer erhalten; importierter Eintrag sichtbar |
| Baum filtern und Filter aufheben | passende Verbindung sichtbar; vollständiger Baum kehrt zurück |
| Trennen über die Statusleiste | Sitzung und Tab werden geschlossen |

Die generische MCP-Shortcut-Einspeisung lieferte teilweise Unicode-Ereignisse
ohne brauchbares `KeyboardEvent.code`. Die Tastaturprüfung wurde deshalb mit
Windows-MCP/PowerShell und `keybd_event` mit expliziten virtuellen Tasten und
Scancodes wiederholt. Die anfänglich fehlenden Funktionstasten waren damit
ein Problem der Testeinspeisung.

## Reproduktion

OpenSSL wird für die Testzertifikate benötigt. Hier wurde die mit Git für Windows
installierte Fassung verwendet:

```powershell
npm ci
$env:PATH = 'C:\Program Files\Git\mingw64\bin;' + $env:PATH
npm run build
npm test
npm run typecheck -w vscode-rdp
$env:VSCODE_TEST_PATH = 'C:\Program Files\Microsoft VS Code\Code.exe'
npm run test:vscode
node tools/windows-e2e-server.mjs
```

`VSCODE_TEST_PATH` ist optional; ohne Angabe lädt der bestehende Testlauf VS Code
herunter. Der lokale Server schreibt Host/Port nach
`.vscode-test/windows-ui/server.json` und erstellt ein eigenes Benutzerprofil
mit einer Testverbindung. Anmeldung: `tester` / `WindowsE2E!` (ausschließlich
lokale, fest vorgegebene Testdaten). F8 stellt einen bekannten Remote-Text bereit;
F9 beendet den Testserver. `OPENSSL_PATH` kann einen anderen OpenSSL-Pfad angeben.
Mit `WINDOWS_E2E_PORT` lässt sich für eine Wiederholung derselbe Port wählen.
Der Server überschreibt bei jedem Start die Einstellungen seines Testprofils.

Für den manuellen Host VS Code mit diesen Argumenten öffnen:

```text
--new-window
--disable-extensions
--user-data-dir=<Repository>/.vscode-test/windows-ui/user-data
--extensions-dir=<Repository>/.vscode-test/windows-ui/extensions
--extensionDevelopmentPath=<Repository>/packages/vscode-rdp
<Repository>/packages/vscode-rdp/test/integration/arbeitsordner
```

Für die Paketprüfung wurde `vsce package --no-dependencies` im Extension-Ordner
ausgeführt und das VSIX ausschließlich im genannten Testprofil installiert.
Anschließend wurde der Host ohne `--disable-extensions` und ohne
`--extensionDevelopmentPath` neu gestartet und erfolgreich verbunden.

Lokale Belege (ignorierte Artefakte): `logs/windows-final-tests.log`,
`logs/windows-vscode-tests.log`, `logs/windows-ui-server.log`,
`logs/windows-package.log`, `logs/Windows Prüfung mit Leerzeichen.png`,
`logs/Windows Export Prüfung.rdp` und
`packages/vscode-rdp/.vscode-test/windows-e2e.vsix`.

## Ursprünglich offene Abnahme gegen einen echten Server

**Nachtrag:** Die anschließende Einrichtung von AD und Prüfung gegen diesen
echten Windows-Server ist in [ad-kerberos.md](ad-kerberos.md) dokumentiert.
Sie bestätigt Kerberos und NTLM, EGFX-Bildübertragung, dynamische Auflösung,
mehrere Monitore sowie Text- und Dateizwischenablage. Der folgende Absatz
beschreibt den Stand vor diesem Folgetest.

Der interaktive RDP-Gegenpart war ein lokaler TLS/NLA-Protokolltestserver,
kein Windows-Desktop. Ein realer Zielserver und dessen Zugang wurden nicht
bereitgestellt. Daher bleibt die Abnahme gegen Windows-RDP offen, insbesondere
die Darstellung echter Anwendungen über EGFX/H.264, dynamische Auflösung und
mehrere Monitore mit EDISP, reale Dateiübertragung/Laufwerksumleitung sowie
längere Sitzungen und Netzwerkausfälle. Automatisierte Protokolltests decken
Teile davon ab; sie ersetzen diese Abnahme nicht. Eine Zusage vollständiger
Fehlerfreiheit wäre auf dieser Grundlage nicht belegt.
