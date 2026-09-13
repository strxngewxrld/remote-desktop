// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  OutputChannel,
  Uri,
  antworten,
  einstellungen,
  notizen,
  window as fensterAttrappe,
  zuruecksetzen,
  zwischenablage,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RdpSession, bildAusDatenUrl, screenshotDateiname } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import type { RdpConnection } from '../src/connections.js';
import { activate, deactivate } from '../src/extension.js';
import { starteWebview } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

/** Eine gueltige 1x1-PNG-Datei als data:-URL - dieselbe wie in dom.ts. */
const PNG_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ------------------------------------------------------------ Vorschlagsname

describe('Screenshot - Vorschlagsname', () => {
  const zeit = new Date(2026, 8, 12, 9, 5, 3); // 12.09.2026, 09:05:03 Ortszeit

  test('Der Name nennt Verbindung und Zeitpunkt', () => {
    assert.equal(screenshotDateiname('DC01', zeit), 'DC01_2026-09-12_09-05-03.png');
  });

  test('Einstellige Werte werden aufgefuellt', () => {
    assert.equal(
      screenshotDateiname('X', new Date(2026, 0, 2, 3, 4, 5)),
      'X_2026-01-02_03-04-05.png',
    );
  });

  test('Zeichen, die Windows in Dateinamen nicht nimmt, werden ersetzt', () => {
    assert.equal(
      screenshotDateiname('KUNDE\\DC01: "Prod" <a/b>|?*', zeit),
      'KUNDE_DC01_ _Prod_ _a_b_____2026-09-12_09-05-03.png',
    );
  });

  test('Ein leerer Name faellt auf eine brauchbare Bezeichnung zurueck', () => {
    assert.equal(screenshotDateiname('   ', zeit), 'RDP-Sitzung_2026-09-12_09-05-03.png');
    assert.equal(screenshotDateiname('', zeit), 'RDP-Sitzung_2026-09-12_09-05-03.png');
  });

  test('Die Ortszeit zaehlt, nicht UTC', () => {
    // Wer die Datei spaeter sucht, sucht nach der Uhrzeit auf seiner Uhr.
    const jetzt = new Date();
    const name = screenshotDateiname('N', jetzt);
    assert.ok(name.includes(String(jetzt.getFullYear())), name);
    assert.ok(name.includes(`-${String(jetzt.getDate()).padStart(2, '0')}_`), name);
  });
});

// -------------------------------------------------------------- Bilddaten

describe('Screenshot - Bilddaten aus dem Webview', () => {
  test('Eine PNG-data-URL wird zu den Bytes der Datei', () => {
    const bytes = bildAusDatenUrl(PNG_URL);
    assert.ok(bytes, 'die Daten kommen an');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('Was kein PNG ist, wird nicht durchgereicht', () => {
    // Sonst entstuende eine .png-Datei, die kein Betrachter oeffnen kann.
    assert.equal(bildAusDatenUrl('data:image/png;base64,'), undefined, 'leer');
    assert.equal(bildAusDatenUrl('data:image/png;base64,AAAAAAAAAAAA'), undefined, 'falsche Signatur');
    assert.equal(bildAusDatenUrl('data:image/jpeg;base64,' + PNG_URL.split(',')[1]), undefined, 'falscher Typ');
    assert.equal(bildAusDatenUrl('data:text/html,<b>'), undefined, 'gar kein Bild');
    assert.equal(bildAusDatenUrl(undefined), undefined);
    assert.equal(bildAusDatenUrl(42), undefined);
    assert.equal(bildAusDatenUrl({ dataUrl: PNG_URL }), undefined);
  });

  test('Fuehrender und folgender Leerraum stoert nicht', () => {
    assert.ok(bildAusDatenUrl(`  ${PNG_URL}\n`));
  });
});

// --------------------------------------------------------- Weg aus dem DOM

describe('Screenshot - Weg aus dem Webview', () => {
  function antwort(w: ReturnType<typeof starteWebview>): Record<string, unknown> | undefined {
    return w.gesendet.filter((n) => (n as { type?: string })?.type === 'screenshot').at(-1) as
      | Record<string, unknown>
      | undefined;
  }

  test('Die Bitte des Hosts wird mit den Bilddaten beantwortet', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 800, height: 600, scaling: 'fit', smooth: false });
    w.sende({ type: 'screenshotAnfrage', id: 7 });

    const gesendet = antwort(w);
    assert.equal(gesendet?.id, 7, 'die laufende Nummer kommt zurueck');
    assert.equal(gesendet?.dataUrl, w.bild.datenUrl);
    assert.equal(gesendet?.width, 800);
    assert.equal(gesendet?.height, 600);
  });

  test('Scheitert toDataURL, erfaehrt der Host den Grund', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 800, height: 600, scaling: 'fit', smooth: false });
    w.bild.wirft = 'Tainted canvases may not be exported.';
    w.sende({ type: 'screenshotAnfrage', id: 1 });

    const gesendet = antwort(w);
    assert.equal(gesendet?.dataUrl, undefined, 'ohne Bild werden keine Daten vorgetaeuscht');
    assert.equal(gesendet?.fehler, 'Tainted canvases may not be exported.');
  });

  test('Das Webview versucht keinen eigenen Download', () => {
    // Ein `<a download>` laeuft im Webview von VS Code nicht verlaesslich -
    // deshalb darf im Skript gar kein Downloadversuch stehen.
    assert.doesNotMatch(skript, /createElement\(['"]a['"]\)/);
    assert.doesNotMatch(skript, /\.download\s*=/);
    assert.doesNotMatch(skript, /createObjectURL/);
  });
});

// ------------------------------------------------------------ Weg zur Datei

describe('Screenshot - Weg in die Datei', () => {
  let kontext: ExtensionContext;
  let ausgabe: OutputChannel;
  const offen: RdpSession[] = [];
  const verbindung: RdpConnection = { name: 'DC01', host: '10.0.0.1' };

  async function oeffne(teil: Partial<RdpConnection> = {}): Promise<RdpSession> {
    const sitzung = await RdpSession.open(
      kontext,
      { ...verbindung, ...teil },
      ausgabe,
      new CertificateTrustStore(kontext),
    );
    offen.push(sitzung);
    return sitzung;
  }

  /** Die Sitzung so weit bringen, dass sie etwas zu sichern hat. */
  function hatGezeichnet(index = 0): void {
    notizen.panels[index]!.webview.vomWebview({ type: 'painted', tiles: 3 });
  }

  /** Die Antwort des Webviews nachstellen. */
  async function antworteMit(nachricht: Record<string, unknown>, index = 0): Promise<void> {
    notizen.panels[index]!.webview.vomWebview({ type: 'screenshot', ...nachricht });
    // Das Speichern laeuft asynchron; einmal die Mikrotasks durchlassen.
    await new Promise((weiter) => setTimeout(weiter, 0));
  }

  /** Die zuletzt ans Webview geschickte Bitte um ein Bild. */
  function letzteAnfrage(index = 0): { id?: number } | undefined {
    return notizen.panels[index]!.webview.gesendet
      .filter((n) => (n as { type?: string })?.type === 'screenshotAnfrage')
      .at(-1) as { id?: number } | undefined;
  }

  beforeEach(() => {
    zuruecksetzen();
    kontext = new ExtensionContext();
    ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  });

  afterEach(() => {
    for (const sitzung of offen.splice(0)) sitzung.dispose();
    deactivate();
    kontext.entsorgeAlles();
  });

  test('Ohne Bildschirminhalt wird gar nicht erst gefragt', async () => {
    const sitzung = await oeffne();
    sitzung.screenshot();
    assert.equal(letzteAnfrage(), undefined);
    assert.equal(notizen.hinweise.length, 1, 'stattdessen ein Hinweis');
  });

  test('Die Bilddaten wandern in die gewaehlte Datei', async () => {
    const sitzung = await oeffne();
    hatGezeichnet();
    sitzung.screenshot();
    const id = letzteAnfrage()?.id;
    assert.equal(typeof id, 'number');

    antworten.speicherziele.push(Uri.file('/ziel/bild.png'));
    antworten.meldungen.push(undefined);
    await antworteMit({ id, dataUrl: PNG_URL, width: 800, height: 600 });

    const datei = notizen.geschriebeneDateien.at(-1);
    assert.equal(datei?.pfad, '/ziel/bild.png');
    assert.deepEqual([...datei!.inhalt.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  test('Der Speicherdialog schlaegt Verbindungsname und Zeitstempel vor', async () => {
    const sitzung = await oeffne({ name: 'Kunde A / DC01' });
    hatGezeichnet();
    sitzung.screenshot();

    antworten.speicherziele.push(undefined); // Abbruch im Dialog
    await antworteMit({ id: letzteAnfrage()?.id, dataUrl: PNG_URL });

    const dialog = notizen.speichernDialoge.at(-1);
    assert.match(
      dialog?.defaultUri?.fsPath ?? '',
      /Kunde A _ DC01_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/,
    );
    assert.deepEqual(dialog?.filters, { 'PNG-Bilder': ['png'] });
    assert.equal(notizen.geschriebeneDateien.length, 0, 'ein Abbruch schreibt nichts');
  });

  test('Die Einstellung gibt den vorgeschlagenen Ordner vor', async () => {
    einstellungen.set('rdp.screenshotFolder', '/bilder/rdp');
    const sitzung = await oeffne();
    hatGezeichnet();
    sitzung.screenshot();

    antworten.speicherziele.push(undefined);
    await antworteMit({ id: letzteAnfrage()?.id, dataUrl: PNG_URL });
    assert.match(notizen.speichernDialoge.at(-1)?.defaultUri?.fsPath ?? '', /^\/bilder\/rdp\/DC01_/);
  });

  test('Unbrauchbare Daten werden nicht geschrieben, sondern gemeldet', async () => {
    const sitzung = await oeffne();
    hatGezeichnet();
    sitzung.screenshot();

    await antworteMit({ id: letzteAnfrage()?.id, fehler: 'Tainted canvas' });

    assert.equal(notizen.speichernDialoge.length, 0, 'gar nicht erst nach einem Ort fragen');
    assert.equal(notizen.geschriebeneDateien.length, 0);
    assert.match(notizen.fehlermeldungen.at(-1) ?? '', /Tainted canvas/);
    assert.ok(
      notizen.protokoll.some((z) => z.includes('Screenshot fehlgeschlagen')),
      'und es steht im Protokoll',
    );
  });

  test('Eine veraltete Antwort oeffnet keinen zweiten Dialog', async () => {
    const sitzung = await oeffne();
    hatGezeichnet();
    sitzung.screenshot();
    const alt = letzteAnfrage()!.id!;
    sitzung.screenshot();

    antworten.speicherziele.push(undefined);
    await antworteMit({ id: alt, dataUrl: PNG_URL });
    assert.equal(notizen.speichernDialoge.length, 0, 'die alte Antwort wird verworfen');

    await antworteMit({ id: letzteAnfrage()!.id, dataUrl: PNG_URL });
    assert.equal(notizen.speichernDialoge.length, 1);
  });

  test('Nach dem Speichern laesst sich der Pfad kopieren - das Bild nicht', async () => {
    // `vscode.env.clipboard` kennt ausschliesslich readText/writeText. Ein
    // Bild in die Zwischenablage zu legen, gibt die API nicht her; der Pfad
    // ist das Naechstbeste.
    const sitzung = await oeffne();
    hatGezeichnet();
    sitzung.screenshot();

    antworten.speicherziele.push(Uri.file('/ziel/bild.png'));
    antworten.meldungen.push('Pfad kopieren');
    await antworteMit({ id: letzteAnfrage()?.id, dataUrl: PNG_URL });

    assert.deepEqual(zwischenablage.geschrieben, ['/ziel/bild.png']);
  });

  test('Der Befehl sucht sich die Sitzung und sagt Bescheid, wenn es keine gibt', async () => {
    activate(kontext);
    assert.ok(notizen.befehle.has('rdp.screenshot'), 'der Befehl ist da');
    await notizen.befehle.get('rdp.screenshot')!();
    assert.match(notizen.hinweise.at(-1) ?? '', /keine RDP-Sitzung/);
  });
});

// ---------------------------------------------------------------- Manifest

describe('Screenshot - Knopf im Panel', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes: { menus: Record<string, { command: string; when?: string; group?: string }[]> };
  };

  test('Der Knopf sitzt in der Titelleiste des Sitzungspanels', () => {
    // Einem Webview-Panel gibt man einen Knopf ueber `editor/title`; die
    // Bedingung `activeWebviewPanelId` traegt den viewType des aktiven Panels.
    const eintrag = (manifest.contributes.menus['editor/title'] ?? []).find(
      (e) => e.command === 'rdp.screenshot',
    );
    assert.ok(eintrag, 'rdp.screenshot steht unter menus."editor/title"');
    assert.equal(eintrag.when, 'activeWebviewPanelId == rdpSession');
    assert.match(eintrag.group ?? '', /^navigation/);
  });

  test('Der Befehl bleibt auch in der Befehlspalette erreichbar', () => {
    const versteckt = (manifest.contributes.menus['commandPalette'] ?? []).find(
      (e) => e.command === 'rdp.screenshot',
    );
    assert.equal(versteckt, undefined, 'er ist nicht mit "when": false ausgeblendet');
  });
});
