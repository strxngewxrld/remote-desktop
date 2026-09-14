// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  OutputChannel,
  antworten,
  dateien,
  einstellungen,
  notizen,
  setzeArbeitsbereichsOrdner,
  window as fensterAttrappe,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockRdpServer } from './ts-rdp-quelle/test/mockServer.js';
import { RdpSession } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import { secretKey } from '../src/connections.js';
import type { RdpConnection } from '../src/connections.js';
// Der Namensraum `rdpdr` traegt die Konstanten und Baufunktionen des
// Protokolls; nur die haeufig gebrauchten Namen stehen zusaetzlich oben im
// Modul.
import { rdpdr } from 'ts-rdp';

/**
 * Die Laufwerksumleitung in einer echten Sitzung.
 *
 * Der Schwerpunkt liegt auf der Rueckfallebene: abgeschaltete Einstellung,
 * leerer Arbeitsbereich, verweigerte Freigabe. In all diesen Faellen muss
 * sich die Sitzung genau wie ohne diese Erweiterung verhalten - ein
 * Protokolleintrag, keine Fehlermeldung, keine abgebrochene Verbindung.
 */

const SERVER_BREITE = 800;
const SERVER_HOEHE = 600;

function erzeugeTestzertifikat(): { cert: string; key: string; ordner: string } {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-rdp-laufwerk-'));
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

async function warteBis(pruefe: () => boolean, was: string, ms = 10000): Promise<void> {
  const ende = Date.now() + ms;
  while (!pruefe()) {
    if (Date.now() > ende) throw new Error(`Zeitablauf beim Warten auf: ${was}`);
    await new Promise((weiter) => setTimeout(weiter, 5));
  }
}

let zertifikat: { cert: string; key: string; ordner: string };
let server: MockRdpServer;
let port: number;
const offeneSitzungen: RdpSession[] = [];

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
  einstellungen.set('rdp.certificateTrust', 'ignore');
  einstellungen.set('rdp.connectTimeout', 10000);
  // Die Zwischenablage stoert hier nur - sie meldet einen zweiten Kanal an.
  einstellungen.set('rdp.clipboard.enabled', false);
});

afterEach(async () => {
  for (const abraeumen of aufraeumer.splice(0)) abraeumen();
  for (const sitzung of offeneSitzungen.splice(0)) sitzung.dispose();
  await new Promise((weiter) => setTimeout(weiter, 20));
});

interface Pruefstand {
  sitzung: RdpSession;
  ausgabe: OutputChannel;
  kontext: ExtensionContext;
}

async function starteSitzung(): Promise<Pruefstand> {
  const kontext = new ExtensionContext();
  const ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  const verbindung: RdpConnection = {
    name: 'Pruefstand',
    host: '127.0.0.1',
    port,
    username: 'tester',
  };
  await kontext.secrets.store(secretKey(verbindung), 'geheim');
  const sitzung = await RdpSession.open(kontext, verbindung, ausgabe, new CertificateTrustStore(kontext));
  offeneSitzungen.push(sitzung);
  const panel = notizen.panels.at(-1)!;
  panel.webview.vomWebview({ type: 'ready', width: 1024, height: 768, devicePixelRatio: 1 });
  return { sitzung, ausgabe, kontext };
}

/**
 * Den RDPDR-Auftakt vom Server aus fahren (MS-RDPEFS 3.3.5.1).
 *
 * Der Mock-Server eroeffnet den Kanal, faehrt aber von sich aus kein
 * Protokoll. Erst dieses Anstossen bringt die Sitzung dazu, ihre Laufwerke zu
 * ermitteln - und damit die Rueckfrage zu stellen.
 */
function serverAuftakt(): void {
  const announce = Buffer.alloc(8);
  announce.writeUInt16LE(1, 0);
  announce.writeUInt16LE(0x000c, 2);
  announce.writeUInt32LE(0x0000beef, 4);
  server.sendStaticChannelData('rdpdr', rdpdr.buildRdpdrPdu(rdpdr.RDPDR_CTYP_CORE, rdpdr.PAKID_CORE_SERVER_ANNOUNCE, announce));

  const general = Buffer.alloc(44);
  general.writeUInt16LE(0x0001, 0); // CAP_GENERAL_TYPE
  general.writeUInt16LE(44, 2);
  general.writeUInt32LE(2, 4); // GENERAL_CAPABILITY_VERSION_02
  general.writeUInt16LE(1, 16);
  general.writeUInt16LE(0x000c, 18);
  general.writeUInt32LE(0x0000ffff, 20);
  general.writeUInt32LE(0x00000007, 28);
  const drive = Buffer.alloc(8);
  drive.writeUInt16LE(0x0004, 0); // CAP_DRIVE_TYPE
  drive.writeUInt16LE(8, 2);
  drive.writeUInt32LE(2, 4);
  const kopf = Buffer.alloc(4);
  kopf.writeUInt16LE(2, 0);
  server.sendStaticChannelData(
    'rdpdr',
    rdpdr.buildRdpdrPdu(rdpdr.RDPDR_CTYP_CORE, rdpdr.PAKID_CORE_SERVER_CAPABILITY, Buffer.concat([kopf, general, drive])),
  );

  // DR_CORE_SERVER_CLIENTID_CONFIRM (2.2.2.6). Ohne diese Bestaetigung
  // kuendigt der Client nichts an - 3.2.5.1.9 verlangt Faehigkeiten *und*
  // Bestaetigung. Ab Nebenversion 12 uebernimmt der Client unsere ClientId,
  // wir koennen sie also hier wiederholen.
  const bestaetigung = Buffer.alloc(8);
  bestaetigung.writeUInt16LE(1, 0);
  bestaetigung.writeUInt16LE(0x000c, 2);
  bestaetigung.writeUInt32LE(0x0000beef, 4);
  server.sendStaticChannelData(
    'rdpdr',
    rdpdr.buildRdpdrPdu(rdpdr.RDPDR_CTYP_CORE, rdpdr.PAKID_CORE_CLIENTID_CONFIRM, bestaetigung),
  );
}

/** Alles mitschreiben, was der Client auf rdpdr schickt. */
function horcheAufRdpdr(): { packetIds: number[] } {
  const gesehen = { packetIds: [] as number[] };
  const horcher = (e: { name: string; data: Buffer }): void => {
    if (e.name !== 'rdpdr') return;
    gesehen.packetIds.push(rdpdr.parseRdpdrPdu(e.data).packetId);
  };
  server.on('staticChannelData', horcher);
  aufraeumer.push(() => server.off('staticChannelData', horcher));
  return gesehen;
}

/** Nach jedem Test abzuraeumen - sonst horchen die Horcher weiter. */
const aufraeumer: (() => void)[] = [];

/** Steht die Zeile irgendwo im Sitzungsprotokoll? */
function protokollEnthaelt(ausgabe: OutputChannel, teil: string): boolean {
  return ausgabe.zeilen.some((z) => z.includes(teil));
}

describe('Laufwerk in der Sitzung - Anmeldung des Kanals', () => {
  test('Mit der Einstellung an wird rdpdr im Client Network Data angemeldet', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    dateien.set('/arbeit/frontend/README.md', Buffer.from('# x\n'));
    antworten.meldungen.push('Freigeben');
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    assert.equal(server.virtualChannelIds.has('rdpdr'), true);
    await warteBis(() => protokollEnthaelt(ausgabe, 'Kanal rdpdr bereit'), 'Bereitmeldung');
    assert.ok(protokollEnthaelt(ausgabe, 'Client-Build: unbundled-test; Diagnose: drive-v3;'));
    assert.ok(protokollEnthaelt(ausgabe, '1 Workspace-Ordner'));
    const intern = sitzung as any;
    intern.protokolliereLaufwerkDiagnose(intern.client, intern.laufwerk);
    assert.ok(protokollEnthaelt(ausgabe, 'empfangen=0 Byte'));
    assert.ok(protokollEnthaelt(ausgabe, '"serverAnnounce":false'));
    assert.ok(protokollEnthaelt(ausgabe, 'Freigabe-Rückfrage ist noch nicht erreicht'));
  });

  test('Mit der Einstellung aus wird der Kanal gar nicht erst angemeldet', async () => {
    einstellungen.set('rdp.driveRedirection.enabled', false);
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    assert.equal(server.virtualChannelIds.has('rdpdr'), false);
    await warteBis(
      () => protokollEnthaelt(ausgabe, 'Laufwerk: in den Einstellungen abgeschaltet'),
      'Protokolleintrag',
    );
    // Entscheidend: keine Fehlermeldung, und die Sitzung steht.
    assert.deepEqual(notizen.fehlermeldungen, []);
    assert.equal(sitzung.isConnected, true);
  });
});

describe('Laufwerk in der Sitzung - Rueckfallebenen', () => {
  test('Ohne geoeffneten Ordner wird nicht einmal gefragt', async () => {
    // Ein Fenster ohne Arbeitsbereich ist der Normalfall beim schnellen
    // Nachschlagen; eine modale Rueckfrage waere dort nur im Weg.
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => protokollEnthaelt(ausgabe, 'Kanal rdpdr bereit'), 'Bereitmeldung');
    const gesehen = horcheAufRdpdr();
    serverAuftakt();
    await warteBis(
      () => protokollEnthaelt(ausgabe, 'kein Ordner im Arbeitsbereich geöffnet'),
      'Protokolleintrag',
    );
    assert.deepEqual(notizen.warnungen, [], 'es darf keine Rückfrage gestellt werden');
    assert.equal(gesehen.packetIds.includes(rdpdr.PAKID_CORE_DEVICELIST_ANNOUNCE), false);
    assert.deepEqual(notizen.fehlermeldungen, []);
    assert.equal(sitzung.isConnected, true);
  });

  test('Eine verweigerte Freigabe laesst die Sitzung unberuehrt', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    antworten.meldungen.push('Nicht freigeben');
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => protokollEnthaelt(ausgabe, 'Kanal rdpdr bereit'), 'Bereitmeldung');
    const gesehen = horcheAufRdpdr();
    serverAuftakt();
    await warteBis(() => protokollEnthaelt(ausgabe, 'Freigabe für'), 'Protokolleintrag');
    assert.equal(gesehen.packetIds.includes(rdpdr.PAKID_CORE_DEVICELIST_ANNOUNCE), false);
    assert.deepEqual(notizen.fehlermeldungen, []);
    assert.equal(sitzung.isConnected, true);
  });

  test('Mit Freigabe geht die Geraeteliste hinaus', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    dateien.set('/arbeit/frontend/README.md', Buffer.from('# x\n'));
    antworten.meldungen.push('Freigeben');
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => protokollEnthaelt(ausgabe, 'Kanal rdpdr bereit'), 'Bereitmeldung');
    const gesehen = horcheAufRdpdr();
    serverAuftakt();
    await warteBis(() => gesehen.packetIds.includes(rdpdr.PAKID_CORE_DEVICELIST_ANNOUNCE), 'Geräteliste');
    assert.equal(protokollEnthaelt(ausgabe, 'gebe 1 Ordner frei'), true);
  });

  test('Ein Server ohne RDPDR-Auftakt laesst die Sitzung unberuehrt', async () => {
    // Der Mock-Server eroeffnet den Kanal, schickt aber nie ein Server
    // Announce. Dann passiert schlicht nichts - kein Handshake, keine
    // Geraeteliste, kein Fehler.
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await new Promise((weiter) => setTimeout(weiter, 100));
    assert.equal(protokollEnthaelt(ausgabe, 'angekuendigt'), false);
    assert.deepEqual(notizen.fehlermeldungen, []);
    assert.equal(sitzung.isConnected, true);
  });

  test('Die Einstellung wird beim Verbinden gelesen, nicht beim Aktivieren', async () => {
    einstellungen.set('rdp.driveRedirection.access', 'readWrite');
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => protokollEnthaelt(ausgabe, 'lesen und schreiben'), 'Rechteangabe im Protokoll');
  });

  test('Eine Aenderung am Arbeitsbereich landet im Protokoll', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const { sitzung, ausgabe } = await starteSitzung();
    await warteBis(() => sitzung.isConnected, 'aktive Sitzung');
    await warteBis(() => protokollEnthaelt(ausgabe, 'Kanal rdpdr bereit'), 'Bereitmeldung');
    setzeArbeitsbereichsOrdner(['/arbeit/frontend', '/arbeit/neu']);
    await warteBis(() => protokollEnthaelt(ausgabe, 'Arbeitsbereich geändert'), 'Aenderungsmeldung');
    assert.equal(protokollEnthaelt(ausgabe, '+ neu'), true);
  });
});

describe('Laufwerk in der Sitzung - Befehl zum Vergessen der Freigaben', () => {
  test('Mit der ersten Sitzung gibt es den Befehl, mit der letzten ist er wieder weg', async () => {
    assert.equal(notizen.befehle.has('rdp.forgetDriveApprovals'), false);
    const { sitzung } = await starteSitzung();
    assert.equal(notizen.befehle.has('rdp.forgetDriveApprovals'), true);
    sitzung.dispose();
    offeneSitzungen.length = 0;
    assert.equal(notizen.befehle.has('rdp.forgetDriveApprovals'), false);
  });

  test('Der Befehl loescht die gemerkten Antworten', async () => {
    const { kontext } = await starteSitzung();
    await kontext.globalState.update('rdp.driveRedirection.freigaben', { 'a:3389': 'verweigert' });
    await notizen.befehle.get('rdp.forgetDriveApprovals')!();
    assert.equal(kontext.globalState.get('rdp.driveRedirection.freigaben'), undefined);
    assert.equal(notizen.hinweise.some((h) => h.includes('vergessen')), true);
  });
});
