import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { planarDecompress, PlanarError } from '../src/codec/planar.js';

/** FormatHeader-Bits aus MS-RDPEGDI 2.2.2.5.1. */
const CS = 0x08;
const RLE = 0x10;
const NA = 0x20;

/** Ein einzelnes Pixel als [R, G, B, A]. */
function pixel(out: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const o = (y * width + x) * 4;
  return [out[o], out[o + 1], out[o + 2], out[o + 3]];
}

/** Die komplette Ausgabe als flache Liste, damit deepEqual lesbare Fehler liefert. */
function all(out: Uint8ClampedArray): number[] {
  return Array.from(out);
}

describe('Planarer Codec - rohe Ebenen', () => {
  test('drei rohe Ebenen ergeben RGB, NA setzt Alpha auf 255', () => {
    // 2.2.2.5.1: NA = 1 bedeutet keine Alphaebene, die Werte gelten als 0xFF.
    // Ebenenreihenfolge ohne Alpha: Rot, Gruen, Blau. Bei RLE = 0 folgt ein
    // Pad-Byte, das ignoriert werden muss.
    const src = Buffer.from([
      NA,
      10, 20, 30, 40, // Rot
      50, 60, 70, 80, // Gruen
      90, 100, 110, 120, // Blau
      0xff, // Pad
    ]);
    assert.deepEqual(
      all(planarDecompress(src, { width: 2, height: 2 })),
      [10, 50, 90, 255, 20, 60, 100, 255, 30, 70, 110, 255, 40, 80, 120, 255],
    );
  });

  test('vier rohe Ebenen: die Alphaebene steht laut Spezifikation vorne', () => {
    // NA = 0: "the alpha plane is sent as the first color plane" (2.2.2.5.1).
    const src = Buffer.from([
      0x00,
      1, 2, 3, 4, // Alpha
      10, 20, 30, 40, // Rot
      50, 60, 70, 80, // Gruen
      90, 100, 110, 120, // Blau
      0x00, // Pad
    ]);
    assert.deepEqual(
      all(planarDecompress(src, { width: 2, height: 2 })),
      [10, 50, 90, 1, 20, 60, 100, 2, 30, 70, 110, 3, 40, 80, 120, 4],
    );
  });

  test('rohe Ebenen sind nicht deltakodiert', () => {
    // Deltawerte kennt laut 2.2.2.5.1.2 nur das rawValues-Feld eines RLE-
    // Segments. Eine rohe Ebene enthaelt "the raw bytes of the color plane",
    // Zeile 1 uebernimmt ihre Bytes also unveraendert.
    const plane = [7, 7, 200, 200];
    const src = Buffer.from([NA, ...plane, ...plane, ...plane, 0x00]);
    const out = planarDecompress(src, { width: 2, height: 2 });
    assert.deepEqual(pixel(out, 2, 0, 1), [200, 200, 200, 255]);
  });
});

describe('Planarer Codec - RLE-Ebenen', () => {
  // Das durchgerechnete Beispiel aus MS-RDPEGDI 3.1.9.2.1: drei Zeilen zu
  // sechs Werten, kodiert als vier Segmente.
  const specSegments = [
    0x13, 0xff, // Segment 1: cRawBytes = 1, nRunLength = 3
    0x20, 0xfe, 0xfd, // Segment 2: cRawBytes = 2, nRunLength = 0
    0x60, 0x01, 0x7d, 0xf5, 0xc2, 0x9a, 0x38, // Segment 3: Zeile 2 als Deltas
    0x60, 0x01, 0x67, 0x8b, 0xa3, 0x78, 0xaf, // Segment 4: Zeile 3 als Deltas
  ];
  // Die Klartextwerte, die die Spezifikation zu diesem Strom angibt.
  const specPlane = [
    [255, 255, 255, 255, 254, 253],
    [254, 192, 132, 96, 75, 25],
    [253, 140, 62, 14, 135, 193],
  ];

  test('Beispielstrom aus 3.1.9.2.1 wird Wert fuer Wert wiederhergestellt', () => {
    // Dieselbe Ebene dreimal (Rot, Gruen, Blau) ergibt ein Graustufenbild,
    // damit sich jeder Kanal direkt mit der Tabelle vergleichen laesst.
    const src = Buffer.from([NA | RLE, ...specSegments, ...specSegments, ...specSegments]);
    const out = planarDecompress(src, { width: 6, height: 3 });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        const v = specPlane[y][x];
        assert.deepEqual(pixel(out, 6, x, y), [v, v, v, 255], `Pixel (${x},${y})`);
      }
    }
  });

  test('ein Segment ohne RAW-Anteil wiederholt den Wert 0 - die Zeile bleibt gleich', () => {
    // 3.1.9.2: "In the absence of a RAW component, the RAW value used to decode
    // the RUN component is assumed to be the value zero." In einer Deltazeile
    // ist die Differenz 0, die Zeile uebernimmt also die Zeile darueber - genau
    // das Beispiel "RAW [<none>]; RUN [6]" aus 3.1.9.2.
    const plane = [
      0x40, 11, 22, 33, 44, // Zeile 0: vier Absolutwerte, kein Lauf
      0x04, // Zeile 1: nRunLength = 4, cRawBytes = 0
    ];
    const src = Buffer.from([NA | RLE, ...plane, ...plane, ...plane]);
    const out = planarDecompress(src, { width: 4, height: 2 });
    assert.deepEqual(pixel(out, 4, 0, 1), [11, 11, 11, 255]);
    assert.deepEqual(pixel(out, 4, 3, 1), [44, 44, 44, 255]);
  });

  test('Deltas werden mit dem Vorzeichen im untersten Bit gelesen', () => {
    // Kodierung laut 3.1.9.2.1: nicht negative Differenzen werden verdoppelt,
    // negative werden negiert, verdoppelt und um eins verringert.
    //   0x02 ->  +1, 0x01 ->  -1, 0x00 -> 0, 0xff -> -128
    const plane = [
      0x40, 100, 100, 100, 100, // Zeile 0
      0x40, 0x02, 0x01, 0x00, 0xff, // Zeile 1: +1, -1, 0, -128
    ];
    const src = Buffer.from([NA | RLE, ...plane, ...plane, ...plane]);
    const out = planarDecompress(src, { width: 4, height: 2 });
    assert.deepEqual(pixel(out, 4, 0, 1), [101, 101, 101, 255]);
    assert.deepEqual(pixel(out, 4, 1, 1), [99, 99, 99, 255]);
    assert.deepEqual(pixel(out, 4, 2, 1), [100, 100, 100, 255]);
    // 100 - 128 = -28, im Byte umlaufend also 228.
    assert.deepEqual(pixel(out, 4, 3, 1), [228, 228, 228, 255]);
  });

  test('Deltaläufe rechnen spaltenweise gegen die Zeile darueber', () => {
    // Ein RUN wiederholt die Differenz, nicht den Pixelwert: jede Spalte
    // addiert sie auf ihren eigenen Vorgaenger (3.1.9.2, "Delta values are
    // relative to the previous scan-line values").
    const plane = [
      0x40, 10, 20, 30, 40, // Zeile 0
      0x13, 0x0a, // Zeile 1: ein RAW-Delta (+5), danach dreimal derselbe Lauf
    ];
    const src = Buffer.from([NA | RLE, ...plane, ...plane, ...plane]);
    const out = planarDecompress(src, { width: 4, height: 2 });
    assert.deepEqual(
      [0, 1, 2, 3].map((x) => pixel(out, 4, x, 1)[0]),
      [15, 25, 35, 45],
    );
  });

  test('nRunLength 1 und 2 kodieren lange Laeufe', () => {
    // 2.2.2.5.1.2: nRunLength = 1 bedeutet Lauflaenge 16 + cRawBytes, und die
    // RAW-Anzahl gilt dann als 0. Der Lauf wiederholt den zuletzt gelesenen
    // RAW-Wert der Zeile - anders liessen sich Laeufe ueber 16 Werte gar nicht
    // ausdruecken, denn genau dafuer wurde das Praefix eingefuehrt.
    const plane = [
      0x10, 0x42, // cRawBytes = 1, nRunLength = 0
      0x01, // nRunLength = 1, cRawBytes = 0 -> 16 Wiederholungen von 0x42
      0x30, 0x21, 0x22, 0x23, // drei RAW-Werte, kein Lauf
    ];
    const src = Buffer.from([NA | RLE, ...plane, ...plane, ...plane]);
    const out = planarDecompress(src, { width: 20, height: 1 });
    for (let x = 0; x < 17; x++) {
      assert.equal(pixel(out, 20, x, 0)[0], 0x42, `Spalte ${x}`);
    }
    assert.deepEqual(
      [17, 18, 19].map((x) => pixel(out, 20, x, 0)[0]),
      [0x21, 0x22, 0x23],
    );
  });

  test('nRunLength 2 addiert 32 statt 16', () => {
    const plane = [
      0x10, 0x7b, // cRawBytes = 1, nRunLength = 0
      0x12, // nRunLength = 2, cRawBytes = 1 -> 32 + 1 = 33 Wiederholungen
    ];
    const src = Buffer.from([NA | RLE, ...plane, ...plane, ...plane]);
    const out = planarDecompress(src, { width: 34, height: 1 });
    assert.equal(pixel(out, 34, 0, 0)[0], 0x7b);
    assert.equal(pixel(out, 34, 33, 0)[0], 0x7b);
  });
});

describe('Planarer Codec - AYCoCg', () => {
  test('CLL > 0 rechnet ueber die inverse Matrix aus 3.1.9.1.2 zurueck', () => {
    // Ebenenbytes: Y = 200, Co-Byte = 0x14 (+20), Cg-Byte = 0xf6 (-10).
    // CLL = 1 schiebt die Chromawerte um ein Bit zurueck (3.1.9.1.4):
    //   Co = 40, Cg = -20.
    // Inverse Transformation:
    //   R = Y + Co/2 - Cg/2 = 200 + 20 + 10 = 230
    //   G = Y + Cg/2        = 200 - 10      = 190
    //   B = Y - Co/2 - Cg/2 = 200 - 20 + 10 = 190
    // 3.1.9.1.1 verlangt anschliessend den Tausch von R und B, weil die
    // Server Co mit vertauschten Kanaelen berechnen.
    const src = Buffer.from([NA | 0x01, 200, 0x14, 0xf6, 0x00]);
    assert.deepEqual(all(planarDecompress(src, { width: 1, height: 1 })), [190, 190, 230, 255]);
  });

  test('Werte ausserhalb 0..255 werden begrenzt', () => {
    // Y = 250, Co = 0, Cg-Byte = 0x40 -> Cg = 128.
    //   R = 250 + 0 - 64 = 186, G = 250 + 64 = 314, B = 250 - 0 - 64 = 186.
    // 3.1.9.1.2: "clamping between 0 and 255", also G = 255.
    const src = Buffer.from([NA | 0x01, 250, 0x00, 0x40, 0x00]);
    assert.deepEqual(all(planarDecompress(src, { width: 1, height: 1 })), [186, 255, 186, 255]);
  });

  test('CLL = 0 laesst die Ebenen unangetastet als RGB stehen', () => {
    // Gegenprobe zum Test darueber: derselbe Bytesatz, nur ohne Farbverlust-
    // reduktion, ist schlicht R = 200, G = 0x14, B = 0xf6.
    const src = Buffer.from([NA, 200, 0x14, 0xf6, 0x00]);
    assert.deepEqual(all(planarDecompress(src, { width: 1, height: 1 })), [200, 0x14, 0xf6, 255]);
  });

  test('Chroma-Subsampling: ein Chromawert deckt ein 2x2-Feld ab', () => {
    // 3x3-Bild, also 2x2 grosse Chromaebenen (3.1.9.1.3). Cg bleibt 0, dann
    // ist G = Y und die Rechnung reduziert sich auf B = Y - Co/2, R = Y + Co/2;
    // nach dem R/B-Tausch aus 3.1.9.1.1 steht Y - Co/2 im Rotkanal.
    // Co-Bytes [10, 20, 30, 40] bei CLL = 1 -> Co = 20, 40, 60, 80.
    const luma = new Array<number>(9).fill(100);
    const src = Buffer.from([NA | CS | 0x01, ...luma, 10, 20, 30, 40, 0, 0, 0, 0, 0x00]);
    const out = planarDecompress(src, { width: 3, height: 3 });

    const red = (x: number, y: number): number => pixel(out, 3, x, y)[0];
    // Linkes oberes 2x2-Feld teilt sich den ersten Chromawert.
    assert.deepEqual([red(0, 0), red(1, 0), red(0, 1), red(1, 1)], [90, 90, 90, 90]);
    // Rechter Rand ist nur 1x2 breit, unterer Rand nur 2x1 hoch.
    assert.deepEqual([red(2, 0), red(2, 1)], [80, 80]);
    assert.deepEqual([red(0, 2), red(1, 2)], [70, 70]);
    // Die Ecke bleibt ein einzelnes Pixel.
    assert.equal(red(2, 2), 60);
    // Der Gruenkanal bleibt ueberall bei Y.
    assert.equal(pixel(out, 3, 2, 2)[1], 100);
  });
});

describe('Planarer Codec - Fehlerfaelle', () => {
  test('leerer Puffer', () => {
    assert.throws(() => planarDecompress(Buffer.alloc(0), { width: 1, height: 1 }), PlanarError);
  });

  test('zu kurzer Puffer fuer rohe Ebenen', () => {
    // Drei Ebenen zu 4 Byte waeren noetig, es stehen nur 5 Byte bereit.
    assert.throws(
      () => planarDecompress(Buffer.from([NA, 1, 2, 3, 4, 5]), { width: 2, height: 2 }),
      (e: unknown) => e instanceof PlanarError && /rohe Ebene/.test(e.message),
    );
  });

  test('abgeschnittener RLE-Strom', () => {
    assert.throws(
      () => planarDecompress(Buffer.from([NA | RLE, 0x40, 1, 2]), { width: 4, height: 1 }),
      (e: unknown) => e instanceof PlanarError && /RAW-Bytes/.test(e.message),
    );
  });

  test('controlByte 0 wird abgewiesen statt endlos zu drehen', () => {
    // 2.2.2.5.1.2: "The controlByte field MUST contain a nonzero value."
    assert.throws(
      () => planarDecompress(Buffer.from([NA | RLE, 0x00, 0x00, 0x00]), { width: 4, height: 1 }),
      (e: unknown) => e instanceof PlanarError && /controlByte 0/.test(e.message),
    );
  });

  test('unsinnige Lauflaenge sprengt die Zeile', () => {
    // nRunLength = 15 in einer Zeile mit vier Pixeln.
    assert.throws(
      () => planarDecompress(Buffer.from([NA | RLE, 0x0f]), { width: 4, height: 1 }),
      (e: unknown) => e instanceof PlanarError && /passt nicht mehr in Zeile/.test(e.message),
    );
  });

  test('lange Lauflaenge sprengt die Zeile ebenfalls', () => {
    // nRunLength = 2, cRawBytes = 15 -> 47 Werte in einer Zeile mit 4 Pixeln.
    assert.throws(
      () => planarDecompress(Buffer.from([NA | RLE, 0xf2]), { width: 4, height: 1 }),
      (e: unknown) => e instanceof PlanarError && /passt nicht mehr in Zeile/.test(e.message),
    );
  });

  test('Chroma-Subsampling ohne AYCoCg ist nicht erlaubt', () => {
    // 2.2.2.5.1: CS = 1 setzt CLL > 0 voraus.
    assert.throws(
      () => planarDecompress(Buffer.from([NA | CS, 1, 2, 3]), { width: 1, height: 1 }),
      (e: unknown) => e instanceof PlanarError && /Subsampling/.test(e.message),
    );
  });

  test('unplausible Zielgroessen', () => {
    assert.throws(() => planarDecompress(Buffer.from([NA]), { width: 0, height: 4 }), PlanarError);
    assert.throws(() => planarDecompress(Buffer.from([NA]), { width: 4, height: -1 }), PlanarError);
    assert.throws(() => planarDecompress(Buffer.from([NA]), { width: 1.5, height: 4 }), PlanarError);
    assert.throws(() => planarDecompress(Buffer.from([NA]), { width: 0x10000, height: 0x10000 }), PlanarError);
  });
});
