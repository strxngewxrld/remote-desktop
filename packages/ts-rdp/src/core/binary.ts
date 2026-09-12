/**
 * Little-/Big-Endian Lese- und Schreibhelfer.
 *
 * RDP ist ein Mischmasch: TPKT/X.224/ASN.1 sind Big Endian, praktisch alles
 * oberhalb von MCS ist Little Endian. Diese beiden Klassen kapseln das, damit
 * der Protokollcode nicht dauernd Offsets mitzaehlen muss.
 */

export class BinaryReader {
  private _offset = 0;

  constructor(public readonly buffer: Buffer, offset = 0) {
    this._offset = offset;
  }

  get offset(): number {
    return this._offset;
  }

  set offset(value: number) {
    if (value < 0 || value > this.buffer.length) {
      throw new RangeError(`offset ${value} ausserhalb des Puffers (${this.buffer.length})`);
    }
    this._offset = value;
  }

  get remaining(): number {
    return this.buffer.length - this._offset;
  }

  get eof(): boolean {
    return this._offset >= this.buffer.length;
  }

  private take(n: number): number {
    const start = this._offset;
    if (start + n > this.buffer.length) {
      throw new RangeError(`Lesen ueber das Pufferende hinaus: ${n} Byte bei Offset ${start} von ${this.buffer.length}`);
    }
    this._offset += n;
    return start;
  }

  uint8(): number {
    return this.buffer.readUInt8(this.take(1));
  }

  int8(): number {
    return this.buffer.readInt8(this.take(1));
  }

  uint16le(): number {
    return this.buffer.readUInt16LE(this.take(2));
  }

  uint16be(): number {
    return this.buffer.readUInt16BE(this.take(2));
  }

  int16le(): number {
    return this.buffer.readInt16LE(this.take(2));
  }

  uint32le(): number {
    return this.buffer.readUInt32LE(this.take(4));
  }

  uint32be(): number {
    return this.buffer.readUInt32BE(this.take(4));
  }

  int32le(): number {
    return this.buffer.readInt32LE(this.take(4));
  }

  bytes(n: number): Buffer {
    return this.buffer.subarray(this.take(n), this._offset);
  }

  /** Rest des Puffers ab aktueller Position. */
  rest(): Buffer {
    return this.bytes(this.remaining);
  }

  /** UTF-16LE-String fester Byte-Laenge; abschliessende NUL-Zeichen werden entfernt. */
  utf16le(byteLength: number): string {
    return this.bytes(byteLength).toString('ucs2').replace(/\0+$/, '');
  }

  ascii(byteLength: number): string {
    return this.bytes(byteLength).toString('ascii').replace(/\0+$/, '');
  }

  skip(n: number): this {
    this.take(n);
    return this;
  }

  /** Liest einen Unterbereich als eigenen Reader, ohne den Puffer zu kopieren. */
  sub(n: number): BinaryReader {
    return new BinaryReader(this.bytes(n));
  }
}

export class BinaryWriter {
  private chunks: Buffer[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  private push(b: Buffer): this {
    this.chunks.push(b);
    this._length += b.length;
    return this;
  }

  uint8(v: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v & 0xff, 0);
    return this.push(b);
  }

  uint16le(v: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v & 0xffff, 0);
    return this.push(b);
  }

  uint16be(v: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(v & 0xffff, 0);
    return this.push(b);
  }

  int16le(v: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16LE(v, 0);
    return this.push(b);
  }

  uint32le(v: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
    return this.push(b);
  }

  uint32be(v: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(v >>> 0, 0);
    return this.push(b);
  }

  bytes(b: Buffer | Uint8Array): this {
    return this.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
  }

  /** n Nullbytes (Padding/Reservefelder). */
  zeros(n: number): this {
    return n > 0 ? this.push(Buffer.alloc(n)) : this;
  }

  ascii(s: string, fixedLength?: number): this {
    const b = Buffer.from(s, 'ascii');
    if (fixedLength === undefined) return this.push(b);
    const out = Buffer.alloc(fixedLength);
    b.copy(out, 0, 0, Math.min(b.length, fixedLength));
    return this.push(out);
  }

  /**
   * UTF-16LE-String. `fixedLength` ist die Gesamtgroesse in Bytes inklusive
   * Padding; ohne Angabe wird der String ohne Terminator geschrieben.
   */
  utf16le(s: string, fixedLength?: number): this {
    const b = Buffer.from(s, 'ucs2');
    if (fixedLength === undefined) return this.push(b);
    const out = Buffer.alloc(fixedLength);
    b.copy(out, 0, 0, Math.min(b.length, fixedLength));
    return this.push(out);
  }

  /** UTF-16LE inklusive abschliessendem NUL (RDP-Konvention fuer Info-Strings). */
  utf16leNul(s: string): this {
    return this.push(Buffer.from(s + '\0', 'ucs2'));
  }

  concat(other: BinaryWriter): this {
    for (const c of other.chunks) this.push(c);
    return this;
  }

  toBuffer(): Buffer {
    if (this.chunks.length === 1) return this.chunks[0];
    const out = Buffer.concat(this.chunks, this._length);
    this.chunks = [out];
    return out;
  }
}

/** Kurzform fuer `new BinaryWriter()`. */
export function writer(): BinaryWriter {
  return new BinaryWriter();
}

/** Kurzform fuer `new BinaryReader(buf)`. */
export function reader(buf: Buffer, offset = 0): BinaryReader {
  return new BinaryReader(buf, offset);
}
