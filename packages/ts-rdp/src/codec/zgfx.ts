/**
 * RDP 8.0 Bulk Compression ("ZGFX") - MS-RDPEGFX 3.1.8.
 *
 * Jede Nachricht der Graphics Pipeline steckt in dieser Huellkurve, also fuehrt
 * an ihr kein Weg vorbei. Das Verfahren ist LZ77 mit einem festen Huffman-Code:
 * ein Token beschreibt entweder ein einzelnes Byte (Literal) oder einen
 * Rueckverweis in den Verlaufspuffer (Match).
 *
 * Zwei Eigenheiten, die man leicht falsch macht:
 *  - Der Verlaufspuffer bleibt ueber Segmente *und* ueber Nachrichten hinweg
 *    erhalten. Ein Match darf auf Daten aus einer frueheren Nachricht zeigen.
 *    Deshalb ist das hier eine Klasse und keine Funktion.
 *  - Das letzte Byte eines komprimierten Segments ist kein Nutzdatenbyte,
 *    sondern die Anzahl ungenutzter Bits im vorletzten Byte.
 *
 * Die Tokentabelle und der Ablauf folgen dem Beispielcode der Spezifikation.
 */
import { RdpProtocolError } from '../core/errors.js';

/** Ein einzelnes Segment. */
export const SEGMENTED_SINGLE = 0xe0;
/** Mehrere Segmente mit gemeinsamer Gesamtlaenge. */
export const SEGMENTED_MULTIPART = 0xe1;

/** Flag im Segmentkopf: Nutzdaten sind Huffman-kodiert. */
const PACKET_COMPRESSED = 0x20;
/**
 * Unteres Nibble des Kopfbytes: welches Kompressionspaket gemeint ist.
 * Es benennt das Verfahren, nicht ob komprimiert wurde - deshalb steht es
 * auch in unkomprimierten Segmenten.
 */
export const PACKET_COMPR_TYPE_RDP8 = 0x04;

/** Groesse des Verlaufspuffers laut Spezifikation. */
const HISTORY_SIZE = 2500000;

interface Token {
  /** Anzahl Bits des Praefixes. */
  prefixLength: number;
  /** Bitmuster des Praefixes. */
  prefixCode: number;
  /** Anzahl anschliessend zu lesender Wertbits. */
  valueBits: number;
  /** 0 = Literal, 1 = Match. */
  tokenType: 0 | 1;
  /** Wird auf die Wertbits addiert. */
  valueBase: number;
}

/** Tokentabelle aus MS-RDPEGFX, nach Praefixlaenge sortiert. */
const TOKEN_TABLE: Token[] = [
  { prefixLength: 1, prefixCode: 0, valueBits: 8, tokenType: 0, valueBase: 0 }, // 0
  { prefixLength: 5, prefixCode: 17, valueBits: 5, tokenType: 1, valueBase: 0 }, // 10001
  { prefixLength: 5, prefixCode: 18, valueBits: 7, tokenType: 1, valueBase: 32 }, // 10010
  { prefixLength: 5, prefixCode: 19, valueBits: 9, tokenType: 1, valueBase: 160 }, // 10011
  { prefixLength: 5, prefixCode: 20, valueBits: 10, tokenType: 1, valueBase: 672 }, // 10100
  { prefixLength: 5, prefixCode: 21, valueBits: 12, tokenType: 1, valueBase: 1696 }, // 10101
  { prefixLength: 5, prefixCode: 24, valueBits: 0, tokenType: 0, valueBase: 0x00 }, // 11000
  { prefixLength: 5, prefixCode: 25, valueBits: 0, tokenType: 0, valueBase: 0x01 }, // 11001
  { prefixLength: 6, prefixCode: 44, valueBits: 14, tokenType: 1, valueBase: 5792 }, // 101100
  { prefixLength: 6, prefixCode: 45, valueBits: 15, tokenType: 1, valueBase: 22176 }, // 101101
  { prefixLength: 6, prefixCode: 52, valueBits: 0, tokenType: 0, valueBase: 0x02 }, // 110100
  { prefixLength: 6, prefixCode: 53, valueBits: 0, tokenType: 0, valueBase: 0x03 }, // 110101
  { prefixLength: 6, prefixCode: 54, valueBits: 0, tokenType: 0, valueBase: 0xff }, // 110110
  { prefixLength: 7, prefixCode: 92, valueBits: 18, tokenType: 1, valueBase: 54944 }, // 1011100
  { prefixLength: 7, prefixCode: 93, valueBits: 20, tokenType: 1, valueBase: 317088 }, // 1011101
  { prefixLength: 7, prefixCode: 110, valueBits: 0, tokenType: 0, valueBase: 0x04 }, // 1101110
  { prefixLength: 7, prefixCode: 111, valueBits: 0, tokenType: 0, valueBase: 0x05 }, // 1101111
  { prefixLength: 7, prefixCode: 112, valueBits: 0, tokenType: 0, valueBase: 0x06 }, // 1110000
  { prefixLength: 7, prefixCode: 113, valueBits: 0, tokenType: 0, valueBase: 0x07 }, // 1110001
  { prefixLength: 7, prefixCode: 114, valueBits: 0, tokenType: 0, valueBase: 0x08 }, // 1110010
  { prefixLength: 7, prefixCode: 115, valueBits: 0, tokenType: 0, valueBase: 0x09 }, // 1110011
  { prefixLength: 7, prefixCode: 116, valueBits: 0, tokenType: 0, valueBase: 0x0a }, // 1110100
  { prefixLength: 7, prefixCode: 117, valueBits: 0, tokenType: 0, valueBase: 0x0b }, // 1110101
  { prefixLength: 7, prefixCode: 118, valueBits: 0, tokenType: 0, valueBase: 0x3a }, // 1110110
  { prefixLength: 7, prefixCode: 119, valueBits: 0, tokenType: 0, valueBase: 0x3b }, // 1110111
  { prefixLength: 7, prefixCode: 120, valueBits: 0, tokenType: 0, valueBase: 0x3c }, // 1111000
  { prefixLength: 7, prefixCode: 121, valueBits: 0, tokenType: 0, valueBase: 0x3d }, // 1111001
  { prefixLength: 7, prefixCode: 122, valueBits: 0, tokenType: 0, valueBase: 0x3e }, // 1111010
  { prefixLength: 7, prefixCode: 123, valueBits: 0, tokenType: 0, valueBase: 0x3f }, // 1111011
  { prefixLength: 7, prefixCode: 124, valueBits: 0, tokenType: 0, valueBase: 0x40 }, // 1111100
  { prefixLength: 7, prefixCode: 125, valueBits: 0, tokenType: 0, valueBase: 0x80 }, // 1111101
  { prefixLength: 8, prefixCode: 188, valueBits: 20, tokenType: 1, valueBase: 1365664 }, // 10111100
  { prefixLength: 8, prefixCode: 189, valueBits: 21, tokenType: 1, valueBase: 2414240 }, // 10111101
  { prefixLength: 8, prefixCode: 252, valueBits: 0, tokenType: 0, valueBase: 0x0c }, // 11111100
  { prefixLength: 8, prefixCode: 253, valueBits: 0, tokenType: 0, valueBase: 0x38 }, // 11111101
  { prefixLength: 8, prefixCode: 254, valueBits: 0, tokenType: 0, valueBase: 0x39 }, // 11111110
  { prefixLength: 8, prefixCode: 255, valueBits: 0, tokenType: 0, valueBase: 0x66 }, // 11111111
  { prefixLength: 9, prefixCode: 380, valueBits: 22, tokenType: 1, valueBase: 4511392 }, // 101111100
  { prefixLength: 9, prefixCode: 381, valueBits: 23, tokenType: 1, valueBase: 8705696 }, // 101111101
  { prefixLength: 9, prefixCode: 382, valueBits: 24, tokenType: 1, valueBase: 17094304 }, // 101111110
];

export class ZgfxError extends RdpProtocolError {
  constructor(message: string) {
    super(`ZGFX: ${message}`);
    this.name = 'ZgfxError';
  }
}

export class ZgfxDecompressor {
  private readonly history = Buffer.alloc(HISTORY_SIZE);
  private historyIndex = 0;

  // Zustand des Bitstroms des gerade laufenden Segments
  private input: Buffer = Buffer.alloc(0);
  private inputPos = 0;
  private inputEnd = 0;
  private bitsRemaining = 0;
  /** Angesammelte, noch nicht verbrauchte Bits. Als Zahl statt Bitoperationen,
   *  weil das Register bis zu 31 Bit breit wird und `<<` in JavaScript
   *  vorzeichenbehaftet arbeitet. */
  private bitBuffer = 0;
  private bitCount = 0;

  private output: number[] = [];

  /** Entpackt eine vollstaendige RDP8_BULK_ENCODED_DATA-Struktur. */
  decompress(data: Buffer): Buffer {
    if (data.length < 1) throw new ZgfxError('leere Eingabe');
    const descriptor = data[0];

    if (descriptor === SEGMENTED_SINGLE) {
      return this.segment(data.subarray(1));
    }

    if (descriptor === SEGMENTED_MULTIPART) {
      if (data.length < 7) throw new ZgfxError('Mehrteiler ohne vollstaendigen Kopf');
      const segmentCount = data.readUInt16LE(1);
      const uncompressedSize = data.readUInt32LE(3);
      const teile: Buffer[] = [];
      let offset = 7;
      for (let i = 0; i < segmentCount; i++) {
        if (offset + 4 > data.length) throw new ZgfxError(`Segment ${i} reicht ueber das Ende hinaus`);
        const size = data.readUInt32LE(offset);
        offset += 4;
        if (offset + size > data.length) throw new ZgfxError(`Segment ${i} ist unvollstaendig`);
        teile.push(this.segment(data.subarray(offset, offset + size)));
        offset += size;
      }
      const ergebnis = Buffer.concat(teile);
      if (ergebnis.length !== uncompressedSize) {
        throw new ZgfxError(
          `entpackte Laenge ${ergebnis.length} weicht von der angekuendigten ${uncompressedSize} ab`,
        );
      }
      return ergebnis;
    }

    throw new ZgfxError(`unbekannter Deskriptor 0x${descriptor.toString(16)}`);
  }

  /** Ein Segment: erstes Byte sind Flags, der Rest sind die Nutzdaten. */
  private segment(segment: Buffer): Buffer {
    if (segment.length < 1) throw new ZgfxError('Segment ohne Kopfbyte');
    const flags = segment[0];
    const nutzdaten = segment.subarray(1);
    return flags & PACKET_COMPRESSED ? this.decodeCompressed(nutzdaten) : this.copyRaw(nutzdaten);
  }

  private copyRaw(raw: Buffer): Buffer {
    for (const byte of raw) this.pushHistory(byte);
    return Buffer.from(raw);
  }

  private pushHistory(byte: number): void {
    this.history[this.historyIndex] = byte;
    if (++this.historyIndex === HISTORY_SIZE) this.historyIndex = 0;
  }

  /** Liefert die naechsten `count` Bits als vorzeichenlose Zahl. */
  private getBits(count: number): number {
    while (this.bitCount < count) {
      this.bitBuffer *= 256;
      if (this.inputPos < this.inputEnd) this.bitBuffer += this.input[this.inputPos++];
      this.bitCount += 8;
    }
    this.bitsRemaining -= count;
    this.bitCount -= count;
    const teiler = 2 ** this.bitCount;
    const ergebnis = Math.floor(this.bitBuffer / teiler);
    this.bitBuffer = this.bitBuffer % teiler;
    return ergebnis;
  }

  private decodeCompressed(encoded: Buffer): Buffer {
    if (encoded.length < 1) throw new ZgfxError('komprimiertes Segment ohne Abschlussbyte');

    this.output = [];
    this.input = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.length);
    this.inputPos = 0;
    // Das letzte Byte zaehlt die ungenutzten Bits und gehoert nicht zum Strom.
    this.inputEnd = encoded.length - 1;
    this.bitsRemaining = 8 * (encoded.length - 1) - encoded[encoded.length - 1];
    this.bitBuffer = 0;
    this.bitCount = 0;

    while (this.bitsRemaining > 0) {
      let haveBits = 0;
      let inPrefix = 0;
      let token: Token | undefined;

      // Bitweise weiterlesen, bis ein Praefix aus der Tabelle passt.
      for (const kandidat of TOKEN_TABLE) {
        while (haveBits < kandidat.prefixLength) {
          inPrefix = inPrefix * 2 + this.getBits(1);
          haveBits++;
        }
        if (inPrefix === kandidat.prefixCode) {
          token = kandidat;
          break;
        }
      }
      if (!token) throw new ZgfxError('kein passendes Token im Bitstrom gefunden');

      if (token.tokenType === 0) {
        const byte = (token.valueBase + this.getBits(token.valueBits)) & 0xff;
        this.pushHistory(byte);
        this.output.push(byte);
        continue;
      }

      const distance = token.valueBase + this.getBits(token.valueBits);

      if (distance === 0) {
        // Sonderfall: es folgen unkodierte Bytes direkt aus dem Strom.
        let count = this.getBits(15);
        this.bitsRemaining -= this.bitCount;
        this.bitCount = 0;
        this.bitBuffer = 0;
        while (count-- > 0) {
          if (this.inputPos >= this.inputEnd) throw new ZgfxError('unkodierter Abschnitt reicht ueber das Segment hinaus');
          const byte = this.input[this.inputPos++];
          this.bitsRemaining -= 8;
          this.pushHistory(byte);
          this.output.push(byte);
        }
        continue;
      }

      // Laenge: ein Bit fuer den haeufigen Fall 3, sonst verdoppelnd kodiert.
      let count: number;
      if (this.getBits(1) === 0) {
        count = 3;
      } else {
        count = 4;
        let extra = 2;
        while (this.getBits(1) === 1) {
          count *= 2;
          extra++;
          if (extra > 32) throw new ZgfxError('unplausible Laengenkodierung');
        }
        count += this.getBits(extra);
      }

      let prevIndex = (this.historyIndex + HISTORY_SIZE - distance) % HISTORY_SIZE;
      while (count-- > 0) {
        const byte = this.history[prevIndex];
        if (++prevIndex === HISTORY_SIZE) prevIndex = 0;
        this.pushHistory(byte);
        this.output.push(byte);
      }
    }

    return Buffer.from(this.output);
  }
}

/**
 * Verpackt Daten als unkomprimiertes Einzelsegment.
 *
 * Achtung Senderichtung: Diese Huelle gehoert NUR in den Weg Server -> Client.
 * Der Client schickt seine EGFX-Nachrichten blank (MS-RDPEGFX 3.2.5.1: "not
 * encapsulated within any external structure"). Hier wird sie deshalb nur vom
 * Testserver benutzt, der die Serverrolle spielt.
 * Ein eigener Kompressor waere nur Bandbreitenoptimierung fuer den Rueckkanal,
 * auf dem ohnehin fast nichts laeuft.
 */
export function zgfxWrapUncompressed(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([SEGMENTED_SINGLE, PACKET_COMPR_TYPE_RDP8]), data]);
}
