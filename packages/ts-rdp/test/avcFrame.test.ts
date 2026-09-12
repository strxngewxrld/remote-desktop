import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import * as frame from '../src/codec/avcFrame.js';
import { AvcRegion } from '../src/codec/avcMeta.js';

// Wie in avcMeta.test.ts: die Eingaben stehen als Byte-Listen im Test, nicht
// als Aufruf eines Schreibhelfers. Ein H.264-Strom laesst sich von Hand
// hinschreiben, solange man nur die NAL-Koepfe braucht - und mehr liest diese
// Schicht nicht.

/** Ein NAL mit langem Startcode (0x00 0x00 0x00 0x01) und gegebenem Typ. */
function nal(typ: number, ...rumpf: number[]): number[] {
  // nal_unit ([ITU-H.264] 7.3.1): forbidden_zero_bit 0, nal_ref_idc 3, type.
  return [0x00, 0x00, 0x00, 0x01, 0x60 | (typ & 0x1f), ...rumpf];
}

/** Dasselbe mit dem kurzen Startcode (0x00 0x00 0x01). */
function nalKurz(typ: number, ...rumpf: number[]): number[] {
  return [0x00, 0x00, 0x01, 0x60 | (typ & 0x1f), ...rumpf];
}

/**
 * Ein SPS-Rumpf, der mit profile_idc, constraint-Flags und level_idc beginnt.
 * 0x42 = 66 (Baseline), 0x4d = 77 (Main), 0x64 = 100 (High).
 */
function sps(profile: number, constraints: number, level: number, ...rest: number[]): number[] {
  return nal(frame.NAL_SPS, profile, constraints, level, ...rest);
}

describe('Annex-B-Analyse (MS-RDPEGFX 2.2.4.4, [ITU-H.264] Annex B)', () => {
  test('Ein Schluesselbild wird an der IDR-Scheibe erkannt, nicht am SPS', () => {
    const strom = Buffer.from([
      ...sps(0x64, 0x00, 0x1f),
      ...nal(frame.NAL_PPS, 0xee, 0x3c, 0xb0),
      ...nal(frame.NAL_SLICE_IDR, 0x88, 0x84, 0x00),
    ]);
    const a = frame.analysiereBitstrom(strom);
    assert.deepEqual(a.nalTypen, [frame.NAL_SPS, frame.NAL_PPS, frame.NAL_SLICE_IDR]);
    assert.equal(a.schluesselbild, true);
    assert.equal(a.hatParametersaetze, true);
  });

  test('Parametersaetze allein sind kein Schluesselbild', () => {
    // Ein SPS/PPS-Paar ohne Scheibe ergibt kein Bild. Wer es WebCodecs als
    // 'key' unterschiebt, bekommt entweder nichts oder einen Decoderfehler.
    const a = frame.analysiereBitstrom(Buffer.from([...sps(0x4d, 0x40, 0x28), ...nal(frame.NAL_PPS, 0x01)]));
    assert.equal(a.schluesselbild, false);
    assert.equal(a.hatParametersaetze, true);
  });

  test('Ein Folgebild ist weder Schluesselbild noch traegt es Parametersaetze', () => {
    const a = frame.analysiereBitstrom(Buffer.from(nal(frame.NAL_SLICE_NICHT_IDR, 0x9a, 0x00, 0x21)));
    assert.deepEqual(a.nalTypen, [frame.NAL_SLICE_NICHT_IDR]);
    assert.equal(a.schluesselbild, false);
    assert.equal(a.hatParametersaetze, false);
    assert.equal(a.codecString, undefined);
  });

  test('Ein SPS ohne PPS reicht nicht', () => {
    const a = frame.analysiereBitstrom(Buffer.from([...sps(0x64, 0x00, 0x1f), ...nal(frame.NAL_SLICE_IDR, 0x88)]));
    assert.equal(a.hatParametersaetze, false, 'ohne PPS darf nicht konfiguriert werden');
    assert.equal(a.schluesselbild, true);
  });

  test('Der kurze Startcode wird genauso gefunden wie der lange', () => {
    const a = frame.analysiereBitstrom(
      Buffer.from([...nalKurz(frame.NAL_SPS, 0x42, 0xc0, 0x1e), ...nalKurz(frame.NAL_PPS, 0x01), ...nalKurz(frame.NAL_SLICE_IDR, 0x88)]),
    );
    assert.deepEqual(a.nalTypen, [frame.NAL_SPS, frame.NAL_PPS, frame.NAL_SLICE_IDR]);
    assert.equal(a.codecString, 'avc1.42c01e');
  });

  test('Ein leerer oder startcodefreier Puffer liefert nichts, statt zu werfen', () => {
    for (const daten of [Buffer.alloc(0), Buffer.from([0x11, 0x22, 0x33, 0x44])]) {
      const a = frame.analysiereBitstrom(daten);
      assert.deepEqual(a.nalTypen, []);
      assert.equal(a.schluesselbild, false);
      assert.equal(a.hatParametersaetze, false);
      assert.equal(a.codecString, undefined);
    }
  });

  test('Ein Startcode ganz am Ende ohne Kopfbyte wird nicht mitgezaehlt', () => {
    const a = frame.analysiereBitstrom(Buffer.from([...nal(frame.NAL_SLICE_IDR, 0x88), 0x00, 0x00, 0x01]));
    assert.deepEqual(a.nalTypen, [frame.NAL_SLICE_IDR]);
  });
});

describe('Codecname nach RFC 6381 3.3', () => {
  test('profile_idc, constraint-Flags und level_idc werden hexadezimal angehaengt', () => {
    // High Profile (100 = 0x64), keine constraint-Flags, Level 3.1 (31 = 0x1f).
    const a = frame.analysiereBitstrom(Buffer.from(sps(0x64, 0x00, 0x1f)));
    assert.equal(a.codecString, 'avc1.64001f');
  });

  test('Einstellige Werte werden auf zwei Stellen aufgefuellt', () => {
    const a = frame.analysiereBitstrom(Buffer.from(sps(0x01, 0x02, 0x03)));
    assert.equal(a.codecString, 'avc1.010203');
  });

  test('Ein Emulation-Prevention-Byte im SPS wird wieder herausgenommen', () => {
    // 0x00 0x00 0x03 0x1f steht laut [ITU-H.264] 7.4.1.1 fuer 0x00 0x00 0x1f.
    // Ohne das Entfernen kaeme hier "avc1.000003" heraus - ein Codecname, den
    // kein Decoder kennt, und der Rueckfall griffe ohne erkennbaren Grund.
    const a = frame.analysiereBitstrom(Buffer.from(nal(frame.NAL_SPS, 0x00, 0x00, 0x03, 0x1f, 0xac)));
    assert.equal(a.codecString, 'avc1.00001f');
  });

  test('Ein abgeschnittenes SPS liefert keinen Namen statt eines falschen', () => {
    const a = frame.analysiereBitstrom(Buffer.from(nal(frame.NAL_SPS, 0x64, 0x00)));
    assert.equal(a.codecString, undefined);
  });

  test('Das erste SPS gewinnt, spaetere aendern den Namen nicht mehr', () => {
    const a = frame.analysiereBitstrom(Buffer.from([...sps(0x42, 0xc0, 0x1e), ...sps(0x64, 0x00, 0x28)]));
    assert.equal(a.codecString, 'avc1.42c01e');
  });
});

describe('Regionen auf dem Bildschirm (MS-RDPEGFX 2.2.4.4.1)', () => {
  function region(left: number, top: number, right: number, bottom: number): AvcRegion {
    return { rect: { left, top, right, bottom }, qp: 28, quality: 100, progressive: false };
  }

  test('Eine Region wird um den Surface-Ursprung verschoben, die Groesse bleibt', () => {
    const bereiche = frame.avcZeichenbereiche([region(16, 32, 80, 96)], {
      width: 1024,
      height: 768,
      outputX: 100,
      outputY: 50,
    });
    assert.deepEqual(bereiche, [{ sx: 16, sy: 32, breite: 64, hoehe: 64, zx: 116, zy: 82 }]);
  });

  test('Die Quelle bleibt in Surface-Koordinaten, auch bei versetzter Ausgabe', () => {
    // Das dekodierte Bild liegt am Surface-Ursprung. Wer hier die Zielposition
    // auch als Quellposition benutzt, schneidet das Bild an der falschen Stelle
    // aus und verschiebt den Inhalt um genau den Ausgabeursprung.
    const [b] = frame.avcZeichenbereiche([region(0, 0, 16, 16)], {
      width: 640,
      height: 480,
      outputX: 200,
      outputY: 300,
    });
    assert.deepEqual([b.sx, b.sy], [0, 0]);
    assert.deepEqual([b.zx, b.zy], [200, 300]);
  });

  test('Der 16er-Ueberhang des Bitstroms wird an der Surface beschnitten', () => {
    // 2.2.4.4: Breite und Hoehe des Bitstroms sind auf ein Vielfaches von 16
    // aufgerundet. Eine Region darf deshalb ueber die Surface hinausragen.
    const bereiche = frame.avcZeichenbereiche([region(0, 0, 1936, 1088)], {
      width: 1920,
      height: 1080,
      outputX: 0,
      outputY: 0,
    });
    assert.deepEqual(bereiche, [{ sx: 0, sy: 0, breite: 1920, hoehe: 1080, zx: 0, zy: 0 }]);
  });

  test('Negative Kanten werden auf null gezogen', () => {
    const [b] = frame.avcZeichenbereiche([region(-8, -4, 16, 16)], {
      width: 100,
      height: 100,
      outputX: 0,
      outputY: 0,
    });
    assert.deepEqual([b.sx, b.sy, b.breite, b.hoehe], [0, 0, 16, 16]);
  });

  test('Eine Region ganz ausserhalb faellt heraus statt mit Breite null zu zeichnen', () => {
    const bereiche = frame.avcZeichenbereiche(
      [region(2000, 0, 2100, 100), region(0, 0, 0, 100), region(0, 0, 32, 32)],
      { width: 1920, height: 1080, outputX: 0, outputY: 0 },
    );
    assert.equal(bereiche.length, 1, 'nur die eine brauchbare Region bleibt uebrig');
    assert.deepEqual([bereiche[0].breite, bereiche[0].hoehe], [32, 32]);
  });

  test('Die Reihenfolge der Regionen bleibt die des Metablocks', () => {
    const bereiche = frame.avcZeichenbereiche([region(0, 0, 8, 8), region(64, 0, 72, 8), region(32, 0, 40, 8)], {
      width: 128,
      height: 64,
      outputX: 0,
      outputY: 0,
    });
    assert.deepEqual(
      bereiche.map((b) => b.sx),
      [0, 64, 32],
    );
  });
});
