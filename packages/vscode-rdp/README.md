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

## Bekannte Grenzen

Keine Zwischenablage, kein Audio, keine Laufwerksweiterleitung. Kein
Multi-Monitor und kein RemoteApp/RAIL – es wird immer der ganze Desktop
übertragen. Die Auflösung wird beim Verbinden aus der Panelgröße bestimmt und
vom Client danach nicht mehr geändert; gibt der Server eine neue Größe vor,
folgt die Sitzung ihr. Bildbereiche, die ein Server in H.264 sendet, bleiben
leer – es gibt keinen H.264-Decoder. Server, die eine Terminalserver-Lizenz
(Per-Device-CAL) verlangen, werden nicht unterstützt.
