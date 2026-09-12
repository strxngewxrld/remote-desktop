import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { interleavedDecompress, RleError } from '../src/codec/rle.js';
import { bytesPerPixel, flipVertical, toRgba } from '../src/codec/pixel.js';
import {
  parsePointerImage,
  parseSurfaceCommands,
  decodeSurfaceBits,
  CMDTYPE_SET_SURFACE_BITS,
  CMDTYPE_FRAME_MARKER,
} from '../src/protocol/updates.js';
import { BinaryReader, BinaryWriter } from '../src/core/binary.js';

/** Liest die dekomprimierte Ausgabe als 16-Bit-Pixel aus. */
function pixels16(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readUInt16LE(i));
  return out;
}

const RED = 0xf800;
const WHITE = 0xffff;

describe('Interleaved RLE', () => {
  test('SPECIAL_BLACK und SPECIAL_WHITE setzen einzelne Pixel', () => {
    const src = Buffer.from([0xfe, 0xfd, 0xfe, 0xfd]);
    assert.deepEqual(pixels16(interleavedDecompress(src, 4, 1, 2)), [0, WHITE, 0, WHITE]);
  });

  test('REGULAR_COLOR_RUN fuellt eine Farbe', () => {
    // Code 3 (<<5) mit Laenge 4, danach die Farbe als 16-Bit LE
    const src = Buffer.from([(3 << 5) | 4, RED & 0xff, RED >> 8]);
    assert.deepEqual(pixels16(interleavedDecompress(src, 4, 1, 2)), [RED, RED, RED, RED]);
  });

  test('REGULAR_COLOR_IMAGE kopiert Pixel unveraendert', () => {
    const w = new BinaryWriter().uint8((4 << 5) | 3);
    w.uint16le(0x1111).uint16le(0x2222).uint16le(0x3333);
    assert.deepEqual(pixels16(interleavedDecompress(w.toBuffer(), 3, 1, 2)), [0x1111, 0x2222, 0x3333]);
  });

  test('Hintergrundlauf kopiert die Zeile darueber', () => {
    const src = Buffer.concat([
      Buffer.from([(3 << 5) | 4, RED & 0xff, RED >> 8]), // Zeile 0: vier rote Pixel
      Buffer.from([4]), // Zeile 1: REGULAR_BG_RUN, Laenge 4
    ]);
    const out = pixels16(interleavedDecompress(src, 4, 2, 2));
    assert.deepEqual(out.slice(0, 4), [RED, RED, RED, RED]);
    assert.deepEqual(out.slice(4), [RED, RED, RED, RED], 'Zeile 1 spiegelt Zeile 0');
  });

  test('Vordergrundlauf XOR-verknuepft mit der Zeile darueber', () => {
    const src = Buffer.concat([
      Buffer.from([(3 << 5) | 4, RED & 0xff, RED >> 8]),
      Buffer.from([(1 << 5) | 4]), // REGULAR_FG_RUN mit Standard-Vordergrund (weiss)
    ]);
    const out = pixels16(interleavedDecompress(src, 4, 2, 2));
    assert.deepEqual(out.slice(4), [RED ^ WHITE, RED ^ WHITE, RED ^ WHITE, RED ^ WHITE]);
  });

  test('LITE_SET_FG_FG_RUN setzt die Vordergrundfarbe neu', () => {
    const src = Buffer.concat([
      Buffer.from([2]), // Zeile 0: zwei schwarze Pixel
      Buffer.from([(0xc << 4) | 2, 0x34, 0x12]), // Zeile 1: FG-Lauf mit Farbe 0x1234
    ]);
    const out = pixels16(interleavedDecompress(src, 2, 2, 2));
    assert.deepEqual(out.slice(0, 2), [0, 0]);
    assert.deepEqual(out.slice(2), [0x1234, 0x1234], 'schwarz XOR Farbe ergibt die Farbe');
  });

  test('Ein zweiter Hintergrundlauf beginnt mit einem Vordergrundpixel', () => {
    // Genau diese Regel (fInsertFgPel) erzeugt Schachbrettmuster in echten Sitzungen:
    // Zeile 1 = Farblauf, Hintergrundlauf, Hintergrundlauf.
    const w = new BinaryWriter().uint8(4); // Zeile 0: vier schwarze Pixel
    w.uint8((3 << 5) | 1).uint16le(0x1234); // Farblauf, setzt insertFgPel zurueck
    w.uint8(1); // Hintergrundlauf: kopiert von oben, setzt insertFgPel
    w.uint8(2); // Hintergrundlauf: erstes Pixel ist jetzt Vordergrund
    const out = pixels16(interleavedDecompress(w.toBuffer(), 4, 2, 2));
    assert.deepEqual(out.slice(0, 4), [0, 0, 0, 0]);
    assert.deepEqual(out.slice(4), [0x1234, 0, WHITE, 0]);
  });

  test('Der Zeilenwechsel setzt das Vordergrund-Flag zurueck', () => {
    // Ein Hintergrundlauf, der genau auf der Zeilengrenze endet, darf in der
    // naechsten Zeile kein Vordergrundpixel einfuegen (MS-RDPEGDI 3.1.9.1).
    const src = Buffer.from([4, 2, 2]);
    const out = pixels16(interleavedDecompress(src, 4, 2, 2));
    assert.deepEqual(out.slice(4), [0, 0, WHITE, 0]);
  });

  test('LITE_DITHERED_RUN wechselt zwei Farben ab', () => {
    const w = new BinaryWriter().uint8((0xe << 4) | 2);
    w.uint16le(0xaaaa).uint16le(0x5555);
    assert.deepEqual(pixels16(interleavedDecompress(w.toBuffer(), 4, 1, 2)), [0xaaaa, 0x5555, 0xaaaa, 0x5555]);
  });

  test('FGBG-Image verteilt Vorder- und Hintergrund bitweise', () => {
    // Code 2, Laenge 0 -> naechstes Byte + 1 = 4 Pixel, danach die Bitmaske
    const src = Buffer.from([2 << 5, 0x03, 0b00000101]);
    assert.deepEqual(pixels16(interleavedDecompress(src, 4, 1, 2)), [WHITE, 0, WHITE, 0]);
  });

  test('MEGA_MEGA_COLOR_RUN nutzt eine 16-Bit-Laenge', () => {
    const w = new BinaryWriter().uint8(0xf3).uint16le(300);
    w.uint16le(0x0f0f);
    const out = pixels16(interleavedDecompress(w.toBuffer(), 300, 1, 2));
    assert.equal(out.length, 300);
    assert.ok(out.every((p) => p === 0x0f0f));
  });

  test('SPECIAL_FGBG_1 entspricht der Maske 0x03', () => {
    const src = Buffer.from([0xf9]);
    assert.deepEqual(pixels16(interleavedDecompress(src, 8, 1, 2)), [WHITE, WHITE, 0, 0, 0, 0, 0, 0]);
  });

  test('8bpp wird unterstuetzt', () => {
    const src = Buffer.from([(3 << 5) | 3, 0x42]);
    assert.deepEqual([...interleavedDecompress(src, 3, 1, 1)], [0x42, 0x42, 0x42]);
  });

  test('24bpp liest drei Byte pro Pixel', () => {
    const src = Buffer.from([(4 << 5) | 2, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    assert.deepEqual([...interleavedDecompress(src, 2, 1, 3)], [0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
  });

  test('Zu viele Daten fuer die Bitmap werden abgefangen', () => {
    const src = Buffer.from([(3 << 5) | 20, 0x00, 0xff]);
    assert.throws(() => interleavedDecompress(src, 4, 1, 2), RleError);
  });

  test('Unbekannte Pixelbreite wird abgelehnt', () => {
    assert.throws(() => interleavedDecompress(Buffer.alloc(1), 1, 1, 4), RleError);
  });
});

describe('Pixelkonvertierung', () => {
  test('RGB565 wird korrekt gespreizt', () => {
    const src = Buffer.alloc(6);
    src.writeUInt16LE(0xf800, 0); // reines Rot
    src.writeUInt16LE(0x07e0, 2); // reines Gruen
    src.writeUInt16LE(0x001f, 4); // reines Blau
    const rgba = toRgba(src, 3, 16);
    assert.deepEqual([...rgba.slice(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...rgba.slice(4, 8)], [0, 255, 0, 255]);
    assert.deepEqual([...rgba.slice(8, 12)], [0, 0, 255, 255]);
  });

  test('RGB555 nutzt fuenf Bit pro Kanal', () => {
    const src = Buffer.alloc(2);
    src.writeUInt16LE(0x7c00, 0);
    assert.deepEqual([...toRgba(src, 1, 15).slice(0, 4)], [255, 0, 0, 255]);
  });

  test('24bpp liegt als BGR vor', () => {
    const rgba = toRgba(Buffer.from([0x10, 0x20, 0x30]), 1, 24);
    assert.deepEqual([...rgba], [0x30, 0x20, 0x10, 255]);
  });

  test('32bpp setzt Alpha immer auf deckend', () => {
    const rgba = toRgba(Buffer.from([0x10, 0x20, 0x30, 0x00]), 1, 32);
    assert.deepEqual([...rgba], [0x30, 0x20, 0x10, 255]);
  });

  test('8bpp verwendet die Palette', () => {
    const palette = Buffer.alloc(768);
    palette[3] = 10; palette[4] = 20; palette[5] = 30;
    assert.deepEqual([...toRgba(Buffer.from([1]), 1, 8, palette)], [10, 20, 30, 255]);
  });

  test('bytesPerPixel deckt alle Formate ab', () => {
    assert.deepEqual([8, 15, 16, 24, 32].map((b) => bytesPerPixel(b as 8)), [1, 2, 2, 3, 4]);
  });

  test('flipVertical dreht die Zeilenreihenfolge', () => {
    const src = Buffer.from([1, 1, 2, 2, 3, 3]); // drei Zeilen a 1 Pixel (2 Byte)
    assert.deepEqual([...flipVertical(src, 1, 3, 2)], [3, 3, 2, 2, 1, 1]);
  });
});

describe('Zeigerbilder', () => {
  test('24bpp-Zeiger mit AND-Maske erzeugt Transparenz', () => {
    const width = 8, height = 2;
    const xorStride = 24; // 8 Pixel * 3 Byte, bereits gerade
    const andStride = 2; // 1 Byte aufgerundet auf 2
    const xor = Buffer.alloc(xorStride * height);
    // Unterste gespeicherte Zeile entspricht der obersten angezeigten Zeile.
    for (let x = 0; x < width; x++) {
      xor[xorStride + x * 3] = 0x00; // B
      xor[xorStride + x * 3 + 1] = 0x00; // G
      xor[xorStride + x * 3 + 2] = 0xff; // R
    }
    const and = Buffer.alloc(andStride * height);
    and[andStride] = 0b00001111; // rechte vier Pixel der oberen Zeile transparent

    const w = new BinaryWriter()
      .uint16le(3) // cacheIndex
      .uint16le(1).uint16le(2) // Hotspot
      .uint16le(width).uint16le(height)
      .uint16le(and.length).uint16le(xor.length)
      .bytes(xor).bytes(and);

    const image = parsePointerImage(new BinaryReader(w.toBuffer()), 24);
    assert.equal(image.cacheIndex, 3);
    assert.equal(image.hotspotX, 1);
    assert.equal(image.width, 8);
    // Erstes Pixel: rot und deckend
    assert.deepEqual([...image.rgba.slice(0, 4)], [255, 0, 0, 255]);
    // Fuenftes Pixel: AND-Bit gesetzt, Farbe aber nicht schwarz -> bleibt deckend
    assert.equal(image.rgba[4 * 4 + 3], 255);
  });

  test('Unplausible Zeigergroessen werden abgewiesen', () => {
    const w = new BinaryWriter()
      .uint16le(0).uint16le(0).uint16le(0)
      .uint16le(4096).uint16le(4096)
      .uint16le(0).uint16le(0);
    assert.throws(() => parsePointerImage(new BinaryReader(w.toBuffer()), 24), /unplausibler Groesse/);
  });
});

describe('Surface Commands', () => {
  /** Baut ein Set-Surface-Bits-Update mit unkomprimierten 32bpp-Pixeln. */
  function surfaceBits(width: number, height: number, pixels: Buffer, codecId = 0): Buffer {
    const w = new BinaryWriter();
    w.uint16le(CMDTYPE_SET_SURFACE_BITS);
    w.uint16le(10).uint16le(20); // destLeft/destTop
    w.uint16le(10 + width - 1).uint16le(20 + height - 1);
    w.uint8(32).uint8(0).uint8(0).uint8(codecId); // bpp, flags, reserved, codecID
    w.uint16le(width).uint16le(height);
    w.uint32le(pixels.length);
    w.bytes(pixels);
    return w.toBuffer();
  }

  test('Unkomprimierte Surface Bits werden gelesen', () => {
    // Surface Bits liegen als BGRA vor.
    const pixels = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255]);
    const [bits] = parseSurfaceCommands(new BinaryReader(surfaceBits(2, 1, pixels)));
    assert.equal(bits.destLeft, 10);
    assert.equal(bits.destTop, 20);
    assert.equal(bits.width, 2);
    assert.equal(bits.bitsPerPixel, 32);
    assert.equal(bits.codecId, 0);
    assert.equal(bits.data.length, 8);
  });

  test('Surface Bits werden nach RGBA gewandelt', () => {
    // BGRA: erstes Pixel rot, zweites gruen.
    const pixels = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255]);
    const [bits] = parseSurfaceCommands(new BinaryReader(surfaceBits(2, 1, pixels)));
    const bild = decodeSurfaceBits(bits);
    assert.equal(bild.x, 10);
    assert.equal(bild.y, 20);
    assert.deepEqual([...bild.rgba.slice(0, 4)], [255, 0, 0, 255], 'rot');
    assert.deepEqual([...bild.rgba.slice(4, 8)], [0, 255, 0, 255], 'gruen');
  });

  test('Mehrzeilige Surface Bits werden richtig herum gedreht', () => {
    // Untere Zeile zuerst: erst blau, dann rot -> oben muss rot stehen.
    const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
    const [bits] = parseSurfaceCommands(new BinaryReader(surfaceBits(1, 2, pixels)));
    const bild = decodeSurfaceBits(bits);
    assert.deepEqual([...bild.rgba.slice(0, 4)], [255, 0, 0, 255], 'oben rot');
    assert.deepEqual([...bild.rgba.slice(4, 8)], [0, 0, 255, 255], 'unten blau');
  });

  test('Frame-Marker werden uebersprungen', () => {
    const marker = new BinaryWriter().uint16le(CMDTYPE_FRAME_MARKER).uint16le(0).uint32le(7).toBuffer();
    const pixels = Buffer.alloc(4);
    const strom = Buffer.concat([marker, surfaceBits(1, 1, pixels), marker]);
    const befehle = parseSurfaceCommands(new BinaryReader(strom));
    assert.equal(befehle.length, 1, 'nur der Bildbefehl zaehlt');
  });

  test('Mehrere Surface Bits in einem Update', () => {
    const strom = Buffer.concat([surfaceBits(1, 1, Buffer.alloc(4)), surfaceBits(2, 1, Buffer.alloc(8))]);
    const befehle = parseSurfaceCommands(new BinaryReader(strom));
    assert.equal(befehle.length, 2);
    assert.equal(befehle[1].width, 2);
  });

  test('Ein nicht unterstuetzter Codec wird klar gemeldet', () => {
    const [bits] = parseSurfaceCommands(new BinaryReader(surfaceBits(1, 1, Buffer.alloc(4), 3)));
    assert.throws(() => decodeSurfaceBits(bits), /Codec 3/);
  });
});
