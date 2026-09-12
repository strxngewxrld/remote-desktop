import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { BinaryWriter } from '../src/core/binary.js';
import * as egfx from '../src/protocol/egfx.js';
import {
  EgfxSession,
  EgfxVideoFrame,
  DEFAULT_EGFX_CAPS,
  AVC420_EGFX_CAPS,
} from '../src/protocol/egfxSession.js';
import { DecodedBitmap } from '../src/protocol/updates.js';
import { Logger } from '../src/core/log.js';

/** Ein Protokoll, das nichts ausgibt, aber die Warnungen mitschreibt. */
function stilleProtokollierung(): Logger & { warnungen: string[] } {
  const warnungen: string[] = [];
  const log = {
    warnungen,
    debug: () => {},
    trace: () => {},
    info: () => {},
    warn: (m: string) => warnungen.push(m),
    error: () => {},
  };
  return log as unknown as Logger & { warnungen: string[] };
}

/** RDPGFX_HEADER (2.2.1.5) um einen Rumpf. */
function pdu(cmdId: number, body: Buffer): Buffer {
  return new BinaryWriter().uint16le(cmdId).uint16le(0).uint32le(8 + body.length).bytes(body).toBuffer();
}

function createSurface(surfaceId: number, width: number, height: number): Buffer {
  return pdu(
    egfx.RDPGFX_CMDID_CREATESURFACE,
    new BinaryWriter()
      .uint16le(surfaceId)
      .uint16le(width)
      .uint16le(height)
      .uint8(egfx.PIXEL_FORMAT_XRGB_8888)
      .toBuffer(),
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

function wireToSurface1(
  surfaceId: number,
  codecId: number,
  rect: { left: number; top: number; right: number; bottom: number },
  bitmapData: Buffer,
): Buffer {
  const body = new BinaryWriter()
    .uint16le(surfaceId)
    .uint16le(codecId)
    .uint8(egfx.PIXEL_FORMAT_XRGB_8888)
    .uint16le(rect.left)
    .uint16le(rect.top)
    .uint16le(rect.right)
    .uint16le(rect.bottom)
    .uint32le(bitmapData.length)
    .bytes(bitmapData)
    .toBuffer();
  return pdu(egfx.RDPGFX_CMDID_WIRETOSURFACE_1, body);
}

/** Eine unkomprimierte Kachel - stellvertretend fuer die bestehenden Codecpfade. */
function unkomprimierteKachel(breite: number, hoehe: number, marke: number): Buffer {
  const daten = Buffer.alloc(breite * hoehe * 4, marke);
  return daten;
}

/** RFX_AVC420_BITMAP_STREAM (2.2.4.4) von Hand: METABLOCK, dann Annex B. */
function avc420Nutzlast(
  regionen: { left: number; top: number; right: number; bottom: number }[],
  bitstream: number[],
): Buffer {
  const w = new BinaryWriter().uint32le(regionen.length);
  for (const r of regionen) w.uint16le(r.left).uint16le(r.top).uint16le(r.right).uint16le(r.bottom);
  // quantQualityVals: qp 28, kein p-Bit, qualityVal 100.
  for (let i = 0; i < regionen.length; i++) w.uint8(28).uint8(100);
  return Buffer.concat([w.toBuffer(), Buffer.from(bitstream)]);
}

/** SPS, PPS und IDR-Scheibe, gerade genug fuer die Analyse. */
const SCHLUESSELBILD = [
  0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f, 0xac,
  0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0xb0,
  0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00,
];
/** Eine Scheibe eines Nicht-IDR-Bildes. */
const FOLGEBILD = [0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00, 0x21];

interface Aufzeichnung {
  sitzung: EgfxSession;
  /** Was der Reihe nach hinausging: Kachelbuendel und Videobilder gemischt. */
  reihenfolge: Array<{ art: 'kacheln'; tiles: DecodedBitmap[] } | { art: 'video'; frame: EgfxVideoFrame }>;
  gesendet: Buffer[];
  warnungen: string[];
}

function baueSitzung(mitVideo: boolean, capsSets?: egfx.EgfxCapsSet[]): Aufzeichnung {
  const log = stilleProtokollierung();
  const reihenfolge: Aufzeichnung['reihenfolge'] = [];
  const gesendet: Buffer[] = [];
  const sitzung = new EgfxSession({
    log,
    capsSets,
    send: (p) => gesendet.push(p),
    onBitmap: (tiles) => reihenfolge.push({ art: 'kacheln', tiles }),
    onResize: () => {},
    onVideo: mitVideo ? (frame) => reihenfolge.push({ art: 'video', frame }) : undefined,
  });
  return { sitzung, reihenfolge, gesendet, warnungen: log.warnungen };
}

/** Liest die angebotenen Capability-Sets aus einem CAPS_ADVERTISE (2.2.2.18). */
function capsAus(roh: Buffer): Array<{ version: number; flags: number }> {
  const anzahl = roh.readUInt16LE(8);
  const sets: Array<{ version: number; flags: number }> = [];
  let o = 10;
  for (let i = 0; i < anzahl; i++) {
    const version = roh.readUInt32LE(o);
    const laenge = roh.readUInt32LE(o + 4);
    sets.push({ version, flags: laenge >= 4 ? roh.readUInt32LE(o + 8) : 0 });
    o += 8 + laenge;
  }
  return sets;
}

describe('EGFX-Capabilities: H.264 bleibt abgeschaltet, solange niemand es anfordert', () => {
  test('Ohne Angabe wird weiterhin V8 und V8.1 ohne jedes Flag angeboten', () => {
    const a = baueSitzung(false);
    a.sitzung.start();
    assert.deepEqual(capsAus(a.gesendet[0]), [
      { version: egfx.RDPGFX_CAPVERSION_8, flags: 0 },
      { version: egfx.RDPGFX_CAPVERSION_81, flags: 0 },
    ]);
  });

  test('DEFAULT_EGFX_CAPS traegt kein AVC420_ENABLED und keine Version ab 10', () => {
    // Die harte Anforderung: bei abgeschalteter Einstellung darf sich auf dem
    // Draht nichts aendern. Ein Flag hier wuerde den Server sofort auf H.264
    // umschwenken lassen, und der bestehende, nachweislich funktionierende
    // Pfad waere weg.
    for (const set of DEFAULT_EGFX_CAPS) {
      assert.equal((set.flags ?? 0) & egfx.RDPGFX_CAPS_FLAG_AVC420_ENABLED, 0);
      assert.ok(set.version < egfx.RDPGFX_CAPVERSION_10, `Version 0x${set.version.toString(16)} ist zu neu`);
    }
  });

  test('AVC420_EGFX_CAPS meldet SMALL_CACHE zusammen mit AVC420_ENABLED an', () => {
    // MS-RDPEGFX 2.2.3.2 zaehlt die erlaubten Flagkombinationen fuer V8.1 auf.
    // AVC420_ENABLED steht dort nur zusammen mit SMALL_CACHE.
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.start();
    assert.deepEqual(capsAus(a.gesendet[0]), [
      { version: egfx.RDPGFX_CAPVERSION_8, flags: 0 },
      {
        version: egfx.RDPGFX_CAPVERSION_81,
        flags: egfx.RDPGFX_CAPS_FLAG_SMALL_CACHE | egfx.RDPGFX_CAPS_FLAG_AVC420_ENABLED,
      },
    ]);
  });

  test('Auch der AVC-Satz bleibt unter Version 10 und verspricht damit kein YUV444', () => {
    // Ab V10 bedeutet ein *nicht* gesetztes AVC_DISABLED die Zusage, H.264 in
    // YUV444 zu beherrschen. Solange nur 420 gebaut ist, darf diese Version
    // gar nicht erst im Angebot stehen.
    for (const set of AVC420_EGFX_CAPS) {
      assert.ok(set.version < egfx.RDPGFX_CAPVERSION_10);
      assert.equal((set.flags ?? 0) & egfx.RDPGFX_CAPS_FLAG_THINCLIENT, 0, 'THINCLIENT wuerde RemoteFX verlangen');
    }
  });

  test('Der AVC-Satz laesst V8 ohne Flags als Rueckfall stehen', () => {
    assert.ok(
      AVC420_EGFX_CAPS.some((s) => s.version === egfx.RDPGFX_CAPVERSION_8 && (s.flags ?? 0) === 0),
      'ohne diesen Eintrag haette ein Server ohne V8.1 gar keine Wahl mehr',
    );
  });
});

describe('Die bestehenden Codecpfade bleiben unberuehrt', () => {
  test('Eine unkomprimierte Kachel wird wie bisher gebuendelt bis zum ENDFRAME', () => {
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 64, 64));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(startFrame(1));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 0, top: 0, right: 8, bottom: 8 },
        unkomprimierteKachel(8, 8, 0x40)),
    );
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 8, top: 0, right: 16, bottom: 8 },
        unkomprimierteKachel(8, 8, 0x50)),
    );
    // Bis hierher darf noch nichts hinausgegangen sein.
    assert.equal(a.reihenfolge.length, 0, 'ohne ENDFRAME wird nicht gezeigt');
    a.sitzung.handle(endFrame(1));
    assert.equal(a.reihenfolge.length, 1, 'genau ein Buendel');
    assert.equal(a.reihenfolge[0].art, 'kacheln');
    assert.equal((a.reihenfolge[0] as { tiles: DecodedBitmap[] }).tiles.length, 2);
  });

  test('Ohne AVC-Nutzlast entsteht kein einziges Videoereignis', () => {
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 64, 64));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(startFrame(1));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 0, top: 0, right: 4, bottom: 4 },
        unkomprimierteKachel(4, 4, 0x11)),
    );
    a.sitzung.handle(endFrame(1));
    assert.ok(a.reihenfolge.every((e) => e.art === 'kacheln'));
    assert.deepEqual(a.sitzung.getAvcStats(), { regionen: 0, bytes: 0 });
  });

  test('Ohne onVideo bleibt es beim bisherigen Verhalten: eine Warnung, kein Bild', () => {
    // Genau der Zustand von vorher. Er muss erhalten bleiben, damit das
    // Messskript unter reinem Node weiterlaeuft.
    const a = baueSitzung(false);
    a.sitzung.handle(createSurface(1, 64, 64));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 64, bottom: 64 },
        avc420Nutzlast([{ left: 0, top: 0, right: 64, bottom: 64 }], SCHLUESSELBILD)),
    );
    assert.equal(a.reihenfolge.length, 0, 'ohne Decoder wird nichts gezeichnet');
    assert.ok(a.warnungen.some((w) => w.includes('kein Decoder')));
    assert.equal(a.sitzung.getAvcStats().regionen, 1, 'gezaehlt wird trotzdem');
  });
});

describe('AVC420 als zusaetzlicher Pfad (MS-RDPEGFX 2.2.2.1, 2.2.4.4)', () => {
  function sitzungMitSurface(): Aufzeichnung {
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 1920, 1080));
    a.sitzung.handle(mapToOutput(1, 40, 25));
    return a;
  }

  test('Ein AVC420-Teilbild kommt mit Regionen, Surface-Lage und Analyse an', () => {
    const a = sitzungMitSurface();
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 1920, bottom: 1080 },
        avc420Nutzlast(
          [
            { left: 0, top: 0, right: 64, bottom: 64 },
            { left: 128, top: 64, right: 256, bottom: 192 },
          ],
          SCHLUESSELBILD,
        )),
    );
    assert.equal(a.reihenfolge.length, 1);
    const eintrag = a.reihenfolge[0];
    assert.equal(eintrag.art, 'video');
    const frame = (eintrag as { frame: EgfxVideoFrame }).frame;

    assert.equal(frame.codecId, egfx.RDPGFX_CODECID_AVC420);
    assert.equal(frame.yuv420?.regions.length, 2);
    assert.deepEqual(frame.yuv420?.regions[1].rect, { left: 128, top: 64, right: 256, bottom: 192 });
    assert.deepEqual(frame.surface, { width: 1920, height: 1080, outputX: 40, outputY: 25 });
    assert.equal(frame.abgebildet, true);
    assert.equal(frame.analyse?.schluesselbild, true);
    assert.equal(frame.analyse?.hatParametersaetze, true);
    assert.equal(frame.analyse?.codecString, 'avc1.64001f');
    assert.equal(frame.chroma420, undefined, 'AVC420 hat keinen Chroma-Teilrahmen');
  });

  test('Ein Folgebild wird als Folgebild gemeldet', () => {
    const a = sitzungMitSurface();
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 16, bottom: 16 },
        avc420Nutzlast([{ left: 0, top: 0, right: 16, bottom: 16 }], FOLGEBILD)),
    );
    const frame = (a.reihenfolge[0] as { frame: EgfxVideoFrame }).frame;
    assert.equal(frame.analyse?.schluesselbild, false);
    assert.equal(frame.analyse?.hatParametersaetze, false);
  });

  test('Eine nicht abgebildete Surface ist als solche gekennzeichnet', () => {
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(2, 320, 240));
    a.sitzung.handle(
      wireToSurface1(2, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 320, bottom: 240 },
        avc420Nutzlast([{ left: 0, top: 0, right: 320, bottom: 240 }], SCHLUESSELBILD)),
    );
    const frame = (a.reihenfolge[0] as { frame: EgfxVideoFrame }).frame;
    assert.equal(frame.abgebildet, false, 'ohne MAPSURFACETOOUTPUT gehoert nichts auf den Bildschirm');
  });

  test('Ein Teilbild fuer eine unbekannte Surface wird verworfen, nicht geraten', () => {
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(
      wireToSurface1(99, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 16, bottom: 16 },
        avc420Nutzlast([{ left: 0, top: 0, right: 16, bottom: 16 }], SCHLUESSELBILD)),
    );
    assert.equal(a.reihenfolge.length, 0);
  });

  test('Eine kaputte AVC-Nutzlast beendet die Sitzung nicht', () => {
    const a = sitzungMitSurface();
    // numRegionRects behauptet 1000 Regionen, es folgen aber nur wenige Bytes.
    const kaputt = Buffer.concat([new BinaryWriter().uint32le(1000).toBuffer(), Buffer.from([1, 2, 3, 4])]);
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 16, bottom: 16 }, kaputt),
    );
    assert.equal(a.reihenfolge.length, 0);
    assert.ok(a.warnungen.some((w) => w.includes('AVC-Nutzlast unlesbar')));
    // Und danach laeuft es weiter.
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 16, bottom: 16 },
        avc420Nutzlast([{ left: 0, top: 0, right: 16, bottom: 16 }], SCHLUESSELBILD)),
    );
    assert.equal(a.reihenfolge.length, 1);
  });
});

describe('Reihenfolge zwischen AVC und den uebrigen Codecpfaden', () => {
  test('Was vor dem Teilbild dekodiert wurde, geht auch vorher hinaus', () => {
    // Der eigentliche Grund fuer den Test: beide Wege schreiben auf dieselbe
    // Flaeche. Kaeme das gebuendelte ClearCodec-Ergebnis erst nach dem
    // Videobild beim Empfaenger an, uebermalte aelterer Inhalt den juengeren.
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 256, 256));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(startFrame(1));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 0, top: 0, right: 4, bottom: 4 },
        unkomprimierteKachel(4, 4, 0x22)),
    );
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 256, bottom: 256 },
        avc420Nutzlast([{ left: 0, top: 0, right: 256, bottom: 256 }], SCHLUESSELBILD)),
    );
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 8, top: 8, right: 12, bottom: 12 },
        unkomprimierteKachel(4, 4, 0x33)),
    );
    a.sitzung.handle(endFrame(1));

    assert.deepEqual(
      a.reihenfolge.map((e) => e.art),
      ['kacheln', 'video', 'kacheln'],
      'die Reihenfolge des Stroms bleibt erhalten',
    );
  });

  test('Ohne vorangegangene Kacheln entsteht kein leeres Buendel', () => {
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 64, 64));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(startFrame(1));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 64, bottom: 64 },
        avc420Nutzlast([{ left: 0, top: 0, right: 64, bottom: 64 }], SCHLUESSELBILD)),
    );
    a.sitzung.handle(endFrame(1));
    assert.deepEqual(a.reihenfolge.map((e) => e.art), ['video']);
  });
});

describe('Der Surface-Puffer kennt die H.264-Pixel nicht', () => {
  test('Nach einem Videobild wird die Surface nicht mehr als Ganzes ausgegeben', () => {
    // Die AVC-Pixel entstehen im Renderer. Eine Vollausgabe aus dem Puffer
    // hier waere an diesen Stellen schwarz und loeschte das Videobild wieder
    // vom Bildschirm - ein Fehler, der nur beim erneuten Abbilden auftritt und
    // deshalb schwer zuzuordnen waere.
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 64, 64));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 0, top: 0, right: 8, bottom: 8 },
        unkomprimierteKachel(8, 8, 0x60)),
    );
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_AVC420, { left: 0, top: 0, right: 64, bottom: 64 },
        avc420Nutzlast([{ left: 0, top: 0, right: 64, bottom: 64 }], SCHLUESSELBILD)),
    );
    const vorher = a.reihenfolge.length;

    a.sitzung.handle(mapToOutput(1, 100, 100));
    assert.equal(a.reihenfolge.length, vorher, 'keine Vollausgabe nach einem Videobild');
  });

  test('Ohne Videobild bleibt die Vollausgabe beim erneuten Abbilden erhalten', () => {
    // Die Gegenprobe: am bestehenden Verhalten aendert sich nichts.
    const a = baueSitzung(true, AVC420_EGFX_CAPS);
    a.sitzung.handle(createSurface(1, 64, 64));
    a.sitzung.handle(mapToOutput(1, 0, 0));
    a.sitzung.handle(
      wireToSurface1(1, egfx.RDPGFX_CODECID_UNCOMPRESSED, { left: 0, top: 0, right: 8, bottom: 8 },
        unkomprimierteKachel(8, 8, 0x60)),
    );
    const vorher = a.reihenfolge.length;

    a.sitzung.handle(mapToOutput(1, 100, 100));
    assert.equal(a.reihenfolge.length, vorher + 1, 'die Vollausgabe kommt wie bisher');
  });
});
