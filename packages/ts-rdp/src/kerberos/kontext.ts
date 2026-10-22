/**
 * Die Clientseite einer Kerberos-Anmeldung in CredSSP.
 *
 * Erst wird das Dienst-Ticket geholt - das geht ans Netz und ist deshalb
 * asynchron, waehrend CredSSP selbst Schritt fuer Schritt auf Antworten
 * reagiert. Danach liegt alles fuer den ersten TSRequest bereit.
 */
import { randomInt } from 'node:crypto';
import { USAGE, entschluesseln, verschluesseln, zufallsSchluessel, type KerberosSchluessel } from './crypto.js';
import {
  AP_OPTION_MUTUAL,
  apAnfrage,
  authenticator,
  leseApAntwort,
  leseApAntwortInhalt,
  leseKrbFehler,
} from './asn1.js';
import {
  GSS_CHECKSUM_TYP,
  GssKrb5Sitzung,
  NEG_REJECT,
  OID_KRB5,
  OID_MS_KRB5,
  apReqToken,
  gssPruefsumme,
  leseNegTokenResp,
  mechListe,
  negTokenInit,
  negTokenResp,
  oeffneKrb5Token,
} from './gss.js';
import { holeDienstTicket, KerberosFehler, type DienstTicket, type KerberosAnmeldung } from './kdc.js';

/** Was CredSSP von einem Anmeldeverfahren braucht - NTLM und Kerberos gleichermassen. */
export interface CredSspKontext {
  /** Das erste Token fuer negoTokens. */
  start(): Buffer;
  /**
   * Ein Token des Servers verarbeiten. Rueckgabe ist das naechste eigene
   * Token, falls eines faellig ist.
   */
  schritt(token: Buffer): Buffer | undefined;
  /** Steht der Sicherheitskontext? Dann geht pubKeyAuth hinaus. */
  readonly fertig: boolean;
  seal(daten: Buffer): Buffer;
  unseal(daten: Buffer): Buffer;
}

/** Die Mechanismen in der Reihenfolge, in der mstsc sie anbietet. */
const MECHS = [OID_MS_KRB5, OID_KRB5] as const;

export class KerberosKontext implements CredSspKontext {
  private sitzung?: GssKrb5Sitzung;
  private readonly subkey: KerberosSchluessel;
  private readonly folge = randomInt(0, 0x7fffffff);
  private readonly zeitpunkt: Date;

  private constructor(
    private readonly ticket: DienstTicket,
    jetzt: Date,
  ) {
    this.subkey = zufallsSchluessel(ticket.sitzungsSchluessel.etype);
    this.zeitpunkt = jetzt;
  }

  /** Ticket holen und den Kontext vorbereiten. Wirft `KerberosFehler`, wenn das nicht geht. */
  static async erstellen(anmeldung: KerberosAnmeldung, dienst: string): Promise<KerberosKontext> {
    const ticket = await holeDienstTicket(anmeldung, dienst);
    return new KerberosKontext(ticket, (anmeldung.jetzt ?? (() => new Date()))());
  }

  /** Aus einem schon vorhandenen Dienst-Ticket - fuer Tests ohne KDC. */
  static ausTicket(ticket: DienstTicket, jetzt = new Date()): KerberosKontext {
    return new KerberosKontext(ticket, jetzt);
  }

  /** Von wem das Ticket kam - fuers Protokoll. */
  get kdc(): string {
    return `${this.ticket.kdc.host}:${this.ticket.kdc.port}`;
  }

  get fertig(): boolean {
    return this.sitzung !== undefined;
  }

  start(): Buffer {
    const sk = this.ticket.sitzungsSchluessel;
    const auth = authenticator({
      crealm: this.ticket.crealm,
      cname: this.ticket.cname,
      pruefsumme: { typ: GSS_CHECKSUM_TYP, wert: gssPruefsumme() },
      zeit: this.zeitpunkt,
      subkey: this.subkey,
      sequenz: this.folge,
    });
    const apReq = apAnfrage(
      this.ticket.ticket.roh,
      { etype: sk.etype, cipher: verschluesseln(sk, USAGE.AP_REQ_AUTHENTICATOR, auth) },
      AP_OPTION_MUTUAL,
    );
    return negTokenInit(MECHS, apReqToken(apReq));
  }

  schritt(token: Buffer): Buffer | undefined {
    const antwort = leseNegTokenResp(token);
    if (antwort.status === NEG_REJECT) {
      throw new KerberosFehler('Kerberos: der Server hat die Anmeldung abgelehnt (SPNEGO reject)');
    }
    if (antwort.mech && antwort.mech !== OID_KRB5 && antwort.mech !== OID_MS_KRB5)
      throw new KerberosFehler('Kerberos: der Server hat einen anderen Mechanismus gewaehlt');
    if (!antwort.antwort) throw new KerberosFehler('Kerberos: der Server hat kein AP-REP geschickt');
    const { art, nachricht } = oeffneKrb5Token(antwort.antwort);
    if (art === 'fehler') {
      const f = leseKrbFehler(nachricht);
      throw new KerberosFehler(`Kerberos: der Server lehnt das Ticket ab (Fehlercode ${f.code}${f.text ? `, ${f.text}` : ''})`, f.code);
    }
    if (art !== 'ap-rep') throw new KerberosFehler('Kerberos: AP-REP erwartet');

    // Gegenseitige Authentifizierung: nur der echte Dienst kennt den
    // Sitzungsschluessel und kann den Zeitpunkt zurueckgeben.
    const inhalt = leseApAntwortInhalt(
      entschluesseln(this.ticket.sitzungsSchluessel, USAGE.AP_REP_ENC_PART, leseApAntwort(nachricht).cipher),
    );
    if (Math.floor(inhalt.zeit.getTime() / 1000) !== Math.floor(this.zeitpunkt.getTime() / 1000) ||
        inhalt.mikrosekunden !== (this.zeitpunkt.getTime() % 1000) * 1000) {
      throw new KerberosFehler('Kerberos: das AP-REP passt nicht zu unserer Anfrage');
    }
    this.sitzung = new GssKrb5Sitzung(
      inhalt.subkey ?? this.subkey,
      'initiator',
      inhalt.subkey !== undefined,
      this.folge,
      inhalt.sequenz ?? 0,
    );

    // mechListMIC (RFC 4178 5): schickt der Server eines, wird es geprueft und
    // mit einem eigenen beantwortet - sonst schliesst er die Aushandlung nicht ab.
    if (antwort.mechListMic) {
      const liste = mechListe(MECHS);
      this.sitzung.verifyMic(liste, antwort.mechListMic);
      return negTokenResp({ mechListMic: this.sitzung.getMic(liste) });
    }
    return undefined;
  }

  seal(daten: Buffer): Buffer {
    if (!this.sitzung) throw new Error('Kerberos: Kontext noch nicht aufgebaut');
    return this.sitzung.wrap(daten);
  }

  unseal(daten: Buffer): Buffer {
    if (!this.sitzung) throw new Error('Kerberos: Kontext noch nicht aufgebaut');
    return this.sitzung.unwrap(daten);
  }
}
