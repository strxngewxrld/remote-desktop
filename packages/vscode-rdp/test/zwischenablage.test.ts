/**
 * Zwischenablage: Einstellungen, Bruecke und das Rueckfallfeld im Webview.
 *
 * Die Protokoll-PDUs selbst werden in ts-rdp geprueft (test/cliprdr.test.ts);
 * hier geht es um das, was drumherum passiert - also die Uebersetzung der
 * Einstellungen, den Weg in die Zwischenablage von VS Code und zurueck, und
 * das Verhalten, wenn dieser Weg versagt.
 */
import {
  ExtensionContext,
  OutputChannel,
  notizen,
  window as fensterAttrappe,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RdpSession, ZWISCHENABLAGE_BEFEHL } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import type { RdpConnection } from '../src/connections.js';
import {
  Zwischenablagebruecke,
  begrenzeGroesse,
  leseEinstellungen,
  richtungAusEinstellung,
  ZWISCHENABLAGE_VORGABEN,
  type ZwischenablageEinstellungen,
  type ZwischenablageSpeicher,
  type ZwischenablageWebviewNachricht,
} from '../src/zwischenablage.js';
// Der Namensraum `cliprdr` ist der oeffentliche Weg an die PDU-Bauteile;
// hier werden sie gebraucht, um die Gegenseite des Servers nachzuspielen.
import { cliprdr } from 'ts-rdp';

const {
  CB_FORMAT_DATA_RESPONSE,
  CB_FORMAT_LIST,
  CB_RESPONSE_FAIL,
  CB_USE_LONG_FORMAT_NAMES,
  CF_UNICODETEXT,
  buildClipboardCapabilities,
  buildFormatDataRequest,
  buildFormatDataResponse,
  buildFormatList,
  buildMonitorReady,
  kodiereUnicodeText,
  parseCliprdrPdu,
  parseFormatList,
} = cliprdr;
import { starteZwischenablagefeld } from './zwischenablagefeld.js';

// ------------------------------------------------------------ Einstellungen

describe('Zwischenablage - Einstellungen', () => {
  test('Die Richtung wird in die Sprache des Protokolls übersetzt', () => {
    assert.equal(richtungAusEinstellung('both', true), 'beide');
    assert.equal(richtungAusEinstellung('remoteToLocal', true), 'nurLesen');
    assert.equal(richtungAusEinstellung('localToRemote', true), 'nurSchreiben');
  });

  test('Abgeschaltet schlägt jede Richtung', () => {
    for (const wert of ['both', 'remoteToLocal', 'localToRemote', undefined]) {
      assert.equal(richtungAusEinstellung(wert, false), 'aus');
    }
  });

  test('Ein unbekannter Wert fällt auf die Vorgabe zurück, nicht auf mehr Rechte', () => {
    assert.equal(richtungAusEinstellung('alles', true), 'beide');
    assert.equal(richtungAusEinstellung(undefined, true), 'beide');
  });

  test('Die Größengrenze rechnet KiB in Byte und bleibt in Grenzen', () => {
    assert.equal(begrenzeGroesse(1024), 1024 * 1024);
    assert.equal(begrenzeGroesse(1), 1024);
    // Unter 1 KiB passt kein sinnvoller Text; über 64 MiB riegelt ohnehin die
    // Zusammensetzung der Kanalblöcke ab.
    assert.equal(begrenzeGroesse(0), 1024 * 1024, 'unsinnige Werte -> Vorgabe');
    assert.equal(begrenzeGroesse(-4), 1024 * 1024);
    assert.equal(begrenzeGroesse('viel'), 1024 * 1024);
    assert.equal(begrenzeGroesse(1024 * 1024), 64 * 1024 * 1024);
  });

  test('Ohne gesetzte Werte gelten die Vorgaben aus package.json', () => {
    const e = leseEinstellungen((_s, vorgabe) => vorgabe);
    assert.deepEqual(e, {
      aktiv: true,
      richtung: 'beide',
      maxBytes: 1024 * 1024,
      abfrageIntervallMs: ZWISCHENABLAGE_VORGABEN.abfrageIntervallMs,
    });
  });

  test('Das Abfrageintervall wird nach unten begrenzt und lässt sich abschalten', () => {
    const werte: Record<string, unknown> = {};
    const hole = <T>(schluessel: string, vorgabe: T): T =>
      (schluessel in werte ? (werte[schluessel] as T) : vorgabe);

    werte['clipboard.pollIntervalMs'] = 0;
    assert.equal(leseEinstellungen(hole).abfrageIntervallMs, 0, '0 schaltet ab');
    werte['clipboard.pollIntervalMs'] = 5;
    assert.equal(leseEinstellungen(hole).abfrageIntervallMs, 100, 'zu häufig wird gebremst');
    werte['clipboard.pollIntervalMs'] = 2000;
    assert.equal(leseEinstellungen(hole).abfrageIntervallMs, 2000);
    werte['clipboard.pollIntervalMs'] = 'oft';
    assert.equal(leseEinstellungen(hole).abfrageIntervallMs, 0, 'Unsinn schaltet ab statt zu rasen');
  });

  test('Abgeschaltet schlägt bis in die Richtung durch', () => {
    const e = leseEinstellungen(<T>(schluessel: string, vorgabe: T): T =>
      (schluessel === 'clipboard.enabled' ? (false as unknown as T) : vorgabe),
    );
    assert.equal(e.aktiv, false);
    assert.equal(e.richtung, 'aus');
  });
});

// ------------------------------------------------------------------ Brücke

/** Zwischenablage im Arbeitsspeicher, mit einstellbaren Fehlern. */
function speicher(start = ''): ZwischenablageSpeicher & {
  inhalt: string;
  geschrieben: string[];
  gelesen: number;
  lesefehler?: Error;
  schreibfehler?: Error;
} {
  return {
    inhalt: start,
    geschrieben: [] as string[],
    // Gezaehlt, weil "gar nicht erst lesen" bei "nur lesen" eine Zusage ist.
    gelesen: 0,
    lesefehler: undefined as Error | undefined,
    schreibfehler: undefined as Error | undefined,
    lesen(this: { inhalt: string; gelesen: number; lesefehler?: Error }) {
      this.gelesen++;
      return this.lesefehler ? Promise.reject(this.lesefehler) : Promise.resolve(this.inhalt);
    },
    schreiben(this: { inhalt: string; geschrieben: string[]; schreibfehler?: Error }, text: string) {
      if (this.schreibfehler) return Promise.reject(this.schreibfehler);
      this.inhalt = text;
      this.geschrieben.push(text);
      return Promise.resolve();
    },
  };
}

function einstellungen(teil: Partial<ZwischenablageEinstellungen> = {}): ZwischenablageEinstellungen {
  return { aktiv: true, richtung: 'beide', maxBytes: 1024 * 1024, abfrageIntervallMs: 0, ...teil };
}

function neueBruecke(
  teil: Partial<ZwischenablageEinstellungen> = {},
  start = '',
  extra: { warnzeitMs?: number } = {},
) {
  const abl = speicher(start);
  const gesendet: Buffer[] = [];
  const anWebview: ZwischenablageWebviewNachricht[] = [];
  const protokoll: string[] = [];
  const stufen: { stufe: string; text: string }[] = [];
  const bruecke = new Zwischenablagebruecke({
    einstellungen: einstellungen(teil),
    send: (d) => gesendet.push(d),
    speicher: abl,
    anWebview: (n) => anWebview.push(n),
    log: (n, stufe) => {
      protokoll.push(n);
      stufen.push({ stufe: stufe ?? 'info', text: n });
    },
    ...extra,
  });
  const typen = () => gesendet.map((d) => parseCliprdrPdu(d).msgType);
  const letztes = (typ: number) => {
    for (let i = gesendet.length - 1; i >= 0; i--) {
      const pdu = parseCliprdrPdu(gesendet[i]);
      if (pdu.msgType === typ) return pdu;
    }
    return undefined;
  };
  return { bruecke, speicher: abl, gesendet, anWebview, protokoll, stufen, typen, letztes };
}

/** Serverauftakt aus MS-RDPECLIP 1.3.2.1. */
function auftakt(bruecke: Zwischenablagebruecke): void {
  bruecke.verarbeite(buildClipboardCapabilities(CB_USE_LONG_FORMAT_NAMES));
  bruecke.verarbeite(buildMonitorReady());
}

/**
 * Den Auftakt samt der Lesung abwarten, die er anstoesst.
 *
 * Der Handshake liest die lokale Zwischenablage nach, weil sie beim
 * MONITOR_READY noch nicht bekannt sein muss. Wer danach etwas ueber den
 * *eingeschwungenen* Zustand behauptet, muss diese Lesung abwarten.
 */
async function auftaktUndLesung(bruecke: Zwischenablagebruecke): Promise<void> {
  auftakt(bruecke);
  await new Promise((r) => setImmediate(r));
}

describe('Zwischenablage - Brücke zum Server', () => {
  test('Dateien warten auf die Formatbestätigung und bleiben für Bereichsanfragen verfügbar', async () => {
    const u = neueBruecke();
    u.bruecke.verarbeite(buildClipboardCapabilities(0x0e));
    u.bruecke.verarbeite(buildMonitorReady());
    await u.bruecke.pruefeLokal();
    u.bruecke.verarbeite(cliprdr.buildFormatListResponse(true));
    let fertig = false;
    const transfer = u.bruecke.ausDateien([{ name: 'test.txt', data: Buffer.from('abc') }], 1024).then(ok => { fertig = true; return ok; });
    await new Promise(r => setImmediate(r));
    assert.equal(fertig, false);
    assert.equal(parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true })[0]!.name, 'FileGroupDescriptorW');
    u.bruecke.verarbeite(cliprdr.buildFormatListResponse(true));
    assert.equal(await transfer, true);
    await u.bruecke.pruefeLokal();
    u.bruecke.verarbeite(buildFormatDataRequest(cliprdr.FILE_GROUP_DESCRIPTOR));
    assert.equal(u.letztes(CB_FORMAT_DATA_RESPONSE)!.body.readUInt32LE(72), 3);
    u.bruecke.dispose();
  });

  test('Abbruch beendet ein wartendes Einfügen; zu großer Text wird nicht eingefügt', async () => {
    const u = neueBruecke({ maxBytes: 8 });
    await auftaktUndLesung(u.bruecke);
    u.bruecke.verarbeite(cliprdr.buildFormatListResponse(true));
    assert.equal(await u.bruecke.ausEinfuegen('zu groß für acht Bytes'), false);
    const pending = u.bruecke.ausEinfuegen('abc');
    await new Promise(r => setImmediate(r));
    u.bruecke.dispose();
    assert.equal(await pending, false);
  });

  test('Der Handshake kommt beim Client an', () => {
    const u = neueBruecke();
    auftakt(u.bruecke);
    assert.equal(u.bruecke.istBereit, true);
    assert.deepEqual(u.typen(), [0x0007, CB_FORMAT_LIST]);
  });

  test('Text vom Server landet in der Zwischenablage von VS Code', async () => {
    const u = neueBruecke();
    auftakt(u.bruecke);
    u.bruecke.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    u.bruecke.verarbeite(buildFormatDataResponse(kodiereUnicodeText('Hallo\nWelt')));
    // Das Schreiben ist asynchron.
    await new Promise((r) => setImmediate(r));
    assert.equal(u.speicher.inhalt, 'Hallo\nWelt', 'mit lokalen Zeilenenden');
    assert.deepEqual(u.anWebview, [{ type: 'clipboardText', text: 'Hallo\nWelt', fallback: false }]);
  });

  test('Scheitert das Schreiben, geht der Text ins Rückfallfeld und es blendet sich ein', async () => {
    const u = neueBruecke();
    u.speicher.schreibfehler = new Error('Clipboard nicht verfügbar');
    auftakt(u.bruecke);
    u.bruecke.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    u.bruecke.verarbeite(buildFormatDataResponse(kodiereUnicodeText('Rettung')));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(u.anWebview, [{ type: 'clipboardText', text: 'Rettung', fallback: true }]);
    assert.ok(u.protokoll.some((z) => /Rückfallfeld/.test(z)));
  });

  test('Eine Änderung der lokalen Zwischenablage wird gemeldet', async () => {
    const u = neueBruecke({}, 'anfang');
    await auftaktUndLesung(u.bruecke);
    u.gesendet.length = 0;

    u.speicher.inhalt = 'neuer Text';
    assert.equal(await u.bruecke.pruefeLokal(), true);
    const liste = parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true });
    assert.deepEqual(liste.map((f) => f.formatId), [CF_UNICODETEXT, 1]);
  });

  test('Unveränderter Inhalt wird nicht gemeldet', async () => {
    const u = neueBruecke({}, 'gleich');
    // Der Handshake hat den Text bereits gelesen und gemeldet.
    await auftaktUndLesung(u.bruecke);
    u.gesendet.length = 0;
    assert.equal(await u.bruecke.pruefeLokal(), false);
    assert.equal(await u.bruecke.pruefeLokal(), false);
    assert.equal(u.gesendet.length, 0);
  });

  test('Ein Lesefehler beendet die Abfrage, statt sie endlos zu wiederholen', async () => {
    const u = neueBruecke({ abfrageIntervallMs: 1000 });
    await auftaktUndLesung(u.bruecke);
    u.bruecke.starteAbfrage();
    u.speicher.lesefehler = new Error('kein Zugriff');
    assert.equal(await u.bruecke.pruefeLokal(), false);
    assert.ok(u.protokoll.some((z) => /Lesen fehlgeschlagen/.test(z)));
    // Ein zweiter Durchlauf käme nur, wenn die Abfrage noch liefe.
    u.speicher.lesefehler = undefined;
    u.bruecke.dispose();
  });

  test('Der Server bekommt auf Anfrage den zuletzt gesehenen Text', async () => {
    const u = neueBruecke({}, 'für den Server');
    auftakt(u.bruecke);
    await u.bruecke.pruefeLokal();
    u.bruecke.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    const antwort = u.letztes(CB_FORMAT_DATA_RESPONSE)!;
    assert.equal(antwort.body.toString('hex'), kodiereUnicodeText('für den Server').toString('hex'));
  });
});

describe('Zwischenablage - Rückfallfeld auf der Hostseite', () => {
  test('Text aus dem Feld geht an den Server und in die lokale Zwischenablage', async () => {
    const u = neueBruecke();
    auftakt(u.bruecke);
    u.gesendet.length = 0;

    assert.equal(await u.bruecke.ausRueckfallfeld('von Hand'), true);
    assert.equal(u.speicher.inhalt, 'von Hand');
    assert.equal(u.letztes(CB_FORMAT_LIST)!.dataLen > 0, true);
  });

  test('Auch ohne funktionierende Zwischenablage kommt der Text beim Server an', async () => {
    const u = neueBruecke();
    u.speicher.schreibfehler = new Error('kein Zugriff');
    auftakt(u.bruecke);
    u.gesendet.length = 0;

    assert.equal(await u.bruecke.ausRueckfallfeld('trotzdem'), true);
    assert.equal(u.letztes(CB_FORMAT_LIST)!.dataLen > 0, true);
  });

  test('Bei "nur lesen" wird das Senden abgelehnt', async () => {
    const u = neueBruecke({ richtung: 'nurLesen' });
    auftakt(u.bruecke);
    u.gesendet.length = 0;
    assert.equal(await u.bruecke.ausRueckfallfeld('geheim'), false);
    assert.equal(u.gesendet.length, 0);
    assert.ok(u.protokoll.some((z) => /Schreiben ist abgeschaltet/.test(z)));
  });
});

describe('Zwischenablage - Richtung und Grenze in der Brücke', () => {
  test('nur lesen: eine Datenanfrage des Servers wird abgelehnt', async () => {
    const u = neueBruecke({ richtung: 'nurLesen' }, 'lokal');
    auftakt(u.bruecke);
    u.bruecke.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    assert.equal(u.letztes(CB_FORMAT_DATA_RESPONSE)!.msgFlags, CB_RESPONSE_FAIL);
  });

  test('nur schreiben: Text vom Server erreicht die Zwischenablage nicht', async () => {
    const u = neueBruecke({ richtung: 'nurSchreiben' });
    auftakt(u.bruecke);
    u.bruecke.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(u.speicher.geschrieben, []);
    assert.deepEqual(u.anWebview, []);
  });

  test('nur schreiben: es wird gar keine Abfrage gestartet, wenn das Intervall 0 ist', async () => {
    const u = neueBruecke({ richtung: 'nurLesen', abfrageIntervallMs: 100 });
    auftakt(u.bruecke);
    u.bruecke.starteAbfrage();
    u.speicher.inhalt = 'ändert sich';
    assert.equal(await u.bruecke.pruefeLokal(), false, 'bei "nur lesen" wird gar nicht erst gelesen');
    u.bruecke.dispose();
  });

  test('Zu großer Text vom Server erreicht die Zwischenablage nicht', async () => {
    const u = neueBruecke({ maxBytes: 200 });
    auftakt(u.bruecke);
    u.bruecke.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    u.bruecke.verarbeite(buildFormatDataResponse(kodiereUnicodeText('x'.repeat(500))));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(u.speicher.geschrieben, []);
    assert.ok(u.protokoll.some((z) => /Grenze/.test(z)));
  });

  test('Nach dispose() wird nichts mehr gesendet', () => {
    const u = neueBruecke();
    auftakt(u.bruecke);
    u.bruecke.dispose();
    u.gesendet.length = 0;
    u.bruecke.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    assert.equal(u.gesendet.length, 0);
  });

  test('zuruecksetzen() macht die Brücke für einen neuen Handshake bereit', async () => {
    const u = neueBruecke({}, 'derselbe');
    await auftaktUndLesung(u.bruecke);
    u.bruecke.zuruecksetzen();
    assert.equal(u.bruecke.istBereit, false);

    u.gesendet.length = 0;
    await auftaktUndLesung(u.bruecke);
    // Derselbe Inhalt gilt nach dem Zurücksetzen wieder als neu: der zweite
    // Handshake kündigt ihn von sich aus wieder an.
    assert.deepEqual(
      parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true }).map((f) => f.formatId),
      [CF_UNICODETEXT, cliprdr.CF_TEXT],
    );
  });
});

// ------------------------------------------------- Rückfallfeld im Webview

const feldSkript = readFileSync(join(__dirname, '..', '..', 'media', 'clipboard.js'), 'utf8');

describe('Zwischenablage-Feld im Webview', () => {
  test('Das Feld ist anfangs unsichtbar', () => {
    const w = starteZwischenablagefeld(feldSkript);
    assert.equal(w.sichtbar, false);
  });

  test('Der Host kann es ein- und ausblenden', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardPanel', sichtbar: true });
    assert.equal(w.sichtbar, true);
    w.sende({ type: 'clipboardPanel', sichtbar: false });
    assert.equal(w.sichtbar, false);
  });

  test('Text vom Host steht im Feld, ohne es einzublenden', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardText', text: 'vom Server', fallback: false });
    assert.equal(w.feld.value, 'vom Server');
    assert.equal(w.sichtbar, false, 'im Normalfall soll nichts aufpoppen');
  });

  test('Bei fallback blendet sich das Feld von selbst ein und sagt warum', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardText', text: 'gerettet', fallback: true });
    assert.equal(w.sichtbar, true);
    assert.equal(w.feld.value, 'gerettet');
    assert.match(w.status, /nicht geklappt/);
  });

  test('"Senden" schickt den Feldinhalt an den Host', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.feld.value = 'zum Server';
    w.klick('clipboard-send');
    assert.deepEqual(
      w.gesendet.filter((n) => (n as { type: string }).type === 'clipboardSend'),
      [{ type: 'clipboardSend', text: 'zum Server' }],
    );
  });

  test('Ein leeres Feld wird nicht gesendet', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.klick('clipboard-send');
    assert.equal(w.gesendet.filter((n) => (n as { type: string }).type === 'clipboardSend').length, 0);
    assert.match(w.status, /leer/);
  });

  test('"Lokal kopieren" nutzt die Clipboard-API im Klick selbst', async () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.feld.value = 'abholen';
    w.klick('clipboard-copy');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.browserZwischenablage, ['abholen']);
    assert.match(w.status, /kopiert/);
  });

  test('Verweigert der Browser das Kopieren, wird der Text markiert', async () => {
    // Genau der Fall, für den es das Feld gibt: die Async Clipboard API
    // verliert die Benutzergeste und lehnt ab.
    const w = starteZwischenablagefeld(feldSkript, { kopierenSchlaegtFehl: true });
    w.feld.value = 'von Hand';
    w.klick('clipboard-copy');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.browserZwischenablage, []);
    assert.equal(w.feld.markiert, true);
    assert.match(w.status, /Strg\+C/);
  });

  test('Fehlt die Clipboard-API ganz, gibt es keinen Absturz', async () => {
    const w = starteZwischenablagefeld(feldSkript, { ohneClipboardApi: true });
    w.feld.value = 'trotzdem';
    w.klick('clipboard-copy');
    await new Promise((r) => setImmediate(r));
    assert.equal(w.feld.markiert, true);
    assert.match(w.status, /Strg\+C/);
  });

  test('"Nur lesen" sperrt den Senden-Knopf', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardConfig', aktiv: true, richtung: 'remoteToLocal' });
    assert.equal(w.knopf('clipboard-send').disabled, true);
    assert.equal(w.knopf('clipboard-copy').disabled, false);
  });

  test('"Nur schreiben" sperrt den Kopieren-Knopf', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardConfig', aktiv: true, richtung: 'localToRemote' });
    assert.equal(w.knopf('clipboard-send').disabled, false);
    assert.equal(w.knopf('clipboard-copy').disabled, true);
  });

  test('Abgeschaltet schließt das Feld und sperrt beides', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardPanel', sichtbar: true });
    w.sende({ type: 'clipboardConfig', aktiv: false, richtung: 'both' });
    assert.equal(w.sichtbar, false);
    assert.equal(w.knopf('clipboard-send').disabled, true);
    assert.equal(w.feld.readOnly, true);
  });

  test('Escape schließt das Feld und geht nicht an die Sitzung weiter', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.sende({ type: 'clipboardPanel', sichtbar: true });
    const ereignis = w.taste('Escape');
    assert.equal(w.sichtbar, false);
    assert.equal(ereignis.gestoppt, true, 'main.js darf die Taste nicht auch noch sehen');
  });

  test('Strg+Enter sendet', () => {
    const w = starteZwischenablagefeld(feldSkript);
    w.feld.value = 'schnell';
    w.taste('Enter', { ctrlKey: true });
    assert.deepEqual(
      w.gesendet.filter((n) => (n as { type: string }).type === 'clipboardSend'),
      [{ type: 'clipboardSend', text: 'schnell' }],
    );
  });

  test('Gewöhnliche Tasten bleiben im Feld, ohne die Sitzung zu erreichen', () => {
    const w = starteZwischenablagefeld(feldSkript);
    const ereignis = w.taste('a');
    assert.equal(ereignis.gestoppt, false);
    assert.equal(ereignis.verhindert, false);
  });

  test('Die Brücke zum Host wird für main.js weitergereicht', () => {
    // acquireVsCodeApi() lässt sich nur einmal je Webview aufrufen. Ohne diesen
    // Ersatz bekäme main.js einen Fehler und das Webview bliebe schwarz.
    const w = starteZwischenablagefeld(feldSkript);
    const zweiterAufruf = w.fensterApi();
    assert.ok(zweiterAufruf, 'window.acquireVsCodeApi muss ersetzt worden sein');
    zweiterAufruf.postMessage({ type: 'test' });
    assert.deepEqual(w.gesendet.at(-1), { type: 'test' });
  });
});

// -------------------------------------------------------------- HTML-Gerüst

describe('Zwischenablage - HTML des Webviews', () => {
  const quelle = readFileSync(join(__dirname, '..', '..', 'src', 'webview.ts'), 'utf8');

  test('Alle vom Skript gesuchten Elemente stehen im HTML', () => {
    for (const id of [
      'clipboard-panel',
      'clipboard-text',
      'clipboard-send',
      'clipboard-copy',
      'clipboard-close',
      'clipboard-status',
    ]) {
      assert.ok(quelle.includes(`id="${id}"`), `Element ${id} fehlt im HTML`);
      assert.ok(feldSkript.includes(`'${id}'`), `Element ${id} wird vom Skript nicht gesucht`);
    }
  });

  test('clipboard.js wird vor main.js geladen', () => {
    // Sonst hat main.js acquireVsCodeApi() schon verbraucht und clipboard.js
    // bekommt einen Fehler.
    const clip = quelle.indexOf('src="${clipboardScript}"');
    const main = quelle.indexOf('src="${script}"');
    assert.ok(clip > 0 && main > 0);
    assert.ok(clip < main, 'clipboard.js muss zuerst kommen');
  });

  test('Das Feld startet ausgeblendet', () => {
    assert.match(quelle, /<div id="clipboard-panel" hidden>/);
  });
});

// ------------------------------------------------------ Befehl in der Sitzung

describe('Zwischenablage - Befehl fürs Rückfallfeld', () => {
  const verbindung: RdpConnection = { name: 'Prüfstand', host: '127.0.0.1', port: 3389 };
  let kontext: ExtensionContext;
  let ausgabe: OutputChannel;
  const offen: RdpSession[] = [];

  async function oeffne(): Promise<RdpSession> {
    const sitzung = await RdpSession.open(kontext, { ...verbindung }, ausgabe, new CertificateTrustStore(kontext));
    offen.push(sitzung);
    return sitzung;
  }

  /** Die letzte Nachricht eines Typs an das Webview. */
  function letzte(typ: string): Record<string, unknown> | undefined {
    const panel = notizen.panels.at(-1)!;
    const alle = panel.webview.gesendet.filter((n) => (n as { type?: string })?.type === typ);
    return alle.at(-1) as Record<string, unknown> | undefined;
  }

  beforeEach(() => {
    zuruecksetzen();
    kontext = new ExtensionContext();
    ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  });

  afterEach(() => {
    for (const sitzung of offen.splice(0)) sitzung.dispose();
    kontext.entsorgeAlles();
  });

  test('Der Befehl bleibt nach Sitzungsende bis zur Deaktivierung registriert', async () => {
    assert.equal(notizen.befehle.has(ZWISCHENABLAGE_BEFEHL), false);
    const sitzung = await oeffne();
    assert.equal(notizen.befehle.has(ZWISCHENABLAGE_BEFEHL), true);
    sitzung.dispose();
    offen.length = 0;
    assert.equal(notizen.befehle.has(ZWISCHENABLAGE_BEFEHL), true);
    kontext.entsorgeAlles();
    assert.equal(notizen.befehle.has(ZWISCHENABLAGE_BEFEHL), false);
  });

  test('Eine zweite Sitzung scheitert nicht an der Befehlsregistrierung', async () => {
    await oeffne();
    await assert.doesNotReject(() => oeffne());
    assert.equal(notizen.befehle.has(ZWISCHENABLAGE_BEFEHL), true);
  });

  test('Der Befehl blendet das Feld ein und wieder aus', async () => {
    await oeffne();
    await notizen.befehle.get(ZWISCHENABLAGE_BEFEHL)!();
    assert.equal(letzte('clipboardPanel')?.sichtbar, true);
    await notizen.befehle.get(ZWISCHENABLAGE_BEFEHL)!();
    assert.equal(letzte('clipboardPanel')?.sichtbar, false);
  });

  test('applyConfiguration schickt Richtung und Schalterzustand ans Webview', async () => {
    const sitzung = await oeffne();
    sitzung.applyConfiguration();
    assert.deepEqual(letzte('clipboardConfig'), {
      type: 'clipboardConfig',
      aktiv: true,
      richtung: 'both',
    });
  });
});

// -------------------------------------------------- Protokoll des Handshakes

/**
 * Warum diese Tests: Beim Nutzer stand der Kanal, und trotzdem tat sich
 * nichts. Aus dem Mitschnitt liess sich nicht ablesen, an welcher Stelle von
 * MS-RDPECLIP 1.3.2.1 der Ablauf haengen blieb - weil ein stiller Kanal
 * genauso aussieht wie ein ruhiger. Diese Zeilen muessen also da sein.
 */
describe('Zwischenablage - Formatliste beim Handshake', () => {
  test('Kommt MONITOR_READY vor der ersten Lesung, wird die Formatliste nachgereicht', async () => {
    // Genau der Fall aus dem Betrieb: der Server ist mit seinem Auftakt
    // schneller als vscode.env.clipboard.readText(). Ohne Nachreichen glaubt
    // der Server, die Zwischenablage sei leer, und fragt nie nach Daten.
    const u = neueBruecke({}, 'schon vorhanden');
    auftakt(u.bruecke);
    assert.deepEqual(
      parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true }).map((f) => f.formatId),
      [],
      'zuerst geht notgedrungen eine leere Liste hinaus',
    );

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true }).map((f) => f.formatId),
      [CF_UNICODETEXT, cliprdr.CF_TEXT],
      'danach stehen die tatsaechlich vorhandenen Formate beim Server',
    );
    assert.equal(u.typen().filter((t) => t === CB_FORMAT_LIST).length, 2);
  });

  test('War der Text schon gelesen, bleibt es bei einer einzigen Formatliste', async () => {
    const u = neueBruecke({}, 'schon vorhanden');
    await u.bruecke.pruefeLokal();
    await auftaktUndLesung(u.bruecke);
    assert.equal(
      u.typen().filter((t) => t === CB_FORMAT_LIST).length,
      1,
      'kein zweites, gleichlautendes Melden',
    );
    assert.deepEqual(
      parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true }).map((f) => f.formatId),
      [CF_UNICODETEXT, cliprdr.CF_TEXT],
    );
  });

  test('Ohne lokalen Text bleibt die Liste leer und wird nicht nachgereicht', async () => {
    const u = neueBruecke({}, '');
    await auftaktUndLesung(u.bruecke);
    assert.equal(u.typen().filter((t) => t === CB_FORMAT_LIST).length, 1);
    assert.deepEqual(
      parseFormatList(u.letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true }),
      [],
    );
  });

  test('Bei "nur lesen" wird die lokale Zwischenablage gar nicht erst angefasst', async () => {
    const u = neueBruecke({ richtung: 'nurLesen' }, 'geheim');
    await auftaktUndLesung(u.bruecke);
    assert.equal(u.speicher.gelesen, 0, 'kein Blick in fremde Zwischenablagen');
  });
});

describe('Zwischenablage - Protokoll des Handshakes', () => {
  test('Jedes PDU steht mit Namen und Richtung im Protokoll', async () => {
    const u = neueBruecke({}, 'lokal');
    // Die Zwischenablage wird asynchron gelesen; die volle Formatliste geht
    // deshalb erst nach dem Auftakt hinaus.
    await auftaktUndLesung(u.bruecke);
    const debug = u.stufen.filter((z) => z.stufe === 'debug').map((z) => z.text);
    assert.ok(
      debug.some((z) => z.includes('empfangen CLIP_CAPS')),
      `CLIP_CAPS fehlt: ${debug.join(' | ')}`,
    );
    assert.ok(debug.some((z) => z.includes('empfangen MONITOR_READY')));
    assert.ok(debug.some((z) => z.includes('gesendet CLIP_CAPS')));
    assert.ok(debug.some((z) => z.includes('gesendet FORMAT_LIST')));
    assert.ok(
      debug.some((z) => z.includes('melde 2 Format(e)') && z.includes('lange Formatnamen')),
      `die gemeldeten Formate fehlen: ${debug.join(' | ')}`,
    );
  });

  test('Erst die Bestätigung aller Formatlisten beendet das Warten', async () => {
    const u = neueBruecke({}, 'lokal');
    await auftaktUndLesung(u.bruecke);
    assert.equal(u.bruecke.wartetAufFormatlistenAntwort, true, 'nach dem Handshake wird gewartet');
    u.bruecke.verarbeite(cliprdr.buildFormatListResponse(true));
    assert.equal(u.bruecke.wartetAufFormatlistenAntwort, true, 'die nachgereichte lokale Formatliste ist noch offen');
    u.bruecke.verarbeite(cliprdr.buildFormatListResponse(true));
    assert.equal(u.bruecke.wartetAufFormatlistenAntwort, false);
    assert.ok(u.stufen.some((z) => z.stufe === 'debug' && /bestaetigt/.test(z.text)));
    assert.equal(u.stufen.filter((z) => z.stufe === 'warn').length, 0);
  });

  test('Bleibt die Antwort aus, steht es genau einmal als Warnung da', async () => {
    const u = neueBruecke({}, 'lokal', { warnzeitMs: 5 });
    await auftaktUndLesung(u.bruecke);
    await new Promise((r) => setTimeout(r, 20));
    const warnungen = u.stufen.filter((z) => z.stufe === 'warn');
    assert.equal(warnungen.length, 1, `genau eine Warnung erwartet: ${JSON.stringify(warnungen)}`);
    assert.match(warnungen[0].text, /FORMAT_LIST_RESPONSE/);
    assert.match(warnungen[0].text, /PDU gesendet, 2 empfangen/);

    // Eine zweite unbeantwortete Formatliste darf die Zeile nicht wiederholen.
    u.speicher.inhalt = 'etwas Neues';
    await u.bruecke.pruefeLokal();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(u.stufen.filter((z) => z.stufe === 'warn').length, 1);
    u.bruecke.dispose();
  });

  test('Eine abgelehnte Formatliste ist eine Warnung, keine Beiläufigkeit', async () => {
    const u = neueBruecke({}, 'lokal');
    await auftaktUndLesung(u.bruecke);
    u.bruecke.verarbeite(cliprdr.buildFormatListResponse(false));
    const warnungen = u.stufen.filter((z) => z.stufe === 'warn');
    assert.equal(warnungen.length, 1);
    assert.match(warnungen[0].text, /abgelehnt/);
  });

  test('Die Formate des Servers und die Datenanfrage stehen im Protokoll', () => {
    const u = neueBruecke();
    auftakt(u.bruecke);
    u.bruecke.verarbeite(
      buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }),
    );
    const debug = u.stufen.filter((z) => z.stufe === 'debug').map((z) => z.text);
    assert.ok(debug.some((z) => z.includes('der Server bietet 1 Format(e) an')));
    assert.ok(debug.some((z) => z.includes(`frage die Daten von Format ${CF_UNICODETEXT}`)));
  });

  test('Ohne regelmäßige Abfrage sagt das Protokoll, dass lokal niemand mitliest', () => {
    const u = neueBruecke({ abfrageIntervallMs: 0 });
    auftakt(u.bruecke);
    u.bruecke.starteAbfrage();
    assert.ok(
      u.stufen.some((z) => z.stufe === 'debug' && /keine regelmaessige Abfrage/.test(z.text)),
      `Hinweis fehlt: ${u.protokoll.join(' | ')}`,
    );
  });
});
