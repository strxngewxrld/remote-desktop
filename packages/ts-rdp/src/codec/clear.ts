/**
 * ClearCodec (MS-RDPEGFX 2.2.4.1 und 3.3.8.1) - RDPGFX_CODECID_CLEARCODEC 0x0008.
 *
 * Der Codec ist kein Blockcodec, sondern legt bis zu drei voneinander
 * unabhaengige Schichten uebereinander (3.3.8.1). Jede ist optional, jede darf
 * Pixel der darunterliegenden ueberschreiben - die Reihenfolge ist deshalb
 * bindend und nicht etwa eine Frage der Implementierung:
 *
 *   1. Residualschicht (2.2.4.1.1.1): ein RGB-Lauflaengenstrom ueber das
 *      gesamte Bild, von links nach rechts und dann von oben nach unten.
 *   2. Bandschicht (2.2.4.1.1.2): waagerechte Baender aus senkrechten
 *      Pixelspalten ("V-Bars"), "MUST be decoded on top of the first layer".
 *   3. Subcodecschicht (2.2.4.1.1.3): rechteckige Teilbilder in RAW, NSCodec
 *      oder RLEX, "MUST be decoded on top of the second layer". Alle drei
 *      Unterverfahren sind hier umgesetzt; NSCodec (MS-RDPNSC) ist entgegen
 *      der Erwartung kein Randfall, siehe drawNsCodec.
 *
 * Drei Zustandsspeicher leben ueber die einzelne Kachel hinaus und sind genau
 * der Grund, warum hier eine Klasse und keine Funktion steht:
 *
 *   - Decompressor Glyph Storage (3.3.1.9): 4000 Plaetze fuer fertig
 *     dekodierte Kleinbilder. Eine Kachel mit CLEARCODEC_FLAG_GLYPH_HIT
 *     besteht nur aus vier Byte Kopf und holt ihren gesamten Inhalt von dort.
 *   - V-Bar Storage (3.3.1.10) mit Cursor (3.3.1.11), 32768 Plaetze.
 *   - Short V-Bar Storage (3.3.1.12) mit Cursor (3.3.1.13), 16384 Plaetze.
 *
 * Auf dem Draht stehen Farben durchgaengig als B, G, R (little-endian, siehe
 * 2.2.4.1.1.1.1 und 2.2.4.1.1.3.1.1.1). Die Ausgabe ist dagegen RGBA von oben
 * nach unten - dasselbe Format wie planarDecompress in src/codec/planar.ts,
 * damit der Aufrufer beide Codecs gleich behandeln kann.
 *
 * Stolpersteine, die hier ausdruecklich aus der Spezifikation stammen und
 * nicht aus der Erinnerung:
 *   - Der V-Bar-Kopf (2.2.4.1.1.2.1.1) ist *ein* 16-Bit-Wert, dessen obere zwei
 *     Bit ueber die Struktur entscheiden - die Feldbreiten darunter sind 15,
 *     14 bzw. 8+6 Bit und damit fuer alle drei Faelle verschieden.
 *   - shortVBarYOff ist exklusiv, yEnd eines Bandes dagegen inklusiv
 *     (ausdruecklich in 4.1.1.4 angemerkt).
 *   - Ein RLEX-Segment liefert runLengthFactor *plus* (suiteDepth + 1) Pixel,
 *     nicht runLengthFactor Pixel (nachgerechnet am Beispiel in 4.1.1.2).
 */
import { RdpProtocolError } from '../core/errors.js';

// --- Flags im CLEARCODEC_BITMAP_STREAM (2.2.4.1) ----------------------------

/** glyphIndex ist vorhanden. Nur bei Bildern bis 1024 Pixel Flaeche erlaubt. */
export const CLEARCODEC_FLAG_GLYPH_INDEX = 0x01;
/** Der Glyph liegt bereits im Cache; compositePayload fehlt dann vollstaendig. */
export const CLEARCODEC_FLAG_GLYPH_HIT = 0x02;
/** Beide V-Bar-Cursor vor dem Dekodieren auf 0 setzen. */
export const CLEARCODEC_FLAG_CACHE_RESET = 0x04;

// --- Subcodec-Kennungen (2.2.4.1.1.3.1) -------------------------------------

export const CLEARCODEC_SUBCODEC_RAW = 0x00;
export const CLEARCODEC_SUBCODEC_NSCODEC = 0x01;
export const CLEARCODEC_SUBCODEC_RLEX = 0x02;

// --- Groessen der Zustandsspeicher (3.3.1.9 bis 3.3.1.13) -------------------

const GLYPH_SLOTS = 4000;
const GLYPH_MAX_AREA = 1024;
const VBAR_SLOTS = 0x8000;
const SHORT_VBAR_SLOTS = 0x4000;

/**
 * Obergrenzen fuer die Zielgroesse. 2.2.4.1 verbietet Kanten ueber 65535
 * Pixel; die Flaechengrenze ist eine zusaetzliche Bremse gegen Zahlen aus dem
 * Netz, die eine absurde Speicheranforderung ausloesen wuerden.
 */
const MAX_DIMENSION = 0xffff;
const MAX_PIXELS = 1 << 24;

/** Groesse eines Bildes in Pixeln. */
export interface ClearSize {
  width: number;
  height: number;
}

/** Ein Eintrag im V-Bar- oder Short-V-Bar-Speicher: BGR-Tripel, von oben nach unten. */
type BgrColumn = Uint8Array;

/**
 * Liest ein ganzes Bild als Folge von Bytes mit expliziter Grenzpruefung.
 *
 * Ein eigener kleiner Leser statt BinaryReader, weil jede Grenzverletzung hier
 * ein RdpProtocolError mit einer Aussage darueber sein soll, *welches* Feld
 * nicht mehr in den Puffer passte - ein RangeError aus dem Buffer sagt das nicht.
 */
class ClearReader {
  private pos: number;

  constructor(private readonly buf: Buffer, start = 0, private readonly end = buf.length) {
    this.pos = start;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number, was: string): number {
    if (this.pos + n > this.end) {
      throw new RdpProtocolError(
        `ClearCodec: ${was} braucht ${n} Byte, ab Offset ${this.pos} stehen aber nur noch ${this.end - this.pos} bereit`,
      );
    }
    const start = this.pos;
    this.pos += n;
    return start;
  }

  u8(was: string): number {
    return this.buf[this.need(1, was)];
  }

  u16(was: string): number {
    return this.buf.readUInt16LE(this.need(2, was));
  }

  u32(was: string): number {
    return this.buf.readUInt32LE(this.need(4, was));
  }

  bytes(n: number, was: string): Buffer {
    const start = this.need(n, was);
    return this.buf.subarray(start, start + n);
  }
}

/**
 * Liest einen Lauflaengenwert nach dem Schema runLengthFactor1/2/3.
 *
 * Dasselbe dreistufige Schema benutzen CLEARCODEC_RGB_RUN_SEGMENT
 * (2.2.4.1.1.1.1) und CLEARCODEC_SUBCODEC_RLEX_SEGMENT (2.2.4.1.1.3.1.1.2):
 * 0xFF im ersten Byte verweist auf ein 16-Bit-Feld, 0xFFFF darin auf ein
 * 32-Bit-Feld. Der Unterschied zwischen beiden Strukturen liegt nur darin, ob
 * der Wert 0 erlaubt ist - das prueft der Aufrufer.
 */
function readRunLength(r: ClearReader, was: string): number {
  const eins = r.u8(`${was} runLengthFactor1`);
  if (eins < 0xff) return eins;
  const zwei = r.u16(`${was} runLengthFactor2`);
  if (zwei < 0xffff) return zwei;
  return r.u32(`${was} runLengthFactor3`);
}

/** Aufrunden auf das naechste Vielfache einer Zweierpotenz (MS-RDPNSC 2.2.2). */
function aufrunden(wert: number, vielfaches: number): number {
  return Math.ceil(wert / vielfaches) * vielfaches;
}

/**
 * Entpackt eine NSCODEC_RLE_SEGMENTS-Ebene (MS-RDPNSC 2.2.2.1).
 *
 * Der Strom besteht aus zwei Segmentarten, die sich nur daran unterscheiden,
 * ob sich das erste Byte unmittelbar wiederholt:
 *   - NSCODEC_RLE_RUN_SEGMENT (2.2.2.2.1): RunValue, RunConfirm (= RunValue),
 *     RunLengthFactor1. Lauflaenge ist RunLengthFactor1 + 2; bei 0xFF folgt
 *     stattdessen ein 32-Bit-Feld mit der Laenge.
 *   - NSCODEC_RLE_LITERAL_SEGMENT (2.2.2.2.2): ein einzelnes Byte.
 *
 * Die *letzten vier* Byte der Ebene stehen laut 2.2.2.1 immer roh im Feld
 * EndData und sind nicht Teil der Segmente. Die Schleife laeuft deshalb nur,
 * solange mehr als vier Byte der Ausgabe fehlen - und eine Restlaenge von genau
 * fuenf kann kein Lauf mehr sein (ein Lauf ist mindestens zwei Byte lang), also
 * ist das letzte Byte davor zwingend ein Literal.
 */
function nscRleDecode(src: Buffer, out: Uint8Array, ebene: string): void {
  const gesamt = out.length;
  let ein = 0;
  let aus = 0;

  const lies = (n: number): number => {
    if (ein + n > src.length) {
      throw new RdpProtocolError(
        `ClearCodec/NSCodec: ${ebene} endet mitten in einem RLE-Segment (Offset ${ein} von ${src.length})`,
      );
    }
    const p = ein;
    ein += n;
    return p;
  };

  while (gesamt - aus > 4) {
    const wert = src[lies(1)];

    if (gesamt - aus === 5) {
      // Vor EndData bleibt genau ein Byte - das kann nur ein Literal sein.
      out[aus++] = wert;
      continue;
    }

    if (ein < src.length && src[ein] === wert) {
      // RunConfirm bestaetigt: NSCODEC_RLE_RUN_SEGMENT.
      lies(1);
      const faktor1 = src[lies(1)];
      const laenge = faktor1 < 0xff ? faktor1 + 2 : src.readUInt32LE(lies(4));
      if (laenge === 0 || aus + laenge > gesamt - 4) {
        throw new RdpProtocolError(
          `ClearCodec/NSCodec: Lauf von ${laenge} Byte in ${ebene} passt nicht in die restlichen ` +
            `${gesamt - 4 - aus} Byte vor EndData`,
        );
      }
      out.fill(wert, aus, aus + laenge);
      aus += laenge;
    } else {
      out[aus++] = wert;
    }
  }

  // EndData (2.2.2.1): die letzten vier Byte der Ebene, unkomprimiert.
  const rest = gesamt - aus;
  out.set(src.subarray(lies(rest), ein), aus);
}

/**
 * Liest eine Farbebene eines NSCodec-Stroms.
 *
 * MS-RDPNSC 2.2.2: die angekuendigte Bytezahl entscheidet ueber das Format -
 * gleich der Rohgroesse heisst unkomprimiert, kleiner heisst RLE, groesser ist
 * unzulaessig.
 */
function nscLiesEbene(r: ClearReader, byteCount: number, roh: number, ebene: string): Uint8Array {
  if (byteCount > roh) {
    throw new RdpProtocolError(
      `ClearCodec/NSCodec: ${ebene} meldet ${byteCount} Byte, die Rohebene ist aber nur ${roh} Byte gross`,
    );
  }
  const daten = r.bytes(byteCount, `NSCODEC_BITMAP_STREAM::${ebene}`);
  const ziel = new Uint8Array(roh);
  if (byteCount === roh) {
    ziel.set(daten);
  } else {
    nscRleDecode(daten, ziel, ebene);
  }
  return ziel;
}

/**
 * Anzahl Bit, mit denen stopIndex in einem RLEX-Segment kodiert ist.
 *
 * 2.2.4.1.1.3.1.1: "floor(log2(paletteCount - 1)) + 1". Das ist die Bitlaenge
 * von paletteCount - 1; fuer paletteCount = 1 waere der Logarithmus nicht
 * definiert, dort gilt 1 Bit (dann bleiben 7 Bit fuer suiteDepth).
 */
function stopIndexBits(paletteCount: number): number {
  let bits = 0;
  for (let n = paletteCount - 1; n > 0; n >>= 1) bits++;
  return Math.max(1, bits);
}

export class ClearCodecDecoder {
  /** Decompressor Glyph Storage (3.3.1.9): fertige RGBA-Bilder je Platz. */
  private readonly glyphs: (Uint8ClampedArray | null)[] = new Array(GLYPH_SLOTS).fill(null);
  /** V-Bar Storage (3.3.1.10). */
  private readonly vBars: (BgrColumn | null)[] = new Array(VBAR_SLOTS).fill(null);
  /** Short V-Bar Storage (3.3.1.12). */
  private readonly shortVBars: (BgrColumn | null)[] = new Array(SHORT_VBAR_SLOTS).fill(null);
  /** V-Bar Storage Cursor (3.3.1.11), startet laut Spezifikation bei 0. */
  private vBarCursor = 0;
  /** Short V-Bar Storage Cursor (3.3.1.13). */
  private shortVBarCursor = 0;

  /** Setzt alle drei Zustandsspeicher zurueck, etwa nach einem Sitzungsneustart. */
  reset(): void {
    this.glyphs.fill(null);
    this.vBars.fill(null);
    this.shortVBars.fill(null);
    this.vBarCursor = 0;
    this.shortVBarCursor = 0;
  }

  /**
   * Dekodiert einen CLEARCODEC_BITMAP_STREAM (2.2.4.1).
   * Rueckgabe: RGBA8888, zeilenweise von oben nach unten, Laenge width*height*4.
   */
  decode(src: Buffer, groesse: ClearSize): Uint8ClampedArray {
    const { width, height } = groesse;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RdpProtocolError(`ClearCodec: ungueltige Zielgroesse ${width}x${height}`);
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      // 2.2.4.1: "Bitmaps with widths larger than 65,535 pixels and heights
      // larger than 65,535 pixels MUST NOT be encoded using ClearCodec."
      throw new RdpProtocolError(`ClearCodec: Zielgroesse ${width}x${height} ist fuer diesen Codec nicht zulaessig`);
    }

    const r = new ClearReader(src);
    const flags = r.u8('CLEARCODEC_BITMAP_STREAM::flags');
    // seqNumber dient nur der Erkennung verlorener Nachrichten; fuer das
    // Dekodieren einer einzelnen Kachel hat es keine Bedeutung.
    r.u8('CLEARCODEC_BITMAP_STREAM::seqNumber');

    const hatGlyphIndex = (flags & CLEARCODEC_FLAG_GLYPH_INDEX) !== 0;
    const hatGlyphHit = (flags & CLEARCODEC_FLAG_GLYPH_HIT) !== 0;
    if (hatGlyphHit && !hatGlyphIndex) {
      // 2.2.4.1: "This flag MUST NOT be present if the
      // CLEARCODEC_FLAG_GLYPH_INDEX (0x01) flag is not present."
      throw new RdpProtocolError(
        'ClearCodec: CLEARCODEC_FLAG_GLYPH_HIT ohne CLEARCODEC_FLAG_GLYPH_INDEX - ohne Index ist kein Cacheplatz benannt',
      );
    }

    let glyphIndex = -1;
    if (hatGlyphIndex) {
      glyphIndex = r.u16('CLEARCODEC_BITMAP_STREAM::glyphIndex');
      if (glyphIndex >= GLYPH_SLOTS) {
        throw new RdpProtocolError(
          `ClearCodec: glyphIndex ${glyphIndex} liegt ausserhalb von 0..${GLYPH_SLOTS - 1} (MS-RDPEGFX 2.2.4.1)`,
        );
      }
      if (width * height > GLYPH_MAX_AREA) {
        throw new RdpProtocolError(
          `ClearCodec: CLEARCODEC_FLAG_GLYPH_INDEX bei ${width}x${height} - ` +
            `der Glyph-Cache nimmt laut 2.2.4.1 nur Bilder bis ${GLYPH_MAX_AREA} Pixel Flaeche auf`,
        );
      }
    }

    if (flags & CLEARCODEC_FLAG_CACHE_RESET) {
      // 2.2.4.1: nur die beiden Cursor werden zurueckgesetzt, die abgelegten
      // V-Bars selbst bleiben erhalten und bleiben ueber ihren Index erreichbar.
      this.vBarCursor = 0;
      this.shortVBarCursor = 0;
    }

    if (hatGlyphIndex && hatGlyphHit) {
      // 2.2.4.1: "In this case, the compositePayload field MUST NOT be present."
      if (r.remaining > 0) {
        throw new RdpProtocolError(
          `ClearCodec: Cache-Treffer auf Glyph ${glyphIndex}, trotzdem folgen noch ${r.remaining} Byte Nutzlast`,
        );
      }
      const glyph = this.glyphs[glyphIndex];
      if (!glyph) {
        throw new RdpProtocolError(
          `ClearCodec: Cache-Treffer auf Glyph ${glyphIndex}, dort wurde aber noch nie ein Bild abgelegt`,
        );
      }
      if (glyph.length !== width * height * 4) {
        throw new RdpProtocolError(
          `ClearCodec: Glyph ${glyphIndex} enthaelt ${glyph.length / 4} Pixel, ` +
            `die Kachel verlangt aber ${width * height} (${width}x${height})`,
        );
      }
      return glyph.slice();
    }

    const out = new Uint8ClampedArray(width * height * 4);
    // Alpha vorbelegen: der Codec uebertraegt ausschliesslich RGB-Tripel, das
    // Zielformat der Pipeline ist aber 32 bpp.
    for (let i = 3; i < out.length; i += 4) out[i] = 0xff;

    this.decodeCompositePayload(r, out, width, height);

    if (hatGlyphIndex) {
      // 4.1.1.4: "Since the glyphIndex field was present ... the Decompressor
      // Glyph Storage ADM element at position <index> is updated with the
      // decoded bitmap." Also erst dekodieren, dann ablegen.
      this.glyphs[glyphIndex] = out.slice();
    }

    return out;
  }

  /** CLEARCODEC_COMPOSITE_PAYLOAD (2.2.4.1.1): drei Laengen, dann drei Schichten. */
  private decodeCompositePayload(r: ClearReader, out: Uint8ClampedArray, width: number, height: number): void {
    const residualByteCount = r.u32('CLEARCODEC_COMPOSITE_PAYLOAD::residualByteCount');
    const bandsByteCount = r.u32('CLEARCODEC_COMPOSITE_PAYLOAD::bandsByteCount');
    const subcodecByteCount = r.u32('CLEARCODEC_COMPOSITE_PAYLOAD::subcodecByteCount');

    const summe = residualByteCount + bandsByteCount + subcodecByteCount;
    if (summe > r.remaining) {
      throw new RdpProtocolError(
        `ClearCodec: die drei Schichten beanspruchen ${summe} Byte (${residualByteCount} + ${bandsByteCount} + ` +
          `${subcodecByteCount}), im Strom stehen aber nur noch ${r.remaining}`,
      );
    }

    // Reihenfolge und Stapelung laut 3.3.8.1: Residual zuerst, Baender darauf,
    // Subcodecs zuoberst. Jede Schicht bekommt genau ihren Byteabschnitt.
    if (residualByteCount > 0) {
      this.decodeResidual(new ClearReader(r.bytes(residualByteCount, 'residualData')), out, width, height);
    }
    if (bandsByteCount > 0) {
      this.decodeBands(new ClearReader(r.bytes(bandsByteCount, 'bandsData')), out, width, height);
    }
    if (subcodecByteCount > 0) {
      this.decodeSubcodecs(new ClearReader(r.bytes(subcodecByteCount, 'subcodecData')), out, width, height);
    }
  }

  /**
   * Schicht 1 - CLEARCODEC_RESIDUAL_DATA (2.2.4.1.1.1).
   *
   * Eine Folge von CLEARCODEC_RGB_RUN_SEGMENT: Farbe, dann Wiederholungszahl.
   * Die Pixel laufen ueber das gesamte Bild "from left to right and then top to
   * bottom" und duerfen es nicht ueberfuellen, muessen es aber auch nicht
   * fuellen - der Rest bleibt den beiden anderen Schichten ueberlassen.
   */
  private decodeResidual(r: ClearReader, out: Uint8ClampedArray, width: number, height: number): void {
    const gesamt = width * height;
    let pixel = 0;

    while (!r.eof) {
      const b = r.u8('CLEARCODEC_RGB_RUN_SEGMENT::blueValue');
      const g = r.u8('CLEARCODEC_RGB_RUN_SEGMENT::greenValue');
      const rot = r.u8('CLEARCODEC_RGB_RUN_SEGMENT::redValue');
      const laenge = readRunLength(r, 'CLEARCODEC_RGB_RUN_SEGMENT');

      // 2.2.4.1.1.1.1: "The value of runLengthFactor1 MUST be greater than
      // zero." Ein Segment ohne Wirkung waere nur ein Hinweis auf einen
      // kaputten Strom.
      if (laenge === 0) {
        throw new RdpProtocolError(
          `ClearCodec: Residualsegment mit Lauflaenge 0 bei Offset ${r.offset} - laut 2.2.4.1.1.1.1 unzulaessig`,
        );
      }
      if (pixel + laenge > gesamt) {
        throw new RdpProtocolError(
          `ClearCodec: Residualschicht schreibt ${pixel + laenge} Pixel, das Bild fasst aber nur ${gesamt} (${width}x${height})`,
        );
      }

      const ende = pixel + laenge;
      for (let o = pixel * 4; pixel < ende; pixel++, o += 4) {
        out[o] = rot;
        out[o + 1] = g;
        out[o + 2] = b;
      }
    }
  }

  /**
   * Schicht 2 - CLEARCODEC_BANDS_DATA (2.2.4.1.1.2).
   *
   * Ein Band ist ein waagerechter Streifen (hoechstens 52 Pixel hoch), der
   * Spalte fuer Spalte aus V-Bars zusammengesetzt wird. Jede Spalte kommt
   * entweder roh im Strom, aus dem Short-V-Bar-Cache oder aus dem
   * V-Bar-Cache - und die ersten beiden Faelle legen ihr Ergebnis zusaetzlich
   * im V-Bar-Cache ab (2.2.4.1.1.2.1.1.2/.3).
   */
  private decodeBands(r: ClearReader, out: Uint8ClampedArray, width: number, height: number): void {
    while (!r.eof) {
      const xStart = r.u16('CLEARCODEC_BAND::xStart');
      const xEnd = r.u16('CLEARCODEC_BAND::xEnd');
      const yStart = r.u16('CLEARCODEC_BAND::yStart');
      const yEnd = r.u16('CLEARCODEC_BAND::yEnd');
      const bkgB = r.u8('CLEARCODEC_BAND::blueBkg');
      const bkgG = r.u8('CLEARCODEC_BAND::greenBkg');
      const bkgR = r.u8('CLEARCODEC_BAND::redBkg');

      // xEnd und yEnd sind inklusiv (2.2.4.1.1.2.1), das Band muss also
      // vollstaendig im Bild liegen.
      if (xStart > xEnd || yStart > yEnd) {
        throw new RdpProtocolError(
          `ClearCodec: Band mit leerem Bereich x ${xStart}..${xEnd}, y ${yStart}..${yEnd} - beide Kanten sind inklusiv`,
        );
      }
      if (xEnd >= width || yEnd >= height) {
        throw new RdpProtocolError(
          `ClearCodec: Band x ${xStart}..${xEnd}, y ${yStart}..${yEnd} ragt aus dem Bild ${width}x${height} heraus`,
        );
      }

      const bandHoehe = yEnd - yStart + 1;
      const anzahl = xEnd - xStart + 1;

      for (let i = 0; i < anzahl; i++) {
        const spalte = this.readVBar(r, bandHoehe, bkgB, bkgG, bkgR);
        // 2.2.4.1.1.2.1.1: xPos = xStart + Position der V-Bar im Band,
        // yPos = yStart + Position des Pixels in der V-Bar.
        const x = xStart + i;
        for (let y = 0; y < bandHoehe; y++) {
          const o = ((yStart + y) * width + x) * 4;
          out[o] = spalte[y * 3 + 2];
          out[o + 1] = spalte[y * 3 + 1];
          out[o + 2] = spalte[y * 3];
        }
      }
    }
  }

  /**
   * Liest eine CLEARCODEC_VBAR (2.2.4.1.1.2.1.1) und liefert sie als BGR-Spalte
   * der Hoehe des umgebenden Bandes.
   *
   * Der Kopf ist ein 16-Bit-Wert, dessen obere zwei Bit die Struktur
   * bestimmen - und nur deshalb sind die drei Varianten unterscheidbar:
   *   1x -> VBAR_CACHE_HIT        (2.2.4.1.1.2.1.1.1), 15 Bit Index
   *   01 -> SHORT_VBAR_CACHE_HIT  (2.2.4.1.1.2.1.1.2), 14 Bit Index + 1 Byte yOn
   *   00 -> SHORT_VBAR_CACHE_MISS (2.2.4.1.1.2.1.1.3), 8 Bit yOn + 6 Bit yOff
   */
  private readVBar(r: ClearReader, bandHoehe: number, bkgB: number, bkgG: number, bkgR: number): BgrColumn {
    const kopf = r.u16('CLEARCODEC_VBAR::vBarHeader');

    if ((kopf & 0x8000) !== 0) {
      // VBAR_CACHE_HIT: die Spalte liegt fertig im V-Bar-Speicher, der Cursor
      // bleibt unberuehrt.
      const index = kopf & 0x7fff;
      const eintrag = this.vBars[index];
      if (!eintrag) {
        throw new RdpProtocolError(
          `ClearCodec: VBAR_CACHE_HIT auf Platz ${index}, dort wurde aber noch keine V-Bar abgelegt`,
        );
      }
      if (eintrag.length !== bandHoehe * 3) {
        // 2.2.4.1.1.2.1.1.1: "the size of the data in the V-Bar Storage ADM
        // element MUST be equal to 3 * (yEnd - yStart + 1) bytes".
        throw new RdpProtocolError(
          `ClearCodec: V-Bar ${index} ist ${eintrag.length / 3} Pixel hoch, das Band verlangt aber ${bandHoehe}`,
        );
      }
      return eintrag;
    }

    if ((kopf & 0x4000) !== 0) {
      // SHORT_VBAR_CACHE_HIT
      const index = kopf & 0x3fff;
      const yOn = r.u8('SHORT_VBAR_CACHE_HIT::shortVBarYOn');
      const kurz = this.shortVBars[index];
      if (!kurz) {
        throw new RdpProtocolError(
          `ClearCodec: SHORT_VBAR_CACHE_HIT auf Platz ${index}, dort wurde aber noch keine Short-V-Bar abgelegt`,
        );
      }
      return this.storeVBar(kurz, yOn, bandHoehe, bkgB, bkgG, bkgR);
    }

    // SHORT_VBAR_CACHE_MISS: yOn in den unteren 8 Bit, yOff in den folgenden 6.
    const yOn = kopf & 0xff;
    const yOff = (kopf >> 8) & 0x3f;
    if (yOff < yOn) {
      // 2.2.4.1.1.2.1.1.3: "shortVBarYOff MUST be larger than or equal to shortVBarYOn".
      throw new RdpProtocolError(
        `ClearCodec: SHORT_VBAR_CACHE_MISS mit shortVBarYOff ${yOff} kleiner als shortVBarYOn ${yOn}`,
      );
    }
    // yOff ist exklusiv, yEnd eines Bandes dagegen inklusiv - ausdruecklich in
    // 4.1.1.4 angemerkt, weil eine Short-V-Bar der Hoehe 0 erlaubt ist.
    const anzahl = yOff - yOn;
    // Kopie, kein Ausschnitt: der Cache ueberlebt den Eingabepuffer.
    const kurz = new Uint8Array(r.bytes(anzahl * 3, 'CLEARCODEC_VBAR::shortVBarPixels'));

    this.shortVBars[this.shortVBarCursor] = kurz;
    this.shortVBarCursor = (this.shortVBarCursor + 1) % SHORT_VBAR_SLOTS;

    return this.storeVBar(kurz, yOn, bandHoehe, bkgB, bkgG, bkgR);
  }

  /**
   * Setzt aus einer Short-V-Bar die volle Spalte des Bandes zusammen und legt
   * sie im V-Bar-Speicher ab.
   *
   * Die Regel steht wortgleich in 2.2.4.1.1.2.1.1.2 und .3: oberhalb von yOn
   * und ab yOn + Pixelzahl gilt die Hintergrundfarbe des Bandes, dazwischen die
   * Pixel der Short-V-Bar. Anschliessend rueckt der V-Bar-Cursor um eins vor
   * und laeuft bei 32768 wieder auf 0.
   */
  private storeVBar(
    kurz: BgrColumn,
    yOn: number,
    bandHoehe: number,
    bkgB: number,
    bkgG: number,
    bkgR: number,
  ): BgrColumn {
    const spalte = new Uint8Array(bandHoehe * 3);
    const kurzPixel = kurz.length / 3;

    for (let y = 0; y < bandHoehe; y++) {
      const o = y * 3;
      if (y >= yOn && y < yOn + kurzPixel) {
        const q = (y - yOn) * 3;
        spalte[o] = kurz[q];
        spalte[o + 1] = kurz[q + 1];
        spalte[o + 2] = kurz[q + 2];
      } else {
        spalte[o] = bkgB;
        spalte[o + 1] = bkgG;
        spalte[o + 2] = bkgR;
      }
    }

    this.vBars[this.vBarCursor] = spalte;
    this.vBarCursor = (this.vBarCursor + 1) % VBAR_SLOTS;
    return spalte;
  }

  /**
   * Schicht 3 - CLEARCODEC_SUBCODECS_DATA (2.2.4.1.1.3).
   *
   * Eine Folge rechteckiger Teilbilder, jedes mit eigener Lage im Zielbild und
   * eigenem Unterverfahren (2.2.4.1.1.3.1).
   */
  private decodeSubcodecs(r: ClearReader, out: Uint8ClampedArray, width: number, height: number): void {
    while (!r.eof) {
      const xStart = r.u16('CLEARCODEC_SUBCODEC::xStart');
      const yStart = r.u16('CLEARCODEC_SUBCODEC::yStart');
      const w = r.u16('CLEARCODEC_SUBCODEC::width');
      const h = r.u16('CLEARCODEC_SUBCODEC::height');
      const byteCount = r.u32('CLEARCODEC_SUBCODEC::bitmapDataByteCount');
      const subCodecId = r.u8('CLEARCODEC_SUBCODEC::subCodecId');
      const daten = r.bytes(byteCount, 'CLEARCODEC_SUBCODEC::bitmapData');

      if (w === 0 || h === 0) {
        throw new RdpProtocolError(`ClearCodec: Subcodec-Teilbild mit Groesse ${w}x${h}`);
      }
      if (xStart + w > width || yStart + h > height) {
        throw new RdpProtocolError(
          `ClearCodec: Subcodec-Teilbild ${w}x${h} an (${xStart},${yStart}) ragt aus dem Bild ${width}x${height} heraus`,
        );
      }
      // 2.2.4.1.1.3.1 sagt zwar "The value in the bitmapDataByteCount field
      // MUST NOT exceed (3 * width * height)", das gilt aber ersichtlich nur
      // fuer den rohen Fall: ein RLEX-Teilbild traegt bis zu 127 Palettenfarben
      // (382 Byte) vor dem ersten Segment, ein NSCodec-Teilbild allein 20 Byte
      // Kopf - bei einem kleinen Rechteck liegt beides ueber 3 * width *
      // height. Die Schranke wird deshalb dort geprueft, wo sie zutrifft
      // (drawRaw verlangt exakt 3 * width * height); die Laenge selbst ist
      // bereits durch den Abschnitt der Subcodecschicht begrenzt.

      switch (subCodecId) {
        case CLEARCODEC_SUBCODEC_RAW:
          this.drawRaw(daten, out, width, xStart, yStart, w, h);
          break;
        case CLEARCODEC_SUBCODEC_RLEX:
          this.drawRlex(daten, out, width, xStart, yStart, w, h);
          break;
        case CLEARCODEC_SUBCODEC_NSCODEC:
          this.drawNsCodec(daten, out, width, xStart, yStart, w, h);
          break;
        default:
          throw new RdpProtocolError(`ClearCodec: unbekannte subCodecId 0x${subCodecId.toString(16).padStart(2, '0')}`);
      }
    }
  }

  /**
   * subCodecId 0x00 - rohe Pixel (2.2.4.1.1.3.1).
   *
   * "the bitmapData field contains the raw pixels of the bitmap in
   * little-endian byte order (blue in the first byte, green in the second byte,
   * and red in the third byte). The pixels are ordered from left to right and
   * then top to bottom."
   */
  private drawRaw(
    daten: Buffer,
    out: Uint8ClampedArray,
    width: number,
    xStart: number,
    yStart: number,
    w: number,
    h: number,
  ): void {
    if (daten.length !== 3 * w * h) {
      throw new RdpProtocolError(
        `ClearCodec: rohes Subcodec-Teilbild ${w}x${h} braucht ${3 * w * h} Byte, geliefert wurden ${daten.length}`,
      );
    }
    for (let y = 0; y < h; y++) {
      let q = y * w * 3;
      let o = ((yStart + y) * width + xStart) * 4;
      for (let x = 0; x < w; x++, q += 3, o += 4) {
        out[o] = daten[q + 2];
        out[o + 1] = daten[q + 1];
        out[o + 2] = daten[q];
      }
    }
  }

  /**
   * subCodecId 0x01 - NSCodec (MS-RDPNSC 2.2.2, Dekodierung 3.1.8.4).
   *
   * Anders als erwartet ist das hier kein Randfall: von 400 aufgezeichneten
   * Kacheln des Zielservers benutzen 75 diesen Subcodec, und ohne ihn bleiben
   * genau die Bereiche leer, in denen der Server Fotos und Farbverlaeufe
   * uebertraegt.
   *
   * NSCodec arbeitet wie der planare Codec im AYCoCg-Raum und teilt sich mit ihm
   * sogar die Spezifikationsabschnitte (MS-RDPNSC 3.1.8.4 verweist auf
   * MS-RDPEGDI 3.1.9.1.1 bis 3.1.9.1.4). Unterschiede zu src/codec/planar.ts:
   *   - Die vier Ebenen kommen mit *eigenen* Laengenangaben und sind einzeln
   *     entweder roh oder RLE-kodiert - das RLE ist ein voellig anderes als das
   *     planare (MS-RDPNSC 2.2.2.2.x statt MS-RDPEGDI 2.2.2.5.1.2).
   *   - Bei Subsampling wird die Lumabreite auf ein Vielfaches von 8 und die
   *     Chromahoehe auf ein Vielfaches von 2 aufgerundet; die Chromaebenen sind
   *     dadurch breiter als das halbe Bild.
   *   - Es gibt keinen "kein Alpha"-Schalter, sondern AlphaPlaneByteCount = 0.
   */
  private drawNsCodec(
    daten: Buffer,
    out: Uint8ClampedArray,
    width: number,
    xStart: number,
    yStart: number,
    w: number,
    h: number,
  ): void {
    const r = new ClearReader(daten);
    const lumaByteCount = r.u32('NSCODEC_BITMAP_STREAM::LumaPlaneByteCount');
    const coByteCount = r.u32('NSCODEC_BITMAP_STREAM::OrangeChromaPlaneByteCount');
    const cgByteCount = r.u32('NSCODEC_BITMAP_STREAM::GreenChromaPlaneByteCount');
    const alphaByteCount = r.u32('NSCODEC_BITMAP_STREAM::AlphaPlaneByteCount');
    const cll = r.u8('NSCODEC_BITMAP_STREAM::ColorLossLevel');
    const subsampling = r.u8('NSCODEC_BITMAP_STREAM::ChromaSubsamplingLevel') !== 0;
    r.u16('NSCODEC_BITMAP_STREAM::Reserved');

    // MS-RDPNSC 2.2.2: "This value MUST be in the range 1 to 7 (inclusive)."
    // CLL = 0 wuerde die Chromaruecktransformation unten still verfaelschen.
    if (cll < 1 || cll > 7) {
      throw new RdpProtocolError(
        `ClearCodec/NSCodec: ColorLossLevel ${cll} liegt ausserhalb von 1..7 (MS-RDPNSC 2.2.2)`,
      );
    }

    // Rohgroessen der Ebenen laut 2.2.2.
    const lumaWidth = subsampling ? aufrunden(w, 8) : w;
    const chromaWidth = subsampling ? aufrunden(w, 8) / 2 : w;
    const chromaHeight = subsampling ? aufrunden(h, 2) / 2 : h;

    const luma = nscLiesEbene(r, lumaByteCount, lumaWidth * h, 'LumaPlane');
    const co = nscLiesEbene(r, coByteCount, chromaWidth * chromaHeight, 'OrangeChromaPlane');
    const cg = nscLiesEbene(r, cgByteCount, chromaWidth * chromaHeight, 'GreenChromaPlane');
    // 2.2.2: "This field MUST NOT be present if AlphaPlaneByteCount equals 0."
    const alpha = alphaByteCount > 0 ? nscLiesEbene(r, alphaByteCount, w * h, 'AlphaPlane') : null;

    for (let y = 0; y < h; y++) {
      const lumaZeile = y * lumaWidth;
      // Super-Sampling (MS-RDPEGDI 3.1.9.1.3): ein Chromawert deckt ein
      // 2x2-Feld ab, also schlichte Pixelverdopplung in beide Richtungen.
      const chromaZeile = (subsampling ? y >> 1 : y) * chromaWidth;
      let o = ((yStart + y) * width + xStart) * 4;

      for (let x = 0; x < w; x++, o += 4) {
        const c = chromaZeile + (subsampling ? x >> 1 : x);
        // Farbverlustreduktion rueckgaengig (MS-RDPEGDI 3.1.9.1.4).
        //
        // Entscheidend ist, aus wie vielen Bit das Ebenenbyte vorzeichen-
        // erweitert wird: Co und Cg sind laut 3.1.9.1.2 neun Bit breit, die
        // Reduktion schiebt sie um CLL Bit nach rechts - es bleiben also
        // 9 - CLL nutzbare Bit, und genau aus so vielen ist zu erweitern.
        //
        // Aus acht Bit zu erweitern ist verlockend und falsch. Bei CLL = 3
        // liegen die Werte in sechs Bit, und -1 steht dann als 0x3F im Byte.
        // Als Achtbitwert gelesen wird daraus +63, nach dem Schieben +504 -
        // weit ausserhalb der neun Bit. Sichtbar wurde das als reingruene
        // Flecken in Fotos: ein zu grosses Cg treibt G an die Obergrenze,
        // waehrend R und B auf null fallen. In der Byteverteilung der
        // betroffenen Kachel stand Cg fast durchweg bei 0..5 und dann
        // schlagartig bei 62 und 63 - das sind -2 und -1, keine Ausreisser
        // nach oben.
        const chromaBits = 9 - cll;
        const erweitere = 32 - chromaBits;
        const coWert = (((co[c] << erweitere) >> erweitere) << cll);
        const cgWert = (((cg[c] << erweitere) >> erweitere) << cll);
        // Inverse Transformation aus 3.1.9.1.2 in Lifting-Form, identisch zu
        // planarDecompress.
        const t = luma[lumaZeile + x] - (cgWert >> 1);
        const g = cgWert + t;
        const b = t - (coWert >> 1);
        const rot = coWert + b;
        // Hier wird *nicht* getauscht - anders als in planarDecompress.
        //
        // Das war zwischenzeitlich anders, und die Geschichte gehoert dazu:
        // Weil Chroma falsch vorzeichenerweitert wurde (siehe oben), erschien
        // das Edge-Symbol orange. Ein Tausch von R und B machte es scheinbar
        // richtig - er hat den Vorzeichenfehler nur ausgeglichen. Sichtbar
        // blieb der Rest des Schadens in Fotos, wo grosse Chromawerte
        // vorkommen: dort blieben reingruene Flecken stehen.
        //
        // Mit der richtigen Vorzeichenbreite stimmt die Rechnung ohne Tausch,
        // wie FreeRDP es in nsc.c auch macht (und anders als in prim_YCoCg.c
        // fuer den planaren Weg). Belegt am Bildschirminhalt: das Store-Symbol
        // zeigt das Windows-Logo in seinen vier Farben statt als einfarbigen
        // Klumpen, und ein Foto im Suchfeld hat blaues Wasser statt goldenem.
        //
        // Lehre daraus: zwei Fehler, die sich gegenseitig teilweise aufheben,
        // sehen an einer Stichprobe wie ein Fehler aus. Eine einzelne Messung
        // an einem Symbol reichte nicht - erst die Byteverteilung der Ebene
        // hat gezeigt, was wirklich los war.

        out[o] = rot;
        out[o + 1] = g;
        out[o + 2] = b;
        // Uint8ClampedArray erledigt das Begrenzen auf 0..255 (3.1.9.1.2).
        if (alpha) out[o + 3] = alpha[y * w + x];
      }
    }
  }

  /**
   * subCodecId 0x02 - CLEARCODEC_SUBCODEC_RLEX (2.2.4.1.1.3.1.1).
   *
   * Eine Palette von bis zu 127 Farben, danach Segmente aus je einem Bitfeld
   * (stopIndex unten, suiteDepth oben) und einer Lauflaenge. Ein Segment
   * liefert erst `runLength` Pixel in startColor = palette[stopIndex -
   * suiteDepth] und danach die Suite palette[startIndex] bis palette[stopIndex],
   * also suiteDepth + 1 weitere Pixel. Das "+1" steht nicht ausdruecklich im
   * Text, folgt aber zwingend aus dem durchgerechneten Beispiel in 4.1.1.2
   * (Segment 0x11/0x04 liefert dort sechs Pixel: 4 + (1 + 1)).
   */
  private drawRlex(
    daten: Buffer,
    out: Uint8ClampedArray,
    width: number,
    xStart: number,
    yStart: number,
    w: number,
    h: number,
  ): void {
    const r = new ClearReader(daten);
    const paletteCount = r.u8('CLEARCODEC_SUBCODEC_RLEX::paletteCount');
    if (paletteCount === 0 || paletteCount > 0x7f) {
      throw new RdpProtocolError(
        `ClearCodec: RLEX meldet paletteCount ${paletteCount}, erlaubt sind 1 bis 127 (2.2.4.1.1.3.1.1)`,
      );
    }
    const palette = r.bytes(paletteCount * 3, 'CLEARCODEC_SUBCODEC_RLEX::paletteEntries');

    const bits = stopIndexBits(paletteCount);
    const indexMaske = (1 << bits) - 1;
    const gesamt = w * h;
    let pixel = 0;

    // Ein Pixel im Teilbild an Position `pixel` setzen; das Teilbild liegt bei
    // (xStart, yStart) im Zielbild.
    const setze = (p: number, farbe: number): void => {
      const q = farbe * 3;
      const o = ((yStart + ((p / w) | 0)) * width + xStart + (p % w)) * 4;
      out[o] = palette[q + 2];
      out[o + 1] = palette[q + 1];
      out[o + 2] = palette[q];
    };

    while (!r.eof) {
      const feld = r.u8('CLEARCODEC_SUBCODEC_RLEX_SEGMENT::stopIndex/suiteDepth');
      const stopIndex = feld & indexMaske;
      const suiteDepth = feld >> bits;
      // Im Gegensatz zum Residualsegment ist hier die Lauflaenge 0 ausdruecklich
      // moeglich (Beispiel 4.1.1.2, Segment 0x29/0x00) - die Suite allein
      // liefert dann die Pixel.
      const laenge = readRunLength(r, 'CLEARCODEC_SUBCODEC_RLEX_SEGMENT');

      const startIndex = stopIndex - suiteDepth;
      if (startIndex < 0 || stopIndex >= paletteCount) {
        throw new RdpProtocolError(
          `ClearCodec: RLEX-Segment mit stopIndex ${stopIndex} und suiteDepth ${suiteDepth} ` +
            `verweist ausserhalb der Palette mit ${paletteCount} Eintraegen`,
        );
      }

      const geschrieben = laenge + suiteDepth + 1;
      if (pixel + geschrieben > gesamt) {
        throw new RdpProtocolError(
          `ClearCodec: RLEX schreibt ${pixel + geschrieben} Pixel, das Teilbild fasst aber nur ${gesamt} (${w}x${h})`,
        );
      }

      for (let i = 0; i < laenge; i++) setze(pixel++, startIndex);
      for (let i = 0; i <= suiteDepth; i++) setze(pixel++, startIndex + i);
    }
  }
}
