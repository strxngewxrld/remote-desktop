import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { starteWebview, VideoOptionen, WebviewUmgebung } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

/** SPS, PPS und IDR-Scheibe - so, wie sie in avcFrame.ts erkannt werden. */
const SCHLUESSELBILD = [
  0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f,
  0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0xb0,
  0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00,
];
const FOLGEBILD = [0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00, 0x21];

interface Videoteile {
  schluesselbild?: boolean;
  hatParametersaetze?: boolean;
  codecString?: string;
  bereiche?: Array<{ sx: number; sy: number; breite: number; hoehe: number; zx: number; zy: number }>;
  bytes?: number[];
}

/** Eine 'video'-Nachricht, wie session.ts sie zusammenstellt. */
function videoNachricht(teile: Videoteile = {}): unknown {
  const schluesselbild = teile.schluesselbild ?? true;
  const bytes = teile.bytes ?? (schluesselbild ? SCHLUESSELBILD : FOLGEBILD);
  return {
    type: 'video',
    codecString: 'codecString' in teile ? teile.codecString : 'avc1.64001f',
    schluesselbild,
    hatParametersaetze: teile.hatParametersaetze ?? schluesselbild,
    bereiche: teile.bereiche ?? [{ sx: 0, sy: 0, breite: 64, hoehe: 64, zx: 10, zy: 20 }],
    data: new Uint8Array(bytes),
    laenge: bytes.length,
  };
}

/** Eine Kachelnachricht mit genau einer Kachel. */
function kachelNachricht(x: number, y: number, w: number, h: number): unknown {
  return {
    type: 'bitmap',
    rects: [{ x, y, w, h, offset: 0, length: w * h * 4 }],
    data: new Uint8Array(w * h * 4),
  };
}

function starte(optionen: VideoOptionen = {}): WebviewUmgebung {
  const w = starteWebview(skript, optionen);
  w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
  return w;
}

/** Die letzte Rueckfallmeldung des Webviews, falls es eine gab. */
function rueckfall(w: WebviewUmgebung): string | undefined {
  const treffer = w.gesendet.filter((m) => (m as { type?: string }).type === 'avcRueckfall');
  return treffer.length ? (treffer[treffer.length - 1] as { message: string }).message : undefined;
}

describe('Webview - Verfuegbarkeitspruefung fuer WebCodecs', () => {
  test('Die ready-Nachricht meldet vorhandene WebCodecs', () => {
    const w = starteWebview(skript);
    const bereit = w.gesendet.find((m) => (m as { type?: string }).type === 'ready') as { webCodecs: boolean };
    assert.equal(bereit.webCodecs, true);
  });

  test('Ohne VideoDecoder meldet ready ausdruecklich false', () => {
    // Der Host haengt daran seine Entscheidung auf, ob er H.264 ueberhaupt
    // beim Server anmeldet. Ein falsches true hier hiesse: der Server stellt
    // um, und wir haetten nichts, womit wir das Ergebnis anzeigen koennten.
    const w = starteWebview(skript, { vorhanden: false });
    const bereit = w.gesendet.find((m) => (m as { type?: string }).type === 'ready') as { webCodecs: boolean };
    assert.equal(bereit.webCodecs, false);
  });

  test('Ohne VideoDecoder wird ein trotzdem eintreffendes Teilbild sauber verworfen', async () => {
    const w = starte({ vorhanden: false });
    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.videobilder.length, 0);
    assert.match(rueckfall(w) ?? '', /WebCodecs/);
  });

  test('isConfigSupported wird mit dem Codecnamen aus dem SPS gefragt', async () => {
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.video.geprueft.length, 1);
    assert.equal(w.video.geprueft[0].codec, 'avc1.64001f');
  });

  test('Ein nicht unterstuetzter Codec fuehrt zum Rueckfall, nicht zu einem Decoder', async () => {
    const w = starte({ unterstuetzt: () => false });
    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.video.konfiguriert.length, 0, 'es wird nichts konfiguriert');
    assert.equal(w.video.haeppchen.length, 0, 'und nichts dekodiert');
    assert.match(rueckfall(w) ?? '', /avc1\.64001f/);
  });

  test('Wirft isConfigSupported, wird das als Rueckfall behandelt', async () => {
    const w = starte({ konfigurationWirft: true });
    w.sende(videoNachricht());
    await w.ruhe();
    assert.notEqual(rueckfall(w), undefined);
  });

  test('Ein Decoderfehler zur Laufzeit fuehrt in den Rueckfall', async () => {
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.video.haeppchen.length, 1);
    w.video.loeseFehlerAus('Hardware weg');
    assert.match(rueckfall(w) ?? '', /Hardware weg/);
    assert.equal(w.video.geschlossen, true, 'der Decoder wird geschlossen');

    // Danach wird nichts mehr hineingegeben.
    w.sende(videoNachricht({ schluesselbild: false }));
    await w.ruhe();
    assert.equal(w.video.haeppchen.length, 1);
  });

  test('Nach dem Rueckfall zeichnet der Kachelweg unveraendert weiter', async () => {
    const w = starte({ unterstuetzt: () => false });
    w.sende(videoNachricht());
    await w.ruhe();
    w.sende(kachelNachricht(4, 8, 16, 16));
    await w.ruhe();
    assert.equal(w.gezeichnet.length, 1, 'die Kachel kommt an');
    assert.deepEqual([w.gezeichnet[0].x, w.gezeichnet[0].y], [4, 8]);
  });
});

describe('Webview - Konfiguration des Decoders', () => {
  test('Die Konfiguration traegt kein description - der Strom ist Annex B', async () => {
    // MS-RDPEGFX 2.2.4.4 verlangt das Byte-Stream-Format nach Annex B, also
    // NAL-Einheiten mit Startcodes. `description` gehoert zum AVCC-Format mit
    // Laengenpraefixen; gesetzt bei Annex B gibt der Decoder stumm nichts aus.
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.video.konfiguriert.length, 1);
    assert.ok(!('description' in w.video.konfiguriert[0]), 'description darf nicht gesetzt sein');
    assert.equal(w.video.konfiguriert[0].codec, 'avc1.64001f');
  });

  test('Ohne Parametersaetze wird noch gar nicht konfiguriert', async () => {
    // SPS und PPS muessen vor dem ersten Bild da sein. Fehlen sie, wird
    // gewartet statt aufgegeben - das naechste Schluesselbild bringt beide mit.
    const w = starte();
    w.sende(videoNachricht({ schluesselbild: false, hatParametersaetze: false, codecString: undefined }));
    await w.ruhe();
    assert.equal(w.video.geprueft.length, 0);
    assert.equal(rueckfall(w), undefined, 'das ist kein Grund aufzugeben');

    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.video.konfiguriert.length, 1);
  });

  test('Konfiguriert wird genau einmal, nicht bei jedem Teilbild', async () => {
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    w.sende(videoNachricht({ schluesselbild: false }));
    w.sende(videoNachricht({ schluesselbild: false }));
    await w.ruhe();
    assert.equal(w.video.konfiguriert.length, 1);
    assert.equal(w.video.geprueft.length, 1);
  });
});

describe('Webview - key und delta', () => {
  test('Ein Schluesselbild geht als key hinein, ein Folgebild als delta', async () => {
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    w.sende(videoNachricht({ schluesselbild: false }));
    await w.ruhe();
    assert.deepEqual(
      w.video.haeppchen.map((h) => h.type),
      ['key', 'delta'],
    );
  });

  test('Ein Folgebild vor dem ersten Schluesselbild wird verworfen', async () => {
    // Ohne Bezugsbild liefert ein Folgebild je nach Decoder Muell oder einen
    // Fehler. Verwerfen ist das einzig Richtige - der Server schickt in Kuerze
    // ein Schluesselbild.
    const w = starte();
    w.sende(videoNachricht({ schluesselbild: false, hatParametersaetze: true }));
    await w.ruhe();
    assert.equal(w.video.haeppchen.length, 0);
    assert.equal(w.videobilder.length, 0);
    assert.equal(rueckfall(w), undefined);

    w.sende(videoNachricht());
    await w.ruhe();
    assert.deepEqual(
      w.video.haeppchen.map((h) => h.type),
      ['key'],
    );
  });

  test('Der Bitstrom geht unveraendert durch', async () => {
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    assert.equal(w.video.haeppchen[0].laenge, SCHLUESSELBILD.length);
    assert.deepEqual(w.video.haeppchen[0].ersteBytes, SCHLUESSELBILD.slice(0, 4));
  });

  test('Die Zeitstempel steigen, damit die Reihenfolge eindeutig ist', async () => {
    const w = starte();
    w.sende(videoNachricht());
    await w.ruhe();
    w.sende(videoNachricht({ schluesselbild: false }));
    await w.ruhe();
    assert.ok(w.video.haeppchen[1].timestamp > w.video.haeppchen[0].timestamp);
  });
});

describe('Webview - Regionen landen an der richtigen Stelle', () => {
  test('Quelle und Ziel eines Bereichs werden getrennt uebergeben', async () => {
    const w = starte();
    w.sende(
      videoNachricht({
        bereiche: [{ sx: 128, sy: 64, breite: 96, hoehe: 48, zx: 168, zy: 89 }],
      }),
    );
    await w.ruhe();
    assert.deepEqual(w.videobilder, [
      { sx: 128, sy: 64, sw: 96, sh: 48, dx: 168, dy: 89, dw: 96, dh: 48 },
    ]);
  });

  test('Mehrere Bereiche eines Teilbildes werden alle gezeichnet, in ihrer Reihenfolge', async () => {
    const w = starte();
    w.sende(
      videoNachricht({
        bereiche: [
          { sx: 0, sy: 0, breite: 16, hoehe: 16, zx: 0, zy: 0 },
          { sx: 64, sy: 32, breite: 32, hoehe: 32, zx: 64, zy: 32 },
          { sx: 8, sy: 8, breite: 8, hoehe: 8, zx: 8, zy: 8 },
        ],
      }),
    );
    await w.ruhe();
    assert.deepEqual(
      w.videobilder.map((b) => b.sx),
      [0, 64, 8],
    );
  });

  test('Eine leere Bereichsliste wird trotzdem dekodiert, aber nicht gezeichnet', async () => {
    // Das ist der Fall einer noch nicht abgebildeten Surface. Der Bitstrom
    // muss durch den Decoder, sonst fehlt spaeteren Folgebildern ihr Bezug.
    const w = starte();
    w.sende(videoNachricht({ bereiche: [] }));
    await w.ruhe();
    assert.equal(w.video.haeppchen.length, 1, 'dekodiert wurde');
    assert.equal(w.videobilder.length, 0, 'gezeichnet wurde nichts');
  });
});

describe('Webview - AVC ergaenzt den Kachelweg, es ersetzt ihn nicht', () => {
  test('Ohne jede video-Nachricht wird eine Kachel unmittelbar gezeichnet', () => {
    // Die harte Anforderung: bei abgeschalteter Einstellung kommt nie eine
    // 'video'-Nachricht, und dann muss der Zeichenweg genau der alte sein -
    // synchron, ohne Warteschlange, ohne Zusagen. Deshalb hier bewusst kein
    // await: waere der Kachelweg in die Kette gewandert, faende dieser Test
    // nichts.
    const w = starte();
    w.sende(kachelNachricht(10, 20, 8, 4));
    assert.equal(w.gezeichnet.length, 1);
    assert.deepEqual([w.gezeichnet[0].x, w.gezeichnet[0].y], [10, 20]);
    assert.equal(w.video.geprueft.length, 0, 'kein Decoder wird auch nur angefasst');
  });

  test('Auch viele Kacheln hintereinander bleiben ohne Videobild synchron', () => {
    const w = starte();
    for (let i = 0; i < 5; i++) w.sende(kachelNachricht(i * 8, 0, 8, 8));
    assert.equal(w.gezeichnet.length, 5);
  });

  test('Nach einem Videobild bleibt die Reihenfolge beider Wege erhalten', async () => {
    // Beide malen auf dieselbe Flaeche. Ueberholte eine spaeter eingetroffene
    // Kachel das Videobild, malte aelterer Inhalt ueber neueren.
    const w = starte();
    w.sende(kachelNachricht(0, 0, 8, 8));
    w.sende(videoNachricht());
    w.sende(kachelNachricht(32, 0, 8, 8));
    await w.ruhe();
    assert.deepEqual(w.protokoll, ['kachel', 'video', 'kachel']);
  });

  test('Mehrere Videobilder und Kacheln im Wechsel behalten ihre Reihenfolge', async () => {
    const w = starte();
    w.sende(videoNachricht());
    w.sende(kachelNachricht(0, 0, 4, 4));
    w.sende(videoNachricht({ schluesselbild: false }));
    w.sende(kachelNachricht(8, 0, 4, 4));
    w.sende(videoNachricht({ schluesselbild: false }));
    await w.ruhe();
    assert.deepEqual(w.protokoll, ['video', 'kachel', 'video', 'kachel', 'video']);
  });

  test('Ein haengender Decoder haelt die Kacheln nicht dauerhaft auf', async () => {
    // Ohne die Zeitschranke im Renderer stuende hier das ganze Bild still -
    // auch die 80 Prozent, die gar nicht durch H.264 gehen.
    const w = starte({ nieAusgeben: true });
    w.sende(videoNachricht());
    w.sende(kachelNachricht(16, 16, 8, 8));
    await w.ruhe(50);
    assert.equal(w.gezeichnet.length, 0, 'kurz nach dem Videobild wartet die Kachel noch');
    await w.ruhe(1200);
    assert.equal(w.gezeichnet.length, 1, 'nach der Zeitschranke laeuft es weiter');
    assert.equal(w.videobilder.length, 0, 'das ausgebliebene Videobild wird nicht gezeichnet');
  });
});
