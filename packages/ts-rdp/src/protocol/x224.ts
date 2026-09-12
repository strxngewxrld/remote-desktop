/**
 * X.224-Verbindungsaufbau (MS-RDPBCGR 2.2.1.1 / 2.2.1.2).
 *
 * Hier wird ausgehandelt, welche Sicherheitsschicht darunter liegt: klassische
 * RDP-Security, TLS oder TLS + CredSSP (NLA/HYBRID).
 */
import { BinaryReader, writer } from '../core/binary.js';
import { NEG_FAILURE_CODES, RdpProtocolError } from '../core/errors.js';
import { TYPE_RDP_NEG_FAILURE, TYPE_RDP_NEG_REQ, TYPE_RDP_NEG_RSP } from './constants.js';

const TPDU_CONNECTION_REQUEST = 0xe0;
const TPDU_CONNECTION_CONFIRM = 0xd0;

export interface NegotiationResult {
  /** Vom Server gewaehltes Protokoll (PROTOCOL_RDP | PROTOCOL_SSL | PROTOCOL_HYBRID ...). */
  selectedProtocol: number;
  flags: number;
}

export interface ConnectionRequestOptions {
  requestedProtocols: number;
  /** Optionales "Cookie: mstshash=<user>" - Gateways/Loadbalancer routen danach. */
  cookie?: string;
  /** RESTRICTED_ADMIN_MODE_REQUIRED (0x01) usw. */
  negotiationFlags?: number;
}

export function buildConnectionRequest(opts: ConnectionRequestOptions): Buffer {
  const body = writer();
  if (opts.cookie) {
    body.ascii(`Cookie: mstshash=${opts.cookie}\r\n`);
  }
  body
    .uint8(TYPE_RDP_NEG_REQ)
    .uint8(opts.negotiationFlags ?? 0)
    .uint16le(8)
    .uint32le(opts.requestedProtocols);

  const payload = body.toBuffer();
  // li zaehlt alle Bytes des X.224-Headers nach dem Laengenbyte selbst.
  const li = 6 + payload.length;
  return writer()
    .uint8(li)
    .uint8(TPDU_CONNECTION_REQUEST)
    .uint16be(0) // dst-ref
    .uint16be(0) // src-ref
    .uint8(0) // class options
    .bytes(payload)
    .toBuffer();
}

/** Wertet das Connection Confirm PDU aus (Payload ohne TPKT-Header). */
export function parseConnectionConfirm(payload: Buffer): NegotiationResult {
  const r = new BinaryReader(payload);
  const li = r.uint8();
  const type = r.uint8();
  if (type !== TPDU_CONNECTION_CONFIRM) {
    throw new RdpProtocolError(`X.224: erwartet wurde Connection Confirm, gelesen 0x${type.toString(16)}`);
  }
  r.skip(5); // dst-ref, src-ref, class

  // Aeltere Server antworten ohne Negotiation-Struktur; das bedeutet Standard-RDP-Security.
  if (li < 6 + 8 || r.remaining < 8) {
    return { selectedProtocol: 0, flags: 0 };
  }

  const negType = r.uint8();
  const flags = r.uint8();
  r.uint16le(); // length, immer 8
  const value = r.uint32le();

  if (negType === TYPE_RDP_NEG_FAILURE) {
    const detail = NEG_FAILURE_CODES[value] ?? `Unbekannter Fehlercode 0x${value.toString(16)}`;
    throw new RdpProtocolError(`Der Server hat die Protokollaushandlung abgelehnt: ${detail}`);
  }
  if (negType !== TYPE_RDP_NEG_RSP) {
    throw new RdpProtocolError(`X.224: unerwarteter Negotiation-Typ 0x${negType.toString(16)}`);
  }
  return { selectedProtocol: value, flags };
}
