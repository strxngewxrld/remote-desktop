import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BitLeser,
  ProgressiveDecoder,
  ProgressiveTile,
  RLGR1,
  RLGR3,
  SrlLeser,
  dequantisiere,
  inverseDwt,
  inverseDwt1d,
  rlgrDekodieren,
  ycbcrNachRgba,
} from '../src/codec/progressive.js';
import { RdpProtocolError } from '../src/core/errors.js';

/**
 * Alle synthetischen Stroeme dieser Datei sind Byte fuer Byte von Hand gesetzt.
 * Die Helfer unten schreiben ausschliesslich Zahlen in die Little-Endian-
 * Bytefolge, die MS-RDPEGFX 2.2.4.2 durchgehend verwendet - bewusst kein
 * Schreibhelfer des Pakets, denn ein Kodierer aus demselben Kopf wuerde
 * denselben Irrtum machen wie der Parser und der Test waere wertlos.
 */
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

/** RFX_PROGRESSIVE_DATABLOCK (2.2.4.2.1): blockType, blockLen inklusive Kopf, blockData. */
const block = (typ: number, rumpf: number[]): number[] => [...u16(typ), ...u32(rumpf.length + 6), ...rumpf];

/** TS_RFX_RECT ([MS-RDPRFX] 2.2.2.1.6). */
const rect = (x: number, y: number, w: number, h: number): number[] => [
  ...u16(x),
  ...u16(y),
  ...u16(w),
  ...u16(h),
];

/**
 * RFX_COMPONENT_CODEC_QUANT (2.2.4.2.1.5.2) mit lauter Sechsen: der
 * Skalenfaktor 1 << (6 - 6) ist eins, die Dequantisierung veraendert also
 * nichts ausser der Festkommaverschiebung.
 */
const QUANT_SECHS = [0x66, 0x66, 0x66, 0x66, 0x66];
const QUANT_NULL = [0x00, 0x00, 0x00, 0x00, 0x00];

/**
 * RFX_PROGRESSIVE_CODEC_QUANT (2.2.4.2.1.5.1) fuer den Erstdurchgang:
 * quality 0x32, danach je fuenf Byte fuer Y, Cb und Cr.
 *
 * Die Y-Bytes 02 00 00 00 10 bedeuten LL3 = 2 (unteres Nibble des ersten Byte)
 * und HH1 = 1 (oberes Nibble des fuenften); alle anderen Bitpositionen sind
 * null. Cb und Cr bleiben komplett auf null, damit im Aufwertungslauf nur die
 * Luma Bits nachbekommt und das Ergebnis eine reine Graustufe bleibt.
 */
const PROGQUANT_A = [0x32, 0x02, 0x00, 0x00, 0x00, 0x10, ...QUANT_NULL, ...QUANT_NULL];
/** Zieltabelle des Aufwertungslaufs: ueberall Bitposition null, also volle Qualitaet. */
const PROGQUANT_B = [0x64, ...QUANT_NULL, ...QUANT_NULL, ...QUANT_NULL];

/**
 * RFX_PROGRESSIVE_REGION (2.2.4.2.1.5) ueber genau eine Kachel bei (0, 0).
 *
 * flags = RFX_DWT_REDUCE_EXTRAPOLATE, weil der Zielserver ausschliesslich so
 * kodiert und die Bandgroessen damit 33/31, 17/16 und 9/8 sind.
 */
function region(progTabellen: number[][], kacheln: number[]): number[] {
  return block(0xccc4, [
    0x40, // tileSize
    ...u16(1), // numRects
    1, // numQuant
    progTabellen.length, // numProgQuant
    0x01, // flags = RFX_DWT_REDUCE_EXTRAPOLATE
    ...u16(1), // numTiles
    ...u32(kacheln.length), // tileDataSize
    ...rect(0, 0, 64, 64),
    ...QUANT_SECHS,
    ...progTabellen.flat(),
    ...kacheln,
  ]);
}

/** RFX_PROGRESSIVE_TILE_FIRST (2.2.4.2.1.5.4). */
function tileFirst(flags: number, progQual: number, y: number[], cb: number[], cr: number[]): number[] {
  return block(0xccc6, [
    0, 0, 0, // quantIdxY, quantIdxCb, quantIdxCr
    ...u16(0), // xIdx
    ...u16(0), // yIdx
    flags,
    progQual,
    ...u16(y.length),
    ...u16(cb.length),
    ...u16(cr.length),
    ...u16(0), // tailLen
    ...y,
    ...cb,
    ...cr,
  ]);
}

/** RFX_PROGRESSIVE_TILE_UPGRADE (2.2.4.2.1.5.5) - ohne flags-Feld! */
function tileUpgrade(progQual: number, srl: number[][], roh: number[][]): number[] {
  return block(0xccc7, [
    0, 0, 0,
    ...u16(0),
    ...u16(0),
    progQual,
    ...u16(srl[0].length),
    ...u16(roh[0].length),
    ...u16(srl[1].length),
    ...u16(roh[1].length),
    ...u16(srl[2].length),
    ...u16(roh[2].length),
    ...srl[0], ...roh[0],
    ...srl[1], ...roh[1],
    ...srl[2], ...roh[2],
  ]);
}

const SYNC = block(0xccc0, [...u32(0xcaccacca), ...u16(0x0100)]);
const CONTEXT = block(0xccc3, [0x00, ...u16(64), 0x01]);
const FRAME_BEGIN = block(0xccc1, [...u32(0), ...u16(1)]);
const FRAME_END = block(0xccc2, []);

/**
 * Der kuerzeste RLGR1-Strom, der 4096 Nullen liefert.
 *
 * Im RL-Modus ist jedes "0"-Bit ein Fluchtzeichen fuer (1 << k) Nullen und hebt
 * kp um vier. Aus 21 Nullbits werden so 2 + 2 + 4 + 4 + 8 + ... = ueber 4096
 * Nullen; drei Nullbytes reichen also mit Reserve.
 */
const RLGR1_NUR_NULLEN = [0x00, 0x00, 0x00];

/**
 * Rohbits des Aufwertungslaufs fuer das LL3-Band: 81 mal der Zweibitwert 1.
 *
 * "01" wiederholt ergibt 0x55; das 81. Paar faellt in das 21. Byte und steht
 * dort in den obersten zwei Bit (0x40). Rohbits laufen ohne Fuellung
 * hintereinander weg (3.2.8.1.5.2.1).
 */
const ROHBITS_LL3 = [...new Array(20).fill(0x55), 0x40];

/**
 * SRL-Strom des Aufwertungslaufs fuer das HH1-Band mit nBits = 1.
 *
 * Bits: "1" schliesst einen Nulllauf ab, "0" ist dessen einziges Laengenbit
 * (K = 1 zu Beginn), also Lauflaenge null; danach folgt unmittelbar der Wert.
 * Bei nBits = 1 besteht der Wert nur aus dem Vorzeichenbit "1", der Betrag kann
 * 1 nicht ueberschreiten (3.1.8.1.5.2). "101" plus Fuellnullen ergibt 0xA0;
 * die drei weiteren Nullbytes tragen den langen Nulllauf fuer die restlichen
 * 960 Elemente des Bandes.
 */
const SRL_HH1 = [0xa0, 0x00, 0x00, 0x00];

function istProtokollfehler(muster: RegExp): (e: unknown) => boolean {
  return (e: unknown) => e instanceof RdpProtocolError && muster.test(e.message);
}

/** Zaehlt, wie oft welche Farbe in einer Kachel vorkommt. */
function farben(kachel: ProgressiveTile): Map<string, number> {
  const zaehl = new Map<string, number>();
  for (let i = 0; i < kachel.rgba.length; i += 4) {
    const s = `${kachel.rgba[i]},${kachel.rgba[i + 1]},${kachel.rgba[i + 2]},${kachel.rgba[i + 3]}`;
    zaehl.set(s, (zaehl.get(s) ?? 0) + 1);
  }
  return zaehl;
}

function pixel(kachel: ProgressiveTile, x: number, y: number): number[] {
  const o = (y * kachel.width + x) * 4;
  return [kachel.rgba[o], kachel.rgba[o + 1], kachel.rgba[o + 2], kachel.rgba[o + 3]];
}

// ---------------------------------------------------------------------------

describe('Progressive - RLGR1 aus den durchgerechneten Beispielen', () => {
  /**
   * MS-RDPEGFX 4.1.2.1.1 "Encode Frame #1 at 25%". Die Spezifikation gibt den
   * Bitstrom als "10101 | 0 | 0 | 00110 | 00 | 100110 | 110 | 11111111111110 |
   * 111000" an und daraus die Bytes 0xA8 0x62 0x6D 0xFF 0xF7 0x00.
   */
  test('erstes Beispiel: 14 Werte, Lauflaenge, GR-Modus und Rueckkehr', () => {
    const werte = rlgrDekodieren(Buffer.from([0xa8, 0x62, 0x6d, 0xff, 0xf7, 0x00]), 14, RLGR1);
    assert.deepEqual(Array.from(werte), [-2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 3, 1, -7, 6]);
  });

  /** MS-RDPEGFX 4.1.2.1.3 "Encode Frame #2 at 25%". */
  test('zweites Beispiel: dieselbe Zahl Werte, anderer Parameterverlauf', () => {
    const werte = rlgrDekodieren(Buffer.from([0x88, 0x76, 0xbd, 0xff, 0xfe, 0xf2]), 14, RLGR1);
    assert.deepEqual(Array.from(werte), [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, -4, 8, -9]);
  });

  test('null angeforderte Werte liefern einen leeren Block, ohne ein Bit zu lesen', () => {
    assert.equal(rlgrDekodieren(Buffer.alloc(0), 0, RLGR1).length, 0);
  });

  /**
   * Ein Strom aus lauter Einsen laesst das Golomb-Rice-Praefix "chew up/count
   * leading 1s" unbegrenzt wachsen. Der Decoder muss abbrechen statt zu
   * rechnen, bis der Puffer zu Ende ist - bei 9000 Byte waeren das 72000
   * Durchlaeufe allein fuer ein einziges Praefix.
   */
  test('endloses Golomb-Rice-Praefix bricht ab statt zu haengen', () => {
    assert.throws(
      () => rlgrDekodieren(Buffer.alloc(9000, 0xff), 4096, RLGR1),
      istProtokollfehler(/fuehrenden Einsen/),
    );
  });
});

describe('Progressive - RLGR3 aus dem durchgerechneten Beispiel', () => {
  /**
   * MS-RDPRFX 4.2.4: die YData der einzigen Kachel des TS_RFX_TILESET, 942 Byte
   * ab Offset 0x2E des Nachrichten-Dumps. Das Beispiel benutzt ausdruecklich
   * RLGR3 ("TS_RFX_TILESET::properties::et = CLW_ENTROPY_RLGR3"), damit deckt
   * dieser Fall den zweiten Zweig des GR-Modus ab: dort steht die Summe zweier
   * Werte im Strom und dahinter der erste Summand in genau so vielen Bit, wie
   * die Summe braucht.
   */
  const Y_DATEN =
    'c00101154899c741a1126811dc222974effd2092e04ea8693bfd4183bf28530c1fe2540c777ca3057c30d09ce8093' +
    '91a5dffe2012213809087d29ffdfd50090d24a08fabfe3c0484c69cdef880c32250af4c2a7ffee05ca9528a067d3d' +
    '090365a3afd2611f7204508d3e164a3ffffd414287243706172e56059c1cb3846afffb438ba37a324328e11f5054f' +
    'ccaa5dfff0804481561d97643f82a07e965f7c6892d40a1c3358df5edf591ae2fcc01ce0348c08d63f4fd50202d0c' +
    '9bb08d13c08a09521b026e423bd0134e840126886a0484342aa500ba544858ea5402b41da7fa4782ec7a77fd00926' +
    '66204a69bfff680c06901c23e9014202ffc409659580cb11368202eb5f5dffff8fc5688602453b541465ff8f17ede' +
    '4a0897e055038fe5756103f2e19001a28e88049805936bffeac060a1880449bff7ff8cb4599080306453fff5c448d' +
    'adacb80386157b2af00e87b46e6d802038a0618143283d08aeebc81b428c47ff9a1690091c551fffe3fe9f1703024' +
    '10a7cb1f8a2493ed83003620d150e7d8ad5820092280d0ca5d1ad7f160752af2d7f8c0324586004301fe80f742817' +
    '4844ca1604ccb1458014d18a1aa470e111a407d4102e330cd338134064683a2471c04aa2012a28b81c49ca02e0632' +
    'f8868501e870f946096abfe0f5a4c878e7d2970bbc3c97ffd54094b2c11818111f43c118c3837f9a31c48e7056daf' +
    '617ded1020d422113dc3a3c409ef40143ea0c4673a27b0c80ffe4ad2e09b463b08c5459faac76361005f098888342' +
    '002071ccc1a9973e5a0d04509223200d0a1c57d7ff10f2030f581ba511f8f1b412db1a48561fe3c750e916b4bcb04' +
    '093eab55b2ffc500a6fcc25e006ab5f24fe8bcb42437e690225c738006ee580a8a43044158fe90cd3a6c214344afe' +
    '037f06a5910254f1a1a153bf11f28f8367800908123ffd4491c28330500702824d31340641796ff0cc0379002c052' +
    '4ec8d2915af44c8eb4fe1fdf141488108affe5148cee7f9b60a308311f00c3bd2a62424ef25fa5a3e923e790e3561' +
    'c8aa1c2e9a277ffff07d305bbc91fffe43242866a77099286e2b182bd4a1773b969ff7ebbe1f0434758431424c65a' +
    'a0950a0c45131d3263a1bf46e4a4e172584787d2c3f4618ca5ff9e5382fd8719494e2cca315b0daa9cb58e4187793' +
    '8a51c623c44e6dd9141e9b8dbccb9dc41805f5a929f86d2938c744e53acdba61984a5702964202d93711de2dd43ff' +
    'e61e733d7894addb03447f4dcadaac99d7e6d4bccdc178957fdbb3775475aec2c6e3c159254642cab9eab2bdd3c66' +
    'a08f475e931a3716f4892300';

  const koeffizienten = rlgrDekodieren(Buffer.from(Y_DATEN, 'hex'), 4096, RLGR3);

  test('liefert genau 4096 Koeffizienten', () => {
    assert.equal(koeffizienten.length, 4096);
  });

  /** MS-RDPRFX 4.2.4.2.1, Anfang des HL1-Bandes. */
  test('Anfang des HL1-Bandes stimmt mit dem Dump ueberein', () => {
    assert.deepEqual(
      Array.from(koeffizienten.slice(0, 24)),
      [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
  });

  /**
   * Die letzten 64 Werte sind das LL3-Band und stehen dort noch als Deltas
   * (MS-RDPRFX 3.1.8.1.6). Dieser Ausschnitt trifft den RL- wie den GR-Modus
   * und ist der aussagekraeftigste Teil des Dumps.
   */
  test('LL3-Deltas am Ende des Blocks stimmen mit dem Dump ueberein', () => {
    assert.deepEqual(
      Array.from(koeffizienten.slice(4032)),
      [
        -1, 1, -1, -14, 3, 0, -7, -4, 50, -13, -11, 34, -26, -23, -3, -1,
        45, -4, 21, 57, -17, -43, -17, -15, 27, -7, 25, 30, -23, 65, -13, -88,
        45, -103, 85, 71, -116, 88, -30, -57, 57, -101, 94, 25, 17, 5, 6, -107,
        15, -31, 20, -26, 142, -18, -23, -95, 69, -7, -13, -9, 5, 18, -38, -18,
      ],
    );
  });

  test('Betragssumme und Zahl der Nichtnullwerte des ganzen Blocks stimmen', () => {
    let summe = 0;
    let nichtNull = 0;
    for (const v of koeffizienten) {
      summe += Math.abs(v);
      if (v !== 0) nichtNull++;
    }
    assert.equal(summe, 6097);
    assert.equal(nichtNull, 1131);
  });
});

describe('Progressive - SRL und Rohbits aus dem durchgerechneten Beispiel', () => {
  /**
   * MS-RDPEGFX 4.1.2.1.2 beschreibt den SRL-Strom als
   * "1010000000000001 | 1000000000000000 | 11001 | 0010 | 100 | 1001 | 111"
   * und daraus die Bytes 0xA0 0x01 0x80 0x00 0xC9 0x49 0xE0.
   *
   * Die acht SRL-Werte verteilen sich auf zwei Baender: die ersten vier
   * gehoeren zum HL-Band mit vier Bit Betrag, die letzten vier zum LH-Band mit
   * zwei Bit. Der Nulllauf ueber die Bandgrenze hinweg ("Even if those values
   * are across two different bands, it is still considered to be a single run
   * of zeros") ist genau das Paar Nullen in der Mitte.
   */
  test('acht Werte ueber zwei Baender mit unterschiedlicher Bitzahl', () => {
    const leser = new SrlLeser(Buffer.from([0xa0, 0x01, 0x80, 0x00, 0xc9, 0x49, 0xe0]));
    const bitzahl = [4, 4, 4, 4, 2, 2, 2, 2];
    const werte = bitzahl.map((n) => leser.naechster(n));
    assert.deepEqual(werte, [-13, 15, -3, 0, 0, -3, 2, -1]);
  });

  /**
   * Derselbe Aufwertungslauf schreibt zwei Werte als Rohbits: das erste
   * HL-Element mit vier Bit und das letzte LH-Element mit zwei. Die
   * Spezifikation gibt "0010 | 00" an, also das Byte 0x20.
   *
   * Rohbits tragen nur den Betrag; das Vorzeichen kommt aus dem gespeicherten
   * Sign-Zustand (3.3.8.2.1.2).
   */
  test('Rohbits laufen ohne Fuellung hintereinander weg', () => {
    const leser = new BitLeser(Buffer.from([0x20]));
    assert.equal(leser.lies(4), 2);
    assert.equal(leser.lies(2), 0);
  });

  /**
   * MS-RDPEGFX 4.1.2.1.5: bei nBits = 3 wird der groesste Betrag 7 als
   * "000000" geschrieben, also ohne die abschliessende "1". Die uebrigen
   * Betraege enden mit einer "1". Hier durchgerechnet fuer Vorzeichen "0"
   * (positiv): 1 -> "01", 2 -> "001", 7 -> "0000000".
   */
  test('unaere Kodierung: groesster Betrag kommt ohne Abschlussbit aus', () => {
    // "1" Nulllauf-Abschluss, "0" Laengenbit (K = 1), dann Vorzeichen + Betrag.
    // 1 0 | 0 1     -> +1
    // 1   | 0 01    -> +2      (K ist nach dem ersten Wert 0)
    // 1   | 0 000000 -> +7
    const bits = '10' + '01' + '1' + '001' + '1' + '0000000';
    const gefuellt = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
    const bytes = [];
    for (let i = 0; i < gefuellt.length; i += 8) bytes.push(parseInt(gefuellt.slice(i, i + 8), 2));
    const leser = new SrlLeser(Buffer.from(bytes));
    assert.deepEqual([leser.naechster(3), leser.naechster(3), leser.naechster(3)], [1, 2, 7]);
  });
});

describe('Progressive - inverse DWT aus dem durchgerechneten Beispiel', () => {
  /**
   * MS-RDPRFX 4.2.4.3.1.5 "Inverse DWT-X (LL3 - HL3)": die nullte Zeile des
   * LL3- und des HL3-Bandes ergeben die nullte Zeile des L2-Bandes. Alle Werte
   * sind 11.5-Festkommazahlen, wie es der Dump der Spezifikation ausweist.
   */
  test('waagerechter Durchgang auf Stufe 3 trifft den Dump auf den Wert genau', () => {
    const ll3 = [-32, 0, -32, -480, -384, -384, -608, -736];
    const hl3 = [0, 0, -64, -64, 32, 0, -32, -64];
    assert.deepEqual(
      Array.from(inverseDwt1d(ll3, hl3)),
      [-32, -16, 0, 0, 0, -336, -416, -520, -368, -320, -400, -496, -592, -704, -688, -816],
    );
  });

  /**
   * MS-RDPRFX 4.2.4.3.1.7 "Inverse DWT-Y (L2 - H2)", hier die Spalte 5. Der
   * senkrechte Durchgang benutzt dieselbe Rechnung, nur ueber Spalten - und
   * seine Eingaben sind bereits Ergebnisse des waagerechten Durchgangs und
   * damit auch ungerade, was die Rundung ueberhaupt erst pruefbar macht.
   */
  test('senkrechter Durchgang auf Stufe 3 trifft den Dump auf den Wert genau', () => {
    const l2 = [-336, 984, 2696, 1856, 3040, 3008, -608, 1312];
    const h2 = [-264, 168, 504, -624, 336, 56, 648, -16];
    assert.deepEqual(
      Array.from(inverseDwt1d(l2, h2)),
      [-72, -48, 1032, 2032, 2360, 3146, 1916, 1302, 3184, 3670, 2812, 1038, -960, 1314, 996, 964],
    );
  });

  /**
   * Reduce-Extrapolate haengt auf Stufe 1 einen Nullwert an den Hochpassstrang
   * und wirft dafuer den letzten berechneten Wert weg (3.3.8.2.2). Aus 33
   * Tiefpass- und 31 Hochpasswerten werden so 64 statt 65 Ergebnisse.
   */
  test('Reduce-Extrapolate: 33 plus 31 Werte ergeben 64 Ergebnisse', () => {
    const tief = new Array(33).fill(32);
    const hoch = new Array(31).fill(0);
    const aus = inverseDwt1d(tief, hoch, 32);
    assert.equal(aus.length, 65);
    // Ein konstanter Tiefpass ohne Hochpassanteil bleibt konstant.
    assert.ok(Array.from(aus).every((v) => v === 32));
  });

  /**
   * Die vollstaendige Kette des Beispiels aus MS-RDPRFX 4.2.4 fuer die
   * Y-Komponente: RLGR3, Differenzaufloesung im LL3-Band, Dequantisierung mit
   * quantVals 66 66 77 88 98 und dreistufige inverse DWT.
   *
   * Die Spezifikation laesst offen, in welche Richtung die ungerade Gleichung
   * X[2n+1] = 2*H[n] + floor((X[2n] + X[2n+2]) / 2) rundet, wenn die Summe
   * ungerade ist. Die hier umgesetzte Lesart ist die woertliche aus Figure 14;
   * gegen den Dump der Spezifikation weicht sie an 581 der 4096 Stellen um
   * hoechstens 2 ab. In der 11.5-Festkommadarstellung sind 2 genau 1/16 eines
   * Helligkeitsschritts, das Ergebnisbyte aendert sich dadurch nicht.
   */
  test('ganze Kette bis zur rekonstruierten Y-Komponente', () => {
    const yDaten = Buffer.from(
      'c00101154899c741a1126811dc222974effd2092e04ea8693bfd4183bf28530c1fe2540c777ca3057c30d09ce8093' +
        '91a5dffe2012213809087d29ffdfd50090d24a08fabfe3c0484c69cdef880c32250af4c2a7ffee05ca9528a067d3d' +
        '090365a3afd2611f7204508d3e164a3ffffd414287243706172e56059c1cb3846afffb438ba37a324328e11f5054f' +
        'ccaa5dfff0804481561d97643f82a07e965f7c6892d40a1c3358df5edf591ae2fcc01ce0348c08d63f4fd50202d0c' +
        '9bb08d13c08a09521b026e423bd0134e840126886a0484342aa500ba544858ea5402b41da7fa4782ec7a77fd00926' +
        '66204a69bfff680c06901c23e9014202ffc409659580cb11368202eb5f5dffff8fc5688602453b541465ff8f17ede' +
        '4a0897e055038fe5756103f2e19001a28e88049805936bffeac060a1880449bff7ff8cb4599080306453fff5c448d' +
        'adacb80386157b2af00e87b46e6d802038a0618143283d08aeebc81b428c47ff9a1690091c551fffe3fe9f1703024' +
        '10a7cb1f8a2493ed83003620d150e7d8ad5820092280d0ca5d1ad7f160752af2d7f8c0324586004301fe80f742817' +
        '4844ca1604ccb1458014d18a1aa470e111a407d4102e330cd338134064683a2471c04aa2012a28b81c49ca02e0632' +
        'f8868501e870f946096abfe0f5a4c878e7d2970bbc3c97ffd54094b2c11818111f43c118c3837f9a31c48e7056daf' +
        '617ded1020d422113dc3a3c409ef40143ea0c4673a27b0c80ffe4ad2e09b463b08c5459faac76361005f098888342' +
        '002071ccc1a9973e5a0d04509223200d0a1c57d7ff10f2030f581ba511f8f1b412db1a48561fe3c750e916b4bcb04' +
        '093eab55b2ffc500a6fcc25e006ab5f24fe8bcb42437e690225c738006ee580a8a43044158fe90cd3a6c214344afe' +
        '037f06a5910254f1a1a153bf11f28f8367800908123ffd4491c28330500702824d31340641796ff0cc0379002c052' +
        '4ec8d2915af44c8eb4fe1fdf141488108affe5148cee7f9b60a308311f00c3bd2a62424ef25fa5a3e923e790e3561' +
        'c8aa1c2e9a277ffff07d305bbc91fffe43242866a77099286e2b182bd4a1773b969ff7ebbe1f0434758431424c65a' +
        'a0950a0c45131d3263a1bf46e4a4e172584787d2c3f4618ca5ff9e5382fd8719494e2cca315b0daa9cb58e4187793' +
        '8a51c623c44e6dd9141e9b8dbccb9dc41805f5a929f86d2938c744e53acdba61984a5702964202d93711de2dd43ff' +
        'e61e733d7894addb03447f4dcadaac99d7e6d4bccdc178957fdbb3775475aec2c6e3c159254642cab9eab2bdd3c66' +
        'a08f475e931a3716f4892300',
      'hex',
    );
    const koeff = rlgrDekodieren(yDaten, 4096, RLGR3);
    // LL3 des klassischen Aufbaus beginnt bei 4032; die Deltas aufsummieren.
    let lauf = 0;
    for (let i = 4032; i < 4096; i++) {
      lauf += koeff[i];
      koeff[i] = lauf;
    }
    // quantVals 66 66 77 88 98, umsortiert in die Reihenfolge von
    // RFX_COMPONENT_CODEC_QUANT: LL3, HL3, LH3, HH3, HL2, LH2, HH2, HL1, LH1, HH1.
    const quant = [6, 6, 6, 6, 7, 7, 8, 8, 8, 9];
    const bild = inverseDwt(dequantisiere(koeff, quant, false), false);

    assert.equal(bild.length, 4096);
    assert.deepEqual(
      Array.from(bild.slice(0, 16)),
      [-32, 16, 64, 272, -32, -16, 0, -16, -32, -24, -16, -8, 0, -24, -48, -72],
    );
    assert.deepEqual(
      Array.from(bild.slice(32 * 64, 32 * 64 + 16)),
      [1504, 1462, 1420, 1410, 1400, 1246, 1604, -1334, -1712, -1089, -978, -643, -308, 59, 938, 1529],
    );
    const letzte = [176, 158, 142, 124, 108, 82, 58, 32, 8, -24, -56, -88, -120, -120, -120, -120];
    letzte.forEach((erwartet, i) => {
      assert.ok(
        Math.abs(bild[63 * 64 + 48 + i] - erwartet) <= 2,
        `Zeile 63, Spalte ${48 + i}: ${bild[63 * 64 + 48 + i]} weicht von ${erwartet} um mehr als 2 ab`,
      );
    });
  });

  test('inverse DWT weist einen Block falscher Groesse zurueck', () => {
    assert.throws(() => inverseDwt(new Int32Array(4000), true), istProtokollfehler(/4096 Koeffizienten/));
    assert.throws(() => dequantisiere(new Int32Array(10), [6], true), istProtokollfehler(/4096 Koeffizienten/));
  });
});

describe('Progressive - Farbumrechnung', () => {
  /**
   * MS-RDPRFX 4.2.4.4: die ersten Pixel des dekodierten XRGB-Bildes lauten
   * 0x00229cdf, 0x00249de0, 0x00259fe2, ... Die zugehoerigen Y-, Cb- und
   * Cr-Werte stehen in 4.2.4.3.3.7, 4.2.4.3.5 und 4.2.4.3.6.
   *
   * Der Fall beantwortet zugleich die Frage nach der Kanalreihenfolge: mit
   * vertauschtem Rot und Blau kaeme 0x00df9c22 heraus.
   */
  test('erste Pixel des Beispiels stimmen mit dem XRGB-Dump ueberein', () => {
    const y = new Int32Array(4096);
    const cb = new Int32Array(4096);
    const cr = new Int32Array(4096);
    const yWerte = [-32, 16, 64, 272, -32, -16];
    const cbWerte = [1728, 1730, 1732, 1734, 1736, 1738];
    const crWerte = [-2112, -2114, -2116, -2118, -2120, -2122];
    yWerte.forEach((v, i) => (y[i] = v));
    cbWerte.forEach((v, i) => (cb[i] = v));
    crWerte.forEach((v, i) => (cr[i] = v));

    const rgba = ycbcrNachRgba(y, cb, cr);
    assert.deepEqual(Array.from(rgba.slice(0, 12)), [0x22, 0x9c, 0xdf, 255, 0x24, 0x9d, 0xe0, 255, 0x25, 0x9f, 0xe2, 255]);
  });

  test('Y, Cb und Cr auf null ergeben mittleres Grau', () => {
    const rgba = ycbcrNachRgba(new Int32Array(4096), new Int32Array(4096), new Int32Array(4096));
    assert.deepEqual(Array.from(rgba.slice(0, 4)), [128, 128, 128, 255]);
  });

  test('Werte ausserhalb des Bereichs werden begrenzt statt umzulaufen', () => {
    const y = new Int32Array(4096).fill(100000);
    const rgba = ycbcrNachRgba(y, new Int32Array(4096), new Int32Array(4096));
    assert.deepEqual(Array.from(rgba.slice(0, 4)), [255, 255, 255, 255]);
    const dunkel = new Int32Array(4096).fill(-100000);
    const rgba2 = ycbcrNachRgba(dunkel, new Int32Array(4096), new Int32Array(4096));
    assert.deepEqual(Array.from(rgba2.slice(0, 4)), [0, 0, 0, 255]);
  });
});

describe('Progressive - Erstdurchgang, Aufwertung und Differenzkacheln', () => {
  /**
   * Der Ablauf dieser vier Nachrichten bildet genau die Zustandsfuehrung ab,
   * um derer willen der Decoder eine Klasse ist. Sie laufen bewusst durch
   * *eine* Instanz und bauen aufeinander auf.
   */
  function ablauf(): { decoder: ProgressiveDecoder; nachrichten: Buffer[] } {
    return {
      decoder: new ProgressiveDecoder(),
      nachrichten: [
        // A: Erstdurchgang, alle Koeffizienten null.
        Buffer.from([
          ...SYNC,
          ...CONTEXT,
          ...FRAME_BEGIN,
          ...region([PROGQUANT_A], tileFirst(0x00, 0, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN)),
          ...FRAME_END,
        ]),
        // B: Aufwertung auf volle Qualitaet. LL3 bekommt zwei Rohbits je
        // Element, HH1 ein Bit ueber den SRL-Strom, alle anderen Baender null
        // Bit und werden uebersprungen. Cb und Cr standen schon auf voller
        // Qualitaet und liefern deshalb gar keine Daten.
        Buffer.from([
          ...FRAME_BEGIN,
          ...region([PROGQUANT_B], tileUpgrade(0, [SRL_HH1, [], []], [ROHBITS_LL3, [], []])),
          ...FRAME_END,
        ]),
        // C: Differenzkachel mit lauter Nullen - der Stand muss erhalten bleiben.
        Buffer.from([
          ...FRAME_BEGIN,
          ...region([], tileFirst(0x01, 0xff, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN)),
          ...FRAME_END,
        ]),
        // D: dieselbe Kachel als Originalkachel - der Stand muss verschwinden.
        Buffer.from([
          ...FRAME_BEGIN,
          ...region([], tileFirst(0x00, 0xff, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN)),
          ...FRAME_END,
        ]),
      ],
    };
  }

  test('Erstdurchgang mit lauter Nullen ergibt eine gleichfoermig graue Kachel', () => {
    const { decoder, nachrichten } = ablauf();
    const kacheln = decoder.decode(nachrichten[0], 7);
    assert.equal(kacheln.length, 1);
    assert.deepEqual(
      { x: kacheln[0].x, y: kacheln[0].y, width: kacheln[0].width, height: kacheln[0].height },
      { x: 0, y: 0, width: 64, height: 64 },
    );
    assert.equal(kacheln[0].rgba.length, 64 * 64 * 4);
    assert.deepEqual([...farben(kacheln[0])], [['128,128,128,255', 4096]]);
  });

  test('Aufwertung hebt das LL3-Band ueber Rohbits und setzt ueber SRL einen HH1-Wert', () => {
    const { decoder, nachrichten } = ablauf();
    decoder.decode(nachrichten[0], 7);
    const kacheln = decoder.decode(nachrichten[1], 7);
    assert.equal(kacheln.length, 1);

    // 81 LL3-Elemente bekommen je den Zweibitwert 1; nach Dequantisierung und
    // inverser DWT ist die ganze Kachel um einen Helligkeitsschritt heller.
    const zaehl = farben(kacheln[0]);
    assert.equal(zaehl.get('129,129,129,255'), 4090);

    // Der einzige SRL-Wert (-1 im ersten HH1-Element) schlaegt sich als kleiner
    // Kringel in der linken oberen Ecke nieder - genau sechs Pixel weit, weil
    // ein HH1-Koeffizient nur die feinste Aufloesungsstufe beruehrt.
    const abweichend: number[][] = [];
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const p = pixel(kacheln[0], x, y);
        if (p[0] !== 129) abweichend.push([x, y, p[0]]);
      }
    }
    assert.deepEqual(abweichend, [
      [0, 0, 128],
      [1, 0, 130],
      [0, 1, 130],
      [1, 1, 127],
      [2, 1, 130],
      [1, 2, 130],
    ]);
  });

  test('Differenzkachel mit Nullinhalt laesst den Stand unveraendert', () => {
    const { decoder, nachrichten } = ablauf();
    decoder.decode(nachrichten[0], 7);
    const vorher = decoder.decode(nachrichten[1], 7)[0];
    const nachher = decoder.decode(nachrichten[2], 7)[0];
    assert.deepEqual(Array.from(nachher.rgba), Array.from(vorher.rgba));
  });

  test('Originalkachel mit Nullinhalt loescht den Stand', () => {
    const { decoder, nachrichten } = ablauf();
    decoder.decode(nachrichten[0], 7);
    decoder.decode(nachrichten[1], 7);
    decoder.decode(nachrichten[2], 7);
    const kacheln = decoder.decode(nachrichten[3], 7);
    assert.deepEqual([...farben(kacheln[0])], [['128,128,128,255', 4096]]);
  });

  test('der Zustand haengt an der surfaceId', () => {
    const { decoder, nachrichten } = ablauf();
    decoder.decode(nachrichten[0], 7);
    decoder.decode(nachrichten[1], 7);
    // Dieselbe Aufwertung auf einer anderen Flaeche trifft eine unberuehrte
    // Kachel: dort steht das LL3-Band noch auf Bitposition null, alle Baender
    // haben null neue Bits und nichts aendert sich.
    const fremd = decoder.decode(nachrichten[1], 8);
    assert.deepEqual([...farben(fremd[0])], [['128,128,128,255', 4096]]);
  });

  test('reset wirft den Zustand einer Flaeche weg, ohne die anderen zu beruehren', () => {
    const { decoder, nachrichten } = ablauf();
    decoder.decode(nachrichten[0], 7);
    decoder.decode(nachrichten[0], 9);
    decoder.decode(nachrichten[1], 7);
    decoder.decode(nachrichten[1], 9);
    decoder.reset(7);

    // Flaeche 7 ist leer: die Differenzkachel findet nichts vor und bleibt grau.
    assert.deepEqual([...farben(decoder.decode(nachrichten[2], 7)[0])], [['128,128,128,255', 4096]]);
    // Flaeche 9 hat ihren Stand behalten.
    assert.equal(farben(decoder.decode(nachrichten[2], 9)[0]).get('129,129,129,255'), 4090);

    decoder.reset();
    assert.deepEqual([...farben(decoder.decode(nachrichten[2], 9)[0])], [['128,128,128,255', 4096]]);
  });

  test('eine Aufwertung darf die Qualitaet nicht verringern', () => {
    const { decoder, nachrichten } = ablauf();
    decoder.decode(nachrichten[0], 7);
    // Zieltabelle mit LL3 = 3, waehrend der Erstdurchgang auf 2 stand.
    const groeber = [0x32, 0x03, 0x00, 0x00, 0x00, 0x00, ...QUANT_NULL, ...QUANT_NULL];
    const nachricht = Buffer.from([
      ...FRAME_BEGIN,
      ...region([groeber], tileUpgrade(0, [[], [], []], [[], [], []])),
      ...FRAME_END,
    ]);
    assert.throws(() => decoder.decode(nachricht, 7), istProtokollfehler(/kann die Qualitaet nicht verringern/));
  });
});

describe('Progressive - abgeschnittene und widerspruechliche Stroeme', () => {
  const decoder = (): ProgressiveDecoder => new ProgressiveDecoder();
  const einfacheKachel = tileFirst(0, 0xff, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN);

  test('ein angefangener Blockkopf', () => {
    assert.throws(
      () => decoder().decode(Buffer.from([0xc0, 0xcc, 0x0c]), 0),
      istProtokollfehler(/abgeschnittener Strom/),
    );
  });

  test('blockLen kleiner als der Blockkopf', () => {
    assert.throws(
      () => decoder().decode(Buffer.from([0xc2, 0xcc, 0x05, 0x00, 0x00, 0x00]), 0),
      istProtokollfehler(/kleiner als der Blockkopf/),
    );
  });

  test('blockLen ueber das Pufferende hinaus', () => {
    assert.throws(
      () => decoder().decode(Buffer.from([0xc0, 0xcc, 0x40, 0x00, 0x00, 0x00, 0x00]), 0),
      istProtokollfehler(/gibt 64 Byte an/),
    );
  });

  test('RFX_PROGRESSIVE_FRAME_END mit falscher Laenge', () => {
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc2, [0x00])), 0),
      istProtokollfehler(/FRAME_END hat blockLen 7/),
    );
  });

  test('RFX_PROGRESSIVE_CONTEXT mit anderer Kachelgroesse als 64', () => {
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc3, [0x00, ...u16(128), 0x01])), 0),
      istProtokollfehler(/tileSize ist 128/),
    );
  });

  test('RFX_PROGRESSIVE_REGION mit anderer Kachelgroesse als 0x40', () => {
    const rumpf = [0x20, ...u16(1), 1, 0, 0x01, ...u16(0), ...u32(0), ...rect(0, 0, 64, 64), ...QUANT_SECHS];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/REGION::tileSize ist 32/),
    );
  });

  test('RFX_PROGRESSIVE_REGION ohne Rechtecke', () => {
    const rumpf = [0x40, ...u16(0), 1, 0, 0x01, ...u16(0), ...u32(0), ...QUANT_SECHS];
    assert.throws(() => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0), istProtokollfehler(/numRects ist 0/));
  });

  test('RFX_PROGRESSIVE_REGION, deren Laengenangaben sich nicht aufaddieren', () => {
    // tileDataSize behauptet 100 Byte, geliefert wird die Kachel von 32 Byte.
    const rumpf = [
      0x40, ...u16(1), 1, 0, 0x01, ...u16(1), ...u32(100),
      ...rect(0, 0, 64, 64), ...QUANT_SECHS, ...einfacheKachel,
    ];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/zusammen \d+ Byte, der Block hat aber/),
    );
  });

  test('numTiles passt nicht zur Zahl der Bloecke im tiles-Feld', () => {
    const rumpf = [
      0x40, ...u16(1), 1, 0, 0x01, ...u16(3), ...u32(einfacheKachel.length),
      ...rect(0, 0, 64, 64), ...QUANT_SECHS, ...einfacheKachel,
    ];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/numTiles ist 3, im tiles-Feld stehen aber 1/),
    );
  });

  test('quantIdxY verweist auf einen Satz, den die Region nicht liefert', () => {
    const kachel = block(0xccc6, [
      2, 0, 0, ...u16(0), ...u16(0), 0x00, 0xff,
      ...u16(3), ...u16(3), ...u16(3), ...u16(0),
      ...RLGR1_NUR_NULLEN, ...RLGR1_NUR_NULLEN, ...RLGR1_NUR_NULLEN,
    ]);
    const rumpf = [
      0x40, ...u16(1), 1, 0, 0x01, ...u16(1), ...u32(kachel.length),
      ...rect(0, 0, 64, 64), ...QUANT_SECHS, ...kachel,
    ];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/quantIdx 2 .* nur 1/s),
    );
  });

  test('progressiveQuality verweist auf einen Satz, den die Region nicht liefert', () => {
    const kachel = tileFirst(0, 1, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN, RLGR1_NUR_NULLEN);
    const nachricht = Buffer.from(region([PROGQUANT_A], kachel));
    assert.throws(
      () => decoder().decode(nachricht, 0),
      istProtokollfehler(/progressiveQuality 1 verweist/),
    );
  });

  test('ein fremder Blocktyp im tiles-Feld', () => {
    const fremd = block(0xcccf, [0x00, 0x00]);
    const rumpf = [
      0x40, ...u16(1), 1, 0, 0x01, ...u16(1), ...u32(fremd.length),
      ...rect(0, 0, 64, 64), ...QUANT_SECHS, ...fremd,
    ];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/im tiles-Feld/),
    );
  });

  test('ein Kachelblock ausserhalb einer Region', () => {
    assert.throws(
      () => decoder().decode(Buffer.from(einfacheKachel), 0),
      istProtokollfehler(/ausserhalb einer RFX_PROGRESSIVE_REGION/),
    );
  });

  test('eine Kachel, deren Teilstroeme nicht in den Block passen', () => {
    // yLen behauptet 1000 Byte, der Block traegt drei.
    const kachel = block(0xccc6, [
      0, 0, 0, ...u16(0), ...u16(0), 0x00, 0xff,
      ...u16(1000), ...u16(0), ...u16(0), ...u16(0),
      ...RLGR1_NUR_NULLEN,
    ]);
    const rumpf = [
      0x40, ...u16(1), 1, 0, 0x01, ...u16(1), ...u32(kachel.length),
      ...rect(0, 0, 64, 64), ...QUANT_SECHS, ...kachel,
    ];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/yData braucht 1000 Byte/),
    );
  });

  test('hinter den Kacheldaten stehen ungedeckte Bytes', () => {
    const kachel = block(0xccc6, [
      0, 0, 0, ...u16(0), ...u16(0), 0x00, 0xff,
      ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      0x11, 0x22,
    ]);
    const rumpf = [
      0x40, ...u16(1), 1, 0, 0x01, ...u16(1), ...u32(kachel.length),
      ...rect(0, 0, 64, 64), ...QUANT_SECHS, ...kachel,
    ];
    assert.throws(
      () => decoder().decode(Buffer.from(block(0xccc4, rumpf)), 0),
      istProtokollfehler(/stehen noch 2 Byte/),
    );
  });

  /**
   * 2.2.4.2.1 verlangt ausdruecklich, unbekannte Blocktypen auf oberster Ebene
   * zu ueberspringen. Das ist kein Fehler, sondern der vorgesehene Weg fuer
   * spaetere Erweiterungen - uebersprungen wird anhand von blockLen, und die
   * wurde vorher gegen den Puffer geprueft.
   */
  test('ein unbekannter Blocktyp auf oberster Ebene wird uebersprungen', () => {
    const nachricht = Buffer.from([
      ...block(0xcc99, [1, 2, 3, 4]),
      ...CONTEXT,
      ...FRAME_BEGIN,
      ...region([], einfacheKachel),
      ...FRAME_END,
    ]);
    const kacheln = decoder().decode(nachricht, 0);
    assert.equal(kacheln.length, 1);
  });

  test('ein leerer Puffer liefert keine Kacheln', () => {
    assert.deepEqual(decoder().decode(Buffer.alloc(0), 0), []);
  });
});

describe('Progressive - echte Aufzeichnung', () => {
  const pfad = join(__dirname, '..', '..', 'test', 'fixtures', 'progressive-echt.json');
  const roh = JSON.parse(readFileSync(pfad, 'utf8')) as {
    quelle?: string;
    nachrichten: { codecId: number; hex: string }[];
  };
  const nachrichten = roh.nachrichten.map((n) => Buffer.from(n.hex, 'hex'));

  test('die Aufzeichnung enthaelt 120 Nachrichten mit codecId 0x09', () => {
    assert.equal(nachrichten.length, 120);
    assert.ok(roh.nachrichten.every((n) => n.codecId === 0x09));
  });

  /**
   * Der Kern dieser Datei: alle 120 Nachrichten in ihrer aufgezeichneten
   * Reihenfolge durch *eine* Instanz. Der Kodierkontext wird ueber Nachrichten
   * hinweg fortgeschrieben - nur zwei der 120 tragen ueberhaupt einen
   * RFX_PROGRESSIVE_CONTEXT-Block, und die meisten Kacheln sind
   * Differenzkacheln oder Aufwertungslaeufe fruehrerer Nachrichten.
   */
  test('alle 120 Nachrichten laufen ohne Ausnahme durch eine Instanz', () => {
    const decoder = new ProgressiveDecoder();
    let kacheln = 0;
    let pixelzahl = 0;

    nachrichten.forEach((nachricht, i) => {
      let ergebnis: ProgressiveTile[];
      try {
        ergebnis = decoder.decode(nachricht, 0);
      } catch (e) {
        assert.fail(`Nachricht ${i} (${nachricht.length} Byte) scheiterte: ${(e as Error).message}`);
      }
      for (const k of ergebnis) {
        assert.ok(k.width > 0 && k.width <= 64, `Nachricht ${i}: Kachelbreite ${k.width}`);
        assert.ok(k.height > 0 && k.height <= 64, `Nachricht ${i}: Kachelhoehe ${k.height}`);
        assert.equal(k.rgba.length, k.width * k.height * 4, `Nachricht ${i}: Puffergroesse passt nicht`);
        assert.ok(k.x >= 0 && k.y >= 0, `Nachricht ${i}: negative Lage`);
        // Der Codec kennt keinen Alphakanal; die Ausgabe ist durchgehend deckend.
        for (let o = 3; o < k.rgba.length; o += 4) {
          if (k.rgba[o] !== 255) assert.fail(`Nachricht ${i}: Alpha ${k.rgba[o]} statt 255`);
        }
        kacheln++;
        pixelzahl += k.width * k.height;
      }
    });

    assert.equal(kacheln, 3664);
    assert.equal(pixelzahl, 9606808);
  });

  /**
   * Die erste Nachricht zeigt den Zuschnitt an den Rechtecken der Region: ihr
   * einziges Rechteck ist 116 Pixel breit und beginnt bei x = 960, die zweite
   * Kachel reicht aber bis 1087. Von ihr duerfen nur 52 Spalten herauskommen -
   * "it is valid for tiles to carry compressed information for pixels outside
   * of the region" (2.2.4.2.1.5).
   */
  test('Kacheln werden an den Rechtecken der Region beschnitten', () => {
    const kacheln = new ProgressiveDecoder().decode(nachrichten[0], 0);
    assert.deepEqual(
      kacheln.map((k) => [k.x, k.y, k.width, k.height]),
      [
        [960, 448, 64, 64],
        [1024, 448, 52, 64],
      ],
    );
    assert.equal(kacheln[1].rgba.length, 52 * 64 * 4);
  });

  /**
   * Die Aufzeichnung zeigt einen Windows-Desktop. Der Startknopf in der
   * Taskleiste liegt bei (331..345, 504..518) und ist das bekannte
   * Windows-Blau; die gruene Solitaer-Kachel und das rote SAT.1-Logo daneben
   * sind die Gegenprobe.
   *
   * Das ist die Antwort auf die Frage nach der Kanalreihenfolge am echten
   * Material: waeren Rot und Blau vertauscht, stuende hier ueberall das
   * Spiegelbild - aus dem Startknopf wuerde Orange.
   */
  test('die Farben des Desktops liegen richtig herum', () => {
    const decoder = new ProgressiveDecoder();
    const breite = 1200;
    const hoehe = 620;
    const rahmen = new Uint8ClampedArray(breite * hoehe * 4);
    for (const nachricht of nachrichten) {
      for (const k of decoder.decode(nachricht, 0)) {
        for (let y = 0; y < k.height; y++) {
          const zy = k.y + y;
          if (zy >= hoehe) continue;
          for (let x = 0; x < k.width; x++) {
            const zx = k.x + x;
            if (zx >= breite) continue;
            const q = (y * k.width + x) * 4;
            const z = (zy * breite + zx) * 4;
            rahmen[z] = k.rgba[q];
            rahmen[z + 1] = k.rgba[q + 1];
            rahmen[z + 2] = k.rgba[q + 2];
            rahmen[z + 3] = 255;
          }
        }
      }
    }

    const mittel = (x0: number, y0: number, x1: number, y1: number): number[] => {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const z = (y * breite + x) * 4;
          r += rahmen[z];
          g += rahmen[z + 1];
          b += rahmen[z + 2];
          n++;
        }
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    };

    const start = mittel(331, 504, 346, 519);
    assert.ok(start[2] > start[0] + 100, `Startknopf ist nicht blau, sondern ${start}`);
    assert.ok(start[2] > start[1], `Startknopf ist nicht blau, sondern ${start}`);

    const solitaer = mittel(128, 328, 176, 376);
    assert.ok(
      solitaer[1] > solitaer[0] && solitaer[1] > solitaer[2],
      `Solitaer-Kachel ist nicht gruen, sondern ${solitaer}`,
    );

    const sat1 = mittel(313, 370, 325, 382);
    assert.ok(sat1[0] > sat1[1] + 40 && sat1[0] > sat1[2] + 40, `SAT.1-Logo ist nicht rot, sondern ${sat1}`);

    // Ein einzelnes Pixel aus dem Startknopf, als unveraenderlicher Anker.
    const z = (506 * breite + 334) * 4;
    assert.deepEqual([rahmen[z], rahmen[z + 1], rahmen[z + 2], rahmen[z + 3]], [56, 181, 246, 255]);
  });

  /**
   * Dieselben Nachrichten zweimal durch dieselbe Instanz, dazwischen ein
   * reset: der zweite Durchlauf muss Byte fuer Byte dasselbe liefern wie der
   * erste. Bliebe irgendein Rest im Zustand haengen - ein Kachelspeicher, eine
   * Bitposition -, waeren die Differenzkacheln des zweiten Durchlaufs falsch.
   */
  test('reset stellt den Anfangszustand vollstaendig wieder her', () => {
    const decoder = new ProgressiveDecoder();
    const ersterLauf = nachrichten.slice(0, 12).map((n) => decoder.decode(n, 0));
    decoder.reset(0);
    const zweiterLauf = nachrichten.slice(0, 12).map((n) => decoder.decode(n, 0));

    assert.equal(zweiterLauf.length, ersterLauf.length);
    for (let i = 0; i < ersterLauf.length; i++) {
      assert.equal(zweiterLauf[i].length, ersterLauf[i].length, `Nachricht ${i}: andere Kachelzahl`);
      for (let k = 0; k < ersterLauf[i].length; k++) {
        assert.deepEqual(
          { ...zweiterLauf[i][k], rgba: Array.from(zweiterLauf[i][k].rgba) },
          { ...ersterLauf[i][k], rgba: Array.from(ersterLauf[i][k].rgba) },
          `Nachricht ${i}, Kachel ${k} unterscheidet sich`,
        );
      }
    }
  });

  /**
   * Jede der 120 Nachrichten, an jeder Stelle abgeschnitten, muss entweder
   * sauber durchlaufen oder einen RdpProtocolError werfen - aber weder haengen
   * noch mit einem anderen Fehler abbrechen. Das ist die Probe darauf, dass
   * jede Schleife pro Durchlauf zwingend vorankommt.
   */
  test('jeder abgeschnittene Ausschnitt endet in einem Protokollfehler oder sauber', () => {
    for (let i = 0; i < nachrichten.length; i += 7) {
      const voll = nachrichten[i];
      for (const anteil of [0.1, 0.35, 0.6, 0.85, 0.99]) {
        const kurz = voll.subarray(0, Math.floor(voll.length * anteil));
        try {
          new ProgressiveDecoder().decode(kurz, 0);
        } catch (e) {
          assert.ok(
            e instanceof RdpProtocolError,
            `Nachricht ${i} auf ${anteil}: ${(e as Error).constructor.name} statt RdpProtocolError - ${(e as Error).message}`,
          );
        }
      }
    }
  });

  /**
   * Dasselbe mit verbogenen Bytes: ein einzelnes gekipptes Byte darf den
   * Decoder nicht aus der Bahn werfen. Entweder liefert er (moeglicherweise
   * unsinnige) Kacheln oder er erkennt den Widerspruch - ein anderer
   * Fehlertyp waere ein Loch in der Grenzpruefung.
   */
  test('verbogene Bytes fuehren zu Protokollfehlern, nicht zu Abstuerzen', () => {
    for (let i = 0; i < 20; i++) {
      const kopie = Buffer.from(nachrichten[i]);
      // Ein Byte im ersten Drittel kippen; dort liegen die Kopffelder.
      const pos = Math.floor((kopie.length / 3) * ((i % 3) / 3 + 0.1));
      kopie[pos] ^= 0xa5;
      try {
        new ProgressiveDecoder().decode(kopie, 0);
      } catch (e) {
        assert.ok(
          e instanceof RdpProtocolError,
          `Nachricht ${i}, Byte ${pos}: ${(e as Error).constructor.name} - ${(e as Error).message}`,
        );
      }
    }
  });
});
