/**
 * Statische virtuelle Kanaele (MS-RDPBCGR 2.2.6).
 *
 * Nutzdaten werden auf Bloecke von hoechstens `VCChunkSize` Byte aufgeteilt.
 * Jeder Block traegt die Gesamtlaenge und Flags, die den ersten und letzten
 * Block markieren - erst daraus laesst sich die urspruengliche Nachricht
 * wieder zusammensetzen.
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';

export const CHANNEL_FLAG_FIRST = 0x00000001;
export const CHANNEL_FLAG_LAST = 0x00000002;
export const CHANNEL_FLAG_SHOW_PROTOCOL = 0x00000010;
export const CHANNEL_FLAG_SUSPEND = 0x00000020;
export const CHANNEL_FLAG_RESUME = 0x00000040;

/** Vorgabe aus dem Virtual Channel Capability Set. */
export const DEFAULT_CHUNK_SIZE = 1600;

export interface ChannelChunk {
  /** Laenge der vollstaendigen Nachricht, nicht dieses Blocks. */
  totalLength: number;
  flags: number;
  data: Buffer;
}

export function parseChannelChunk(payload: Buffer): ChannelChunk {
  if (payload.length < 8) throw new RdpProtocolError('Virtueller Kanal: Block kuerzer als der Kopf');
  const r = new BinaryReader(payload);
  const totalLength = r.uint32le();
  const flags = r.uint32le();
  return { totalLength, flags, data: r.rest() };
}

export function buildChannelChunks(data: Buffer, chunkSize = DEFAULT_CHUNK_SIZE): Buffer[] {
  const out: Buffer[] = [];
  const total = data.length;
  // CHANNEL_FLAG_SHOW_PROTOCOL ist ausschliesslich fuer aufgeteilte Nachrichten
  // gedacht (MS-RDPBCGR 3.1.5.2.1). Wer es bei einer einteiligen Nachricht
  // setzt, bekommt vom Empfaenger den 8 Byte langen Kanalkopf mit an den
  // Endpunkt gereicht - der sieht dann Muell vor seinen Nutzdaten und verwirft
  // die Nachricht stillschweigend.
  const aufgeteilt = total > chunkSize;

  for (let offset = 0; offset < total || offset === 0; offset += chunkSize) {
    const stueck = data.subarray(offset, Math.min(offset + chunkSize, total));
    let flags = aufgeteilt ? CHANNEL_FLAG_SHOW_PROTOCOL : 0;
    if (offset === 0) flags |= CHANNEL_FLAG_FIRST;
    if (offset + chunkSize >= total) flags |= CHANNEL_FLAG_LAST;
    out.push(writer().uint32le(total).uint32le(flags).bytes(stueck).toBuffer());
    if (stueck.length === 0) break;
  }
  return out;
}

/**
 * Setzt die Bloecke eines Kanals wieder zu ganzen Nachrichten zusammen.
 * Liefert `undefined`, solange eine Nachricht noch unvollstaendig ist.
 */
export class ChannelReassembler {
  private teile: Buffer[] = [];
  private erwartet = 0;

  constructor(private readonly maxLength = 16 * 1024 * 1024) {}

  push(chunk: ChannelChunk): Buffer | undefined {
    if (chunk.flags & CHANNEL_FLAG_FIRST) {
      this.teile = [];
      this.erwartet = chunk.totalLength;
      if (this.erwartet > this.maxLength) {
        throw new RdpProtocolError(
          `Virtueller Kanal: angekuendigte Laenge ${this.erwartet} uebersteigt die Obergrenze`,
        );
      }
    }
    this.teile.push(chunk.data);

    if (!(chunk.flags & CHANNEL_FLAG_LAST)) return undefined;
    const vollstaendig = Buffer.concat(this.teile);
    this.teile = [];
    return vollstaendig;
  }
}
