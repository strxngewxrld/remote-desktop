/**
 * Umwandlung der RDP-Pixelformate nach RGBA8888 (das Format eines
 * Canvas-ImageData).
 */

export type SourceFormat = 8 | 15 | 16 | 24 | 32;

/**
 * @param src Rohpixel im Serverformat, zeilenweise von oben nach unten
 * @param bitsPerPixel Format der Quelldaten
 * @param palette optionale 256-Eintraege-Palette (nur fuer 8bpp), je 3 Byte RGB
 */
export function toRgba(
  src: Buffer,
  pixelCount: number,
  bitsPerPixel: SourceFormat,
  palette?: Buffer,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixelCount * 4);
  let o = 0;

  switch (bitsPerPixel) {
    case 8: {
      for (let i = 0; i < pixelCount; i++) {
        const idx = src[i];
        if (palette && palette.length >= (idx + 1) * 3) {
          out[o++] = palette[idx * 3];
          out[o++] = palette[idx * 3 + 1];
          out[o++] = palette[idx * 3 + 2];
        } else {
          // Ohne Palette: Graustufen, damit wenigstens etwas Sinnvolles erscheint.
          out[o++] = idx;
          out[o++] = idx;
          out[o++] = idx;
        }
        out[o++] = 255;
      }
      break;
    }

    case 15: {
      for (let i = 0; i < pixelCount; i++) {
        const p = src[i * 2] | (src[i * 2 + 1] << 8);
        const r = (p >> 10) & 0x1f;
        const g = (p >> 5) & 0x1f;
        const b = p & 0x1f;
        // 5 Bit auf 8 Bit strecken: obere Bits nach unten kopieren statt zu skalieren.
        out[o++] = (r << 3) | (r >> 2);
        out[o++] = (g << 3) | (g >> 2);
        out[o++] = (b << 3) | (b >> 2);
        out[o++] = 255;
      }
      break;
    }

    case 16: {
      for (let i = 0; i < pixelCount; i++) {
        const p = src[i * 2] | (src[i * 2 + 1] << 8);
        const r = (p >> 11) & 0x1f;
        const g = (p >> 5) & 0x3f;
        const b = p & 0x1f;
        out[o++] = (r << 3) | (r >> 2);
        out[o++] = (g << 2) | (g >> 4);
        out[o++] = (b << 3) | (b >> 2);
        out[o++] = 255;
      }
      break;
    }

    case 24: {
      for (let i = 0; i < pixelCount; i++) {
        out[o++] = src[i * 3 + 2];
        out[o++] = src[i * 3 + 1];
        out[o++] = src[i * 3];
        out[o++] = 255;
      }
      break;
    }

    case 32: {
      for (let i = 0; i < pixelCount; i++) {
        out[o++] = src[i * 4 + 2];
        out[o++] = src[i * 4 + 1];
        out[o++] = src[i * 4];
        out[o++] = 255; // Alpha des Servers ist bei RDP bedeutungslos
      }
      break;
    }
  }

  return out;
}

export function bytesPerPixel(bitsPerPixel: SourceFormat): number {
  return bitsPerPixel === 8 ? 1 : bitsPerPixel === 15 || bitsPerPixel === 16 ? 2 : bitsPerPixel === 24 ? 3 : 4;
}

/** Dreht die Zeilenreihenfolge um - unkomprimierte RDP-Bitmaps kommen von unten nach oben. */
export function flipVertical(src: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    src.copy(out, y * stride, (height - 1 - y) * stride, (height - y) * stride);
  }
  return out;
}
