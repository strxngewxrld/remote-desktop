# Remote Desktop (RDP) für VS Code

Öffnet Windows-Remotedesktop-Sitzungen in einem Editor-Panel – ohne externen
Client, ohne native Module.

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
Server bekommt beim Öffnen einen gefüllten Farbpunkt im Tab.

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
(`rdp.clipboard.maxFileSizeMb`). Ordner und Dateien in Gegenrichtung sind noch
nicht unterstützt; Text bleibt in beide Richtungen verfügbar.

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
| `rdp.connections` (Einstellungen) | je nach Ebene | User-Settings sind lokal, Workspace-Settings liegen beim Arbeitsbereich |

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

## Bekannte Grenzen

Kein Audio. Kein
Multi-Monitor und kein RemoteApp/RAIL – es wird immer der ganze Desktop
übertragen. Die Auflösung wird beim Verbinden aus der Panelgröße bestimmt und
vom Client danach nicht mehr geändert; gibt der Server eine neue Größe vor,
folgt die Sitzung ihr. Bildbereiche, die ein Server in H.264 sendet, bleiben
leer – es gibt keinen H.264-Decoder. Server, die eine Terminalserver-Lizenz
(Per-Device-CAL) verlangen, werden nicht unterstützt.
