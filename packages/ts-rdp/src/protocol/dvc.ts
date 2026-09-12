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
import { CHANNEL_CHUNK_LENGTH } from './virtualChannel.js';

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

/**
 * DYNVC_DATA_FIRST (MS-RDPEDYC 2.2.3.1): erster Teil einer Nachricht, die
 * nicht in ein einzelnes PDU passt. `Sp` kodiert die Breite der Gesamtlaenge
 * genau wie `cbId` die der Kanal-ID.
 */
export function buildDataFirst(channelId: number, totalLength: number, data: Buffer): Buffer {
  const { cbId, bytes } = writeChannelId(channelId);
  const sp = totalLength <= 0xff ? 0 : totalLength <= 0xffff ? 1 : 2;
  const w = writer()
    .uint8((DVC_CMD_DATA_FIRST << 4) | (sp << 2) | cbId)
    .bytes(bytes);
  if (sp === 0) w.uint8(totalLength);
  else if (sp === 1) w.uint16le(totalLength);
  else w.uint32le(totalLength >>> 0);
  return w.bytes(data).toBuffer();
}

/**
 * Nutzdaten eines dynamischen Kanals in sendefertige DVC-PDUs zerlegen.
 *
 * Jedes DVC-PDU reist als Nachricht des statischen Kanals `drdynvc` und darf
 * dessen Chunkgroesse nicht ueberschreiten - genau dafuer gibt es
 * DATA_FIRST/DATA. Passt alles in ein PDU, entsteht ein einzelnes DATA ohne
 * Laengenfeld; sonst traegt das erste PDU die Gesamtlaenge und die folgenden
 * sind schlichte DATA-Stuecke.
 *
 * `maxPduSize` ist die Groesse des *ganzen* PDU einschliesslich Kopf.
 */
export function buildDataSegments(
  channelId: number,
  data: Buffer,
  maxPduSize = CHANNEL_CHUNK_LENGTH,
): Buffer[] {
  const { bytes } = writeChannelId(channelId);
  const kopfData = 1 + bytes.length;
  if (data.length + kopfData <= maxPduSize) return [buildData(channelId, data)];

  // Breite des Gesamtlaengenfelds im ersten PDU.
  const spBreite = data.length <= 0xff ? 1 : data.length <= 0xffff ? 2 : 4;
  const kopfFirst = kopfData + spBreite;
  const platzFirst = maxPduSize - kopfFirst;
  const platzData = maxPduSize - kopfData;
  if (platzFirst <= 0 || platzData <= 0) {
    throw new RdpProtocolError(`DVC: Chunkgroesse ${maxPduSize} ist zu klein fuer einen Kopf`);
  }

  const teile: Buffer[] = [buildDataFirst(channelId, data.length, data.subarray(0, platzFirst))];
  for (let offset = platzFirst; offset < data.length; offset += platzData) {
    teile.push(buildData(channelId, data.subarray(offset, Math.min(offset + platzData, data.length))));
  }
  return teile;
}
