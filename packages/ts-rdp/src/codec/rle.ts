/**
 * Interleaved-RLE-Dekomprimierung (MS-RDPEGDI 3.1.9).
 *
 * Das Verfahren arbeitet zeilenweise gegen die jeweils darueberliegende Zeile:
 * die meisten Laufarten kopieren oder XOR-verknuepfen Pixel der Vorgaengerzeile.
 * Deshalb ist die erste Zeile ein Sonderfall (`firstLine`) - dort existiert
 * keine Bezugszeile und es wird gegen Schwarz gearbeitet.
 *
 * Die Ausgabe ist zeilenweise von oben nach unten.
 */

// Regulaere Codes belegen die oberen 3 Bit, Lite-Codes 4 Bit, Mega-Codes das ganze Byte.
const REGULAR_BG_RUN = 0x0;
const REGULAR_FG_RUN = 0x1;
const REGULAR_FGBG_IMAGE = 0x2;
const REGULAR_COLOR_RUN = 0x3;
const REGULAR_COLOR_IMAGE = 0x4;
const LITE_SET_FG_FG_RUN = 0xc;
const LITE_SET_FG_FGBG_IMAGE = 0xd;
const LITE_DITHERED_RUN = 0xe;
const MEGA_MEGA_BG_RUN = 0xf0;
const MEGA_MEGA_FG_RUN = 0xf1;
const MEGA_MEGA_FGBG_IMAGE = 0xf2;
const MEGA_MEGA_COLOR_RUN = 0xf3;
const MEGA_MEGA_COLOR_IMAGE = 0xf4;
const MEGA_MEGA_SET_FG_RUN = 0xf6;
const MEGA_MEGA_SET_FGBG_IMAGE = 0xf7;
const MEGA_MEGA_DITHERED_RUN = 0xf8;
const SPECIAL_FGBG_1 = 0xf9;
const SPECIAL_FGBG_2 = 0xfa;
const SPECIAL_WHITE = 0xfd;
const SPECIAL_BLACK = 0xfe;

const MASK_SPECIAL_FGBG_1 = 0x03;
const MASK_SPECIAL_FGBG_2 = 0x05;

function extractCodeId(header: number): number {
  if ((header & 0xc0) !== 0xc0) return header >> 5; // REGULAR
  if ((header & 0xf0) === 0xf0) return header; // MEGA_MEGA oder SPECIAL
  return header >> 4; // LITE
}

function whitePixel(bpp: number): number {
  return bpp === 1 ? 0xff : bpp === 2 ? 0xffff : 0xffffff;
}

export class RleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RleError';
  }
}

/**
 * Dekomprimiert einen Interleaved-RLE-Strom.
 *
 * @param src komprimierte Daten
 * @param width Breite in Pixeln
 * @param height Hoehe in Pixeln
 * @param bpp Bytes pro Pixel (1 = 8bpp, 2 = 15/16bpp, 3 = 24bpp)
 */
export function interleavedDecompress(src: Buffer, width: number, height: number, bpp: number): Buffer {
  if (bpp !== 1 && bpp !== 2 && bpp !== 3) {
    throw new RleError(
      `Interleaved RLE ist nur fuer 8 bis 24 bpp definiert, hier sind es ${bpp * 8} bpp. ` +
        'Bei 32 bpp ist der planare Codec zustaendig - siehe codec/planar.ts.',
    );
  }
  const rowDelta = width * bpp;
  const dst = Buffer.alloc(rowDelta * height);
  const white = whitePixel(bpp);

  let pos = 0; // Leseposition in src
  let out = 0; // Schreibposition in dst
  let firstLine = true;
  let insertFgPel = false;
  let fgPel = white;

  const readSrcPixel = (): number => {
    if (pos + bpp > src.length) throw new RleError('RLE: Lesen ueber das Ende der komprimierten Daten hinaus');
    let v = src[pos];
    if (bpp >= 2) v |= src[pos + 1] << 8;
    if (bpp === 3) v |= src[pos + 2] << 16;
    pos += bpp;
    return v;
  };

  const writePixel = (v: number): void => {
    if (out + bpp > dst.length) throw new RleError('RLE: dekomprimierte Daten sind groesser als die Bitmap');
    dst[out] = v & 0xff;
    if (bpp >= 2) dst[out + 1] = (v >> 8) & 0xff;
    if (bpp === 3) dst[out + 2] = (v >> 16) & 0xff;
    out += bpp;
  };

  const readAbove = (): number => {
    const p = out - rowDelta;
    if (p < 0) return 0;
    let v = dst[p];
    if (bpp >= 2) v |= dst[p + 1] << 8;
    if (bpp === 3) v |= dst[p + 2] << 16;
    return v;
  };

  /** Laenge eines Laufs; liefert zugleich, um wie viele Bytes der Header ruecken muss. */
  const extractRunLength = (code: number): number => {
    const header = src[pos];
    switch (code) {
      case REGULAR_FGBG_IMAGE: {
        const n = header & 0x1f;
        if (n === 0) {
          const len = src[pos + 1] + 1;
          pos += 2;
          return len;
        }
        pos += 1;
        return n * 8;
      }
      case LITE_SET_FG_FGBG_IMAGE: {
        const n = header & 0x0f;
        if (n === 0) {
          const len = src[pos + 1] + 1;
          pos += 2;
          return len;
        }
        pos += 1;
        return n * 8;
      }
      case REGULAR_BG_RUN:
      case REGULAR_FG_RUN:
      case REGULAR_COLOR_RUN:
      case REGULAR_COLOR_IMAGE: {
        const n = header & 0x1f;
        if (n === 0) {
          const len = src[pos + 1] + 32;
          pos += 2;
          return len;
        }
        pos += 1;
        return n;
      }
      case LITE_SET_FG_FG_RUN:
      case LITE_DITHERED_RUN: {
        const n = header & 0x0f;
        if (n === 0) {
          const len = src[pos + 1] + 16;
          pos += 2;
          return len;
        }
        pos += 1;
        return n;
      }
      default: {
        // MEGA_MEGA_*: 16-Bit-Laenge hinter dem Headerbyte.
        const len = src[pos + 1] | (src[pos + 2] << 8);
        pos += 3;
        return len;
      }
    }
  };

  const writeFgBgImage = (bitmask: number, bits: number): void => {
    for (let i = 0; i < bits; i++) {
      const above = readAbove();
      writePixel(bitmask & (1 << i) ? above ^ fgPel : above);
    }
  };

  const writeFirstLineFgBgImage = (bitmask: number, bits: number): void => {
    for (let i = 0; i < bits; i++) {
      writePixel(bitmask & (1 << i) ? fgPel : 0);
    }
  };

  while (pos < src.length) {
    // Sobald die erste Zeile voll ist, steht ab jetzt eine Bezugszeile zur Verfuegung.
    if (firstLine && out >= rowDelta) {
      firstLine = false;
      insertFgPel = false;
    }

    const code = extractCodeId(src[pos]);

    if (code === REGULAR_BG_RUN || code === MEGA_MEGA_BG_RUN) {
      let runLength = extractRunLength(code);
      if (firstLine) {
        if (insertFgPel) {
          writePixel(fgPel);
          runLength--;
        }
        while (runLength-- > 0) writePixel(0);
      } else {
        if (insertFgPel) {
          writePixel(readAbove() ^ fgPel);
          runLength--;
        }
        while (runLength-- > 0) writePixel(readAbove());
      }
      // Ein direkt folgender Hintergrundlauf beginnt mit einem Vordergrundpixel.
      insertFgPel = true;
      continue;
    }

    insertFgPel = false;

    switch (code) {
      case REGULAR_FG_RUN:
      case MEGA_MEGA_FG_RUN:
      case LITE_SET_FG_FG_RUN:
      case MEGA_MEGA_SET_FG_RUN: {
        let runLength = extractRunLength(code);
        if (code === LITE_SET_FG_FG_RUN || code === MEGA_MEGA_SET_FG_RUN) fgPel = readSrcPixel();
        if (firstLine) {
          while (runLength-- > 0) writePixel(fgPel);
        } else {
          while (runLength-- > 0) writePixel(readAbove() ^ fgPel);
        }
        break;
      }

      case LITE_DITHERED_RUN:
      case MEGA_MEGA_DITHERED_RUN: {
        let runLength = extractRunLength(code);
        const a = readSrcPixel();
        const b = readSrcPixel();
        while (runLength-- > 0) {
          writePixel(a);
          writePixel(b);
        }
        break;
      }

      case REGULAR_COLOR_RUN:
      case MEGA_MEGA_COLOR_RUN: {
        let runLength = extractRunLength(code);
        const color = readSrcPixel();
        while (runLength-- > 0) writePixel(color);
        break;
      }

      case REGULAR_FGBG_IMAGE:
      case MEGA_MEGA_FGBG_IMAGE:
      case LITE_SET_FG_FGBG_IMAGE:
      case MEGA_MEGA_SET_FGBG_IMAGE: {
        let runLength = extractRunLength(code);
        if (code === LITE_SET_FG_FGBG_IMAGE || code === MEGA_MEGA_SET_FGBG_IMAGE) fgPel = readSrcPixel();
        const write = firstLine ? writeFirstLineFgBgImage : writeFgBgImage;
        while (runLength > 8) {
          write(src[pos++], 8);
          runLength -= 8;
        }
        if (runLength > 0) write(src[pos++], runLength);
        break;
      }

      case REGULAR_COLOR_IMAGE:
      case MEGA_MEGA_COLOR_IMAGE: {
        let runLength = extractRunLength(code);
        while (runLength-- > 0) writePixel(readSrcPixel());
        break;
      }

      case SPECIAL_FGBG_1:
        pos++;
        if (firstLine) writeFirstLineFgBgImage(MASK_SPECIAL_FGBG_1, 8);
        else writeFgBgImage(MASK_SPECIAL_FGBG_1, 8);
        break;

      case SPECIAL_FGBG_2:
        pos++;
        if (firstLine) writeFirstLineFgBgImage(MASK_SPECIAL_FGBG_2, 8);
        else writeFgBgImage(MASK_SPECIAL_FGBG_2, 8);
        break;

      case SPECIAL_WHITE:
        pos++;
        writePixel(white);
        break;

      case SPECIAL_BLACK:
        pos++;
        writePixel(0);
        break;

      default:
        throw new RleError(`RLE: unbekannter Order-Code 0x${code.toString(16)} bei Offset ${pos}`);
    }
  }

  return dst;
}
