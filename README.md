# RDP in VS Code

Eine VS Code Extension, die Remote-Desktop-Sitzungen direkt in einem Editor-Panel
öffnet – zusammen mit **`ts-rdp`**, einer von Grund auf neu geschriebenen
RDP-Implementierung in TypeScript.

## Installation und Hilfe

Ein bereitgestelltes VSIX in VS Code über **Extensions: Install from VSIX…**
installieren. In der Remote-Desktop-Seitenleiste eine Verbindung hinzufügen oder
**RDP: Erste Schritte** aufrufen. Das [Anwenderhandbuch](packages/vscode-rdp/docs/ANWENDERHANDBUCH.md)
und die [Problemlösung](packages/vscode-rdp/docs/TROUBLESHOOTING.md) werden im VSIX
mitgeliefert und sind über die Befehlspalette erreichbar.

Die Publisher-ID entspricht Report Builder: `Tom-Knueppel.vscode-rdp`.
Alte `local.vscode-rdp`-Testinstallationen vorher entfernen; Passwörter erneut
speichern und Laufwerksfreigaben erneut prüfen. Verbindungen in den
Benutzereinstellungen bleiben bestehen.

Der [Vergleich mit Report Builder](docs/report-builder-parity.md) beschreibt
die übernommenen Abläufe und verbleibenden Unterschiede.
Die [Icon-Dokumentation](docs/icons.md) beschreibt die Varianten und den reproduzierbaren Export.

## Warum eine eigene Library?

Die vorhandenen npm-Pakete taugen für dieses Vorhaben nicht:

| Paket | Stand | Problem |
|---|---|---|
| `node-rdpjs` | 0.3.0, letzte inhaltliche Arbeit 2015 | reines JS ohne Typen, **kein NLA** – scheitert an Windows-Standardeinstellungen |
| `node-rdpjs-2` | 0.3.5 (2022) | Fork mit Abhängigkeitspflege, Protokollstand unverändert |
| `mstsc.js` | 0.2.4 | Aufsatz auf `node-rdpjs`, gleiche Grenzen |
| alle genannten | – | **AGPL-3.0**, für eine Extension eine harte Lizenzauflage |

`ts-rdp` ist deshalb neu geschrieben: TypeScript, MIT-Lizenz, keine
Laufzeitabhängigkeiten, und mit NLA/CredSSP – dem Verfahren, das moderne
Windows-Server per Voreinstellung verlangen.

## Aufbau

```
packages/
├── ts-rdp/         RDP-Protokollclient (eigenständig nutzbar, MIT)
└── vscode-rdp/     VS Code Extension (Webview, Eingaben, Verbindungsverwaltung)
```

Die Protokollarbeit läuft im Extension-Host (Node.js): TLS, NLA, Dekomprimierung
der Bitmaps. Das Webview bekommt fertige RGBA-Kacheln und schickt Maus- und
Tastaturereignisse zurück. Der Aufbau sieht so aus:

```
VS Code Webview  ──Eingaben──▶  Extension-Host  ──TCP/TLS──▶  RDP-Server
   <canvas>      ◀──RGBA────    ts-rdp-Client
```

## Funktionsumfang

**Protokoll**
- X.224-Aushandlung, TLS und **NLA (CredSSP + NTLMv2)** mit MIC und Kanalbindung
- MCS-Domain, Capability Exchange, Lizenzphase
- Bildschirmaktualisierungen über Fastpath und Slowpath, inklusive Reassemblierung
  fragmentierter Updates
- **Interleaved-RLE-Dekomprimierung** (MS-RDPEGDI) für 8/15/16/24 bpp und der
  **planare Codec** (RDP 6.0/6.1) für 32 bpp – im Bitmap-Update wie in den
  Surface Commands
- **Surface Commands** mit unkomprimierten und planar komprimierten Pixeln
- **Graphics Pipeline (MS-RDPEGFX)** auf dem dynamischen Kanal `drdynvc`
  (MS-RDPEDYC): Surface-Verwaltung, Cache, ZGFX-Dekompression und die Codecs
  **planar**, **ClearCodec** (samt NSCodec-Subcodec, MS-RDPNSC) und
  **RemoteFX Progressive**. Das ist der Weg, über den Windows Server 2019+
  ab Werk sendet – siehe unten.
- Zeigerformen (Farb-, New- und Cached-Pointer) werden als echter Mauszeiger dargestellt
- Tastatur als Set-1-Scancodes plus Unicode-Ersatzweg, Maus inklusive Rad,
  Seitentasten und Feststelltasten-Abgleich

**Extension**
- Verbindungsverwaltung in der Seitenleiste, Passwörter im sicheren Speicher von VS Code
- Zertifikatsprüfung **vor** der Anmeldung (Trust on first use mit Fingerabdruck)
- Automatische Auflösung nach Panelgröße, Skalierung ein-/ausschaltbar,
  optional volle Pixeldichte auf HiDPI-Bildschirmen
- Graphics Pipeline standardmäßig eingeschaltet (`rdp.graphicsPipeline`),
  Farbtiefe standardmäßig 32 bpp (`rdp.defaultColorDepth`)
- Strg+Alt+Entf, Bildschirm neu anfordern, Leistungsoptionen (Hintergrundbild, Themes …)
- Auflösung folgt der Panelgröße auch während der Sitzung (**MS-RDPEDISP**)
- **Mehrere Monitore**: ein Knopf in der Titelleiste öffnet einen weiteren
  Monitor als eigenes VS-Code-Fenster, rechts neben dem bisherigen
- **H.264 (AVC420)** über WebCodecs im Webview, mit Rückfall auf die übrigen Codecs
- **Zwischenablage** (MS-RDPECLIP): Text in beide Richtungen, Dateien vom
  Arbeitsplatz zum Server
- **Laufwerksumleitung** (MS-RDPEFS): die Ordner des Arbeitsbereichs als
  Laufwerk `\\tsclient\VS_Code`, standardmäßig nur lesbar
- Automatisches Wiederverbinden (Auto-Reconnect-Cookie), `.rdp`-Import und
  -Export, Ordner mit vererbten Einstellungen, Tags, Bandbreitenprofile

## Loslegen

```bash
npm ci
npm run build
npm test
```

Danach in VS Code **F5** drücken – es startet ein zweites Fenster mit geladener
Extension. Dort `RDP: Verbinden mit…` aus der Befehlspalette aufrufen.

Weitere Skripte im Wurzelverzeichnis: `npm run package` baut das VSIX,
`npm run test:vscode` startet die Integrationstests in einer echten
VS-Code-Instanz.

Die Library lässt sich auch ohne VS Code prüfen:

```bash
node packages/ts-rdp/examples/connect.mjs --host 10.0.0.5 --user admin --password geheim
```

Das Programm verbindet sich, zeigt den Zertifikatsfingerabdruck, sammelt einige
Sekunden Bildschirmaktualisierungen und schreibt ein PPM-Bild – ein schneller
Weg, um Protokollprobleme von Darstellungsproblemen zu trennen.
`examples/diagnose.mjs` geht einen Schritt weiter und vergleicht mehrere
Capability-Sätze gegen denselben Server, wenn ein Server sich ungewöhnlich
verhält.

## Tests

`npm test` prüft die Protokolllibrary und die Extension:

- **Krypto gegen offizielle Testvektoren**: MD4 (RFC 1320), RC4,
  NTLMv2 inklusive Session Base Key aus MS-NLMP 4.2.4
- **Protokollkodierung**: X.224, BER/PER, GCC, MCS, Share-PDUs, Client Info
- **RLE-Decoder**: jede Lauf- und Bildart einzeln, gegen handgebaute Ströme
- **Codecs gegen die durchgerechneten Beispiele der Spezifikation**: planar
  (MS-RDPEGDI), ClearCodec mit allen drei Schichten und dem NSCodec-Subcodec,
  RemoteFX Progressive mit RLGR1/RLGR3, inverser DWT und Aufwertungskacheln,
  dazu ZGFX und die AVC-Bitstream-Zerlegung. ClearCodec und Progressive werden
  zusätzlich gegen **echte Aufzeichnungen** eines Windows-Servers geprüft
  (`test/fixtures/`)
- **Graphics Pipeline**: Kopf- und Nachrichtenzerlegung beider Richtungen,
  DVC-Rahmen (MS-RDPEDYC) und ein Test, der festhält, dass Client-Nachrichten
  **nicht** in ZGFX verpackt werden – die Hülle ist einseitig
- **TLS-Verträglichkeit**: Erkennung der BoringSSL-Meldung und ein Mock-Server,
  der den ersten Handshake scheitern lässt – der zweite Versuch muss durchkommen,
  ohne dass nach außen ein Fehler sichtbar wird
- **Neuaktivierung**: Windows schickt kurz nach dem Verbinden ein Deactivate All
  gefolgt von einem neuen Demand Active. Ein Test spielt das nach und prüft, dass
  der Client erneut bestätigt und die Sitzung weiterläuft
- **Integration**: ein Mock-Server spricht die komplette Servergegenseite –
  Handshake, Lizenz, Capability Exchange, Bitmaps, Eingaben, dynamische Kanäle
  und Graphics Pipeline. Für NLA rechnet er die NTLMv2-Antwort mit dem bekannten
  Passwort nach und prüft Proof, MIC und Kanalbindung. Die Clientseite wird also
  gegen eine unabhängige Umsetzung derselben Spezifikation geprüft.

Die Integrationstests gegen eine echte VS-Code-Instanz liegen getrennt unter
`npm run test:vscode` und sind im Unit-Testlauf nicht enthalten.

## TLS mit Windows-Zertifikaten

Das selbstsignierte Zertifikat des Remotedesktopdienstes hat eine Key-Usage-
Erweiterung **ohne `digitalSignature`** – der Schlüssel darf formal nur
verschlüsseln, nicht signieren. Genau das verlangen aber ECDHE-Suiten und alle
TLS-1.3-Verfahren.

OpenSSL wertet das als Zertifikatsfehler, den `rejectUnauthorized: false`
übergeht. **BoringSSL – und damit der Extension-Host von VS Code – bricht den
Handshake hart ab** (`KEY_USAGE_BIT_INCORRECT`). Deshalb versucht der Client
zuerst moderne Suiten und wiederholt bei einer Unverträglichkeit genau einmal mit
statischem RSA-Schlüsselaustausch und TLS 1.2 – dabei wird das Premaster Secret
mit dem öffentlichen Schlüssel verschlüsselt, wofür `keyEncipherment` genügt.

Das kostet Forward Secrecy für diese Verbindung. Der Schutz gegen
zwischengeschaltete Angreifer hängt bei RDP aber ohnehin nicht allein an TLS: die
CredSSP-Bindung des öffentlichen Serverschlüssels und der beim ersten Verbinden
bestätigte Fingerabdruck greifen unabhängig davon. Wer Forward Secrecy braucht,
weist dem Dienst ein Zertifikat mit der Schlüsselverwendung „Digitale Signatur“ zu.

## Windows Server 2019+ und die Graphics Pipeline

Seit Windows Server 2019 ist der **WDDM-Anzeigetreiber** die Voreinstellung für
Remotedesktop-Sitzungen. Er liefert Bildschirminhalte ausschließlich über die
**Graphics Pipeline** (MS-RDPEGFX) auf dem dynamischen virtuellen Kanal
`drdynvc`. Der klassische Ausgabeweg – Bitmap-Updates, Surface Commands, sogar
Zeigerformen – wird dann gar nicht mehr bedient.

Für einen Client, der nur den klassischen Weg spricht, sieht das so aus: Der
Verbindungsaufbau läuft vollständig durch, der Server bestätigt Capabilities,
gewährt die Kontrolle und meldet die erfolgreiche Anmeldung – und sendet
anschließend **kein einziges Byte Bildinhalt**. Kein Fehler, kein Abbruch,
einfach Stille. Nachgemessen mit `examples/diagnose.mjs`: acht verschiedene
Capability-Sätze, immer dasselbe Ergebnis; sobald `drdynvc` angemeldet wird,
beginnt derselbe Server sofort zu senden.

**Dieser Client spricht die Pipeline inzwischen.** `rdp.graphicsPipeline` ist
in der Extension standardmäßig aktiv; der Client meldet `drdynvc` an, nimmt die
drei Kanäle des modernen Stapels an, handelt EGFX-Capabilities aus und dekodiert
die eingehenden Kacheln. Zwei Dinge, die dabei teuer gelernt wurden und in Tests
festgehalten sind:

- **Die ZGFX-Hülle ist einseitig.** MS-RDPEGFX 3.2.5.1: Nachrichten vom Client
  zum Server sind „not encapsulated within any external structure“. Wer sie
  symmetrisch verpackt, verschiebt dem Server den Nachrichtenkopf – sein
  Grafik-Subsystem steigt dann mit `ERRINFO_GRAPHICSSUBSYSTEMFAILED` (0x112F) aus.
- **Ein Server sendet, was er will.** Der Testserver schickt praktisch alles in
  ClearCodec – und darin zu einem guten Teil NSCodec als Subcodec. Zusätzlich
  kommt RemoteFX Progressive über `WIRE_TO_SURFACE_PDU_2`; ohne diesen Decoder
  fehlen ganze Bildbereiche. Nur EGFX 8.0 anzumelden hilft nicht, der Server
  bleibt bei seiner Wahl.

Wo die Pipeline unerwünscht ist – etwa zur Fehlersuche – schaltet
`rdp.graphicsPipeline: false` sie ab; der Server fällt dann auf den klassischen
Weg zurück, sofern seine Gruppenrichtlinie das zulässt.

## Grenzen

Ehrlich benannt, statt später zu überraschen:

- **Keine Standard-RDP-Verschlüsselung** (RC4 ohne TLS). Nur TLS und NLA. Betrifft
  nur sehr alte Server; Windows Server ab 2012 ist ab Werk in Ordnung.
- **Keine Terminalserver-Lizenzausstellung.** Server mit Per-Device-CALs melden
  eine Lizenzanforderung, die dieser Client nicht bedienen kann. Windows ohne
  RDS-Rolle und xrdp sind nicht betroffen.
- **Kein Audio.** `rdpsnd` wird zusammen mit der Laufwerksumleitung nur als
  stummer Hilfskanal angemeldet, weil manche Windows-Server den
  Geräte-Handshake sonst nicht beginnen. Er nimmt keine Audioformate an.
- **Kein AVC444.** H.264 wird nur als AVC420 dekodiert, und nur dort, wo der
  Webview WebCodecs anbietet. Ohne WebCodecs meldet der Client kein H.264.
- **Weitere Monitore nur nebeneinander.** Jeder weitere Monitor sitzt rechts
  vom bisher letzten, oben bündig. Er braucht Display Control (MS-RDPEDISP)
  und einen Server, der mehrere Monitore zulässt.
- **Automatische NLA-Auswahl.** Standard `rdp.nlaMechanism: "auto"` bevorzugt
  Kerberos (Windows: PowerShell 7/SSPI; macOS/Linux: TypeScript) und verwendet
  NTLMv2, wenn Kerberos
  vor dem ersten Tokenaustausch nicht verfügbar ist. Explizite Anmelde- oder
  Sicherheitsfehler erlauben keinen automatischen Rückfall.
  `rdp.nlaMechanism: "kerberos"` verlangt Kerberos ohne NTLM-Rückfall und
  benötigt den Server-FQDN sowie einen erreichbaren AD-KDC. Auf macOS/Linux
  den Benutzer als UPN angeben oder `rdp.kerberosRealm` setzen;
  `rdp.kerberosKdc` kann die DNS-Ermittlung überschreiben.
- **Kein RD Gateway** (MS-TSGU).
- **Kein RemoteApp/RAIL.** Es wird immer der ganze Desktop übertragen.
- **Keine Zeigerform über den Pipeline-Kanal.** `Microsoft::Windows::RDS::MouseCursor`
  wird angenommen, damit das Grafik-Subsystem des Servers startet, aber nicht
  ausgewertet; der Zeiger kommt weiterhin aus den klassischen Pointer-Updates.
- **Keine Zeichenbefehle (Drawing Orders)** und **keine Bitmap-Codecs auf dem
  klassischen Weg** (RemoteFX, NSCodec und H.264 als `CAPSETTYPE_BITMAP_CODECS`).
  Der Client meldet dort bewusst keine Unterstützung; NSCodec und RemoteFX
  Progressive sind nur innerhalb der Graphics Pipeline nutzbar. Auf dem
  klassischen Weg fällt der Server dadurch auf Bitmap-Updates bzw. Surface Bits
  zurück – robust, aber bandbreitenhungriger als ein Vollausbau.
- **Die Library selbst nimmt weiterhin 16 bpp als Voreinstellung** (`RdpClient`
  ohne `colorDepth`). Die Extension fordert 32 bpp an. Der Server darf die
  Farbtiefe ohnehin vorgeben, und seine Angabe gewinnt.

## Offene Punkte

- **Monitoranordnung wählbar machen** (links, oben, unten statt immer rechts)
  und Screenshots über alle Monitore.

## Veröffentlichen

Der [Release-Leitfaden](docs/RELEASING.md) beschreibt CI, GitHub-Releaseentwürfe,
optionales Marketplace-Publishing und den Umstieg von Entwicklungsinstallationen.
`npm run package` baut frisch nach `artifacts/` und prüft den VSIX-Inhalt.
`npm run typecheck`, `npm run check:docs` und `npm run check:package` sind auch
einzeln ausführbar. CI führt die Tests unter Windows, Linux und macOS aus und stellt
geprüfte VSIX-Artefakte bereit.

Zusätzlich kann die Extension von Hand in die **GitHub Package Registry** gestellt werden. In
VS Code **Terminal → Task ausführen…** und dann:

- **RDP: Veröffentlichen – Probelauf**: baut, testet und packt alles, ohne die
  Version anzuheben und ohne hochzuladen.
- **RDP: Veröffentlichen (GitHub Packages)**: fragt nach GitHub-Owner,
  Versionssprung und einem Personal Access Token mit `write:packages`, hebt
  die Version an, baut, testet, packt das VSIX und lädt es als npm-Paket
  `@<owner>/vscode-rdp` hoch.
- **RDP: VSIX bauen**: frisch gebautes und geprüftes VSIX, lokal unter `artifacts/`.

GitHub Packages kennt kein VSIX-Format. Das npm-Paket ist deshalb nur eine
Hülle um die VSIX-Datei; das Manifest der Extension bleibt unverändert. Das
Skript dazu ist [`tools/publish-github.mjs`](tools/publish-github.mjs). Es
lehnt ein Arbeitsverzeichnis mit offenen Änderungen ab, und das Token kommt nur
über die Umgebung (`NODE_AUTH_TOKEN`), nie in eine Datei. Danach die neue
Versionsnummer committen und taggen.

Installieren auf einem Rechner, dessen npm bei GitHub angemeldet ist:

```sh
npm pack @<owner>/vscode-rdp --registry https://npm.pkg.github.com
tar -xzf <owner>-vscode-rdp-<version>.tgz
code --install-extension package/vscode-rdp-<version>.vsix
```

## Lizenz

MIT.
