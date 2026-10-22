// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  OutputChannel,
  WebviewPanel,
  einstellungen,
  notizen,
  window as fensterAttrappe,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RdpDiagnostics } from 'ts-rdp';
import {
  DIAGNOSE_BEFEHL,
  DIAGNOSE_ZUSTAND_SCHLUESSEL,
  RdpSession,
  dauerText,
  diagnoseZeilen,
  mengeText,
  type DiagnoseProbe,
} from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import type { RdpConnection } from '../src/connections.js';
import { starteWebview } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

// ------------------------------------------------------------------ Hilfen

/** Rohwerte, wie `getDiagnostics()` sie liefert - alle Felder belegt. */
function rohwerte(teil: Partial<RdpDiagnostics> = {}): RdpDiagnostics {
  return {
    bitmaps: 0,
    updateCodes: {},
    supportsRefreshRect: true,
    activations: 1,
    ioChannelId: 1003,
    frames: { fastpath: 0, slowpath: 0, verworfen: 0 },
    sharePduTypes: {},
    dataPduTypes: {},
    virtualChannelBytes: {},
    dynamicChannels: [],
    graphicsBytes: 0,
    graphicsCodecs: {},
    graphicsAvc: { regionen: 0, bytes: 0 },
    ...teil,
  };
}

function probe(zeit: number, teil: Partial<DiagnoseProbe> = {}): DiagnoseProbe {
  return {
    zeit,
    diagnostics: rohwerte(),
    anWebviewBytes: 0,
    anWebviewKacheln: 0,
    letztesBild: 0,
    ...teil,
  };
}

/** Sucht eine Zeile des Overlays am Namen. */
function wert(zeilen: { name: string; wert: string }[], name: string): string {
  const treffer = zeilen.find((z) => z.name === name);
  assert.ok(treffer, `Zeile "${name}" fehlt (vorhanden: ${zeilen.map((z) => z.name).join(', ')})`);
  return treffer.wert;
}

const verbindung: RdpConnection = { name: 'Prüfstand', host: '127.0.0.1', port: 3389 };

// ---------------------------------------------------------- Kennzahlen

describe('Diagnose - Kennzahlen aufbereiten', () => {
  test('Ohne Verbindung stehen Groesse und ein klarer Hinweis da', () => {
    const zeilen = diagnoseZeilen(probe(1000, { diagnostics: undefined }), undefined, {
      breite: 1280,
      hoehe: 800,
      verbundenSeit: 0,
      base64: false,
    });
    assert.equal(wert(zeilen, 'Sitzung'), '1280×800 · –');
    assert.equal(wert(zeilen, 'Verbindung'), 'steht nicht');
  });

  test('Die erste Messung zeigt Staende, aber noch keine Raten', () => {
    const zeilen = diagnoseZeilen(
      probe(1000, { diagnostics: rohwerte({ bitmaps: 40, frames: { fastpath: 12, slowpath: 3, verworfen: 0 } }) }),
      undefined,
      { breite: 800, hoehe: 600, verbundenSeit: 1000, base64: false },
    );
    assert.equal(wert(zeilen, 'Kacheln'), '40');
    assert.equal(wert(zeilen, 'Rahmen'), '15 (12 fast / 3 slow)');
  });

  test('Zwei Messungen im Sekundenabstand ergeben Raten', () => {
    const vorher = probe(1000, {
      diagnostics: rohwerte({ bitmaps: 40, graphicsBytes: 1024 * 1024 }),
      anWebviewBytes: 0,
    });
    const jetzt = probe(2000, {
      diagnostics: rohwerte({ bitmaps: 100, graphicsBytes: 3 * 1024 * 1024 }),
      anWebviewBytes: 2048,
      anWebviewKacheln: 60,
      letztesBild: 1880,
    });
    const zeilen = diagnoseZeilen(jetzt, vorher, {
      breite: 800,
      hoehe: 600,
      verbundenSeit: 1000,
      rttMs: 4,
      base64: false,
    });

    assert.equal(wert(zeilen, 'Kacheln'), '100 · 60/s');
    assert.equal(wert(zeilen, 'eGFX entpackt'), '3.0 MB · 2.0 MB/s');
    assert.equal(wert(zeilen, 'An Webview'), '2.0 kB · 2.0 kB/s · 60 Kacheln');
    assert.equal(wert(zeilen, 'Letztes Bild'), 'vor 120 ms');
    assert.equal(wert(zeilen, 'Webview-RTT'), '4 ms');
    assert.equal(wert(zeilen, 'Sitzung'), '800×600 · 00:01');
  });

  test('Der halbe Messabstand verdoppelt die Rate nicht', () => {
    // Der Zeitgeber laeuft nicht auf die Millisekunde genau; wird der Zuwachs
    // ungeteilt als "pro Sekunde" gemeldet, springt die Anzeige grundlos.
    const zeilen = diagnoseZeilen(
      probe(1500, { diagnostics: rohwerte({ bitmaps: 30 }) }),
      probe(1000, { diagnostics: rohwerte({ bitmaps: 10 }) }),
      { breite: 800, hoehe: 600, verbundenSeit: 1000, base64: false },
    );
    assert.equal(wert(zeilen, 'Kacheln'), '30 · 40/s');
  });

  test('Codecs stehen mit Klarnamen und nach Haeufigkeit sortiert', () => {
    const zeilen = diagnoseZeilen(
      probe(2000, {
        diagnostics: rohwerte({ graphicsCodecs: { '0x8': 5, '0x9': 120, '0xa': 40 } }),
      }),
      probe(1000, { diagnostics: rohwerte({ graphicsCodecs: { '0x9': 100 } }) }),
      { breite: 800, hoehe: 600, verbundenSeit: 1000, base64: false },
    );
    // Progressive fuehrt, ClearCodec ist neu hinzugekommen und zaehlt ab null.
    assert.equal(wert(zeilen, 'Codecs'), 'Progressive 120 · 20/s, Planar 40 · 40/s, ClearCodec 5 · 5/s');
  });

  test('Ohne Graphics Pipeline steht dort "keine", nicht eine leere Zeile', () => {
    const zeilen = diagnoseZeilen(probe(1000), undefined, {
      breite: 800,
      hoehe: 600,
      verbundenSeit: 1000,
      base64: false,
    });
    assert.equal(wert(zeilen, 'Codecs'), 'keine');
  });

  test('H.264 und Aktivierungen erscheinen nur, wenn es sie gibt', () => {
    const ohne = diagnoseZeilen(probe(1000), undefined, {
      breite: 800,
      hoehe: 600,
      verbundenSeit: 1000,
      base64: false,
    });
    assert.equal(
      ohne.find((z) => z.name === 'H.264'),
      undefined,
    );
    assert.equal(
      ohne.find((z) => z.name === 'Aktivierungen'),
      undefined,
    );

    const mit = diagnoseZeilen(
      probe(1000, { diagnostics: rohwerte({ graphicsAvc: { regionen: 7, bytes: 2048 }, activations: 2 }) }),
      undefined,
      { breite: 800, hoehe: 600, verbundenSeit: 1000, base64: false },
    );
    assert.equal(wert(mit, 'H.264'), '7 Regionen · 2.0 kB');
    assert.equal(wert(mit, 'Aktivierungen'), '2');
  });

  test('Kanalbytes werden ueber alle Kanaele summiert', () => {
    const zeilen = diagnoseZeilen(
      probe(2000, { diagnostics: rohwerte({ virtualChannelBytes: { 1004: 1024, 1005: 3072 } }) }),
      probe(1000, { diagnostics: rohwerte({ virtualChannelBytes: { 1004: 1024 } }) }),
      { breite: 800, hoehe: 600, verbundenSeit: 1000, base64: false },
    );
    assert.equal(wert(zeilen, 'Kanäle'), '4.0 kB · 3.0 kB/s');
  });

  test('Der Base64-Umweg steht in der Kopfzeile - er kostet Leistung', () => {
    const zeilen = diagnoseZeilen(probe(1000), undefined, {
      breite: 800,
      hoehe: 600,
      verbundenSeit: 1000,
      base64: true,
    });
    assert.ok(wert(zeilen, 'Sitzung').endsWith('· Base64'), wert(zeilen, 'Sitzung'));
  });

  test('Mengen und Dauern werden lesbar geschrieben', () => {
    assert.equal(mengeText(512), '512 B');
    assert.equal(mengeText(2048), '2.0 kB');
    assert.equal(mengeText(5 * 1024 * 1024), '5.0 MB');
    assert.equal(dauerText(0), '00:00');
    assert.equal(dauerText(65_000), '01:05');
    assert.equal(dauerText(3_725_000), '1:02:05');
  });
});

// ------------------------------------------------------------- Umschalten

describe('Diagnose - umschalten', () => {
  let kontext: ExtensionContext;
  let ausgabe: OutputChannel;
  const offen: RdpSession[] = [];

  async function oeffne(): Promise<RdpSession> {
    const sitzung = await RdpSession.open(kontext, { ...verbindung }, ausgabe, new CertificateTrustStore(kontext));
    offen.push(sitzung);
    return sitzung;
  }

  function letzteDiagnoseNachricht(panel: WebviewPanel): { sichtbar: boolean; zeilen?: unknown[] } | undefined {
    const alle = panel.webview.gesendet.filter((n) => (n as { type?: string })?.type === 'diagnose');
    return alle.at(-1) as { sichtbar: boolean; zeilen?: unknown[] } | undefined;
  }

  beforeEach(() => {
    zuruecksetzen();
    kontext = new ExtensionContext();
    ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  });

  afterEach(() => {
    // Wichtig: dispose beendet den Zeitgeber des Overlays und gibt den Befehl
    // wieder frei - sonst haengt der naechste Test an einer alten Registrierung.
    for (const sitzung of offen.splice(0)) sitzung.dispose();
    kontext.entsorgeAlles();
  });

  test('Der Befehl bleibt nach Sitzungsende bis zur Deaktivierung registriert', async () => {
    assert.equal(notizen.befehle.has(DIAGNOSE_BEFEHL), false);
    const sitzung = await oeffne();
    assert.equal(notizen.befehle.has(DIAGNOSE_BEFEHL), true);
    sitzung.dispose();
    offen.length = 0;
    assert.equal(notizen.befehle.has(DIAGNOSE_BEFEHL), true);
    kontext.entsorgeAlles();
    assert.equal(notizen.befehle.has(DIAGNOSE_BEFEHL), false);
  });

  test('Eine zweite Sitzung scheitert nicht an der Befehlsregistrierung', async () => {
    await oeffne();
    await assert.doesNotReject(() => oeffne());
    assert.equal(notizen.befehle.has(DIAGNOSE_BEFEHL), true);
  });

  test('Der Befehl schaltet ein und wieder aus', async () => {
    const sitzung = await oeffne();
    const panel = notizen.panels[0]!;
    assert.equal(sitzung.diagnoseAktiv, false);

    await notizen.befehle.get(DIAGNOSE_BEFEHL)!();
    assert.equal(sitzung.diagnoseAktiv, true);
    assert.equal(letzteDiagnoseNachricht(panel)?.sichtbar, true);
    assert.ok(letzteDiagnoseNachricht(panel)?.zeilen, 'die erste Messung geht sofort mit');

    await notizen.befehle.get(DIAGNOSE_BEFEHL)!();
    assert.equal(sitzung.diagnoseAktiv, false);
    assert.equal(letzteDiagnoseNachricht(panel)?.sichtbar, false);
  });

  test('Der Befehl wirkt auf alle offenen Sitzungen', async () => {
    const eine = await oeffne();
    const andere = await oeffne();
    await notizen.befehle.get(DIAGNOSE_BEFEHL)!();
    assert.equal(eine.diagnoseAktiv, true);
    assert.equal(andere.diagnoseAktiv, true);
  });

  test('Der Zustand ueberdauert die Sitzung', async () => {
    const erste = await oeffne();
    await notizen.befehle.get(DIAGNOSE_BEFEHL)!();
    assert.equal(kontext.globalState.get(DIAGNOSE_ZUSTAND_SCHLUESSEL), true);
    erste.dispose();
    offen.length = 0;

    const zweite = await oeffne();
    assert.equal(zweite.diagnoseAktiv, true, 'die neue Sitzung nimmt den gemerkten Zustand an');
  });

  test('Die Einstellung entscheidet, solange nichts umgeschaltet wurde', async () => {
    einstellungen.set('rdp.diagnostics.showOnStart', true);
    const sitzung = await oeffne();
    assert.equal(sitzung.diagnoseAktiv, true);

    // Umschalten hat Vorrang: danach zaehlt der gemerkte Zustand, nicht mehr
    // die Einstellung.
    await notizen.befehle.get(DIAGNOSE_BEFEHL)!();
    assert.equal(sitzung.diagnoseAktiv, false);
    sitzung.dispose();
    offen.length = 0;

    const zweite = await oeffne();
    assert.equal(zweite.diagnoseAktiv, false);
  });
});

// ---------------------------------------------------------------- Webview

describe('Diagnose - Overlay im Webview', () => {
  /** Startet ein Webview mit eingeblendetem Overlay. */
  function mitOverlay(): ReturnType<typeof starteWebview> {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    w.sende({ type: 'diagnose', sichtbar: true, titel: 'Prüfstand', zeilen: [] });
    return w;
  }

  /** Eine Bitmap-Nachricht mit einer Kachel bekannter Groesse. */
  function bitmap(w: number, h: number): unknown {
    const laenge = w * h * 4;
    return {
      type: 'bitmap',
      rects: [{ x: 0, y: 0, w, h, offset: 0, length: laenge }],
      data: new Uint8Array(laenge),
    };
  }

  test('Ohne Nachricht bleibt das Overlay unsichtbar', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    assert.equal(w.diagnose.sichtbar, false);
  });

  test('Die Zeilen des Hosts erscheinen mit den eigenen Messwerten', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    w.sende({
      type: 'diagnose',
      sichtbar: true,
      titel: 'Prüfstand',
      zeilen: [{ name: 'Kacheln', wert: '100 · 60/s' }],
    });

    assert.equal(w.diagnose.sichtbar, true);
    assert.equal(w.diagnose.titel, 'Prüfstand');
    assert.match(w.diagnose.text, /Kacheln:\s+100 · 60\/s/);
    // Was nur der Renderer weiss, steht ebenfalls da.
    assert.match(w.diagnose.text, /Bildrate:/);
    assert.match(w.diagnose.text, /Fläche:\s+1076×536/);
  });

  test('Gezeichnete Kacheln zaehlen mit', () => {
    const w = mitOverlay();
    w.sende(bitmap(8, 4));
    w.sende(bitmap(8, 4));
    w.sende({ type: 'diagnose', sichtbar: true, titel: 'Prüfstand', zeilen: [] });

    assert.equal(w.gezeichnet.length, 2);
    assert.match(w.diagnose.text, /Gezeichnet:.*2 Kacheln/);
    assert.match(w.diagnose.text, /Zuletzt:\s+vor \d+ ms/);
  });

  test('Bei ausgeblendetem Overlay wird nichts gemessen', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    // Ohne Overlay gezeichnet - diese Kacheln duerfen spaeter nicht auftauchen.
    w.sende(bitmap(8, 4));
    w.sende(bitmap(8, 4));
    assert.equal(w.gezeichnet.length, 2, 'gezeichnet wird trotzdem');

    w.sende({ type: 'diagnose', sichtbar: true, titel: 'Prüfstand', zeilen: [] });
    assert.match(w.diagnose.text, /Gezeichnet:.*0 Kacheln/);
    assert.match(w.diagnose.text, /Zuletzt:\s+nichts gezeichnet/);
  });

  test('Ausblenden raeumt das Overlay weg', () => {
    const w = mitOverlay();
    w.sende(bitmap(8, 4));
    w.sende({ type: 'diagnose', sichtbar: false });
    assert.equal(w.diagnose.sichtbar, false);
    assert.equal(w.diagnose.text, '');

    // Und faengt danach wieder bei null an.
    w.sende({ type: 'diagnose', sichtbar: true, titel: 'Prüfstand', zeilen: [] });
    assert.match(w.diagnose.text, /Gezeichnet:.*0 Kacheln/);
  });

  test('Auf einen Ping antwortet das Webview sofort mit derselben Nummer', () => {
    const w = mitOverlay();
    w.sende({ type: 'diagnosePing', seq: 7 });
    const pong = w.gesendet.filter((n) => (n as { type?: string })?.type === 'diagnosePong');
    assert.deepEqual(pong, [{ type: 'diagnosePong', seq: 7 }]);
  });

  test('Das Overlay faengt keine Eingaben ab', () => {
    // Belegt am Stylesheet, nicht am Verhalten: im Webview gibt es keine
    // Treffererkennung, die sich pruefen liesse - die Regel ist die Zusage.
    const css = readFileSync(join(__dirname, '..', '..', 'media', 'main.css'), 'utf8');
    const block = css.slice(css.indexOf('#diagnose {'), css.indexOf('}', css.indexOf('#diagnose {')));
    assert.match(block, /pointer-events:\s*none/);
    assert.match(block, /var\(--vscode-/, 'die Farben kommen aus dem Thema');
  });
});
