# ts-rdp

Remote-Desktop-Protokoll-Client in reinem TypeScript. Keine Laufzeitabhängigkeiten,
keine nativen Node-Module. Der Standardpfad verwendet `node:net`, `node:tls`
und `node:crypto`. Windows-Kerberos nutzt PowerShell 7/SSPI; macOS und Linux
verwenden eine integrierte TypeScript-Implementierung mit AES128/AES256.

Standard ist `nlaMechanism: 'auto'`: Kerberos bevorzugen, bei fehlender lokaler
Unterstützung oder einem eindeutig als unbekannt gemeldeten Kerberos-Ziel vor dem ersten
Tokenaustausch NTLMv2 verwenden. Explizite Anmeldefehler, unbekannte Fehler und
Fehler nach Beginn des Tokenaustauschs erlauben keinen Rückfall.
`client.authenticationMechanism` liefert nach erfolgreicher NLA das gewählte
Verfahren (`kerberos` oder `ntlm`); das Verfahren wird auch protokolliert.
`nlaMechanism: 'ntlm'` erzwingt NTLMv2.

Für ausschließlich Kerberos `nlaMechanism: 'kerberos'` setzen und einen
Server-FQDN sowie explizite Domänen-Zugangsdaten angeben. Windows benötigt
PowerShell 7. Auf macOS/Linux kommt der Realm aus dem UPN-Benutzernamen, einer
DNS-Domäne in `domain` oder explizit aus `kerberos.realm`. Der AD-KDC muss
erreichbar sein; optional überschreibt `kerberos.kdc: [{ host, port: 88 }]` die
DNS-SRV-Ermittlung. Dieser Modus fällt
weder auf NTLM noch auf TLS ohne NLA zurück.

```ts
import { RdpClient, probeServerCertificate } from 'ts-rdp';

// Zertifikat prüfen, bevor Zugangsdaten übertragen werden
const cert = await probeServerCertificate({ host: '10.0.0.5' });
console.log(cert.fingerprint256);

const client = new RdpClient({
  host: '10.0.0.5',
  domain: 'CONTOSO',
  username: 'admin',
  password: 'geheim',
  width: 1280,
  height: 800,
  colorDepth: 32,
  // Windows Server 2019+ sendet Grafik ausschliesslich über diesen Weg.
  enableGraphicsPipeline: true,
});

client.on('bitmap', (tiles) => {
  for (const tile of tiles) {
    // tile.rgba ist RGBA8888, zeilenweise von oben nach unten
    draw(tile.x, tile.y, tile.width, tile.height, tile.rgba);
  }
});

client.on('pointer', (pointer) => { /* Zeigerform oder null */ });
client.on('resize', ({ width, height }) => { /* Server gibt neue Größe vor */ });
client.on('close', (reason) => console.log('beendet:', reason));

await client.connect();

client.sendMouseMove(100, 200);
client.sendKeyScancode(0x1e, true);  // Taste A drücken
client.sendKeyScancode(0x1e, false);
```

Kacheln der Graphics Pipeline und des klassischen Wegs kommen beide als
`bitmap`-Ereignis heraus – der Aufrufer merkt nicht, welcher Weg benutzt wurde.

## Unterstützt

- Sicherheit: **TLS** und **NLA (CredSSP + NTLMv2)** mit MIC und Public-Key-Bindung
- Verbindungsaufbau: X.224, MCS/GCC, Lizenzphase, Capability Exchange
- Bild, klassischer Weg: Fastpath- und Slowpath-Updates, Interleaved RLE
  (8/15/16/24 bpp), planarer Codec (32 bpp), Paletten, Surface Commands
  unkomprimiert und planar
- Bild, **Graphics Pipeline (MS-RDPEGFX)**: dynamische virtuelle Kanäle
  (MS-RDPEDYC), ZGFX-Dekompression, Surface- und Cacheverwaltung,
  `SOLIDFILL`/`SURFACETOSURFACE`/`CACHETOSURFACE`, Ausgabeabbildung auch
  skaliert, dazu die Codecs **unkomprimiert**, **planar**, **ClearCodec**
  (mit RAW-, NSCodec- und RLEX-Subcodec) und **RemoteFX Progressive**
- H.264: AVC420/AVC444 werden **zerlegt, nicht dekodiert** – der Bitstream wird
  über `onVideo` durchgereicht, damit ihn ein externer Decoder (etwa WebCodecs
  im Browser) übernehmen kann
- Zeiger: Farb-, New- und Cached-Pointer mit Transparenz aus der AND-Maske
- Eingabe: Scancodes (Set 1), Unicode, Maus inklusive Rad und Seitentasten,
  Feststelltasten-Abgleich, Refresh-Rect und Suppress-Output

## Nicht unterstützt

Standard-RDP-Verschlüsselung (RC4 ohne TLS), Lizenzausstellung mit Per-Device-CALs,
die Kanalanwendungen Zwischenablage (`cliprdr`), Audio (`rdpsnd`) und Laufwerke
(`rdpdr`) – die Kanalschicht selbst steht, die Protokolle darauf fehlen –,
Drawing Orders, Bitmap-Codecs auf dem klassischen Weg (`CAPSETTYPE_BITMAP_CODECS`:
RemoteFX, NSCodec, H.264), ein H.264-Decoder, Auflösungsänderung durch den Client
(MS-RDPEDISP), Multi-Monitor, RemoteApp/RAIL sowie der Zeigerkanal
`Microsoft::Windows::RDS::MouseCursor` (wird angenommen, aber nicht ausgewertet).

## Aufbau

| Verzeichnis | Inhalt |
|---|---|
| `core/` | Binär-I/O, Logger, Fehlertypen |
| `crypto/` | MD4, RC4, NTLMv2, CredSSP (MD4 und RC4 fehlen in OpenSSL 3) |
| `asn1/`, `protocol/ber.ts`, `protocol/per.ts` | DER, BER und PER – die drei Kodierungen, die RDP mischt |
| `protocol/` | TPKT, X.224, MCS, GCC, Capabilities, PDUs, Updates, Tastaturtabelle |
| `protocol/virtualChannel.ts`, `dvc.ts` | Statische Kanäle und DVC (MS-RDPEDYC) |
| `protocol/egfx.ts`, `egfxSession.ts` | Graphics Pipeline: Nachrichten und Surface-/Cacheverwaltung |
| `codec/` | Interleaved RLE, planar, ClearCodec (inkl. NSCodec), RemoteFX Progressive, ZGFX, AVC-Zerlegung, Pixelformatwandlung |
| `client.ts` | Verbindungssequenz und Ereignisse |
| `probe.ts` | Zertifikatsabfrage vor der Anmeldung |
| `examples/` | `connect.mjs` (Rauchtest mit PPM-Ausgabe), `diagnose.mjs` (Capability-Sätze vergleichen) |

## Referenzen

- [MS-RDPBCGR] Remote Desktop Protocol: Basic Connectivity and Graphics Remoting
- [MS-RDPEGDI] Graphics Device Interface Acceleration Extensions (3.1.9: RLE und planar)
- [MS-RDPEGFX] Graphics Pipeline Extension (ClearCodec 2.2.4.1, Progressive 2.2.4.2)
- [MS-RDPEDYC] Dynamic Channel Virtual Channel Extension
- [MS-RDPNSC] NSCodec Extension
- [MS-RDPRFX] RemoteFX Codec Extension (Wavelet, RLGR, durchgerechnete Beispiele)
- [MS-CSSP] Credential Security Support Provider
- [MS-NLMP] NT LAN Manager Authentication Protocol
- ITU-T T.124 / T.125 (GCC und MCS)

MIT-Lizenz.
