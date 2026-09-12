import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { GRAPHICS_CHANNEL_NAME, RdpClient } from '../src/client.js';
import { BinaryReader, BinaryWriter } from '../src/core/binary.js';
import { readShareControlHeader } from '../src/protocol/pdu.js';
import { MockRdpServer, ReceivedInput } from './mockServer.js';
import type { DvcCapsResponse, DvcCreateResponse, DvcData } from './mockServer.js';
import { DVC_CREATION_STATUS_NO_LISTENER, DVC_CREATION_STATUS_OK } from '../src/protocol/dvc.js';
import {
  EGFX_HEADER_SIZE,
  PIXEL_FORMAT_XRGB_8888,
  RDPGFX_CAPS_FLAG_AVC_DISABLED,
  RDPGFX_CAPVERSION_10,
  RDPGFX_CMDID_CAPSADVERTISE,
  RDPGFX_CMDID_CREATESURFACE,
  RDPGFX_CMDID_ENDFRAME,
  RDPGFX_CMDID_FRAMEACKNOWLEDGE,
  RDPGFX_CMDID_MAPSURFACETOOUTPUT,
  RDPGFX_CMDID_RESETGRAPHICS,
  RDPGFX_CMDID_STARTFRAME,
  RDPGFX_CMDID_WIRETOSURFACE_1,
  RDPGFX_CODECID_UNCOMPRESSED,
  parseEgfxPdus,
} from '../src/protocol/egfx.js';
import { probeServerCertificate } from '../src/probe.js';
import { LEGACY_TLS_PROFILE, isTlsCompatibilityError } from '../src/protocol/tlsProfiles.js';
import {
  FASTPATH_UPDATETYPE_BITMAP,
  FASTPATH_UPDATETYPE_POINTER,
  INPUT_EVENT_MOUSE,
  INPUT_EVENT_SCANCODE,
  PTRFLAGS_BUTTON1,
  PTRFLAGS_DOWN,
} from '../src/protocol/constants.js';
import type { DecodedBitmap } from '../src/protocol/updates.js';

const WIDTH = 800;
const HEIGHT = 600;

/** Selbstsigniertes Testzertifikat; RDP-Server verwenden in der Praxis dasselbe. */
function createTestCertificate(): { cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-test-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=ts-rdp-test',
  ], { stdio: 'ignore' });
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

/**
 * Server und Clients werden mitgeschrieben und am Ende zwangsweise geschlossen.
 * Ohne das haelt ein fehlgeschlagener Test offene Sockets zurueck und der
 * Testprozess endet nie - ein Fehler wuerde sich als Haenger tarnen.
 */
const offeneServer: MockRdpServer[] = [];
const offeneClients: RdpClient[] = [];

function neuerServer(options: ConstructorParameters<typeof MockRdpServer>[0]): MockRdpServer {
  const server = new MockRdpServer(options);
  offeneServer.push(server);
  return server;
}

function neuerClient(options: ConstructorParameters<typeof RdpClient>[0]): RdpClient {
  const client = new RdpClient(options);
  offeneClients.push(client);
  return client;
}

after(() => {
  for (const client of offeneClients.splice(0)) {
    try {
      client.disconnect();
    } catch {
      // beim Aufraeumen unerheblich
    }
  }
  for (const server of offeneServer.splice(0)) server.close();
});

/** Wartet auf das naechste Ereignis, das die Bedingung erfuellt. */
function naechstesEreignis<T>(
  emitter: MockRdpServer,
  name: string,
  passt: (wert: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const listener = (wert: T) => {
      if (!passt(wert)) return;
      emitter.removeListener(name, listener);
      resolve(wert);
    };
    emitter.on(name, listener);
  });
}

/** Unkomprimierte 16bpp-Bitmap, von unten nach oben wie im Protokoll. */
function bitmapUpdate(): Buffer {
  const width = 2;
  const height = 2;
  const pixels = new BinaryWriter();
  // Untere Zeile zuerst: gruen, blau - darueber rot, weiss.
  pixels.uint16le(0x07e0).uint16le(0x001f);
  pixels.uint16le(0xf800).uint16le(0xffff);
  const data = pixels.toBuffer();

  return new BinaryWriter()
    .uint16le(0x0001) // updateType: BITMAP
    .uint16le(1) // numberRectangles
    .uint16le(10).uint16le(20) // destLeft/destTop
    .uint16le(11).uint16le(21) // destRight/destBottom
    .uint16le(width).uint16le(height)
    .uint16le(16) // bitsPerPixel
    .uint16le(0) // flags: unkomprimiert
    .uint16le(data.length)
    .bytes(data)
    .toBuffer();
}

/** Komprimierte 4x1-Bitmap: ein Farblauf in Interleaved RLE. */
function compressedBitmapUpdate(): Buffer {
  const data = Buffer.from([(3 << 5) | 4, 0x00, 0xf8]); // REGULAR_COLOR_RUN, 4 Pixel rot
  return new BinaryWriter()
    .uint16le(0x0001)
    .uint16le(1)
    .uint16le(0).uint16le(0)
    .uint16le(3).uint16le(0)
    .uint16le(4).uint16le(1)
    .uint16le(16)
    .uint16le(0x0401) // BITMAP_COMPRESSION | NO_BITMAP_COMPRESSION_HDR
    .uint16le(data.length)
    .bytes(data)
    .toBuffer();
}

describe('Vollstaendige Verbindungssequenz gegen einen Mock-Server', () => {
  let server: MockRdpServer;
  let port: number;
  let certificate: { cert: string; key: string };

  before(async () => {
    certificate = createTestCertificate();
    server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT });
    port = await server.listen();
  });

  after(() => server.close());

  test('Client durchlaeuft Handshake und empfaengt Bildschirminhalt', async () => {
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      username: 'tester',
      password: 'geheim',
      useNla: false, // der Mock-Server bietet nur TLS an
      width: WIDTH,
      height: HEIGHT,
      connectTimeout: 10000,
    });

    const clientInfo = once(server, 'clientInfo');
    const confirmActive = once(server, 'confirmActive');
    const activated = once(server, 'activated');

    const bitmaps: DecodedBitmap[] = [];
    client.on('bitmap', (tiles) => bitmaps.push(...tiles));
    client.on('error', (err) => {
      throw err;
    });

    await client.connect();
    assert.equal(client.isConnected, true, 'Sitzung muss aktiv sein');

    // Der Server muss ein auswertbares Client Info PDU erhalten haben.
    const [info] = await clientInfo;
    assert.ok((info as Buffer).includes(Buffer.from('tester\0', 'ucs2')), 'Benutzername im Client Info PDU');

    await confirmActive;
    await activated;

    // Bildschirminhalt einspeisen und das Ergebnis pruefen.
    const received = new Promise<void>((resolve) => {
      client.on('bitmap', () => resolve());
    });
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmapUpdate());
    await received;

    const tile = bitmaps[0];
    assert.equal(tile.x, 10);
    assert.equal(tile.y, 20);
    assert.equal(tile.width, 2);
    assert.equal(tile.height, 2);
    // Unkomprimierte Bitmaps liegen von unten nach oben vor und werden gedreht:
    // oben links muss jetzt Rot stehen.
    assert.deepEqual([...tile.rgba.slice(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...tile.rgba.slice(4, 8)], [255, 255, 255, 255]);
    assert.deepEqual([...tile.rgba.slice(8, 12)], [0, 255, 0, 255]);
    assert.deepEqual([...tile.rgba.slice(12, 16)], [0, 0, 255, 255]);

    client.disconnect();
  });

  test('Komprimierte Bitmaps werden dekodiert', async () => {
    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    await client.connect();

    const tiles = new Promise<DecodedBitmap[]>((resolve) => client.on('bitmap', resolve));
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, compressedBitmapUpdate());
    const [tile] = await tiles;

    assert.equal(tile.width, 4);
    assert.equal(tile.height, 1);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual([...tile.rgba.slice(i * 4, i * 4 + 4)], [255, 0, 0, 255], `Pixel ${i} ist rot`);
    }
    client.disconnect();
  });

  test('Zeiger-Updates erreichen den Client', async () => {
    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    await client.connect();

    const pointerReceived = new Promise<any>((resolve) => client.on('pointer', resolve));
    const xorStride = 6; // 2 Pixel * 3 Byte
    const pointerData = new BinaryWriter()
      .uint16le(24) // xorBpp
      .uint16le(1) // cacheIndex
      .uint16le(0).uint16le(0) // Hotspot
      .uint16le(2).uint16le(2) // Groesse
      .uint16le(4) // lengthAndMask (2 Zeilen * 2 Byte)
      .uint16le(xorStride * 2)
      .bytes(Buffer.alloc(xorStride * 2, 0xff)) // weisser Zeiger
      .bytes(Buffer.alloc(4, 0x00)) // AND-Maske: vollstaendig deckend
      .toBuffer();
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_POINTER, pointerData);

    const pointer = await pointerReceived;
    assert.equal(pointer.width, 2);
    assert.equal(pointer.height, 2);
    assert.deepEqual([...pointer.rgba.slice(0, 4)], [255, 255, 255, 255]);
    client.disconnect();
  });

  test('Maus- und Tastatureingaben erreichen den Server', async () => {
    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    await client.connect();

    const inputs: ReceivedInput[] = [];
    server.on('input', (input: ReceivedInput) => inputs.push(input));

    const mausEmpfangen = naechstesEreignis(server, 'input', (i: ReceivedInput) =>
      i.events.some((e) => e.messageType === INPUT_EVENT_MOUSE),
    );
    client.sendMouseButton(400, 300, PTRFLAGS_BUTTON1, true);
    await mausEmpfangen;

    const tasteEmpfangen = naechstesEreignis(server, 'input', (i: ReceivedInput) =>
      i.events.some((e) => e.messageType === INPUT_EVENT_SCANCODE),
    );
    client.sendKeyScancode(0x1e, true); // Taste A
    await tasteEmpfangen;

    // Nach der Aktivierung schickt der Client zusaetzlich ein Sync-Ereignis,
    // deshalb wird nach Art gesucht statt nach Position.
    const alle = inputs.flatMap((i) => i.events);
    const maus = alle.find((e) => e.messageType === INPUT_EVENT_MOUSE);
    assert.ok(maus, 'Mausereignis muss ankommen');
    assert.equal(maus.flags, PTRFLAGS_BUTTON1 | PTRFLAGS_DOWN);
    assert.equal(maus.param1, 400);
    assert.equal(maus.param2, 300);

    const taste = alle.find((e) => e.messageType === INPUT_EVENT_SCANCODE);
    assert.ok(taste, 'Tastenereignis muss ankommen');
    assert.equal(taste.param1, 0x1e);
    assert.equal(taste.flags, 0x4000, 'KBDFLAGS_DOWN');

    client.disconnect();
  });

  test('Zertifikatsabfrage liefert den Fingerabdruck vor der Anmeldung', async () => {
    const info = await probeServerCertificate({ host: '127.0.0.1', port, useNla: false });
    assert.match(info.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(info.selfSigned, true);
    assert.match(info.subject, /ts-rdp-test/);
  });

  test('Serverseitiges Trennen loest ein close-Ereignis aus', async () => {
    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    await client.connect();
    const closed = once(client, 'close');
    server.close();
    await closed;
    assert.equal(client.isConnected, false);
  });
});

describe('NLA (CredSSP/NTLMv2) gegen einen Mock-Server', () => {
  let server: MockRdpServer;
  let port: number;

  before(async () => {
    const certificate = createTestCertificate();
    server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      credentials: { domain: 'TESTDOM', user: 'tester', password: 'P@ssw0rt!' },
    });
    port = await server.listen();
  });

  after(() => server.close());

  test('Client authentifiziert sich erfolgreich und uebertraegt die Zugangsdaten', async () => {
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      domain: 'TESTDOM',
      username: 'tester',
      password: 'P@ssw0rt!',
      width: WIDTH,
      height: HEIGHT,
      connectTimeout: 10000,
    });

    const credssp = once(server, 'credssp');
    client.on('error', (err) => {
      throw err;
    });

    await client.connect();
    const [outcome] = await credssp;

    // Der Server konnte die NTLMv2-Antwort mit dem bekannten Passwort nachrechnen,
    // die Kanalbindung pruefen und die Zugangsdaten entschluesseln.
    assert.deepEqual(outcome.credentials, {
      domain: 'TESTDOM',
      user: 'tester',
      password: 'P@ssw0rt!',
    });
    assert.equal(outcome.micVerified, true, 'MIC der AUTHENTICATE-Nachricht muss stimmen');
    assert.equal(client.isConnected, true);

    client.disconnect();
  });

  test('Falsches Passwort wird vom Server erkannt', async () => {
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      domain: 'TESTDOM',
      username: 'tester',
      password: 'falsch',
      width: WIDTH,
      height: HEIGHT,
      connectTimeout: 5000,
    });
    client.on('error', () => {});
    await assert.rejects(() => client.connect());
  });
});

describe('TLS-Vertraeglichkeit mit Windows-RDP-Zertifikaten', () => {
  test('Die Fehlermeldung von BoringSSL loest einen Wiederholversuch aus', () => {
    // Genau diese Meldung liefert der Extension-Host von VS Code bei einem
    // Zertifikat ohne digitalSignature.
    const boringSsl = new Error(
      '1322850673152:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:' +
        '../../third_party/boringssl/src/ssl/ssl_cert.cc:360:',
    );
    assert.equal(isTlsCompatibilityError(boringSsl), true);
  });

  test('Weitere Unvertraeglichkeiten werden erkannt, echte Fehler nicht', () => {
    assert.equal(isTlsCompatibilityError(new Error('sslv3 alert handshake failure')), true);
    assert.equal(isTlsCompatibilityError(Object.assign(new Error('x'), { code: 'EPROTO' })), true);
    assert.equal(isTlsCompatibilityError(new Error('unsupported protocol')), true);

    assert.equal(isTlsCompatibilityError(new Error('ECONNREFUSED')), false);
    assert.equal(isTlsCompatibilityError(new Error('CredSSP: Kanalbindung stimmt nicht')), false);
    assert.equal(isTlsCompatibilityError(undefined), false);
  });

  test('Die Rueckfallebene nutzt ausschliesslich statischen RSA-Schluesselaustausch', () => {
    // Keine ECDHE-Suite, sonst braeuchte das Zertifikat wieder digitalSignature.
    assert.ok(!LEGACY_TLS_PROFILE.ciphers!.includes('ECDHE'));
    assert.ok(!LEGACY_TLS_PROFILE.ciphers!.includes('DHE'));
    // TLS 1.3 kennt keinen RSA-Schluesselaustausch mehr.
    assert.equal(LEGACY_TLS_PROFILE.maxVersion, 'TLSv1.2');
  });

  test('Verbindung zu einem Server, der nur statisches RSA anbietet', async () => {
    const certificate = createTestCertificate();
    const server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      ciphers: 'AES128-SHA:AES256-SHA:AES128-GCM-SHA256',
      maxTlsVersion: 'TLSv1.2',
    });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    client.on('error', (err) => {
      throw err;
    });
    await client.connect();
    assert.equal(client.isConnected, true);

    client.disconnect();
    server.close();
  });

  test('Nach einem gescheiterten Handshake verbindet der zweite Versuch', async () => {
    const certificate = createTestCertificate();
    const server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      failFirstTlsHandshake: true,
    });
    const port = await server.listen();

    const warnungen: string[] = [];
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      logLevel: 'warn',
      logSink: (_level, message) => warnungen.push(message),
    });

    // Der erste Versuch darf nach aussen weder 'error' noch 'close' melden.
    let fehlerGemeldet = false;
    let geschlossenGemeldet = false;
    client.on('error', () => (fehlerGemeldet = true));
    client.on('close', () => (geschlossenGemeldet = true));

    await client.connect();

    assert.equal(client.isConnected, true, 'der zweite Versuch muss erfolgreich sein');
    assert.equal(server.tlsAttempts, 2, 'es muss genau einen Wiederholversuch geben');
    assert.equal(fehlerGemeldet, false, 'kein Fehlerereignis waehrend des Wiederholversuchs');
    assert.equal(geschlossenGemeldet, false, 'kein Schliessereignis waehrend des Wiederholversuchs');
    assert.ok(
      warnungen.some((w) => w.includes('digitalSignature')),
      'der Grund muss im Protokoll stehen',
    );

    client.disconnect();
    server.close();
  });
});

describe('Reihenfolge beim Sitzungsstart', () => {
  test('Bilddaten aus der Handshake-Phase kommen erst nach dem connect-Ereignis', async () => {
    // Der Server schickt den Desktop direkt nach der Aktivierung genau einmal.
    // Kaeme er vor 'connect', haette der Anwender seine Zeichenflaeche noch
    // nicht eingerichtet - bei einem statischen Desktop bliebe das Bild schwarz.
    const certificate = createTestCertificate();
    const server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      bitmapBeforeActivation: bitmapUpdate(),
    });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    const reihenfolge: string[] = [];
    client.on('connect', () => reihenfolge.push('connect'));
    client.on('bitmap', () => reihenfolge.push('bitmap'));
    client.on('error', (err) => {
      throw err;
    });

    await client.connect();
    // Kurz warten, damit zwischengespeicherte Frames sicher ausgeliefert sind.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(reihenfolge.includes('bitmap'), 'die vorab gesendeten Bilddaten muessen ankommen');
    assert.equal(reihenfolge[0], 'connect', `erwartet 'connect' zuerst, tatsaechlich: ${reihenfolge.join(', ')}`);
    assert.equal(client.getDiagnostics().bitmaps, 1);

    client.disconnect();
    server.close();
  });

  test('Die Diagnose zaehlt die empfangenen Update-Arten', async () => {
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    await client.connect();

    const start = client.getDiagnostics();
    assert.equal(start.bitmaps, 0);
    assert.deepEqual(start.updateCodes, {});
    assert.equal(start.supportsRefreshRect, true);
    assert.equal(start.activations, 1);
    assert.equal(start.ioChannelId, 1003);
    assert.equal(client.refresh(), true, 'der Server bietet Refresh Rect an');

    const empfangen = new Promise((resolve) => client.on('bitmap', resolve));
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmapUpdate());
    await empfangen;

    const diagnose = client.getDiagnostics();
    assert.equal(diagnose.bitmaps, 1);
    assert.deepEqual(diagnose.updateCodes, { '0x1': 1 });
    assert.equal(diagnose.activations, 1);

    client.disconnect();
    server.close();
  });
});

describe('Refresh Rect', () => {
  test('Ohne Serverunterstuetzung wird keine Anforderung gesendet', async () => {
    const certificate = createTestCertificate();
    const server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      refreshRectSupport: false,
    });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    await client.connect();

    assert.equal(client.getDiagnostics().supportsRefreshRect, false);
    assert.equal(client.refresh(), false, 'ohne Unterstuetzung darf nichts gesendet werden');

    client.disconnect();
    server.close();
  });
});

describe('Neuaktivierung der Sitzung', () => {
  test('Deactivate All gefolgt von Demand Active wird beantwortet', async () => {
    // Windows schickt diese Folge routinemaessig kurz nach dem Verbinden.
    // Antwortet der Client nicht mit einem neuen Confirm Active, wartet der
    // Server vergeblich und beendet die Sitzung - ohne dass je ein Bild kam.
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    let geschlossen = false;
    client.on('close', () => (geschlossen = true));
    client.on('error', (err) => {
      throw err;
    });

    // Das Ereignis der ersten Aktivierung muss vor connect() abonniert werden:
    // connect() kehrt zurueck, sobald die Font List gesendet ist - der Server
    // hat sie dann noch nicht zwingend verarbeitet.
    const ersteAktivierung = once(server, 'activated');
    await client.connect();
    await ersteAktivierung;
    assert.equal(client.getDiagnostics().activations, 1);

    const zweiteAktivierung = once(server, 'activated');
    server.reactivate();
    await zweiteAktivierung;

    assert.equal(client.getDiagnostics().activations, 2, 'die Neuaktivierung muss bestaetigt werden');
    assert.equal(geschlossen, false, 'die Sitzung darf dabei nicht enden');

    // Nach der Neuaktivierung muss weiterhin Bild ankommen.
    const bild = new Promise((resolve) => client.on('bitmap', resolve));
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmapUpdate());
    await bild;
    assert.equal(client.getDiagnostics().bitmaps, 1);

    client.disconnect();
    server.close();
  });

  test('Eingaben funktionieren nach der Neuaktivierung weiter', async () => {
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    const ersteAktivierung = once(server, 'activated');
    await client.connect();
    await ersteAktivierung;

    const zweiteAktivierung = once(server, 'activated');
    server.reactivate();
    await zweiteAktivierung;

    const eingabe = once(server, 'input');
    client.sendMouseMove(123, 45);
    const [empfangen] = await eingabe;
    assert.equal((empfangen as ReceivedInput).events[0].param1, 123);

    client.disconnect();
    server.close();
  });
});

describe('I/O-Kanal des Servers', () => {
  test('Der Client sendet auf dem Kanal, den der Server nennt', async () => {
    // Der I/O-Kanal ist ueblicherweise 1003, der Server darf aber einen
    // anderen waehlen. Wer stattdessen fest 1003 sendet, dessen PDUs werden
    // stillschweigend verworfen: die Verbindung steht, aber es kommt nie ein Bild.
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT, ioChannelId: 1007 });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    const aktiviert = once(server, 'activated');
    await client.connect();
    await aktiviert;

    assert.equal(client.getDiagnostics().ioChannelId, 1007);
    assert.deepEqual([...server.clientChannels], [1007], 'alle PDUs muessen auf 1007 laufen');

    // Und der Bildweg funktioniert ueber diesen Kanal ebenfalls.
    const bild = new Promise((resolve) => client.on('bitmap', resolve));
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmapUpdate());
    await bild;
    assert.equal(client.getDiagnostics().bitmaps, 1);

    client.disconnect();
    server.close();
  });
});

describe('Grafik über Surface Commands', () => {
  test('Der Client bietet die Capability an und verarbeitet Surface Bits', async () => {
    // Aktuelle Windows-Versionen liefern Bildschirminhalte auf diesem Weg statt
    // als klassische Bitmap-Updates. Fehlt die Capability, bleibt das Bild leer.
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    const bestaetigt = once(server, 'confirmActive');
    await client.connect();
    const [confirmActive] = await bestaetigt;

    // 0x1c = CAPSETTYPE_SURFACE_COMMANDS muss im Confirm Active stehen.
    const typen: number[] = [];
    const r = new BinaryReader(confirmActive as Buffer);
    readShareControlHeader(r);
    r.uint32le(); // shareId
    r.uint16le(); // originatorId
    const laengeQuelle = r.uint16le();
    r.uint16le(); // lengthCombinedCapabilities
    r.skip(laengeQuelle);
    const anzahl = r.uint16le();
    r.uint16le();
    for (let i = 0; i < anzahl; i++) {
      typen.push(r.uint16le());
      const laenge = r.uint16le();
      r.skip(laenge - 4);
    }
    assert.ok(typen.includes(0x1c), `Surface Commands fehlen: ${typen.map((t) => '0x' + t.toString(16))}`);

    // Und der Weg funktioniert end-to-end.
    const pixel = Buffer.from([0, 0, 255, 255]); // BGRA, rot
    const befehl = new BinaryWriter()
      .uint16le(0x0001) // CMDTYPE_SET_SURFACE_BITS
      .uint16le(5).uint16le(6)
      .uint16le(5).uint16le(6)
      .uint8(32).uint8(0).uint8(0).uint8(0)
      .uint16le(1).uint16le(1)
      .uint32le(pixel.length)
      .bytes(pixel)
      .toBuffer();

    const bild = new Promise<DecodedBitmap[]>((resolve) => client.on('bitmap', resolve));
    server.sendFastpathUpdate(0x04 /* FASTPATH_UPDATETYPE_SURFCMDS */, befehl);
    const [kachel] = await bild;

    assert.equal(kachel.x, 5);
    assert.equal(kachel.y, 6);
    assert.deepEqual([...kachel.rgba], [255, 0, 0, 255]);
    assert.equal(client.getDiagnostics().bitmaps, 1);

    client.disconnect();
    server.close();
  });
});

describe('Farbtiefe', () => {
  /** Liest die Capability-Sets aus einem Confirm Active PDU. */
  function capsAusConfirmActive(pdu: Buffer): Map<number, Buffer> {
    const r = new BinaryReader(pdu);
    readShareControlHeader(r);
    r.uint32le();
    r.uint16le();
    const laengeQuelle = r.uint16le();
    r.uint16le();
    r.skip(laengeQuelle);
    const anzahl = r.uint16le();
    r.uint16le();
    const out = new Map<number, Buffer>();
    for (let i = 0; i < anzahl; i++) {
      const typ = r.uint16le();
      const laenge = r.uint16le();
      out.set(typ, r.bytes(laenge - 4));
    }
    return out;
  }

  test('Die Vorgabe des Servers wird übernommen und bestätigt', async () => {
    // Aktuelle Windows-Versionen geben 32 bpp vor. Bestätigt der Client eine
    // andere Farbtiefe, liefern sie überhaupt kein Bild.
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT, colorDepth: 32 });
    const port = await server.listen();

    const client = neuerClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      colorDepth: 16, // ausdrücklich etwas anderes anfragen
    });
    const bestaetigt = once(server, 'confirmActive');
    await client.connect();
    const [confirmActive] = await bestaetigt;

    const bitmapCap = capsAusConfirmActive(confirmActive as Buffer).get(0x02);
    assert.ok(bitmapCap, 'Bitmap Capability Set muss vorhanden sein');
    assert.equal(bitmapCap.readUInt16LE(0), 32, 'der Client muss 32 bpp zurückbestätigen');

    client.disconnect();
    server.close();
  });

  test('Eine niedrigere Vorgabe wird ebenso übernommen', async () => {
    const certificate = createTestCertificate();
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT, colorDepth: 16 });
    const port = await server.listen();

    const client = neuerClient({ host: '127.0.0.1', port, useNla: false, width: WIDTH, height: HEIGHT });
    const bestaetigt = once(server, 'confirmActive');
    await client.connect();
    const [confirmActive] = await bestaetigt;

    assert.equal(capsAusConfirmActive(confirmActive as Buffer).get(0x02)!.readUInt16LE(0), 16);

    client.disconnect();
    server.close();
  });
});

describe('Dynamische virtuelle Kanäle und Graphics Pipeline', () => {
  let certificate: { cert: string; key: string };

  before(() => {
    certificate = createTestCertificate();
  });

  /**
   * Sammelt die Nutzdaten, die der Client auf dem Grafikkanal schickt.
   *
   * Bewusst ohne ZGFX-Dekompression: die Huelle gehoert nur in die
   * Gegenrichtung (MS-RDPEGFX 3.2.5.1). Frueher hat dieser Sammler
   * dekomprimiert - dadurch waren die Tests gruen, waehrend der Client dem
   * echten Server zwei Bytes zu viel schickte und dessen Grafik-Subsystem
   * damit zum Absturz brachte. Ein Test, der die Annahme des Codes
   * nachspricht, prueft nichts.
   */
  class EgfxSammler {
    readonly nachrichten: Buffer[] = [];
    private readonly wartende: Array<() => void> = [];

    aufnehmen(data: Buffer): void {
      this.nachrichten.push(data);
      for (const wecken of this.wartende.splice(0)) wecken();
    }

    /** Wartet, bis mindestens `anzahl` Nachrichten eingetroffen sind. */
    async warteAuf(anzahl: number): Promise<Buffer[]> {
      while (this.nachrichten.length < anzahl) {
        await new Promise<void>((resolve) => this.wartende.push(resolve));
      }
      return this.nachrichten;
    }
  }

  interface Grafiksitzung {
    server: MockRdpServer;
    client: RdpClient;
    sammler: EgfxSammler;
  }

  /**
   * Baut eine Sitzung mit eingeschalteter Graphics Pipeline auf.
   *
   * Alle Ereignisse werden vor `connect()` abonniert: `connect()` kehrt schon
   * zurueck, sobald die Font List gesendet ist - die DVC-Aushandlung laeuft
   * erst danach und waere sonst schon vorbei, bevor jemand zuhoert.
   */
  async function grafikSitzung(kanaele: string[] = [GRAPHICS_CHANNEL_NAME]): Promise<Grafiksitzung> {
    const server = neuerServer({ ...certificate, width: WIDTH, height: HEIGHT, dynamicChannels: kanaele });
    const port = await server.listen();
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      enableGraphicsPipeline: true,
    });
    const sammler = new EgfxSammler();
    server.on('dvcData', (ereignis: DvcData) => {
      if (ereignis.name === GRAPHICS_CHANNEL_NAME) sammler.aufnehmen(ereignis.data);
    });
    await client.connect();
    return { server, client, sammler };
  }

  // ------------------------------------------------------- EGFX-Nachrichten

  /** Setzt den RDPGFX_HEADER (cmdId, flags, pduLength) vor einen Rumpf. */
  function egfxPdu(cmdId: number, body: Buffer): Buffer {
    return new BinaryWriter()
      .uint16le(cmdId)
      .uint16le(0)
      .uint32le(EGFX_HEADER_SIZE + body.length)
      .bytes(body)
      .toBuffer();
  }

  function resetGraphics(width: number, height: number): Buffer {
    const body = new BinaryWriter()
      .uint32le(width)
      .uint32le(height)
      .uint32le(1) // monitorCount
      .uint32le(0).uint32le(0).uint32le(width - 1).uint32le(height - 1)
      .uint32le(1) // TS_MONITOR_PRIMARY
      .toBuffer();
    // Das PDU ist auf 340 Byte aufzufuellen (MS-RDPEGFX 2.2.2.14).
    const fuellung = Buffer.alloc(340 - EGFX_HEADER_SIZE - body.length);
    return egfxPdu(RDPGFX_CMDID_RESETGRAPHICS, Buffer.concat([body, fuellung]));
  }

  function createSurface(surfaceId: number, width: number, height: number): Buffer {
    const body = new BinaryWriter()
      .uint16le(surfaceId)
      .uint16le(width)
      .uint16le(height)
      .uint8(PIXEL_FORMAT_XRGB_8888)
      .toBuffer();
    return egfxPdu(RDPGFX_CMDID_CREATESURFACE, body);
  }

  function mapSurfaceToOutput(surfaceId: number, x: number, y: number): Buffer {
    const body = new BinaryWriter()
      .uint16le(surfaceId)
      .uint16le(0) // reserved
      .uint32le(x)
      .uint32le(y)
      .toBuffer();
    return egfxPdu(RDPGFX_CMDID_MAPSURFACETOOUTPUT, body);
  }

  function startFrame(frameId: number): Buffer {
    return egfxPdu(RDPGFX_CMDID_STARTFRAME, new BinaryWriter().uint32le(0).uint32le(frameId).toBuffer());
  }

  function endFrame(frameId: number): Buffer {
    return egfxPdu(RDPGFX_CMDID_ENDFRAME, new BinaryWriter().uint32le(frameId).toBuffer());
  }

  /** RDPGFX_WIRE_TO_SURFACE_PDU_1 mit unkomprimierten Pixeln. */
  function wireToSurface(
    surfaceId: number,
    rect: { left: number; top: number; right: number; bottom: number },
    pixel: Buffer,
  ): Buffer {
    const body = new BinaryWriter()
      .uint16le(surfaceId)
      .uint16le(RDPGFX_CODECID_UNCOMPRESSED)
      .uint8(PIXEL_FORMAT_XRGB_8888)
      .uint16le(rect.left).uint16le(rect.top).uint16le(rect.right).uint16le(rect.bottom)
      .uint32le(pixel.length)
      .bytes(pixel)
      .toBuffer();
    return egfxPdu(RDPGFX_CMDID_WIRETOSURFACE_1, body);
  }

  /** Liest die angebotenen Capability-Sets aus einem RDPGFX_CAPS_ADVERTISE_PDU. */
  function capsSetsAusAdvertise(raw: Buffer): Array<{ version: number; flags: number }> {
    const r = new BinaryReader(raw);
    r.skip(EGFX_HEADER_SIZE);
    const anzahl = r.uint16le();
    const sets: Array<{ version: number; flags: number }> = [];
    for (let i = 0; i < anzahl; i++) {
      const version = r.uint32le();
      const laenge = r.uint32le();
      const daten = r.bytes(laenge);
      sets.push({ version, flags: laenge >= 4 ? daten.readUInt32LE(0) : 0 });
    }
    return sets;
  }

  // ------------------------------------------------------------------ Tests

  test('Der Client bestätigt die Kanaleröffnung, bevor er Nutzdaten schickt', async () => {
    // Regressionstest. Ein echter Server verwirft Nutzdaten auf einem Kanal,
    // dessen Annahme er noch nicht gesehen hat - das Ergebnis war ein schwarzer
    // Bildschirm ohne jede Fehlermeldung. Kippt die Reihenfolge im Client,
    // schlaegt dieser Test fehl.
    const { server, sammler } = await grafikSitzung();
    await sammler.warteAuf(1);

    const id = server.dynamicChannelIds.get(GRAPHICS_CHANNEL_NAME);
    assert.ok(id !== undefined, 'der Server muss den Grafikkanal eröffnet haben');
    const reihenfolge = server.empfangeneReihenfolge;
    const bestaetigung = reihenfolge.indexOf(`createResponse:${id}`);
    const nutzdaten = reihenfolge.indexOf(`data:${id}`);

    assert.ok(nutzdaten >= 0, `keine Nutzdaten empfangen: ${reihenfolge.join(', ')}`);
    // Eine fehlende Bestaetigung ist derselbe Fehler wie eine zu spaete: in
    // beiden Faellen trifft die Nutzlast auf einen Kanal, den der Server noch
    // nicht als angenommen fuehrt.
    assert.ok(
      bestaetigung >= 0 && bestaetigung < nutzdaten,
      `CREATE_RESPONSE muss vor den ersten Nutzdaten liegen, tatsächlich: [${reihenfolge.join(', ')}]`,
    );
  });

  test('Der Client verpackt seine EGFX-Nachrichten NICHT in ZGFX', async () => {
    // MS-RDPEGFX 3.2.5.1: Client -> Server ist "not encapsulated within any
    // external structure", Server -> Client dagegen RDP_SEGMENTED_DATA. Wer
    // hier symmetrisch verpackt, schiebt dem Server 0xE0 0x04 vor den
    // RDPGFX_HEADER; er liest das als cmdId/flags, die Laenge passt nicht mehr,
    // und er beendet die Sitzung mit ERRINFO_GRAPHICSSUBSYSTEMFAILED.
    const { sammler } = await grafikSitzung();
    const [erste] = await sammler.warteAuf(1);

    assert.notEqual(erste[0], 0xe0, 'kein RDP_SEGMENTED_DATA-Deskriptor davor');
    assert.equal(erste.readUInt16LE(0), RDPGFX_CMDID_CAPSADVERTISE, 'beginnt mit dem RDPGFX_HEADER');
    assert.equal(erste.readUInt16LE(2), 0, 'flags sind null');
    assert.equal(erste.readUInt32LE(4), erste.length, 'pduLength zaehlt die ganze Nachricht');
  });

  test('Der Client bestätigt eine DVC-Version, die er beherrscht', async () => {
    const server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      dynamicChannels: [GRAPHICS_CHANNEL_NAME],
      dvcVersion: 3,
    });
    const port = await server.listen();
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      enableGraphicsPipeline: true,
    });
    const antwort = once(server, 'dvcCapsResponse');
    await client.connect();
    const [caps] = (await antwort) as [DvcCapsResponse];

    // Der Client darf hoechstens die angebotene Version bestaetigen und muss
    // sich auf eine festlegen, die er auch sprechen kann.
    assert.ok(caps.version >= 1 && caps.version <= 3, `unerwartete DVC-Version ${caps.version}`);
  });

  test('Die Pipeline-Kanäle werden angenommen, fremde Kanäle abgelehnt', async () => {
    // Windows oeffnet Graphics, MouseCursor und CoreInput als Einheit. Wird
    // nur einer davon angenommen, scheitert das serverseitige Grafik-Subsystem
    // mit ERRINFO_GRAPHICSSUBSYSTEMFAILED - deshalb muessen alle drei durch.
    const MAUSZEIGER = 'Microsoft::Windows::RDS::MouseCursor';
    const FREMD = 'Contoso::Beispiel::Kanal';
    const server = neuerServer({
      ...certificate,
      width: WIDTH,
      height: HEIGHT,
      dynamicChannels: [GRAPHICS_CHANNEL_NAME, MAUSZEIGER, FREMD],
    });
    const port = await server.listen();
    const client = neuerClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      enableGraphicsPipeline: true,
    });

    const antworten = new Map<string, number>();
    const beide = new Promise<void>((resolve) => {
      server.on('dvcCreateResponse', (ereignis: DvcCreateResponse) => {
        antworten.set(ereignis.name, ereignis.status);
        if (antworten.size === 3) resolve();
      });
    });
    await client.connect();
    await beide;

    assert.equal(antworten.get(GRAPHICS_CHANNEL_NAME), DVC_CREATION_STATUS_OK);
    assert.equal(
      antworten.get(MAUSZEIGER),
      DVC_CREATION_STATUS_OK,
      'der Zeigerkanal gehört zum selben Stapel und muss mit angenommen werden',
    );
    assert.equal(
      antworten.get(FREMD),
      DVC_CREATION_STATUS_NO_LISTENER,
      'ein fremder Kanal ohne Zuhörer muss mit STATUS_NOT_SUPPORTED abgelehnt werden',
    );
  });

  test('Die erste Nutzlast ist ein CAPS_ADVERTISE ohne unhaltbare H.264-Zusage', async () => {
    const { sammler } = await grafikSitzung();
    const [erste] = await sammler.warteAuf(1);

    const pdus = parseEgfxPdus(erste);
    assert.equal(pdus.length, 1, 'die erste Nachricht enthält genau ein PDU');
    assert.equal(pdus[0].cmdId, RDPGFX_CMDID_CAPSADVERTISE);

    const sets = capsSetsAusAdvertise(erste);
    assert.ok(sets.length > 0, 'es muss mindestens ein Capability-Set angeboten werden');
    for (const set of sets) {
      // Ab V10 kehrt sich die Bedeutung um: ein *nicht* gesetztes AVC_DISABLED
      // sagt H.264 in YUV444 zu. Ohne Decoder waere das eine Zusage, die der
      // Client nicht halten kann - der Server liefert dann unlesbare Frames.
      if (set.version < RDPGFX_CAPVERSION_10) continue;
      assert.ok(
        (set.flags & RDPGFX_CAPS_FLAG_AVC_DISABLED) !== 0,
        `Version 0x${set.version.toString(16)} wird ohne AVC_DISABLED angeboten`,
      );
    }
  });

  test('Ein kompletter Frame erreicht die Anzeige mit den richtigen Pixeln', async () => {
    const { server, client, sammler } = await grafikSitzung();
    // Erst die Capability-Aushandlung abwarten: davor steht die Sitzung nicht.
    await sammler.warteAuf(1);

    const kacheln: DecodedBitmap[] = [];
    const zweiMalZwei = new Promise<DecodedBitmap>((resolve) => {
      client.on('bitmap', (tiles) => {
        kacheln.push(...tiles);
        const treffer = tiles.find((t) => t.width === 2 && t.height === 2);
        if (treffer) resolve(treffer);
      });
    });

    // Unkomprimierte EGFX-Pixel liegen als BGRA vor: rot, gruen / blau, weiss.
    const pixel = Buffer.from([
      0, 0, 255, 255,
      0, 255, 0, 255,
      255, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    server.sendDynamicChannelData(
      GRAPHICS_CHANNEL_NAME,
      Buffer.concat([
        resetGraphics(WIDTH, HEIGHT),
        createSurface(1, 8, 8),
        mapSurfaceToOutput(1, 100, 50),
        startFrame(7),
        wireToSurface(1, { left: 2, top: 3, right: 4, bottom: 5 }, pixel),
        endFrame(7),
      ]),
    );

    const kachel = await zweiMalZwei;
    assert.equal(kachel.x, 102, 'Ursprung der Ausgabe plus linke Kante des Zielrechtecks');
    assert.equal(kachel.y, 53);
    assert.deepEqual(
      [...kachel.rgba],
      [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255],
      'BGRA auf dem Draht muss als RGBA herauskommen',
    );
  });

  test('Nach dem ENDFRAME bestätigt der Client den Frame', async () => {
    const { server, sammler } = await grafikSitzung();
    await sammler.warteAuf(1);

    const frameId = 4711;
    server.sendDynamicChannelData(
      GRAPHICS_CHANNEL_NAME,
      Buffer.concat([
        createSurface(1, 4, 4),
        mapSurfaceToOutput(1, 0, 0),
        startFrame(frameId),
        endFrame(frameId),
      ]),
    );

    // Ohne Bestaetigung drosselt ein echter Server nach wenigen Frames.
    const nachrichten = await sammler.warteAuf(2);
    const bestaetigung = nachrichten[1];
    assert.equal(bestaetigung.readUInt16LE(0), RDPGFX_CMDID_FRAMEACKNOWLEDGE);
    // Auf dem Draht steht queueDepth vor frameId (MS-RDPEGFX 2.2.2.13).
    assert.equal(bestaetigung.readUInt32LE(EGFX_HEADER_SIZE + 4), frameId);
  });
});
