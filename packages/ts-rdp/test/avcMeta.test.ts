import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import * as avc from '../src/codec/avcMeta.js';

// Alle Testeingaben werden hier aus Byte-Listen aufgebaut, nicht mit den
// Schreibhelfern des Pakets erzeugt. So steht im Test schwarz auf weiss, welche
// Bytes der Parser sehen soll - ein Fehler in einem Schreibhelfer koennte den
// Test sonst gemeinsam mit dem Parser in dieselbe falsche Richtung ziehen.

/** UINT32 Little Endian. */
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** UINT16 Little Endian. */
function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

/** RDPGFX_RECT16 (MS-RDPEGFX 2.2.1.2). */
function rect16(left: number, top: number, right: number, bottom: number): number[] {
  return [...u16(left), ...u16(top), ...u16(right), ...u16(bottom)];
}

/**
 * RDPGFX_AVC420_QUANT_QUALITY (2.2.4.4.2), 2 Byte: qpVal mit qp in Bit 0-5,
 * dem reservierten Bit 6 und p in Bit 7, danach qualityVal.
 */
function quantQuality(qp: number, quality: number, progressiv = false, reserviert = false): number[] {
  return [(qp & 0x3f) | (reserviert ? 0x40 : 0) | (progressiv ? 0x80 : 0), quality];
}

/** Etwas, das wie ein H.264-Annex-B-Strom aussieht; der Inhalt ist beliebig. */
function annexB(marke: number): number[] {
  return [0x00, 0x00, 0x00, 0x01, 0x65, marke, marke ^ 0xff];
}

/** avc420EncodedBitstreamInfo (2.2.4.5): cb in Bit 0-29, LC in Bit 30-31. */
function bitstreamInfo(cb: number, lc: number): number[] {
  return u32(((lc & 0x3) * 0x40000000 + (cb & 0x3fffffff)) >>> 0);
}

describe('RFX_AVC420_BITMAP_STREAM (MS-RDPEGFX 2.2.4.4)', () => {
  test('Mehrere Regionen: erst alle Rechtecke, dann alle Quant-Quality-Paare', () => {
    // 2.2.4.4.1 legt zwei getrennte Arrays hintereinander, nicht abwechselnd
    // Rechteck und Guetewert. Genau das prueft dieser Fall.
    const daten = Buffer.from([
      ...u32(3), // numRegionRects
      ...rect16(0, 0, 64, 32),
      ...rect16(64, 32, 128, 64),
      ...rect16(10, 20, 30, 40),
      ...quantQuality(28, 100),
      ...quantQuality(51, 75, true),
      ...quantQuality(0, 0),
      ...annexB(0xab),
    ]);

    const strom = avc.parseAvc420(daten);
    assert.equal(strom.regions.length, 3);
    assert.deepEqual(
      strom.regions.map((r) => r.rect),
      [
        { left: 0, top: 0, right: 64, bottom: 32 },
        { left: 64, top: 32, right: 128, bottom: 64 },
        { left: 10, top: 20, right: 30, bottom: 40 },
      ],
    );
    assert.deepEqual(strom.regions.map((r) => r.qp), [28, 51, 0]);
    assert.deepEqual(strom.regions.map((r) => r.quality), [100, 75, 0]);
    assert.deepEqual(strom.regions.map((r) => r.progressive), [false, true, false]);
    assert.deepEqual([...strom.bitstream], annexB(0xab));
  });

  test('Ein einzelnes Rechteck wird gelesen und der Rest ist der Bitstream', () => {
    const daten = Buffer.from([
      ...u32(1),
      ...rect16(0, 0, 1920, 1080),
      ...quantQuality(30, 90),
      ...annexB(0x11),
    ]);

    const strom = avc.parseAvc420(daten);
    assert.deepEqual(strom.regions, [
      { rect: { left: 0, top: 0, right: 1920, bottom: 1080 }, qp: 30, quality: 90, progressive: false },
    ]);
    assert.deepEqual([...strom.bitstream], annexB(0x11));
  });

  test('qpVal: qp sind die unteren 6 Bit, p ist Bit 7, Bit 6 bleibt unbeachtet', () => {
    // 0x3F = qp 63 ohne weitere Bits, 0xFF = qp 63 mit gesetztem Reserve- und
    // p-Bit. Beide muessen dasselbe qp liefern - lesen wir versehentlich das
    // ganze Byte, faellt der zweite Fall sofort auf.
    for (const [byte, qp, progressiv] of [
      [0x3f, 63, false],
      [0xff, 63, true],
      [0x80, 0, true],
      [0x40, 0, false],
    ] as const) {
      const daten = Buffer.from([...u32(1), ...rect16(0, 0, 16, 16), byte, 50, ...annexB(1)]);
      const region = avc.parseAvc420(daten).regions[0];
      assert.equal(region.qp, qp, `qp fuer qpVal 0x${byte.toString(16)}`);
      assert.equal(region.progressive, progressiv, `p fuer qpVal 0x${byte.toString(16)}`);
      assert.equal(region.quality, 50);
    }
  });

  test('numRegionRects = 0 ist zulaessig, die Nutzlast ist dann reiner Bitstream', () => {
    const strom = avc.parseAvc420(Buffer.from([...u32(0), ...annexB(0x7e)]));
    assert.deepEqual(strom.regions, []);
    assert.deepEqual([...strom.bitstream], annexB(0x7e));
  });

  test('Ein numRegionRects ueber die Puffergrenze hinaus wird abgewiesen', () => {
    // Angekuendigt sind 3 Regionen (3 * 10 = 30 Byte), vorhanden ist nur eine.
    const daten = Buffer.from([...u32(3), ...rect16(0, 0, 8, 8), ...quantQuality(20, 80)]);
    assert.throws(() => avc.parseAvc420(daten), /numRegionRects = 3/);
  });

  test('Ein absurd grosses numRegionRects wird abgewiesen, statt Speicher zu belegen', () => {
    const daten = Buffer.from([...u32(0xffffffff), ...rect16(0, 0, 8, 8), ...quantQuality(20, 80)]);
    assert.throws(() => avc.parseAvc420(daten), /numRegionRects/);
  });

  test('Ein hinter den Rechtecken abgeschnittener METABLOCK wird abgewiesen', () => {
    // Zwei Rechtecke vollstaendig, danach nur ein Byte des ersten
    // Quant-Quality-Paars: die Gesamtlaenge stimmt nicht mehr.
    const daten = Buffer.from([...u32(2), ...rect16(0, 0, 8, 8), ...rect16(8, 8, 16, 16), 0x1c]);
    assert.throws(() => avc.parseAvc420(daten), /numRegionRects = 2/);
  });

  test('Ein Puffer, der nicht einmal numRegionRects traegt, wird abgewiesen', () => {
    assert.throws(() => avc.parseAvc420(Buffer.from([0x01, 0x00, 0x00])), /numRegionRects verlangt 4 Byte/);
  });

  test('Ein METABLOCK ohne folgenden Bitstream wird abgewiesen', () => {
    const daten = Buffer.from([...u32(1), ...rect16(0, 0, 8, 8), ...quantQuality(20, 80)]);
    assert.throws(() => avc.parseAvc420(daten), /avc420EncodedBitstream ist leer/);
  });
});

describe('RFX_AVC444_BITMAP_STREAM (MS-RDPEGFX 2.2.4.5)', () => {
  /** Ein vollstaendiger RFX_AVC420_BITMAP_STREAM mit genau einer Region. */
  function avc420(marke: number, qp = 26, quality = 80): number[] {
    return [...u32(1), ...rect16(0, 0, 32, 32), ...quantQuality(qp, quality), ...annexB(marke)];
  }

  test('LC = 0x0: YUV420 in Bitstream 1, Chroma420 in Bitstream 2', () => {
    const luma = avc420(0x01, 26, 80);
    const chroma = avc420(0x02, 33, 60);
    const daten = Buffer.from([...bitstreamInfo(luma.length, 0x0), ...luma, ...chroma]);

    const strom = avc.parseAvc444(daten);
    assert.equal(strom.lc, avc.AVC444_LC_YUV420_UND_CHROMA420);
    assert.ok(strom.luma, 'luma muss vorhanden sein');
    assert.ok(strom.chroma, 'chroma muss vorhanden sein');
    assert.equal(strom.luma!.regions[0].qp, 26);
    assert.equal(strom.chroma!.regions[0].qp, 33);
    assert.deepEqual([...strom.luma!.bitstream], annexB(0x01));
    assert.deepEqual([...strom.chroma!.bitstream], annexB(0x02));
  });

  test('LC = 0x1: nur der YUV420-Teilrahmen, kein Chroma', () => {
    const luma = avc420(0x03, 22, 95);
    const daten = Buffer.from([...bitstreamInfo(luma.length, 0x1), ...luma]);

    const strom = avc.parseAvc444(daten);
    assert.equal(strom.lc, avc.AVC444_LC_NUR_YUV420);
    assert.equal(strom.chroma, undefined);
    assert.equal(strom.luma!.regions[0].quality, 95);
    assert.deepEqual([...strom.luma!.bitstream], annexB(0x03));
  });

  test('LC = 0x2: Bitstream 1 traegt den Chroma420-Rahmen, cb ist null', () => {
    // Der haeufigste Stolperstein: bei LC = 0x2 steht in Bitstream 1 *nicht*
    // der Luma-Rahmen. cbAvc420EncodedBitstream1 ist null, weil es keinen
    // YUV420-Rahmen gibt - die Laenge des Chromastroms steht nirgends.
    const chroma = avc420(0x04, 40, 55);
    const daten = Buffer.from([...bitstreamInfo(0, 0x2), ...chroma]);

    const strom = avc.parseAvc444(daten);
    assert.equal(strom.lc, avc.AVC444_LC_NUR_CHROMA420);
    assert.equal(strom.luma, undefined);
    assert.equal(strom.chroma!.regions[0].qp, 40);
    assert.deepEqual([...strom.chroma!.bitstream], annexB(0x04));
  });

  test('LC steht in den oberen zwei Bits und faelscht cb nicht', () => {
    // Ein cb, dessen obere Bits gesetzt waeren, wenn man die Maske vergisst:
    // der Rumpf ist 0x2A Byte lang, LC = 0x2 macht daraus den Rohwert
    // 0x8000002A. Ohne Maske laese man eine absurde Laenge.
    const chroma = avc420(0x05);
    const roh = Buffer.from([...bitstreamInfo(chroma.length, 0x2), ...chroma]);
    assert.equal(roh.readUInt32LE(0) >>> 30, 0x2);
    assert.equal(roh.readUInt32LE(0) & 0x3fffffff, chroma.length);
    assert.equal(avc.parseAvc444(roh).lc, 0x2);
  });

  test('LC = 0x3 ist laut Spezifikation ungueltig und wird abgewiesen', () => {
    const daten = Buffer.from([...bitstreamInfo(0, 0x3), ...avc420(0x06)]);
    assert.throws(() => avc.parseAvc444(daten), /LC = 0x3/);
  });

  test('Ein cb groesser als die Nutzlast wird abgewiesen', () => {
    const luma = avc420(0x07);
    const daten = Buffer.from([...bitstreamInfo(luma.length + 16, 0x0), ...luma]);
    assert.throws(() => avc.parseAvc444(daten), /nach dem Kopf sind aber nur/);
  });

  test('Ein cb, das LC = 0x1 widerspricht, wird abgewiesen', () => {
    // Bei LC = 0x1 fuellt der einzige Teilrahmen den Rest. Ein cb, das kuerzer
    // ist als der Rumpf, deutet auf eine verstuemmelte Nachricht hin.
    const luma = avc420(0x08);
    const daten = Buffer.from([...bitstreamInfo(luma.length - 4, 0x1), ...luma]);
    assert.throws(() => avc.parseAvc444(daten), /widerspricht/);
  });

  test('Ein am Ende abgeschnittener AVC444-Strom wird abgewiesen', () => {
    const luma = avc420(0x09);
    const chroma = avc420(0x0a);
    const vollstaendig = Buffer.from([...bitstreamInfo(luma.length, 0x0), ...luma, ...chroma]);
    // Der Chroma-Teilrahmen verliert alles bis auf seinen METABLOCK.
    const gekuerzt = vollstaendig.subarray(0, vollstaendig.length - annexB(0x0a).length);
    assert.throws(() => avc.parseAvc444(gekuerzt), /avc420EncodedBitstream ist leer/);
  });

  test('Ein Puffer ohne vollstaendigen Kopf wird abgewiesen', () => {
    assert.throws(() => avc.parseAvc444(Buffer.from([0x01, 0x00, 0x00])), /avc420EncodedBitstreamInfo verlangt 4 Byte/);
  });

  test('AVC444V2 (2.2.4.6) hat dasselbe Drahtformat', () => {
    const luma = avc420(0x0b);
    const daten = Buffer.from([...bitstreamInfo(luma.length, 0x1), ...luma]);
    assert.deepEqual(avc.parseAvc444V2(daten), avc.parseAvc444(daten));
  });
});
