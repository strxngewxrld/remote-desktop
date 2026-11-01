/**
 * Verbindungsueberwachung: Probe, 'unresponsive'/'responsive' und Uhrensprung.
 * Zeit ist ueber `liveness.now` einstellbar; der Takt laeuft in echten, aber
 * sehr kurzen Intervallen gegen den Mock-Server.
 */
import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { RdpClient } from '../src/client.js';
import type { RdpClientOptions } from '../src/client.js';
import { MockRdpServer } from './mockServer.js';
import { BinaryWriter } from '../src/core/binary.js';
import { FASTPATH_UPDATETYPE_BITMAP } from '../src/protocol/constants.js';

function zertifikat(): { cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-live-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=ts-rdp-test'], { stdio: 'ignore' });
  return { cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8') };
}

/** Kleinstes gueltiges Bitmap-Update: irgendetwas, das beim Client Bytes ankommen laesst. */
function bitmap(): Buffer {
  const data = new BinaryWriter().uint16le(0x07e0).toBuffer();
  return new BinaryWriter()
    .uint16le(0x0001).uint16le(1)
    .uint16le(0).uint16le(0).uint16le(0).uint16le(0)
    .uint16le(1).uint16le(1).uint16le(16).uint16le(0)
    .uint16le(data.length).bytes(data)
    .toBuffer();
}

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Verbindungsueberwachung', () => {
  let cert: { cert: string; key: string };
  const server: MockRdpServer[] = [];
  const clients: RdpClient[] = [];
  before(() => {
    cert = zertifikat();
  });
  after(() => {
    for (const c of clients) c.disconnect();
    for (const s of server) s.close();
  });

  async function aufbau(opt: Partial<RdpClientOptions>, refreshRectSupport = true) {
    const s = new MockRdpServer({ ...cert, width: 800, height: 600, refreshRectSupport });
    server.push(s);
    const port = await s.listen();
    const c = new RdpClient({ host: '127.0.0.1', port, useNla: false, width: 800, height: 600, connectTimeout: 5000, ...opt });
    clients.push(c);
    c.on('error', () => {});
    const proben: number[] = [];
    s.on('refreshRect', () => proben.push(Date.now()));
    await c.connect();
    return { s, c, proben };
  }

  test('Stille loest eine Probe aus; schweigt der Server, folgt unresponsive, danach responsive', async () => {
    const { s, c, proben } = await aufbau({ liveness: { idleMs: 60, probeTimeoutMs: 80, tickMs: 10 } });
    const ereignisse: string[] = [];
    c.on('unresponsive', () => ereignisse.push('unresponsive'));
    c.on('responsive', () => ereignisse.push('responsive'));
    await once(c, 'unresponsive');
    assert.ok(proben.length >= 1, 'Probe wurde gesendet');
    s.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmap());
    await once(c, 'responsive');
    assert.deepEqual(ereignisse, ['unresponsive', 'responsive']);
  });

  test('Fliessen Daten, gibt es weder Probe noch Ereignis', async () => {
    // Grenze reichlich ueber dem Sendeabstand: unter Last verspaeten sich Timer,
    // und eine knappe Grenze loeste dann eine Probe aus. Der Lauf dauert
    // trotzdem mehr als dreimal so lange wie die Grenze.
    const { s, c, proben } = await aufbau({ liveness: { idleMs: 150, probeTimeoutMs: 40, tickMs: 10 } });
    let ereignis = false;
    c.on('unresponsive', () => (ereignis = true));
    for (let i = 0; i < 25; i++) {
      s.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmap());
      await warte(20);
    }
    assert.equal(ereignis, false);
    assert.equal(proben.length, 0);
  });

  test('Antwortet der Server auf die Probe, bleibt es still', async () => {
    const { s, c, proben } = await aufbau({ liveness: { idleMs: 50, probeTimeoutMs: 100, tickMs: 10 } });
    let ereignis = false;
    c.on('unresponsive', () => (ereignis = true));
    s.on('refreshRect', () => s.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmap()));
    await warte(400);
    assert.ok(proben.length >= 2);
    assert.equal(ereignis, false);
  });

  test('Ein Uhrensprung loest sofort eine Probe mit kurzem Zeitlimit aus', async () => {
    let versatz = 0;
    const { c, proben } = await aufbau({
      liveness: { idleMs: 60_000, probeTimeoutMs: 60_000, tickMs: 10, now: () => Date.now() + versatz },
    });
    const unresponsive = once(c, 'unresponsive');
    await warte(50);
    assert.equal(proben.length, 0);
    versatz = 30_000; // Ruhezustand
    await warte(60);
    assert.equal(proben.length, 1);
    // Das kurze Zeitlimit (3 s) wird ueber die Uhr erreicht, nicht ueber die Wartezeit.
    versatz = 40_000;
    await unresponsive;
  });

  test('Ohne Refresh Rect gibt es keine Probe und kein Ereignis', async () => {
    const { c, proben } = await aufbau({ liveness: { idleMs: 30, probeTimeoutMs: 30, tickMs: 10 } }, false);
    let ereignis = false;
    c.on('unresponsive', () => (ereignis = true));
    await warte(200);
    assert.equal(proben.length, 0);
    assert.equal(ereignis, false);
  });

  test('enabled: false schaltet die Ueberwachung ab', async () => {
    const { c, proben } = await aufbau({ liveness: { enabled: false, idleMs: 20, probeTimeoutMs: 20, tickMs: 10 } });
    let ereignis = false;
    c.on('unresponsive', () => (ereignis = true));
    await warte(150);
    assert.equal(proben.length, 0);
    assert.equal(ereignis, false);
  });
});
