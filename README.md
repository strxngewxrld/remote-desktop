# RDP in VS Code

Eine VS Code Extension, die Remote-Desktop-Sitzungen direkt in einem Editor-Panel
öffnet – zusammen mit **`ts-rdp`**, einer von Grund auf neu geschriebenen
RDP-Implementierung in TypeScript.

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
- **Interleaved-RLE-Dekomprimierung** (MS-RDPEGDI) für 8/15/16/24 bpp
- **Surface Commands** mit unkomprimierten Pixeln – der Weg, über den aktuelle
  Windows-Versionen (RDP-Stack 10.x) Grafik liefern
- Zeigerformen (Farb-, New- und Cached-Pointer) werden als echter Mauszeiger dargestellt
- Tastatur als Set-1-Scancodes plus Unicode-Ersatzweg, Maus inklusive Rad,
  Seitentasten und Feststelltasten-Abgleich

**Extension**
- Verbindungsverwaltung in der Seitenleiste, Passwörter im sicheren Speicher von VS Code
- Zertifikatsprüfung **vor** der Anmeldung (Trust on first use mit Fingerabdruck)
- Automatische Auflösung nach Panelgröße, Skalierung ein-/ausschaltbar
- Strg+Alt+Entf, Bildschirm neu anfordern, Leistungsoptionen (Hintergrundbild, Themes …)

## Loslegen

```bash
npm install
npm run build
npm test
```

Danach in VS Code **F5** drücken – es startet ein zweites Fenster mit geladener
Extension. Dort `RDP: Verbinden mit…` aus der Befehlspalette aufrufen.

Die Library lässt sich auch ohne VS Code prüfen:

```bash
node packages/ts-rdp/examples/connect.mjs --host 10.0.0.5 --user admin --password geheim
```

Das Programm verbindet sich, zeigt den Zertifikatsfingerabdruck, sammelt einige
Sekunden Bildschirmaktualisierungen und schreibt ein PPM-Bild – ein schneller
Weg, um Protokollprobleme von Darstellungsproblemen zu trennen.

## Tests

106 Tests, `npm test`:

- **Krypto gegen offizielle Testvektoren**: MD4 (RFC 1320), RC4,
  NTLMv2 inklusive Session Base Key aus MS-NLMP 4.2.4
- **Protokollkodierung**: X.224, BER/PER, GCC, MCS, Share-PDUs, Client Info
- **RLE-Decoder**: jede Lauf- und Bildart einzeln, gegen handgebaute Ströme
- **TLS-Verträglichkeit**: Erkennung der BoringSSL-Meldung und ein Mock-Server,
  der den ersten Handshake scheitern lässt – der zweite Versuch muss durchkommen,
  ohne dass nach außen ein Fehler sichtbar wird
- **Neuaktivierung**: Windows schickt kurz nach dem Verbinden ein Deactivate All
  gefolgt von einem neuen Demand Active. Ein Test spielt das nach und prüft, dass
  der Client erneut bestätigt und die Sitzung weiterläuft
- **Integration**: ein Mock-Server spricht die komplette Servergegenseite –
  Handshake, Lizenz, Capability Exchange, Bitmaps, Eingaben. Für NLA rechnet er
  die NTLMv2-Antwort mit dem bekannten Passwort nach und prüft Proof, MIC und
  Kanalbindung. Die Clientseite wird also gegen eine unabhängige Umsetzung
  derselben Spezifikation geprüft.

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

Dieser Client beherrscht die Pipeline **noch nicht**. Zwei Wege:

- **Auf dem Server** die Gruppenrichtlinie *Remotedesktopdienste →
  Remotedesktop-Sitzungshost → Remotesitzungsumgebung → „WDDM-Grafikanzeigetreiber
  für Remotedesktopverbindungen verwenden"* auf **Deaktiviert** setzen und neu
  starten. Windows fällt dann auf den klassischen Weg zurück.
- **Im Client** die Pipeline implementieren: `drdynvc` mit DVC-Protokoll
  (MS-RDPEDYC), darauf EGFX mit Surface-Verwaltung, ZGFX-Dekompression und den
  planaren Codec RDP 6.1. Steht auf der Liste.

## Grenzen

Ehrlich benannt, statt später zu überraschen:

- **Keine Standard-RDP-Verschlüsselung** (RC4 ohne TLS). Nur TLS und NLA. Betrifft
  nur sehr alte Server; Windows Server ab 2012 ist ab Werk in Ordnung.
- **Keine Terminalserver-Lizenzausstellung.** Server mit Per-Device-CALs melden
  eine Lizenzanforderung, die dieser Client nicht bedienen kann. Windows ohne
  RDS-Rolle und xrdp sind nicht betroffen.
- **Keine Zwischenablage, kein Audio, keine Laufwerksweiterleitung.** Dafür wären
  virtuelle Kanäle (`cliprdr`, `rdpsnd`, `rdpdr`) nötig – die Kanalinfrastruktur
  ist vorbereitet, die Kanäle selbst fehlen.
- **Keine Auflösungsänderung im laufenden Betrieb.** Die Sitzung wird mit der
  Panelgröße beim Verbinden aufgebaut.
- **Keine Graphics Pipeline (MS-RDPEGFX).** Siehe den Abschnitt oben – betrifft
  Windows Server 2019+ in der Standardkonfiguration.
- **Kein planarer Codec (RDP 6.0).** Deshalb ist 16 bpp die Voreinstellung: bis
  24 bpp komprimiert der Server mit Interleaved RLE, ab 32 bpp planar.
- **Keine Zeichenbefehle (Drawing Orders), keine Bitmap-Codecs (RemoteFX, NSCodec,
  H.264).** Der Client meldet bewusst keine Order- und Codec-Unterstützung. Der
  Server fällt dadurch auf Bitmap-Updates bzw. unkomprimierte Surface Bits zurück –
  robust, aber bandbreitenhungriger als ein Vollausbau.

## Lizenz

MIT.
