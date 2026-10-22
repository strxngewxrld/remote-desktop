/**
 * Geht Kerberos fuer diese Verbindung ueberhaupt - und mit welchem Realm?
 *
 * Kerberos braucht drei Dinge, die NTLM nicht braucht: einen Rechnernamen
 * (das Ticket gilt fuer TERMSRV/<name>, eine IP-Adresse hat keinen SPN), einen
 * Realm (der DNS-Name der Domaene, nicht ihr NetBIOS-Name) und einen KDC.
 * Hier stehen die ersten beiden; ob ein KDC antwortet, zeigt erst der Versuch.
 */
import { isIP } from 'node:net';

export type KerberosZiel =
  | { ok: true; realm: string; benutzer: string; dienst: string }
  | { ok: false; grund: string };

export function kerberosZiel(eingabe: {
  host: string;
  benutzer: string;
  domain?: string;
  realm?: string;
}): KerberosZiel {
  if (isIP(eingabe.host)) {
    return { ok: false, grund: `"${eingabe.host}" ist eine IP-Adresse - Kerberos braucht den Rechnernamen` };
  }
  let benutzer = eingabe.benutzer;
  let realm = eingabe.realm?.trim();
  // benutzer@firma.de: der Teil hinter dem @ ist der Realm, wenn keiner vorgegeben ist.
  const at = benutzer.lastIndexOf('@');
  if (at > 0) {
    if (!realm) realm = benutzer.slice(at + 1);
    benutzer = benutzer.slice(0, at);
  }
  if (!realm && eingabe.domain && eingabe.domain.includes('.')) realm = eingabe.domain;
  if (!realm) {
    return {
      ok: false,
      grund: eingabe.domain
        ? `die Domaene "${eingabe.domain}" ist ein NetBIOS-Name; fuer Kerberos den DNS-Namen als Realm angeben oder als benutzer@domaene anmelden`
        : 'kein Realm bekannt; als benutzer@domaene anmelden oder den Realm angeben',
    };
  }
  return { ok: true, realm: realm.toUpperCase(), benutzer, dienst: `TERMSRV/${eingabe.host}` };
}
