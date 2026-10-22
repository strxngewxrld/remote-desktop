/**
 * Kerberos als GSS-API-Mechanismus (RFC 4121) und SPNEGO (RFC 4178).
 *
 * CredSSP braucht davon drei Dinge:
 *   - das Kontext-Token: der AP-REQ in der GSS-Huelle, eingewickelt in ein
 *     SPNEGO NegTokenInit - genau so schickt es auch mstsc,
 *   - die Antwort darauf: NegTokenResp mit dem AP-REP des Servers,
 *   - Wrap und Unwrap (Abschnitt 4.2.6.2) fuer pubKeyAuth und die
 *     Zugangsdaten, dazu MIC-Token fuer das mechListMIC von SPNEGO.
 */
import { children, readElement } from '../asn1/der.js';
import { timingSafeEqual } from 'node:crypto';
import {
  type KerberosSchluessel,
  USAGE,
  entschluesseln,
  pruefsumme,
  verschluesseln,
} from './crypto.js';
import { app, ctx, felder, oid, oktetts, seq } from './asn1.js';

export const OID_KRB5 = '1.2.840.113554.1.2.2';
/** Die Kennung, unter der Windows Kerberos fuehrt - mstsc nennt sie zuerst. */
export const OID_MS_KRB5 = '1.2.840.48018.1.2.2';
export const OID_NTLM = '1.3.6.1.4.1.311.2.2.10';
export const OID_SPNEGO = '1.3.6.1.5.5.2';

const TOK_AP_REQ = Buffer.from([0x01, 0x00]);
const TOK_AP_REP = Buffer.from([0x02, 0x00]);
const TOK_KRB_ERROR = Buffer.from([0x03, 0x00]);

/** Pruefsummentyp des GSS-Authenticators (RFC 4121 4.1.1). */
export const GSS_CHECKSUM_TYP = 0x8003;
/** mutual | replay | sequence | conf | integ. */
export const GSS_FLAGS = 0x02 | 0x04 | 0x08 | 0x10 | 0x20;

/** Die GSS-Pruefsumme im Authenticator: Laenge, Kanalbindung, Flags. */
export function gssPruefsumme(kanalbindung = Buffer.alloc(16), flags = GSS_FLAGS): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(16, 0);
  kanalbindung.copy(b, 4, 0, 16);
  b.writeUInt32LE(flags, 20);
  return b;
}

// ---------------------------------------------------- Kontext-Token (4.1)

/** InitialContextToken (RFC 2743 3.1) um einen AP-REQ. */
export function apReqToken(apReq: Buffer): Buffer {
  return app(0, Buffer.concat([oid(OID_KRB5), TOK_AP_REQ, apReq]));
}

/** Kerberos-Nachricht aus einem GSS-Token holen, samt TOK_ID. */
export function oeffneKrb5Token(token: Buffer): { art: 'ap-req' | 'ap-rep' | 'fehler'; nachricht: Buffer } {
  const aussen = readElement(token);
  if (aussen.tag !== 0x60) throw new Error('GSS: InitialContextToken erwartet');
  const kennung = readElement(aussen.content);
  if (kennung.tag !== 0x06) throw new Error('GSS: Mechanismus-OID fehlt');
  if (![OID_KRB5, OID_MS_KRB5].includes(oidText(kennung.content))) throw new Error('GSS: falsche Mechanismus-OID');
  const rest = aussen.content.subarray(kennung.end);
  const tokId = rest.subarray(0, 2);
  const nachricht = rest.subarray(2);
  if (tokId.equals(TOK_AP_REQ)) return { art: 'ap-req', nachricht };
  if (tokId.equals(TOK_AP_REP)) return { art: 'ap-rep', nachricht };
  if (tokId.equals(TOK_KRB_ERROR)) return { art: 'fehler', nachricht };
  throw new Error(`GSS: unbekannte TOK_ID ${tokId.toString('hex')}`);
}

export function apRepToken(apRep: Buffer): Buffer {
  return app(0, Buffer.concat([oid(OID_KRB5), TOK_AP_REP, apRep]));
}

// ---------------------------------------------------------------- SPNEGO

/** Die DER-Kodierung der Mechanismenliste - ueber genau diese Bytes geht das mechListMIC. */
export function mechListe(mechs: readonly string[]): Buffer {
  return seq(...mechs.map(oid));
}

export function negTokenInit(mechs: readonly string[], mechToken: Buffer): Buffer {
  return app(0, Buffer.concat([oid(OID_SPNEGO), ctx(0, seq(ctx(0, mechListe(mechs)), ctx(2, oktetts(mechToken))))]));
}

export interface NegTokenResp {
  /** 0 accept-completed, 1 accept-incomplete, 2 reject, 3 request-mic. */
  status?: number;
  mech?: string;
  antwort?: Buffer;
  mechListMic?: Buffer;
}

export const NEG_ACCEPT_COMPLETED = 0;
export const NEG_ACCEPT_INCOMPLETE = 1;
export const NEG_REJECT = 2;

function oidText(inhalt: Buffer): string {
  const teile: number[] = [Math.floor(inhalt[0]! / 40), inhalt[0]! % 40];
  let v = 0;
  for (const b of inhalt.subarray(1)) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      teile.push(v);
      v = 0;
    }
  }
  return teile.join('.');
}

export function negTokenResp(r: NegTokenResp): Buffer {
  return ctx(
    1,
    seq(
      ...(r.status !== undefined ? [ctx(0, Buffer.from([0x0a, 0x01, r.status]))] : []),
      ...(r.mech ? [ctx(1, oid(r.mech))] : []),
      ...(r.antwort ? [ctx(2, oktetts(r.antwort))] : []),
      ...(r.mechListMic ? [ctx(3, oktetts(r.mechListMic))] : []),
    ),
  );
}

export function leseNegTokenResp(token: Buffer): NegTokenResp {
  const aussen = readElement(token);
  if (aussen.tag !== 0xa1) throw new Error('SPNEGO: NegTokenResp erwartet');
  const f = felder(readElement(aussen.content));
  const status = f.get(0);
  const mech = f.get(1);
  const antwort = f.get(2);
  const mic = f.get(3);
  return {
    status: status ? status.content[0] : undefined,
    mech: mech ? oidText(mech.content) : undefined,
    antwort: antwort ? Buffer.from(antwort.content) : undefined,
    mechListMic: mic ? Buffer.from(mic.content) : undefined,
  };
}

/** NegTokenInit lesen - fuer den Testserver. */
export function leseNegTokenInit(token: Buffer): { mechs: string[]; mechListeRoh: Buffer; mechToken?: Buffer } {
  const aussen = readElement(token);
  if (aussen.tag !== 0x60) throw new Error('SPNEGO: InitialContextToken erwartet');
  const kennung = readElement(aussen.content);
  if (oidText(kennung.content) !== OID_SPNEGO) throw new Error('SPNEGO: falsche Mechanismus-OID');
  const init = readElement(aussen.content, kennung.end);
  if (init.tag !== 0xa0) throw new Error('SPNEGO: NegTokenInit erwartet');
  const f = felder(readElement(init.content));
  const liste = f.get(0);
  if (!liste) throw new Error('SPNEGO: mechTypes fehlt');
  const token2 = f.get(2);
  return {
    mechs: [...children(liste.content)].map((e) => oidText(e.content)),
    mechListeRoh: Buffer.concat([Buffer.from([liste.tag]), encodeLaenge(liste.content.length), liste.content]),
    mechToken: token2 ? Buffer.from(token2.content) : undefined,
  };
}

function encodeLaenge(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

// ------------------------------------------------ Wrap und MIC (RFC 4121)

const FLAG_VOM_ACCEPTOR = 0x01;
const FLAG_VERSIEGELT = 0x02;
const FLAG_ACCEPTOR_SUBKEY = 0x04;

/**
 * Der Nachrichtenschutz einer aufgebauten Kerberos-Sitzung.
 *
 * Beide Seiten zaehlen ihre eigenen Folgenummern; die erste ist die aus
 * Authenticator bzw. AP-REP. Mit Acceptor-Subkey gilt fuer beide Richtungen
 * dieser Schluessel, sonst der des Initiators (RFC 4121 2).
 */
export class GssKrb5Sitzung {
  private sendeFolge: bigint;
  private empfangsFolge: bigint;

  constructor(
    private readonly schluessel: KerberosSchluessel,
    private readonly rolle: 'initiator' | 'acceptor',
    private readonly acceptorSubkey: boolean,
    sendeFolge: number,
    empfangsFolge: number,
  ) {
    this.sendeFolge = BigInt(sendeFolge);
    this.empfangsFolge = BigInt(empfangsFolge);
  }

  private kopf(art: 'wrap' | 'mic', ec: number, rrc: number, folge: bigint): Buffer {
    const k = Buffer.alloc(16, 0xff);
    if (art === 'wrap') {
      k[0] = 0x05;
      k[1] = 0x04;
    } else {
      k[0] = 0x04;
      k[1] = 0x04;
    }
    k[2] =
      (this.rolle === 'acceptor' ? FLAG_VOM_ACCEPTOR : 0) |
      (art === 'wrap' ? FLAG_VERSIEGELT : 0) |
      (this.acceptorSubkey ? FLAG_ACCEPTOR_SUBKEY : 0);
    if (art === 'wrap') {
      k.writeUInt16BE(ec, 4);
      k.writeUInt16BE(rrc, 6);
    }
    k.writeBigUInt64BE(folge, 8);
    return k;
  }

  private pruefeEmpfangskopf(kopf: Buffer, mic = false): void {
    const flags = kopf[2];
    if (((flags & FLAG_VOM_ACCEPTOR) !== 0) !== (this.rolle === 'initiator'))
      throw new Error('GSS: Token aus der falschen Richtung');
    if (((flags & FLAG_ACCEPTOR_SUBKEY) !== 0) !== this.acceptorSubkey)
      throw new Error('GSS: Token nennt den falschen Subkey');
    if (kopf.readBigUInt64BE(8) !== this.empfangsFolge)
      throw new Error('GSS: wiederholtes oder ungeordnetes Token');
    if (kopf[3] !== 0xff || (mic && !kopf.subarray(3, 8).equals(Buffer.alloc(5, 0xff))))
      throw new Error('GSS: ungueltiger Token-Kopf');
  }

  private get sendeSeal(): number {
    return this.rolle === 'initiator' ? USAGE.GSS_INITIATOR_SEAL : USAGE.GSS_ACCEPTOR_SEAL;
  }
  private get empfangsSeal(): number {
    return this.rolle === 'initiator' ? USAGE.GSS_ACCEPTOR_SEAL : USAGE.GSS_INITIATOR_SEAL;
  }

  /**
   * Versiegeln (4.2.4): Klartext || Kopf werden verschluesselt, davor steht
   * der Kopf offen. EC und RRC bleiben null - dann ist die Frage, ob die
   * Gegenseite um RRC oder um RRC+EC zurueckrotiert, gegenstandslos.
   */
  wrap(klartext: Buffer, form: { ec?: number; rrc?: number; drehung?: number } = {}): Buffer {
    // `form` gibt es fuer Tests, die nachstellen, wie Windows seine Tokens
    // baut: EC 16, RRC 28, gedreht um RRC+EC.
    const ec = form.ec ?? 0;
    const rrc = form.rrc ?? 0;
    const folge = this.sendeFolge++;
    const innen = this.kopf('wrap', ec, 0, folge);
    const rumpf = verschluesseln(this.schluessel, this.sendeSeal, Buffer.concat([klartext, Buffer.alloc(ec, 0xff), innen]));
    const n = (form.drehung ?? rrc) % rumpf.length;
    const gedreht = n ? Buffer.concat([rumpf.subarray(rumpf.length - n), rumpf.subarray(0, rumpf.length - n)]) : rumpf;
    return Buffer.concat([this.kopf('wrap', ec, rrc, folge), gedreht]);
  }

  /**
   * Entsiegeln. Windows rotiert seine Tokens (RRC 28) und zaehlt dabei - anders
   * als RFC 4121 - EC mit (MS-KILE 3.4.5.4.1). Beide Lesarten werden versucht.
   */
  unwrap(token: Buffer): Buffer {
    if (token.length < 16 || token[0] !== 0x05 || token[1] !== 0x04) throw new Error('GSS: Wrap-Token erwartet');
    this.pruefeEmpfangskopf(token.subarray(0, 16));
    const flags = token[2]!;
    const vomAcceptor = (flags & FLAG_VOM_ACCEPTOR) !== 0;
    if (vomAcceptor !== (this.rolle === 'initiator')) throw new Error('GSS: Token aus der falschen Richtung');
    if (!(flags & FLAG_VERSIEGELT)) throw new Error('GSS: unversiegelte Wrap-Tokens werden nicht angenommen');
    const ec = token.readUInt16BE(4);
    const rrc = token.readUInt16BE(6);
    const rumpf = token.subarray(16);

    let letzterFehler: unknown;
    for (const drehung of rrc === 0 ? [0] : [rrc, rrc + ec]) {
      const n = drehung % (rumpf.length || 1);
      const zurueck = Buffer.concat([rumpf.subarray(n), rumpf.subarray(0, n)]);
      try {
        const klar = entschluesseln(this.schluessel, this.empfangsSeal, zurueck);
        if (klar.length < 16 + ec) throw new Error('GSS: Wrap-Token zu kurz');
        const kopfKopie = klar.subarray(klar.length - 16);
        // Im verschluesselten Kopf steht RRC als null (4.2.5).
        const erwartet = Buffer.from(token.subarray(0, 16));
        erwartet.writeUInt16BE(0, 6);
        if (!kopfKopie.equals(erwartet)) throw new Error('GSS: Kopf im Token passt nicht zum verschluesselten');
        this.empfangsFolge++;
        return klar.subarray(0, klar.length - 16 - ec);
      } catch (fehler) {
        letzterFehler = fehler;
      }
    }
    throw letzterFehler;
  }

  /** MIC-Token (4.2.6.1): Kopf und Pruefsumme ueber Nachricht || Kopf. */
  getMic(nachricht: Buffer): Buffer {
    const kopf = this.kopf('mic', 0, 0, this.sendeFolge++);
    const usage = this.rolle === 'initiator' ? USAGE.GSS_INITIATOR_SIGN : USAGE.GSS_ACCEPTOR_SIGN;
    return Buffer.concat([kopf, pruefsumme(this.schluessel, usage, Buffer.concat([nachricht, kopf]))]);
  }

  verifyMic(nachricht: Buffer, token: Buffer): void {
    if (token.length < 16 + 12 || token[0] !== 0x04 || token[1] !== 0x04) throw new Error('GSS: MIC-Token erwartet');
    const kopf = token.subarray(0, 16);
    this.pruefeEmpfangskopf(kopf, true);
    const usage = this.rolle === 'initiator' ? USAGE.GSS_ACCEPTOR_SIGN : USAGE.GSS_INITIATOR_SIGN;
    const erwartet = pruefsumme(this.schluessel, usage, Buffer.concat([nachricht, kopf]));
    if (token.length !== 16 + erwartet.length || !timingSafeEqual(erwartet, token.subarray(16))) throw new Error('GSS: mechListMIC stimmt nicht');
    this.empfangsFolge++;
  }
}
