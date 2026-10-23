# Remote Desktop (RDP) für VS Code

Öffnet Windows-Remotedesktop-Sitzungen in einem Editor-Panel – ohne externen
Client, ohne native Module.

## Updates und Lizenzhinweise

**RDP: Nach Updates suchen** prüft veröffentlichte stabile GitHub-Releases.
Die automatische Prüfung beim Aktivieren ist mit `rdp.checkForUpdates: false`
abschaltbar. Die manuelle Prüfung bleibt verfügbar und ignoriert zuvor
übersprungene Versionen. Die Anfrage kommt vom Extension-Host und überträgt keine
gespeicherten Verbindungen oder Zugangsdaten. Private Releases mit Anmeldung
werden nicht unterstützt; automatische Netzwerkfehler bleiben ohne Meldung.

Bei einer neuen Version stehen **Installieren**, **Release öffnen** und
**Diese Version überspringen** zur Wahl. Installiert wird nur nach ausdrücklicher
Auswahl. Die passende VSIX wird geladen und ihre SHA-256-Prüfsumme geprüft,
sofern GitHub sie bereitstellt. VS Code steuert einen eventuell nötigen Neustart;
laufende RDP-Sitzungen werden nicht automatisch neu gestartet.

In Remote-SSH-, WSL- und Container-Fenstern gibt es nur **Release öffnen**:
Die VSIX herunterladen und über **Extensions: Install from VSIX…** im richtigen
Fenster installieren. Marketplace-Installationen können auch die normale
Updateverwaltung von VS Code verwenden. Ein GitHub-Releaseentwurf muss erst
veröffentlicht werden, bevor die Updateprüfung ihn sehen kann.

**RDP: Lizenzhinweise öffnen** zeigt die offline mitgelieferten Notices.
Diese werden beim Build aus den tatsächlichen Bundle-Inputs mit vollständigen
Lizenztexten erzeugt; Build- und Testabhängigkeiten werden nicht mitgeliefert.

## Verwenden

1. In der Seitenleiste auf das Remote-Desktop-Symbol klicken und eine Verbindung
   anlegen, oder in der Befehlspalette `RDP: Verbinden mit…` aufrufen.
2. Server als `host` oder `host:port` angeben, dann Benutzername – wahlweise als
   `DOMAIN\benutzer`.
3. Beim ersten Verbinden wird der Fingerabdruck des Serverzertifikats angezeigt.
   Nach Bestätigung wird er gespeichert; ändert er sich später, kommt eine Warnung.
4. Das Passwort kann auf Wunsch im sicheren Speicher von VS Code abgelegt werden –
   nicht in `settings.json`.

## Befehle

Die Befehle verwenden die Kategorie `RDP`. VS Code zeigt diese in der
Befehlspalette an; Kontextmenüs enthalten nur den jeweiligen Befehlsnamen.

Verbindungen und Ordner lassen sich im Baum per Drag-and-drop in einen Ordner
oder auf die freie Fläche der obersten Ebene verschieben. Ein farbig markierter
Server bekommt beim Öffnen ein eigenes SVG-Icon im Tab: Rot/Kreis,
Orange/Raute, Gelb/Dreieck, Grün/Quadrat, Blau/Sechseck, Violett/Stern,
Grau/Ring. Der Titel bleibt ohne Emojis. Die Icons werden mit der Extension
ausgeliefert und brauchen keinen Schreibzugriff auf den Extension-Speicher.
VS Code muss Editor-Icons anzeigen (`workbench.editor.showIcons: true`);
die Extension verändert diese globale Einstellung nicht.

**Verbinden als …** ist als Personen-Button direkt am Servereintrag und im
Kontextmenü verfügbar. Es bietet die effektiven, vererbten Profile und
**Andere Zugangsdaten …** für eine manuelle Anmeldung an. Die Auswahl gilt nur
für diese Sitzung; der gespeicherte Standard bleibt unverändert.

Über **Zugangsdaten verwalten…** im Ansichtsmenü werden Profile auf oberster
Ebene gepflegt; derselbe Befehl im Kontextmenü verwaltet Profile am Ordner oder
Server. Profile werden zusätzlich zu den übergeordneten Profilen vererbt.
**Standard auswählen** legt den bevorzugten Login fest. Bei mehreren Profilen
ohne Standard erscheint beim Verbinden eine Auswahl. **Immer nach Zugangsdaten
fragen** unterbricht die Vererbung und fragt jedes Mal Benutzername und Passwort
ab. Server ohne Profil und ohne bisherigen Benutzernamen fragen ebenfalls jedes
Mal. Passwörter liegen ausschließlich im SecretStorage.

Dateien vom Arbeitsplatz lassen sich im Sitzungsfenster mit Cmd+V/Strg+V in den
geöffneten Remote-Zielordner einfügen. Die Übertragung nutzt Dateiobjekte des
nativen Paste-Ereignisses und funktioniert damit auch unabhängig vom Dateisystem
des Extension-Hosts. Das Standardlimit ist insgesamt 64 MiB
(`rdp.clipboard.maxFileSizeMb`). Auf einem lokalen macOS-Extension-Host lassen
sich auch Dateien und Ordner vom Server übernehmen: im Remote-Explorer
kopieren, die Statusmeldung „Dateien bereit“ abwarten und im Finder mit Cmd+V
einfügen. Verschachtelte und leere Ordner bleiben erhalten. Ordner vom Client
zum Server werden weiterhin nicht unterstützt. Text bleibt in beide
Richtungen verfügbar.

## Repository unter Windows öffnen

1. Das Repository als Ordner im **gleichen VS-Code-Fenster** öffnen, aus dem
   die RDP-Sitzung gestartet wird. Bei Remote-SSH/Containern sind dies die
   Ordner des entfernten Extension-Hosts, nicht automatisch die des Macs.
2. `rdp.driveRedirection.enabled` auf `true` setzen (Vorgabe) und die Sitzung
   neu verbinden. `rdp.driveRedirection.access` bleibt zunächst `readOnly`.
3. Die Freigabe-Rückfrage mit **Freigeben** oder **Nur dieses Mal** bestätigen.
   Wurde früher abgelehnt: **RDP: Laufwerksfreigaben vergessen** ausführen
   und anschließend neu verbinden.
4. Im Windows-Explorer **Dieser PC** bzw. `\\tsclient\` öffnen. Das Laufwerk
   heißt standardmäßig **VS_Code** (`\\tsclient\VS_Code`); darunter liegt ein Unterordner pro
   Workspace-Ordner. Ein eigener Laufwerksbuchstabe wird nicht automatisch
   eingerichtet. Dies ist RDP-Umleitung, keine SMB-Freigabe.

Für Änderungen am Repository `rdp.driveRedirection.access` bewusst auf
`readWrite` setzen, neu verbinden und Schreibrecht bestätigen. Ausgeschlossene
Dateien (u. a. `.git`, `.env`, Schlüssel) und Symlinks bleiben unsichtbar;
die Freigabe ist damit kein vollständiger Git-Checkout für Windows.

Beispiel für die VS-Code-Einstellungen (JSON):

```json
"rdp.driveRedirection.enabled": true,
"rdp.driveRedirection.access": "readWrite"
```

Die Vorgabe bleibt aus Sicherheitsgründen `readOnly`. `readWrite` unterstützt
Anlegen, Ändern, Umbenennen und Löschen; es ist keine reine Leseumleitung.
Der Windows-Freigabename ersetzt Leerzeichen und Pfadsonderzeichen durch `_`.

Fehlt das Laufwerk weiterhin, unter **RDP: Protokoll anzeigen** die Zeilen
`Laufwerk:` und `RDPDR:` prüfen. Ein bereiter `rdpdr`-Kanal allein belegt noch
keine erfolgreiche Geräteankündigung; erwartet werden `RDPDR: Server-Version`,
die Geräteankündigung und `ist im Explorer verfuegbar`. Mit `rdp.logLevel` auf
`debug` steht zusätzlich jede einzelne Dateianfrage des Servers im Protokoll
(ohne Dateipfade). Auch eine serverseitige Richtlinie kann die Umleitung
verhindern; siehe [Microsofts Dokumentation zur Laufwerksumleitung](https://learn.microsoft.com/en-us/azure/virtual-desktop/redirection-configure-drives-storage).

Für Windows-Kompatibilität wird zusammen mit der Laufwerksumleitung zusätzlich
`rdpsnd` angemeldet. Manche Windows-Server starten den Geräte-Handshake sonst
nicht. Dieser Hilfskanal akzeptiert **keine Audioformate** und implementiert
keine Audiowiedergabe; die leere Formatauswahl dient nur der Aushandlung.

## Weitere Monitore

Der Knopf **Weiteren Monitor hinzufügen** in der Titelleiste der Sitzung
(neben dem Screenshot) öffnet ein zweites Panel und verschiebt es in ein
eigenes VS-Code-Fenster. Der Server richtet dafür einen weiteren Monitor
rechts neben dem bisher letzten ein; das Fenster zeigt genau diesen Teil des
Desktops, Maus und Tastatur funktionieren dort wie im Hauptfenster. Die Größe
folgt dem Fenster. Wer das Fenster schließt, entfernt den Monitor wieder; mit
der Sitzung schließen sich alle ihre Monitore.

Voraussetzung ist der Display Control Channel (MS-RDPEDISP, Einstellung
`rdp.dynamicResolution`) und ein Server, der mehrere Monitore erlaubt. Fehlt
beides, gibt es eine Meldung statt eines leeren Fensters. Screenshots zeigen
nur den primären Monitor. Mit H.264 dekodiert jedes Fenster den ganzen
Videostrom, die Rechenlast steigt also je Monitor.

## Befehlsübersicht

| Befehl | Wirkung |
|---|---|
| `RDP: Verbinden mit…` | Einmalige Verbindung ohne zu speichern |
| `RDP: Verbindung hinzufügen` | Verbindung dauerhaft anlegen |
| `RDP: Sitzung trennen` | Laufende Sitzung beenden |
| `RDP: Strg+Alt+Entf senden` | Tastenkombination, die der Browser nicht durchlässt (`Strg+Alt+Ende`) |
| `RDP: Bildschirm neu anfordern` | Vollbild vom Server neu übertragen lassen |
| `RDP: Skalierung umschalten` | Zwischen Einpassen und Originalgröße wechseln |
| `RDP: Gespeichertes Passwort löschen` | Zugangsdaten aus dem sicheren Speicher entfernen |
| `RDP: Protokoll anzeigen` | Ausgabekanal mit dem Verbindungsverlauf |
| `RDP: Weiteren Monitor hinzufügen` | Zusätzliches Fenster als weiterer Monitor der Sitzung |
| `RDP: Laufwerksfreigaben vergessen` | Gemerkte Antworten auf die Freigabefrage löschen; beim nächsten Verbinden wird wieder gefragt |
| `RDP: Laufzeitumgebung anzeigen (lokal oder entfernt)` | Wo die Extension läuft und von welchem Rechner die RDP-Verbindung ausgeht – siehe [Remote-SSH](#remote-ssh-der-ssh-rechner-als-sprungbrett) |

Über das Kontextmenü der Verbindungsliste kommen `Gespeicherte Verbindung öffnen`,
`Verbindung bearbeiten`, `Verbindung löschen` und `Liste aktualisieren` dazu; sie
sind in der Befehlspalette absichtlich ausgeblendet.

## Einstellungen

Alle Schalter liegen unter `rdp.*`:

| Einstellung | Standard | Wirkung |
|---|---|---|
| `rdp.connections` | `[]` | Gespeicherte Verbindungen (ohne Passwörter) |
| `rdp.defaultKeyboardLayout` | `de-DE` | Layout, das dem Server gemeldet wird |
| `rdp.defaultColorDepth` | `32` | Angeforderte Farbtiefe: 15, 16, 24 oder 32 |
| `rdp.graphicsPipeline` | `true` | Graphics Pipeline (MS-RDPEGFX) anfordern – für Windows Server 2019+ nötig |
| `rdp.scaling` | `fit` | Bild einpassen oder Originalgröße mit Bildlaufleisten |
| `rdp.smoothScaling` | `false` | Beim Skalieren glätten; aus wirkt bei Text meist schärfer |
| `rdp.certificateTrust` | `trust-on-first-use` | Alternativ `always-ask` oder `ignore` |
| `rdp.highDpi` | `false` | Volle Pixeldichte auf hochauflösenden Bildschirmen |
| `rdp.connectTimeout` | `15000` | Zeitlimit für den Verbindungsaufbau in Millisekunden |
| `rdp.logLevel` | `info` | `error`, `warn`, `info`, `debug` oder `trace` |
| `rdp.performance.*` | – | Hintergrundbild (aus), Themes (an), Menüanimationen (aus), Fensterinhalt beim Ziehen (aus), Schriftglättung (an) |
| `rdp.dynamicResolution` | `true` | Auflösung folgt der Panelgröße auch während der Sitzung |
| `rdp.clipboard.enabled` / `.direction` | `true` / beide | Zwischenablage an und in welche Richtung |
| `rdp.driveRedirection.enabled` | `true` | Ordner des Arbeitsbereichs als Laufwerk freigeben |
| `rdp.driveRedirection.access` | `readOnly` | `readWrite` erlaubt dem Server Anlegen, Ändern, Umbenennen und Löschen |
| `rdp.driveRedirection.exclude` | `.git`, `.env`, Schlüssel … | Pfade, die der Server nicht sieht |

Die Farbtiefe ist nur ein Wunsch: der Server gibt sie im Demand Active PDU vor,
und diese Vorgabe wird übernommen.

## Tastatur

Tasten werden als physische Scancodes übertragen, die Zuordnung zu Zeichen macht
der Server anhand des gemeldeten Layouts. `F1` und `Strg+Umschalt+P` bleiben für
VS Code reserviert; alle übrigen Tasten gehen an die Sitzung, solange das
Panel den Fokus hat.

## Remote-SSH: der SSH-Rechner als Sprungbrett

Ist VS Code per **Remote-SSH** (oder WSL, Dev Container, Tunnel) mit einer
anderen Maschine verbunden, läuft diese Extension **auf dieser Maschine** und
nicht auf dem Arbeitsplatz. Die RDP-Verbindung entsteht also dort. Genau das
ist der Nutzen: Windows-Server, die vom Arbeitsplatz aus gar nicht erreichbar
sind, weil sie hinter dem SSH-Rechner im Netz liegen, werden so erreichbar –
der SSH-Rechner wird zum Sprungbrett. Ein SSH-Tunnel von Hand ist dafür nicht
nötig.

Dafür trägt das Manifest `"extensionKind": ["workspace"]`. VS Code leitet
dieselbe Einstufung zwar schon aus dem vorhandenen `main` ab, aber eine
Ableitung ist keine Zusage. `ui` steht bewusst **nicht** in der Rangfolge: eine
Rangfolge wie `["workspace", "ui"]` würde die Extension am Arbeitsplatz laden,
sobald sie auf dem entfernten Rechner nicht installiert ist – die Verbindung
käme dann vom falschen Rechner und der Server wäre unerreichbar, ohne dass
irgendetwas nach einem Fehler aussähe.

Der Preis dieser Wahl: die Extension muss **auf dem entfernten Rechner
installiert** sein. VS Code bietet das in der Erweiterungsansicht als
„Install in SSH: *host*" an. Und im browserbasierten Editor ohne entfernten
Extension-Host kann sie nicht laufen – dort gäbe es ohnehin kein `node:net`
für den RDP-Socket.

### Was wo liegt

| Sache | Rechner | Anmerkung |
| --- | --- | --- |
| RDP-Verbindung (TCP, TLS, NLA) | **entfernt** | der eigentliche Zweck |
| Sitzungsfenster (Webview) | **lokal** | Webviews laufen immer beim Nutzer |
| Zwischenablage (`env.clipboard`) | **lokal** | die VS-Code-Zwischenablage ist immer die lokale |
| Gespeicherte Passwörter (`SecretStorage`) | **lokal** | „The API will always store the secrets on the client side" |
| Gemerkte Zertifikatsfingerabdrücke | **lokal** | liegen im `globalState` des Arbeitsplatzes |
| `.rdp`-Import und -Export | **entfernt** | die Dateidialoge zeigen das entfernte Dateisystem |
| `rdp.connections` (Einstellungen) | **lokal** | nur aus den Benutzereinstellungen, siehe [Sicherheit](#sicherheit) |

Dass Passwörter am Arbeitsplatz bleiben, ist die angenehme Nachricht: sie
wandern nicht auf den SSH-Rechner. Sie sind damit aber auch an den Arbeitsplatz
gebunden – von einem anderen Rechner aus fragt die Extension erneut.

Die Titel der Dateidialoge nennen den Rechner mit („Als .rdp-Datei speichern
(Dateisystem von ssh-remote)"), damit eine exportierte Datei nicht unbemerkt
auf der falschen Platte landet.

### Bild und Leistung

Der Webview wird lokal gezeichnet, die Extension läuft entfernt. Jede
Bildkachel nimmt damit den Weg RDP-Server → SSH-Rechner → SSH-Verbindung →
Arbeitsplatz. Die SSH-Strecke ist eine zusätzliche Etappe und meist die
langsamste; auf einer trägen Leitung macht sich das bemerkbar. Gegenmittel sind
dieselben wie sonst: ein sparsameres Bandbreitenprofil
(`rdp.defaultBandwidthProfile`), `rdp.highDpi` aus, und eine kleinere
Auflösung. Gegen `localhost` im Webview greift die Sitzung nicht – es wird
ausschließlich die Nachrichtenbrücke (`postMessage`) benutzt, die in beiden
Aufstellungen gleich funktioniert.

### Plattform: Extension-Host ≠ Arbeitsplatz

Unter Remote-SSH ist der Extension-Host womöglich Linux, während der Nutzer an
einem Mac sitzt. `process.platform` beantwortet deshalb **nicht** die Frage, auf
welcher Tastatur getippt wird – und auch `vscode.env.uiKind` nicht, das
unterscheidet nur Desktop von Browser. Verlässlich ist allein der Webview: er
läuft immer beim Nutzer und kennt dessen Plattform über `navigator`. Die
Extension hält das in `tastaturPlattform()` fest; fehlt die Meldung aus dem
Webview, gilt der Extension-Host nur als Notbehelf und wird als unzuverlässig
gekennzeichnet, statt eine falsche Antwort als sicher auszugeben.

### Wenn etwas nicht klappt

**RDP: Laufzeitumgebung anzeigen (lokal oder entfernt)** sagt in einem Satz,
wo die Extension läuft, auf welcher Plattform, und von welchem Rechner die
RDP-Verbindung ausgeht. Dieselben Zeilen stehen im Protokoll
(`RDP: Protokoll anzeigen`) – einmal beim Aktivieren und einmal bei jedem
Sitzungsstart:

```
Extension-Host: entfernt über ssh-remote, Plattform linux, geladen als workspace-Extension.
RDP-Verbindungen gehen aus von: entfernter Rechner (ssh-remote).
Bedienoberfläche: VS Code auf dem Desktop. Webview, Zwischenablage und gespeicherte Passwörter liegen immer dort, nicht im Extension-Host.
Dateidialoge (.rdp-Import und -Export) zeigen das Dateisystem des entfernten Rechners.
Verbinde mit srv01:3389 — Verbindungsaufbau von entfernter Rechner (ssh-remote), Plattform linux.
```

Hängt das Fenster an einem entfernten Rechner, wurde die Extension aber
trotzdem lokal geladen, meldet sich die Extension mit einer Warnung und nennt
die übliche Ursache: einen Eintrag unter `remote.extensionKind` in den
Einstellungen. Ohne diese Warnung sähe der Fall aus wie ein nicht erreichbarer
Server. `Developer: Show Running Extensions` zeigt den Ort unabhängig davon an.

## Sicherheit

- **Nur Benutzereinstellungen.** Verbindungen, Zugangsdaten-Profile,
  `rdp.certificateTrust` sowie die Schalter für Zwischenablage und
  Laufwerksumleitung gelten nur aus den Benutzereinstellungen. Ein geöffnetes
  Repository kann sie über seine `.vscode/settings.json` nicht ändern, also
  weder Zertifikatsprüfung abschalten noch `.env` freigeben noch eine
  Verbindung mit gespeichertem Passwort auf einen anderen Server lenken.
- **Zertifikate** werden vor der Anmeldung geprüft; ein geänderter
  Fingerabdruck führt zu einer Warnung, nicht zu einer stillen Verbindung.
- **Laufwerk:** nur lesbar, bis `readWrite` bewusst gesetzt und je Server
  bestätigt ist. Ausgeschlossenes existiert für den Server nicht. Symlinks
  werden nicht freigegeben. Namen, die Windows auf einen anderen Namen
  abbildet – ein Doppelpunkt (Datenströme), ein Punkt oder Leerzeichen am Ende
  und auf einem Windows-Host 8.3-Kurznamen wie `NODE_M~1` –, werden
  abgewiesen. Ein Verzeichnis oberhalb eines Ausschlussmusters mit Pfad (etwa
  `doku/geheim`) lässt sich nicht umbenennen, sonst würde der ausgeschlossene
  Eintrag unter neuem Pfad sichtbar. Gelöschtes geht in den Papierkorb.

## Kerberos auf Windows, macOS und Linux

Standard ist `"rdp.nlaMechanism": "auto"`: Die Extension bevorzugt Kerberos
und verwendet NTLMv2, wenn Kerberos vor dem ersten Tokenaustausch nicht verfügbar
ist, etwa bei IP-Zielen, lokalen Serverkonten, fehlendem PowerShell 7 oder
einem eindeutig als unbekannt gemeldeten Kerberos-Ziel. Falsche Passwörter, abgelaufene Zugangsdaten,
unbekannte Fehler sowie Fehler während des Tokenaustauschs brechen ab.
Das verwendete Verfahren steht im RDP-Ausgabeprotokoll.

Mit `"rdp.nlaMechanism": "kerberos"` wird ausschließlich Kerberos verwendet,
ohne NTLM-Rückfall; `"ntlm"` erzwingt NTLMv2. Windows verwendet SSPI und benötigt
PowerShell 7 unter `Program Files/PowerShell/7`. macOS und Linux verwenden die
integrierte TypeScript-Implementierung ohne PowerShell oder native Node-Module.
Als Server den vollständigen DNS-Namen (FQDN) verwenden; IP-Adressen werden
abgelehnt. AD-DNS und der KDC müssen vom Extension-Host aus erreichbar sein.

Auf macOS/Linux den Benutzer als `benutzer@ad.example.de` angeben oder
`rdp.kerberosRealm` auf die AD-DNS-Domäne setzen. Ein NetBIOS-Domänenname wie
`FIRMA` allein reicht nicht. Optional kann `rdp.kerberosKdc` eine Liste aus
`{"host":"dc.ad.example.de","port":88}` vorgeben; ohne Vorgabe werden die KDCs
über AD-DNS ermittelt. Die KDC-Vorgabe eignet sich auch für einen lokalen
SSH-Tunnel. Benutzer und Passwort werden wie bisher eingegeben und auf Wunsch
im SecretStorage gespeichert.

Der Windows-Hilfsprozess erhält Zugangsdaten nur über stdin. Auf macOS/Linux
bleiben sie für die Anmeldung im Node-Prozess. Die Extension prüft Zertifikat,
gegenseitige Kerberos-Authentifizierung und CredSSP-Kanalbindung vor der Delegation.

## Bekannte Grenzen

Kein Audio. Weitere Monitore nur rechts nebeneinander. Kein RemoteApp/RAIL –
es wird immer der ganze Desktop übertragen. H.264 nur als AVC420 und nur mit WebCodecs
im Webview, kein AVC444. Windows-Kerberos benötigt PowerShell 7; macOS/Linux
benötigen einen AD-DNS-Realm und einen erreichbaren KDC. Kein RD Gateway. Server,
die eine Terminalserver-Lizenz (Per-Device-CAL) verlangen, werden nicht
unterstützt.
