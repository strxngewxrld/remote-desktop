/**
 * Share-Control-/Share-Data-Ebene (MS-RDPBCGR 2.2.8.1.1.1) sowie die PDUs der
 * Aktivierungssequenz und die Eingabeereignisse.
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';
import { CapabilitySet, parseCapabilities, serializeCapabilities, ServerCapabilities } from './caps.js';
import {
  CTRLACTION_COOPERATE,
  CTRLACTION_REQUEST_CONTROL,
  INPUT_EVENT_MOUSE,
  INPUT_EVENT_MOUSEX,
  INPUT_EVENT_SCANCODE,
  INPUT_EVENT_SYNC,
  INPUT_EVENT_UNICODE,
  PDUTYPE_CONFIRMACTIVEPDU,
  PDUTYPE_DATAPDU,
  PDUTYPE2_CONTROL,
  PDUTYPE2_FONTLIST,
  PDUTYPE2_INPUT,
  PDUTYPE2_SHUTDOWN_REQUEST,
  PDUTYPE2_SUPPRESS_OUTPUT,
  PDUTYPE2_REFRESH_RECT,
  PDUTYPE2_SYNCHRONIZE,
  PDU_PROTOCOL_VERSION,
} from './constants.js';

export interface ShareControlHeader {
  totalLength: number;
  pduType: number;
  pduSource: number;
}

export function readShareControlHeader(r: BinaryReader): ShareControlHeader {
  const totalLength = r.uint16le();
  const pduType = r.uint16le();
  const pduSource = totalLength > 4 ? r.uint16le() : 0;
  return { totalLength, pduType: pduType & 0x0f, pduSource };
}

export function writeShareControlHeader(pduType: number, userId: number, body: Buffer): Buffer {
  return Buffer.concat([
    writer()
      .uint16le(body.length + 6)
      .uint16le(pduType | PDU_PROTOCOL_VERSION)
      .uint16le(userId)
      .toBuffer(),
    body,
  ]);
}

/**
 * Heuristik: beginnt der Puffer mit einem Share Control Header (statt mit einem
 * Security Header)? Unter TLS/NLA fehlt der Security Header bei allen PDUs
 * ausser den Lizenz-PDUs, ein Unterscheidungsmerkmal gibt es im Header selbst
 * nicht - also wird die Struktur auf Plausibilitaet geprueft.
 */
export function looksLikeShareControl(buf: Buffer): boolean {
  if (buf.length < 6) return false;
  const totalLength = buf.readUInt16LE(0);
  const pduType = buf.readUInt16LE(2);
  if ((pduType & 0xf0) !== PDU_PROTOCOL_VERSION) return false;
  const type = pduType & 0x0f;
  if (![1, 3, 6, 7, 10].includes(type)) return false;
  return totalLength >= 6 && totalLength <= buf.length;
}

export interface ShareDataHeader {
  shareId: number;
  streamId: number;
  uncompressedLength: number;
  pduType2: number;
  compressedType: number;
  compressedLength: number;
}

export function readShareDataHeader(r: BinaryReader): ShareDataHeader {
  const shareId = r.uint32le();
  r.uint8(); // pad
  const streamId = r.uint8();
  const uncompressedLength = r.uint16le();
  const pduType2 = r.uint8();
  const compressedType = r.uint8();
  const compressedLength = r.uint16le();
  return { shareId, streamId, uncompressedLength, pduType2, compressedType, compressedLength };
}

export function writeShareDataHeader(shareId: number, pduType2: number, body: Buffer): Buffer {
  return Buffer.concat([
    writer()
      .uint32le(shareId)
      .uint8(0) // pad
      .uint8(1) // streamId: STREAM_LOW
      .uint16le(body.length + 18)
      .uint8(pduType2)
      .uint8(0) // compressedType
      .uint16le(0) // compressedLength
      .toBuffer(),
    body,
  ]);
}

export interface DemandActive {
  shareId: number;
  sourceDescriptor: string;
  capabilities: ServerCapabilities;
}

export function parseDemandActive(r: BinaryReader): DemandActive {
  const shareId = r.uint32le();
  const lengthSourceDescriptor = r.uint16le();
  r.uint16le(); // lengthCombinedCapabilities
  const sourceDescriptor = r.ascii(lengthSourceDescriptor);
  const numberCapabilities = r.uint16le();
  r.uint16le(); // pad
  const capabilities = parseCapabilities(r, numberCapabilities);
  return { shareId, sourceDescriptor, capabilities };
}

export function buildConfirmActive(shareId: number, userId: number, caps: CapabilitySet[]): Buffer {
  const source = Buffer.from('rdp-ts\0', 'ascii');
  const capsBuf = serializeCapabilities(caps);
  const body = writer()
    .uint32le(shareId)
    .uint16le(0x03ea) // originatorId: Server-Kanal
    .uint16le(source.length)
    .uint16le(capsBuf.length + 4)
    .bytes(source)
    .uint16le(caps.length)
    .uint16le(0)
    .bytes(capsBuf)
    .toBuffer();
  return writeShareControlHeader(PDUTYPE_CONFIRMACTIVEPDU, userId, body);
}

export function buildSynchronize(shareId: number, userId: number, targetUser: number): Buffer {
  const body = writer().uint16le(1).uint16le(targetUser).toBuffer();
  return writeShareControlHeader(PDUTYPE_DATAPDU, userId, writeShareDataHeader(shareId, PDUTYPE2_SYNCHRONIZE, body));
}

export function buildControl(shareId: number, userId: number, action: number): Buffer {
  const body = writer().uint16le(action).uint16le(0).uint32le(0).toBuffer();
  return writeShareControlHeader(PDUTYPE_DATAPDU, userId, writeShareDataHeader(shareId, PDUTYPE2_CONTROL, body));
}

export const buildControlCooperate = (shareId: number, userId: number): Buffer =>
  buildControl(shareId, userId, CTRLACTION_COOPERATE);

export const buildControlRequest = (shareId: number, userId: number): Buffer =>
  buildControl(shareId, userId, CTRLACTION_REQUEST_CONTROL);

export function buildFontList(shareId: number, userId: number): Buffer {
  const body = writer()
    .uint16le(0) // numberFonts
    .uint16le(0) // totalNumFonts
    .uint16le(0x0003) // listFlags: FONTLIST_FIRST | FONTLIST_LAST
    .uint16le(0x0032) // entrySize
    .toBuffer();
  return writeShareControlHeader(PDUTYPE_DATAPDU, userId, writeShareDataHeader(shareId, PDUTYPE2_FONTLIST, body));
}

export function buildShutdownRequest(shareId: number, userId: number): Buffer {
  return writeShareControlHeader(
    PDUTYPE_DATAPDU,
    userId,
    writeShareDataHeader(shareId, PDUTYPE2_SHUTDOWN_REQUEST, Buffer.alloc(0)),
  );
}

/** Fordert den Server auf, den angegebenen Bereich neu zu senden. */
export function buildRefreshRect(shareId: number, userId: number, rects: Rect[]): Buffer {
  const w = writer().uint8(rects.length).zeros(3);
  for (const rect of rects) {
    w.uint16le(rect.left).uint16le(rect.top).uint16le(rect.right).uint16le(rect.bottom);
  }
  return writeShareControlHeader(
    PDUTYPE_DATAPDU,
    userId,
    writeShareDataHeader(shareId, PDUTYPE2_REFRESH_RECT, w.toBuffer()),
  );
}

/** Schaltet die Bildaktualisierung ab oder wieder an (z.B. wenn das Panel verdeckt ist). */
export function buildSuppressOutput(shareId: number, userId: number, allow: boolean, rect?: Rect): Buffer {
  const w = writer().uint8(allow ? 1 : 0).zeros(3);
  if (allow && rect) {
    w.uint16le(rect.left).uint16le(rect.top).uint16le(rect.right).uint16le(rect.bottom);
  }
  return writeShareControlHeader(
    PDUTYPE_DATAPDU,
    userId,
    writeShareDataHeader(shareId, PDUTYPE2_SUPPRESS_OUTPUT, w.toBuffer()),
  );
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface InputEvent {
  messageType: number;
  /** Erstes 16-Bit-Feld: Flags (Tastatur/Maus). */
  flags: number;
  /** Zweites Feld: Scancode, Unicode-Zeichen oder X-Koordinate. */
  param1: number;
  /** Drittes Feld: Y-Koordinate oder Padding. */
  param2: number;
}

export function buildInputPdu(shareId: number, userId: number, events: InputEvent[]): Buffer {
  const w = writer().uint16le(events.length).uint16le(0);
  for (const e of events) {
    w.uint32le(0) // eventTime: 0 = "jetzt"
      .uint16le(e.messageType)
      .uint16le(e.flags)
      .uint16le(e.param1)
      .uint16le(e.param2);
  }
  return writeShareControlHeader(
    PDUTYPE_DATAPDU,
    userId,
    writeShareDataHeader(shareId, PDUTYPE2_INPUT, w.toBuffer()),
  );
}

export const scancodeEvent = (flags: number, scancode: number): InputEvent => ({
  messageType: INPUT_EVENT_SCANCODE,
  flags,
  param1: scancode,
  param2: 0,
});

export const unicodeEvent = (flags: number, code: number): InputEvent => ({
  messageType: INPUT_EVENT_UNICODE,
  flags,
  param1: code,
  param2: 0,
});

export const mouseEvent = (flags: number, x: number, y: number): InputEvent => ({
  messageType: INPUT_EVENT_MOUSE,
  flags,
  param1: x,
  param2: y,
});

export const mouseExEvent = (flags: number, x: number, y: number): InputEvent => ({
  messageType: INPUT_EVENT_MOUSEX,
  flags,
  param1: x,
  param2: y,
});

/** Synchronisiert den Zustand der Feststelltasten (Num/Caps/Scroll). */
export const syncEvent = (toggleFlags: number): InputEvent => ({
  messageType: INPUT_EVENT_SYNC,
  flags: 0,
  param1: toggleFlags & 0xffff,
  param2: (toggleFlags >> 16) & 0xffff,
});

export function expectShareControl(r: BinaryReader, expected: number): ShareControlHeader {
  const header = readShareControlHeader(r);
  if (header.pduType !== expected) {
    throw new RdpProtocolError(`Erwartet wurde PDU-Typ ${expected}, empfangen ${header.pduType}`);
  }
  return header;
}
