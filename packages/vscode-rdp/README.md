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
| `RDP: Strg+Alt+Entf senden` | Tastenkombination, die der Browser nicht durchlässt (`Strg+Alt+Ende`) |
| `RDP: Bildschirm neu anfordern` | Vollbild vom Server neu übertragen lassen |
| `RDP: Skalierung umschalten` | Zwischen Einpassen und Originalgröße wechseln |
| `RDP: Gespeichertes Passwort löschen` | Zugangsdaten aus dem sicheren Speicher entfernen |
| `RDP: Protokoll anzeigen` | Ausgabekanal mit dem Verbindungsverlauf |

## Einstellungen

Wichtige Schalter unter `rdp.*`:

- `rdp.scaling` – Bild einpassen oder Originalgröße mit Bildlaufleisten
- `rdp.defaultKeyboardLayout` – Layout, das dem Server gemeldet wird (Standard `de-DE`)
- `rdp.defaultColorDepth` – 15, 16 oder 24 Bit
- `rdp.certificateTrust` – `trust-on-first-use`, `always-ask` oder `ignore`
- `rdp.highDpi` – volle Pixeldichte auf hochauflösenden Bildschirmen
- `rdp.performance.*` – Hintergrundbild, Themes, Animationen, Schriftglättung

## Tastatur

Tasten werden als physische Scancodes übertragen, die Zuordnung zu Zeichen macht
der Server anhand des gemeldeten Layouts. `F1` und `Strg+Umschalt+P` bleiben für
VS Code reserviert; alle übrigen Tasten gehen an die Sitzung, solange das
Panel den Fokus hat.

## Bekannte Grenzen

Keine Zwischenablage, kein Audio, keine Laufwerksweiterleitung, keine
Auflösungsänderung im laufenden Betrieb. Server, die eine Terminalserver-Lizenz
(Per-Device-CAL) verlangen, werden nicht unterstützt.
