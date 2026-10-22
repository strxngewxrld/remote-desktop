/**
 * Kerberos-Nachrichten in DER (RFC 4120 Abschnitt 5) - genau die, die ein
 * Client fuer AS-, TGS- und AP-Austausch braucht, dazu die Gegenstuecke, die
 * ein Testserver zum Pruefen liest.
 *
 * Wie `asn1/der.ts` bewusst kein allgemeiner ASN.1-Stack: jede Struktur ist
 * einzeln ausgeschrieben, und beim Lesen wird nur verlangt, was gebraucht
 * wird. Alle Kerberos-Tags liegen unter 31, ein Tag passt also in ein Byte.
 */
import { children, encodeLength, readElement, type DerElement } from '../asn1/der.js';
import type { KerberosSchluessel } from './crypto.js';

// ------------------------------------------------------------------ Bauen

function tlv(tag: number, inhalt: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(inhalt.length), inhalt]);
}

export const seq = (...teile: Buffer[]): Buffer => tlv(0x30, Buffer.concat(teile));
export const ctx = (n: number, inhalt: Buffer): Buffer => tlv(0xa0 | n, inhalt);
export const app = (n: number, inhalt: Buffer): Buffer => tlv(0x60 | n, inhalt);
export const oktetts = (b: Buffer): Buffer => tlv(0x04, b);
export const generalString = (s: string): Buffer => tlv(0x1b, Buffer.from(s, 'utf8'));
export const boolean = (wert: boolean): Buffer => tlv(0x01, Buffer.from([wert ? 0xff : 0x00]));

/** INTEGER mit Vorzeichen, wie Int32 und UInt32 in RFC 4120 es brauchen. */
export function int(wert: number): Buffer {
  if (!Number.isInteger(wert)) throw new Error(`Kerberos: ${wert} ist keine ganze Zahl`);
  const bytes: number[] = [];
  let v = BigInt(wert);
  // Zweierkomplement, so kurz wie moeglich.
  for (;;) {
    bytes.unshift(Number(v & 0xffn));
    const rest = v >> 8n;
    const vorzeichen = (bytes[0]! & 0x80) !== 0;
    if ((rest === 0n && !vorzeichen) || (rest === -1n && vorzeichen)) break;
    v = rest;
  }
  return tlv(0x02, Buffer.from(bytes));
}

/** 32 Flag-Bits als BIT STRING; Bit 0 ist das hoechstwertige. */
export function flags32(wert: number): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(wert >>> 0, 1);
  return tlv(0x03, b);
}

/** KerberosTime: GeneralizedTime ohne Sekundenbruchteile, immer UTC. */
export function zeit(datum: Date): Buffer {
  const iso = datum.toISOString(); // 2026-10-10T12:34:56.789Z
  const text = iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z';
  return tlv(0x18, Buffer.from(text, 'ascii'));
}

/** Objektkennung aus der Punktschreibweise. */
export function oid(punkte: string): Buffer {
  const teile = punkte.split('.').map(Number);
  const bytes: number[] = [teile[0]! * 40 + teile[1]!];
  for (const t of teile.slice(2)) {
    const stuecke: number[] = [];
    let v = t;
    do {
      stuecke.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < stuecke.length - 1; i++) stuecke[i]! |= 0x80;
    bytes.push(...stuecke);
  }
  return tlv(0x06, Buffer.from(bytes));
}

// ------------------------------------------------------------------ Lesen

/** Die [n]-Felder einer SEQUENCE, je Nummer das innere Element. */
export function felder(sequenz: DerElement): Map<number, DerElement> {
  const ergebnis = new Map<number, DerElement>();
  for (const kind of children(sequenz.content)) {
    if ((kind.tag & 0xe0) !== 0xa0) continue;
    ergebnis.set(kind.tag & 0x1f, readElement(kind.content));
  }
  return ergebnis;
}

function pflicht(f: Map<number, DerElement>, n: number, was: string): DerElement {
  const el = f.get(n);
  if (!el) throw new Error(`Kerberos: Feld [${n}] (${was}) fehlt`);
  return el;
}

/** [APPLICATION n] oeffnen und die SEQUENCE darin zurueckgeben. */
export function oeffneApp(daten: Buffer, n: number): DerElement {
  const aussen = readElement(daten);
  if (aussen.tag !== (0x60 | n)) {
    throw new Error(`Kerberos: [APPLICATION ${n}] erwartet, gefunden Tag 0x${aussen.tag.toString(16)}`);
  }
  return readElement(aussen.content);
}

/** Welche [APPLICATION n] steht vorn? -1, wenn es keine ist. */
export function appNummer(daten: Buffer): number {
  const tag = daten[0] ?? 0;
  return (tag & 0xe0) === 0x60 ? tag & 0x1f : -1;
}

export function leseInt(el: DerElement): number {
  if (el.tag !== 0x02) throw new Error('Kerberos: INTEGER erwartet');
  let v = 0n;
  for (const b of el.content) v = (v << 8n) | BigInt(b);
  if (el.content.length && (el.content[0]! & 0x80)) v -= 1n << BigInt(el.content.length * 8);
  return Number(v);
}

export function leseText(el: DerElement): string {
  return el.content.toString('utf8');
}

export function leseZeit(el: DerElement): Date {
  const t = el.content.toString('ascii');
  return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)));
}

export function leseFlags(el: DerElement): number {
  if (el.tag !== 0x03 || el.content.length < 2) throw new Error('Kerberos: BIT STRING erwartet');
  const b = Buffer.alloc(4);
  el.content.copy(b, 0, 1, Math.min(5, el.content.length));
  return b.readUInt32BE(0);
}

// --------------------------------------------------------------- Bausteine

/** Namenstypen (RFC 4120 6.2). */
export const NT_PRINCIPAL = 1;
export const NT_SRV_INST = 2;
export const NT_SRV_HST = 3;
export const NT_ENTERPRISE = 10;

export interface Prinzipal {
  typ: number;
  teile: string[];
}

export function prinzipalText(p: Prinzipal): string {
  return p.teile.join('/');
}

export function prinzipal(p: Prinzipal): Buffer {
  return seq(ctx(0, int(p.typ)), ctx(1, seq(...p.teile.map(generalString))));
}

export function lesePrinzipal(el: DerElement): Prinzipal {
  const f = felder(el);
  return {
    typ: leseInt(pflicht(f, 0, 'name-type')),
    teile: [...children(pflicht(f, 1, 'name-string').content)].map(leseText),
  };
}

export interface VerschluesselteDaten {
  etype: number;
  kvno?: number;
  cipher: Buffer;
}

export function verschluesselteDaten(d: VerschluesselteDaten): Buffer {
  return seq(ctx(0, int(d.etype)), ...(d.kvno !== undefined ? [ctx(1, int(d.kvno))] : []), ctx(2, oktetts(d.cipher)));
}

export function leseVerschluesselteDaten(el: DerElement): VerschluesselteDaten {
  const f = felder(el);
  const kvno = f.get(1);
  return {
    etype: leseInt(pflicht(f, 0, 'etype')),
    kvno: kvno ? leseInt(kvno) : undefined,
    cipher: pflicht(f, 2, 'cipher').content,
  };
}

export function schluessel(k: KerberosSchluessel): Buffer {
  return seq(ctx(0, int(k.etype)), ctx(1, oktetts(k.wert)));
}

export function leseSchluessel(el: DerElement): KerberosSchluessel {
  const f = felder(el);
  return { etype: leseInt(pflicht(f, 0, 'keytype')), wert: Buffer.from(pflicht(f, 1, 'keyvalue').content) };
}

export function pruefsummeFeld(typ: number, wert: Buffer): Buffer {
  return seq(ctx(0, int(typ)), ctx(1, oktetts(wert)));
}

export interface PaDaten {
  typ: number;
  wert: Buffer;
}

export const PA_TGS_REQ = 1;
export const PA_ENC_TIMESTAMP = 2;
export const PA_ETYPE_INFO2 = 19;
export const PA_PAC_REQUEST = 128;

export function paDaten(p: PaDaten): Buffer {
  return seq(ctx(1, int(p.typ)), ctx(2, oktetts(p.wert)));
}

export function lesePaDatenListe(el: DerElement): PaDaten[] {
  return [...children(el.content)].map((eintrag) => {
    const f = felder(eintrag);
    return { typ: leseInt(pflicht(f, 1, 'padata-type')), wert: Buffer.from(pflicht(f, 2, 'padata-value').content) };
  });
}

export interface EtypeInfo2 {
  etype: number;
  salz?: string;
  iterationen?: number;
}

/** ETYPE-INFO2 aus PA-ETYPE-INFO2 (RFC 4120 5.2.7.5). */
export function leseEtypeInfo2(wert: Buffer): EtypeInfo2[] {
  return [...children(readElement(wert).content)].map((eintrag) => {
    const f = felder(eintrag);
    const salz = f.get(1);
    const s2k = f.get(2);
    return {
      etype: leseInt(pflicht(f, 0, 'etype')),
      salz: salz ? leseText(salz) : undefined,
      // AES: s2kparams ist die Iterationszahl als 32 Bit Big Endian (RFC 3962).
      iterationen: s2k && s2k.content.length === 4 ? s2k.content.readUInt32BE(0) : undefined,
    };
  });
}

export function etypeInfo2(eintraege: EtypeInfo2[]): Buffer {
  return seq(
    ...eintraege.map((e) => seq(ctx(0, int(e.etype)), ...(e.salz !== undefined ? [ctx(1, generalString(e.salz))] : []))),
  );
}

// ---------------------------------------------------------------- Ticket

export interface Ticket {
  realm: string;
  sname: Prinzipal;
  encPart: VerschluesselteDaten;
  /** Die Bytes, wie sie kamen - ein Ticket wird unveraendert weitergereicht. */
  roh: Buffer;
}

export function leseTicket(el: DerElement, roh: Buffer): Ticket {
  if (el.tag !== 0x61) throw new Error('Kerberos: Ticket ([APPLICATION 1]) erwartet');
  const f = felder(readElement(el.content));
  return {
    realm: leseText(pflicht(f, 1, 'realm')),
    sname: lesePrinzipal(pflicht(f, 2, 'sname')),
    encPart: leseVerschluesselteDaten(pflicht(f, 3, 'enc-part')),
    roh,
  };
}

/** Ein Ticket aus seinen eigenen Bytes - etwa aus einem AP-REQ. */
export function ticketAusBytes(roh: Buffer): Ticket {
  return leseTicket(readElement(roh), roh);
}

export function baueTicket(realm: string, sname: Prinzipal, encPart: VerschluesselteDaten): Buffer {
  return app(1, seq(ctx(0, int(5)), ctx(1, generalString(realm)), ctx(2, prinzipal(sname)), ctx(3, verschluesselteDaten(encPart))));
}

/** Der Teil von EncTicketPart, den ein Dienst zum Pruefen braucht. */
export interface TicketInhalt {
  schluessel: KerberosSchluessel;
  crealm: string;
  cname: Prinzipal;
  endtime: Date;
}

export function leseTicketInhalt(klartext: Buffer): TicketInhalt {
  const f = felder(oeffneApp(klartext, 3));
  return {
    schluessel: leseSchluessel(pflicht(f, 1, 'key')),
    crealm: leseText(pflicht(f, 2, 'crealm')),
    cname: lesePrinzipal(pflicht(f, 3, 'cname')),
    endtime: leseZeit(pflicht(f, 7, 'endtime')),
  };
}

// ------------------------------------------------------- AS- und TGS-Anfrage

export const AS_REQ = 10;
export const AS_REP = 11;
export const TGS_REQ = 12;
export const TGS_REP = 13;
export const AP_REQ = 14;
export const AP_REP = 15;
export const KRB_ERROR = 30;

/** forwardable | renewable | canonicalize (RFC 4120 5.4.1, RFC 6806). */
export const KDC_OPTIONEN = 0x40810000;

export interface KdcAnfrageRumpf {
  cname?: Prinzipal;
  realm: string;
  sname: Prinzipal;
  till: Date;
  nonce: number;
  etypes: readonly number[];
  optionen?: number;
}

export function kdcAnfrageRumpf(r: KdcAnfrageRumpf): Buffer {
  return seq(
    ctx(0, flags32(r.optionen ?? KDC_OPTIONEN)),
    ...(r.cname ? [ctx(1, prinzipal(r.cname))] : []),
    ctx(2, generalString(r.realm)),
    ctx(3, prinzipal(r.sname)),
    ctx(5, zeit(r.till)),
    ctx(7, int(r.nonce)),
    ctx(8, seq(...r.etypes.map(int))),
  );
}

export function kdcAnfrage(art: typeof AS_REQ | typeof TGS_REQ, padata: PaDaten[], rumpf: Buffer): Buffer {
  return app(
    art,
    seq(
      ctx(1, int(5)),
      ctx(2, int(art)),
      ...(padata.length ? [ctx(3, seq(...padata.map(paDaten)))] : []),
      ctx(4, rumpf),
    ),
  );
}

/** Eine KDC-Anfrage lesen - fuer den Testserver. */
export function leseKdcAnfrage(daten: Buffer): { art: number; padata: PaDaten[]; rumpf: KdcAnfrageRumpf; rumpfRoh: Buffer } {
  const art = appNummer(daten);
  const f = felder(oeffneApp(daten, art));
  const padata = f.get(3);
  const rumpfEl = pflicht(f, 4, 'req-body');
  const r = felder(rumpfEl);
  const cname = r.get(1);
  return {
    art,
    padata: padata ? lesePaDatenListe(padata) : [],
    rumpf: {
      cname: cname ? lesePrinzipal(cname) : undefined,
      realm: leseText(pflicht(r, 2, 'realm')),
      sname: lesePrinzipal(pflicht(r, 3, 'sname')),
      till: leseZeit(pflicht(r, 5, 'till')),
      nonce: leseInt(pflicht(r, 7, 'nonce')),
      etypes: [...children(pflicht(r, 8, 'etype').content)].map(leseInt),
      optionen: leseFlags(pflicht(r, 0, 'kdc-options')),
    },
    rumpfRoh: seqBytes(rumpfEl),
  };
}

/** Ein gelesenes Element wieder als vollstaendiges TLV. */
function seqBytes(el: DerElement): Buffer {
  return tlv(el.tag, el.content);
}

/** PA-ENC-TS-ENC (RFC 4120 5.2.7.2). */
export function zeitstempel(jetzt: Date): Buffer {
  return seq(ctx(0, zeit(jetzt)), ctx(1, int((jetzt.getTime() % 1000) * 1000)));
}

export function leseZeitstempel(klartext: Buffer): Date {
  return leseZeit(pflicht(felder(readElement(klartext)), 0, 'patimestamp'));
}

/** PA-PAC-REQUEST (MS-KILE 2.2.3): ein Windows-KDC soll die PAC beilegen. */
export function pacAnfrage(mitPac = true): Buffer {
  return seq(ctx(0, boolean(mitPac)));
}

// ------------------------------------------------------------ KDC-Antwort

export interface KdcAntwort {
  art: number;
  padata: PaDaten[];
  crealm: string;
  cname: Prinzipal;
  ticket: Ticket;
  encPart: VerschluesselteDaten;
}

export function leseKdcAntwort(daten: Buffer): KdcAntwort {
  const art = appNummer(daten);
  if (art !== AS_REP && art !== TGS_REP) throw new Error(`Kerberos: AS-REP oder TGS-REP erwartet, nicht [APPLICATION ${art}]`);
  const f = felder(oeffneApp(daten, art));
  const padata = f.get(2);
  // Das Ticket steht hinter einem [5]; fuer seine Rohbytes braucht es das
  // vollstaendige TLV, nicht nur den Inhalt.
  const ticketEl = pflicht(f, 5, 'ticket');
  return {
    art,
    padata: padata ? lesePaDatenListe(padata) : [],
    crealm: leseText(pflicht(f, 3, 'crealm')),
    cname: lesePrinzipal(pflicht(f, 4, 'cname')),
    ticket: leseTicket(ticketEl, seqBytes(ticketEl)),
    encPart: leseVerschluesselteDaten(pflicht(f, 6, 'enc-part')),
  };
}

export interface KdcAntwortInhalt {
  schluessel: KerberosSchluessel;
  nonce: number;
  endtime: Date;
  srealm: string;
  sname: Prinzipal;
}

/**
 * EncASRepPart oder EncTGSRepPart. Windows legt in eine AS-Antwort gelegentlich
 * ein EncTGSRepPart ([APPLICATION 26]) statt [APPLICATION 25] - RFC 4120
 * 5.4.2 verlangt ausdruecklich, beides anzunehmen.
 */
export function leseKdcAntwortInhalt(klartext: Buffer): KdcAntwortInhalt {
  const art = appNummer(klartext);
  if (art !== 25 && art !== 26) throw new Error(`Kerberos: EncKDCRepPart erwartet, nicht [APPLICATION ${art}]`);
  const f = felder(oeffneApp(klartext, art));
  return {
    schluessel: leseSchluessel(pflicht(f, 0, 'key')),
    nonce: leseInt(pflicht(f, 2, 'nonce')),
    endtime: leseZeit(pflicht(f, 7, 'endtime')),
    srealm: leseText(pflicht(f, 9, 'srealm')),
    sname: lesePrinzipal(pflicht(f, 10, 'sname')),
  };
}

// --------------------------------------------------------------- KRB-ERROR

export interface KrbFehler {
  code: number;
  realm?: string;
  text?: string;
  eData?: Buffer;
}

export function leseKrbFehler(daten: Buffer): KrbFehler {
  const f = felder(oeffneApp(daten, KRB_ERROR));
  const realm = f.get(9);
  const text = f.get(11);
  const eData = f.get(12);
  return {
    code: leseInt(pflicht(f, 6, 'error-code')),
    realm: realm ? leseText(realm) : undefined,
    text: text ? leseText(text) : undefined,
    eData: eData ? Buffer.from(eData.content) : undefined,
  };
}

/** Fehlercodes, die ein Client unterscheiden muss (RFC 4120 7.5.9). */
export const KDC_ERR = {
  C_PRINCIPAL_UNKNOWN: 6,
  S_PRINCIPAL_UNKNOWN: 7,
  ETYPE_NOSUPP: 14,
  PREAUTH_FAILED: 24,
  PREAUTH_REQUIRED: 25,
  KRB_AP_ERR_SKEW: 37,
  KRB_ERR_RESPONSE_TOO_BIG: 52,
  WRONG_REALM: 68,
} as const;

// ------------------------------------------------------------- AP-Austausch

/** mutual-required (RFC 4120 5.5.1): der Dienst muss sich mit AP-REP ausweisen. */
export const AP_OPTION_MUTUAL = 0x20000000;

export interface AuthenticatorInhalt {
  crealm: string;
  cname: Prinzipal;
  pruefsumme?: { typ: number; wert: Buffer };
  zeit: Date;
  subkey?: KerberosSchluessel;
  sequenz?: number;
}

export function authenticator(a: AuthenticatorInhalt): Buffer {
  return app(
    2,
    seq(
      ctx(0, int(5)),
      ctx(1, generalString(a.crealm)),
      ctx(2, prinzipal(a.cname)),
      ...(a.pruefsumme ? [ctx(3, pruefsummeFeld(a.pruefsumme.typ, a.pruefsumme.wert))] : []),
      ctx(4, int((a.zeit.getTime() % 1000) * 1000)),
      ctx(5, zeit(a.zeit)),
      ...(a.subkey ? [ctx(6, schluessel(a.subkey))] : []),
      ...(a.sequenz !== undefined ? [ctx(7, int(a.sequenz))] : []),
    ),
  );
}

export function leseAuthenticator(klartext: Buffer): AuthenticatorInhalt {
  const f = felder(oeffneApp(klartext, 2));
  const ck = f.get(3);
  const sub = f.get(6);
  const sequenz = f.get(7);
  const ckFelder = ck ? felder(ck) : undefined;
  return {
    crealm: leseText(pflicht(f, 1, 'crealm')),
    cname: lesePrinzipal(pflicht(f, 2, 'cname')),
    pruefsumme: ckFelder
      ? { typ: leseInt(pflicht(ckFelder, 0, 'cksumtype')), wert: Buffer.from(pflicht(ckFelder, 1, 'checksum').content) }
      : undefined,
    zeit: new Date(leseZeit(pflicht(f, 5, 'ctime')).getTime() + Math.floor(leseInt(pflicht(f, 4, 'cusec')) / 1000)),
    subkey: sub ? leseSchluessel(sub) : undefined,
    sequenz: sequenz ? leseInt(sequenz) : undefined,
  };
}

export function apAnfrage(ticket: Buffer, verschluesselterAuthenticator: VerschluesselteDaten, optionen: number): Buffer {
  return app(
    AP_REQ,
    seq(
      ctx(0, int(5)),
      ctx(1, int(AP_REQ)),
      ctx(2, flags32(optionen)),
      ctx(3, ticket),
      ctx(4, verschluesselteDaten(verschluesselterAuthenticator)),
    ),
  );
}

export function leseApAnfrage(daten: Buffer): { optionen: number; ticket: Ticket; authenticator: VerschluesselteDaten } {
  const f = felder(oeffneApp(daten, AP_REQ));
  const ticketEl = pflicht(f, 3, 'ticket');
  return {
    optionen: leseFlags(pflicht(f, 2, 'ap-options')),
    ticket: leseTicket(ticketEl, seqBytes(ticketEl)),
    authenticator: leseVerschluesselteDaten(pflicht(f, 4, 'authenticator')),
  };
}

export interface ApAntwortInhalt {
  zeit: Date;
  mikrosekunden?: number;
  subkey?: KerberosSchluessel;
  sequenz?: number;
}

export function apAntwort(encPart: VerschluesselteDaten): Buffer {
  return app(AP_REP, seq(ctx(0, int(5)), ctx(1, int(AP_REP)), ctx(2, verschluesselteDaten(encPart))));
}

export function leseApAntwort(daten: Buffer): VerschluesselteDaten {
  return leseVerschluesselteDaten(pflicht(felder(oeffneApp(daten, AP_REP)), 2, 'enc-part'));
}

export function apAntwortInhalt(a: ApAntwortInhalt): Buffer {
  return app(
    27,
    seq(
      ctx(0, zeit(a.zeit)),
      ctx(1, int(a.mikrosekunden ?? (a.zeit.getTime() % 1000) * 1000)),
      ...(a.subkey ? [ctx(2, schluessel(a.subkey))] : []),
      ...(a.sequenz !== undefined ? [ctx(3, int(a.sequenz))] : []),
    ),
  );
}

export function leseApAntwortInhalt(klartext: Buffer): ApAntwortInhalt {
  const f = felder(oeffneApp(klartext, 27));
  const sub = f.get(2);
  const sequenz = f.get(3);
  const mikrosekunden = leseInt(pflicht(f, 1, 'cusec'));
  if (mikrosekunden < 0 || mikrosekunden >= 1_000_000) throw new Error('Kerberos: ungueltige cusec');
  return {
    zeit: leseZeit(pflicht(f, 0, 'ctime')),
    mikrosekunden,
    subkey: sub ? leseSchluessel(sub) : undefined,
    sequenz: sequenz ? leseInt(sequenz) : undefined,
  };
}
