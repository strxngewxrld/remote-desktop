/**
 * PER (Packed Encoding Rules, ALIGNED) - so viel wie GCC und die MCS-Domain-
 * PDUs davon benoetigen (T.124 / T.125).
 */
import { BinaryReader, writer } from '../core/binary.js';

export function writeLength(value: number): Buffer {
  if (value > 0x7f) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(value | 0x8000, 0);
    return b;
  }
  return Buffer.from([value]);
}

export function readLength(r: BinaryReader): number {
  const first = r.uint8();
  if (first & 0x80) return ((first & 0x7f) << 8) | r.uint8();
  return first;
}

export function writeChoice(choice: number): Buffer {
  return Buffer.from([choice]);
}

export function readChoice(r: BinaryReader): number {
  return r.uint8();
}

export function writeSelection(selection: number): Buffer {
  return Buffer.from([selection]);
}

export function readSelection(r: BinaryReader): number {
  return r.uint8();
}

export function writeNumberOfSet(n: number): Buffer {
  return Buffer.from([n]);
}

export function readNumberOfSet(r: BinaryReader): number {
  return r.uint8();
}

export function writeEnumerates(value: number): Buffer {
  return Buffer.from([value]);
}

export function readEnumerates(r: BinaryReader): number {
  return r.uint8();
}

/** OID als 6 Komponenten, wie es T.124 fuer den Conference-Identifier nutzt. */
export function writeObjectIdentifier(oid: number[]): Buffer {
  return Buffer.from([5, (oid[0] << 4) | oid[1], oid[2], oid[3], oid[4], oid[5]]);
}

export function readObjectIdentifier(r: BinaryReader, expected: number[]): void {
  const size = r.uint8();
  if (size !== 5) throw new Error('PER: OID muss 5 Bytes lang sein');
  const b = r.bytes(5);
  const oid = [b[0] >> 4, b[0] & 0x0f, b[1], b[2], b[3], b[4]];
  for (let i = 0; i < 6; i++) {
    if (oid[i] !== expected[i]) throw new Error(`PER: unerwarteter Object Identifier ${oid.join('.')}`);
  }
}

/** NumericString, 2 Ziffern pro Byte (BCD-artig), wie in T.124 verlangt. */
export function writeNumericString(str: string, minValue: number): Buffer {
  const length = str.length;
  const mlength = length - minValue >= 0 ? length - minValue : minValue;
  const w = writer().bytes(writeLength(mlength));
  for (let i = 0; i < length; i += 2) {
    const c1 = (str.charCodeAt(i) - 0x30) % 10;
    const c2 = i + 1 < length ? (str.charCodeAt(i + 1) - 0x30) % 10 : 0;
    w.uint8((c1 << 4) | c2);
  }
  return w.toBuffer();
}

export function writePadding(n: number): Buffer {
  return Buffer.alloc(n);
}

export function writeOctetStream(data: Buffer | string, minValue = 0): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'ascii') : data;
  const mlength = buf.length - minValue >= 0 ? buf.length - minValue : minValue;
  return Buffer.concat([writeLength(mlength), buf]);
}

export function readOctetStream(r: BinaryReader, expected: string, minValue = 0): void {
  const size = readLength(r) + minValue;
  if (size !== expected.length) {
    throw new Error(`PER: OctetStream-Laenge ${size} passt nicht zu "${expected}"`);
  }
  const actual = r.bytes(size).toString('ascii');
  if (actual !== expected) throw new Error(`PER: erwartet "${expected}", gelesen "${actual}"`);
}

export function writeInteger16(value: number, minimum = 0): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(value - minimum, 0);
  return b;
}

export function readInteger16(r: BinaryReader, minimum = 0): number {
  return r.uint16be() + minimum;
}

export function writeInteger(value: number): Buffer {
  if (value < 0x80) return Buffer.from([1, value]);
  if (value < 0x8000) {
    const b = Buffer.allocUnsafe(3);
    b.writeUInt8(2, 0);
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.allocUnsafe(5);
  b.writeUInt8(4, 0);
  b.writeUInt32BE(value >>> 0, 1);
  return b;
}

export function readInteger(r: BinaryReader): number {
  const size = r.uint8();
  if (size === 1) return r.uint8();
  if (size === 2) return r.uint16be();
  if (size === 4) return r.uint32be();
  throw new Error(`PER: INTEGER mit ${size} Bytes wird nicht unterstuetzt`);
}
