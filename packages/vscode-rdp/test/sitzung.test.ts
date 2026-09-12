// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  OutputChannel,
  StatusBarAlignment,
  StatusBarItem,
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
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockRdpServer } from './ts-rdp-quelle/test/mockServer.js';
import { BinaryWriter } from 'ts-rdp';
import { RdpSession } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import { secretKey } from '../src/connections.js';
import type { RdpConnection } from '../src/connections.js';

/** Der Server gibt die Sitzungsgroesse vor - absichtlich anders als angefragt. */
const SERVER_BREITE = 800;
const SERVER_HOEHE = 600;
const FASTPATH_UPDATETYPE_BITMAP = 0x0001;

// ------------------------------------------------------------------ Hilfen

/** Selbstsigniertes Testzertifikat; RDP-Server verwenden in der Praxis dasselbe. */
function erzeugeTestzertifikat(): { cert: string; key: string; ordner: string } {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-rdp-test-'));
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

/** Einen Port ermitteln, auf dem sicher niemand horcht. */
async function geschlossenerPort(): Promise<number> {
  const horcher = net.createServer();
  await new Promise<void>((fertig) => horcher.listen(0, '127.0.0.1', fertig));
  const port = (horcher.address() as net.AddressInfo).port;
  await new Promise<void>((fertig) => horcher.close(() => fertig()));
  return port;
}

/**
 * Ein durchreichender TCP-Lauscher vor dem Mock-Server.
 *
 * Nur so laesst sich von aussen sehen, ob eine Sitzung ihre Verbindung
 * wirklich abbaut: `isConnected` kann das nicht belegen, weil `dispose` den
 * Client ohnehin vergisst - die Steckdose muss man selbst nachschauen.
 */
interface Durchreiche {
  port: number;
  offeneVerbindungen(): number;
  schliessen(): void;
}

async function durchreiche(zielPort: number): Promise<Durchreiche> {
  const offen = new Set<net.Socket>();
  const lauscher = net.createServer((vonClient) => {
    offen.add(vonClient);
    const zumServer = net.connect(zielPort, '127.0.0.1');
    const beenden = () => {
      vonClient.destroy();
      zumServer.destroy();
    };
    vonClient.on('close', () => offen.delete(vonClient));
    vonClient.on('error', beenden);
    zumServer.on('close', beenden);
    zumServer.on('error', beenden);
    vonClient.pipe(zumServer);
    zumServer.pipe(vonClient);
  });
  await new Promise<void>((fertig) => lauscher.listen(0, '127.0.0.1', fertig));
  return {
    port: (lauscher.address() as net.AddressInfo).port,
    offeneVerbindungen: () => offen.size,
    schliessen: () => {
      for (const s of [...offen]) s.destroy();
      lauscher.close();
    },
  };
}

async function warteBis(bedingung: () => boolean, was: string, frist = 15000): Promise<void> {
  const ende = Date.now() + frist;
  for (;;) {
    if (bedingung()) return;
    if (Date.now() > ende) throw new Error(`Zeitueberschreitung beim Warten auf: ${was}`);
    await new Promise((weiter) => setTimeout(weiter, 5));
  }
}

interface BitmapNachricht {
  type: 'bitmap';
  rects: { x: number; y: number; w: number; h: number; offset: number; length: number }[];
  data: Uint8Array | string;
}

function nachrichten<T = any>(panel: WebviewPanel, typ: string, ab = 0): T[] {
  return panel.webview.gesendet.slice(ab).filter((n) => (n as { type?: string })?.type === typ) as T[];
}

/** Macht aus beiden erlaubten Uebertragungsformen wieder Bytes. */
function alsBytes(daten: Uint8Array | string): Uint8Array {
  return typeof daten === 'string' ? new Uint8Array(Buffer.from(daten, 'base64')) : daten;
}

/**
 * Ein Fastpath-Bitmap-Update mit mehreren Rechtecken, jedes in einer eigenen
 * Farbe. 16 bpp, unkomprimiert - der Inhalt ist einfarbig, damit das Drehen
 * von unten nach oben das Ergebnis nicht verwischt und sich jede Kachel an
 * ihrer Farbe wiedererkennen laesst.
 */
function bitmapUpdate(kacheln: { x: number; y: number; w: number; h: number; farbe: number }[]): Buffer {
  const w = new BinaryWriter().uint16le(0x0001).uint16le(kacheln.length);
  for (const kachel of kacheln) {
    const pixel = new BinaryWriter();
    for (let i = 0; i < kachel.w * kachel.h; i++) pixel.uint16le(kachel.farbe);
    const daten = pixel.toBuffer();
    w.uint16le(kachel.x)
      .uint16le(kachel.y)
      .uint16le(kachel.x + kachel.w - 1)
      .uint16le(kachel.y + kachel.h - 1)
      .uint16le(kachel.w)
      .uint16le(kachel.h)
      .uint16le(16)
      .uint16le(0)
      .uint16le(daten.length)
      .bytes(daten);
  }
  return w.toBuffer();
}

/** RGB565 -> RGBA, so wie der Dekoder es liefern muss. */
const ROT = { code: 0xf800, rgba: [255, 0, 0, 255] };
const GRUEN = { code: 0x07e0, rgba: [0, 255, 0, 255] };
const BLAU = { code: 0x001f, rgba: [0, 0, 255, 255] };

function offeneZeitgeber(): number {
  return process.getActiveResourcesInfo().filter((art) => art === 'Timeout').length;
}

interface Pruefstand {
  sitzung: RdpSession;
  panel: WebviewPanel;
  kontext: ExtensionContext;
  ausgabe: OutputChannel;
  statusleiste: StatusBarItem;
}

const offeneSitzungen: RdpSession[] = [];

/**
 * Baut eine Sitzung genauso auf, wie die Extension es tut: Panel oeffnen, das
 * Webview meldet sich mit 'ready', daraufhin verbindet der Host.
 */
async function starteSitzung(port: number, bereit = { width: 1024, height: 768 }): Promise<Pruefstand> {
  const kontext = new ExtensionContext();
  const ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  const verbindung: RdpConnection = { name: 'Pruefstand', host: '127.0.0.1', port, username: 'tester' };
  // Passwort vorab hinterlegen, sonst fragt die Sitzung danach.
  await kontext.secrets.store(secretKey(verbindung), 'geheim');

  const sitzung = await RdpSession.open(kontext, verbindung, ausgabe, new CertificateTrustStore(kontext));
  offeneSitzungen.push(sitzung);
  // Jede Sitzung legt ihre eigene Statusleiste an; hier die zuletzt erzeugte
  // greifen, statt der Sitzung eine fremde unterzuschieben.
  const statusleiste = notizen.statusleisten.at(-1)!;
  const panel = notizen.panels.at(-1)!;
  panel.webview.vomWebview({ type: 'ready', ...bereit, devicePixelRatio: 1 });
  return { sitzung, panel, kontext, ausgabe, statusleiste };
}

/** Unbehandelte Zusagen sind hier der eigentliche Prueffall, also mitschreiben. */
const unbehandelt: unknown[] = [];
process.on('unhandledRejection', (grund) => unbehandelt.push(grund));

let zertifikat: { cert: string; key: string; ordner: string };
let server: MockRdpServer;
let port: number;

before(async () => {
  zertifikat = erzeugeTestzertifikat();
  server = new MockRdpServer({
    cert: zertifikat.cert,
    key: zertifikat.key,
    width: SERVER_BREITE,
    height: SERVER_HOEHE,
  });
  port = await server.listen();
});

after(() => {
  server.close();
  fs.rmSync(zertifikat.ordner, { recursive: true, force: true });
});

beforeEach(() => {
  zuruecksetzen();
  unbehandelt.length = 0;
  einstellungen.set('rdp.certificateTrust', 'ignore');
  einstellungen.set('rdp.connectTimeout', 10000);
  einstellungen.set('rdp.scaling', 'fit');
  einstellungen.set('rdp.smoothScaling', false);
});

afterEach(async () => {
  for (const sitzung of offeneSitzungen.splice(0)) sitzung.dispose();
  // Dem Server Zeit geben, die Verbindung abzubauen - sonst stolpert der
  // naechste Test ueber den Rest des vorigen.
  await new Promise((weiter) => setTimeout(weiter, 20));
  assert.deepEqual(unbehandelt, [], 'keine unbehandelte Zusage');
});

// ----------------------------------------------------------------- Aufbau

describe('Sitzungsaufbau', () => {
  test('Die Webview bekommt init mit der Groesse, die der Server vorgibt', async () => {
    const { sitzung, panel, statusleiste } = await starteSitzung(port, { width: 1024, height: 768 });
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => nachrichten(panel, 'init').length > 0, 'init-Nachricht');

    const inits = nachrichten<{ width: number; height: number; scaling: string }>(panel, 'init');
    // Die Zeichenflaeche muss die Groesse haben, in der der Server seine
    // Kacheln adressiert - sonst landen sie ausserhalb des Bildes.
    for (const init of inits) {
      assert.equal(init.width, SERVER_BREITE);
      assert.equal(init.height, SERVER_HOEHE);
    }
    assert.equal(inits.at(-1)!.scaling, 'fit', 'die Einstellung wird mitgeschickt');

    assert.equal(statusleiste.sichtbar, true, 'die Statusleiste zeigt die aktive Sitzung');
    assert.ok(statusleiste.text.includes('Pruefstand'), statusleiste.text);
  });

  test('"connected" wird erst gemeldet, wenn das Webview gezeichnet hat', async () => {
    const { sitzung, panel } = await starteSitzung(port);
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => nachrichten(panel, 'init').length > 0, 'init-Nachricht');

    type Zustand = { state: string; title?: string; message?: string };
    const zustaende = () => nachrichten<Zustand>(panel, 'state').map((z) => z.state);

    // Solange nichts gezeichnet ist, waere eine schwarze Flaeche nicht von
    // einem Fehler zu unterscheiden - die Einblendung muss also stehen bleiben.
    assert.ok(!zustaende().includes('connected'), `zu frueh verbunden gemeldet: ${zustaende().join(', ')}`);
    assert.ok(zustaende().includes('waiting'), 'bis dahin wird gewartet');

    panel.webview.vomWebview({ type: 'painted', tiles: 3 });
    assert.equal(zustaende().at(-1), 'connected');
  });

  test('Der Zertifikatsfingerabdruck steht im Protokoll', async () => {
    const { sitzung, ausgabe } = await starteSitzung(port);
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');

    const zeile = ausgabe.zeilen.find((z) => z.includes('Zertifikat von'));
    assert.ok(zeile, `kein Zertifikatsprotokoll in:\n${ausgabe.zeilen.join('\n')}`);
    assert.match(zeile!, /(?:[0-9A-F]{2}:){31}[0-9A-F]{2}/, 'SHA-256-Fingerabdruck in Doppelpunktschreibweise');
  });
});

// ----------------------------------------------------------------- Kacheln

describe('Kacheln auf dem Weg zur Webview', () => {
  /**
   * Der Vertrag, auf den sich media/main.js verlaesst. Er wird hier aus den
   * Kachelangaben der Nachricht selbst hergeleitet und nicht aus dem, was
   * session.ts gerechnet hat - sonst wuerde der Test denselben Fehler machen
   * wie der Code.
   */
  function pruefeVertrag(nachricht: BitmapNachricht): Uint8Array {
    const bytes = alsBytes(nachricht.data);
    let erwartetesOffset = 0;
    for (const [i, rechteck] of nachricht.rects.entries()) {
      assert.equal(
        rechteck.length,
        rechteck.w * rechteck.h * 4,
        `Rechteck ${i}: length muss w*h*4 sein (${rechteck.w}x${rechteck.h})`,
      );
      assert.equal(
        rechteck.offset,
        erwartetesOffset,
        `Rechteck ${i}: offset muss luecken- und ueberlappungsfrei anschliessen`,
      );
      erwartetesOffset += rechteck.length;
    }
    assert.equal(bytes.length, erwartetesOffset, 'die Daten sind genau so lang wie die Summe der Rechtecke');
    return bytes;
  }

  test('Alle Kacheln eines Updates ergeben genau eine bitmap-Nachricht', async () => {
    const { sitzung, panel } = await starteSitzung(port);
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    const ab = panel.webview.gesendet.length;

    const kacheln = [
      { x: 10, y: 20, w: 4, h: 2, farbe: ROT.code },
      { x: 64, y: 8, w: 2, h: 3, farbe: BLAU.code },
      { x: 100, y: 100, w: 8, h: 1, farbe: GRUEN.code },
    ];
    server.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, bitmapUpdate(kacheln));
    await warteBis(() => nachrichten(panel, 'bitmap', ab).length > 0, 'bitmap-Nachricht');
    // Kurz nachfassen: eine zweite Nachricht waere ein Vertragsbruch und darf
    // dem Test nicht dadurch entgehen, dass er zu frueh nachschaut.
    await new Promise((weiter) => setTimeout(weiter, 100));

    const bitmaps = nachrichten<BitmapNachricht>(panel, 'bitmap', ab);
    assert.equal(bitmaps.length, 1, 'ein Update, eine Nachricht');

    const nachricht = bitmaps[0]!;
    assert.equal(nachricht.rects.length, kacheln.length);
    const bytes = pruefeVertrag(nachricht);

    // Und jetzt der Teil, den blosse Rechnerei nicht abdeckt: an jedem Offset
    // muss auch wirklich die zugehoerige Kachel liegen.
    const farben = new Map([[ROT.code, ROT.rgba], [BLAU.code, BLAU.rgba], [GRUEN.code, GRUEN.rgba]]);
    for (const [i, rechteck] of nachricht.rects.entries()) {
      const quelle = kacheln[i]!;
      assert.deepEqual(
        [rechteck.x, rechteck.y, rechteck.w, rechteck.h],
        [quelle.x, quelle.y, quelle.w, quelle.h],
        `Rechteck ${i} beschreibt die Kachel des Servers`,
      );
      const erwartet = farben.get(quelle.farbe)!;
      const ausschnitt = bytes.subarray(rechteck.offset, rechteck.offset + rechteck.length);
      for (let pixel = 0; pixel < rechteck.w * rechteck.h; pixel++) {
        assert.deepEqual(
          [...ausschnitt.subarray(pixel * 4, pixel * 4 + 4)],
          erwartet,
          `Rechteck ${i}, Pixel ${pixel} liegt am angegebenen Offset`,
        );
      }
    }
  });

  test('Eine einzelne Kachel faengt bei Offset 0 an', async () => {
    const { sitzung, panel } = await starteSitzung(port);
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    const ab = panel.webview.gesendet.length;

    server.sendFastpathUpdate(
      FASTPATH_UPDATETYPE_BITMAP,
      bitmapUpdate([{ x: 0, y: 0, w: 4, h: 4, farbe: GRUEN.code }]),
    );
    await warteBis(() => nachrichten(panel, 'bitmap', ab).length > 0, 'bitmap-Nachricht');

    const nachricht = nachrichten<BitmapNachricht>(panel, 'bitmap', ab)[0]!;
    assert.equal(nachricht.rects[0]!.offset, 0, "die erste Kachel beginnt am Anfang der Daten");
    pruefeVertrag(nachricht);
  });

  test('Nach binaryUnsupported traegt die naechste Nachricht eine Zeichenkette', async () => {
    const { sitzung, panel } = await starteSitzung(port);
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');

    const vorher = panel.webview.gesendet.length;
    server.sendFastpathUpdate(
      FASTPATH_UPDATETYPE_BITMAP,
      bitmapUpdate([{ x: 0, y: 0, w: 2, h: 2, farbe: ROT.code }]),
    );
    await warteBis(() => nachrichten(panel, 'bitmap', vorher).length > 0, 'erste bitmap-Nachricht');
    const erste = nachrichten<BitmapNachricht>(panel, 'bitmap', vorher)[0]!;
    assert.ok(erste.data instanceof Uint8Array, 'zuerst wird binaer geschickt');

    // Das Webview meldet, dass Binaerdaten bei ihm nicht ankommen.
    panel.webview.vomWebview({ type: 'binaryUnsupported' });

    const dazwischen = panel.webview.gesendet.length;
    server.sendFastpathUpdate(
      FASTPATH_UPDATETYPE_BITMAP,
      bitmapUpdate([{ x: 5, y: 6, w: 2, h: 2, farbe: BLAU.code }]),
    );
    await warteBis(() => nachrichten(panel, 'bitmap', dazwischen).length > 0, 'zweite bitmap-Nachricht');

    const zweite = nachrichten<BitmapNachricht>(panel, 'bitmap', dazwischen)[0]!;
    assert.equal(typeof zweite.data, 'string', 'danach als Base64-Zeichenkette');
    const bytes = pruefeVertrag(zweite);
    // Die Umstellung darf am Inhalt nichts aendern.
    assert.deepEqual([...bytes.subarray(0, 4)], BLAU.rgba);
  });
});

// ------------------------------------------------------------------ Fehler

describe('Fehlerfall', () => {
  test('Ein abgelehnter Verbindungsversuch endet in einem sauberen Zustand', async () => {
    const tot = await geschlossenerPort();
    const { sitzung, panel, statusleiste } = await starteSitzung(tot);

    type Zustand = { state: string; title?: string; message?: string; action?: string };
    await warteBis(
      () => nachrichten<Zustand>(panel, 'state').some((z) => z.state === 'error'),
      'Fehlerzustand im Webview',
    );

    const fehler = nachrichten<Zustand>(panel, 'state').filter((z) => z.state === 'error').at(-1)!;
    assert.equal(fehler.title, 'Verbindung fehlgeschlagen');
    assert.ok(fehler.action, 'der Benutzer bekommt einen Ausweg angeboten');
    // Der Benutzer soll eine Erklaerung bekommen, keinen Systemfehlercode.
    assert.ok(
      !/ECONNREFUSED/.test(fehler.message ?? ''),
      `technische Meldung durchgereicht: ${fehler.message}`,
    );
    assert.match(fehler.message ?? '', /Remotedesktopdienst|Verbindung/);

    assert.equal(sitzung.isConnected, false);
    assert.equal(statusleiste.sichtbar, false, 'keine aktive Sitzung in der Statusleiste');
    assert.equal(panel.entsorgt, false, 'das Panel bleibt offen, damit man es erneut versuchen kann');
  });

  test('Bricht der Server die Sitzung ab, wird das gemeldet und nicht geworfen', async () => {
    const eigenerServer = new MockRdpServer({
      cert: zertifikat.cert,
      key: zertifikat.key,
      width: SERVER_BREITE,
      height: SERVER_HOEHE,
    });
    const eigenerPort = await eigenerServer.listen();
    try {
      const { sitzung, panel } = await starteSitzung(eigenerPort);
      await warteBis(() => sitzung.isConnected, 'aktive Sitzung');

      eigenerServer.close();

      type Zustand = { state: string; title?: string };
      await warteBis(
        () => nachrichten<Zustand>(panel, 'state').some((z) => z.state === 'closed' || z.state === 'error'),
        'Abbruch wird gemeldet',
      );
      assert.equal(sitzung.isConnected, false);
    } finally {
      eigenerServer.close();
    }
  });
});

// ----------------------------------------------------------------- Abbau

describe('Aufraeumen', () => {
  test('dispose beendet Zeitgeber und Verbindung', async () => {
    const lauscher = await durchreiche(port);
    try {
      const { sitzung, panel, statusleiste } = await starteSitzung(lauscher.port);
      await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
      // Die Zertifikatspruefung hat eine eigene Verbindung benutzt und wieder
      // geschlossen; uebrig bleibt genau die der Sitzung.
      await warteBis(() => lauscher.offeneVerbindungen() === 1, 'genau eine offene Verbindung');

      // Bewusst kein 'painted' aus dem Webview: dadurch bleiben beide
      // Wachhund-Zeitgeber scharf und ihr Verschwinden ist messbar.
      const zeitgeberVorher = offeneZeitgeber();
      assert.ok(zeitgeberVorher >= 2, `Wachhund laeuft (${zeitgeberVorher} Zeitgeber)`);

      sitzung.dispose();

      assert.ok(
        offeneZeitgeber() <= zeitgeberVorher - 2,
        `beide Wachhund-Zeitgeber sind abgeraeumt (vorher ${zeitgeberVorher}, jetzt ${offeneZeitgeber()})`,
      );
      await warteBis(() => lauscher.offeneVerbindungen() === 0, 'die Steckdose ist gezogen', 3000);

      assert.equal(sitzung.isConnected, false);
      assert.equal(panel.entsorgt, true, 'das Panel ist geschlossen');
      assert.equal(statusleiste.sichtbar, false);
      assert.equal(notizen.kontext.get('rdp.sessionFocused'), false, 'der Tastaturkontext ist zurueckgenommen');
    } finally {
      lauscher.schliessen();
    }
  });

  test('Nach dispose geht nichts mehr an die Webview', async () => {
    const { sitzung, panel } = await starteSitzung(port);
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');

    sitzung.dispose();
    const stand = panel.webview.gesendet.length;

    // Alles anstossen, was sonst etwas schicken wuerde.
    sitzung.applyConfiguration();
    sitzung.refreshScreen();
    sitzung.sendCtrlAltDelete();
    sitzung.toggleScaling();
    server.sendFastpathUpdate(
      FASTPATH_UPDATETYPE_BITMAP,
      bitmapUpdate([{ x: 0, y: 0, w: 2, h: 2, farbe: ROT.code }]),
    );
    await new Promise((weiter) => setTimeout(weiter, 150));

    assert.equal(
      panel.webview.gesendet.length,
      stand,
      `nachtraegliche Nachrichten: ${JSON.stringify(panel.webview.gesendet.slice(stand))}`,
    );
  });

  test('Schliesst der Benutzer das Panel, endet die Sitzung', async () => {
    const lauscher = await durchreiche(port);
    try {
      const { sitzung, panel } = await starteSitzung(lauscher.port);
      await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
      await warteBis(() => lauscher.offeneVerbindungen() === 1, 'genau eine offene Verbindung');

      let entsorgt = false;
      sitzung.onDispose = () => {
        entsorgt = true;
      };
      panel.dispose();

      assert.equal(entsorgt, true, 'die Extension erfaehrt vom Schliessen');
      await warteBis(() => lauscher.offeneVerbindungen() === 0, 'die Verbindung wird mit abgebaut', 3000);
      assert.equal(sitzung.isConnected, false);
    } finally {
      lauscher.schliessen();
    }
  });
});

// ------------------------------------------------- Regressionen aus der Pruefung

describe('Regressionen', () => {
  test('Erneut verbinden trennt die alte Verbindung, statt sie zu vergessen', async () => {
    // Zuvor setzte der Fall 'reconnect' nur `this.client = undefined`. Die alte
    // Verbindung blieb offen, ohne dass noch jemand sie kannte: der Server hielt
    // die Sitzung, und die Horcher der verwaisten Instanz speisten weiter
    // Kacheln und Fehler in dasselbe Webview. Jeder Klick auf "Erneut
    // verbinden" legte eine weitere solche Geistersitzung an.
    const lauscher = await durchreiche(port);
    try {
      const { sitzung, panel } = await starteSitzung(lauscher.port);
      await warteBis(() => sitzung.isConnected, 'erste Sitzung steht');
      await warteBis(() => lauscher.offeneVerbindungen() === 1, 'genau eine offene Verbindung');

      panel.webview.vomWebview({ type: 'reconnect' });
      await warteBis(() => sitzung.isConnected, 'zweite Sitzung steht');

      // Der springende Punkt: es darf weiterhin nur *eine* Verbindung offen sein.
      await warteBis(
        () => lauscher.offeneVerbindungen() === 1,
        `nach dem Neuverbinden nur eine Verbindung (es sind ${lauscher.offeneVerbindungen()})`,
        5000,
      );

      sitzung.dispose();
      await warteBis(() => lauscher.offeneVerbindungen() === 0, 'dispose raeumt alles ab', 3000);
    } finally {
      lauscher.schliessen();
    }
  });

  test('Beim ersten Verbinden meldet die Sitzung keine Aufloesungsaenderung', async () => {
    // Windows gibt regelmaessig eine andere Groesse vor als angefragt. Das
    // 'resize' des Clients trifft dann schon waehrend des Aufbaus ein, also vor
    // 'connect'. Wer das unbesehen anzeigt, blendet dem Anwender beim
    // allerersten Verbindungsaufbau "Auflösung geändert" ein - vor der ersten
    // Anzeige ueberhaupt.
    const { sitzung, panel } = await starteSitzung(port, { width: 1024, height: 768 });
    await warteBis(() => sitzung.isConnected, 'Sitzung steht');

    const zustaende = nachrichten<{ title?: string }>(panel, 'state');
    const falschgemeldet = zustaende.filter((z) => (z.title ?? '').includes('Auflösung geändert'));
    assert.deepEqual(
      falschgemeldet,
      [],
      `keine Aufloesungsmeldung beim Aufbau, gemeldet wurde: ${zustaende.map((z) => z.title).join(' | ')}`,
    );
  });

  test('Zwei Sitzungen teilen sich keine Statusleiste', async () => {
    // Frueher erzeugte activate() genau einen Eintrag und reichte ihn an jede
    // Sitzung durch: die zuletzt aktive ueberschrieb den Text der anderen, und
    // das Schliessen *einer* Sitzung blendete die Anzeige aus, obwohl die
    // andere noch verbunden war.
    const erste = await starteSitzung(port);
    await warteBis(() => erste.sitzung.isConnected, 'erste Sitzung steht');
    const zweite = await starteSitzung(port);
    await warteBis(() => zweite.sitzung.isConnected, 'zweite Sitzung steht');

    assert.notEqual(erste.statusleiste, zweite.statusleiste, 'jede Sitzung hat einen eigenen Eintrag');

    erste.sitzung.dispose();
    assert.equal(
      zweite.statusleiste.sichtbar,
      true,
      'die zweite Sitzung bleibt in der Statusleiste sichtbar',
    );
  });
});
