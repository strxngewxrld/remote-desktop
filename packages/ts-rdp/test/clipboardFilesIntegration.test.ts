/**
 * Dateien zum Server anbieten, gegen den Mock-Server: Formatliste,
 * FileGroupDescriptorW und CB_FILECONTENTS_* laufen ueber eine echte
 * TLS-Verbindung, echtes MCS und das Chunking des statischen Kanals.
 * (Portiert aus feat/clip-files, angepasst an CliprdrSession.meldeDateien.)
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
import { parseRemoteFileList, type ClipboardSink } from '../src/protocol/clipboardDownload.js';
import {
  CB_CLIP_CAPS,
  CB_FILECONTENTS_REQUEST,
  CB_FILECONTENTS_RESPONSE,
  CB_FORMAT_DATA_RESPONSE,
  CB_FORMAT_LIST,
  CB_FORMAT_LIST_RESPONSE,
  CB_FORMAT_DATA_REQUEST,
  CB_HUGE_FILE_SUPPORT_ENABLED,
  CB_RESPONSE_FAIL,
  CB_RESPONSE_OK,
  CB_STREAM_FILECLIP_ENABLED,
  CB_USE_LONG_FORMAT_NAMES,
  CLIPRDR_CHANNEL_DEF,
  CLIPRDR_CHANNEL_NAME,
  CliprdrSession,
  buildClipboardCapabilities,
  buildFormatList,
  buildFileList,
  buildFormatDataResponse,
  type ClipboardFileSource,
  buildCliprdrPdu,
  buildFormatDataRequest,
  buildFormatListResponse,
  buildMonitorReady,
  parseCliprdrPdu,
  parseFormatList,
} from '../src/protocol/cliprdr.js';

const offeneServer: MockRdpServer[] = [];
const offeneClients: RdpClient[] = [];
after(() => {
  for (const c of offeneClients.splice(0)) { try { c.disconnect(); } catch { /* egal */ } }
  for (const s of offeneServer.splice(0)) s.close();
});

function createTestCertificate(): { cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-clipfiles-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost']);
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

async function warteAuf(pruefe: () => boolean, was: string, ms = 5000): Promise<void> {
  const ende = Date.now() + ms;
  while (!pruefe()) {
    if (Date.now() > ende) throw new Error(`Zeitablauf beim Warten auf: ${was}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

class ServerSeite {
  beantworte?: (pdu: { msgType: number; body: Buffer }) => void;
  readonly empfangen: { msgType: number; msgFlags: number; body: Buffer }[] = [];
  constructor(private readonly server: MockRdpServer) {
    server.on('staticChannelData', (e: { name: string; data: Buffer }) => {
      if (e.name !== CLIPRDR_CHANNEL_NAME) return;
      const pdu = parseCliprdrPdu(e.data);
      this.empfangen.push({ msgType: pdu.msgType, msgFlags: pdu.msgFlags, body: pdu.body });
      if (pdu.msgType === CB_FORMAT_LIST) this.sende(buildFormatListResponse(true));
      this.beantworte?.(pdu);
    });
  }
  sende(d: Buffer): void { this.server.sendStaticChannelData(CLIPRDR_CHANNEL_NAME, d); }
  auftakt(dateien: boolean): void {
    this.sende(buildClipboardCapabilities(CB_USE_LONG_FORMAT_NAMES | (dateien ? CB_STREAM_FILECLIP_ENABLED | CB_HUGE_FILE_SUPPORT_ENABLED : 0)));
    this.sende(buildMonitorReady());
  }
  anzahl(msgType: number): number { return this.empfangen.filter((p) => p.msgType === msgType).length; }
  letzte(msgType: number) { return this.empfangen.filter((p) => p.msgType === msgType).at(-1); }
  dateiAnfrage(streamId: number, lindex: number, flags: number, offset: number, count: number, high = 0): void {
    const b = Buffer.alloc(24);
    [streamId, lindex, flags, offset, high, count].forEach((n, i) => b.writeUInt32LE(n, i * 4));
    this.sende(buildCliprdrPdu(CB_FILECONTENTS_REQUEST, 0, b));
  }
  antwort(streamId: number) {
    return this.empfangen.find((p) => p.msgType === CB_FILECONTENTS_RESPONSE && p.body.readUInt32LE(0) === streamId);
  }
}

describe('Dateien zum Server über den Kanal cliprdr', () => {
  let certificate: { cert: string; key: string };
  before(() => { certificate = createTestCertificate(); });

  async function sitzung(serverKannDateien = true) {
    const server = new MockRdpServer({ ...certificate, width: 1024, height: 768 });
    offeneServer.push(server);
    const port = await server.listen();
    const client = new RdpClient({
      host: '127.0.0.1', port, useNla: false, width: 1024, height: 768, colorDepth: 32,
      keyboardLayout: 0x409, clientName: 'test', rejectUnauthorized: false,
      extraStaticChannels: [CLIPRDR_CHANNEL_DEF],
    });
    offeneClients.push(client);
    const clip = new CliprdrSession({ send: (d) => client.sendVirtualChannel(CLIPRDR_CHANNEL_NAME, d) });
    client.on('staticChannelData', (e) => { if (e.name === CLIPRDR_CHANNEL_NAME) clip.verarbeite(e.data); });
    const aktiviert = once(server, 'activated');
    await client.connect();
    await aktiviert;
    const gegenseite = new ServerSeite(server);
    gegenseite.auftakt(serverKannDateien);
    await warteAuf(() => gegenseite.anzahl(CB_CLIP_CAPS) > 0, 'Client-Caps');
    return { clip, gegenseite };
  }

  test('Der Client kündigt Dateien an, liefert Deskriptor, Größe und Bereiche', async () => {
    const { clip, gegenseite } = await sitzung();
    const inhalt = Buffer.from('Hallo Dateien über den Kanal');
    const vorher = gegenseite.anzahl(CB_FORMAT_LIST);
    assert.equal(clip.meldeDateien([{ name: 'gruss.txt', data: inhalt }]), true);
    await warteAuf(() => gegenseite.anzahl(CB_FORMAT_LIST) > vorher, 'Formatliste');
    const formate = parseFormatList(gegenseite.letzte(CB_FORMAT_LIST)!.body, { longFormatNames: true });
    assert.equal(formate.length, 1);
    assert.equal(formate[0].name, 'FileGroupDescriptorW');

    gegenseite.sende(buildFormatDataRequest(formate[0].formatId));
    await warteAuf(() => gegenseite.anzahl(CB_FORMAT_DATA_RESPONSE) > 0, 'Dateiliste');
    const liste = gegenseite.letzte(CB_FORMAT_DATA_RESPONSE)!.body;
    assert.equal(liste.readUInt32LE(0), 1);
    assert.equal(liste.readUInt32LE(4 + 68), inhalt.length);

    gegenseite.dateiAnfrage(1, 0, 1, 0, 8);
    await warteAuf(() => !!gegenseite.antwort(1), 'Größe');
    assert.equal(gegenseite.antwort(1)!.msgFlags, CB_RESPONSE_OK);
    assert.equal(gegenseite.antwort(1)!.body.readBigUInt64LE(4), BigInt(inhalt.length));

    gegenseite.dateiAnfrage(2, 0, 2, 6, 8);
    await warteAuf(() => !!gegenseite.antwort(2), 'Bereich');
    assert.equal(gegenseite.antwort(2)!.body.subarray(4).toString(), 'Dateien ');
  });

  test('Eine große Datei kommt blockweise über den Kanal und heil an', async () => {
    const { clip, gegenseite } = await sitzung();
    const gross = Buffer.alloc(300_000);
    for (let i = 0; i < gross.length; i++) gross[i] = (i * 31 + 7) & 0xff;
    assert.equal(clip.meldeDateien([{ name: 'gross.bin', data: gross }]), true);
    const BLOCK = 64 * 1024;
    const teile: Buffer[] = [];
    let id = 100;
    for (let off = 0; off < gross.length; off += BLOCK) {
      const mine = id++;
      gegenseite.dateiAnfrage(mine, 0, 2, off, BLOCK);
      await warteAuf(() => !!gegenseite.antwort(mine), `Block ${off}`);
      assert.equal(gegenseite.antwort(mine)!.msgFlags, CB_RESPONSE_OK);
      teile.push(gegenseite.antwort(mine)!.body.subarray(4));
    }
    assert.ok(Buffer.concat(teile).equals(gross));
  });

  test('Mehrere Dateien werden über lindex getrennt, ungültige Anfragen abgelehnt', async () => {
    const { clip, gegenseite } = await sitzung();
    clip.meldeDateien([{ name: 'a.txt', data: Buffer.from('AAA') }, { name: 'b.txt', data: Buffer.from('BBBB') }]);
    gegenseite.dateiAnfrage(1, 1, 2, 0, 16);
    gegenseite.dateiAnfrage(2, 7, 2, 0, 16); // lindex ausserhalb
    gegenseite.dateiAnfrage(3, 0, 3, 0, 8); // SIZE|RANGE zugleich
    await warteAuf(() => !!gegenseite.antwort(1) && !!gegenseite.antwort(2) && !!gegenseite.antwort(3), 'Antworten');
    assert.equal(gegenseite.antwort(1)!.body.subarray(4).toString(), 'BBBB');
    assert.equal(gegenseite.antwort(2)!.msgFlags, CB_RESPONSE_FAIL);
    assert.equal(gegenseite.antwort(3)!.msgFlags, CB_RESPONSE_FAIL);
  });

  test('Ordner mit Zeitstempel und eine 5-GiB-Datei zum Server: Deskriptor und Bereich mit 64-Bit-Offset', async () => {
    const { clip, gegenseite } = await sitzung();
    const zeit = new Date('2024-06-07T08:09:10.000Z');
    const GiB = 1024 ** 3;
    const muster = (o: number, l: number) => Buffer.from(Array.from({ length: l }, (_, i) => (o + i) & 0xff));
    const quellen: ClipboardFileSource[] = [
      { name: 'Ordner', directory: true, size: 0, lastWriteTime: zeit, read: async () => Buffer.alloc(0) },
      { name: 'Ordner/Leer', directory: true, size: 0, read: async () => Buffer.alloc(0) },
      { name: 'Ordner/riesig.bin', size: 5 * GiB + 16, lastWriteTime: zeit, read: async (o, l) => muster(o, l) },
    ];
    assert.equal(clip.meldeDateien(quellen, 6 * GiB), true);
    gegenseite.sende(buildFormatDataRequest(0xc001));
    await warteAuf(() => gegenseite.anzahl(CB_FORMAT_DATA_RESPONSE) > 0, 'Dateiliste');
    const liste = parseRemoteFileList(gegenseite.letzte(CB_FORMAT_DATA_RESPONSE)!.body);
    assert.deepEqual(liste.map((e) => [e.name, e.directory, e.size]), [['Ordner', true, 0], ['Ordner/Leer', true, 0], ['Ordner/riesig.bin', false, 5 * GiB + 16]]);
    assert.equal(liste[0].lastWriteTime?.getTime(), zeit.getTime());
    assert.equal(liste[2].lastWriteTime?.getTime(), zeit.getTime());

    gegenseite.dateiAnfrage(1, 2, 1, 0, 8);
    await warteAuf(() => !!gegenseite.antwort(1), 'Groesse');
    assert.equal(gegenseite.antwort(1)!.body.readBigUInt64LE(4), BigInt(5 * GiB + 16));
    gegenseite.dateiAnfrage(2, 2, 2, 0, 16, 1); // Offset 4 GiB
    await warteAuf(() => !!gegenseite.antwort(2), 'Bereich ueber 4 GiB');
    assert.ok(gegenseite.antwort(2)!.body.subarray(4).equals(muster(4 * GiB, 16)));
  });

  test('Ordner mit Zeitstempel vom Server in eine Senke streamen', async () => {
    const { clip, gegenseite } = await sitzung();
    const zeit = new Date('2020-02-03T04:05:06.000Z');
    const inhalt = Buffer.from('Inhalt der Datei im Unterordner');
    const liste = buildFileList([
      { name: 'Wurzel', directory: true, size: 0, lastWriteTime: zeit, read: async () => Buffer.alloc(0) },
      { name: 'Wurzel/Leer', directory: true, size: 0, read: async () => Buffer.alloc(0) },
      { name: 'Wurzel/a.txt', size: inhalt.length, lastWriteTime: zeit, read: async () => inhalt },
    ]);
    // Der Mock-Server antwortet auf Listen- und Inhaltsanfragen des Clients.
    gegenseite.beantworte = (pdu) => {
      if (pdu.msgType === CB_FORMAT_DATA_REQUEST) gegenseite.sende(buildFormatDataResponse(liste));
      if (pdu.msgType === CB_FILECONTENTS_REQUEST) {
        const o = pdu.body.readUInt32LE(12), n = pdu.body.readUInt32LE(20);
        gegenseite.sende(buildCliprdrPdu(CB_FILECONTENTS_RESPONSE, CB_RESPONSE_OK, Buffer.concat([pdu.body.subarray(0, 4), inhalt.subarray(o, o + n)])));
      }
    };
    gegenseite.sende(buildFormatList([{ formatId: 0xd001, name: 'FileGroupDescriptorW' }], { longFormatNames: true }));
    await warteAuf(() => gegenseite.anzahl(CB_FORMAT_LIST_RESPONSE) > 0, 'Antwort auf Formatliste');
    const ereignisse: string[] = []; const chunks: Buffer[] = [];
    const sink: ClipboardSink = {
      directory: (e) => { ereignisse.push(`dir ${e.name} ${e.lastWriteTime?.getTime()}`); },
      file: (e) => ({ write: (ch) => { chunks.push(ch); }, close: () => { ereignisse.push(`file ${e.name} ${e.lastWriteTime?.getTime()}`); } }),
    };
    await clip.streamServerFiles(sink, 1024);
    assert.deepEqual(ereignisse, [`dir Wurzel ${zeit.getTime()}`, 'dir Wurzel/Leer undefined', `file Wurzel/a.txt ${zeit.getTime()}`]);
    assert.ok(Buffer.concat(chunks).equals(inhalt));
  });

  test('Kann der Server keine Dateien, wird nichts angekündigt', async () => {
    const { clip, gegenseite } = await sitzung(false);
    const vorher = gegenseite.anzahl(CB_FORMAT_LIST);
    assert.equal(clip.meldeDateien([{ name: 'a.txt', data: Buffer.from('x') }]), false);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gegenseite.anzahl(CB_FORMAT_LIST), vorher);
  });
});
