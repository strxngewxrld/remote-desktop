/**
 * Zertifikatsabfrage vor dem eigentlichen Verbindungsaufbau.
 *
 * Sinn der Sache: bei NLA gehen die Zugangsdaten schon waehrend des Handshakes
 * ueber die Leitung. Wer das Serverzertifikat erst danach prueft, hat sein
 * Passwort im Zweifel bereits an den Falschen geschickt. Darum wird hier
 * vorab eine eigene Verbindung nur zum Einsammeln des Zertifikats aufgebaut.
 */
import { createHash } from 'node:crypto';
import { RdpTransport, parseFrame, tpktRaw } from './protocol/transport.js';
import { buildConnectionRequest, parseConnectionConfirm } from './protocol/x224.js';
import { PROTOCOL_HYBRID, PROTOCOL_RDP, PROTOCOL_SSL } from './protocol/constants.js';
import { RdpError } from './core/errors.js';
import {
  LEGACY_TLS_PROFILE,
  MODERN_TLS_PROFILE,
  TlsProfile,
  isTlsCompatibilityError,
} from './protocol/tlsProfiles.js';

export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256-Fingerabdruck in Doppelpunktschreibweise. */
  fingerprint256: string;
  selfSigned: boolean;
  /** Vom Server ausgehandeltes Sicherheitsprotokoll. */
  selectedProtocol: number;
}

export interface ProbeOptions {
  host: string;
  port?: number;
  connectTimeout?: number;
  /** NLA anfragen (beeinflusst nur, was der Server als gewaehltes Protokoll meldet). */
  useNla?: boolean;
}

/**
 * Holt das Zertifikat. Scheitert der Handshake an einer Unvertraeglichkeit,
 * wird einmal mit der Rueckfallebene wiederholt - dieselbe Logik wie beim
 * eigentlichen Verbindungsaufbau, damit die Pruefung nie strenger ist als die
 * spaetere Verbindung.
 */
export async function probeServerCertificate(opts: ProbeOptions): Promise<CertificateInfo> {
  try {
    return await probeOnce(opts, MODERN_TLS_PROFILE);
  } catch (err) {
    if (!isTlsCompatibilityError(err)) throw err;
    return probeOnce(opts, LEGACY_TLS_PROFILE);
  }
}

async function probeOnce(opts: ProbeOptions, tlsProfile: TlsProfile): Promise<CertificateInfo> {
  const transport = new RdpTransport({
    host: opts.host,
    port: opts.port ?? 3389,
    connectTimeout: opts.connectTimeout,
    rejectUnauthorized: false,
    tlsProfile,
  });

  try {
    await transport.connect();
    const requested = PROTOCOL_SSL | (opts.useNla === false ? 0 : PROTOCOL_HYBRID);
    transport.write(tpktRaw(buildConnectionRequest({ requestedProtocols: requested })));
    const confirm = await transport.nextFrame('tpkt');
    const negotiation = parseConnectionConfirm(parseFrame(confirm).payload);

    if (negotiation.selectedProtocol === PROTOCOL_RDP) {
      throw new RdpError(
        'Der Server verwendet die alte RDP-Standardverschluesselung ohne TLS.',
        'RDP_UNSUPPORTED_SECURITY',
      );
    }

    const socket = await transport.upgradeTls();
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.raw) throw new RdpError('Der Server hat kein Zertifikat vorgelegt', 'RDP_TLS');

    const digest = createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
    return {
      subject: formatName(cert.subject),
      issuer: formatName(cert.issuer),
      validFrom: cert.valid_from,
      validTo: cert.valid_to,
      fingerprint256: digest.match(/.{2}/g)!.join(':'),
      selfSigned: formatName(cert.subject) === formatName(cert.issuer),
      selectedProtocol: negotiation.selectedProtocol,
    };
  } finally {
    transport.close();
  }
}

function formatName(name: Record<string, string | string[] | undefined> | undefined): string {
  if (!name) return '';
  const cn = name.CN;
  if (cn) return Array.isArray(cn) ? cn[0] : cn;
  return Object.entries(name)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`)
    .join(', ');
}
