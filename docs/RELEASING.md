# Packaging und Veröffentlichung

## Lokal prüfen

Node.js 24 und npm verwenden. Die lokalen TLS-Testserver benötigen OpenSSL
im `PATH`. Unter Windows kann beispielsweise `C:\Program Files\Git\usr\bin`
aus Git for Windows für die aktuelle Shell zum `PATH` hinzugefügt werden.
Im Repository-Root:

```sh
npm ci
npm run typecheck
npm test
npm run test:vscode
npm run package
```

Unter Linux benötigt der VS-Code-Test eine grafische Sitzung, zum Beispiel
`xvfb-run -a npm run test:vscode`. Er benötigt keinen RDP-Server.
Der Paket-Build erzeugt `artifacts/vscode-rdp-<version>.vsix` und prüft
Dokumentlinks, Changelog, enthaltene Dateien, Icon und Bundle-Importe.
`npm run check:package` prüft das zuletzt gebaute Paket erneut.

Installieren: **Extensions: Install from VSIX…** oder:

```sh
code --install-extension artifacts/vscode-rdp-1.0.0.vsix
```

## Umstieg von Entwicklungsinstallationen

Der Publisher entspricht Report Builder: `Tom-Knueppel`. Die ID lautet jetzt
`Tom-Knueppel.vscode-rdp`. Alte `local.vscode-rdp`-Installationen vorher entfernen,
damit Befehle und Ansichten nicht doppelt registriert werden.
Verbindungen in den Benutzereinstellungen bleiben erhalten. SecretStorage und
Freigabezustand und bestätigte Zertifikate gehören zur Extension-ID: Passwörter
erneut speichern, Zertifikate erneut prüfen und Laufwerksfreigaben erneut bestätigen.
Es gibt keine automatische Secret-Migration.

## GitHub Release

Releases auf GitHub sind der einzige Vertriebsweg. Die Extension prüft das
neueste veröffentlichte stabile Release; es muss die Datei
`vscode-rdp-<version>.vsix` unter dem Tag `v<version>` enthalten.
**RDP: Nach Updates suchen** erlaubt eine manuelle Prüfung; die automatische
Startprüfung lässt sich mit `rdp.checkForUpdates` abschalten. Download und Installation
erfordern eine Auswahl durch den Anwender. In entfernten Fenstern führt die
Updateaktion zur Release-Seite für die manuelle VSIX-Installation.

Beim Extension-Build werden Notices aus den esbuild-Inputs erzeugt. Ein neues
gebündeltes Fremdpaket benötigt eine Lizenzdatei im Paket; ohne Lizenztext
schlägt der Build fehl. Der Paketcheck vergleicht die archivierten Notices mit
den tatsächlich ermittelten Lizenztexten. `npm run test:tooling` prüft diesen Ablauf.

### Ablauf

1. Änderungen laufend unter `## [Unreleased]` in `packages/vscode-rdp/CHANGELOG.md`
   und `## [Unveröffentlicht]` in `CHANGELOG.de.md` eintragen.
2. Auf `main` mit sauberem Arbeitsverzeichnis den VS-Code-Task
   **RDP: Release erstellen** starten (oder `npm run release -- --bump minor`).
   [`tools/release.mjs`](../tools/release.mjs) hebt die Version an, macht aus
   „Unveröffentlicht“ die Versionssektion (mit neuer, leerer Sektion darüber),
   führt Typecheck, Tests und Paketprüfung aus, committet `chore(release): v<version>`,
   setzt den Tag und pusht `main` und Tag gemeinsam.
3. Der Tag startet den Workflow **Release**: Er prüft, dass Tag und
   Paketversion passen, führt die komplette CI (Windows, Linux, macOS) aus und
   veröffentlicht das Release mit dem geprüften VSIX. Der Release-Text ist die
   Changelog-Sektion der Version. Ist `gh` angemeldet, wartet das Skript auf
   den Lauf und gibt am Ende den Link aus.

**RDP: Release – Probelauf** prüft Changelog und Tests, ohne etwas zu ändern
oder zu pushen. Scheitert der Workflow, den Fehler beheben und den Lauf über
**Actions → Release → Run workflow** auf demselben Tag erneut starten; liegt der
Fehler im getaggten Code, ihn beheben und ein neues Patch-Release erstellen.
