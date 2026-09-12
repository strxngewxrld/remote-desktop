/**
 * Bildschirm- und Zeiger-Updates (MS-RDPBCGR 2.2.9.1).
 */
import { BinaryReader } from '../core/binary.js';
import { interleavedDecompress } from '../codec/rle.js';
import { planarDecompress } from '../codec/planar.js';
import { bytesPerPixel, flipVertical, SourceFormat, toRgba } from '../codec/pixel.js';
import { BITMAP_COMPRESSION, NO_BITMAP_COMPRESSION_HDR } from './constants.js';
import { RdpProtocolError } from '../core/errors.js';

export interface BitmapRectangle {
  /** Zielkoordinaten im Desktop; rechts/unten sind inklusiv. */
  destLeft: number;
  destTop: number;
  destRight: number;
  destBottom: number;
  /** Groesse der uebertragenen Bitmap - kann wegen Ausrichtung groesser sein als der Zielbereich. */
  width: number;
  height: number;
  bitsPerPixel: number;
  compressed: boolean;
  data: Buffer;
}

export interface DecodedBitmap {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA8888, zeilenweise von oben nach unten. */
  rgba: Uint8ClampedArray;
}

export function parseBitmapUpdate(r: BinaryReader): BitmapRectangle[] {
  const count = r.uint16le();
  const rects: BitmapRectangle[] = [];
  for (let i = 0; i < count; i++) {
    const destLeft = r.uint16le();
    const destTop = r.uint16le();
    const destRight = r.uint16le();
    const destBottom = r.uint16le();
    const width = r.uint16le();
    const height = r.uint16le();
    const bitsPerPixel = r.uint16le();
    const flags = r.uint16le();
    let bitmapLength = r.uint16le();
    const compressed = (flags & BITMAP_COMPRESSION) !== 0;

    if (compressed && !(flags & NO_BITMAP_COMPRESSION_HDR)) {
      // Compressed Data Header: cbCompFirstRowSize, cbCompMainBodySize, cbScanWidth, cbUncompressedSize
      r.uint16le();
      const mainBodySize = r.uint16le();
      r.uint16le();
      r.uint16le();
      bitmapLength = mainBodySize;
    }

    rects.push({
      destLeft,
      destTop,
      destRight,
      destBottom,
      width,
      height,
      bitsPerPixel,
      compressed,
      data: r.bytes(Math.min(bitmapLength, r.remaining)),
    });
  }
  return rects;
}

/** Dekomprimiert eine Bitmap und wandelt sie nach RGBA. */
export function decodeBitmap(rect: BitmapRectangle, palette?: Buffer): DecodedBitmap {
  const bpp = rect.bitsPerPixel as SourceFormat;
  const bytes = bytesPerPixel(bpp);

  // Ab 32 bpp komprimiert der Server planar (RDP 6.0), darunter interleaved RLE.
  if (rect.compressed && bpp === 32) {
    const rgba = planarDecompress(rect.data, { width: rect.width, height: rect.height });
    return {
      x: rect.destLeft,
      y: rect.destTop,
      width: rect.width,
      height: rect.height,
      // In TS_BITMAP_DATA sind Bitmaps von unten nach oben gemeint.
      rgba: flipRgbaVertical(rgba, rect.width, rect.height),
    };
  }

  const pixels = rect.compressed
    ? interleavedDecompress(rect.data, rect.width, rect.height, bytes)
    : flipVertical(rect.data, rect.width, rect.height, bytes);

  return {
    x: rect.destLeft,
    y: rect.destTop,
    width: rect.width,
    height: rect.height,
    rgba: toRgba(pixels, rect.width * rect.height, bpp, palette),
  };
}

export interface PointerImage {
  cacheIndex: number;
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
  /** RGBA8888 mit Transparenz aus der AND-Maske. */
  rgba: Uint8ClampedArray;
}

/** Zeilenlaenge inklusive Ausrichtung auf 2 Byte, wie es die Zeigerformate vorschreiben. */
function strideOf(width: number, bits: number): number {
  const bytes = Math.ceil((width * bits) / 8);
  return bytes + (bytes % 2);
}

/**
 * Color Pointer Update (2.2.9.1.1.4.4) bzw. New Pointer Update (2.2.9.1.1.4.5).
 * Die Masken liegen von unten nach oben vor und werden hier direkt gedreht.
 */
export function parsePointerImage(r: BinaryReader, xorBpp: number): PointerImage {
  const cacheIndex = r.uint16le();
  const hotspotX = r.uint16le();
  const hotspotY = r.uint16le();
  const width = r.uint16le();
  const height = r.uint16le();
  const lengthAndMask = r.uint16le();
  const lengthXorMask = r.uint16le();
  const xorMask = r.bytes(Math.min(lengthXorMask, r.remaining));
  const andMask = r.bytes(Math.min(lengthAndMask, r.remaining));

  if (width > 384 || height > 384) {
    throw new RdpProtocolError(`Zeiger mit unplausibler Groesse ${width}x${height}`);
  }

  const xorStride = strideOf(width, xorBpp);
  const andStride = strideOf(width, 1);
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y; // Masken sind von unten nach oben gespeichert
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r8 = 0, g8 = 0, b8 = 0, a8 = 255;

      switch (xorBpp) {
        case 1: {
          const byte = xorMask[srcRow * xorStride + (x >> 3)] ?? 0;
          const bit = (byte >> (7 - (x & 7))) & 1;
          r8 = g8 = b8 = bit ? 255 : 0;
          break;
        }
        case 16: {
          const off = srcRow * xorStride + x * 2;
          const p = (xorMask[off] ?? 0) | ((xorMask[off + 1] ?? 0) << 8);
          const rr = (p >> 11) & 0x1f, gg = (p >> 5) & 0x3f, bb = p & 0x1f;
          r8 = (rr << 3) | (rr >> 2);
          g8 = (gg << 2) | (gg >> 4);
          b8 = (bb << 3) | (bb >> 2);
          break;
        }
        case 32: {
          const off = srcRow * xorStride + x * 4;
          b8 = xorMask[off] ?? 0;
          g8 = xorMask[off + 1] ?? 0;
          r8 = xorMask[off + 2] ?? 0;
          a8 = xorMask[off + 3] ?? 255;
          break;
        }
        default: {
          // 24bpp ist das uebliche Format fuer Color Pointer.
          const off = srcRow * xorStride + x * 3;
          b8 = xorMask[off] ?? 0;
          g8 = xorMask[off + 1] ?? 0;
          r8 = xorMask[off + 2] ?? 0;
        }
      }

      // AND-Maske: gesetztes Bit bedeutet "Bildschirminhalt durchscheinen lassen".
      if (andMask.length > 0 && xorBpp !== 32) {
        const byte = andMask[srcRow * andStride + (x >> 3)] ?? 0;
        const transparent = (byte >> (7 - (x & 7))) & 1;
        if (transparent) {
          // AND=1 mit XOR=0 ist transparent, mit XOR!=0 waere es eine Invertierung
          // des Hintergrunds - das wird hier als deckend genaehert.
          a8 = r8 === 0 && g8 === 0 && b8 === 0 ? 0 : 255;
        }
      }

      rgba[o] = r8;
      rgba[o + 1] = g8;
      rgba[o + 2] = b8;
      rgba[o + 3] = a8;
    }
  }

  return { cacheIndex, hotspotX, hotspotY, width, height, rgba };
}

export interface PaletteUpdate {
  /** 256 * 3 Byte RGB. */
  entries: Buffer;
}

export function parsePaletteUpdate(r: BinaryReader): PaletteUpdate {
  r.uint16le(); // pad
  const count = r.uint32le();
  const entries = Buffer.alloc(768);
  for (let i = 0; i < Math.min(count, 256); i++) {
    entries[i * 3] = r.uint8();
    entries[i * 3 + 1] = r.uint8();
    entries[i * 3 + 2] = r.uint8();
  }
  return { entries };
}

/** Befehlsarten im Surface-Commands-Update (MS-RDPBCGR 2.2.9.2). */
export const CMDTYPE_SET_SURFACE_BITS = 0x0001;
export const CMDTYPE_FRAME_MARKER = 0x0004;
export const CMDTYPE_STREAM_SURFACE_BITS = 0x0006;

/** codecID 0 bedeutet unkomprimierte Pixel. */
export const RDP_CODEC_ID_NONE = 0;
/** Planarer Codec RDP 6.0 (MS-RDPEGDI 3.1.9.2). */
export const RDP_CODEC_ID_PLANAR = 0x0a;

/** Im Kopf der erweiterten Bitmapdaten: optionaler 24-Byte-Zusatzkopf. */
const EX_COMPRESSED_BITMAP_HEADER_PRESENT = 0x01;

export interface SurfaceBits {
  destLeft: number;
  destTop: number;
  destRight: number;
  destBottom: number;
  bitsPerPixel: number;
  codecId: number;
  width: number;
  height: number;
  data: Buffer;
}

/**
 * Zerlegt ein Surface-Commands-Update. Frame-Marker werden uebersprungen - sie
 * klammern nur zusammengehoerende Befehle und muessen nur bestaetigt werden,
 * wenn der Client Frame Acknowledge anbietet (tut er nicht).
 */
export function parseSurfaceCommands(r: BinaryReader): SurfaceBits[] {
  const out: SurfaceBits[] = [];
  while (r.remaining >= 2) {
    const cmdType = r.uint16le();
    if (cmdType === CMDTYPE_FRAME_MARKER) {
      if (r.remaining < 6) break;
      r.uint16le(); // frameAction
      r.uint32le(); // frameId
      continue;
    }
    if (cmdType !== CMDTYPE_SET_SURFACE_BITS && cmdType !== CMDTYPE_STREAM_SURFACE_BITS) {
      // Unbekannter Befehl: der Rest des Updates ist nicht mehr zuverlaessig zu deuten.
      break;
    }
    if (r.remaining < 20) break;

    const destLeft = r.uint16le();
    const destTop = r.uint16le();
    const destRight = r.uint16le();
    const destBottom = r.uint16le();

    // EXTENDED_BITMAP_DATA (2.2.9.2.1.1)
    const bitsPerPixel = r.uint8();
    const flags = r.uint8();
    r.uint8(); // reserved
    const codecId = r.uint8();
    const width = r.uint16le();
    const height = r.uint16le();
    const dataLength = r.uint32le();
    if (flags & EX_COMPRESSED_BITMAP_HEADER_PRESENT) r.skip(Math.min(24, r.remaining));

    out.push({
      destLeft,
      destTop,
      destRight,
      destBottom,
      bitsPerPixel,
      codecId,
      width,
      height,
      data: r.bytes(Math.min(dataLength, r.remaining)),
    });
  }
  return out;
}

/**
 * Wandelt Surface Bits in ein zeichenbares Rechteck. Unkomprimierte Surface
 * Bits liegen - wie klassische Bitmaps - von unten nach oben vor.
 */
export function decodeSurfaceBits(bits: SurfaceBits): DecodedBitmap {
  if (bits.codecId === RDP_CODEC_ID_PLANAR) {
    return {
      x: bits.destLeft,
      y: bits.destTop,
      width: bits.width,
      height: bits.height,
      rgba: planarDecompress(bits.data, { width: bits.width, height: bits.height }),
    };
  }
  if (bits.codecId !== RDP_CODEC_ID_NONE) {
    throw new RdpProtocolError(
      `Surface Bits mit Codec ${bits.codecId} werden nicht unterstuetzt - ` +
        'der Client bietet keine Bitmap-Codecs an, der Server haette codecID 0 verwenden muessen.',
    );
  }
  const bpp = bits.bitsPerPixel as SourceFormat;
  const pixels = flipVertical(bits.data, bits.width, bits.height, bytesPerPixel(bpp));
  return {
    x: bits.destLeft,
    y: bits.destTop,
    width: bits.width,
    height: bits.height,
    rgba: toRgba(pixels, bits.width * bits.height, bpp),
  };
}

/** Dreht fertige RGBA-Zeilen um - fuer Container, die von unten nach oben zaehlen. */
function flipRgbaVertical(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const stride = width * 4;
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    out.set(rgba.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  }
  return out;
}
