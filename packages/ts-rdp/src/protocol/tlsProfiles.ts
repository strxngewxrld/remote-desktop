/**
 * TLS-Kompatibilitaet mit RDP-Servern.
 *
 * Windows erzeugt fuer den Remotedesktopdienst ein selbstsigniertes Zertifikat,
 * dessen Erweiterung "Key Usage" nur `keyEncipherment` und `dataEncipherment`
 * enthaelt - `digitalSignature` fehlt. Damit darf der Schluessel formal nichts
 * signieren, und genau das verlangen ECDHE-Suiten sowie saemtliche
 * TLS-1.3-Verfahren fuer den ServerKeyExchange.
 *
 * OpenSSL wertet das als Zertifikatsfehler, den `rejectUnauthorized: false`
 * uebergeht. BoringSSL - und damit der Extension-Host von VS Code - bricht den
 * Handshake stattdessen hart mit KEY_USAGE_BIT_INCORRECT ab, unabhaengig von
 * der Zertifikatspruefung.
 *
 * Ausweg ist der statische RSA-Schluesselaustausch: der verschluesselt das
 * Premaster Secret mit dem oeffentlichen Schluessel des Servers und braucht
 * deshalb nur `keyEncipherment` - vorhanden. Das kostet Forward Secrecy, ist
 * aber genau das, was mstsc mit solchen Zertifikaten ebenfalls tut. Der Schutz
 * gegen zwischengeschaltete Angreifer haengt bei RDP ohnehin nicht allein an
 * TLS, sondern an der CredSSP-Bindung des oeffentlichen Serverschluessels und
 * am geprueften Zertifikatsfingerabdruck.
 */
import type { SecureVersion } from 'node:tls';

export interface TlsProfile {
  ciphers?: string;
  minVersion?: SecureVersion;
  maxVersion?: SecureVersion;
}

/** Bevorzugt: moderne Suiten, alles was der Server anbietet. */
export const MODERN_TLS_PROFILE: TlsProfile = {
  minVersion: 'TLSv1',
};

/**
 * Rueckfallebene fuer Zertifikate ohne `digitalSignature`: ausschliesslich
 * Suiten mit statischem RSA-Schluesselaustausch, dadurch zwingend TLS 1.2 oder
 * aelter (TLS 1.3 kennt keinen RSA-Schluesselaustausch mehr).
 */
export const LEGACY_TLS_PROFILE: TlsProfile = {
  ciphers: [
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'AES128-SHA256',
    'AES256-SHA256',
    'AES128-SHA',
    'AES256-SHA',
  ].join(':'),
  minVersion: 'TLSv1',
  maxVersion: 'TLSv1.2',
};

/**
 * Meldungen und Codes, bei denen ein zweiter Versuch mit der Rueckfallebene
 * sinnvoll ist: alle beschreiben eine Unvertraeglichkeit beim Handshake, nicht
 * eine abgelehnte Identitaet.
 */
// BoringSSL schreibt diese Fehler als KEY_USAGE_BIT_INCORRECT, OpenSSL als
// "sslv3 alert handshake failure" - die Muster muessen beide Schreibweisen treffen.
const COMPATIBILITY_PATTERNS = [
  /KEY[_ ]USAGE[_ ]BIT[_ ]INCORRECT/i,
  /NO[_ ]SHARED[_ ]CIPHER/i,
  /UNSUPPORTED[_ ]PROTOCOL/i,
  /WRONG[_ ]VERSION[_ ]NUMBER/i,
  /UNSUPPORTED[_ ]VERSION/i,
  /PROTOCOL[_ ]VERSION/i,
  /HANDSHAKE[_ ]FAILURE/i,
  /SSLV3[_ ]ALERT/i,
  /INAPPROPRIATE[_ ]FALLBACK/i,
];

/** Fehlercodes, die generisch fuer einen gescheiterten Handshake stehen. */
const COMPATIBILITY_CODES = new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_NO_CIPHER_MATCH']);

/** Lohnt sich bei diesem Fehler ein Wiederholversuch mit der Rueckfallebene? */
export function isTlsCompatibilityError(error: unknown): boolean {
  if (!error) return false;
  const err = error as NodeJS.ErrnoException & { reason?: string };
  if (err.code && COMPATIBILITY_CODES.has(err.code)) return true;
  const haystack = [err.message, err.reason, err.code].filter(Boolean).join(' ');
  return haystack.length > 0 && COMPATIBILITY_PATTERNS.some((pattern) => pattern.test(haystack));
}

/** Erklaert dem Anwender, warum der zweite Versuch noetig war. */
export const LEGACY_TLS_EXPLANATION =
  'Das Serverzertifikat erlaubt keine Signaturen (Key Usage ohne digitalSignature) - ' +
  'typisch fuer das selbstsignierte Zertifikat des Windows-Remotedesktopdienstes. ' +
  'Der Handshake wird mit statischem RSA-Schluesselaustausch und TLS 1.2 wiederholt.';
