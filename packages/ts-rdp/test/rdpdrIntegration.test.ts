/**
 * Laufwerksumleitung gegen den Mock-Server: der vollstaendige Ablauf ueber
 * eine echte TLS-Verbindung, echtes MCS und echtes Chunking des statischen
 * Kanals.
 *
 * Der Unterschied zu rdpdrSession.test.ts ist der Weg: dort wird die
 * Zustandsmaschine direkt mit Puffern gefuettert, hier laufen dieselben PDUs
 * durch den Kanal - inklusive CHANNEL_PDU_HEADER, Zerlegung in Bloecke und
 * Zusammensetzen auf der Gegenseite. Genau daran faellt auf, wenn eine
 * Leseantwort die Blockgrenze nicht vertraegt.
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
  FILE_DIRECTORY_FILE,
  FILE_OPEN,
  FileBothDirectoryInformation,
  FileFsVolumeInformation,
  GENERIC_READ,
  GENERIC_WRITE,
  IRP_MJ_CLOSE,
  IRP_MJ_CREATE,
  IRP_MJ_DIRECTORY_CONTROL,
  IRP_MJ_QUERY_VOLUME_INFORMATION,
  IRP_MJ_READ,
  IRP_MN_QUERY_DIRECTORY,
  PAKID_CORE_CLIENTID_CONFIRM,
  PAKID_CORE_CLIENT_CAPABILITY,
  PAKID_CORE_CLIENT_NAME,
  PAKID_CORE_DEVICELIST_ANNOUNCE,
  PAKID_CORE_DEVICE_IOCOMPLETION,
  PAKID_CORE_DEVICE_IOREQUEST,
  PAKID_CORE_DEVICE_REPLY,
  PAKID_CORE_SERVER_ANNOUNCE,
  PAKID_CORE_SERVER_CAPABILITY,
  RDPDR_CHANNEL_DEF,
  RDPDR_CHANNEL_NAME,
  RDPDR_CTYP_CORE,
  RdpdrSession,
  STATUS_ACCESS_DENIED,
  STATUS_SUCCESS,
  buildRdpdrPdu,
  parseRdpdrPdu,
  type DateiEintrag,
  type RdpdrDateisystem,
} from '../src/protocol/rdpdr.js';

const WIDTH = 1024;
const HEIGHT = 768;
const DEVICE_ID = 1;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-rdpdr-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost',
  ]);
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

/** Ein kleines Dateisystem im Arbeitsspeicher. */
function testDateisystem(dateien: Record<string, string | null>): RdpdrDateisystem {
  const eintrag = (pfad: string): DateiEintrag => ({
    name: pfad.split('/').pop() ?? pfad,
    istVerzeichnis: dateien[pfad] === null,
    groesse: dateien[pfad]?.length ?? 0,
    erstellt: 1700000000000,
    geaendert: 1700000000000,
  });
  return {
    async stat(pfad) {
      return pfad in dateien ? eintrag(pfad) : undefined;
    },
    async liste(pfad) {
      const praefix = pfad === '' ? '' : pfad + '/';
      return Object.keys(dateien)
        .filter((p) => p.startsWith(praefix))
        .filter((p) => {
          const rest = p.substring(praefix.length);
          return rest !== '' && !rest.includes('/');
        })
        .map(eintrag);
    },
    async lies(pfad, offset, laenge) {
      const inhalt = dateien[pfad];
      if (typeof inhalt !== 'string') return Buffer.alloc(0);
      return Buffer.from(inhalt, 'utf8').subarray(offset, offset + laenge);
    },
  };
}

/**
 * Der Serverteil des Protokolls, so weit der Test ihn braucht.
 *
 * Er faehrt den Auftakt aus 3.3.5.1 (Announce, Capabilities, ClientId
 * Confirm, User Logged On), bestaetigt jede Geraeteankuendigung und laesst
 * sich einzelne I/O-Anfragen stellen.
 */
class ServerLaufwerk {
  readonly empfangen: { packetId: number; body: Buffer }[] = [];
  /** Antworten, nach CompletionId abgelegt. */
  readonly antworten = new Map<number, { status: number; rumpf: Buffer }>();
  /** Namen der Geraete, die der Client angekuendigt hat. */
  readonly geraete: { deviceId: number; name: string }[] = [];
  private naechsteCompletionId = 1;

  constructor(private readonly server: MockRdpServer) {
    server.on('staticChannelData', (e: { name: string; data: Buffer }) => {
      if (e.name !== RDPDR_CHANNEL_NAME) return;
      this.verarbeite(e.data);
    });
  }

  sende(daten: Buffer): void {
    this.server.sendStaticChannelData(RDPDR_CHANNEL_NAME, daten);
  }

  /** DR_CORE_SERVER_ANNOUNCE_REQ (2.2.2.2). */
  auftakt(versionMinor = 0x000c): void {
    const body = Buffer.alloc(8);
    body.writeUInt16LE(1, 0);
    body.writeUInt16LE(versionMinor, 2);
    body.writeUInt32LE(0x0000beef, 4);
    this.sende(buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_SERVER_ANNOUNCE, body));
  }

  /** DR_CORE_CAPABILITY_REQ mit General- und Drive-Satz (2.2.2.7). */
  faehigkeiten(): void {
    const general = Buffer.alloc(44);
    general.writeUInt16LE(0x0001, 0); // CAP_GENERAL_TYPE
    general.writeUInt16LE(44, 2);
    general.writeUInt32LE(2, 4); // GENERAL_CAPABILITY_VERSION_02
    general.writeUInt16LE(1, 16); // protocolMajorVersion
    general.writeUInt16LE(0x000c, 18); // protocolMinorVersion
    general.writeUInt32LE(0x0000ffff, 20); // ioCode1
    general.writeUInt32LE(0x00000007, 28); // extendedPDU
    const drive = Buffer.alloc(8);
    drive.writeUInt16LE(0x0004, 0); // CAP_DRIVE_TYPE
    drive.writeUInt16LE(8, 2);
    drive.writeUInt32LE(2, 4); // DRIVE_CAPABILITY_VERSION_02
    const kopf = Buffer.alloc(4);
    kopf.writeUInt16LE(2, 0);
    this.sende(buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_SERVER_CAPABILITY, Buffer.concat([kopf, general, drive])));
  }

  /** DR_CORE_SERVER_CLIENTID_CONFIRM (2.2.2.6). */
  bestaetigeClientId(clientId: number): void {
    const body = Buffer.alloc(8);
    body.writeUInt16LE(1, 0);
    body.writeUInt16LE(0x000c, 2);
    body.writeUInt32LE(clientId, 4);
    this.sende(buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_CLIENTID_CONFIRM, body));
  }

  /** Eine I/O-Anfrage stellen; liefert die CompletionId. */
  frage(fileId: number, major: number, minor: number, rest: Buffer): number {
    const completionId = this.naechsteCompletionId++;
    const kopf = Buffer.alloc(20);
    kopf.writeUInt32LE(DEVICE_ID, 0);
    kopf.writeUInt32LE(fileId, 4);
    kopf.writeUInt32LE(completionId, 8);
    kopf.writeUInt32LE(major, 12);
    kopf.writeUInt32LE(minor, 16);
    this.sende(buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_DEVICE_IOREQUEST, Buffer.concat([kopf, rest])));
    return completionId;
  }

  /** IRP_MJ_CREATE (2.2.1.4.1). */
  oeffne(pfad: string, opts: { access?: number; options?: number } = {}): number {
    const pfadBytes = Buffer.from(pfad + '\0', 'ucs2');
    const fest = Buffer.alloc(32);
    fest.writeUInt32LE((opts.access ?? GENERIC_READ) >>> 0, 0);
    fest.writeUInt32LE(0, 12); // FileAttributes
    fest.writeUInt32LE(0, 16); // SharedAccess
    fest.writeUInt32LE(FILE_OPEN, 20);
    fest.writeUInt32LE(opts.options ?? 0, 24);
    fest.writeUInt32LE(pfadBytes.length, 28);
    return this.frage(0, IRP_MJ_CREATE, 0, Buffer.concat([fest, pfadBytes]));
  }

  lies(fileId: number, offset: number, laenge: number): number {
    const b = Buffer.alloc(32);
    b.writeUInt32LE(laenge, 0);
    b.writeBigUInt64LE(BigInt(offset), 4);
    return this.frage(fileId, IRP_MJ_READ, 0, b);
  }

  schliesse(fileId: number): number {
    return this.frage(fileId, IRP_MJ_CLOSE, 0, Buffer.alloc(32));
  }

  blaettere(fileId: number, pfad: string, initial: boolean): number {
    const pfadBytes = Buffer.from(pfad + '\0', 'ucs2');
    const b = Buffer.alloc(32);
    b.writeUInt32LE(FileBothDirectoryInformation, 0);
    b.writeUInt8(initial ? 1 : 0, 4);
    b.writeUInt32LE(pfadBytes.length, 5);
    return this.frage(fileId, IRP_MJ_DIRECTORY_CONTROL, IRP_MN_QUERY_DIRECTORY, Buffer.concat([b, pfadBytes]));
  }

  volumen(fileId: number, klasse: number): number {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(klasse, 0);
    return this.frage(fileId, IRP_MJ_QUERY_VOLUME_INFORMATION, 0, b);
  }

  private verarbeite(daten: Buffer): void {
    const pdu = parseRdpdrPdu(daten);
    this.empfangen.push({ packetId: pdu.packetId, body: pdu.body });

    if (pdu.packetId === PAKID_CORE_DEVICELIST_ANNOUNCE) {
      const anzahl = pdu.body.readUInt32LE(0);
      let offset = 4;
      for (let i = 0; i < anzahl; i++) {
        const deviceId = pdu.body.readUInt32LE(offset + 4);
        const datenLaenge = pdu.body.readUInt32LE(offset + 16);
        const name = pdu.body.subarray(offset + 20, offset + 20 + datenLaenge).toString('utf8').replace(/\0+$/, '');
        this.geraete.push({ deviceId, name });
        offset += 20 + datenLaenge;
        // Jedes Geraet bekommt eine eigene Antwort (2.2.2.1).
        const antwort = Buffer.alloc(8);
        antwort.writeUInt32LE(deviceId, 0);
        antwort.writeUInt32LE(STATUS_SUCCESS, 4);
        this.sende(buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_DEVICE_REPLY, antwort));
      }
      return;
    }

    if (pdu.packetId === PAKID_CORE_DEVICE_IOCOMPLETION) {
      const completionId = pdu.body.readUInt32LE(4);
      this.antworten.set(completionId, {
        status: pdu.body.readUInt32LE(8),
        rumpf: pdu.body.subarray(12),
      });
      return;
    }

    if (pdu.packetId === PAKID_CORE_CLIENTID_CONFIRM) {
      // Die ClientId des Clients bestaetigen, wie ein Windows-Server es tut.
      this.bestaetigeClientId(pdu.body.readUInt32LE(4));
    }
  }

  hat(packetId: number): boolean {
    return this.empfangen.some((e) => e.packetId === packetId);
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

describe('Laufwerksumleitung über den Kanal rdpdr', () => {
  let certificate: { cert: string; key: string };

  before(() => {
    certificate = createTestCertificate();
  });

  /** Sitzung mit angemeldetem Kanal `rdpdr` und verdrahteten Gegenseiten. */
  async function sitzung(opts: { nurLesen?: boolean; laufwerke?: boolean; frueherAuftakt?: boolean } = {}) {
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
      extraStaticChannels: [RDPDR_CHANNEL_DEF],
    });
    offeneClients.push(client);

    const protokoll: string[] = [];
    const dateisystem = testDateisystem({
      repo: null,
      'repo/README.md': '# Ein Repository\n',
      'repo/gross.txt': 'x'.repeat(200000),
      'repo/src': null,
      'repo/src/index.ts': 'export const a = 1;\n',
    });

    const laufwerk = new RdpdrSession({
      send: (daten) => client.sendVirtualChannel(RDPDR_CHANNEL_NAME, daten),
      computerName: 'VSCODE',
      nurLesen: opts.nurLesen,
      log: (n) => protokoll.push(n),
      laufwerke: () =>
        opts.laufwerke === false ? [] : [{ deviceId: DEVICE_ID, name: 'Arbeitsbereich', dateisystem }],
    });

    client.on('staticChannelData', (e: { name: string; data: Buffer }) => {
      assert.equal(client.isConnected, true, 'Kanaldaten dürfen erst nach connect ankommen');
      if (e.name === RDPDR_CHANNEL_NAME) laufwerk.verarbeite(e.data);
    });

    const serverSeite = new ServerLaufwerk(server);
    if (opts.frueherAuftakt) server.once('clientInfo', () => serverSeite.auftakt());
    const verbunden = once(client, 'connect');
    await client.connect();
    await verbunden;
    return { client, server, laufwerk, serverSeite, protokoll };
  }

  test('Ein RDPDR-Auftakt vor der Aktivierung wird nach connect beantwortet', async () => {
    const { serverSeite, protokoll, laufwerk } = await sitzung({ frueherAuftakt: true });
    await warteAuf(() => serverSeite.hat(PAKID_CORE_CLIENT_NAME), 'frühe RDPDR-Antwort', 1000);
    serverSeite.faehigkeiten();
    await warteAuf(() => serverSeite.geraete.length === 1, 'Geräteliste');
    await warteAuf(() => protokoll.some(n => n.includes('ist im Explorer verfuegbar')), 'Gerätebestätigung');
    assert.equal(serverSeite.geraete[0]!.name, 'Arbeitsbereich');
    assert.deepEqual(laufwerk.diagnose, {
      serverAnnounce: true, capabilities: true, clientIdBestaetigt: true,
      freigabeLaeuft: false, listeVerarbeitet: true, laufwerke: 1,
    });
  });

  test('Der Handshake laeuft in der Reihenfolge aus 3.2.5.1 ab', async () => {
    const { serverSeite } = await sitzung();
    serverSeite.auftakt();
    await warteAuf(() => serverSeite.hat(PAKID_CORE_CLIENT_NAME), 'Client Name Request');

    // Erst Announce Reply, dann Rechnername - und nichts dazwischen.
    const reihenfolge = serverSeite.empfangen.map((e) => e.packetId);
    assert.deepEqual(reihenfolge.slice(0, 2), [PAKID_CORE_CLIENTID_CONFIRM, PAKID_CORE_CLIENT_NAME]);

    serverSeite.faehigkeiten();
    await warteAuf(() => serverSeite.hat(PAKID_CORE_CLIENT_CAPABILITY), 'Client Core Capability Response');
    await warteAuf(() => serverSeite.geraete.length > 0, 'Geräteliste');
    assert.deepEqual(serverSeite.geraete, [{ deviceId: DEVICE_ID, name: 'Arbeitsbereich' }]);
  });

  test('Der Rechnername kommt als nullterminiertes UTF-16 an', async () => {
    const { serverSeite } = await sitzung();
    serverSeite.auftakt();
    await warteAuf(() => serverSeite.hat(PAKID_CORE_CLIENT_NAME), 'Client Name Request');
    const nachricht = serverSeite.empfangen.find((e) => e.packetId === PAKID_CORE_CLIENT_NAME)!;
    assert.equal(nachricht.body.readUInt32LE(0), 1); // UnicodeFlag
    assert.equal(nachricht.body.readUInt32LE(4), 0); // CodePage MUSS null sein
    const laenge = nachricht.body.readUInt32LE(8);
    assert.equal(nachricht.body.subarray(12, 12 + laenge).toString('ucs2'), 'VSCODE\0');
  });

  /** Die Sitzung bis zur bestaetigten Geraeteliste bringen. */
  async function bisBereit(opts: { nurLesen?: boolean } = {}) {
    const stand = await sitzung(opts);
    stand.serverSeite.auftakt();
    stand.serverSeite.faehigkeiten();
    await warteAuf(() => stand.serverSeite.geraete.length > 0, 'Geräteliste');
    return stand;
  }

  test('Eine Datei laesst sich oeffnen, lesen und schliessen', async () => {
    const { serverSeite } = await bisBereit();
    const oeffnen = serverSeite.oeffne('\\repo\\README.md');
    await warteAuf(() => serverSeite.antworten.has(oeffnen), 'Create-Antwort');
    const antwort = serverSeite.antworten.get(oeffnen)!;
    assert.equal(antwort.status, STATUS_SUCCESS);
    const fileId = antwort.rumpf.readUInt32LE(0);

    const lesen = serverSeite.lies(fileId, 0, 4096);
    await warteAuf(() => serverSeite.antworten.has(lesen), 'Read-Antwort');
    const gelesen = serverSeite.antworten.get(lesen)!;
    assert.equal(gelesen.status, STATUS_SUCCESS);
    assert.equal(gelesen.rumpf.readUInt32LE(0), Buffer.byteLength('# Ein Repository\n'));
    assert.equal(gelesen.rumpf.subarray(4).toString('utf8'), '# Ein Repository\n');

    const schliessen = serverSeite.schliesse(fileId);
    await warteAuf(() => serverSeite.antworten.has(schliessen), 'Close-Antwort');
    assert.equal(serverSeite.antworten.get(schliessen)!.status, STATUS_SUCCESS);
  });

  test('Eine grosse Leseantwort ueberlebt die Zerlegung in Kanalbloecke', async () => {
    // Der Kanal zerlegt in Bloecke von 1600 Byte; 200000 Byte sind also gut
    // 125 Bloecke. Genau hier faellt auf, wenn CHANNEL_FLAG_FIRST/LAST oder
    // die Laengenangabe nicht stimmen.
    const { serverSeite } = await bisBereit();
    const oeffnen = serverSeite.oeffne('\\repo\\gross.txt');
    await warteAuf(() => serverSeite.antworten.has(oeffnen), 'Create-Antwort');
    const fileId = serverSeite.antworten.get(oeffnen)!.rumpf.readUInt32LE(0);

    const lesen = serverSeite.lies(fileId, 0, 200000);
    await warteAuf(() => serverSeite.antworten.has(lesen), 'grosse Read-Antwort', 20000);
    const gelesen = serverSeite.antworten.get(lesen)!;
    assert.equal(gelesen.status, STATUS_SUCCESS);
    assert.equal(gelesen.rumpf.readUInt32LE(0), 200000);
    assert.equal(gelesen.rumpf.subarray(4).length, 200000);
    assert.equal(gelesen.rumpf.subarray(4).every((b) => b === 0x78), true);
  });

  test('Ein Verzeichnis laesst sich durchblaettern', async () => {
    const { serverSeite } = await bisBereit();
    const oeffnen = serverSeite.oeffne('\\repo', { options: FILE_DIRECTORY_FILE });
    await warteAuf(() => serverSeite.antworten.has(oeffnen), 'Create-Antwort');
    const fileId = serverSeite.antworten.get(oeffnen)!.rumpf.readUInt32LE(0);

    const namen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = serverSeite.blaettere(fileId, '\\repo\\*', i === 0);
      await warteAuf(() => serverSeite.antworten.has(id), `Blättern ${i}`);
      const antwort = serverSeite.antworten.get(id)!;
      if (antwort.status !== STATUS_SUCCESS) break;
      const puffer = antwort.rumpf.subarray(4);
      namen.push(puffer.subarray(94, 94 + puffer.readUInt32LE(60)).toString('ucs2'));
    }
    assert.deepEqual(namen, ['.', '..', 'README.md', 'gross.txt', 'src']);
  });

  test('Die Volumenbezeichnung kommt beim Server an', async () => {
    const { serverSeite } = await bisBereit();
    const oeffnen = serverSeite.oeffne('\\', { options: FILE_DIRECTORY_FILE });
    await warteAuf(() => serverSeite.antworten.has(oeffnen), 'Create-Antwort');
    const fileId = serverSeite.antworten.get(oeffnen)!.rumpf.readUInt32LE(0);

    const id = serverSeite.volumen(fileId, FileFsVolumeInformation);
    await warteAuf(() => serverSeite.antworten.has(id), 'Volumen-Antwort');
    const puffer = serverSeite.antworten.get(id)!.rumpf.subarray(4);
    const laenge = puffer.readUInt32LE(12);
    assert.equal(puffer.subarray(17, 17 + laenge).toString('ucs2'), 'Arbeitsbereich');
  });

  test('Im Nur-Lesen-Betrieb wird schon das Oeffnen mit Schreibwunsch abgelehnt', async () => {
    const { serverSeite } = await bisBereit({ nurLesen: true });
    const id = serverSeite.oeffne('\\repo\\README.md', { access: GENERIC_WRITE });
    await warteAuf(() => serverSeite.antworten.has(id), 'Create-Antwort');
    assert.equal(serverSeite.antworten.get(id)!.status, STATUS_ACCESS_DENIED);
  });

  test('Ein Pfad-Fluchtversuch wird ueber den echten Kanal ebenso abgewiesen', async () => {
    const { serverSeite } = await bisBereit();
    const id = serverSeite.oeffne('\\..\\..\\etc\\passwd');
    await warteAuf(() => serverSeite.antworten.has(id), 'Create-Antwort');
    assert.equal(serverSeite.antworten.get(id)!.status, STATUS_ACCESS_DENIED);
  });

  test('Ohne freigegebene Laufwerke geht keine Geraeteliste hinaus', async () => {
    const stand = await sitzung({ laufwerke: false });
    stand.serverSeite.auftakt();
    stand.serverSeite.faehigkeiten();
    await warteAuf(
      () => stand.protokoll.some((n) => n.includes('keine Laufwerke freigegeben')),
      'Protokolleintrag',
    );
    assert.equal(stand.serverSeite.hat(PAKID_CORE_DEVICELIST_ANNOUNCE), false);
    // Und die Sitzung selbst laeuft weiter.
    assert.equal(stand.client.isConnected, true);
  });
});
