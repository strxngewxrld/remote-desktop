/**
 * Dynamische virtuelle Kanaele (MS-RDPEDYC).
 *
 * Auf dem statischen Kanal `drdynvc` handelt der Server zunaechst eine Version
 * aus, oeffnet danach benannte Unterkanaele und schickt darauf die Nutzdaten.
 * Die Graphics Pipeline ist einer dieser Unterkanaele.
 *
 * Kopfbyte: Cmd in den Bits 4-7, Sp in 2-3, cbId in 0-1. `cbId` gibt an, wie
 * viele Bytes die Kanal-ID belegt (1, 2 oder 4).
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';

export const DVC_CMD_CREATE = 0x01;
export const DVC_CMD_DATA_FIRST = 0x02;
export const DVC_CMD_DATA = 0x03;
export const DVC_CMD_CLOSE = 0x04;
export const DVC_CMD_CAPABILITY = 0x05;
export const DVC_CMD_DATA_FIRST_COMPRESSED = 0x06;
export const DVC_CMD_DATA_COMPRESSED = 0x07;
export const DVC_CMD_SOFT_SYNC_REQUEST = 0x08;
export const DVC_CMD_SOFT_SYNC_RESPONSE = 0x09;

/** Erfolgreiche Kanaleroeffnung. */
export const DVC_CREATION_STATUS_OK = 0;
/** STATUS_NOT_SUPPORTED - hoefliche Absage fuer Kanaele, die wir nicht wollen. */
export const DVC_CREATION_STATUS_NO_LISTENER = 0xc0000001;

export interface DvcPdu {
  cmd: number;
  channelId?: number;
  /** Nur bei CREATE. */
  name?: string;
  /** Nur bei CAPABILITY. */
  version?: number;
  /** Bei DATA_FIRST die Gesamtlaenge der Nachricht. */
  totalLength?: number;
  data?: Buffer;
}

/** Anzahl Bytes der Kanal-ID gemaess cbId. */
function idLength(cbId: number): number {
  if (cbId === 0) return 1;
  if (cbId === 1) return 2;
  if (cbId === 2) return 4;
  throw new RdpProtocolError(`DVC: ungueltiges cbId-Feld ${cbId}`);
}

function readChannelId(r: BinaryReader, cbId: number): number {
  const bytes = idLength(cbId);
  if (bytes === 1) return r.uint8();
  if (bytes === 2) return r.uint16le();
  return r.uint32le();
}

/** Kleinstmoegliche Kodierung der Kanal-ID waehlen. */
function writeChannelId(id: number): { cbId: number; bytes: Buffer } {
  if (id <= 0xff) return { cbId: 0, bytes: Buffer.from([id]) };
  if (id <= 0xffff) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(id, 0);
    return { cbId: 1, bytes: b };
  }
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(id >>> 0, 0);
  return { cbId: 2, bytes: b };
}

export function parseDvcPdu(buf: Buffer): DvcPdu {
  if (buf.length < 1) throw new RdpProtocolError('DVC: leere Nachricht');
  const r = new BinaryReader(buf);
  const header = r.uint8();
  const cmd = (header >> 4) & 0x0f;
  const sp = (header >> 2) & 0x03;
  const cbId = header & 0x03;

  switch (cmd) {
    case DVC_CMD_CAPABILITY: {
      r.uint8(); // Pad
      return { cmd, version: r.remaining >= 2 ? r.uint16le() : 1 };
    }
    case DVC_CMD_CREATE: {
      // Achtung, richtungsabhaengig: hier wird die *Anfrage* des Servers
      // gelesen (Kanal-ID + nullterminierter Name). Die Antwort des Clients
      // hat an derselben Stelle einen 4-Byte-NTSTATUS - wer sie parsen will,
      // braucht einen eigenen Pfad.
      const channelId = readChannelId(r, cbId);
      // Der Name ist ASCII und nullterminiert.
      const rest = r.rest();
      const ende = rest.indexOf(0);
      return { cmd, channelId, name: rest.subarray(0, ende < 0 ? rest.length : ende).toString('ascii') };
    }
    case DVC_CMD_DATA_FIRST: {
      const channelId = readChannelId(r, cbId);
      // sp kodiert die Breite des Laengenfelds wie cbId.
      const laenge = sp === 0 ? r.uint8() : sp === 1 ? r.uint16le() : r.uint32le();
      return { cmd, channelId, totalLength: laenge, data: r.rest() };
    }
    case DVC_CMD_DATA: {
      const channelId = readChannelId(r, cbId);
      return { cmd, channelId, data: r.rest() };
    }
    case DVC_CMD_CLOSE: {
      return { cmd, channelId: readChannelId(r, cbId) };
    }
    default:
      return { cmd, data: buf };
  }
}

export function buildCapabilitiesResponse(version: number): Buffer {
  // Kopf: Cmd 5, Sp 0, cbId 0
  return writer().uint8(DVC_CMD_CAPABILITY << 4).uint8(0).uint16le(version).toBuffer();
}

export function buildCreateResponse(channelId: number, status: number): Buffer {
  const { cbId, bytes } = writeChannelId(channelId);
  return writer()
    .uint8((DVC_CMD_CREATE << 4) | cbId)
    .bytes(bytes)
    .uint32le(status >>> 0)
    .toBuffer();
}

export function buildData(channelId: number, data: Buffer): Buffer {
  const { cbId, bytes } = writeChannelId(channelId);
  return writer()
    .uint8((DVC_CMD_DATA << 4) | cbId)
    .bytes(bytes)
    .bytes(data)
    .toBuffer();
}

export function buildClose(channelId: number): Buffer {
  const { cbId, bytes } = writeChannelId(channelId);
  return writer()
    .uint8((DVC_CMD_CLOSE << 4) | cbId)
    .bytes(bytes)
    .toBuffer();
}
