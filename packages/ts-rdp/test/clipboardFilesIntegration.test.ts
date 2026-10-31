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
import {
  CB_CLIP_CAPS,
  CB_FILECONTENTS_REQUEST,
  CB_FILECONTENTS_RESPONSE,
  CB_FORMAT_DATA_RESPONSE,
  CB_FORMAT_LIST,
  CB_RESPONSE_FAIL,
  CB_RESPONSE_OK,
  CB_STREAM_FILECLIP_ENABLED,
  CB_USE_LONG_FORMAT_NAMES,
  CLIPRDR_CHANNEL_DEF,
  CLIPRDR_CHANNEL_NAME,
  CliprdrSession,
  buildClipboardCapabilities,
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
  readonly empfangen: { msgType: number; msgFlags: number; body: Buffer }[] = [];
  constructor(private readonly server: MockRdpServer) {
    server.on('staticChannelData', (e: { name: string; data: Buffer }) => {
      if (e.name !== CLIPRDR_CHANNEL_NAME) return;
      const pdu = parseCliprdrPdu(e.data);
      this.empfangen.push({ msgType: pdu.msgType, msgFlags: pdu.msgFlags, body: pdu.body });
      if (pdu.msgType === CB_FORMAT_LIST) this.sende(buildFormatListResponse(true));
    });
  }
  sende(d: Buffer): void { this.server.sendStaticChannelData(CLIPRDR_CHANNEL_NAME, d); }
  auftakt(dateien: boolean): void {
    this.sende(buildClipboardCapabilities(CB_USE_LONG_FORMAT_NAMES | (dateien ? CB_STREAM_FILECLIP_ENABLED : 0)));
    this.sende(buildMonitorReady());
  }
  anzahl(msgType: number): number { return this.empfangen.filter((p) => p.msgType === msgType).length; }
  letzte(msgType: number) { return this.empfangen.filter((p) => p.msgType === msgType).at(-1); }
  dateiAnfrage(streamId: number, lindex: number, flags: number, offset: number, count: number): void {
    const b = Buffer.alloc(24);
    [streamId, lindex, flags, offset, 0, count].forEach((n, i) => b.writeUInt32LE(n, i * 4));
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

  test('Kann der Server keine Dateien, wird nichts angekündigt', async () => {
    const { clip, gegenseite } = await sitzung(false);
    const vorher = gegenseite.anzahl(CB_FORMAT_LIST);
    assert.equal(clip.meldeDateien([{ name: 'a.txt', data: Buffer.from('x') }]), false);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gegenseite.anzahl(CB_FORMAT_LIST), vorher);
  });
});
