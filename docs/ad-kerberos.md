# Active-Directory-/Kerberos-Test auf diesem Rechner

Ergebnis nach dem genehmigten Neustart am 22.10.2026:

- Rechner: `WIN-UDEC6VTSF3U`, Windows Server 2025, ursprünglich WORKGROUP.
- AD-DS-Rolle und Verwaltungswerkzeuge erfolgreich installiert.
- `Test-ADDSForestInstallation` für `rdp.test` / `RDPTEST` erfolgreich.
- `Install-ADDSForest` erfolgreich, Neustart erforderlich und angesetzt.
- Neustart abgeschlossen. Der Rechner ist Domänencontroller von `rdp.test`;
  AD DS, KDC, DNS, SQL Express und Business Central laufen.
- Der automatische echte Kerberos-RDP-Test war erfolgreich (Exitcode 0,
  822 dekodierte Kacheln). Security-Ereignis 4624 bestätigt Kerberos für die
  NLA-Netzwerkanmeldung; Ereignis 4769 bestätigt erfolgreiche Service-Tickets.
  Die anschließende interaktive Anmeldung erscheint zusätzlich als Logontyp 10
  mit Paket `Negotiate`; das ist kein Nachweis eines NTLM-Rückfalls.
- Der Benutzer hat die Testdomäne und den Neustart bestätigt und Konsolenzugriff angegeben.
- Der vorhandene Business-Central-Dienst verwendet `.\BCService`; zusätzlich
  existieren die lokalen Sandbox-Konten. Der Wiederanlauftest erfasst diese Konten
  und den Dienststatus nach der Hochstufung.
- Vor AD war ein echter RDP-Login als temporärer Nicht-Administrator gegen
  `127.0.0.1:3389` erfolgreich: NTLMv2, 1024×768, 1.307 dekodierte Kacheln,
  EGFX-Version 8.1, ClearCodec/Progressive und vorhandener EDISP-Kanal.
  Belege: `logs/real-windows-rdp.log`, `logs/real-windows-rdp.png`.

## Interaktiver Folgetest und installierte Extension

Über Windows MCP wurden im echten Kerberos-Desktop geprüft:

- Startmenü, Editor, Maus und Tastatur mit expliziten Windows-Scancodes;
- Textzwischenablage in beide Richtungen einschließlich Umlauten, Eurozeichen
  und Zeilenumbruch; eine remote hinzugefügte Markierung kam lokal an;
- native Windows-Dateizwischenablage: `kerberos-file-äöü.txt` wurde auf den
  Remote-Desktop eingefügt. Die 52 Byte stimmen per SHA-256 überein:
  `408A70AE57E0EA0148DD7DAFAEAD3A7607232EC1CED3C027EFF963C656E3CF96`;
- dynamische Auflösung (784×796 → 1080×796), zweiter Monitor mit
  Gesamtfläche 2104×796 und Rückkehr zu einem Monitor;
- gespeichertes Passwort und Zertifikatsvertrauen beim erneuten Öffnen.

Anschließend wurde `packages/vscode-rdp/.vscode-test/windows-kerberos.vsix`
installiert und VS Code ohne Development-Argumente gestartet. Das geladene
Modul lag unter dem isolierten `extensions/local.vscode-rdp-1.0.0`-Verzeichnis.
Der erneute Login um 09:32 Uhr meldete Kerberos/SSPI ohne NTLM-Rückfall;
Windows protokollierte erneut Kerberos und erfolgreiche Service-Tickets.
Auch ein echter NTLM-Vergleichstest gegen denselben Server bestand
(`logs/domain-ntlm-real-rdp.log`, 442 Kacheln).

Build und Typprüfung bestanden. Die automatisierten Tests bestanden mit
737 Protokolltests, 500 Extension-Tests und 10 Tests im echten VS-Code-Host.
Grafik und mehrere Monitore wurden über EGFX/ClearCodec/Progressive geprüft;
H.264/AVC war in diesem Durchlauf nicht eingeschaltet.

Zusätzliche Belege: `logs/kerberos-file-transfer.json`,
`logs/kerberos-two-monitors.png`, `logs/ad-vscode-tests.log`,
`logs/ad-kerberos-unit-tests.log`, `logs/kerberos-package.log` und die
Sitzungsprotokolle unter `.vscode-test/kerberos-ui/user-data/logs`.

## Wiederhergestellte vorhandene Funktionen

SQL Express war nach dem Boot gestoppt. Nach dem Start wurden die vorhandene
BC-Datenbank und anschließend Business Central vollständig betriebsbereit;
beide Dienste melden `Running`. Dienstkonten und Datenbanken wurden nicht
umgestellt oder neu angelegt.

Die neuen Domänencontroller-Richtlinien verhinderten zunächst den lokalen
Prozessstart der vorhandenen Konten `CodexSandboxOffline` und
`CodexSandboxOnline` (Fehler 1385). Nach ausdrücklicher Benutzerfreigabe wurde
gezielt diesen beiden Konten `SeInteractiveLogonRight` gegeben. Ein normaler
Sandbox-Aufruf meldet wieder `rdptest\codexsandboxoffline`. Administrator- und
RDP-Rechte wurden diesen Konten nicht hinzugefügt.

Das Nicht-Administrator-Testkonto `rdp-e2e-test` ist bis 22.10.2026, 13:13 Uhr
(Europe/Berlin) gültig. Das isolierte Testprofil enthält sein Passwort im
VS-Code-SecretStorage; im Repository liegt es nur DPAPI-geschützt vor.

## Kerberos-Pfad in der Extension

Folgetest der automatischen Auswahl am 22.10.2026:

- 745 Protokolltests, 500 Extension-Tests und 10 Tests im echten VS-Code-Host
  bestanden (1.255 insgesamt); Build und Typecheck erfolgreich.
- `auto` gegen `win-udec6vtsf3u.rdp.test`: Kerberos, 812 dekodierte Kacheln.
- `auto` gegen `127.0.0.1`: NTLMv2, 244 dekodierte Kacheln.
- Installierte VSIX im isolierten VS-Code-Profil ohne gesetzte
  `rdp.nlaMechanism`-Option: Kerberos, echter Windows-Desktop sichtbar.
- Echter Negativtest: falsches Passwort bricht ab; kein NTLM-Rückfall.
- Belege: `logs/auto-auth-unit-tests.log`, `logs/auto-auth-vscode-tests.log`,
  `logs/auto-kerberos-real-rdp.log`, `logs/auto-ntlm-real-rdp.log`,
  `logs/auto-auth-negative.log`, `logs/auto-auth-installed-vsix.log`.

`rdp.nlaMechanism` wählt `auto` (neuer Standard), `ntlm` oder `kerberos`.
Automatisch wird Kerberos bevorzugt. Wenn lokale Voraussetzungen fehlen
(Windows/PowerShell 7/FQDN oder ein lokales Serverkonto) oder SSPI vor dem
ersten RDP-Token `Unsupported` oder `TargetUnknown`
meldet, wird NTLMv2 verwendet. `InvalidCredentials`, `CredentialsExpired`, `UnknownCredentials`,
unbekannte Fehler, Zeitüberschreitungen und sämtliche Fehler nach Beginn des
Tokenaustauschs führen zum Abbruch. Zertifikatsprüfung und Kanalbindung bleiben
verbindlich. Auswahl und erfolgreicher Mechanismus stehen im RDP-Protokoll.

Beim echten Negativtest meldete Windows ein falsches Passwort als
`UnknownCredentials`; deshalb erlaubt dieser Status ausdrücklich keinen Rückfall.
Ein nicht vorhandener Test-SPN wurde auf diesem System als `GenericFailure`
gemeldet und führt ebenfalls zum Abbruch. Die Extension rät bei mehrdeutigen
SSPI-Fehlern nicht, ob ein Anmelde- oder Verfügbarkeitsproblem vorliegt.

Der explizite Modus `kerberos` bleibt ohne automatischen NTLM-Rückfall.
Kerberos verwendet Windows SSPI über einen versteckten PowerShell-7-Prozess
und .NET `NegotiateAuthentication` mit dem expliziten Paket `Kerberos`.
Ein Windows-Extension-Host, ein erreichbarer KDC und der Server-FQDN sind nötig.
Ein IP-Ziel, abgeschaltete NLA und ein TLS-only-Server werden abgelehnt.
Diese strikten Anforderungen gelten für den expliziten Modus `kerberos`.

Die Zugangsdaten werden ausschließlich über stdin an den Hilfsprozess gegeben.
SSPI erledigt Ticket-Austausch, gegenseitige Authentifizierung und
Nachrichtenverschlüsselung. Die Extension prüft weiterhin die CredSSP-Bindung
an den öffentlichen TLS-Serverschlüssel vor der verschlüsselten Delegation.
Die alten NTLM-Tests und zusätzliche Tests zu Kerberos-Zuständen, falscher
Kanalbindung, alten Serverversionen und Downgrade-Verhinderung bleiben erhalten.

## Einrichtung und Wiederanlauf

`tools/Initialize-RdpAdLab.ps1 -Mode Prepare` führt nur die Vorprüfung aus.
`-Mode Promote` installiert DNS, schränkt neue eingehende AD-/DNS-Firewallregeln
auf die eigene Rechner-IP ein und erstellt den Forest. Loopback benötigt keine
eingehende Firewallfreigabe. Bestehende RDP- und
Anwendungsregeln werden dabei nicht geändert. Nach erfolgreicher Hochstufung
wird ein Neustart mit 30 Sekunden Vorlauf angesetzt.

Vorherige IP-/DNS- und Firewallinformationen liegen unter
`logs/ad-network-before.xml` und `logs/ad-firewall-before.xml`.
Das DSRM-Passwort wird zufällig erzeugt, mit Windows-DPAPI im Maschinenkontext
verschlüsselt und als `.vscode-test/ad-lab/dsrm.dpapi` gespeichert. Das gesamte
Verzeichnis ist nur für SYSTEM und Administratoren freigegeben. Es enthält
keine versionierten Geheimnisse. Das bestehende Administrator-Passwort wird
durch das Skript nicht verändert.

Die einmalige SYSTEM-Aufgabe `RdpAdLab-VerifyAfterReboot`:

1. wartet auf AD und erfasst Domäne, Konten und Dienstzustände;
2. richtet den vorherigen DNS-Resolver als Forwarder ein;
3. prüft eindeutige `TERMSRV`-SPNs für Rechnername und FQDN;
4. erstellt/aktualisiert den Nicht-Administrator `rdp-e2e-test`, begrenzt ihn
   auf vier Stunden und gewährt diesem SID gezielt Remote-Interactive-Logon;
5. aktiviert lokale erfolgreiche/fehlgeschlagene Logon- und
   Kerberos-Service-Ticket-Audits und sichert die vorherige Auditkonfiguration;
6. führt den echten RDP-Rauchtest mit erzwungenem Kerberos aus;
7. speichert Exitcode und relevante Security-Ereignisse und entfernt die Aufgabe.

Ergebnisse nach dem Neustart:

- `.vscode-test/ad-lab/after-reboot.json`
- `.vscode-test/ad-lab/kerberos-security-events.json`
- `logs/kerberos-real-windows-rdp.log`
- bei erfolgreicher Bildübertragung: `logs/kerberos-windows-rdp.png`

Ein gespeicherter Exitcode ungleich null bedeutet einen fehlgeschlagenen Test.
Für den Kerberos-Nachweis sind die erfolgreiche SSPI-Anmeldung ohne Rückfall
sowie serverseitige Kerberos-Logon-/Ticketereignisse maßgeblich. Diese Nachweise
liegen für Bibliothek, Development Host und installiertes VSIX vor.

Erneuter Rauchtest aus einer administrativen PowerShell 7:

```powershell
./tools/Invoke-RdpLabSmoke.ps1 -Mechanism kerberos
./tools/Invoke-RdpLabSmoke.ps1 -Mechanism ntlm
```

Das Hilfsskript entschlüsselt die geschützten Test-Zugangsdaten nur im Speicher
und übergibt sie per stdin. Es gibt das Passwort nicht aus. Nach Abschluss der
interaktiven Tests das Testkonto deaktivieren und verbleibende RDP-Test-Sitzungen
abmelden. Bei Bedarf kann die gesicherte Auditkonfiguration wiederhergestellt
werden. AD nicht durch bloßes Entfernen der Windows-Rolle zurückbauen: Ein
Domänencontroller muss zuerst ordnungsgemäß heruntergestuft werden.

Protokollgrundlagen:
[Microsoft CredSSP](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cssp/385a7489-d46b-464c-b224-f7340e308a5c),
[.NET NegotiateAuthentication](https://learn.microsoft.com/en-us/dotnet/api/system.net.security.negotiateauthentication),
[Install-ADDSForest](https://learn.microsoft.com/en-us/powershell/module/addsdeployment/install-addsforest).
