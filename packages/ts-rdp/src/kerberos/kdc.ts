/**
 * Der Weg zum Dienst-Ticket: KDC finden, TGT holen (AS), Ticket fuer
 * TERMSRV/<host> holen (TGS). RFC 4120 Abschnitte 3.1 und 3.3.
 *
 * Nur TCP (RFC 4120 7.2.2): ein vierstelliges Laengenpraefix, dann die
 * Nachricht. UDP waere bei Windows ohnehin meist zu klein - die PAC macht
 * die Antworten gross, und ein KDC antwortet dann mit RESPONSE_TOO_BIG.
 */
import * as net from 'node:net';
import { promises as dns } from 'node:dns';
import { randomInt } from 'node:crypto';
import {
  type KerberosSchluessel,
  UNTERSTUETZTE_ETYPES,
  USAGE,
  entschluesseln,
  istUnterstuetzt,
  pruefsumme,
  pruefsummenTyp,
  schluesselAusPasswort,
  verschluesseln,
} from './crypto.js';
import {
  AS_REQ,
  AS_REP,
  KDC_ERR,
  KRB_ERROR,
  NT_PRINCIPAL,
  NT_SRV_INST,
  PA_ENC_TIMESTAMP,
  PA_ETYPE_INFO2,
  PA_PAC_REQUEST,
  PA_TGS_REQ,
  TGS_REQ,
  TGS_REP,
  type PaDaten,
  type Prinzipal,
  type Ticket,
  apAnfrage,
  appNummer,
  authenticator,
  kdcAnfrage,
  kdcAnfrageRumpf,
  leseEtypeInfo2,
  leseKdcAntwort,
  leseKdcAntwortInhalt,
  leseKrbFehler,
  lesePaDatenListe,
  pacAnfrage,
  verschluesselteDaten,
  zeitstempel,
} from './asn1.js';
import { readElement } from '../asn1/der.js';

/** Ein Fehler des KDC mit seinem Code - der Aufrufer entscheidet, ob er auf NTLM ausweicht. */
export class KerberosFehler extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'KerberosFehler';
  }
}

export interface KdcAdresse {
  host: string;
  port: number;
}

export interface KerberosAnmeldung {
  realm: string;
  benutzer: string;
  passwort: string;
  /** KDC fest vorgegeben; sonst DNS-SRV `_kerberos._tcp.<realm>`, dann der Realm selbst. */
  kdc?: KdcAdresse[];
  zeitlimitMs?: number;
  signal?: AbortSignal;
  /** Fuer Tests: die Uhr. */
  jetzt?: () => Date;
}

export interface DienstTicket {
  ticket: Ticket;
  sitzungsSchluessel: KerberosSchluessel;
  /** Name und Realm des Benutzers, wie der KDC sie bestaetigt hat. */
  crealm: string;
  cname: Prinzipal;
  kdc: KdcAdresse;
}

const MELDUNGEN: Record<number, string> = {
  [KDC_ERR.C_PRINCIPAL_UNKNOWN]: 'der Benutzer ist dem KDC unbekannt',
  [KDC_ERR.S_PRINCIPAL_UNKNOWN]: 'der Dienst ist dem KDC unbekannt (SPN nicht registriert - meist eine IP-Adresse oder ein Kurzname statt des Rechnernamens)',
  [KDC_ERR.ETYPE_NOSUPP]: 'der KDC bietet kein AES an',
  [KDC_ERR.PREAUTH_FAILED]: 'das Passwort ist falsch',
  [KDC_ERR.KRB_AP_ERR_SKEW]: 'die Uhren von Client und KDC weichen mehr als fuenf Minuten voneinander ab',
  [KDC_ERR.WRONG_REALM]: 'falscher Realm',
};

function fehlerAusAntwort(daten: Buffer, schritt: string): KerberosFehler {
  const f = leseKrbFehler(daten);
  const text = MELDUNGEN[f.code] ?? `Fehlercode ${f.code}`;
  return new KerberosFehler(`Kerberos (${schritt}): ${text}${f.text ? ` - ${f.text}` : ''}`, f.code);
}

// -------------------------------------------------------------- Transport

/** Eine Nachricht an den KDC und seine Antwort (RFC 4120 7.2.2). */
export function frageKdc(adresse: KdcAdresse, nachricht: Buffer, zeitlimitMs = 10000, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((erfuellt, abgelehnt) => {
    if (signal?.aborted) { abgelehnt(signal.reason); return; }
    const socket = net.connect(adresse.port, adresse.host);
    const teile: Buffer[] = [];
    let laenge = 0;
    const kopf = Buffer.alloc(4);
    let kopfBytes = 0;
    let erwartet: number | undefined;
    let fertig = false;
    const ende = (fehler?: Error, ergebnis?: Buffer) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abbrechen);
      socket.destroy();
      if (fehler) abgelehnt(fehler);
      else erfuellt(ergebnis!);
    };
    const timer = setTimeout(
      () => ende(new KerberosFehler(`Kerberos: KDC ${adresse.host}:${adresse.port} antwortet nicht`)),
      zeitlimitMs,
    );
    const abbrechen = () => ende(signal?.reason ?? new Error('Kerberos abgebrochen'));
    signal?.addEventListener('abort', abbrechen, { once: true });
    socket.on('connect', () => {
      const anfrageKopf = Buffer.alloc(4);
      anfrageKopf.writeUInt32BE(nachricht.length, 0);
      socket.write(Buffer.concat([anfrageKopf, nachricht]));
    });
    socket.on('data', (stueck) => {
      if (fertig) return;
      let offset = 0;
      if (kopfBytes < 4) {
        offset = Math.min(4 - kopfBytes, stueck.length);
        stueck.copy(kopf, kopfBytes, 0, offset);
        kopfBytes += offset;
        if (kopfBytes < 4) return;
        erwartet = kopf.readUInt32BE(0);
      }
      // Das hoechste Bit ist fuer Erweiterungen reserviert; eine Antwort ueber
      // 16 MiB ist kein Ticket mehr.
      if (!erwartet || erwartet > 16 * 1024 * 1024) return ende(new KerberosFehler('Kerberos: unplausible Antwortlaenge vom KDC'));
      const daten = stueck.subarray(offset);
      laenge += daten.length;
      if (laenge > erwartet) return ende(new KerberosFehler('Kerberos: KDC-Antwort laenger als angekuendigt'));
      if (daten.length) teile.push(daten);
      if (laenge === erwartet) ende(undefined, Buffer.concat(teile, laenge));
    });
    socket.on('error', (err) => ende(new KerberosFehler(`Kerberos: KDC ${adresse.host}:${adresse.port} nicht erreichbar (${err.message})`)));
    socket.on('close', () => ende(new KerberosFehler('Kerberos: der KDC hat die Verbindung ohne Antwort beendet')));
  });
}

/** Die KDCs eines Realms: DNS-SRV, und wenn das nichts liefert, der Realm als Rechnername. */
export async function findeKdc(realm: string): Promise<KdcAdresse[]> {
  try {
    const eintraege = await dns.resolveSrv(`_kerberos._tcp.${realm.toLowerCase()}`);
    if (eintraege.length) {
      return eintraege
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
        .map((e) => ({ host: e.name, port: e.port }));
    }
  } catch {
    // Kein SRV-Eintrag - in einer AD-Domaene loest der Domaenenname selbst
    // auf die Domaenencontroller auf.
  }
  return [{ host: realm.toLowerCase(), port: 88 }];
}

// ---------------------------------------------------------------- Ablauf

function nonce(): number {
  return randomInt(1, 0x7fffffff);
}

/** Das Standardsalz (RFC 4120 4): Realm, dann die Namensteile ohne Trenner. */
function standardSalz(realm: string, name: Prinzipal): string {
  return realm + name.teile.join('');
}

async function frageReihum(
  adressen: KdcAdresse[],
  nachricht: Buffer,
  zeitlimitMs?: number,
  signal?: AbortSignal,
): Promise<{ antwort: Buffer; kdc: KdcAdresse }> {
  let letzter: unknown;
  for (const kdc of adressen) {
    signal?.throwIfAborted();
    try {
      return { antwort: await frageKdc(kdc, nachricht, zeitlimitMs, signal), kdc };
    } catch (err) {
      letzter = err;
    }
  }
  throw letzter ?? new KerberosFehler('Kerberos: kein KDC bekannt');
}

/**
 * Ein Dienst-Ticket fuer `dienst` (etwa `TERMSRV/server.firma.de`) holen.
 *
 * Ablauf: AS-REQ ohne Vorab-Authentifizierung - der KDC antwortet mit
 * PREAUTH_REQUIRED und nennt Verfahren und Salz. Dann AS-REQ mit
 * verschluesseltem Zeitstempel, daraus das TGT. Dann TGS-REQ fuer den Dienst.
 */
export async function holeDienstTicket(anmeldung: KerberosAnmeldung, dienst: string): Promise<DienstTicket> {
  anmeldung.signal?.throwIfAborted();
  const jetzt = anmeldung.jetzt ?? (() => new Date());
  const realm = anmeldung.realm.toUpperCase();
  const adressen = anmeldung.kdc?.length ? anmeldung.kdc : await findeKdc(realm);
  const cname: Prinzipal = { typ: NT_PRINCIPAL, teile: [anmeldung.benutzer] };
  const tgs: Prinzipal = { typ: NT_SRV_INST, teile: ['krbtgt', realm] };
  const pac: PaDaten = { typ: PA_PAC_REQUEST, wert: pacAnfrage(true) };

  const asAnfrage = (padata: PaDaten[], n: number) =>
    kdcAnfrage(
      AS_REQ,
      padata,
      kdcAnfrageRumpf({
        cname,
        realm,
        sname: tgs,
        till: new Date(jetzt().getTime() + 10 * 3600 * 1000),
        nonce: n,
        etypes: UNTERSTUETZTE_ETYPES,
      }),
    );

  // 1. Ohne Vorab-Authentifizierung - nur um Verfahren und Salz zu erfahren.
  let n = nonce();
  let { antwort, kdc } = await frageReihum(adressen, asAnfrage([pac], n), anmeldung.zeitlimitMs, anmeldung.signal);
  const ziel = [kdc];

  let etypeInfo: { etype: number; salz?: string; iterationen?: number } | undefined;
  const merkeEtypeInfo = (padata: PaDaten[]) => {
    const info = padata.find((p) => p.typ === PA_ETYPE_INFO2);
    if (!info) return;
    const passend = leseEtypeInfo2(info.wert).find((e) => istUnterstuetzt(e.etype));
    if (passend) etypeInfo = passend;
  };

  if (appNummer(antwort) === KRB_ERROR) {
    const f = leseKrbFehler(antwort);
    if (f.code !== KDC_ERR.PREAUTH_REQUIRED) throw fehlerAusAntwort(antwort, 'Anmeldung');
    // e-data ist METHOD-DATA: eine Folge von PA-DATA.
    if (f.eData) merkeEtypeInfo(lesePaDatenListe(readElement(f.eData)));
    if (!etypeInfo) throw new KerberosFehler('Kerberos: der KDC bietet kein unterstuetztes Verfahren (AES) an', KDC_ERR.ETYPE_NOSUPP);

    const schluessel = schluesselAusPasswort(
      etypeInfo.etype,
      anmeldung.passwort,
      etypeInfo.salz ?? standardSalz(realm, cname),
      etypeInfo.iterationen,
    );
    const ts: PaDaten = {
      typ: PA_ENC_TIMESTAMP,
      wert: verschluesselteDaten({
        etype: schluessel.etype,
        cipher: verschluesseln(schluessel, USAGE.PA_ENC_TIMESTAMP, zeitstempel(jetzt())),
      }),
    };
    n = nonce();
    ({ antwort } = await frageReihum(ziel, asAnfrage([ts, pac], n), anmeldung.zeitlimitMs, anmeldung.signal));
    if (appNummer(antwort) === KRB_ERROR) throw fehlerAusAntwort(antwort, 'Anmeldung');
  }

  // 2. Das TGT. Ohne Vorab-Authentifizierung kennt der Client das Salz nur
  //    aus der Antwort selbst.
  const asRep = leseKdcAntwort(antwort);
  if (asRep.art !== AS_REP) throw new KerberosFehler('Kerberos: AS-REP erwartet');
  merkeEtypeInfo(asRep.padata);
  const etype = asRep.encPart.etype;
  if (!istUnterstuetzt(etype)) throw new KerberosFehler(`Kerberos: Antwort mit nicht unterstuetztem Verfahren ${etype}`);
  const benutzerSchluessel = schluesselAusPasswort(
    etype,
    anmeldung.passwort,
    etypeInfo?.etype === etype && etypeInfo.salz !== undefined ? etypeInfo.salz : standardSalz(realm, cname),
    etypeInfo?.etype === etype ? etypeInfo.iterationen : undefined,
  );
  let asInhalt;
  try {
    asInhalt = leseKdcAntwortInhalt(entschluesseln(benutzerSchluessel, USAGE.AS_REP_ENC_PART, asRep.encPart.cipher));
  } catch {
    throw new KerberosFehler('Kerberos (Anmeldung): die Antwort des KDC laesst sich nicht entschluesseln - meist ist das Passwort falsch', KDC_ERR.PREAUTH_FAILED);
  }
  if (asInhalt.nonce !== n) throw new KerberosFehler('Kerberos: die Antwort des KDC gehoert nicht zu dieser Anfrage');

  // 3. Das Dienst-Ticket. Der Realm kommt aus der Antwort: ein Windows-KDC
  //    schreibt ihn so, wie er ihn kennt (canonicalize).
  const crealm = asRep.crealm;
  const tgsNonce = nonce();
  const rumpf = kdcAnfrageRumpf({
    realm: crealm,
    sname: { typ: NT_SRV_INST, teile: dienst.split('/') },
    till: new Date(jetzt().getTime() + 10 * 3600 * 1000),
    nonce: tgsNonce,
    etypes: UNTERSTUETZTE_ETYPES,
  });
  const zeitpunkt = jetzt();
  const auth = authenticator({
    crealm,
    cname: asRep.cname,
    pruefsumme: {
      typ: pruefsummenTyp(asInhalt.schluessel.etype),
      wert: pruefsumme(asInhalt.schluessel, USAGE.TGS_REQ_AUTH_CKSUM, rumpf),
    },
    zeit: zeitpunkt,
  });
  const paTgs: PaDaten = {
    typ: PA_TGS_REQ,
    wert: apAnfrage(
      asRep.ticket.roh,
      { etype: asInhalt.schluessel.etype, cipher: verschluesseln(asInhalt.schluessel, USAGE.TGS_REQ_AUTHENTICATOR, auth) },
      0,
    ),
  };
  const { antwort: tgsAntwort } = await frageReihum(ziel, kdcAnfrage(TGS_REQ, [paTgs], rumpf), anmeldung.zeitlimitMs, anmeldung.signal);
  if (appNummer(tgsAntwort) === KRB_ERROR) throw fehlerAusAntwort(tgsAntwort, `Ticket fuer ${dienst}`);
  const tgsRep = leseKdcAntwort(tgsAntwort);
  if (tgsRep.art !== TGS_REP) throw new KerberosFehler('Kerberos: TGS-REP erwartet');
  const tgsInhalt = leseKdcAntwortInhalt(
    entschluesseln(asInhalt.schluessel, USAGE.TGS_REP_ENC_PART_SESSION, tgsRep.encPart.cipher),
  );
  if (tgsInhalt.nonce !== tgsNonce) throw new KerberosFehler('Kerberos: die Ticketantwort gehoert nicht zu dieser Anfrage');
  const erwartet = dienst.toLowerCase();
  if (tgsInhalt.sname.teile.join('/').toLowerCase() !== erwartet ||
      tgsRep.ticket.sname.teile.join('/').toLowerCase() !== erwartet ||
      tgsRep.ticket.realm.toUpperCase() !== tgsInhalt.srealm.toUpperCase() ||
      tgsInhalt.endtime.getTime() <= jetzt().getTime())
    throw new KerberosFehler('Kerberos: Dienstname, Realm oder Gueltigkeit des Tickets stimmt nicht');

  return { ticket: tgsRep.ticket, sitzungsSchluessel: tgsInhalt.schluessel, crealm, cname: asRep.cname, kdc };
}
