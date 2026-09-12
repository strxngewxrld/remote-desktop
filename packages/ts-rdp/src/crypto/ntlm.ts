/**
 * NTLMv2 (MS-NLMP) - genau so viel, wie CredSSP/NLA fuer RDP braucht:
 * NEGOTIATE -> CHALLENGE -> AUTHENTICATE, danach Signieren/Sealen der
 * CredSSP-Nachrichten mit Extended Session Security.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BinaryReader, BinaryWriter, reader, writer } from '../core/binary.js';
import { md4 } from './md4.js';
import { Rc4 } from './rc4.js';

export const NTLMSSP_NEGOTIATE_UNICODE = 0x00000001;
export const NTLMSSP_REQUEST_TARGET = 0x00000004;
export const NTLMSSP_NEGOTIATE_SIGN = 0x00000010;
export const NTLMSSP_NEGOTIATE_SEAL = 0x00000020;
export const NTLMSSP_NEGOTIATE_NTLM = 0x00000200;
export const NTLMSSP_NEGOTIATE_ALWAYS_SIGN = 0x00008000;
export const NTLMSSP_NEGOTIATE_EXTENDED_SESSION_SECURITY = 0x00080000;
export const NTLMSSP_NEGOTIATE_TARGET_INFO = 0x00800000;
export const NTLMSSP_NEGOTIATE_VERSION = 0x02000000;
export const NTLMSSP_NEGOTIATE_128 = 0x20000000;
export const NTLMSSP_NEGOTIATE_KEY_EXCH = 0x40000000;
export const NTLMSSP_NEGOTIATE_56 = 0x80000000;

const DEFAULT_FLAGS =
  (NTLMSSP_NEGOTIATE_56 |
    NTLMSSP_NEGOTIATE_KEY_EXCH |
    NTLMSSP_NEGOTIATE_128 |
    NTLMSSP_NEGOTIATE_VERSION |
    NTLMSSP_NEGOTIATE_EXTENDED_SESSION_SECURITY |
    NTLMSSP_NEGOTIATE_ALWAYS_SIGN |
    NTLMSSP_NEGOTIATE_NTLM |
    NTLMSSP_NEGOTIATE_SEAL |
    NTLMSSP_NEGOTIATE_SIGN |
    NTLMSSP_REQUEST_TARGET |
    NTLMSSP_NEGOTIATE_UNICODE) >>> 0;

const SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii');

/** AV-Pair-IDs aus dem TargetInfo-Block (MS-NLMP 2.2.2.1). */
export const MsvAvEOL = 0x0000;
export const MsvAvNbComputerName = 0x0001;
export const MsvAvNbDomainName = 0x0002;
export const MsvAvDnsComputerName = 0x0003;
export const MsvAvDnsDomainName = 0x0004;
export const MsvAvTimestamp = 0x0007;
export const MsvAvFlags = 0x0006;
export const MsvAvChannelBindings = 0x000a;
export const MsvAvTargetName = 0x0009;

export interface NtlmChallenge {
  targetName: string;
  flags: number;
  serverChallenge: Buffer;
  targetInfo: Buffer;
  raw: Buffer;
}

function unicode(s: string): Buffer {
  return Buffer.from(s, 'ucs2');
}

function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return createHmac('md5', key).update(data).digest();
}

function md5(...parts: Buffer[]): Buffer {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** NT-Hash: MD4 ueber das UTF-16LE-Passwort (NTOWFv1). */
export function ntowfv1(password: string): Buffer {
  return md4(unicode(password));
}

/** NTOWFv2 = HMAC_MD5(NTOWFv1, UPPER(user) + domain). */
export function ntowfv2(user: string, password: string, domain: string): Buffer {
  return hmacMd5(ntowfv1(password), unicode(user.toUpperCase() + domain));
}

/** Windows-FILETIME (100ns seit 1601) als 8-Byte-Little-Endian. */
export function filetime(date = new Date()): Buffer {
  const t = BigInt(date.getTime()) * 10000n + 116444736000000000n;
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(t);
  return b;
}

/** Zerlegt einen TargetInfo-Block in seine AV-Paare. */
export function parseAvPairs(buf: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  const r = reader(buf);
  while (r.remaining >= 4) {
    const id = r.uint16le();
    const len = r.uint16le();
    if (id === MsvAvEOL) break;
    out.set(id, r.bytes(len));
  }
  return out;
}

/** Baut einen TargetInfo-Block aus AV-Paaren (EOL wird automatisch angehaengt). */
export function buildAvPairs(pairs: Map<number, Buffer>): Buffer {
  const w = writer();
  for (const [id, value] of pairs) {
    if (id === MsvAvEOL) continue;
    w.uint16le(id).uint16le(value.length).bytes(value);
  }
  w.uint16le(MsvAvEOL).uint16le(0);
  return w.toBuffer();
}

function versionBlock(): Buffer {
  // Windows 10.0.19041, NTLM-Revision 15 - rein kosmetisch, aber manche
  // Server protokollieren es und einige Middleboxen erwarten ein Feld != 0.
  return Buffer.from([10, 0, 0xb3, 0x4a, 0x00, 0x00, 0x00, 0x0f]);
}

/** Feld-Deskriptor (len, maxLen, offset) fuer die NTLM-Payload-Bereiche. */
function field(w: BinaryWriter, len: number, offset: number): void {
  w.uint16le(len).uint16le(len).uint32le(offset);
}

export interface NtlmV2Input {
  /** NTOWFv2 = HMAC_MD5(MD4(UTF16(Passwort)), UPPER(user) + domain) */
  responseKey: Buffer;
  serverChallenge: Buffer;
  clientChallenge: Buffer;
  /** Windows-FILETIME, 8 Byte Little Endian. */
  timestamp: Buffer;
  targetInfo: Buffer;
}

export interface NtlmV2Response {
  ntChallengeResponse: Buffer;
  lmChallengeResponse: Buffer;
  sessionBaseKey: Buffer;
  ntProofStr: Buffer;
}

/**
 * NTLMv2-Antwort nach MS-NLMP 3.3.2. Als eigene Funktion herausgezogen, damit
 * sie mit den Testvektoren aus MS-NLMP 4.2.4 geprueft werden kann - `authenticate()`
 * selbst zieht Zufallswerte und waere so nicht reproduzierbar.
 */
export function computeNtlmV2Response(input: NtlmV2Input): NtlmV2Response {
  // temp = Responderversion || HiResponderversion || Z(6) || Timestamp ||
  //        ClientChallenge || Z(4) || TargetInfo || Z(4)
  const temp = writer()
    .uint8(1)
    .uint8(1)
    .zeros(6)
    .bytes(input.timestamp)
    .bytes(input.clientChallenge)
    .zeros(4)
    .bytes(input.targetInfo)
    .zeros(4)
    .toBuffer();

  const ntProofStr = hmacMd5(input.responseKey, Buffer.concat([input.serverChallenge, temp]));
  return {
    ntProofStr,
    ntChallengeResponse: Buffer.concat([ntProofStr, temp]),
    lmChallengeResponse: Buffer.concat([
      hmacMd5(input.responseKey, Buffer.concat([input.serverChallenge, input.clientChallenge])),
      input.clientChallenge,
    ]),
    sessionBaseKey: hmacMd5(input.responseKey, ntProofStr),
  };
}

export interface NtlmOptions {
  domain: string;
  user: string;
  password: string;
  workstation?: string;
  /** MD5 der gss_channel_bindings-Struktur; nur noetig, wenn der Server EPA erzwingt. */
  channelBindings?: Buffer;
  /** SPN, z.B. "TERMSRV/host" - wird als MsvAvTargetName eingetragen, wenn gesetzt. */
  servicePrincipalName?: string;
}

/**
 * Zustandsbehafteter NTLM-Client. Die Instanz haelt nach `authenticate()` die
 * Sign-/Seal-Schluessel und kann Nachrichten fuer CredSSP versiegeln.
 */
export class NtlmClient {
  private negotiateMessage?: Buffer;
  private challenge?: NtlmChallenge;
  private exportedSessionKey?: Buffer;

  private clientSigningKey?: Buffer;
  private serverSigningKey?: Buffer;
  private clientSeal?: Rc4;
  private serverSeal?: Rc4;
  private clientSeq = 0;
  private serverSeq = 0;
  private negotiatedFlags = DEFAULT_FLAGS;

  constructor(private readonly opts: NtlmOptions) {}

  /** Schritt 1: NEGOTIATE_MESSAGE. */
  negotiate(): Buffer {
    const w = writer();
    w.bytes(SIGNATURE).uint32le(1).uint32le(DEFAULT_FLAGS);
    // Domain und Workstation bleiben leer; der Server leitet das Target selbst ab.
    field(w, 0, 40);
    field(w, 0, 40);
    w.bytes(versionBlock());
    this.negotiateMessage = w.toBuffer();
    return this.negotiateMessage;
  }

  /** Schritt 2: CHALLENGE_MESSAGE einlesen. */
  parseChallenge(buf: Buffer): NtlmChallenge {
    const r = new BinaryReader(buf);
    const sig = r.bytes(8);
    if (!sig.equals(SIGNATURE)) throw new Error('NTLM: ungueltige Signatur in CHALLENGE_MESSAGE');
    const type = r.uint32le();
    if (type !== 2) throw new Error(`NTLM: erwartet wurde MessageType 2, empfangen ${type}`);

    const tnLen = r.uint16le();
    r.uint16le();
    const tnOff = r.uint32le();
    const flags = r.uint32le();
    const serverChallenge = r.bytes(8);
    r.skip(8); // Reserved
    const tiLen = r.uint16le();
    r.uint16le();
    const tiOff = r.uint32le();

    const challenge: NtlmChallenge = {
      targetName: tnLen ? buf.subarray(tnOff, tnOff + tnLen).toString('ucs2') : '',
      flags,
      serverChallenge,
      targetInfo: tiLen ? buf.subarray(tiOff, tiOff + tiLen) : Buffer.alloc(0),
      raw: buf,
    };
    this.challenge = challenge;
    return challenge;
  }

  /**
   * Schritt 3: AUTHENTICATE_MESSAGE erzeugen und die Sitzungsschluessel
   * ableiten. Nach diesem Aufruf ist `seal()`/`unseal()` nutzbar.
   */
  authenticate(now = new Date()): Buffer {
    const challenge = this.challenge;
    const negotiateMessage = this.negotiateMessage;
    if (!challenge || !negotiateMessage) throw new Error('NTLM: negotiate()/parseChallenge() zuerst aufrufen');

    const { domain, user, password } = this.opts;
    const workstation = this.opts.workstation ?? 'TSCLIENT';

    const av = parseAvPairs(challenge.targetInfo);
    const serverTimestamp = av.get(MsvAvTimestamp);
    // Ein Zeitstempel im TargetInfo heisst: der Server erwartet einen MIC.
    const wantsMic = serverTimestamp !== undefined;
    if (wantsMic) av.set(MsvAvFlags, Buffer.from([0x02, 0x00, 0x00, 0x00]));
    if (this.opts.servicePrincipalName) {
      av.set(MsvAvTargetName, unicode(this.opts.servicePrincipalName));
    }
    if (this.opts.channelBindings) av.set(MsvAvChannelBindings, this.opts.channelBindings);
    const targetInfo = buildAvPairs(av);

    const responseKey = ntowfv2(user, password, domain);
    const clientChallenge = randomBytes(8);
    const timestamp = serverTimestamp ?? filetime(now);

    const { ntChallengeResponse, lmChallengeResponse, sessionBaseKey } = computeNtlmV2Response({
      responseKey,
      serverChallenge: challenge.serverChallenge,
      clientChallenge,
      timestamp,
      targetInfo,
    });
    const exportedSessionKey = randomBytes(16);
    const encryptedRandomSessionKey = new Rc4(sessionBaseKey).update(exportedSessionKey);
    this.exportedSessionKey = exportedSessionKey;

    const flags = (DEFAULT_FLAGS | (challenge.flags & NTLMSSP_NEGOTIATE_TARGET_INFO)) >>> 0;
    this.negotiatedFlags = flags;

    const domainB = unicode(domain);
    const userB = unicode(user);
    const wsB = unicode(workstation);

    // Fester Kopf der AUTHENTICATE_MESSAGE (MS-NLMP 2.2.1.3):
    // Signature 8 + MessageType 4 + sechs Felddeskriptoren a 8 = 60,
    // NegotiateFlags 4 = 64, Version 8 = 72, MIC 16 = 88. Danach die Payload.
    const MIC_OFFSET = 72;
    const base = MIC_OFFSET + 16;
    let off = base;
    const lmOff = off; off += lmChallengeResponse.length;
    const ntOff = off; off += ntChallengeResponse.length;
    const domOff = off; off += domainB.length;
    const userOff = off; off += userB.length;
    const wsOff = off; off += wsB.length;
    const keyOff = off; off += encryptedRandomSessionKey.length;

    const w = writer();
    w.bytes(SIGNATURE).uint32le(3);
    field(w, lmChallengeResponse.length, lmOff);
    field(w, ntChallengeResponse.length, ntOff);
    field(w, domainB.length, domOff);
    field(w, userB.length, userOff);
    field(w, wsB.length, wsOff);
    field(w, encryptedRandomSessionKey.length, keyOff);
    w.uint32le(flags);
    w.bytes(versionBlock());
    w.zeros(16); // MIC-Platzhalter
    w.bytes(lmChallengeResponse)
      .bytes(ntChallengeResponse)
      .bytes(domainB)
      .bytes(userB)
      .bytes(wsB)
      .bytes(encryptedRandomSessionKey);

    const message = w.toBuffer();
    if (wantsMic) {
      // MIC = HMAC_MD5(exportedSessionKey, NEGOTIATE || CHALLENGE || AUTHENTICATE)
      // wobei das MIC-Feld waehrend der Berechnung auf Null steht.
      const mic = hmacMd5(
        exportedSessionKey,
        Buffer.concat([negotiateMessage, challenge.raw, message]),
      );
      mic.copy(message, MIC_OFFSET);
    }

    this.deriveSessionKeys(exportedSessionKey);
    return message;
  }

  private deriveSessionKeys(key: Buffer): void {
    const magic = (s: string) => Buffer.from(s + '\0', 'ascii');
    this.clientSigningKey = md5(key, magic('session key to client-to-server signing key magic constant'));
    this.serverSigningKey = md5(key, magic('session key to server-to-client signing key magic constant'));
    const clientSealingKey = md5(key, magic('session key to client-to-server sealing key magic constant'));
    const serverSealingKey = md5(key, magic('session key to server-to-client sealing key magic constant'));
    this.clientSeal = new Rc4(clientSealingKey);
    this.serverSeal = new Rc4(serverSealingKey);
  }

  get sessionKey(): Buffer {
    if (!this.exportedSessionKey) throw new Error('NTLM: noch keine Sitzung ausgehandelt');
    return this.exportedSessionKey;
  }

  /**
   * Versiegelt eine Nachricht (Client -> Server): RC4 ueber die Nutzdaten,
   * Signatur ueber den Klartext. Rueckgabe ist Signatur || Chiffrat, genau so
   * wie CredSSP es in pubKeyAuth/authInfo erwartet.
   */
  seal(plaintext: Buffer): Buffer {
    if (!this.clientSeal || !this.clientSigningKey) throw new Error('NTLM: authenticate() zuerst aufrufen');
    const seq = this.clientSeq++;
    const sealed = this.clientSeal.update(plaintext);
    const signature = this.makeSignature(this.clientSigningKey, this.clientSeal, seq, plaintext);
    return Buffer.concat([signature, sealed]);
  }

  /** Gegenstueck zu `seal()` fuer Server -> Client, prueft die Signatur. */
  unseal(data: Buffer): Buffer {
    if (!this.serverSeal || !this.serverSigningKey) throw new Error('NTLM: authenticate() zuerst aufrufen');
    if (data.length < 16) throw new Error('NTLM: versiegelte Nachricht zu kurz');
    const signature = data.subarray(0, 16);
    const seq = this.serverSeq++;
    const plaintext = this.serverSeal.update(data.subarray(16));
    const expected = this.makeSignature(this.serverSigningKey, this.serverSeal, seq, plaintext);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new Error('NTLM: Signatur der Serverantwort ist ungueltig');
    }
    return plaintext;
  }

  private makeSignature(signingKey: Buffer, seal: Rc4, seq: number, plaintext: Buffer): Buffer {
    const seqBuf = Buffer.allocUnsafe(4);
    seqBuf.writeUInt32LE(seq >>> 0, 0);
    let checksum = hmacMd5(signingKey, Buffer.concat([seqBuf, plaintext])).subarray(0, 8);
    if (this.negotiatedFlags & NTLMSSP_NEGOTIATE_KEY_EXCH) checksum = seal.update(checksum);
    return Buffer.concat([Buffer.from([1, 0, 0, 0]), checksum, seqBuf]);
  }
}

/**
 * Channel-Binding-Token fuer TLS ("tls-server-end-point") als MD5 der
 * gss_channel_bindings-Struktur - noetig, wenn der Server Extended Protection
 * for Authentication erzwingt.
 */
export function tlsChannelBindings(certHash: Buffer): Buffer {
  const appData = Buffer.concat([Buffer.from('tls-server-end-point:', 'ascii'), certHash]);
  const w = writer();
  w.uint32le(0).uint32le(0).uint32le(0).uint32le(0).uint32le(appData.length).bytes(appData);
  return md5(w.toBuffer());
}
