# ts-rdp

Remote-Desktop-Protokoll-Client in reinem TypeScript. Keine Laufzeitabhängigkeiten,
keine nativen Module – nur `node:net`, `node:tls` und `node:crypto`.

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
});

client.on('bitmap', (tiles) => {
  for (const tile of tiles) {
    // tile.rgba ist RGBA8888, zeilenweise von oben nach unten
    draw(tile.x, tile.y, tile.width, tile.height, tile.rgba);
  }
});

client.on('pointer', (pointer) => { /* Zeigerform oder null */ });
client.on('close', (reason) => console.log('beendet:', reason));

await client.connect();

client.sendMouseMove(100, 200);
client.sendKeyScancode(0x1e, true);  // Taste A drücken
client.sendKeyScancode(0x1e, false);
```

## Unterstützt

- Sicherheit: **TLS** und **NLA (CredSSP + NTLMv2)** mit MIC und Public-Key-Bindung
- Verbindungsaufbau: X.224, MCS/GCC, Lizenzphase, Capability Exchange
- Bild: Fastpath- und Slowpath-Updates, Interleaved RLE (8/15/16/24 bpp), Paletten,
  Surface Commands mit unkomprimierten Pixeln (moderne Windows-Server)
- Zeiger: Farb-, New- und Cached-Pointer mit Transparenz aus der AND-Maske
- Eingabe: Scancodes (Set 1), Unicode, Maus inklusive Rad und Seitentasten,
  Feststelltasten-Abgleich, Refresh-Rect und Suppress-Output

## Nicht unterstützt

Standard-RDP-Verschlüsselung (RC4 ohne TLS), Lizenzausstellung mit Per-Device-CALs,
virtuelle Kanäle (Zwischenablage, Audio, Laufwerke), Drawing Orders, Bitmap-Codecs
(RemoteFX, NSCodec, H.264), Auflösungsänderung im laufenden Betrieb.

## Aufbau

| Verzeichnis | Inhalt |
|---|---|
| `core/` | Binär-I/O, Logger, Fehlertypen |
| `crypto/` | MD4, RC4, NTLMv2, CredSSP (MD4 und RC4 fehlen in OpenSSL 3) |
| `asn1/`, `protocol/ber.ts`, `protocol/per.ts` | DER, BER und PER – die drei Kodierungen, die RDP mischt |
| `protocol/` | TPKT, X.224, MCS, GCC, Capabilities, PDUs, Updates, Tastaturtabelle |
| `codec/` | Interleaved-RLE-Decoder und Pixelformatwandlung |
| `client.ts` | Verbindungssequenz und Ereignisse |
| `probe.ts` | Zertifikatsabfrage vor der Anmeldung |

## Referenzen

- [MS-RDPBCGR] Remote Desktop Protocol: Basic Connectivity and Graphics Remoting
- [MS-RDPEGDI] Graphics Device Interface Acceleration Extensions (Abschnitt 3.1.9: RLE)
- [MS-CSSP] Credential Security Support Provider
- [MS-NLMP] NT LAN Manager Authentication Protocol
- ITU-T T.124 / T.125 (GCC und MCS)

MIT-Lizenz.
