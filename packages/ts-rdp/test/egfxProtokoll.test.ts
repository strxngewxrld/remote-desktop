/**
 * Die Protokollierung der Graphics Pipeline ist selbst ein Werkzeug und wird
 * deshalb geprueft wie jedes andere: an einem echten Server laesst sich der
 * Bildfehler nicht nachstellen, also muss der Mitschnitt die Fragen
 * beantworten, die wir sonst am Debugger klaeren wuerden.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BinaryWriter } from '../src/core/binary.js';
import { EgfxSession } from '../src/protocol/egfxSession.js';
import { ProgressiveDecoder } from '../src/codec/progressive.js';
import { DecodedBitmap } from '../src/protocol/updates.js';
import { LogLevel, Logger } from '../src/core/log.js';
import * as egfx from '../src/protocol/egfx.js';

interface Mitschnitt {
  sitzung: EgfxSession;
  zeilen: Array<{ stufe: LogLevel; text: string }>;
  /** Alle Zeilen einer Stufe als eine Zeichenkette - bequem fuer Suchen. */
  auf: (stufe: LogLevel) => string;
  /**
   * Nimmt die fertigen Kacheln entgegen. Ueberschreibbar, damit ein Test das
   * tatsaechliche Bild einsammeln kann und nicht nur den Mitschnitt.
   */
  bilder: (tiles: DecodedBitmap[]) => void;
}

function baueSitzung(): Mitschnitt {
  const zeilen: Array<{ stufe: LogLevel; text: string }> = [];
  const merke =
    (stufe: LogLevel) =>
    (text: string): void => {
      zeilen.push({ stufe, text });
    };
  const log: Logger = {
    error: merke('error'),
    warn: merke('warn'),
    info: merke('info'),
    debug: merke('debug'),
    trace: merke('trace'),
  };
  const mitschnitt: Mitschnitt = {
    sitzung: undefined as unknown as EgfxSession,
    zeilen,
    auf: (stufe) =>
      zeilen
        .filter((z) => z.stufe === stufe)
        .map((z) => z.text)
        .join('\n'),
    bilder: () => {},
  };
  mitschnitt.sitzung = new EgfxSession({
    log,
    send: () => {},
    onBitmap: (tiles) => mitschnitt.bilder(tiles),
    onResize: () => {},
  });
  return mitschnitt;
}

/** RDPGFX_HEADER (2.2.1.5) um einen Rumpf. */
function pdu(cmdId: number, body: Buffer): Buffer {
  return new BinaryWriter().uint16le(cmdId).uint16le(0).uint32le(8 + body.length).bytes(body).toBuffer();
}

function createSurface(surfaceId: number, width: number, height: number, pixelFormat: number): Buffer {
  return pdu(
    egfx.RDPGFX_CMDID_CREATESURFACE,
    new BinaryWriter().uint16le(surfaceId).uint16le(width).uint16le(height).uint8(pixelFormat).toBuffer(),
  );
}

function mapToOutput(surfaceId: number, x: number, y: number): Buffer {
  return pdu(
    egfx.RDPGFX_CMDID_MAPSURFACETOOUTPUT,
    new BinaryWriter().uint16le(surfaceId).uint16le(0).uint32le(x).uint32le(y).toBuffer(),
  );
}

function startFrame(frameId: number): Buffer {
  return pdu(egfx.RDPGFX_CMDID_STARTFRAME, new BinaryWriter().uint32le(0).uint32le(frameId).toBuffer());
}

function endFrame(frameId: number): Buffer {
  return pdu(egfx.RDPGFX_CMDID_ENDFRAME, new BinaryWriter().uint32le(frameId).toBuffer());
}

function unkomprimiert(surfaceId: number, rect: number[], marke: number): Buffer {
  const [left, top, right, bottom] = rect;
  const daten = Buffer.alloc((right - left) * (bottom - top) * 4, marke);
  return pdu(
    egfx.RDPGFX_CMDID_WIRETOSURFACE_1,
    new BinaryWriter()
      .uint16le(surfaceId)
      .uint16le(egfx.RDPGFX_CODECID_UNCOMPRESSED)
      .uint8(egfx.PIXEL_FORMAT_XRGB_8888)
      .uint16le(left)
      .uint16le(top)
      .uint16le(right)
      .uint16le(bottom)
      .uint32le(daten.length)
      .bytes(daten)
      .toBuffer(),
  );
}

function cacheToSurface(cacheSlot: number, surfaceId: number, punkte: number[][]): Buffer {
  const w = new BinaryWriter().uint16le(cacheSlot).uint16le(surfaceId).uint16le(punkte.length);
  for (const [x, y] of punkte) w.int16le(x).int16le(y);
  return pdu(egfx.RDPGFX_CMDID_CACHETOSURFACE, w.toBuffer());
}

function surfaceToSurface(src: number, ziel: number, rect: number[], punkte: number[][]): Buffer {
  const [left, top, right, bottom] = rect;
  const w = new BinaryWriter()
    .uint16le(src)
    .uint16le(ziel)
    .uint16le(left)
    .uint16le(top)
    .uint16le(right)
    .uint16le(bottom)
    .uint16le(punkte.length);
  for (const [x, y] of punkte) w.int16le(x).int16le(y);
  return pdu(egfx.RDPGFX_CMDID_SURFACETOSURFACE, w.toBuffer());
}

function surfaceToCache(surfaceId: number, cacheSlot: number, rect: number[]): Buffer {
  const [left, top, right, bottom] = rect;
  return pdu(
    egfx.RDPGFX_CMDID_SURFACETOCACHE,
    new BinaryWriter()
      .uint16le(surfaceId)
      .uint32le(0x11223344)
      .uint32le(0)
      .uint16le(cacheSlot)
      .uint16le(left)
      .uint16le(top)
      .uint16le(right)
      .uint16le(bottom)
      .toBuffer(),
  );
}

describe('Graphics Pipeline - Protokollierung jedes Befehls', () => {
  test('Ein Puffer mit fuenf Befehlen meldet alle fuenf, nicht nur den ersten', () => {
    const m = baueSitzung();
    // Genau die Form, die der echte Server schickt: der Puffer traegt mehrere
    // Befehle hintereinander. Frueher wurde nur der erste protokolliert,
    // weshalb ENDFRAME und MAPSURFACETOOUTPUT im Mitschnitt nie auftauchten.
    m.sitzung.handle(
      Buffer.concat([
        createSurface(1, 128, 64, egfx.PIXEL_FORMAT_XRGB_8888),
        mapToOutput(1, 0, 0),
        startFrame(9),
        unkomprimiert(1, [0, 0, 16, 16], 0x40),
        endFrame(9),
      ]),
    );
    const alles = m.zeilen.map((z) => z.text).join('\n');
    for (const name of ['CREATESURFACE', 'MAPSURFACETOOUTPUT', 'STARTFRAME', 'WIRETOSURFACE_1', 'ENDFRAME']) {
      assert.ok(alles.includes(name), `${name} fehlt im Mitschnitt`);
    }
  });

  test('CREATESURFACE nennt Nummer, Groesse und Pixelformat im Klartext', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(7, 840, 536, egfx.PIXEL_FORMAT_ARGB_8888));
    assert.match(m.auf('info'), /CREATESURFACE 7, 840x536, Pixelformat ARGB_8888/);
  });

  test('MAPSURFACETOOUTPUT nennt Zielkoordinaten und ob die Surface schon bemalt ist', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(3, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(3, 100, 200));
    assert.match(m.auf('info'), /MAPSURFACETOOUTPUT 3 nach \(100, 200\); Surface 64x64, noch unbemalt/);
  });

  test('DELETESURFACE steht mit seiner Nummer im Mitschnitt', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(3, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(pdu(egfx.RDPGFX_CMDID_DELETESURFACE, new BinaryWriter().uint16le(3).toBuffer()));
    assert.match(m.auf('info'), /DELETESURFACE 3/);
  });

  test('Bemalte Bereiche nennen Codec, Zielrechteck und Surface', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 128, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(unkomprimiert(1, [16, 8, 48, 24], 0x40));
    assert.match(
      m.auf('debug'),
      /WIRETOSURFACE_1 Surface 1, Codec UNCOMPRESSED, Pixelformat XRGB_8888, Ziel 32x16\+16\+8, 2048 Byte/,
    );
  });

  test('STARTFRAME und ENDFRAME liegen auf trace, damit debug lesbar bleibt', () => {
    const m = baueSitzung();
    m.sitzung.handle(Buffer.concat([startFrame(1), endFrame(1)]));
    assert.match(m.auf('trace'), /STARTFRAME frameId 1/);
    assert.match(m.auf('trace'), /ENDFRAME frameId 1/);
    assert.ok(!m.auf('debug').includes('STARTFRAME'));
  });
});

describe('Graphics Pipeline - Auffaelligkeiten der Kopierbefehle', () => {
  test('CACHETOSURFACE auf einen nie gefuellten Slot warnt statt stillschweigend nichts zu tun', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(cacheToSurface(42, 1, [[0, 0]]));
    assert.match(m.auf('warn'), /Slot 42, den diese Sitzung nie gefuellt hat/);
  });

  test('Dieselbe Auffaelligkeit warnt nur einmal', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    for (let i = 0; i < 5; i++) m.sitzung.handle(cacheToSurface(42, 1, [[0, 0]]));
    assert.equal(m.zeilen.filter((z) => z.stufe === 'warn').length, 1);
  });

  test('SURFACETOSURFACE aus einer nie bemalten Surface wird uebersprungen statt schwarz kopiert', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(createSurface(2, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(surfaceToSurface(1, 2, [0, 0, 32, 32], [[0, 0]]));
    assert.match(m.auf('warn'), /kopiert aus Surface 1, in die noch nie etwas gemalt wurde/);
    assert.match(m.auf('warn'), /der Zielbereich bleibt stehen/);
    assert.match(m.auf('debug'), /SURFACETOSURFACE von Surface 1 32x32\+0\+0 nach Surface 2, Zielpunkte \(0, 0\)/);
  });

  test('Ein Quellrechteck ausserhalb der Surface wird benannt', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(createSurface(2, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(unkomprimiert(1, [0, 0, 64, 64], 0x20));
    m.sitzung.handle(surfaceToSurface(1, 2, [0, 0, 200, 64], [[0, 0]]));
    assert.match(m.auf('warn'), /liest 200x64\+0\+0 aus Surface 1, die nur 64x64 gross ist/);
  });

  test('SURFACETOCACHE nennt Slot, Schluessel und Quellrechteck', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(unkomprimiert(1, [0, 0, 64, 64], 0x20));
    m.sitzung.handle(surfaceToCache(1, 5, [0, 0, 16, 16]));
    assert.match(m.auf('debug'), /SURFACETOCACHE Surface 1 16x16\+0\+0 -> Slot 5, Schluessel 0x11223344/);
  });

  test('Ein Cacheeintrag aus einer unbemalten Surface wird gar nicht erst angelegt', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(surfaceToCache(1, 5, [0, 0, 16, 16]));
    assert.match(m.auf('warn'), /Slot 5 aus Surface 1 fuellen, deren Puffer hier noch unbemalt ist/);
    assert.match(m.auf('warn'), /der Slot bleibt leer statt schwarz/);
    // Und der leere Slot faellt beim Zugriff auf, statt schwarz zu zeichnen.
    m.sitzung.handle(cacheToSurface(5, 1, [[0, 0]]));
    assert.match(m.auf('warn'), /Slot 5, den diese Sitzung nie gefuellt hat/);
  });
});

/**
 * Der Kodierkontext und die Kachelhistorie sind zwei verschiedene Dinge.
 *
 * MS-RDPEGFX trennt beim Client drei Zustandsbehaelter, und genau diese
 * Trennung hat uns graue Bloecke im Bild gekostet:
 *
 *   - Codec Contexts (3.3.1.1). RDPGFX_DELETE_ENCODING_CONTEXT_PDU raeumt
 *     ausschliesslich diesen (3.3.5.3).
 *   - Progressive Tile Contexts (3.3.1.2): Vorzeichen und Bitposition. Sie
 *     "can be discarded", sobald *alle* zugehoerigen Kodierkontexte weg sind.
 *   - Sub-Band Diffing Tile Contexts (3.3.1.3): die DWT-Koeffizienten, gegen
 *     die RFX_TILE_DIFFERENCE rechnet. Sie "MUST be preserved for the duration
 *     of the RDP connection or until the off-screen surface [...] has been
 *     deleted".
 *
 * Der Ablauf hier ist nicht ausgedacht, sondern aus zwei echten Quellen
 * zusammengesetzt: die Nutzlast stammt aus der Aufzeichnung eines echten
 * Windows-11-Servers (progressive-echt.json), die Kontextgrenzen aus dem
 * Mitschnitt logs/dump.txt. Dort legt der Server fuer praktisch jede
 * Aktualisierung einen eigenen Kodierkontext an und loescht ihn sofort wieder -
 * 329 Kontexte in einer Minute -, und ein Kontext umfasst genau eine Nachricht
 * mit Erstdurchgaengen plus die unmittelbar folgenden Aufwertungsnachrichten.
 * Diese Gruppierung wird unten nicht geraten, sondern aus der Aufzeichnung
 * selbst abgeleitet: eine Nachricht mit Aufwertungen setzt den Kontext der
 * vorigen fort, jede andere beginnt einen neuen.
 */
describe('Graphics Pipeline - Kodierkontext und Kachelhistorie (MS-RDPEGFX 3.3.1.1 bis 3.3.1.3)', () => {
  const nachrichten = (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'progressive-echt.json'), 'utf8'),
    ) as { nachrichten: { hex: string }[] }
  ).nachrichten.map((n) => Buffer.from(n.hex, 'hex'));

  const BREITE = 1280;
  const HOEHE = 720;

  function wireToSurface2(surfaceId: number, kontext: number, daten: Buffer): Buffer {
    return pdu(
      egfx.RDPGFX_CMDID_WIRETOSURFACE_2,
      new BinaryWriter()
        .uint16le(surfaceId)
        .uint16le(egfx.RDPGFX_CODECID_CAPROGRESSIVE)
        .uint32le(kontext)
        .uint8(0)
        .uint32le(daten.length)
        .bytes(daten)
        .toBuffer(),
    );
  }

  function deleteEncodingContext(surfaceId: number, kontext: number): Buffer {
    return pdu(
      egfx.RDPGFX_CMDID_DELETEENCODINGCONTEXT,
      new BinaryWriter().uint16le(surfaceId).uint32le(kontext).toBuffer(),
    );
  }

  /**
   * Welche Nachricht traegt Aufwertungen? Das beantwortet der Decoder selbst,
   * damit die Kontextgrenzen aus der Aufzeichnung stammen und nicht aus einer
   * Annahme des Tests.
   */
  const hatAufwertung = ((): boolean[] => {
    const decoder = new ProgressiveDecoder();
    return nachrichten.map((n) => {
      decoder.decode(n, 0);
      return decoder.letzteDiagnose().aufwertung > 0;
    });
  })();
  const kontextEndet = nachrichten.map((_, i) => i + 1 >= nachrichten.length || !hatAufwertung[i + 1]);

  /** Spielt die Aufzeichnung ab und gibt das fertige Bild samt Mitschnitt zurueck. */
  function spieleAb(mitKontextloeschen: boolean): { rahmen: Uint8ClampedArray; m: Mitschnitt } {
    const m = baueSitzung();
    const rahmen = new Uint8ClampedArray(BREITE * HOEHE * 4);
    m.bilder = (tiles) => {
      for (const t of tiles) {
        for (let y = 0; y < t.height; y++) {
          const zy = t.y + y;
          if (zy >= HOEHE) continue;
          for (let x = 0; x < t.width; x++) {
            const zx = t.x + x;
            if (zx >= BREITE) continue;
            const q = (y * t.width + x) * 4;
            const z = (zy * BREITE + zx) * 4;
            rahmen[z] = t.rgba[q];
            rahmen[z + 1] = t.rgba[q + 1];
            rahmen[z + 2] = t.rgba[q + 2];
            rahmen[z + 3] = 255;
          }
        }
      }
    };
    m.sitzung.handle(createSurface(0, BREITE, HOEHE, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(0, 0, 0));
    let kontext = 1;
    nachrichten.forEach((n, i) => {
      m.sitzung.handle(wireToSurface2(0, kontext, n));
      if (mitKontextloeschen && kontextEndet[i]) {
        m.sitzung.handle(deleteEncodingContext(0, kontext));
        kontext++;
      }
    });
    return { rahmen, m };
  }

  /** Mittelgrau ist die Farbe, die aus lauter Nullkoeffizienten entsteht. */
  function mittelgrau(rahmen: Uint8ClampedArray): number {
    let n = 0;
    for (let i = 0; i < rahmen.length; i += 4) {
      if (rahmen[i] === 128 && rahmen[i + 1] === 128 && rahmen[i + 2] === 128) n++;
    }
    return n;
  }

  const ohne = spieleAb(false);
  const mit = spieleAb(true);

  test('die Aufzeichnung zerfaellt in mehr als einen Kodierkontext', () => {
    // Sonst wuerde der Test nichts pruefen: ohne Kontextgrenze kein Loeschen.
    assert.ok(
      kontextEndet.filter(Boolean).length > 50,
      `nur ${kontextEndet.filter(Boolean).length} Kontextgrenzen - der Ablauf bildet den Server nicht ab`,
    );
  });

  /**
   * Der eigentliche Nachweis: dasselbe Bild, Pixel fuer Pixel. Das Loeschen des
   * Kodierkontexts darf am dekodierten Inhalt nichts aendern, denn die
   * Kachelhistorie gehoert nicht dazu.
   */
  test('das Loeschen des Kodierkontexts aendert am Bild nichts', () => {
    let abweichend = 0;
    for (let i = 0; i < ohne.rahmen.length; i += 4) {
      if (
        ohne.rahmen[i] !== mit.rahmen[i] ||
        ohne.rahmen[i + 1] !== mit.rahmen[i + 1] ||
        ohne.rahmen[i + 2] !== mit.rahmen[i + 2]
      ) {
        abweichend++;
      }
    }
    assert.equal(abweichend, 0, `${abweichend} Pixel weichen ab`);
  });

  /**
   * Die Gegenprobe in absoluten Zahlen, unabhaengig vom Vergleichslauf: mit
   * verworfener Historie blieben in genau diesem Ablauf 15330 Pixel mittelgrau
   * stehen - die grauen Bloecke aus dem Bildschirmfoto. Im Bild selbst kommt
   * RGB(128, 128, 128) genau einmal als echter Inhalt vor.
   */
  test('es bleiben keine mittelgrauen Bloecke stehen', () => {
    assert.equal(mittelgrau(ohne.rahmen), 1);
    assert.equal(mittelgrau(mit.rahmen), 1);
  });

  /**
   * Ein unveraenderlicher Anker aus dem Startknopf der Taskleiste: dasselbe
   * Pixel, das progressive.test.ts fuer den Lauf ohne Kontextloeschen festhaelt.
   */
  test('der Startknopf behaelt seine Farbe', () => {
    const z = (506 * BREITE + 334) * 4;
    assert.deepEqual(Array.from(mit.rahmen.slice(z, z + 4)), [56, 181, 246, 255]);
  });

  test('keine Warnung ueber fehlenden Vorzustand im Mitschnitt', () => {
    assert.equal(mit.m.auf('warn'), '');
    assert.equal(mit.m.auf('error'), '');
  });

  /**
   * Die Protokollzeile selbst darf nicht mehr behaupten, etwas zu verwerfen -
   * sie war lange der Grund, an dieser Stelle nicht weiterzusuchen.
   */
  /**
   * Die Kehrseite: bei DELETESURFACE *muss* alles weg. Sonst rechnete eine
   * spaeter unter derselben Nummer angelegte Flaeche Differenzen gegen fremde
   * Bilddaten - und der Speicher liefe ueber alle Flaechen hinweg voll.
   *
   * Nachgewiesen ueber die Warnung: Nachricht 19 der Aufzeichnung enthaelt 19
   * Differenzkacheln. Nach einem DELETESURFACE fehlt ihnen der Vorzustand, und
   * genau das meldet die Sitzung.
   */
  test('DELETESURFACE verwirft die Kachelhistorie sehr wohl', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(0, BREITE, HOEHE, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(0, 0, 0));
    for (let i = 0; i < 19; i++) m.sitzung.handle(wireToSurface2(0, 1, nachrichten[i]));
    assert.equal(m.auf('warn'), '', 'bis hierher darf nichts fehlen');

    m.sitzung.handle(pdu(egfx.RDPGFX_CMDID_DELETESURFACE, new BinaryWriter().uint16le(0).toBuffer()));
    m.sitzung.handle(createSurface(0, BREITE, HOEHE, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(0, 0, 0));
    m.sitzung.handle(wireToSurface2(0, 2, nachrichten[19]));
    assert.match(m.auf('warn'), /bekommt Differenzkacheln ohne Vorzustand/);
  });

  /**
   * Der Speicher haengt an der Geometrie der Flaeche, nicht an der Zahl der
   * Kodierkontexte. Derselbe Ablauf ein zweites Mal - also noch einmal so viele
   * Kontexte - darf keinen einzigen Kachelzustand hinzufuegen.
   */
  test('die Zahl der Kodierkontexte laesst den Speicher nicht wachsen', () => {
    const decoder = new ProgressiveDecoder();
    for (const n of nachrichten) decoder.decode(n, 0);
    const nachErstemDurchlauf = decoder.gemerkteKacheln(0);
    for (const n of nachrichten) decoder.decode(n, 0);
    assert.equal(decoder.gemerkteKacheln(0), nachErstemDurchlauf);
    // Obergrenze ist die Kachelzahl der Flaeche: 1280/64 mal 720/64, aufgerundet.
    assert.ok(
      nachErstemDurchlauf <= Math.ceil(BREITE / 64) * Math.ceil(HOEHE / 64),
      `${nachErstemDurchlauf} Kachelzustaende sind mehr, als die Flaeche Plaetze hat`,
    );
  });

  test('DELETEENCODINGCONTEXT meldet den Kontext, nicht das Verwerfen der Historie', () => {
    const m = baueSitzung();
    m.sitzung.handle(deleteEncodingContext(3, 17));
    assert.match(m.auf('info'), /DELETEENCODINGCONTEXT Surface 3, Kodierkontext 17 - Kachelhistorie bleibt erhalten/);
  });
});

// --------------------------------------------------------------------------
// Kopierpfade: Inhalt, nicht nur Gueltigkeit
// --------------------------------------------------------------------------

function solidFill(surfaceId: number, farbe: number[], rects: number[][]): Buffer {
  const [b, g, r, a] = farbe;
  const w = new BinaryWriter().uint16le(surfaceId).uint8(b).uint8(g).uint8(r).uint8(a).uint16le(rects.length);
  for (const [left, top, right, bottom] of rects) w.uint16le(left).uint16le(top).uint16le(right).uint16le(bottom);
  return pdu(egfx.RDPGFX_CMDID_SOLIDFILL, w.toBuffer());
}

/**
 * Ein Bildschirm, der sich genau wie das Webview verhaelt.
 *
 * Die Sitzung liefert Kacheln mit Bildschirmkoordinaten; das Webview setzt sie
 * mit putImageData ab. Genau das macht diese Funktion - und erst dadurch sagen
 * die Tests unten etwas ueber das aus, was der Nutzer sieht, statt nur ueber
 * den Zustand eines Puffers, den niemand anschaut.
 */
function baueBildschirm(m: Mitschnitt, breite: number, hoehe: number): Uint8ClampedArray {
  const schirm = new Uint8ClampedArray(breite * hoehe * 4);
  m.bilder = (tiles) => {
    for (const t of tiles) {
      for (let y = 0; y < t.height; y++) {
        for (let x = 0; x < t.width; x++) {
          const zy = t.y + y;
          const zx = t.x + x;
          if (zy < 0 || zy >= hoehe || zx < 0 || zx >= breite) continue;
          const von = (y * t.width + x) * 4;
          const nach = (zy * breite + zx) * 4;
          for (let c = 0; c < 4; c++) schirm[nach + c] = t.rgba[von + c];
        }
      }
    }
  };
  return schirm;
}

/** Zaehlt Pixel, die nicht die erwartete Farbe tragen. */
function abweichendePixel(
  puffer: Uint8ClampedArray,
  breite: number,
  rect: number[],
  erwartet: number[],
): number {
  const [left, top, right, bottom] = rect;
  let n = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const o = (y * breite + x) * 4;
      if (puffer[o] !== erwartet[0] || puffer[o + 1] !== erwartet[1] || puffer[o + 2] !== erwartet[2]) n++;
    }
  }
  return n;
}

/**
 * Was ausserhalb der Quelle liegt, darf nicht schwarz werden.
 *
 * MS-RDPEGFX beschreibt alle drei Kopierbefehle als SRCCOPY-ROP3-Operation
 * (3.3.5.5, 3.3.5.6, 3.3.5.7) und setzt dabei voraus, dass die Rechtecke in
 * ihren Surfaces liegen. Ueber Pixel ausserhalb sagt die Spezifikation nichts -
 * sie sind nicht "schwarz", sondern gar nicht da. FreeRDP verwirft den ganzen
 * Befehl (is_rect_valid in libfreerdp/gdi/gfx.c); hier wird der vorhandene Teil
 * kopiert und der Rest in Ruhe gelassen.
 *
 * Mit dem alten Code scheitern diese Tests nicht knapp: dort fuellte `extract`
 * nichtvorhandene Quellpixel mit Nullen, und `blit` schrieb sie mit Alpha 255
 * zurueck - also sattes Schwarz ueber gutem Bildinhalt.
 */
describe('Graphics Pipeline - Kopieren ueber den Rand hinaus faerbt nichts schwarz', () => {
  const GRUEN = [0, 200, 0];

  test('SURFACETOSURFACE kopiert nur den vorhandenen Teil, der Rest bleibt stehen', () => {
    const m = baueSitzung();
    const schirm = baueBildschirm(m, 128, 128);
    m.sitzung.handle(createSurface(1, 32, 32, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(createSurface(2, 128, 128, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(2, 0, 0));
    // Ziel vollflaechig gruen, Quelle mit einem Wert belegen.
    m.sitzung.handle(solidFill(2, [GRUEN[2], GRUEN[1], GRUEN[0], 0xff], [[0, 0, 128, 128]]));
    m.sitzung.handle(unkomprimiert(1, [0, 0, 32, 32], 0x20));

    // Der Server verlangt 64x64 aus einer 32x32 grossen Surface.
    m.sitzung.handle(surfaceToSurface(1, 2, [0, 0, 64, 64], [[0, 0]]));

    // Die vorhandenen 32x32 sind kopiert ...
    assert.equal(abweichendePixel(schirm, 128, [0, 0, 32, 32], [0x20, 0x20, 0x20]), 0);
    // ... und der Rest des 64x64-Rechtecks ist unveraendert gruen geblieben.
    assert.equal(abweichendePixel(schirm, 128, [32, 0, 64, 64], GRUEN), 0);
    assert.equal(abweichendePixel(schirm, 128, [0, 32, 32, 64], GRUEN), 0);
    assert.match(m.auf('warn'), /kopiert wird nur 32x32\+0\+0, der Rest bleibt unveraendert stehen/);
  });

  test('SURFACETOCACHE legt nur den vorhandenen Teil ab und CACHETOSURFACE setzt ihn lagerichtig', () => {
    const m = baueSitzung();
    const schirm = baueBildschirm(m, 128, 128);
    m.sitzung.handle(createSurface(1, 128, 128, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(1, 0, 0));
    m.sitzung.handle(solidFill(1, [GRUEN[2], GRUEN[1], GRUEN[0], 0xff], [[0, 0, 128, 128]]));
    m.sitzung.handle(unkomprimiert(1, [96, 96, 128, 128], 0x71));

    // 32x32 ab (112, 112) - die Haelfte davon liegt ausserhalb der Surface.
    m.sitzung.handle(surfaceToCache(1, 9, [112, 112, 144, 144]));
    m.sitzung.handle(cacheToSurface(9, 1, [[0, 0]]));

    // Abgelegt wurden nur die vorhandenen 16x16, und sie stehen am Ursprung -
    // der Versatz ist hier null, weil links und oben nichts fehlte.
    assert.equal(abweichendePixel(schirm, 128, [0, 0, 16, 16], [0x71, 0x71, 0x71]), 0);
    // Der Rest des 32x32-Ziels ist gruen geblieben statt schwarz zu werden.
    assert.equal(abweichendePixel(schirm, 128, [16, 0, 32, 32], GRUEN), 0);
    assert.equal(abweichendePixel(schirm, 128, [0, 16, 16, 32], GRUEN), 0);
    assert.match(m.auf('warn'), /Slot 9 bekommt nur 16x16\+112\+112/);
  });

  test('Ein negativer Zielpunkt schneidet nur ab, was ausserhalb liegt', () => {
    // RDPGFX_POINT16 (2.2.1.1) ist vorzeichenbehaftet: ein Zielpunkt darf vor
    // der Surface liegen. Dann gehoert der herausragende Teil weggelassen und
    // der Rest an seinen Platz - nicht die ganze Kopie verworfen und auch nicht
    // um den abgeschnittenen Betrag verrutscht.
    const m = baueSitzung();
    const schirm = baueBildschirm(m, 128, 128);
    m.sitzung.handle(createSurface(1, 16, 16, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(createSurface(2, 128, 128, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(mapToOutput(2, 0, 0));
    m.sitzung.handle(solidFill(2, [GRUEN[2], GRUEN[1], GRUEN[0], 0xff], [[0, 0, 128, 128]]));
    m.sitzung.handle(unkomprimiert(1, [0, 0, 16, 16], 0x55));

    // 32x32 aus einer 16x16-Surface, abgesetzt bei (-8, -8): vorhanden sind
    // 16x16, sichtbar davon 8x8 in der linken oberen Ecke.
    m.sitzung.handle(surfaceToSurface(1, 2, [0, 0, 32, 32], [[-8, -8]]));
    assert.equal(abweichendePixel(schirm, 128, [0, 0, 8, 8], [0x55, 0x55, 0x55]), 0);
    assert.equal(abweichendePixel(schirm, 128, [8, 0, 32, 32], GRUEN), 0);
    assert.equal(abweichendePixel(schirm, 128, [0, 8, 8, 32], GRUEN), 0);
  });
});

/**
 * Der Cache ist im Mitschnitt vom 12.09. der Hauptweg: 2252 CACHETOSURFACE und
 * 2077 SURFACETOCACHE stehen 2181 WIRETOSURFACE_1 gegenueber. Ein inhaltlicher
 * Fehler dort - Zeilenabstand, vertauschte Achsen, Off-by-one am Rand - wuerde
 * keine einzige Warnung ausloesen, weil formal alles stimmt. Deshalb wird der
 * Rundlauf hier an echter Serverlast nachgerechnet, Pixel fuer Pixel.
 */
describe('Graphics Pipeline - Cache-Rundlauf an echter ClearCodec-Nutzlast', () => {
  const kacheln = (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'clearcodec-echt.json'), 'utf8'),
    ) as { kacheln: { width: number; height: number; hex: string }[] }
  ).kacheln;

  function clearKachel(surfaceId: number, left: number, top: number, k: { width: number; height: number; hex: string }): Buffer {
    const daten = Buffer.from(k.hex, 'hex');
    return pdu(
      egfx.RDPGFX_CMDID_WIRETOSURFACE_1,
      new BinaryWriter()
        .uint16le(surfaceId)
        .uint16le(egfx.RDPGFX_CODECID_CLEARCODEC)
        .uint8(egfx.PIXEL_FORMAT_XRGB_8888)
        .uint16le(left)
        .uint16le(top)
        .uint16le(left + k.width)
        .uint16le(top + k.height)
        .uint32le(daten.length)
        .bytes(daten)
        .toBuffer(),
    );
  }

  test('Ein Ausschnitt kommt aus dem Cache Pixel fuer Pixel so zurueck, wie er hineinging', () => {
    const m = baueSitzung();
    const BREITE = 320;
    const schirm = baueBildschirm(m, BREITE, 320);
    m.sitzung.handle(createSurface(1, BREITE, 320, egfx.PIXEL_FORMAT_ARGB_8888));
    m.sitzung.handle(mapToOutput(1, 0, 0));
    // Bewusst auf eine ungerade Stelle malen: ein falscher Zeilenabstand oder
    // eine vertauschte Achse faellt bei 0/0 und Vielfachen von 64 nicht auf.
    const k = kacheln[0];
    m.sitzung.handle(clearKachel(1, 7, 5, k));
    m.sitzung.handle(surfaceToCache(1, 3, [7, 5, 7 + k.width, 5 + k.height]));
    // Zwei Zielpunkte, die sich nicht ueberlappen - beide muessen dasselbe Bild tragen.
    m.sitzung.handle(cacheToSurface(3, 1, [[100, 100], [200, 200]]));

    let abweichend = 0;
    for (let y = 0; y < k.height; y++) {
      for (let x = 0; x < k.width; x++) {
        const o = ((5 + y) * BREITE + 7 + x) * 4;
        for (const [zx, zy] of [[100, 100], [200, 200]]) {
          const z = ((zy + y) * BREITE + zx + x) * 4;
          for (let c = 0; c < 3; c++) if (schirm[z + c] !== schirm[o + c]) abweichend++;
        }
      }
    }
    assert.equal(abweichend, 0, `${abweichend} Farbkanaele weichen zwischen Original und Cachekopie ab`);
  });

  test('Eine ueberlappende Verschiebung innerhalb derselben Surface bleibt korrekt', () => {
    // 45 der 79 SURFACETOSURFACE im Mitschnitt verschieben innerhalb von
    // Surface 0 und ueberlappen dabei - genau der Fall beim Scrollen. Ohne
    // Zwischenkopie wuerde eine Zeile die naechste ueberschreiben, bevor diese
    // gelesen ist, und der Bereich streifig auslaufen.
    const m = baueSitzung();
    const BREITE = 512;
    m.sitzung.handle(createSurface(1, BREITE, 512, egfx.PIXEL_FORMAT_ARGB_8888));
    const k = kacheln[1];
    m.sitzung.handle(clearKachel(1, 100, 50, k));

    const surfaces = (m.sitzung as unknown as { surfaces: Map<number, { rgba: Uint8ClampedArray }> }).surfaces;
    const vorher = Uint8ClampedArray.from(surfaces.get(1)!.rgba);

    // Echter Befehl aus dem Mitschnitt: 84x72 um 47 Zeilen nach unten.
    const [SX, SY, SW, SH, DY] = [120, 60, 84, 72, 107];
    m.sitzung.handle(surfaceToSurface(1, 1, [SX, SY, SX + SW, SY + SH], [[SX, DY]]));

    const jetzt = surfaces.get(1)!.rgba;
    let abweichend = 0;
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const q = ((SY + y) * BREITE + SX + x) * 4;
        const z = ((DY + y) * BREITE + SX + x) * 4;
        for (let c = 0; c < 3; c++) if (jetzt[z + c] !== vorher[q + c]) abweichend++;
      }
    }
    assert.equal(abweichend, 0, `${abweichend} Farbkanaele stimmen nach der ueberlappenden Kopie nicht`);
  });
});

