/**
 * Robuste Sitzung: Groesse beim Start und nach Webview-Neuladen, abgelehnte
 * Anmeldung ohne Passwortverlust, "keine Antwort"-Overlay und der Befehl
 * "Auflösung an Fenster anpassen". Gegen den Mock-Server aus ts-rdp.
 */
import {
  ExtensionContext,
  WebviewPanel,
  antworten,
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
import { RdpAuthError, RdpClient, RdpError, edisp } from 'ts-rdp';
import { RdpSession, humanizeError, ntStatusText } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import { secretKey } from '../src/connections.js';
import type { RdpConnection } from '../src/connections.js';

const DISPLAY_CONTROL = edisp.DISPLAY_CONTROL_CHANNEL_NAME;

function zertifikat(): { cert: string; key: string; ordner: string } {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-rdp-robust-'));
  const certPfad = path.join(ordner, 'cert.pem');
  const keyPfad = path.join(ordner, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPfad, '-out', certPfad,
    '-days', '2', '-subj', '/CN=vscode-rdp-test'], { stdio: 'ignore' });
  return { cert: fs.readFileSync(certPfad, 'utf8'), key: fs.readFileSync(keyPfad, 'utf8'), ordner };
}

async function warteBis(bedingung: () => boolean, was: string, frist = 10000): Promise<void> {
  const ende = Date.now() + frist;
  for (;;) {
    if (bedingung()) return;
    if (Date.now() > ende) throw new Error(`Zeitueberschreitung beim Warten auf: ${was}`);
    await new Promise((weiter) => setTimeout(weiter, 5));
  }
}

const pause = (ms: number) => new Promise((weiter) => setTimeout(weiter, ms));

function nachrichten<T = any>(panel: WebviewPanel, typ: string): T[] {
  return panel.webview.gesendet.filter((n) => (n as { type?: string })?.type === typ) as T[];
}

let cert: { cert: string; key: string; ordner: string };
const offen: { server: MockRdpServer; sitzung?: RdpSession }[] = [];
let nr = 0;

before(() => {
  cert = zertifikat();
});
after(() => fs.rmSync(cert.ordner, { recursive: true, force: true }));

const originalConnect = RdpClient.prototype.connect;

beforeEach(() => {
  zuruecksetzen();
  einstellungen.set('rdp.certificateTrust', 'ignore');
  einstellungen.set('rdp.connectTimeout', 10000);
  einstellungen.set('rdp.dynamicResolution', true);
  RdpSession.anmeldeWiederholungMs = 40;
});

afterEach(async () => {
  RdpClient.prototype.connect = originalConnect;
  for (const { server, sitzung } of offen.splice(0)) {
    sitzung?.dispose();
    server.close();
  }
  await pause(20);
});

interface Optionen {
  /** Display Control anbieten. */
  kanal?: boolean;
  /** Das CAPS-PDU gleich senden. */
  caps?: boolean;
  verbindung?: Partial<RdpConnection>;
  /** Auf 'ready' verzichten (Test schickt es selbst). */
  ohneReady?: boolean;
  passwort?: string | null;
  /** Nicht auf die stehende Verbindung warten (Anmeldung wird abgelehnt). */
  scheitert?: boolean;
}

async function starte(o: Optionen = {}) {
  const kanal = o.kanal ?? true;
  const server = new MockRdpServer({
    cert: cert.cert, key: cert.key, width: 1024, height: 768, dynamicChannels: kanal ? [DISPLAY_CONTROL] : [],
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
  const verbindung: RdpConnection = { name: `Robust${++nr}`, host: '127.0.0.1', port, username: `tester${nr}`, ...o.verbindung };
  if (o.passwort !== null) await kontext.secrets.store(secretKey(verbindung), o.passwort ?? 'geheim');
  const sitzung = await RdpSession.open(kontext, verbindung, ausgabe, new CertificateTrustStore(kontext));
  eintrag.sitzung = sitzung;
  const panel = notizen.panels.at(-1)!;
  const sendeCaps = () =>
    server.sendDynamicChannelData(
      DISPLAY_CONTROL,
      edisp.buildCapsPdu({ maxNumMonitors: 4, maxMonitorAreaFactorA: 8192, maxMonitorAreaFactorB: 8192 }),
    );
  if (!o.ohneReady) {
    panel.webview.vomWebview({ type: 'ready', width: 1024, height: 768, devicePixelRatio: 1 });
    if (o.scheitert) return { server, sitzung, panel, ausgabe, layouts, sendeCaps, verbindung, kontext, port };
    await warteBis(() => sitzung.isConnected && nachrichten(panel, 'init').length > 0, 'verbundene Sitzung');
    if (kanal) {
      await warteBis(() => server.dynamicChannelIds.has(DISPLAY_CONTROL), 'Display-Control-Kanal');
      if (o.caps ?? true) {
        sendeCaps();
        await warteBis(() => ausgabe.zeilen.some((z) => z.includes('Monitore')), 'CAPS beim Client');
      }
    }
  }
  return { server, sitzung, panel, ausgabe, layouts, sendeCaps, verbindung, kontext, port };
}

const letzterZustand = (p: WebviewPanel) => nachrichten<{ state: string; title?: string; action?: string; message?: string }>(p, 'state').at(-1)!;

// ------------------------------------------------------- 1. Groesse

describe('Sitzung - Panelgroesse', () => {
  test('Eine Groesse, die vor Display Control eintraf, wird mit dem CAPS-PDU nachgeholt', async () => {
    const { panel, ausgabe, layouts, sendeCaps, sitzung } = await starte({ caps: false });
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1400, height: 900, devicePixelRatio: 1 });
    await warteBis(() => ausgabe.zeilen.some((z) => z.includes('vorgemerkt')), 'Groesse vorgemerkt');
    assert.equal(layouts.length, 0);
    sendeCaps();
    await warteBis(() => layouts.length === 1, 'Anfrage nach dem CAPS-PDU');
    assert.deepEqual([layouts[0]![0]!.width, layouts[0]![0]!.height], [1400, 900]);
    void sitzung;
  });

  test('Ein erneutes ready sendet init und Zustand neu und wendet die neue Groesse an', async () => {
    const { panel, layouts, sitzung } = await starte();
    const inits = nachrichten(panel, 'init').length;
    const server = offen[0]!.server;
    const refreshs: number[] = [];
    server.on('refreshRect', () => refreshs.push(1));
    panel.webview.vomWebview({ type: 'painted', tiles: 1 });

    panel.webview.vomWebview({ type: 'ready', width: 1600, height: 900, devicePixelRatio: 1 });
    assert.equal(nachrichten(panel, 'init').length, inits + 1, 'init erneut gesendet');
    assert.equal(nachrichten(panel, 'diagnose').length >= 2, true);
    assert.equal(nachrichten(panel, 'farbe').length >= 2, true);
    assert.equal(letzterZustand(panel).state, 'waiting', 'wartet auf das neue Bild');
    await warteBis(() => refreshs.length > 0, 'Vollbild angefordert');
    await warteBis(() => layouts.length === 1, 'neue Groesse angefragt');
    assert.deepEqual([layouts[0]![0]!.width, layouts[0]![0]!.height], [1600, 900]);
    // Das neue Webview meldet 'painted' und der Zustand geht zurueck auf verbunden.
    panel.webview.vomWebview({ type: 'painted', tiles: 1 });
    assert.equal(letzterZustand(panel).state, 'connected');
    void sitzung;
  });

  test('Waehrend des Aufbaus merkt ein erneutes ready nur die Groesse', async () => {
    const { panel, sitzung } = await starte({ ohneReady: true });
    // Erstes ready hat start() angestossen, das noch laeuft (Zertifikatspruefung).
    panel.webview.vomWebview({ type: 'ready', width: 1024, height: 768, devicePixelRatio: 1 });
    panel.webview.vomWebview({ type: 'ready', width: 1500, height: 800, devicePixelRatio: 1 });
    await warteBis(() => sitzung.isConnected && nachrichten(panel, 'init').length > 0, 'verbunden');
    assert.equal(offen[0]!.server.tlsAttempts >= 1, true);
  });

  test('Ein Server, der eine andere Groesse erzwingt, loest keine Schleife aus', async () => {
    const { panel, layouts, server, ausgabe } = await starte();
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1400, height: 900, devicePixelRatio: 1 });
    await warteBis(() => layouts.length === 1, 'erste Anfrage');
    // Der Server richtet etwas anderes ein (klassische Neuaktivierung).
    (server as unknown as { opts: { width: number; height: number } }).opts.width = 1280;
    (server as unknown as { opts: { width: number; height: number } }).opts.height = 720;
    server.reactivate();
    await warteBis(() => ausgabe.zeilen.some((z) => z.includes('Sitzungsgröße geändert: 1280×720')), 'Server-resize');
    await pause(150);
    assert.equal(layouts.length, 1, 'dieselbe Zielgroesse wird nicht ein zweites Mal angefragt');
    // Eine andere Panelgroesse wird dagegen wieder angefragt.
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1500, height: 900, devicePixelRatio: 1 });
    await warteBis(() => layouts.length === 2, 'neue Zielgroesse');
  });

  test('Feste Aufloesung und abgeschaltetes Mitziehen bleiben ohne Befehl unberuehrt', async () => {
    einstellungen.set('rdp.dynamicResolution', false);
    const { panel, layouts } = await starte();
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1400, height: 900, devicePixelRatio: 1 });
    panel.webview.vomWebview({ type: 'ready', width: 1500, height: 900, devicePixelRatio: 1 });
    await pause(100);
    assert.equal(layouts.length, 0);
  });
});

// ------------------------------------------------------- 4. Befehl

describe('Sitzung - Auflösung an Fenster anpassen', () => {
  test('Fragt die Webview und wendet die Antwort auch bei ausgeschaltetem Mitziehen an', async () => {
    einstellungen.set('rdp.dynamicResolution', false);
    const { panel, layouts, sitzung, ausgabe } = await starte();
    sitzung.passeAufloesungAn();
    assert.equal(nachrichten(panel, 'groesseMelden').length, 1);
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1360, height: 840, devicePixelRatio: 1, erzwingen: true });
    await warteBis(() => layouts.length === 1, 'angefragt');
    assert.deepEqual([layouts[0]![0]!.width, layouts[0]![0]!.height], [1360, 840]);
    assert.ok(ausgabe.zeilen.some((z) => z.includes('auf Wunsch')), 'Logzeile');
  });

  test('Gilt auch bei fest eingetragener Aufloesung', async () => {
    const { panel, layouts } = await starte({ verbindung: { width: 1024, height: 768 } });
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1360, height: 840, devicePixelRatio: 1 });
    await pause(60);
    assert.equal(layouts.length, 0, 'ohne Befehl wird die feste Aufloesung nicht ueberstimmt');
    panel.webview.vomWebview({ type: 'resizeRequest', width: 1360, height: 840, devicePixelRatio: 1, erzwingen: true });
    await warteBis(() => layouts.length === 1, 'erzwungen angefragt');
  });

  test('Ohne Display Control gibt es einen Hinweis mit Knopf "Neu verbinden"', async () => {
    const { sitzung } = await starte({ kanal: false });
    antworten.meldungen.push(undefined);
    sitzung.passeAufloesungAn();
    await warteBis(() => notizen.hinweise.some((h) => h.includes('keinen Auflösungswechsel')), 'Hinweis');
    assert.match(notizen.hinweise.at(-1)!, /neu verbinden übernimmt die Fenstergröße/);
  });

  test('"Neu verbinden" baut die Sitzung neu auf', async () => {
    const { sitzung, server } = await starte({ kanal: false });
    antworten.meldungen.push('Neu verbinden');
    const bisher = server.tlsAttempts;
    sitzung.passeAufloesungAn();
    await warteBis(() => server.tlsAttempts > bisher, 'neue Verbindung');
  });
});

// ------------------------------------------------------- 3. Keine Antwort

describe('Sitzung - keine Antwort vom Server', () => {
  test('unresponsive blendet das Overlay ein, responsive stellt den Zustand wieder her', async () => {
    const { sitzung, panel } = await starte();
    panel.webview.vomWebview({ type: 'painted', tiles: 1 });
    assert.equal(letzterZustand(panel).state, 'connected');
    const client = (sitzung as unknown as { client: RdpClient }).client;

    client.emit('unresponsive', { sinceMs: 21000 });
    const z = letzterZustand(panel);
    assert.equal(z.title, 'Keine Antwort vom Server');
    assert.match(z.message!, /Seit 21 s kommt nichts mehr an/);
    assert.match(z.message!, /Ruhezustand/);
    assert.equal(z.action, 'Erneut verbinden');
    const leiste = notizen.statusleisten.at(-1)!;
    assert.match(String(leiste.text), /warning/);

    client.emit('responsive');
    assert.equal(letzterZustand(panel).state, 'connected');
    assert.doesNotMatch(String(leiste.text), /warning/);
  });

  test('Das Overlay behaelt "Erneut verbinden" auch nach neu geladenem Webview', async () => {
    const { sitzung, panel } = await starte();
    panel.webview.vomWebview({ type: 'painted', tiles: 1 });
    const client = (sitzung as unknown as { client: RdpClient }).client;
    client.emit('unresponsive', { sinceMs: 16000 });
    panel.webview.vomWebview({ type: 'ready', width: 1024, height: 768, devicePixelRatio: 1 });
    assert.equal(letzterZustand(panel).title, 'Keine Antwort vom Server');
  });

  test('Der Knopf nutzt den vorhandenen reconnect-Pfad', async () => {
    const { sitzung, panel, server } = await starte();
    const client = (sitzung as unknown as { client: RdpClient }).client;
    client.emit('unresponsive', { sinceMs: 16000 });
    const bisher = server.tlsAttempts;
    panel.webview.vomWebview({ type: 'reconnect' });
    await warteBis(() => server.tlsAttempts > bisher, 'neue Verbindung');
    await warteBis(() => (sitzung as unknown as { client: RdpClient }).client !== client && sitzung.isConnected, 'neu verbunden');
  });
});

// ------------------------------------------------------- 2. Anmeldung

function patcheConnect(verhalten: (versuch: number) => Error | undefined): { aufrufe: () => number } {
  let n = 0;
  RdpClient.prototype.connect = async function (this: RdpClient) {
    const fehler = verhalten(++n);
    if (fehler) throw fehler;
    return originalConnect.call(this);
  };
  return { aufrufe: () => n };
}

const logonFehler = (status = 0xc000006d) => new RdpAuthError(`CredSSP: Server meldet Fehler 0x${status.toString(16)}`, status);

describe('Sitzung - abgelehnte Anmeldung', () => {
  test('0xc000006d mit gespeichertem Passwort: einmal nach Pause erneut, Passwort bleibt', async () => {
    const zaehler = patcheConnect((n) => (n === 1 ? logonFehler() : undefined));
    const { sitzung, panel, kontext, verbindung } = await starte({ scheitert: true });
    await warteBis(() => zaehler.aufrufe() === 2 && sitzung.isConnected, 'zweiter Versuch gelingt');
    assert.ok(
      nachrichten<{ message?: string }>(panel, 'state').some((s) => /neuer Versuch in \d+ s/.test(s.message ?? '')),
      'Hinweis im Overlay',
    );
    assert.equal(await kontext.secrets.get(secretKey(verbindung)), 'geheim');
  });

  test('Scheitert auch der zweite Versuch, ist Schluss und das Passwort bleibt gespeichert', async () => {
    const zaehler = patcheConnect(() => logonFehler());
    const { panel, kontext, verbindung } = await starte({ scheitert: true });
    await warteBis(() => letzterZustand(panel)?.state === 'error', 'Fehlerzustand');
    assert.equal(zaehler.aufrufe(), 2, 'genau ein automatischer Zusatzversuch');
    assert.equal(await kontext.secrets.get(secretKey(verbindung)), 'geheim', 'Passwort nicht geloescht');
    assert.match(letzterZustand(panel).message!, /Passwort bleibt erhalten/);
  });

  test('Andere Codes (falsches Passwort, gesperrt) werden nie automatisch wiederholt', async () => {
    for (const status of [0xc000006a, 0xc0000064, 0xc0000234]) {
      const zaehler = patcheConnect(() => logonFehler(status));
      const { panel, kontext, verbindung } = await starte({ scheitert: true });
      await warteBis(() => letzterZustand(panel)?.state === 'error', 'Fehlerzustand');
      await pause(120);
      assert.equal(zaehler.aufrufe(), 1, `0x${status.toString(16)}: kein zweiter Versuch`);
      assert.equal(await kontext.secrets.get(secretKey(verbindung)), 'geheim');
      for (const { server, sitzung } of offen.splice(0)) {
        sitzung?.dispose();
        server.close();
      }
    }
  });

  test('Beim naechsten Verbinden wird gefragt; "erneut verwenden" ist der Standard', async () => {
    let nochAbgelehnt = true;
    patcheConnect(() => (nochAbgelehnt ? logonFehler(0xc000006a) : undefined));
    const { sitzung, panel, kontext, verbindung } = await starte({ scheitert: true });
    await warteBis(() => letzterZustand(panel)?.state === 'error', 'erste Ablehnung');
    nochAbgelehnt = false;
    antworten.auswahlen.push(0);
    const listen = notizen.auswahllisten.length;
    panel.webview.vomWebview({ type: 'reconnect' });
    await warteBis(() => sitzung.isConnected, 'verbunden mit gespeichertem Passwort');
    const frage = notizen.auswahllisten[listen]!;
    assert.equal(frage.eintraege[0]!.label, 'Gespeichertes Passwort erneut verwenden');
    assert.equal(frage.eintraege[1]!.label, 'Neues Passwort eingeben');
    assert.equal(await kontext.secrets.get(secretKey(verbindung)), 'geheim');

    // Nach dem Erfolg ist das Merkzeichen weg: der naechste Neuaufbau fragt nicht mehr.
    const vorher = notizen.auswahllisten.length;
    panel.webview.vomWebview({ type: 'reconnect' });
    await pause(150);
    assert.equal(notizen.auswahllisten.length, vorher);
  });

  test('"Neues Passwort eingeben" ersetzt das gespeicherte erst nach erfolgreicher Anmeldung', async () => {
    let nochAbgelehnt = true;
    patcheConnect(() => (nochAbgelehnt ? logonFehler(0xc000006a) : undefined));
    const { sitzung, panel, kontext, verbindung } = await starte({ scheitert: true });
    await warteBis(() => letzterZustand(panel)?.state === 'error', 'erste Ablehnung');
    nochAbgelehnt = false;
    antworten.auswahlen.push(1, 0); // neues Passwort, "Passwort merken"
    antworten.eingaben.push('neuesPasswort');
    panel.webview.vomWebview({ type: 'reconnect' });
    await warteBis(() => sitzung.isConnected, 'verbunden');
    await pause(30);
    assert.equal(await kontext.secrets.get(secretKey(verbindung)), 'neuesPasswort');
  });
});

describe('humanizeError - NTSTATUS', () => {
  test('Bekannte Codes werden auf Deutsch benannt', () => {
    const f = (status: number) => humanizeError(new RdpAuthError(`CredSSP: x 0x${status.toString(16)}`, status));
    assert.match(f(0xc000006d), /erst gestartet.*gespeicherte Passwort bleibt erhalten/);
    assert.match(f(0xc000006a), /Passwort ist falsch/);
    assert.match(f(0xc0000064), /Benutzername/);
    assert.match(f(0xc0000234), /gesperrt/);
    assert.match(f(0xc0000071), /abgelaufen/);
    assert.match(f(0xc0000224), /geändert/);
    assert.match(f(0xc000015b), /Recht/);
    assert.match(f(0xc0000072), /deaktiviert/);
    assert.equal(ntStatusText(0xc0000999), undefined);
  });

  test('Unbekannte Codes und andere Fehler behalten die bisherige Erklaerung', () => {
    assert.match(humanizeError(new RdpAuthError('CredSSP: Server meldet Fehler 0xc0009999', 0xc0009999)), /falscher Benutzername/);
    assert.match(humanizeError(new RdpError('Zeitueberschreitung beim TCP-Verbindungsaufbau', 'RDP_TIMEOUT')), /Zeitüberschreitung/);
  });
});
