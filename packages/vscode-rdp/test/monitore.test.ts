/**
 * Weitere Monitore: Zuordnung der Desktopbereiche und der Weg durch die
 * Sitzung - Button, eigenes Panel, Anordnung beim Server, Kacheln je Panel.
 */
import {
  ExtensionContext,
  WebviewPanel,
  einstellungen,
  notizen,
  window as fensterAttrappe,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockRdpServer, type DvcData } from './ts-rdp-quelle/test/mockServer.js';
import { BinaryWriter, edisp } from 'ts-rdp';
import { RdpSession } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import { secretKey } from '../src/connections.js';
import type { RdpConnection } from '../src/connections.js';
import { bereicheAusServer, schneidet } from '../src/monitore.js';

const DISPLAY_CONTROL = edisp.DISPLAY_CONTROL_CHANNEL_NAME;

// ------------------------------------------------------------ Reine Rechnung

describe('Monitore - Bereiche aus der Antwort des Servers', () => {
  test('Die Monitorliste des Servers gilt, der primaere zuerst', () => {
    const bereiche = bereicheAusServer(
      2304,
      800,
      [
        { left: 1280, top: 0, right: 2303, bottom: 767, flags: 0 },
        { left: 0, top: 0, right: 1279, bottom: 799, flags: 1 },
      ],
      [],
    );
    assert.deepEqual(bereiche, [
      { x: 0, y: 0, width: 1280, height: 800 },
      { x: 1280, y: 0, width: 1024, height: 768 },
    ]);
  });

  test('Negative Koordinaten verschieben sich auf den Desktopursprung', () => {
    // Ein Monitor links vom primaeren: der Desktop beginnt bei ihm.
    const bereiche = bereicheAusServer(
      2000,
      600,
      [
        { left: 0, top: 0, right: 999, bottom: 599, flags: 1 },
        { left: -1000, top: 0, right: -1, bottom: 599, flags: 0 },
      ],
      [],
    );
    assert.deepEqual(bereiche, [
      { x: 1000, y: 0, width: 1000, height: 600 },
      { x: 0, y: 0, width: 1000, height: 600 },
    ]);
  });

  test('Ohne Monitorliste wird der eigenen Anfrage nur bei passender Groesse geglaubt', () => {
    const angefragt = [
      { width: 1024, height: 768 },
      { width: 801, height: 600 },
    ];
    assert.deepEqual(bereicheAusServer(1824, 768, undefined, angefragt), [
      { x: 0, y: 0, width: 1024, height: 768 },
      { x: 1024, y: 0, width: 800, height: 600 },
    ]);
    // Der Server hat die Anordnung nicht uebernommen: alles gehoert dem primaeren.
    assert.deepEqual(bereicheAusServer(1024, 768, undefined, angefragt), [{ x: 0, y: 0, width: 1024, height: 768 }]);
  });

  test('Kacheln auf der Grenze schneiden beide Bereiche', () => {
    const links = { x: 0, y: 0, width: 100, height: 100 };
    const rechts = { x: 100, y: 0, width: 100, height: 100 };
    const grenze = { x: 95, y: 10, w: 10, h: 10 };
    assert.equal(schneidet(grenze, links), true);
    assert.equal(schneidet(grenze, rechts), true);
    assert.equal(schneidet({ x: 100, y: 0, w: 5, h: 5 }, links), false, 'die rechte Kante gehoert nicht dazu');
  });
});

// ----------------------------------------------------------------- Sitzung

function erzeugeTestzertifikat(): { cert: string; key: string; ordner: string } {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-rdp-monitor-'));
  const certPfad = path.join(ordner, 'cert.pem');
  const keyPfad = path.join(ordner, 'key.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPfad, '-out', certPfad,
     '-days', '2', '-subj', '/CN=vscode-rdp-test'],
    { stdio: 'ignore' },
  );
  return { cert: fs.readFileSync(certPfad, 'utf8'), key: fs.readFileSync(keyPfad, 'utf8'), ordner };
}

async function warteBis(bedingung: () => boolean, was: string, frist = 15000): Promise<void> {
  const ende = Date.now() + frist;
  for (;;) {
    if (bedingung()) return;
    if (Date.now() > ende) throw new Error(`Zeitueberschreitung beim Warten auf: ${was}`);
    await new Promise((weiter) => setTimeout(weiter, 5));
  }
}

function nachrichten<T = any>(panel: WebviewPanel, typ: string): T[] {
  return panel.webview.gesendet.filter((n) => (n as { type?: string })?.type === typ) as T[];
}

/** Ein unkomprimiertes 16-bpp-Bitmap-Update; je Kachel eine Farbe. */
function bitmapUpdate(kacheln: { x: number; y: number; w: number; h: number }[]): Buffer {
  const w = new BinaryWriter().uint16le(0x0001).uint16le(kacheln.length);
  for (const k of kacheln) {
    const pixel = Buffer.alloc(k.w * k.h * 2, 0x1f);
    w.uint16le(k.x).uint16le(k.y).uint16le(k.x + k.w - 1).uint16le(k.y + k.h - 1)
      .uint16le(k.w).uint16le(k.h).uint16le(16).uint16le(0).uint16le(pixel.length).bytes(pixel);
  }
  return w.toBuffer();
}

let zertifikat: { cert: string; key: string; ordner: string };
const offen: { server: MockRdpServer; sitzung?: RdpSession }[] = [];

before(() => {
  zertifikat = erzeugeTestzertifikat();
});

after(() => {
  fs.rmSync(zertifikat.ordner, { recursive: true, force: true });
});

beforeEach(() => {
  zuruecksetzen();
  einstellungen.set('rdp.certificateTrust', 'ignore');
  einstellungen.set('rdp.connectTimeout', 10000);
  einstellungen.set('rdp.dynamicResolution', true);
});

afterEach(async () => {
  for (const { server, sitzung } of offen.splice(0)) {
    sitzung?.dispose();
    server.close();
  }
  await new Promise((weiter) => setTimeout(weiter, 20));
});

/** Sitzung gegen einen Server mit Display Control und `maxNumMonitors` Monitoren. */
async function starte(maxNumMonitors = 4, mitKanal = true) {
  const server = new MockRdpServer({
    cert: zertifikat.cert,
    key: zertifikat.key,
    width: 1024,
    height: 768,
    dynamicChannels: mitKanal ? [DISPLAY_CONTROL] : [],
  });
  const eintrag: { server: MockRdpServer; sitzung?: RdpSession } = { server };
  offen.push(eintrag);
  const port = await server.listen();
  const layouts: edisp.MonitorLayout[][] = [];
  server.on('dvcData', (e: DvcData) => {
    if (e.name === DISPLAY_CONTROL) layouts.push(edisp.parseMonitorLayoutPdu(e.data));
  });

  const kontext = new ExtensionContext();
  const ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  const verbindung: RdpConnection = { name: 'Mehrfach', host: '127.0.0.1', port, username: 'tester' };
  await kontext.secrets.store(secretKey(verbindung), 'geheim');
  const sitzung = await RdpSession.open(kontext, verbindung, ausgabe, new CertificateTrustStore(kontext));
  eintrag.sitzung = sitzung;
  const panel = notizen.panels.at(-1)!;
  panel.webview.vomWebview({ type: 'ready', width: 1024, height: 768, devicePixelRatio: 1 });
  await warteBis(() => sitzung.isConnected && nachrichten(panel, 'init').length > 0, 'verbundene Sitzung');
  if (mitKanal) {
    await warteBis(() => server.dynamicChannelIds.has(DISPLAY_CONTROL), 'Display-Control-Kanal');
    server.sendDynamicChannelData(
      DISPLAY_CONTROL,
      edisp.buildCapsPdu({ maxNumMonitors, maxMonitorAreaFactorA: 8192, maxMonitorAreaFactorB: 8192 }),
    );
    await warteBis(() => ausgabe.zeilen.some((z) => z.includes('Monitore')), 'CAPS beim Client');
  }
  return { server, sitzung, panel, ausgabe, layouts };
}

describe('Monitore - weiterer Monitor in der Sitzung', () => {
  test('Ein weiterer Monitor bekommt ein eigenes Panel in einem eigenen Fenster', async () => {
    const { sitzung, panel, layouts, server } = await starte();
    await sitzung.monitorHinzufuegen();

    const zweites = notizen.panels.at(-1)!;
    assert.notEqual(zweites, panel);
    assert.equal(zweites.viewType, 'rdpMonitor');
    assert.ok(zweites.title.includes('Monitor 2'), zweites.title);
    assert.ok(notizen.ausgefuehrt.some((a) => a.befehl === 'workbench.action.moveEditorToNewWindow'));
    assert.equal(sitzung.monitorAnzahl, 2);

    // Erst mit der Groesse des neuen Panels geht die Anordnung hinaus.
    zweites.webview.vomWebview({ type: 'ready', width: 800, height: 600, devicePixelRatio: 1 });
    await warteBis(() => layouts.some((l) => l.length === 2), 'Anordnung mit zwei Monitoren');
    const anordnung = layouts.find((l) => l.length === 2)!;
    assert.deepEqual(
      anordnung.map((m) => [m.left, m.top, m.width, m.height]),
      [
        [0, 0, 1024, 768],
        [1024, 0, 800, 600],
      ],
    );

    // Der Server richtet den breiteren Desktop ein (klassischer Weg, ohne Monitorliste).
    (server as unknown as { opts: { width: number; height: number } }).opts.width = 1824;
    server.reactivate();
    await warteBis(() => nachrichten(zweites, 'init').some((i) => i.originX === 1024), 'init fuer Monitor 2');
    const init = nachrichten(zweites, 'init').at(-1);
    assert.equal(init.width, 800);
    assert.equal(init.height, 600);
    const primaer = nachrichten(panel, 'init').at(-1);
    assert.equal(primaer.width, 1024, 'das Sitzungspanel zeigt nur seinen eigenen Teil');

    // Kacheln gehen nur dorthin, wo sie zu sehen sind; die auf der Grenze an beide.
    const vorherA = nachrichten(panel, 'bitmap').length;
    const vorherB = nachrichten(zweites, 'bitmap').length;
    server.sendFastpathUpdate(0x0001, bitmapUpdate([
      { x: 10, y: 10, w: 4, h: 4 },
      { x: 1100, y: 10, w: 4, h: 4 },
      { x: 1022, y: 10, w: 4, h: 4 },
    ]));
    await warteBis(
      () => nachrichten(panel, 'bitmap').length > vorherA && nachrichten(zweites, 'bitmap').length > vorherB,
      'Kacheln in beiden Panels',
    );
    const xs = (p: WebviewPanel, ab: number) =>
      nachrichten<{ rects: { x: number }[] }>(p, 'bitmap').slice(ab).flatMap((n) => n.rects.map((r) => r.x)).sort((a, b) => a - b);
    assert.deepEqual(xs(panel, vorherA), [10, 1022]);
    assert.deepEqual(xs(zweites, vorherB), [1022, 1100]);
  });

  test('Mauseingaben vom zweiten Monitor gehen unveraendert an den Server', async () => {
    const { sitzung } = await starte();
    await sitzung.monitorHinzufuegen();
    const zweites = notizen.panels.at(-1)!;
    // Das Webview rechnet seinen Ursprung schon hinein; der Host reicht durch.
    assert.doesNotThrow(() => zweites.webview.vomWebview({ type: 'mouse', kind: 'move', x: 1500, y: 20 }));
  });

  test('Schliessen des Monitors fragt wieder einen einzelnen Monitor an', async () => {
    const { sitzung, layouts } = await starte();
    await sitzung.monitorHinzufuegen();
    const zweites = notizen.panels.at(-1)!;
    zweites.webview.vomWebview({ type: 'ready', width: 800, height: 600, devicePixelRatio: 1 });
    await warteBis(() => layouts.some((l) => l.length === 2), 'Anordnung mit zwei Monitoren');

    zweites.dispose();
    assert.equal(sitzung.monitorAnzahl, 1);
    await warteBis(() => layouts.at(-1)!.length === 1, 'Anordnung mit einem Monitor');
  });

  test('Mit der Sitzung schliessen auch ihre weiteren Monitore', async () => {
    const { sitzung } = await starte();
    await sitzung.monitorHinzufuegen();
    const zweites = notizen.panels.at(-1)!;
    sitzung.dispose();
    assert.equal(zweites.entsorgt, true);
  });

  test('RÜCKFALLEBENE: ohne Display Control gibt es eine Meldung und kein Panel', async () => {
    const { sitzung } = await starte(4, false);
    const panels = notizen.panels.length;
    await sitzung.monitorHinzufuegen();
    assert.equal(notizen.panels.length, panels);
    assert.ok(notizen.warnungen.some((w) => w.includes('MS-RDPEDISP')), notizen.warnungen.join(' | '));
  });

  test('RÜCKFALLEBENE: erlaubt der Server nur einen Monitor, bleibt es dabei', async () => {
    const { sitzung } = await starte(1);
    const panels = notizen.panels.length;
    await sitzung.monitorHinzufuegen();
    assert.equal(notizen.panels.length, panels);
    assert.ok(notizen.warnungen.some((w) => w.includes('nur einen Monitor')), notizen.warnungen.join(' | '));
  });
});
