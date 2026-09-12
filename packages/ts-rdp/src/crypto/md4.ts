/**
 * MD4 (RFC 1320).
 *
 * Node liefert MD4 seit OpenSSL 3 nicht mehr ueber den Default-Provider, NTLM
 * braucht es aber zwingend fuer den NT-Hash. Darum hier eine eigenstaendige
 * Implementierung. MD4 wird hier ausschliesslich als Baustein des NTLM-Hashes
 * verwendet und nie als kryptografische Hashfunktion im eigentlichen Sinn.
 */

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function md4(data: Buffer): Buffer {
  const bitLen = data.length * 8;
  // Padding: 0x80, dann Nullen bis Laenge % 64 === 56, dann 64-Bit-Laenge (LE).
  const padded = Buffer.alloc(((data.length + 8) >> 6) * 64 + 64);
  data.copy(padded);
  padded[data.length] = 0x80;
  padded.writeUInt32LE(bitLen >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLen / 0x100000000), padded.length - 4);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const x = new Array<number>(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];

    // Runde 1: F(x,y,z) = (x & y) | (~x & z)
    const f = (p: number, q: number, r: number) => (p & q) | (~p & r);
    const r1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const s1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) {
      const k = r1[i], s = s1[i % 4];
      if (i % 4 === 0) a = rotl((a + f(b, c, d) + x[k]) >>> 0, s);
      else if (i % 4 === 1) d = rotl((d + f(a, b, c) + x[k]) >>> 0, s);
      else if (i % 4 === 2) c = rotl((c + f(d, a, b) + x[k]) >>> 0, s);
      else b = rotl((b + f(c, d, a) + x[k]) >>> 0, s);
    }

    // Runde 2: G(x,y,z) = (x & y) | (x & z) | (y & z), Konstante 0x5a827999
    const g = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
    const r2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const s2 = [3, 5, 9, 13];
    for (let i = 0; i < 16; i++) {
      const k = r2[i], s = s2[i % 4];
      if (i % 4 === 0) a = rotl((a + g(b, c, d) + x[k] + 0x5a827999) >>> 0, s);
      else if (i % 4 === 1) d = rotl((d + g(a, b, c) + x[k] + 0x5a827999) >>> 0, s);
      else if (i % 4 === 2) c = rotl((c + g(d, a, b) + x[k] + 0x5a827999) >>> 0, s);
      else b = rotl((b + g(c, d, a) + x[k] + 0x5a827999) >>> 0, s);
    }

    // Runde 3: H(x,y,z) = x ^ y ^ z, Konstante 0x6ed9eba1
    const h = (p: number, q: number, r: number) => p ^ q ^ r;
    const r3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const s3 = [3, 9, 11, 15];
    for (let i = 0; i < 16; i++) {
      const k = r3[i], s = s3[i % 4];
      if (i % 4 === 0) a = rotl((a + h(b, c, d) + x[k] + 0x6ed9eba1) >>> 0, s);
      else if (i % 4 === 1) d = rotl((d + h(a, b, c) + x[k] + 0x6ed9eba1) >>> 0, s);
      else if (i % 4 === 2) c = rotl((c + h(d, a, b) + x[k] + 0x6ed9eba1) >>> 0, s);
      else b = rotl((b + h(c, d, a) + x[k] + 0x6ed9eba1) >>> 0, s);
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = Buffer.allocUnsafe(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}
