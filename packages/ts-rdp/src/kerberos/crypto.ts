/**
 * Kerberos-Verschluesselung fuer AES (RFC 3961 und RFC 3962).
 *
 * Nur die beiden Verfahren, die eine Windows-Domaene heute verwendet:
 * aes256-cts-hmac-sha1-96 (18) und aes128-cts-hmac-sha1-96 (17). RC4-HMAC
 * fehlt bewusst - Microsoft schaltet es ab, und ein Client, der es anbietet,
 * laedt den KDC zu einem schwaecheren Ticket ein.
 *
 * Aufbau nach RFC 3961 Abschnitt 5.3 ("simplified profile"):
 *   - Basisschluessel aus dem Passwort: PBKDF2-HMAC-SHA1, dann DK(..., "kerberos")
 *   - je Schluesselverwendung drei abgeleitete Schluessel:
 *       Ke = DK(K, usage | 0xAA)  Verschluesselung
 *       Ki = DK(K, usage | 0x55)  Integritaet der Nachricht
 *       Kc = DK(K, usage | 0x99)  Pruefsummen
 *   - verschluesselt wird Zufallspraefix || Klartext mit AES-CTS, angehaengt
 *     die ersten 96 Bit von HMAC-SHA1(Ki, Zufallspraefix || Klartext)
 */
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export const ETYPE_AES128_CTS_HMAC_SHA1_96 = 17;
export const ETYPE_AES256_CTS_HMAC_SHA1_96 = 18;

/** Pruefsummentypen (RFC 3962 Abschnitt 7). */
export const CKSUMTYPE_HMAC_SHA1_96_AES128 = 15;
export const CKSUMTYPE_HMAC_SHA1_96_AES256 = 16;

/** Unterstuetzte Verfahren, das staerkste zuerst - in dieser Reihenfolge angeboten. */
export const UNTERSTUETZTE_ETYPES = [ETYPE_AES256_CTS_HMAC_SHA1_96, ETYPE_AES128_CTS_HMAC_SHA1_96] as const;

/** Iterationen fuer PBKDF2, wenn der KDC nichts anderes sagt (RFC 3962 Abschnitt 4). */
export const STANDARD_ITERATIONEN = 4096;

const BLOCK = 16;
const HMAC_LAENGE = 12;

export interface KerberosSchluessel {
  etype: number;
  wert: Buffer;
}

export function istUnterstuetzt(etype: number): boolean {
  return etype === ETYPE_AES128_CTS_HMAC_SHA1_96 || etype === ETYPE_AES256_CTS_HMAC_SHA1_96;
}

function schluesselLaenge(etype: number): number {
  if (etype === ETYPE_AES128_CTS_HMAC_SHA1_96) return 16;
  if (etype === ETYPE_AES256_CTS_HMAC_SHA1_96) return 32;
  throw new Error(`Kerberos: Verschluesselungstyp ${etype} wird nicht unterstuetzt`);
}

function aesName(laenge: number, modus: 'cbc' | 'ecb'): string {
  return `aes-${laenge * 8}-${modus}`;
}

export function pruefsummenTyp(etype: number): number {
  return etype === ETYPE_AES128_CTS_HMAC_SHA1_96 ? CKSUMTYPE_HMAC_SHA1_96_AES128 : CKSUMTYPE_HMAC_SHA1_96_AES256;
}

// ------------------------------------------------------------------- n-fold

/**
 * n-fold (RFC 3961 Abschnitt 5.1): eine Bytefolge auf `bits` Bit strecken oder
 * stauchen. Die Eingabe wird wiederholt, jede Wiederholung um 13 Bit nach
 * rechts rotiert, und alles in Stuecken der Ziellaenge mit
 * Einerkomplement-Addition aufsummiert.
 */
export function nfold(eingabe: Buffer, bits: number): Buffer {
  const ausgabeBytes = bits / 8;
  const eingabeBytes = eingabe.length;
  const kgv = kleinstesGemeinsamesVielfaches(eingabeBytes, ausgabeBytes);
  const ergebnis = new Array<number>(ausgabeBytes).fill(0);
  const eingabeBits = eingabeBytes * 8;

  // Byte i der langen, rotierten Folge: Wiederholung r = floor(i / n),
  // um 13 * r Bit nach rechts rotiert.
  const bit = (index: number): number => {
    const r = Math.floor(index / eingabeBits);
    const innerhalb = index % eingabeBits;
    const quelle = (((innerhalb - 13 * r) % eingabeBits) + eingabeBits) % eingabeBits;
    return (eingabe[quelle >> 3]! >> (7 - (quelle & 7))) & 1;
  };

  for (let stueck = 0; stueck < kgv / ausgabeBytes; stueck++) {
    // Einerkomplement-Addition: von hinten nach vorn mit Uebertrag.
    let uebertrag = 0;
    for (let i = ausgabeBytes - 1; i >= 0; i--) {
      let byte = 0;
      const basis = (stueck * ausgabeBytes + i) * 8;
      for (let b = 0; b < 8; b++) byte = (byte << 1) | bit(basis + b);
      const summe = ergebnis[i]! + byte + uebertrag;
      ergebnis[i] = summe & 0xff;
      uebertrag = summe >> 8;
    }
    // Der Uebertrag ganz vorn wird hinten wieder aufaddiert - notfalls
    // mehrmals, wenn er dabei erneut ganz nach vorn durchlaeuft.
    while (uebertrag) {
      for (let i = ausgabeBytes - 1; uebertrag && i >= 0; i--) {
        const summe = ergebnis[i]! + uebertrag;
        ergebnis[i] = summe & 0xff;
        uebertrag = summe >> 8;
      }
    }
  }
  return Buffer.from(ergebnis);
}

function kleinstesGemeinsamesVielfaches(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return (a * b) / x;
}

// ------------------------------------------------------------------ AES-CTS

/**
 * AES im CBC-Modus mit Ciphertext Stealing (CBC-CS3, RFC 3962 Abschnitt 5),
 * Startvektor null. Genau ein Block wird schlicht verschluesselt; bei mehr
 * werden die letzten beiden Bloecke getauscht und der letzte gekuerzt.
 */
export function aesCtsVerschluesseln(schluessel: Buffer, klartext: Buffer, iv = Buffer.alloc(BLOCK)): Buffer {
  if (klartext.length < BLOCK) throw new Error('AES-CTS: mindestens ein ganzer Block ist noetig');
  const cbc = (daten: Buffer, start: Buffer) => {
    const c = createCipheriv(aesName(schluessel.length, 'cbc'), schluessel, start);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(daten), c.final()]);
  };
  if (klartext.length === BLOCK) return cbc(klartext, iv);

  const rest = klartext.length % BLOCK;
  const aufgefuellt = Buffer.concat([klartext, Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)]);
  const c = cbc(aufgefuellt, iv);
  const bloecke = c.length / BLOCK;
  const vorletzter = c.subarray((bloecke - 2) * BLOCK, (bloecke - 1) * BLOCK);
  const letzter = c.subarray((bloecke - 1) * BLOCK);
  const letzteLaenge = rest === 0 ? BLOCK : rest;
  return Buffer.concat([c.subarray(0, (bloecke - 2) * BLOCK), letzter, vorletzter.subarray(0, letzteLaenge)]);
}

export function aesCtsEntschluesseln(schluessel: Buffer, geheimtext: Buffer, iv = Buffer.alloc(BLOCK)): Buffer {
  if (geheimtext.length < BLOCK) throw new Error('AES-CTS: Geheimtext kuerzer als ein Block');
  const ecbEnt = (block: Buffer) => {
    const d = createDecipheriv(aesName(schluessel.length, 'ecb'), schluessel, null);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(block), d.final()]);
  };
  const cbcEnt = (daten: Buffer, start: Buffer) => {
    const d = createDecipheriv(aesName(schluessel.length, 'cbc'), schluessel, start);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(daten), d.final()]);
  };
  if (geheimtext.length === BLOCK) return cbcEnt(geheimtext, iv);

  const bloecke = Math.ceil(geheimtext.length / BLOCK);
  const letzteLaenge = geheimtext.length - (bloecke - 1) * BLOCK;
  const vorne = geheimtext.subarray(0, (bloecke - 2) * BLOCK);
  // Nach dem Tausch steht der volle Block C(n-1)' an vorletzter Stelle, der
  // gekuerzte C(n) am Ende.
  const cVorletzt = geheimtext.subarray((bloecke - 2) * BLOCK, (bloecke - 1) * BLOCK);
  const cLetzt = geheimtext.subarray((bloecke - 1) * BLOCK);
  const vorgaenger = vorne.length ? vorne.subarray(vorne.length - BLOCK) : iv;

  // D(C(n-1)') = P(n) XOR C(n) auf voller Laenge; die fehlenden Bytes von
  // C(n) sind genau die hinteren Bytes dieses Zwischenergebnisses.
  const zwischen = ecbEnt(cVorletzt);
  const cLetztVoll = Buffer.concat([cLetzt, zwischen.subarray(letzteLaenge)]);
  const pLetzt = Buffer.alloc(letzteLaenge);
  for (let i = 0; i < letzteLaenge; i++) pLetzt[i] = zwischen[i]! ^ cLetztVoll[i]!;
  const pVorletzt = cbcEnt(cLetztVoll, vorgaenger);
  const pVorne = vorne.length ? cbcEnt(vorne, iv) : Buffer.alloc(0);
  return Buffer.concat([pVorne, pVorletzt, pLetzt]);
}

// ------------------------------------------------------- Schluesselableitung

/** DR (RFC 3961 Abschnitt 5.1): Zufallsbytes aus Schluessel und Konstante. */
function dr(schluessel: Buffer, konstante: Buffer): Buffer {
  let block = konstante.length === BLOCK ? konstante : nfold(konstante, BLOCK * 8);
  const teile: Buffer[] = [];
  let laenge = 0;
  while (laenge < schluessel.length) {
    const c = createCipheriv(aesName(schluessel.length, 'ecb'), schluessel, null);
    c.setAutoPadding(false);
    block = Buffer.concat([c.update(block), c.final()]);
    teile.push(block);
    laenge += block.length;
  }
  return Buffer.concat(teile).subarray(0, schluessel.length);
}

/** DK = random-to-key(DR); bei AES ist random-to-key die Identitaet. */
export function dk(schluessel: Buffer, konstante: Buffer): Buffer {
  return dr(schluessel, konstante);
}

/** Konstante fuer eine Schluesselverwendung: 32 Bit Big Endian plus Art. */
function verwendung(usage: number, art: 0x99 | 0xaa | 0x55): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(usage >>> 0, 0);
  b[4] = art;
  return b;
}

/**
 * string-to-key (RFC 3962 Abschnitt 4). Das Salz ist normalerweise der Realm
 * in Grossbuchstaben gefolgt von den Namensteilen des Prinzipals - bei Windows
 * gibt der KDC es ueber ETYPE-INFO2 vor, weil dort andere Regeln gelten.
 */
export function schluesselAusPasswort(
  etype: number,
  passwort: string,
  salz: string | Buffer,
  iterationen = STANDARD_ITERATIONEN,
): KerberosSchluessel {
  const laenge = schluesselLaenge(etype);
  const tkey = pbkdf2Sync(Buffer.from(passwort, 'utf8'), salz, iterationen, laenge, 'sha1');
  return { etype, wert: dk(tkey, Buffer.from('kerberos', 'ascii')) };
}

// ---------------------------------------------------- Ver- und Entschluesseln

/** Verschluesseln mit Zufallspraefix und angehaengtem HMAC (RFC 3961 5.3). */
export function verschluesseln(
  schluessel: KerberosSchluessel,
  usage: number,
  klartext: Buffer,
  praefix: Buffer = randomBytes(BLOCK),
): Buffer {
  const ke = dk(schluessel.wert, verwendung(usage, 0xaa));
  const ki = dk(schluessel.wert, verwendung(usage, 0x55));
  const daten = Buffer.concat([praefix, klartext]);
  const c = aesCtsVerschluesseln(ke, daten);
  const h = createHmac('sha1', ki).update(daten).digest().subarray(0, HMAC_LAENGE);
  return Buffer.concat([c, h]);
}

export function entschluesseln(schluessel: KerberosSchluessel, usage: number, geheimtext: Buffer): Buffer {
  if (geheimtext.length < BLOCK + HMAC_LAENGE) throw new Error('Kerberos: Geheimtext zu kurz');
  const ke = dk(schluessel.wert, verwendung(usage, 0xaa));
  const ki = dk(schluessel.wert, verwendung(usage, 0x55));
  const c = geheimtext.subarray(0, geheimtext.length - HMAC_LAENGE);
  const h = geheimtext.subarray(geheimtext.length - HMAC_LAENGE);
  const daten = aesCtsEntschluesseln(ke, c);
  const erwartet = createHmac('sha1', ki).update(daten).digest().subarray(0, HMAC_LAENGE);
  if (!timingSafeEqual(h, erwartet)) {
    throw new Error('Kerberos: Integritaetspruefung fehlgeschlagen - falscher Schluessel oder veraenderte Daten');
  }
  return daten.subarray(BLOCK);
}

/** hmac-sha1-96-aes128/256 (RFC 3962 Abschnitt 7). */
export function pruefsumme(schluessel: KerberosSchluessel, usage: number, daten: Buffer): Buffer {
  const kc = dk(schluessel.wert, verwendung(usage, 0x99));
  return createHmac('sha1', kc).update(daten).digest().subarray(0, HMAC_LAENGE);
}

/** Ein frischer Zufallsschluessel des Verfahrens - etwa als Subkey. */
export function zufallsSchluessel(etype: number): KerberosSchluessel {
  return { etype, wert: randomBytes(schluesselLaenge(etype)) };
}

// ------------------------------------------------------ Schluesselverwendungen

/** Key Usage Numbers (RFC 4120 Abschnitt 7.5.1, RFC 4121 Abschnitt 2). */
export const USAGE = {
  PA_ENC_TIMESTAMP: 1,
  TICKET: 2,
  AS_REP_ENC_PART: 3,
  TGS_REQ_AUTH_CKSUM: 6,
  TGS_REQ_AUTHENTICATOR: 7,
  TGS_REP_ENC_PART_SESSION: 8,
  TGS_REP_ENC_PART_SUBKEY: 9,
  AP_REQ_AUTH_CKSUM: 10,
  AP_REQ_AUTHENTICATOR: 11,
  AP_REP_ENC_PART: 12,
  GSS_ACCEPTOR_SEAL: 22,
  GSS_ACCEPTOR_SIGN: 23,
  GSS_INITIATOR_SEAL: 24,
  GSS_INITIATOR_SIGN: 25,
} as const;
