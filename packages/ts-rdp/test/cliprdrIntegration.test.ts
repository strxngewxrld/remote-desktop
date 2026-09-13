/**
 * Zwischenablage gegen den Mock-Server: der vollstaendige Handshake und beide
 * Uebertragungsrichtungen ueber eine echte TLS-Verbindung, echtes MCS und
 * echtes Chunking des statischen Kanals.
 *
 * Der Unterschied zu cliprdr.test.ts ist der Weg: dort wird die
 * Zustandsmaschine direkt mit Puffern gefuettert, hier laufen dieselben PDUs
 * durch den Kanal - inklusive CHANNEL_PDU_HEADER, Zerlegung in Bloecke und
 * Zusammensetzen auf der Gegenseite.
 */
import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { RdpClient } from '../src/client.js';
import { MockRdpServer } from './mockServer.js';
import {
  CB_CLIP_CAPS,
  CB_FORMAT_DATA_REQUEST,
  CB_FORMAT_DATA_RESPONSE,
  CB_FORMAT_LIST,
  CB_FORMAT_LIST_RESPONSE,
  CB_RESPONSE_OK,
  buildFormatListResponse,
  CB_USE_LONG_FORMAT_NAMES,
  CF_UNICODETEXT,
  CLIPRDR_CHANNEL_DEF,
  CLIPRDR_CHANNEL_NAME,
  CliprdrSession,
  buildClipboardCapabilities,
  buildFormatDataRequest,
  buildFormatDataResponse,
  buildFormatList,
  buildMonitorReady,
  dekodiereUnicodeText,
  kodiereUnicodeText,
  parseClipboardCapabilities,
  parseCliprdrPdu,
  parseFormatDataRequest,
  parseFormatList,
} from '../src/protocol/cliprdr.js';

const WIDTH = 1024;
const HEIGHT = 768;

/** Alles, was ein Test geoeffnet hat - sonst haengt der Testlauf am Ende. */
const offeneServer: MockRdpServer[] = [];
const offeneClients: RdpClient[] = [];

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

/** Selbstsigniertes Zertifikat fuer den Mock-Server. */
function createTestCertificate(): { cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-clip-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost',
  ]);
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

/**
 * Der Serverteil des Protokolls, so weit der Test ihn braucht.
 *
 * Er haelt fest, was hereinkam, und antwortet wie ein Windows-Server: auf die
 * Formatliste des Clients mit einer Bestaetigung, auf eine Datenanfrage mit
 * dem eigenen Text.
 */
class ServerZwischenablage {
  readonly empfangen: { msgType: number; msgFlags: number; body: Buffer }[] = [];
  /** Was der Server in seiner Zwischenablage haelt. */
  text = '';
  clientCapsFlags = 0;

  constructor(
    private readonly server: MockRdpServer,
    private readonly langeNamen: boolean,
  ) {
    server.on('staticChannelData', (e: { name: string; data: Buffer }) => {
      if (e.name !== CLIPRDR_CHANNEL_NAME) return;
      this.verarbeite(e.data);
    });
  }

  /** Eine fertige CLIPRDR-Nachricht auf den Kanal geben. */
  sende(daten: Buffer): void {
    this.server.sendStaticChannelData(CLIPRDR_CHANNEL_NAME, daten);
  }

  /** Auftakt aus MS-RDPECLIP 1.3.2.1: erst die Faehigkeiten, dann Monitor Ready. */
  auftakt(): void {
    this.sende(buildClipboardCapabilities(this.langeNamen ? CB_USE_LONG_FORMAT_NAMES : 0));
    this.sende(buildMonitorReady());
  }

  /** Der Server hat kopiert. */
  kopiere(text: string): void {
    this.text = text;
    this.sende(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: this.langeNamen }));
  }

  /** Der Server fuegt ein und fragt den Text des Clients an. */
  frageAn(formatId = CF_UNICODETEXT): void {
    this.sende(buildFormatDataRequest(formatId));
  }

  letztes(msgType: number) {
    for (let i = this.empfangen.length - 1; i >= 0; i--) {
      if (this.empfangen[i].msgType === msgType) return this.empfangen[i];
    }
    return undefined;
  }

  private verarbeite(daten: Buffer): void {
    const pdu = parseCliprdrPdu(daten);
    this.empfangen.push({ msgType: pdu.msgType, msgFlags: pdu.msgFlags, body: pdu.body });
    switch (pdu.msgType) {
      case CB_CLIP_CAPS:
        this.clientCapsFlags = parseClipboardCapabilities(pdu.body).generalFlags;
        break;
      case CB_FORMAT_LIST:
        // Der Server bestaetigt jede Formatliste - genau wie Windows.
        this.sende(buildFormatListResponse(true));
        break;
      case CB_FORMAT_DATA_REQUEST: {
        const format = parseFormatDataRequest(pdu.body);
        if (format === CF_UNICODETEXT) this.sende(buildFormatDataResponse(kodiereUnicodeText(this.text)));
        break;
      }
    }
  }
}

/** Wartet, bis `pruefe()` zutrifft, oder laeuft in einen Zeitablauf. */
async function warteAuf(pruefe: () => boolean, was: string, ms = 5000): Promise<void> {
  const ende = Date.now() + ms;
  while (!pruefe()) {
    if (Date.now() > ende) throw new Error(`Zeitablauf beim Warten auf: ${was}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Zwischenablage über den Kanal cliprdr', () => {
  let certificate: { cert: string; key: string };

  before(() => {
    certificate = createTestCertificate();
  });

  /**
   * Sitzung mit angemeldetem Kanal `cliprdr`, verdrahteter CliprdrSession auf
   * der Clientseite und der Gegenseite auf dem Mock-Server.
   */
  async function sitzung(opts: { langeNamen?: boolean; richtung?: 'beide' | 'nurLesen' | 'nurSchreiben'; maxBytes?: number } = {}) {
    const server = new MockRdpServer({ ...certificate, width: WIDTH, height: HEIGHT });
    offeneServer.push(server);
    const port = await server.listen();
    const client = new RdpClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      colorDepth: 32,
      keyboardLayout: 0x409,
      clientName: 'test',
      rejectUnauthorized: false,
      extraStaticChannels: [CLIPRDR_CHANNEL_DEF],
    });
    offeneClients.push(client);

    /** Was die lokale Zwischenablage des Clients gerade enthaelt. */
    const lokal = { text: undefined as string | undefined };
    const uebernommen: string[] = [];
    const protokoll: string[] = [];

    const clip = new CliprdrSession({
      send: (daten) => client.sendVirtualChannel(CLIPRDR_CHANNEL_NAME, daten),
      richtung: opts.richtung,
      maxBytes: opts.maxBytes,
      leseLokalenText: () => lokal.text,
      onServerText: (t) => {
        lokal.text = t;
        uebernommen.push(t);
      },
      log: (m) => protokoll.push(m),
    });
    client.on('staticChannelData', (e) => {
      if (e.name === CLIPRDR_CHANNEL_NAME) clip.verarbeite(e.data);
    });

    const aktiviert = once(server, 'activated');
    await client.connect();
    await aktiviert;

    const gegenseite = new ServerZwischenablage(server, opts.langeNamen ?? true);
    return { server, client, clip, gegenseite, lokal, uebernommen, protokoll };
  }

  test('Der Handshake läuft in der Reihenfolge aus 1.3.2.1 ab', async () => {
    const { clip, gegenseite } = await sitzung();
    gegenseite.auftakt();

    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Caps und Formatliste des Clients');
    assert.deepEqual(
      gegenseite.empfangen.map((p) => p.msgType),
      [CB_CLIP_CAPS, CB_FORMAT_LIST],
    );
    assert.equal(gegenseite.clientCapsFlags, 0x0e); // Lange Namen, Dateistreams, keine absoluten Pfade.
    assert.equal(clip.istBereit, true);
    assert.equal(clip.langeFormatnamen, true);
  });

  test('Text vom Server landet in der lokalen Zwischenablage', async () => {
    const { gegenseite, uebernommen } = await sitzung();
    gegenseite.auftakt();
    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Handshake');

    gegenseite.kopiere('Vom Server\nmit zwei Zeilen');
    await warteAuf(() => uebernommen.length > 0, 'übernommener Text');
    // Der Server hat CR-LF geschickt, lokal steht LF.
    assert.deepEqual(uebernommen, ['Vom Server\nmit zwei Zeilen']);

    const anfrage = gegenseite.letztes(CB_FORMAT_DATA_REQUEST);
    assert.ok(anfrage, 'der Client muss die Daten angefragt haben');
    assert.equal(parseFormatDataRequest(anfrage.body), CF_UNICODETEXT);
  });

  test('Text vom Client landet beim Server, mit CR-LF und Nullzeichen', async () => {
    const { gegenseite, clip, lokal } = await sitzung();
    gegenseite.auftakt();
    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Handshake');

    lokal.text = 'Aus VS Code\nzweite Zeile';
    assert.equal(clip.melde(lokal.text), true);
    await warteAuf(() => gegenseite.empfangen.filter((p) => p.msgType === CB_FORMAT_LIST).length >= 2, 'Formatliste');

    const liste = parseFormatList(gegenseite.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true });
    assert.ok(liste.some((f) => f.formatId === CF_UNICODETEXT));

    gegenseite.frageAn(CF_UNICODETEXT);
    await warteAuf(() => gegenseite.letztes(CB_FORMAT_DATA_RESPONSE) !== undefined, 'Datenantwort');
    const antwort = gegenseite.letztes(CB_FORMAT_DATA_RESPONSE)!;
    assert.equal(antwort.msgFlags, CB_RESPONSE_OK);
    assert.equal(antwort.body.toString('hex'), kodiereUnicodeText('Aus VS Code\nzweite Zeile').toString('hex'));
    assert.equal(dekodiereUnicodeText(antwort.body), 'Aus VS Code\nzweite Zeile');
  });

  test('Ein Text über der Chunkgrenze wird zerlegt und kommt vollständig an', async () => {
    // 1600 Byte Nutzlast je Block: 4000 Zeichen ergeben gut 8000 Byte.
    const lang = 'ä'.repeat(4000);
    const { gegenseite, clip, lokal, server } = await sitzung();
    gegenseite.auftakt();
    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Handshake');

    lokal.text = lang;
    clip.melde(lang);
    gegenseite.frageAn(CF_UNICODETEXT);
    await warteAuf(() => gegenseite.letztes(CB_FORMAT_DATA_RESPONSE) !== undefined, 'Datenantwort');

    const antwort = gegenseite.letztes(CB_FORMAT_DATA_RESPONSE)!;
    assert.equal(dekodiereUnicodeText(antwort.body), lang);
    assert.ok(
      server.statischeBloecke.filter((b) => b.length > 8).length >= 6,
      'die Antwort muss über mehrere Blöcke gegangen sein',
    );
  });

  test('Server ohne Textformat: bestätigt, aber nichts angefragt', async () => {
    const { gegenseite, uebernommen } = await sitzung();
    gegenseite.auftakt();
    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Handshake');
    const vorher = gegenseite.empfangen.length;

    // Eine Formatliste ohne Textformat einspeisen.
    gegenseite.sende(buildFormatList([{ formatId: 49267, name: 'HTML Format' }], { longFormatNames: true }));
    await warteAuf(() => gegenseite.empfangen.length > vorher, 'Bestätigung');
    assert.equal(gegenseite.empfangen[vorher].msgType, CB_FORMAT_LIST_RESPONSE);
    assert.equal(gegenseite.letztes(CB_FORMAT_DATA_REQUEST), undefined);
    assert.deepEqual(uebernommen, []);
  });

  test('Kurze Formatnamen, wenn der Server keine langen anbietet', async () => {
    const { gegenseite, clip, lokal } = await sitzung({ langeNamen: false });
    gegenseite.auftakt();
    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Handshake');
    assert.equal(clip.langeFormatnamen, false);

    lokal.text = 'kurz';
    clip.melde('kurz');
    await warteAuf(() => gegenseite.empfangen.filter((p) => p.msgType === CB_FORMAT_LIST).length >= 2, 'Formatliste');
    assert.equal(gegenseite.letztes(CB_FORMAT_LIST)!.body.length, 2 * 36);
  });

  test('Die Größengrenze greift auch über den echten Kanal', async () => {
    const { gegenseite, uebernommen, protokoll } = await sitzung({ maxBytes: 512 });
    gegenseite.auftakt();
    await warteAuf(() => gegenseite.empfangen.length >= 2, 'Handshake');

    gegenseite.kopiere('x'.repeat(1000));
    await warteAuf(() => protokoll.some((z) => /ueberschreiten die Grenze/.test(z)), 'Verwerfmeldung');
    assert.deepEqual(uebernommen, [], 'zu großer Text darf die Zwischenablage nicht erreichen');
  });

  test('Ohne angemeldeten Kanal verhält sich alles wie bisher', async () => {
    // Die Rückfallebene: ein Server, der `cliprdr` nicht eröffnet. Es darf
    // keinen Fehler geben, nur einen Protokolleintrag.
    const server = new MockRdpServer({ ...certificate, width: WIDTH, height: HEIGHT });
    offeneServer.push(server);
    const port = await server.listen();
    const client = new RdpClient({
      host: '127.0.0.1',
      port,
      useNla: false,
      width: WIDTH,
      height: HEIGHT,
      colorDepth: 32,
      keyboardLayout: 0x409,
      clientName: 'test',
      rejectUnauthorized: false,
      // Kein extraStaticChannels: der Kanal existiert nicht.
    });
    offeneClients.push(client);
    const fehler: Error[] = [];
    client.on('error', (e) => fehler.push(e));
    const aktiviert = once(server, 'activated');
    await client.connect();
    await aktiviert;

    assert.equal(client.getStaticChannelId(CLIPRDR_CHANNEL_NAME), undefined);
    assert.equal(server.virtualChannelIds.get(CLIPRDR_CHANNEL_NAME), undefined);
    assert.equal(client.isConnected, true);
    assert.deepEqual(fehler, []);
    client.disconnect();
  });
});
