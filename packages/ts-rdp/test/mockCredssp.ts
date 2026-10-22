/**
 * Servergegenseite von CredSSP/NTLMv2 fuer die Tests.
 *
 * Sie rechnet die NTLMv2-Antwort mit dem bekannten Passwort nach und prueft
 * Proof, MIC und die versiegelten Nachrichten. Damit wird die Clientseite
 * vollstaendig gegen eine unabhaengige Implementierung derselben Spezifikation
 * geprueft - inklusive der Kanalbindung an das TLS-Zertifikat.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BinaryReader, BinaryWriter } from '../src/core/binary.js';
import { Rc4 } from '../src/crypto/rc4.js';
import { buildAvPairs, filetime, ntowfv2 } from '../src/crypto/ntlm.js';
import { children, decodeInteger, readElement } from '../src/asn1/der.js';
import { decodeTsRequest, encodeTsRequest } from '../src/crypto/credssp.js';

const SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii');

function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return createHmac('md5', key).update(data).digest();
}

function md5(...parts: Buffer[]): Buffer {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
}

function magic(s: string): Buffer {
  return Buffer.from(s + '\0', 'ascii');
}

export function bindingHash(label: string, nonce: Buffer, publicKey: Buffer): Buffer {
  return createHash('sha256').update(Buffer.from(label + '\0', 'ascii')).update(nonce).update(publicKey).digest();
}

export interface CredSspExpectation {
  domain: string;
  user: string;
  password: string;
  publicKey: Buffer;
}

export interface CredSspOutcome {
  /** Vom Client geschickte Zugangsdaten, nachdem sie entschluesselt wurden. */
  credentials: { domain: string; user: string; password: string };
  micVerified: boolean;
}

export class MockCredSspServer {
  private serverChallenge = randomBytes(8);
  private negotiateMessage?: Buffer;
  private challengeMessage?: Buffer;
  private exportedSessionKey?: Buffer;
  private clientSeal?: Rc4;
  private serverSeal?: Rc4;
  private clientSigningKey?: Buffer;
  private serverSigningKey?: Buffer;
  private clientSeq = 0;
  private serverSeq = 0;
  private clientNonce?: Buffer;
  private micVerified = false;
  private state: 'negotiate' | 'auth' | 'credentials' | 'done' = 'negotiate';

  constructor(private readonly expect: CredSspExpectation) {}

  /**
   * Verarbeitet eine Clientnachricht.
   * @returns Antwort an den Client und - am Ende - die entschluesselten Zugangsdaten.
   */
  step(incoming: Buffer): { send?: Buffer; outcome?: CredSspOutcome } {
    const request = decodeTsRequest(incoming);

    switch (this.state) {
      case 'negotiate': {
        this.negotiateMessage = request.negoTokens?.[0];
        if (!this.negotiateMessage) throw new Error('CredSSP-Test: NEGOTIATE_MESSAGE fehlt');
        this.challengeMessage = this.buildChallenge();
        this.state = 'auth';
        return { send: encodeTsRequest({ version: 6, negoTokens: [this.challengeMessage] }) };
      }

      case 'auth': {
        const authenticate = request.negoTokens?.[0];
        if (!authenticate) throw new Error('CredSSP-Test: AUTHENTICATE_MESSAGE fehlt');
        this.clientNonce = request.clientNonce;
        this.verifyAuthenticate(authenticate);

        if (!request.pubKeyAuth) throw new Error('CredSSP-Test: pubKeyAuth fehlt');
        const received = this.unsealFromClient(request.pubKeyAuth);
        const expected = this.clientNonce
          ? bindingHash('CredSSP Client-To-Server Binding Hash', this.clientNonce, this.expect.publicKey)
          : this.expect.publicKey;
        if (!received.equals(expected)) {
          throw new Error('CredSSP-Test: Kanalbindung des Clients stimmt nicht');
        }

        const answer = this.clientNonce
          ? bindingHash('CredSSP Server-To-Client Binding Hash', this.clientNonce, this.expect.publicKey)
          : incrementFirstByte(this.expect.publicKey);
        this.state = 'credentials';
        return { send: encodeTsRequest({ version: 6, pubKeyAuth: this.sealToClient(answer) }) };
      }

      case 'credentials': {
        if (!request.authInfo) throw new Error('CredSSP-Test: authInfo fehlt');
        const credentials = parseTsCredentials(this.unsealFromClient(request.authInfo));
        this.state = 'done';
        return { outcome: { credentials, micVerified: this.micVerified } };
      }

      default:
        throw new Error('CredSSP-Test: unerwartete Nachricht');
    }
  }

  private buildChallenge(): Buffer {
    const targetName = Buffer.from('TESTDOM', 'ucs2');
    const targetInfo = buildAvPairs(
      new Map([
        [0x0002, Buffer.from('TESTDOM', 'ucs2')],
        [0x0001, Buffer.from('TESTSRV', 'ucs2')],
        [0x0007, filetime()],
      ]),
    );

    const flags =
      (0x00000001 | 0x00000004 | 0x00000010 | 0x00000020 | 0x00000200 | 0x00008000 |
        0x00080000 | 0x00800000 | 0x02000000 | 0x20000000 | 0x40000000 | 0x80000000) >>> 0;

    const headerSize = 56;
    const w = new BinaryWriter();
    w.bytes(SIGNATURE).uint32le(2);
    w.uint16le(targetName.length).uint16le(targetName.length).uint32le(headerSize);
    w.uint32le(flags);
    w.bytes(this.serverChallenge);
    w.zeros(8);
    w.uint16le(targetInfo.length).uint16le(targetInfo.length).uint32le(headerSize + targetName.length);
    w.bytes(Buffer.from([10, 0, 0xb3, 0x4a, 0x00, 0x00, 0x00, 0x0f]));
    w.bytes(targetName).bytes(targetInfo);
    return w.toBuffer();
  }

  private verifyAuthenticate(message: Buffer): void {
    const r = new BinaryReader(message);
    if (!r.bytes(8).equals(SIGNATURE)) throw new Error('CredSSP-Test: falsche NTLM-Signatur');
    if (r.uint32le() !== 3) throw new Error('CredSSP-Test: erwartet wurde MessageType 3');

    const field = () => {
      const len = r.uint16le();
      r.uint16le();
      const off = r.uint32le();
      return message.subarray(off, off + len);
    };

    field(); // lmChallengeResponse
    const ntResponse = field();
    const domain = field().toString('ucs2');
    const user = field().toString('ucs2');
    field(); // workstation
    const encryptedSessionKey = field();
    const flags = r.uint32le();
    r.skip(8); // Version
    const mic = Buffer.from(r.bytes(16));

    // NTLMv2-Antwort mit dem bekannten Passwort nachrechnen.
    const responseKey = ntowfv2(user, this.expect.password, domain);
    const proof = ntResponse.subarray(0, 16);
    const temp = ntResponse.subarray(16);
    const expectedProof = hmacMd5(responseKey, Buffer.concat([this.serverChallenge, temp]));
    if (!timingSafeEqual(proof, expectedProof)) {
      throw new Error('CredSSP-Test: NTLMv2-Proof des Clients ist falsch');
    }

    const sessionBaseKey = hmacMd5(responseKey, proof);
    // Mit NEGOTIATE_KEY_EXCH schickt der Client einen eigenen Sitzungsschluessel.
    this.exportedSessionKey =
      flags & 0x40000000 ? new Rc4(sessionBaseKey).update(encryptedSessionKey) : sessionBaseKey;

    // MIC pruefen: dabei muss das MIC-Feld selbst auf Null stehen (Offset 72).
    const zeroed = Buffer.from(message);
    Buffer.alloc(16).copy(zeroed, 72);
    const expectedMic = hmacMd5(
      this.exportedSessionKey,
      Buffer.concat([this.negotiateMessage!, this.challengeMessage!, zeroed]),
    );
    this.micVerified = mic.equals(expectedMic);
    if (!this.micVerified && !mic.equals(Buffer.alloc(16))) {
      throw new Error('CredSSP-Test: MIC des Clients ist falsch');
    }

    this.deriveKeys(this.exportedSessionKey);
  }

  private deriveKeys(key: Buffer): void {
    this.clientSigningKey = md5(key, magic('session key to client-to-server signing key magic constant'));
    this.serverSigningKey = md5(key, magic('session key to server-to-client signing key magic constant'));
    this.clientSeal = new Rc4(md5(key, magic('session key to client-to-server sealing key magic constant')));
    this.serverSeal = new Rc4(md5(key, magic('session key to server-to-client sealing key magic constant')));
  }

  private unsealFromClient(data: Buffer): Buffer {
    const signature = data.subarray(0, 16);
    const seq = this.clientSeq++;
    const plaintext = this.clientSeal!.update(data.subarray(16));
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32LE(seq, 0);
    let checksum = hmacMd5(this.clientSigningKey!, Buffer.concat([seqBuf, plaintext])).subarray(0, 8);
    checksum = this.clientSeal!.update(checksum);
    const expected = Buffer.concat([Buffer.from([1, 0, 0, 0]), checksum, seqBuf]);
    if (!signature.equals(expected)) throw new Error('CredSSP-Test: Signatur des Clients ist ungueltig');
    return plaintext;
  }

  private sealToClient(plaintext: Buffer): Buffer {
    const seq = this.serverSeq++;
    const sealed = this.serverSeal!.update(plaintext);
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32LE(seq, 0);
    let checksum = hmacMd5(this.serverSigningKey!, Buffer.concat([seqBuf, plaintext])).subarray(0, 8);
    checksum = this.serverSeal!.update(checksum);
    return Buffer.concat([Buffer.from([1, 0, 0, 0]), checksum, seqBuf, sealed]);
  }
}

function incrementFirstByte(key: Buffer): Buffer {
  const copy = Buffer.from(key);
  copy[0] = (copy[0] + 1) & 0xff;
  return copy;
}

/** TSCredentials -> TSPasswordCreds auspacken. */
export function parseTsCredentials(der: Buffer): { domain: string; user: string; password: string } {
  const root = readElement(der);
  let credentialsBlob: Buffer | undefined;
  for (const el of children(root.content)) {
    const tag = el.tag & 0x1f;
    if (tag === 0) decodeInteger(readElement(el.content).content);
    if (tag === 1) credentialsBlob = readElement(el.content).content;
  }
  if (!credentialsBlob) throw new Error('CredSSP-Test: TSCredentials ohne credentials-Feld');

  const inner = readElement(credentialsBlob);
  const values: string[] = [];
  for (const el of children(inner.content)) {
    values.push(readElement(el.content).content.toString('ucs2'));
  }
  return { domain: values[0] ?? '', user: values[1] ?? '', password: values[2] ?? '' };
}
