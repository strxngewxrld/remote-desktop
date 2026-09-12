/**
 * Planarer Bitmapcodec (RDP 6.0/6.1) - MS-RDPEGDI 2.2.2.5.1 und 3.1.9.
 *
 * Statt das Bild als Block zu komprimieren, zerlegt der Codec es in einzelne
 * 8-Bit-Farbebenen (Alpha, Rot, Gruen, Blau bzw. Alpha, Luma, Orange-, Gruen-
 * Chroma) und komprimiert jede Ebene fuer sich. Genau daher stammen die drei
 * Stolpersteine, die man einzeln in der Spezifikation nachlesen muss:
 *
 *  - Die Reihenfolge der Ebenen im Strom ist fest: Alpha (nur wenn NA = 0),
 *    dann Luma/Rot, Orange-Chroma/Gruen, Gruen-Chroma/Blau (2.2.2.5.1).
 *  - Deltakodierung gibt es nur in RLE-Ebenen, nicht in rohen Ebenen. Die erste
 *    Zeile traegt Absolutwerte, jede weitere Differenzen zur Zeile darueber -
 *    und zwar in einer eigenen Vorzeichenkodierung (siehe decodeDelta).
 *  - Ein RUN wiederholt den zuletzt gelesenen RAW-Wert *der laufenden Zeile*,
 *    nicht den des laufenden Segments. Vor dem ersten RAW-Wert einer Zeile gilt
 *    der Wert 0 (3.1.9.2: "the RAW value used to decode the RUN component is
 *    assumed to be the value zero"). Am Zeilenanfang wird er deshalb
 *    zurueckgesetzt; wuerde er ueber die Zeile hinaus gelten, waere das
 *    Beispiel in 3.1.9.2.1 ("RAW [<none>]; RUN [6]" = Zeile unveraendert
 *    uebernehmen) nicht erklaerbar.
 *
 * Zeilenreihenfolge: MS-RDPEGDI legt fuer den Strom selbst keine Richtung fest,
 * die bestimmt der Container. In der Graphics Pipeline - dem Einsatzort hier -
 * ist sie von oben nach unten (MS-RDPEGFX 2.2.2.1, RDPGFX_CODECID_UNCOMPRESSED:
 * "Pixels ... are ordered from left to right and then top to bottom"; der
 * planare Codec sitzt im selben Feld). Die Ebenen werden hier also in
 * Stromreihenfolge als Zeile 0..h-1 gelesen und genau so ausgegeben. Steckt der
 * Strom dagegen in einer klassischen TS_BITMAP_DATA (MS-RDPBCGR
 * 2.2.9.1.1.3.1.2.2), ist die Bitmap wie dort ueblich von unten nach oben
 * gemeint - der Aufrufer muss die Ausgabe dann spiegeln (flipVertical).
 */

/** FormatHeader (MS-RDPEGDI 2.2.2.5.1): CLL in Bit 0-2, CS, RLE, NA darueber. */
const HEADER_CLL_MASK = 0x07;
const HEADER_CS = 0x08;
const HEADER_RLE = 0x10;
const HEADER_NA = 0x20;

/**
 * Obergrenzen fuer die Zielgroesse. Breite und Hoehe stammen aus Feldern eines
 * entfernten Servers, deshalb wird hier hart begrenzt, statt darauf zu hoffen,
 * dass die Speicheranforderung schon schiefgehen wird.
 */
const MAX_DIMENSION = 0x8000;
const MAX_PIXELS = 1 << 24;

export class PlanarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanarError';
  }
}

export interface PlanarOptions {
  /** Zielbreite und -hoehe in Pixeln. */
  width: number;
  height: number;
}

/**
 * Macht aus dem Deltacode der Spezifikation (3.1.9.2.1) wieder eine Differenz.
 *
 * Der Kodierer nimmt das Deltabyte als Zweierkomplement: nicht negative Werte
 * werden nur um ein Bit nach links geschoben, negative werden negiert,
 * geschoben und um eins verringert. Das unterste Bit traegt also das
 * Vorzeichen. Rueckwaerts: ungerade heisst negativ.
 */
function decodeDelta(code: number): number {
  return code & 1 ? -((code + 1) >> 1) : code >> 1;
}

/**
 * Liest eine RLE-kodierte Ebene (2.2.2.5.1.1/2.2.2.5.1.2).
 *
 * @returns Leseposition hinter der Ebene
 */
function readRlePlane(src: Buffer, start: number, plane: Uint8Array, width: number, height: number): number {
  let pos = start;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    // Der zuletzt gelesene RAW-Wert der Zeile; vor dem ersten RAW-Wert 0.
    // In Zeile 0 ist das ein Absolutwert, sonst eine Differenz.
    let last = 0;
    let x = 0;

    while (x < width) {
      if (pos >= src.length) {
        throw new PlanarError(`Planar: Strom endet mitten in Zeile ${y} einer RLE-Ebene`);
      }
      const controlByte = src[pos++];
      // Ein Nullbyte ist laut 2.2.2.5.1.2 verboten - und wuerde als Segment
      // ohne RAW und ohne RUN die Schleife nicht voranbringen.
      if (controlByte === 0) {
        throw new PlanarError(`Planar: controlByte 0 bei Offset ${pos - 1} - Segment ohne Inhalt`);
      }

      let runLength = controlByte & 0x0f;
      let rawBytes = (controlByte >> 4) & 0x0f;
      // nRunLength 1 und 2 sind keine Laufweiten, sondern Praefixe fuer lange
      // Laeufe; die RAW-Anzahl wird dann als Erweiterung der Laenge gelesen.
      if (runLength === 1) {
        runLength = 16 + rawBytes;
        rawBytes = 0;
      } else if (runLength === 2) {
        runLength = 32 + rawBytes;
        rawBytes = 0;
      }

      if (rawBytes + runLength > width - x) {
        throw new PlanarError(
          `Planar: Segment mit ${rawBytes} RAW-Bytes und Lauflaenge ${runLength} ` +
            `passt nicht mehr in Zeile ${y} (Spalte ${x} von ${width})`,
        );
      }
      if (pos + rawBytes > src.length) {
        throw new PlanarError(`Planar: ${rawBytes} RAW-Bytes angekuendigt, aber nur ${src.length - pos} vorhanden`);
      }

      if (y === 0) {
        for (let i = 0; i < rawBytes; i++) {
          last = src[pos++];
          plane[row + x++] = last;
        }
        for (let i = 0; i < runLength; i++) plane[row + x++] = last;
      } else {
        for (let i = 0; i < rawBytes; i++) {
          last = decodeDelta(src[pos++]);
          plane[row + x] = (plane[row + x - width] + last) & 0xff;
          x++;
        }
        // Der Lauf wiederholt die Differenz, nicht den Pixelwert - jede Spalte
        // rechnet gegen ihren eigenen Vorgaenger in der Zeile darueber.
        for (let i = 0; i < runLength; i++) {
          plane[row + x] = (plane[row + x - width] + last) & 0xff;
          x++;
        }
      }
    }
  }

  return pos;
}

/**
 * Rechnet einen Chromawert der Ebene in den Bereich von 3.1.9.1.2 zurueck.
 *
 * Das Ebenenbyte ist ein vorzeichenbehafteter 8-Bit-Wert. Die Farbverlust-
 * reduktion (3.1.9.1.4) hat ihn um CLL Bit nach rechts geschoben; rueckwaerts
 * wird um CLL Bit nach links geschoben, ohne erneut auf 8 Bit zu beschneiden -
 * Co und Cg sind laut 3.1.9.1.2 neun Bit breit (-255 bis 255).
 */
function chroma(value: number, cll: number): number {
  return ((value << 24) >> 24) << cll;
}

/**
 * Dekodiert einen RDP6-planaren Bitmapstrom.
 * Rueckgabe: RGBA8888, zeilenweise von oben nach unten, Laenge width*height*4.
 */
export function planarDecompress(src: Buffer, options: PlanarOptions): Uint8ClampedArray {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PlanarError(`Planar: ungueltige Zielgroesse ${width}x${height}`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new PlanarError(`Planar: Zielgroesse ${width}x${height} ist unplausibel gross`);
  }
  if (src.length < 1) {
    throw new PlanarError('Planar: der Strom enthaelt nicht einmal den FormatHeader');
  }

  const formatHeader = src[0];
  const cll = formatHeader & HEADER_CLL_MASK;
  const subsampled = (formatHeader & HEADER_CS) !== 0;
  const rle = (formatHeader & HEADER_RLE) !== 0;
  const noAlpha = (formatHeader & HEADER_NA) !== 0;

  // 2.2.2.5.1: Chroma-Subsampling gibt es nur im AYCoCg-Raum, also nur mit CLL > 0.
  if (subsampled && cll === 0) {
    throw new PlanarError(
      'Planar: FormatHeader verlangt Chroma-Subsampling bei CLL = 0. ' +
        'Subsampling ist laut MS-RDPEGDI 2.2.2.5.1 nur im AYCoCg-Farbraum erlaubt - der Strom ist defekt.',
    );
  }

  const pixels = width * height;
  // Im AYCoCg-Raum liegen die beiden Chromaebenen bei CS = 1 nur in halber
  // Aufloesung vor (3.1.9.1.3); ungerade Kanten werden aufgerundet.
  const chromaWidth = subsampled ? (width + 1) >> 1 : width;
  const chromaHeight = subsampled ? (height + 1) >> 1 : height;

  let pos = 1;
  const readPlane = (w: number, h: number): Uint8Array => {
    const plane = new Uint8Array(w * h);
    if (rle) {
      pos = readRlePlane(src, pos, plane, w, h);
    } else {
      const size = w * h;
      if (pos + size > src.length) {
        throw new PlanarError(
          `Planar: rohe Ebene braucht ${size} Byte, im Strom stehen ab Offset ${pos} aber nur ${src.length - pos}`,
        );
      }
      plane.set(src.subarray(pos, pos + size));
      pos += size;
    }
    return plane;
  };

  // Reihenfolge laut 2.2.2.5.1; die Alphaebene fehlt genau dann, wenn NA gesetzt ist.
  const alpha = noAlpha ? null : readPlane(width, height);
  const lumaOrRed = readPlane(width, height);
  const orangeOrGreen = readPlane(chromaWidth, chromaHeight);
  const greenOrBlue = readPlane(chromaWidth, chromaHeight);

  const out = new Uint8ClampedArray(pixels * 4);

  for (let y = 0; y < height; y++) {
    // Supersampling ist reine Pixelverdopplung: ein Chromawert deckt ein
    // 2x2-Feld ab, an ungeraden Raendern entsprechend weniger (3.1.9.1.3).
    const chromaRow = (subsampled ? y >> 1 : y) * chromaWidth;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = chromaRow + (subsampled ? x >> 1 : x);
      let o = i * 4;

      if (cll === 0) {
        // ARGB/RGB: die Ebenen sind direkt Rot, Gruen und Blau.
        out[o++] = lumaOrRed[i];
        out[o++] = orangeOrGreen[i];
        out[o++] = greenOrBlue[i];
      } else {
        // Inverse Transformation aus 3.1.9.1.2:
        //   R = Y + Co/2 - Cg/2, G = Y + Cg/2, B = Y - Co/2 - Cg/2.
        // Hier in der ueblichen Lifting-Form, die ohne Rundungsfehler die
        // Hintransformation umkehrt.
        const luma = lumaOrRed[i];
        const co = chroma(orangeOrGreen[c], cll);
        const cg = chroma(greenOrBlue[c], cll);
        const t = luma - (cg >> 1);
        const g = cg + t;
        const b = t - (co >> 1);
        const r = co + b;
        // 3.1.9.1.1: Microsoft-Server berechnen Co mit vertauschtem R und B.
        // Die Spezifikation schreibt dem Client deshalb vor, R und B nach der
        // Ruecktransformation zu tauschen.
        out[o++] = b;
        out[o++] = g;
        out[o++] = r;
      }
      // Uint8ClampedArray erledigt das in 3.1.9.1.2 geforderte Begrenzen auf 0..255.

      // NA = 1 heisst: keine Alphaebene, alle Pixel voll deckend (2.2.2.5.1).
      out[o] = alpha ? alpha[i] : 0xff;
    }
  }

  return out;
}
