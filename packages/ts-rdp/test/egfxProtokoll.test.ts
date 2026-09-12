/**
 * Die Protokollierung der Graphics Pipeline ist selbst ein Werkzeug und wird
 * deshalb geprueft wie jedes andere: an einem echten Server laesst sich der
 * Bildfehler nicht nachstellen, also muss der Mitschnitt die Fragen
 * beantworten, die wir sonst am Debugger klaeren wuerden.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BinaryWriter } from '../src/core/binary.js';
import { EgfxSession } from '../src/protocol/egfxSession.js';
import { LogLevel, Logger } from '../src/core/log.js';
import * as egfx from '../src/protocol/egfx.js';

interface Mitschnitt {
  sitzung: EgfxSession;
  zeilen: Array<{ stufe: LogLevel; text: string }>;
  /** Alle Zeilen einer Stufe als eine Zeichenkette - bequem fuer Suchen. */
  auf: (stufe: LogLevel) => string;
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
  const sitzung = new EgfxSession({
    log,
    send: () => {},
    onBitmap: () => {},
    onResize: () => {},
  });
  return {
    sitzung,
    zeilen,
    auf: (stufe) =>
      zeilen
        .filter((z) => z.stufe === stufe)
        .map((z) => z.text)
        .join('\n'),
  };
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

  test('SURFACETOSURFACE aus einer nie bemalten Surface warnt vor der schwarzen Kopie', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(createSurface(2, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(surfaceToSurface(1, 2, [0, 0, 32, 32], [[0, 0]]));
    assert.match(m.auf('warn'), /kopiert aus Surface 1, in die noch nie etwas gemalt wurde/);
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

  test('Ein Cacheeintrag aus einer unbemalten Surface wird als schwarz gemeldet', () => {
    const m = baueSitzung();
    m.sitzung.handle(createSurface(1, 64, 64, egfx.PIXEL_FORMAT_XRGB_8888));
    m.sitzung.handle(surfaceToCache(1, 5, [0, 0, 16, 16]));
    assert.match(m.auf('warn'), /Slot 5 aus Surface 1 an, deren Puffer hier noch unbemalt ist/);
  });
});
