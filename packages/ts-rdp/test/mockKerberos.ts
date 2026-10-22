/**
 * Servergegenseite von CredSSP mit Kerberos fuer die Tests.
 *
 * Der Dienstschluessel kommt aus einer Keytab, die MIT Kerberos erzeugt hat,
 * und das Ticket hat ein echter MIT-KDC ausgestellt. Laesst es sich hier
 * entschluesseln, stimmt also die Clientseite mit einer fremden Implementierung
 * ueberein - nicht nur mit sich selbst.
 */
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeTsRequest, encodeTsRequest } from '../src/crypto/credssp.js';
import { USAGE, entschluesseln, verschluesseln, zufallsSchluessel, type KerberosSchluessel } from '../src/kerberos/crypto.js';
import {
  apAntwort,
  apAntwortInhalt,
  leseApAnfrage,
  leseAuthenticator,
  leseTicketInhalt,
  prinzipalText,
} from '../src/kerberos/asn1.js';
import {
  GSS_CHECKSUM_TYP,
  GssKrb5Sitzung,
  NEG_ACCEPT_COMPLETED,
  OID_MS_KRB5,
  apRepToken,
  leseNegTokenInit,
  leseNegTokenResp,
  negTokenResp,
  oeffneKrb5Token,
} from '../src/kerberos/gss.js';
import { bindingHash, parseTsCredentials, type CredSspOutcome } from './mockCredssp.js';

export interface KeytabEintrag {
  prinzipal: string;
  realm: string;
  kvno: number;
  schluessel: KerberosSchluessel;
}

/** MIT-Keytab lesen (Format 0x0502, siehe krb5 "keytab file format"). */
export function leseKeytab(pfad: string): KeytabEintrag[] {
  const b = readFileSync(pfad);
  if (b.readUInt16BE(0) !== 0x0502) throw new Error('Keytab: nur Version 0x0502');
  const eintraege: KeytabEintrag[] = [];
  let pos = 2;
  while (pos + 4 <= b.length) {
    const laenge = b.readInt32BE(pos);
    pos += 4;
    if (laenge <= 0) {
      pos += -laenge;
      continue;
    }
    const ende = pos + laenge;
    const text = () => {
      const n = b.readUInt16BE(pos);
      const t = b.subarray(pos + 2, pos + 2 + n).toString('utf8');
      pos += 2 + n;
      return t;
    };
    const anzahl = b.readUInt16BE(pos);
    pos += 2;
    const realm = text();
    const teile: string[] = [];
    for (let i = 0; i < anzahl; i++) teile.push(text());
    pos += 4; // name_type
    pos += 4; // timestamp
    let kvno = b[pos]!;
    pos += 1;
    const etype = b.readUInt16BE(pos);
    pos += 2;
    const keyLen = b.readUInt16BE(pos);
    pos += 2;
    const wert = Buffer.from(b.subarray(pos, pos + keyLen));
    pos += keyLen;
    // Optional ein 32-Bit-kvno, der das 8-Bit-Feld ersetzt.
    if (ende - pos >= 4) kvno = b.readUInt32BE(pos);
    pos = ende;
    eintraege.push({ prinzipal: teile.join('/'), realm, kvno, schluessel: { etype, wert } });
  }
  return eintraege;
}

export interface KerberosErwartung {
  /** Schluessel des Dienstes TERMSRV/<host>, je Verfahren einer. */
  dienstSchluessel: KerberosSchluessel[];
  publicKey: Buffer;
  /** Wie Windows ein mechListMIC mitschicken (Standard: ja). */
  mechListMic?: boolean;
  /** Wrap-Tokens wie Windows: EC 16, RRC 28, gedreht um RRC+EC. */
  windowsWrap?: boolean;
}

export interface KerberosOutcome extends CredSspOutcome {
  /** Der Benutzer, wie er im Ticket steht. */
  ticketBenutzer: string;
  /** Hat der Client unser mechListMIC mit einem eigenen beantwortet? */
  clientMic: boolean;
}

export class MockKerberosCredSspServer {
  private sitzung?: GssKrb5Sitzung;
  private mechListeRoh?: Buffer;
  private ticketBenutzer = '';
  private clientMic = false;
  private state: 'apreq' | 'pubkey' | 'credentials' | 'done' = 'apreq';

  constructor(private readonly erwartung: KerberosErwartung) {}

  step(incoming: Buffer): { send?: Buffer; outcome?: KerberosOutcome } {
    const request = decodeTsRequest(incoming);
    switch (this.state) {
      case 'apreq': {
        const token = request.negoTokens?.[0];
        if (!token) throw new Error('Kerberos-Test: negoToken fehlt');
        const init = leseNegTokenInit(token);
        if (!init.mechToken) throw new Error('Kerberos-Test: kein mechToken');
        this.mechListeRoh = init.mechListeRoh;
        const { art, nachricht } = oeffneKrb5Token(init.mechToken);
        if (art !== 'ap-req') throw new Error('Kerberos-Test: AP-REQ erwartet');
        const apReq = leseApAnfrage(nachricht);
        if (!(apReq.optionen & 0x20000000)) throw new Error('Kerberos-Test: mutual-required fehlt');

        const dienst = this.erwartung.dienstSchluessel.find((k) => k.etype === apReq.ticket.encPart.etype);
        if (!dienst) throw new Error(`Kerberos-Test: kein Dienstschluessel fuer etype ${apReq.ticket.encPart.etype}`);
        const ticket = leseTicketInhalt(entschluesseln(dienst, USAGE.TICKET, apReq.ticket.encPart.cipher));
        const auth = leseAuthenticator(entschluesseln(ticket.schluessel, USAGE.AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
        if (prinzipalText(auth.cname) !== prinzipalText(ticket.cname)) {
          throw new Error('Kerberos-Test: Authenticator und Ticket nennen verschiedene Benutzer');
        }
        if (auth.pruefsumme?.typ !== GSS_CHECKSUM_TYP) throw new Error('Kerberos-Test: GSS-Pruefsumme fehlt');
        if (!auth.subkey || auth.sequenz === undefined) throw new Error('Kerberos-Test: Subkey oder Folgenummer fehlt');
        this.ticketBenutzer = `${prinzipalText(ticket.cname)}@${ticket.crealm}`;

        const acceptorSubkey = zufallsSchluessel(auth.subkey.etype);
        const folge = randomInt(0, 0x7fffffff);
        const apRep = apAntwort({
          etype: ticket.schluessel.etype,
          cipher: verschluesseln(
            ticket.schluessel,
            USAGE.AP_REP_ENC_PART,
            apAntwortInhalt({ zeit: auth.zeit, subkey: acceptorSubkey, sequenz: folge }),
          ),
        });
        this.sitzung = new GssKrb5Sitzung(acceptorSubkey, 'acceptor', true, folge, auth.sequenz);
        const mitMic = this.erwartung.mechListMic !== false;
        this.state = 'pubkey';
        return {
          send: encodeTsRequest({
            version: 6,
            negoTokens: [
              negTokenResp({
                status: NEG_ACCEPT_COMPLETED,
                mech: OID_MS_KRB5,
                antwort: apRepToken(apRep),
                mechListMic: mitMic ? this.sitzung.getMic(this.mechListeRoh) : undefined,
              }),
            ],
          }),
        };
      }

      case 'pubkey': {
        const sitzung = this.sitzung!;
        const mic = request.negoTokens?.[0];
        if (mic) {
          const resp = leseNegTokenResp(mic);
          if (!resp.mechListMic) throw new Error('Kerberos-Test: NegTokenResp ohne mechListMIC');
          sitzung.verifyMic(this.mechListeRoh!, resp.mechListMic);
          this.clientMic = true;
        } else if (this.erwartung.mechListMic !== false) {
          throw new Error('Kerberos-Test: der Client hat das mechListMIC nicht beantwortet');
        }
        if (!request.pubKeyAuth || !request.clientNonce) throw new Error('Kerberos-Test: pubKeyAuth oder clientNonce fehlt');
        const empfangen = sitzung.unwrap(request.pubKeyAuth);
        const erwartet = bindingHash('CredSSP Client-To-Server Binding Hash', request.clientNonce, this.erwartung.publicKey);
        if (!empfangen.equals(erwartet)) throw new Error('Kerberos-Test: Kanalbindung des Clients stimmt nicht');
        const antwort = bindingHash('CredSSP Server-To-Client Binding Hash', request.clientNonce, this.erwartung.publicKey);
        this.state = 'credentials';
        return {
          send: encodeTsRequest({
            version: 6,
            pubKeyAuth: this.erwartung.windowsWrap
              ? sitzung.wrap(antwort, { ec: 16, rrc: 28, drehung: 44 })
              : sitzung.wrap(antwort),
          }),
        };
      }

      case 'credentials': {
        if (!request.authInfo) throw new Error('Kerberos-Test: authInfo fehlt');
        const credentials = parseTsCredentials(this.sitzung!.unwrap(request.authInfo));
        this.state = 'done';
        return {
          outcome: { credentials, micVerified: this.clientMic, ticketBenutzer: this.ticketBenutzer, clientMic: this.clientMic },
        };
      }

      default:
        throw new Error('Kerberos-Test: unerwartete Nachricht');
    }
  }
}
