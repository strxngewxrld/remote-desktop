/**
 * BER-Kodierung fuer die MCS-Connect-PDUs (T.125). Nur die verwendeten
 * Universaltypen: BOOLEAN, INTEGER, OCTET STRING, ENUMERATED, SEQUENCE und
 * Application-Tags.
 */
import { BinaryReader, writer } from '../core/binary.js';

export const BER_BOOLEAN = 1;
export const BER_INTEGER = 2;
export const BER_OCTET_STRING = 4;
export const BER_ENUMERATED = 10;
export const BER_SEQUENCE = 16;

const CLASS_UNIVERSAL = 0x00;
const CLASS_APPLICATION = 0x40;
const CLASS_CONTEXT = 0x80;
const PC_CONSTRUCT = 0x20;

export function writeLength(size: number): Buffer {
  if (size > 0x7f) {
    const b = Buffer.allocUnsafe(3);
    b.writeUInt8(0x82, 0);
    b.writeUInt16BE(size, 1);
    return b;
  }
  return Buffer.from([size]);
}

export function writeUniversalTag(tag: number, constructed: boolean): Buffer {
  return Buffer.from([(CLASS_UNIVERSAL | (constructed ? PC_CONSTRUCT : 0)) | tag]);
}

export function writeApplicationTag(tag: number, size: number): Buffer {
  if (tag > 30) {
    return Buffer.concat([
      Buffer.from([CLASS_APPLICATION | PC_CONSTRUCT | 0x1f, tag]),
      writeLength(size),
    ]);
  }
  return Buffer.concat([Buffer.from([CLASS_APPLICATION | PC_CONSTRUCT | tag]), writeLength(size)]);
}

export function writeBoolean(value: boolean): Buffer {
  return Buffer.concat([writeUniversalTag(BER_BOOLEAN, false), writeLength(1), Buffer.from([value ? 0xff : 0x00])]);
}

export function writeInteger(value: number): Buffer {
  const body = (() => {
    if (value <= 0xff) return Buffer.from([value]);
    if (value <= 0xffff) {
      const b = Buffer.allocUnsafe(2);
      b.writeUInt16BE(value, 0);
      return b;
    }
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
  })();
  return Buffer.concat([writeUniversalTag(BER_INTEGER, false), writeLength(body.length), body]);
}

export function writeOctetString(value: Buffer): Buffer {
  return Buffer.concat([writeUniversalTag(BER_OCTET_STRING, false), writeLength(value.length), value]);
}

export function writeEnumerated(value: number): Buffer {
  return Buffer.concat([writeUniversalTag(BER_ENUMERATED, false), writeLength(1), Buffer.from([value])]);
}

export function writeSequence(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeUniversalTag(BER_SEQUENCE, true), writeLength(body.length), body]);
}

export function writeContext(tag: number, value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([CLASS_CONTEXT | PC_CONSTRUCT | tag]),
    writeLength(value.length),
    value,
  ]);
}

export function readLength(r: BinaryReader): number {
  const first = r.uint8();
  if (first & 0x80) {
    const count = first & 0x7f;
    let size = 0;
    for (let i = 0; i < count; i++) size = (size << 8) | r.uint8();
    return size;
  }
  return first;
}

/** Prueft das erwartete Universal-Tag und liefert die Inhaltslaenge. */
export function readUniversalTag(r: BinaryReader, tag: number, constructed: boolean): number {
  const b = r.uint8();
  const expected = (CLASS_UNIVERSAL | (constructed ? PC_CONSTRUCT : 0)) | tag;
  if (b !== expected) {
    throw new Error(`BER: erwartetes Tag 0x${expected.toString(16)}, gelesen 0x${b.toString(16)}`);
  }
  return readLength(r);
}

export function readApplicationTag(r: BinaryReader, tag: number): number {
  let b = r.uint8();
  if (tag > 30) {
    if (b !== (CLASS_APPLICATION | PC_CONSTRUCT | 0x1f)) throw new Error('BER: ungueltiges Application-Tag');
    const t = r.uint8();
    if (t !== tag) throw new Error(`BER: erwartetes Application-Tag ${tag}, gelesen ${t}`);
  } else if (b !== (CLASS_APPLICATION | PC_CONSTRUCT | tag)) {
    throw new Error(`BER: erwartetes Application-Tag ${tag}, gelesen 0x${b.toString(16)}`);
  }
  return readLength(r);
}

export function readInteger(r: BinaryReader): number {
  const size = readUniversalTag(r, BER_INTEGER, false);
  if (size === 1) return r.uint8();
  if (size === 2) return r.uint16be();
  if (size === 3) {
    const pad = r.uint8();
    return (pad << 16) | r.uint16be();
  }
  if (size === 4) return r.uint32be();
  throw new Error(`BER: INTEGER mit ${size} Bytes wird nicht unterstuetzt`);
}

export function readEnumerated(r: BinaryReader): number {
  const size = readUniversalTag(r, BER_ENUMERATED, false);
  if (size !== 1) throw new Error('BER: ENUMERATED muss genau 1 Byte haben');
  return r.uint8();
}

export function readOctetString(r: BinaryReader): Buffer {
  const size = readUniversalTag(r, BER_OCTET_STRING, false);
  return r.bytes(size);
}

export function readBoolean(r: BinaryReader): boolean {
  const size = readUniversalTag(r, BER_BOOLEAN, false);
  if (size !== 1) throw new Error('BER: BOOLEAN muss genau 1 Byte haben');
  return r.uint8() !== 0;
}

/** Hilfsfunktion: Application-Tag mit korrekt berechneter Laenge umschliessen. */
export function wrapApplication(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeApplicationTag(tag, body.length), body]);
}

export { writer };
