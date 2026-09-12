import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClearCodecDecoder } from '../src/codec/clear.js';
import { RdpProtocolError } from '../src/core/errors.js';

/**
 * Die synthetischen Stroeme in dieser Datei sind bewusst Byte fuer Byte von
 * Hand gesetzt und nicht mit Schreibhelfern des Pakets erzeugt: ein Kodierer
 * aus demselben Kopf wuerde denselben Irrtum wie der Parser machen und der Test
 * waere wertlos. Die beiden Helfer unten schreiben nur Zahlen in die
 * Little-Endian-Bytefolge, die MS-RDPEGFX 2.2.4.1 durchgehend verwendet.
 */
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

/** CLEARCODEC_BITMAP_STREAM mit CLEARCODEC_COMPOSITE_PAYLOAD (2.2.4.1, 2.2.4.1.1). */
function strom(
  flags: number,
  schichten: { residual?: number[]; bands?: number[]; subcodec?: number[] },
  glyphIndex?: number,
): Buffer {
  const residual = schichten.residual ?? [];
  const bands = schichten.bands ?? [];
  const subcodec = schichten.subcodec ?? [];
  return Buffer.from([
    flags,
    0x00, // seqNumber
    ...(glyphIndex === undefined ? [] : u16(glyphIndex)),
    ...u32(residual.length),
    ...u32(bands.length),
    ...u32(subcodec.length),
    ...residual,
    ...bands,
    ...subcodec,
  ]);
}

/** Ein einzelnes Pixel als [R, G, B, A]. */
function pixel(out: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const o = (y * width + x) * 4;
  return [out[o], out[o + 1], out[o + 2], out[o + 3]];
}

/** Die komplette Ausgabe als flache Liste, damit deepEqual lesbare Fehler liefert. */
function all(out: Uint8ClampedArray): number[] {
  return Array.from(out);
}

function istProtokollfehler(muster: RegExp): (e: unknown) => boolean {
  return (e: unknown) => e instanceof RdpProtocolError && muster.test(e.message);
}

describe('ClearCodec - echte Aufzeichnung', () => {
  const pfad = join(__dirname, '..', '..', 'test', 'fixtures', 'clearcodec-echt.json');
  const roh = JSON.parse(readFileSync(pfad, 'utf8')) as {
    quelle?: string;
    kacheln: { codecId: number; width: number; height: number; hex: string }[];
  };

  test('alle aufgezeichneten Kacheln dekodieren zu width*height*4 Byte RGBA', () => {
    // Die Kacheln stammen aus *einer* Sitzung und stehen in Aufnahmereihenfolge.
    // Sie muessen deshalb durch eine einzige Decoder-Instanz laufen: der
    // Glyph-Cache und die beiden V-Bar-Speicher (MS-RDPEGFX 3.3.1.9 bis
    // 3.3.1.13) leben ueber Kacheln hinweg, und die Kacheln mit
    // CLEARCODEC_FLAG_GLYPH_HIT bestehen nur aus vier Byte Kopf - ihr Inhalt
    // steht ausschliesslich im Cache frueherer Kacheln.
    const decoder = new ClearCodecDecoder();
    const fehler: string[] = [];
    let dekodiert = 0;

    roh.kacheln.forEach((kachel, i) => {
      assert.equal(kachel.codecId, 0x0008, `Kachel ${i} ist nicht RDPGFX_CODECID_CLEARCODEC`);
      const src = Buffer.from(kachel.hex, 'hex');
      try {
        const out = decoder.decode(src, { width: kachel.width, height: kachel.height });
        assert.equal(
          out.length,
          kachel.width * kachel.height * 4,
          `Kachel ${i} liefert ${out.length} statt ${kachel.width * kachel.height * 4} Byte`,
        );
        dekodiert++;
      } catch (e) {
        fehler.push(`Kachel ${i} (${kachel.width}x${kachel.height}, ${src.length} Byte): ${(e as Error).message}`);
      }
    });

    assert.deepEqual(fehler, [], `${fehler.length} Kacheln sind nicht dekodierbar`);
    assert.equal(dekodiert, roh.kacheln.length);
    assert.equal(roh.kacheln.length, 400, 'die Aufzeichnung soll 400 Kacheln enthalten');
  });

  test('in der Aufzeichnung stecken alle drei Schichten und alle drei Subcodecs', () => {
    // Absicherung der Absicherung: haette der Server nur eine Schicht benutzt,
    // wuerde der Test oben viel weniger pruefen, als er zu pruefen scheint.
    // Diese Auswertung liest nur die Laengenfelder, nicht den Inhalt.
    const zaehler = { residual: 0, bands: 0, subcodec: 0, glyphTreffer: 0 };
    const subcodecArten = new Set<number>();

    for (const kachel of roh.kacheln) {
      const b = Buffer.from(kachel.hex, 'hex');
      const flags = b[0];
      let p = 2;
      if (flags & 0x01) p += 2;
      if ((flags & 0x03) === 0x03) {
        zaehler.glyphTreffer++;
        continue;
      }
      const residual = b.readUInt32LE(p);
      const bands = b.readUInt32LE(p + 4);
      const subcodec = b.readUInt32LE(p + 8);
      if (residual > 0) zaehler.residual++;
      if (bands > 0) zaehler.bands++;
      if (subcodec > 0) zaehler.subcodec++;

      let q = p + 12 + residual + bands;
      const ende = q + subcodec;
      while (q < ende) {
        const laenge = b.readUInt32LE(q + 8);
        subcodecArten.add(b[q + 12]);
        q += 13 + laenge;
      }
    }

    assert.ok(zaehler.residual > 0, 'keine Kachel mit Residualschicht');
    assert.ok(zaehler.bands > 0, 'keine Kachel mit Bandschicht');
    assert.ok(zaehler.subcodec > 0, 'keine Kachel mit Subcodecschicht');
    assert.ok(zaehler.glyphTreffer > 0, 'keine Kachel mit CLEARCODEC_FLAG_GLYPH_HIT');
    // 0x00 = RAW, 0x01 = NSCodec, 0x02 = RLEX (2.2.4.1.1.3.1). Der Server in
    // dieser Aufzeichnung benutzt NSCodec und RLEX, aber kein RAW - RAW wird
    // deshalb nur von den handgebauten Stroemen weiter unten abgedeckt.
    assert.deepEqual([...subcodecArten].sort(), [0x01, 0x02]);
  });
});

describe('ClearCodec - Residualschicht (2.2.4.1.1.1)', () => {
  test('CLEARCODEC_RGB_RUN_SEGMENT fuellt von links oben nach rechts unten', () => {
    // Zwei Segmente: (B=10, G=20, R=30) dreimal, dann (B=40, G=50, R=60) einmal.
    // Auf dem Draht steht B, G, R (2.2.4.1.1.1.1), ausgegeben wird RGBA.
    const out = new ClearCodecDecoder().decode(
      strom(0x00, { residual: [10, 20, 30, 3, 40, 50, 60, 1] }),
      { width: 2, height: 2 },
    );
    assert.deepEqual(all(out), [30, 20, 10, 255, 30, 20, 10, 255, 30, 20, 10, 255, 60, 50, 40, 255]);
  });

  test('runLengthFactor1 = 0xFF schaltet auf das 16-Bit-Feld um', () => {
    // 2.2.4.1.1.1.1: "If the runLengthFactor1 field equals 255 (0xFF), the
    // runLengthFactor2 field MUST be present". Dieselbe Stelle, an der in
    // Beispiel 4.1.1.3 die Lauflaenge 1408 steht.
    const out = new ClearCodecDecoder().decode(
      strom(0x00, { residual: [1, 2, 3, 0xff, ...u16(300)] }),
      { width: 20, height: 15 },
    );
    assert.equal(out.length, 20 * 15 * 4);
    assert.deepEqual(pixel(out, 20, 0, 0), [3, 2, 1, 255]);
    assert.deepEqual(pixel(out, 20, 19, 14), [3, 2, 1, 255]);
  });

  test('ein Lauf ueber das Bildende hinaus wird abgewiesen', () => {
    assert.throws(
      () => new ClearCodecDecoder().decode(strom(0x00, { residual: [1, 2, 3, 5] }), { width: 2, height: 2 }),
      istProtokollfehler(/Residualschicht schreibt 5 Pixel/),
    );
  });

  test('Lauflaenge 0 ist laut Spezifikation unzulaessig', () => {
    // 2.2.4.1.1.1.1: "The value of runLengthFactor1 MUST be greater than zero."
    assert.throws(
      () => new ClearCodecDecoder().decode(strom(0x00, { residual: [1, 2, 3, 0] }), { width: 2, height: 2 }),
      istProtokollfehler(/Lauflaenge 0/),
    );
  });
});

describe('ClearCodec - Bandschicht (2.2.4.1.1.2)', () => {
  /**
   * Ein Band ueber das ganze 3x3-Bild mit den drei moeglichen V-Bar-Koepfen
   * hintereinander. Der Kopf ist *ein* 16-Bit-Wert, dessen obere zwei Bit die
   * Struktur bestimmen (2.2.4.1.1.2.1.1.1 bis .3):
   *   Spalte 0: SHORT_VBAR_CACHE_MISS - obere zwei Bit 00,
   *             shortVBarYOn = 1 (untere 8 Bit), shortVBarYOff = 2 (naechste 6).
   *             Ein Pixel roh, Rest ist Hintergrund.
   *   Spalte 1: SHORT_VBAR_CACHE_HIT - obere zwei Bit 01, Index 0, dazu ein
   *             eigenes Byte shortVBarYOn = 0.
   *   Spalte 2: VBAR_CACHE_HIT - oberstes Bit 1, Index 0. Das ist die in
   *             Spalte 0 abgelegte fertige Spalte, denn der V-Bar-Cursor stand
   *             beim ersten Ablegen auf 0.
   */
  const band = [
    ...u16(0), // xStart
    ...u16(2), // xEnd, inklusiv
    ...u16(0), // yStart
    ...u16(2), // yEnd, inklusiv
    1, 2, 3, // blueBkg, greenBkg, redBkg
    ...u16(0x0201), // SHORT_VBAR_CACHE_MISS: yOn = 1, yOff = 2
    9, 8, 7, // ein Pixel B, G, R
    ...u16(0x4000), // SHORT_VBAR_CACHE_HIT, Index 0
    0, // shortVBarYOn
    ...u16(0x8000), // VBAR_CACHE_HIT, Index 0
  ];

  test('alle drei V-Bar-Koepfe legen die Spalten richtig ab', () => {
    const out = new ClearCodecDecoder().decode(strom(0x00, { bands: band }), { width: 3, height: 3 });
    const hg = [3, 2, 1, 255];
    const vg = [7, 8, 9, 255];

    // Spalte 0: Hintergrund, Pixel, Hintergrund.
    assert.deepEqual(pixel(out, 3, 0, 0), hg);
    assert.deepEqual(pixel(out, 3, 0, 1), vg);
    assert.deepEqual(pixel(out, 3, 0, 2), hg);
    // Spalte 1: dieselbe Short-V-Bar, aber ab yOn = 0 eingesetzt.
    assert.deepEqual(pixel(out, 3, 1, 0), vg);
    assert.deepEqual(pixel(out, 3, 1, 1), hg);
    assert.deepEqual(pixel(out, 3, 1, 2), hg);
    // Spalte 2: die fertige Spalte 0 aus dem V-Bar-Speicher.
    assert.deepEqual(pixel(out, 3, 2, 0), hg);
    assert.deepEqual(pixel(out, 3, 2, 1), vg);
    assert.deepEqual(pixel(out, 3, 2, 2), hg);
  });

  test('shortVBarYOff ist exklusiv - eine Short-V-Bar der Hoehe 0 ist erlaubt', () => {
    // 4.1.1.4 merkt das ausdruecklich an: "shortVBarYOff is exclusive, while
    // CLEARCODEC_BAND::yEnd is inclusive". yOn = yOff = 0 heisst: keine Pixel
    // im Strom, die Spalte ist reiner Hintergrund.
    const leer = [...u16(0), ...u16(0), ...u16(0), ...u16(1), 4, 5, 6, ...u16(0x0000)];
    const out = new ClearCodecDecoder().decode(strom(0x00, { bands: leer }), { width: 1, height: 2 });
    assert.deepEqual(all(out), [6, 5, 4, 255, 6, 5, 4, 255]);
  });

  test('der V-Bar-Speicher ueberlebt die Kachel', () => {
    // Genau das macht den Decoder zu einer Klasse mit Zustand: die zweite
    // Kachel enthaelt nur noch einen Verweis auf Platz 0.
    const decoder = new ClearCodecDecoder();
    decoder.decode(strom(0x00, { bands: band }), { width: 3, height: 3 });

    const nurTreffer = [...u16(0), ...u16(0), ...u16(0), ...u16(2), 0, 0, 0, ...u16(0x8000)];
    const out = decoder.decode(strom(0x00, { bands: nurTreffer }), { width: 1, height: 3 });
    assert.deepEqual(all(out), [3, 2, 1, 255, 7, 8, 9, 255, 3, 2, 1, 255]);
  });

  test('CLEARCODEC_FLAG_CACHE_RESET setzt den V-Bar-Cursor auf 0 zurueck', () => {
    // 2.2.4.1: zurueckgesetzt werden die beiden Cursor, nicht der Inhalt. Die
    // zweite Kachel legt ihre Spalte deshalb wieder auf Platz 0 ab und
    // ueberschreibt die der ersten.
    const decoder = new ClearCodecDecoder();
    decoder.decode(strom(0x00, { bands: band }), { width: 3, height: 3 });

    const andereSpalte = [...u16(0), ...u16(0), ...u16(0), ...u16(2), 1, 2, 3, ...u16(0x0300), 11, 12, 13, 21, 22, 23, 31, 32, 33];
    decoder.decode(strom(0x04, { bands: andereSpalte }), { width: 1, height: 3 });

    const nurTreffer = [...u16(0), ...u16(0), ...u16(0), ...u16(2), 0, 0, 0, ...u16(0x8000)];
    const out = decoder.decode(strom(0x00, { bands: nurTreffer }), { width: 1, height: 3 });
    assert.deepEqual(all(out), [13, 12, 11, 255, 23, 22, 21, 255, 33, 32, 31, 255]);
  });

  test('ein Treffer auf einen nie beschriebenen Platz wirft', () => {
    const nurTreffer = [...u16(0), ...u16(0), ...u16(0), ...u16(2), 0, 0, 0, ...u16(0x8123)];
    assert.throws(
      () => new ClearCodecDecoder().decode(strom(0x00, { bands: nurTreffer }), { width: 1, height: 3 }),
      istProtokollfehler(/VBAR_CACHE_HIT auf Platz 291/),
    );
  });

  test('ein Band ausserhalb des Bildes wirft', () => {
    const zuBreit = [...u16(0), ...u16(9), ...u16(0), ...u16(0), 0, 0, 0];
    assert.throws(
      () => new ClearCodecDecoder().decode(strom(0x00, { bands: zuBreit }), { width: 3, height: 3 }),
      istProtokollfehler(/ragt aus dem Bild/),
    );
  });
});

describe('ClearCodec - Subcodecschicht (2.2.4.1.1.3)', () => {
  /** CLEARCODEC_SUBCODEC-Kopf (2.2.4.1.1.3.1). */
  function subcodec(x: number, y: number, w: number, h: number, id: number, daten: number[]): number[] {
    return [...u16(x), ...u16(y), ...u16(w), ...u16(h), ...u32(daten.length), id, ...daten];
  }

  test('subCodecId 0x00 legt rohe BGR-Pixel an die angegebene Stelle', () => {
    // Das Teilbild ist 2x1 gross und sitzt in einem 3x2-Bild bei (1, 1).
    const daten = [10, 11, 12, 20, 21, 22];
    const out = new ClearCodecDecoder().decode(
      strom(0x00, { subcodec: subcodec(1, 1, 2, 1, 0x00, daten) }),
      { width: 3, height: 2 },
    );
    assert.deepEqual(pixel(out, 3, 1, 1), [12, 11, 10, 255]);
    assert.deepEqual(pixel(out, 3, 2, 1), [22, 21, 20, 255]);
    // Ausserhalb des Teilbildes bleibt es beim voreingestellten Schwarz.
    assert.deepEqual(pixel(out, 3, 0, 0), [0, 0, 0, 255]);
  });

  test('ein rohes Teilbild mit falscher Bytezahl wirft', () => {
    assert.throws(
      () =>
        new ClearCodecDecoder().decode(strom(0x00, { subcodec: subcodec(0, 0, 2, 1, 0x00, [1, 2, 3]) }), {
          width: 2,
          height: 1,
        }),
      istProtokollfehler(/braucht 6 Byte, geliefert wurden 3/),
    );
  });

  test('ein Teilbild ausserhalb des Bildes wirft', () => {
    assert.throws(
      () =>
        new ClearCodecDecoder().decode(strom(0x00, { subcodec: subcodec(2, 0, 2, 1, 0x00, [1, 2, 3, 4, 5, 6]) }), {
          width: 3,
          height: 1,
        }),
      istProtokollfehler(/ragt aus dem Bild/),
    );
  });

  test('RLEX: ein Segment liefert runLength plus suiteDepth + 1 Pixel', () => {
    // Nachbau des ersten Segments aus Beispiel 4.1.1.2 mit kleinerer Palette.
    // paletteCount = 2 -> floor(log2(1)) + 1 = 1 Bit fuer stopIndex, 7 Bit fuer
    // suiteDepth. Feldbyte 0x03 = stopIndex 1, suiteDepth 1; runLength 4.
    // startIndex = 1 - 1 = 0, also 4 Pixel Farbe 0, danach die Suite 0, 1.
    // Ergebnis: fuenfmal Farbe 0, einmal Farbe 1.
    const rlex = [
      2, // paletteCount
      0x10, 0x11, 0x12, // paletteEntries[0] als B, G, R
      0x20, 0x21, 0x22, // paletteEntries[1]
      0x03, 0x04, // stopIndex 1 / suiteDepth 1, runLengthFactor1 = 4
    ];
    const out = new ClearCodecDecoder().decode(
      strom(0x00, { subcodec: subcodec(0, 0, 3, 2, 0x02, rlex) }),
      { width: 3, height: 2 },
    );
    const a = [0x12, 0x11, 0x10, 255];
    const b = [0x22, 0x21, 0x20, 255];
    assert.deepEqual(all(out), [...a, ...a, ...a, ...a, ...a, ...b]);
  });

  test('RLEX: das Feldbyte 0x29 aus 4.1.1.2 zerlegt sich bei 14 Farben in 9 und 2', () => {
    // Die Spezifikation rechnet dieses Segment selbst vor: paletteCount = 14
    // ergibt 4 Bit fuer stopIndex, das Byte 0x29 also stopIndex 9 und
    // suiteDepth 2; mit runLength 0 liefert es genau die Suite 7, 8, 9.
    const palette: number[] = [];
    for (let i = 0; i < 14; i++) palette.push(i, 100 + i, 200 + i);
    const rlex = [14, ...palette, 0x29, 0x00];
    const out = new ClearCodecDecoder().decode(
      strom(0x00, { subcodec: subcodec(0, 0, 3, 1, 0x02, rlex) }),
      { width: 3, height: 1 },
    );
    assert.deepEqual(all(out), [207, 107, 7, 255, 208, 108, 8, 255, 209, 109, 9, 255]);
  });

  test('RLEX: ein stopIndex ausserhalb der Palette wirft', () => {
    const rlex = [2, 0x10, 0x11, 0x12, 0x20, 0x21, 0x22, 0x0f, 0x00];
    assert.throws(
      () =>
        new ClearCodecDecoder().decode(strom(0x00, { subcodec: subcodec(0, 0, 8, 1, 0x02, rlex) }), {
          width: 8,
          height: 1,
        }),
      istProtokollfehler(/ausserhalb der Palette/),
    );
  });

  test('eine unbekannte subCodecId wirft', () => {
    assert.throws(
      () =>
        new ClearCodecDecoder().decode(strom(0x00, { subcodec: subcodec(0, 0, 1, 1, 0x07, [0, 0, 0]) }), {
          width: 1,
          height: 1,
        }),
      istProtokollfehler(/unbekannte subCodecId 0x07/),
    );
  });
});

describe('ClearCodec - Subcodec NSCodec (MS-RDPNSC)', () => {
  /** NSCODEC_BITMAP_STREAM-Kopf (MS-RDPNSC 2.2.2). */
  function nsc(
    luma: number[],
    co: number[],
    cg: number[],
    alpha: number[],
    cll: number,
    subsampling: number,
  ): number[] {
    return [
      ...u32(luma.length),
      ...u32(co.length),
      ...u32(cg.length),
      ...u32(alpha.length),
      cll,
      subsampling,
      0x00, 0x00, // Reserved
      ...luma,
      ...co,
      ...cg,
      ...alpha,
    ];
  }

  function teilbild(w: number, h: number, daten: number[]): number[] {
    return [...u16(0), ...u16(0), ...u16(w), ...u16(h), ...u32(daten.length), 0x01, ...daten];
  }

  test('rohe Ebenen werden ueber die inverse AYCoCg-Matrix zurueckgerechnet', () => {
    // Dieselbe Rechnung wie im planaren Test, damit sich beide vergleichen
    // lassen: Y = 200, Co-Byte 0x14 (+20), Cg-Byte 0xf6 (-10), ColorLossLevel 1
    // ergibt Co = 40 und Cg = -20 (MS-RDPEGDI 3.1.9.1.4). Die inverse Matrix aus
    // 3.1.9.1.2 liefert R = 230, G = 190, B = 190.
    //
    // Hier wird R und B *nicht* getauscht - anders als in planarDecompress.
    // Die Begruendung samt Vorgeschichte steht in src/codec/clear.ts an der
    // Zuweisung.
    const daten = nsc([200, 200, 200, 200], [0x14, 0, 0, 0], [0xf6, 0, 0, 0], [], 1, 0);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(2, 2, daten) }), {
      width: 2,
      height: 2,
    });
    assert.deepEqual(pixel(out, 2, 0, 0), [230, 190, 190, 255]);
    assert.deepEqual(pixel(out, 2, 1, 0), [200, 200, 200, 255]);
  });

  test('Chroma wird aus 9 minus ColorLossLevel Bit vorzeichenerweitert', () => {
    // Regressionstest fuer reingruene Flecken in Fotos.
    //
    // Co und Cg sind laut MS-RDPEGDI 3.1.9.1.2 neun Bit breit; die
    // Farbverlustreduktion (3.1.9.1.4) schiebt sie um ColorLossLevel Bit nach
    // rechts. Im Ebenenbyte stecken also nur 9 - CLL nutzbare Bit, und aus
    // genau so vielen ist zu erweitern.
    //
    // Bei CLL = 3 sind das sechs Bit: 0x3F ist dort -1, nicht +63. Wer aus acht
    // Bit erweitert, macht daraus +63 und nach dem Schieben +504 - weit
    // ausserhalb der neun Bit. Ein derart grosses Cg treibt G an die Obergrenze
    // und drueckt R und B auf null: reines Gruen mitten im Bild.
    //
    // Luma 100, Co 0, Cg 0x3F ergibt richtig: Cg = -1 << 3 = -8,
    // t = 100 + 4 = 104, G = 104 - 8 = 96, B = 104, R = 104.
    const daten = nsc([100], [0x00], [0x3f], [], 3, 0);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(1, 1, daten) }), {
      width: 1,
      height: 1,
    });
    assert.deepEqual(all(out), [104, 96, 104, 255], 'aus acht Bit erweitert kaeme hier reines Gruen heraus');
  });

  test('Bei ColorLossLevel 1 bleiben alle acht Bit nutzbar', () => {
    // Gegenprobe zur Regel: bei CLL = 1 sind es 9 - 1 = 8 Bit, das Byte wird
    // also wie gewohnt aus acht Bit erweitert. 0xF6 ist dann -10.
    // Luma 200, Co 0, Cg -10 << 1 = -20: t = 200 + 10 = 210,
    // G = 210 - 20 = 190, B = 210, R = 210.
    const daten = nsc([200], [0x00], [0xf6], [], 1, 0);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(1, 1, daten) }), {
      width: 1,
      height: 1,
    });
    assert.deepEqual(all(out), [210, 190, 210, 255]);
  });

  test('Werte ausserhalb 0..255 werden begrenzt', () => {
    // Y = 250, Co = 0, Cg-Byte 0x40 bei CLL 1 -> Cg = 128:
    //   R = 250 - 64 = 186, G = 250 + 64 = 314, B = 250 - 64 = 186.
    // 3.1.9.1.2 verlangt "clamping between 0 and 255", also G = 255.
    const daten = nsc([250], [0x00], [0x40], [], 1, 0);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(1, 1, daten) }), {
      width: 1,
      height: 1,
    });
    assert.deepEqual(all(out), [186, 255, 186, 255]);
  });

  test('RLE-Ebene: Laufsegment, Literalsegment und EndData', () => {
    // MS-RDPNSC 2.2.2: eine Ebene ist genau dann RLE-kodiert, wenn ihre
    // Bytezahl kleiner als die Rohgroesse ist. Rohgroesse hier 4*3 = 12 Byte,
    // geliefert werden 8. Die letzten vier Byte der Ebene stehen laut 2.2.2.1
    // immer roh in EndData.
    //   0x10             -> NSCODEC_RLE_LITERAL_SEGMENT (2.2.2.2.2)
    //   0x20 0x20 0x05   -> NSCODEC_RLE_RUN_SEGMENT, Laenge 5 + 2 = 7
    //   0x30 0x30 0x30 0x30 -> EndData
    const luma = [0x10, 0x20, 0x20, 0x05, 0x30, 0x30, 0x30, 0x30];
    const grau = new Array<number>(12).fill(0x00);
    const daten = nsc(luma, grau, grau, [], 1, 0);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(4, 3, daten) }), {
      width: 4,
      height: 3,
    });
    const werte = [0x10, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x30, 0x30, 0x30, 0x30];
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(
        pixel(out, 4, i % 4, (i / 4) | 0),
        [werte[i], werte[i], werte[i], 255],
        `Pixel ${i} der RLE-Ebene`,
      );
    }
  });

  test('Chroma-Subsampling rundet die Lumabreite auf 8 und die Chromahoehe auf 2 auf', () => {
    // MS-RDPNSC 2.2.2 bei ChromaSubsamplingLevel = 1 und einem 3x3-Bild:
    //   LumaPlaneWidth   = ROUND_UP_TO_NEAREST_MULTIPLE_OF_8(3)     = 8
    //   ChromaPlaneWidth = ROUND_UP_TO_NEAREST_MULTIPLE_OF_8(3) / 2 = 4
    //   ChromaPlaneHeight= ROUND_UP_TO_NEAREST_MULTIPLE_OF_2(3) / 2 = 2
    // Ein Chromawert deckt anschliessend ein 2x2-Feld ab (MS-RDPEGDI 3.1.9.1.3).
    const luma = new Array<number>(8 * 3).fill(100);
    const co = [10, 20, 0, 0, 0, 0, 0, 0];
    const cg = new Array<number>(8).fill(0);
    const daten = nsc(luma, co, cg, [], 1, 1);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(3, 3, daten) }), {
      width: 3,
      height: 3,
    });

    // Cg = 0, also G = Y und B = Y - Co/2, R = Y + Co/2.
    // Co-Byte 10 bei CLL 1 -> Co = 20 -> R = 110, B = 90.
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
      assert.deepEqual(pixel(out, 3, x, y), [110, 100, 90, 255], `Pixel (${x},${y})`);
    }
    // Der rechte Rand liegt im zweiten Chromafeld (Co-Byte 20 -> Co = 40).
    assert.deepEqual(pixel(out, 3, 2, 0), [120, 100, 80, 255]);
    assert.deepEqual(pixel(out, 3, 2, 1), [120, 100, 80, 255]);
    // Die dritte Zeile liegt in der zweiten Chromazeile, dort steht ueberall 0.
    assert.deepEqual(pixel(out, 3, 0, 2), [100, 100, 100, 255]);
    assert.deepEqual(pixel(out, 3, 2, 2), [100, 100, 100, 255]);
  });

  test('eine vorhandene Alphaebene wird uebernommen', () => {
    // 2.2.2: die Alphaebene fehlt genau dann, wenn AlphaPlaneByteCount 0 ist.
    const daten = nsc([100, 100], [0, 0], [0, 0], [0x00, 0x80], 1, 0);
    const out = new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(2, 1, daten) }), {
      width: 2,
      height: 1,
    });
    assert.equal(pixel(out, 2, 0, 0)[3], 0x00);
    assert.equal(pixel(out, 2, 1, 0)[3], 0x80);
  });

  test('ColorLossLevel 0 wird abgewiesen', () => {
    // 2.2.2: "This value MUST be in the range 1 to 7 (inclusive)."
    const daten = nsc([100], [0], [0], [], 0, 0);
    assert.throws(
      () =>
        new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(1, 1, daten) }), { width: 1, height: 1 }),
      istProtokollfehler(/ColorLossLevel 0/),
    );
  });

  test('eine Ebene groesser als ihre Rohgroesse wird abgewiesen', () => {
    const daten = nsc([1, 2, 3, 4], [0], [0], [], 1, 0);
    assert.throws(
      () =>
        new ClearCodecDecoder().decode(strom(0x00, { subcodec: teilbild(1, 1, daten) }), { width: 1, height: 1 }),
      istProtokollfehler(/LumaPlane meldet 4 Byte/),
    );
  });
});

describe('ClearCodec - Stapelung der drei Schichten (3.3.8.1)', () => {
  test('Subcodec liegt ueber Band, Band ueber Residual', () => {
    // Alle drei Schichten treffen im selben 2x2-Bild aufeinander:
    //   Residual faerbt alle vier Pixel,
    //   das Band ueberschreibt die linke Spalte,
    //   der Subcodec ueberschreibt davon noch das Pixel links oben.
    const residual = [1, 1, 1, 4];
    const band = [
      ...u16(0), ...u16(0), ...u16(0), ...u16(1),
      2, 2, 2, // Hintergrund des Bandes
      ...u16(0x0000), // SHORT_VBAR_CACHE_MISS, yOn = yOff = 0: nur Hintergrund
    ];
    const sub = [...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(3), 0x00, 3, 3, 3];

    const out = new ClearCodecDecoder().decode(strom(0x00, { residual, bands: band, subcodec: sub }), {
      width: 2,
      height: 2,
    });
    assert.deepEqual(pixel(out, 2, 0, 0), [3, 3, 3, 255], 'Subcodec zuoberst');
    assert.deepEqual(pixel(out, 2, 0, 1), [2, 2, 2, 255], 'Band ueber Residual');
    assert.deepEqual(pixel(out, 2, 1, 0), [1, 1, 1, 255], 'Residual bleibt stehen');
    assert.deepEqual(pixel(out, 2, 1, 1), [1, 1, 1, 255], 'Residual bleibt stehen');
  });
});

describe('ClearCodec - Glyph-Cache (2.2.4.1, 3.3.1.9)', () => {
  const inhalt = strom(0x01, { residual: [10, 20, 30, 4] }, 7);
  /** CLEARCODEC_FLAG_GLYPH_INDEX | CLEARCODEC_FLAG_GLYPH_HIT, sonst nichts. */
  const treffer = Buffer.from([0x03, 0x01, ...u16(7)]);

  test('ein Glyph wird abgelegt und beim Treffer unveraendert zurueckgegeben', () => {
    const decoder = new ClearCodecDecoder();
    const erst = decoder.decode(inhalt, { width: 2, height: 2 });
    assert.deepEqual(all(erst), [30, 20, 10, 255, 30, 20, 10, 255, 30, 20, 10, 255, 30, 20, 10, 255]);

    // 4.1.1.4: bei vorhandenem glyphIndex wird der Cacheplatz nach dem
    // Dekodieren mit dem fertigen Bild beschrieben. Der Treffer besteht dann
    // nur noch aus flags, seqNumber und glyphIndex - vier Byte.
    assert.equal(treffer.length, 4);
    assert.deepEqual(all(decoder.decode(treffer, { width: 2, height: 2 })), all(erst));
  });

  test('der Treffer liefert eine Kopie, nicht den Cacheeintrag selbst', () => {
    const decoder = new ClearCodecDecoder();
    decoder.decode(inhalt, { width: 2, height: 2 });
    const a = decoder.decode(treffer, { width: 2, height: 2 });
    a[0] = 0;
    const b = decoder.decode(treffer, { width: 2, height: 2 });
    assert.equal(b[0], 30, 'der Cache wurde vom Aufrufer veraendert');
  });

  test('ein Treffer ohne vorheriges Ablegen wirft, statt Muell zu liefern', () => {
    assert.throws(
      () => new ClearCodecDecoder().decode(treffer, { width: 2, height: 2 }),
      istProtokollfehler(/Cache-Treffer auf Glyph 7, dort wurde aber noch nie/),
    );
  });

  test('reset leert den Glyph-Cache', () => {
    const decoder = new ClearCodecDecoder();
    decoder.decode(inhalt, { width: 2, height: 2 });
    decoder.reset();
    assert.throws(() => decoder.decode(treffer, { width: 2, height: 2 }), istProtokollfehler(/noch nie/));
  });

  test('ein Treffer mit unpassender Kachelgroesse wirft', () => {
    const decoder = new ClearCodecDecoder();
    decoder.decode(inhalt, { width: 2, height: 2 });
    assert.throws(
      () => decoder.decode(treffer, { width: 3, height: 1 }),
      istProtokollfehler(/enthaelt 4 Pixel, die Kachel verlangt aber 3 \(3x1\)/),
    );
  });

  test('CLEARCODEC_FLAG_GLYPH_HIT ohne CLEARCODEC_FLAG_GLYPH_INDEX wirft', () => {
    // 2.2.4.1: "This flag MUST NOT be present if the
    // CLEARCODEC_FLAG_GLYPH_INDEX (0x01) flag is not present."
    assert.throws(
      () => new ClearCodecDecoder().decode(Buffer.from([0x02, 0x00]), { width: 1, height: 1 }),
      istProtokollfehler(/GLYPH_HIT ohne CLEARCODEC_FLAG_GLYPH_INDEX/),
    );
  });

  test('ein Treffer darf keine Nutzlast mitbringen', () => {
    // 2.2.4.1: "In this case, the compositePayload field MUST NOT be present."
    assert.throws(
      () => new ClearCodecDecoder().decode(Buffer.from([0x03, 0x00, ...u16(7), 0x00]), { width: 1, height: 1 }),
      istProtokollfehler(/trotzdem folgen noch 1 Byte/),
    );
  });

  test('glyphIndex ausserhalb 0..3999 wirft', () => {
    assert.throws(
      () => new ClearCodecDecoder().decode(strom(0x01, { residual: [1, 2, 3, 1] }, 4000), { width: 1, height: 1 }),
      istProtokollfehler(/glyphIndex 4000/),
    );
  });

  test('ein Glyph mit mehr als 1024 Pixeln Flaeche wirft', () => {
    // 2.2.4.1: "This flag MUST NOT be used in conjunction with a bitmap that
    // has an area larger than 1024 square pixels."
    assert.throws(
      () => new ClearCodecDecoder().decode(strom(0x01, { residual: [1, 2, 3, 1] }, 0), { width: 33, height: 33 }),
      istProtokollfehler(/nur Bilder bis 1024 Pixel/),
    );
  });
});

describe('ClearCodec - abgeschnittene und widerspruechliche Stroeme', () => {
  const decoder = new ClearCodecDecoder();

  test('leerer Puffer', () => {
    assert.throws(() => decoder.decode(Buffer.alloc(0), { width: 1, height: 1 }), istProtokollfehler(/flags/));
  });

  test('Kopf ohne compositePayload', () => {
    assert.throws(
      () => decoder.decode(Buffer.from([0x00, 0x00]), { width: 1, height: 1 }),
      istProtokollfehler(/residualByteCount/),
    );
  });

  test('glyphIndex angekuendigt, aber nur ein Byte da', () => {
    assert.throws(
      () => decoder.decode(Buffer.from([0x01, 0x00, 0x05]), { width: 1, height: 1 }),
      istProtokollfehler(/glyphIndex braucht 2 Byte/),
    );
  });

  test('die drei Schichtlaengen versprechen mehr, als im Strom steht', () => {
    const kopf = Buffer.from([0x00, 0x00, ...u32(100), ...u32(0), ...u32(0), 1, 2, 3]);
    assert.throws(
      () => decoder.decode(kopf, { width: 1, height: 1 }),
      istProtokollfehler(/beanspruchen 100 Byte .* nur noch 3/),
    );
  });

  test('Residualsegment mitten in der Lauflaenge abgeschnitten', () => {
    assert.throws(
      () => decoder.decode(strom(0x00, { residual: [1, 2, 3] }), { width: 2, height: 2 }),
      istProtokollfehler(/runLengthFactor1 braucht 1 Byte/),
    );
  });

  test('Bandkopf abgeschnitten', () => {
    assert.throws(
      () => decoder.decode(strom(0x00, { bands: [...u16(0), ...u16(0), ...u16(0)] }), { width: 1, height: 1 }),
      istProtokollfehler(/CLEARCODEC_BAND::yEnd/),
    );
  });

  test('shortVBarPixels abgeschnitten', () => {
    const band = [...u16(0), ...u16(0), ...u16(0), ...u16(2), 0, 0, 0, ...u16(0x0300), 1, 2, 3];
    assert.throws(
      () => decoder.decode(strom(0x00, { bands: band }), { width: 1, height: 3 }),
      istProtokollfehler(/shortVBarPixels braucht 9 Byte/),
    );
  });

  test('bitmapData eines Subcodecs abgeschnitten', () => {
    const sub = [...u16(0), ...u16(0), ...u16(2), ...u16(2), ...u32(12), 0x00, 1, 2, 3];
    assert.throws(
      () => decoder.decode(strom(0x00, { subcodec: sub }), { width: 2, height: 2 }),
      istProtokollfehler(/bitmapData braucht 12 Byte/),
    );
  });

  test('RLEX-Palette abgeschnitten', () => {
    const sub = [...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(3), 0x02, 5, 1, 2];
    assert.throws(
      () => decoder.decode(strom(0x00, { subcodec: sub }), { width: 1, height: 1 }),
      istProtokollfehler(/paletteEntries braucht 15 Byte/),
    );
  });

  test('NSCodec-Ebene mitten im RLE-Segment abgeschnitten', () => {
    // Rohgroesse 4*3 = 12, angekuendigt 5 Byte: die Segmente muessen 8 Byte
    // erzeugen und danach kommen 4 Byte EndData - das kann nicht aufgehen.
    const daten = [...u32(5), ...u32(12), ...u32(12), ...u32(0), 1, 0, 0, 0, 0x10, 0x20, 0x20, 0x05, 0x30];
    const sub = [...u16(0), ...u16(0), ...u16(4), ...u16(3), ...u32(daten.length), 0x01, ...daten];
    assert.throws(
      () => decoder.decode(strom(0x00, { subcodec: sub }), { width: 4, height: 3 }),
      istProtokollfehler(/endet mitten in einem RLE-Segment/),
    );
  });

  test('unplausible Zielgroessen', () => {
    const gueltig = strom(0x00, { residual: [1, 2, 3, 1] });
    assert.throws(() => decoder.decode(gueltig, { width: 0, height: 4 }), RdpProtocolError);
    assert.throws(() => decoder.decode(gueltig, { width: 4, height: -1 }), RdpProtocolError);
    assert.throws(() => decoder.decode(gueltig, { width: 1.5, height: 4 }), RdpProtocolError);
    assert.throws(() => decoder.decode(gueltig, { width: 0x10000, height: 2 }), RdpProtocolError);
  });
});
