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

Die Extension prüft das neueste veröffentlichte stabile GitHub-Release.
Ein Entwurf genügt dafür nicht. Das Release muss die Datei
`vscode-rdp-<version>.vsix` unter dem passenden Tag `v<version>` enthalten.
**RDP: Nach Updates suchen** erlaubt eine manuelle Prüfung; die automatische
Startprüfung lässt sich mit `rdp.checkForUpdates` abschalten. Download und Installation
erfordern eine Auswahl durch den Anwender. In entfernten Fenstern führt die
Updateaktion zur Release-Seite für die manuelle VSIX-Installation.

Beim Extension-Build werden Notices aus den esbuild-Inputs erzeugt. Ein neues
gebündeltes Fremdpaket benötigt eine Lizenzdatei im Paket; ohne Lizenztext
schlägt der Build fehl. Der Paketcheck vergleicht die archivierten Notices mit
den tatsächlich ermittelten Lizenztexten. `npm run test:tooling` prüft diesen Ablauf.

1. Versionsnummer in `packages/vscode-rdp/package.json` und Lockfile aktualisieren
   (`npm version <version> --no-git-tag-version -w vscode-rdp`) und eine passende
   Sektion in `packages/vscode-rdp/CHANGELOG.md` ergänzen.
2. Änderungen committen und CI auf dem Commit erfolgreich abschließen lassen.
3. Tag `v<version>` auf diesen Commit setzen und pushen.
4. Workflow **Release** manuell auf diesem Tag starten. Standardmäßig wird
   ein GitHub-Releaseentwurf mit geprüftem VSIX erstellt. Der Entwurf kann
   anschließend geprüft und veröffentlicht werden.

## Visual Studio Marketplace

Beim manuellen Release-Workflow `marketplace` nur bewusst aktivieren.
Repository-Environment `marketplace` mit geeignetem Schutz und einem
Publisher-berechtigten Secret `VSCE_PAT` konfigurieren. Der Workflow veröffentlicht
das zuvor gebaute VSIX, ohne nochmals zu bauen oder eine Version anzuheben.
Der Publisher `Tom-Knueppel` muss dem verwendeten Konto gehören.
Bei PAT-Nutzung ein organisationsgebundenes Token mit Marketplace-Manage-Recht
verwenden; keine globalen PATs. Für längerfristige Automatisierung Entra-ID-basierte
Authentifizierung gemäß der [offiziellen Publishing-Dokumentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
einrichten. Secret- und Publisher-Berechtigungen werden nicht durch das Repository angelegt.

## GitHub Packages

Der bestehende Weg bleibt verfügbar und verwendet denselben Paket-Build:

```sh
npm run publish:github -- --owner strxngewxrld --bump none --dry-run
```

Für den echten Upload `--dry-run` entfernen und `NODE_AUTH_TOKEN` mit
`write:packages` setzen. Ohne `--bump none` ist `patch` die Vorgabe;
Changelog vorher für diese Zielversion vorbereiten. Echte Uploads verlangen
einen sauberen Git-Stand. Das Paket `@<owner>/vscode-rdp` enthält das VSIX;
es ist kein Marketplace-Listing. Zugangstoken werden nur über die Umgebung übergeben.
