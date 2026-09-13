/**
 * Minimaler DER-Encoder/-Decoder.
 *
 * Es wird nur der Ausschnitt abgedeckt, den CredSSP (MS-CSSP) braucht:
 * SEQUENCE, INTEGER, OCTET STRING und kontextspezifische Tags. Bewusst kein
 * generischer ASN.1-Stack - weniger Code, weniger Angriffsflaeche.
 */

export const TAG_INTEGER = 0x02;
export const TAG_OCTET_STRING = 0x04;
export const TAG_SEQUENCE = 0x30;

/** Laengenpraefix nach DER: kurz (<128) oder lang mit Byte-Anzahl. */
export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encodeTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export function encodeInteger(value: number): Buffer {
  if (value < 0) throw new Error('DER: negative INTEGER werden nicht unterstuetzt');
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  // Fuehrendes 0x00, damit der Wert nicht als negativ gelesen wird.
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return encodeTlv(TAG_INTEGER, Buffer.from(bytes));
}

export function encodeOctetString(content: Buffer): Buffer {
  return encodeTlv(TAG_OCTET_STRING, content);
}

export function encodeSequence(...parts: Buffer[]): Buffer {
  return encodeTlv(TAG_SEQUENCE, Buffer.concat(parts));
}

/** [n] EXPLICIT - konstruiertes kontextspezifisches Tag. */
export function encodeContext(n: number, content: Buffer): Buffer {
  return encodeTlv(0xa0 | n, content);
}

export interface DerElement {
  tag: number;
  content: Buffer;
  /** Offset direkt hinter diesem Element im Ausgangspuffer. */
  end: number;
}

export function readElement(buf: Buffer, offset = 0): DerElement {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('DER: ungültiger Offset');
  if (offset + 2 > buf.length) throw new Error('DER: Puffer zu kurz fuer Tag/Laenge');
  const tag = buf[offset];
  let pos = offset + 1;
  let len = buf[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error(`DER: nicht unterstuetzte Laengenkodierung (${n} Bytes)`);
    if (pos + n > buf.length) throw new Error('DER: abgeschnittenes Laengenfeld');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  if (pos + len > buf.length) throw new Error('DER: Element reicht ueber das Pufferende hinaus');
  return { tag, content: buf.subarray(pos, pos + len), end: pos + len };
}

/** Iteriert ueber die direkten Kindelemente eines konstruierten Elements. */
export function* children(content: Buffer): Generator<DerElement> {
  let offset = 0;
  while (offset < content.length) {
    const el = readElement(content, offset);
    yield el;
    offset = el.end;
  }
}

export function decodeInteger(content: Buffer): number {
  let v = 0;
  for (const b of content) v = v * 256 + b;
  return v;
}

/**
 * Gesamtlaenge eines DER-Elements ab `offset`, oder -1 wenn der Puffer noch
 * unvollstaendig ist. Wird gebraucht, um TSRequests aus dem TLS-Stream zu
 * schneiden, bevor man sie parsen kann.
 */
export function elementLength(buf: Buffer, offset = 0): number {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('DER: ungültiger Offset');
  if (buf.length - offset < 2) return -1;
  let pos = offset + 1;
  let len = buf[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error(`DER: nicht unterstuetzte Laengenkodierung (${n} Bytes)`);
    if (buf.length - pos < n) return -1;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  const total = pos - offset + len;
  return buf.length - offset < total ? -1 : total;
}
