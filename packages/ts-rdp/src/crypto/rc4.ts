/**
 * RC4 als zustandsbehafteter Stromchiffre-Handle.
 *
 * NTLM/CredSSP sealen jede Nachricht mit demselben fortlaufenden RC4-Strom pro
 * Richtung - deshalb reicht eine zustandslose Funktion nicht aus, der Zustand
 * muss ueber Nachrichten hinweg erhalten bleiben.
 */
export class Rc4 {
  private s: Uint8Array;
  private i = 0;
  private j = 0;

  constructor(key: Buffer) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 0xff;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
    }
    this.s = s;
  }

  update(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    let { i, j } = this;
    const s = this.s;
    for (let n = 0; n < data.length; n++) {
      i = (i + 1) & 0xff;
      j = (j + s[i]) & 0xff;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
      out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
    }
    this.i = i;
    this.j = j;
    return out;
  }
}

/** Einmalige RC4-Operation mit frischem Zustand. */
export function rc4(key: Buffer, data: Buffer): Buffer {
  return new Rc4(key).update(data);
}
