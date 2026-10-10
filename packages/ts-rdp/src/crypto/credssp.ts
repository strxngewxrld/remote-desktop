/**
 * CredSSP (MS-CSSP) - das Protokoll hinter "Authentifizierung auf Netzwerkebene"
 * (NLA). Laeuft innerhalb des bereits aufgebauten TLS-Kanals:
 *
 *   1. Client -> Server: TSRequest{negoTokens: NTLM NEGOTIATE}
 *   2. Server -> Client: TSRequest{negoTokens: NTLM CHALLENGE}
 *   3. Client -> Server: TSRequest{negoTokens: NTLM AUTHENTICATE, pubKeyAuth, clientNonce}
 *   4. Server -> Client: TSRequest{pubKeyAuth}  (Bindung an den TLS-Kanal pruefen)
 *   5. Client -> Server: TSRequest{authInfo: verschluesselte Zugangsdaten}
 *
 * Mit Kerberos ist es ein Schritt weniger: der erste TSRequest traegt den
 * AP-REQ (in SPNEGO), die Antwort das AP-REP, und danach geht es wie oben mit
 * pubKeyAuth weiter. Das Verfahren steckt hinter `CredSspKontext`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  children,
  decodeInteger,
  encodeContext,
  encodeInteger,
  encodeOctetString,
  encodeSequence,
  readElement,
} from '../asn1/der.js';
import { NtlmClient, NtlmOptions } from './ntlm.js';
import { RdpAuthError } from '../core/errors.js';
import type { CredSspKontext } from '../kerberos/kontext.js';

const CLIENT_TO_SERVER_MAGIC = 'CredSSP Client-To-Server Binding Hash';
const SERVER_TO_CLIENT_MAGIC = 'CredSSP Server-To-Client Binding Hash';

/** Ab dieser CredSSP-Version wird der Public Key ueber einen Nonce-Hash gebunden. */
const NONCE_HASH_MIN_VERSION = 5;
const CLIENT_VERSION = 6;

export interface TsRequest {
  version: number;
  negoTokens?: Buffer[];
  authInfo?: Buffer;
  pubKeyAuth?: Buffer;
  errorCode?: number;
  clientNonce?: Buffer;
}

export function encodeTsRequest(req: TsRequest): Buffer {
  const parts: Buffer[] = [encodeContext(0, encodeInteger(req.version))];
  if (req.negoTokens?.length) {
    const tokens = req.negoTokens.map((t) => encodeSequence(encodeContext(0, encodeOctetString(t))));
    parts.push(encodeContext(1, encodeSequence(...tokens)));
  }
  if (req.authInfo) parts.push(encodeContext(2, encodeOctetString(req.authInfo)));
  if (req.pubKeyAuth) parts.push(encodeContext(3, encodeOctetString(req.pubKeyAuth)));
  if (req.errorCode !== undefined) parts.push(encodeContext(4, encodeInteger(req.errorCode)));
  if (req.clientNonce) parts.push(encodeContext(5, encodeOctetString(req.clientNonce)));
  return encodeSequence(...parts);
}

export function decodeTsRequest(buf: Buffer): TsRequest {
  const root = readElement(buf);
  const out: TsRequest = { version: 0 };
  for (const el of children(root.content)) {
    const tagNumber = el.tag & 0x1f;
    switch (tagNumber) {
      case 0:
        out.version = decodeInteger(readElement(el.content).content);
        break;
      case 1: {
        const seq = readElement(el.content);
        out.negoTokens = [];
        for (const item of children(seq.content)) {
          const ctx = readElement(item.content);
          out.negoTokens.push(readElement(ctx.content).content);
        }
        break;
      }
      case 2:
        out.authInfo = readElement(el.content).content;
        break;
      case 3:
        out.pubKeyAuth = readElement(el.content).content;
        break;
      case 4:
        out.errorCode = decodeInteger(readElement(el.content).content);
        break;
      case 5:
        out.clientNonce = readElement(el.content).content;
        break;
    }
  }
  return out;
}

/** TSPasswordCreds in TSCredentials verpackt (credType 1 = Passwort). */
export function encodeTsCredentials(domain: string, user: string, password: string): Buffer {
  const creds = encodeSequence(
    encodeContext(0, encodeOctetString(Buffer.from(domain, 'ucs2'))),
    encodeContext(1, encodeOctetString(Buffer.from(user, 'ucs2'))),
    encodeContext(2, encodeOctetString(Buffer.from(password, 'ucs2'))),
  );
  return encodeSequence(encodeContext(0, encodeInteger(1)), encodeContext(1, encodeOctetString(creds)));
}

function bindingHash(magic: string, nonce: Buffer, publicKey: Buffer): Buffer {
  // Das abschliessende NUL gehoert zum Magic-String dazu.
  return createHash('sha256')
    .update(Buffer.from(magic + '\0', 'ascii'))
    .update(nonce)
    .update(publicKey)
    .digest();
}

export type CredSspResult = { send?: Buffer; done: boolean };

/** NTLM hinter der gemeinsamen Schnittstelle: drei Nachrichten, danach steht der Kontext. */
class NtlmKontext implements CredSspKontext {
  private readonly ntlm: NtlmClient;
  fertig = false;

  constructor(opts: NtlmOptions) {
    this.ntlm = new NtlmClient(opts);
  }

  start(): Buffer {
    return this.ntlm.negotiate();
  }

  schritt(challenge: Buffer): Buffer {
    this.ntlm.parseChallenge(challenge);
    this.fertig = true;
    return this.ntlm.authenticate();
  }

  seal(daten: Buffer): Buffer {
    return this.ntlm.seal(daten);
  }

  unseal(daten: Buffer): Buffer {
    return this.ntlm.unseal(daten);
  }
}

export class CredSspClient {
  private readonly kontext: CredSspKontext;
  private readonly nonce = randomBytes(32);
  private peerVersion = CLIENT_VERSION;
  private state: 'negotiate' | 'challenge' | 'pubkey' | 'done' = 'negotiate';

  constructor(
    private readonly opts: NtlmOptions,
    /** Oeffentlicher Schluessel des Serverzertifikats (DER), bindet CredSSP an den TLS-Kanal. */
    private readonly serverPublicKey: Buffer,
    /** Ein anderes Verfahren als NTLM, etwa Kerberos. Die Zugangsdaten in `opts` gehen trotzdem an den Server. */
    kontext?: CredSspKontext,
  ) {
    this.kontext = kontext ?? new NtlmKontext(opts);
  }

  /** Erste Nachricht an den Server. */
  start(): Buffer {
    const token = this.kontext.start();
    this.state = 'challenge';
    return encodeTsRequest({ version: CLIENT_VERSION, negoTokens: [token] });
  }

  /** Verarbeitet eine Serverantwort und liefert die naechste Nachricht. */
  step(incoming: Buffer): CredSspResult {
    const req = decodeTsRequest(incoming);
    if (req.version) this.peerVersion = Math.min(req.version, CLIENT_VERSION);
    if (req.errorCode) {
      throw new RdpAuthError(`CredSSP: Server meldet Fehler 0x${(req.errorCode >>> 0).toString(16)}`);
    }

    switch (this.state) {
      case 'challenge': {
        const challenge = req.negoTokens?.[0];
        if (!challenge) throw new RdpAuthError('CredSSP: CHALLENGE_MESSAGE fehlt in der Serverantwort');
        const naechstes = this.kontext.schritt(challenge);
        if (!this.kontext.fertig) {
          // Das Verfahren braucht noch eine Runde, bevor pubKeyAuth folgen darf.
          if (!naechstes) throw new RdpAuthError('CredSSP: die Anmeldung kommt nicht weiter');
          return { send: encodeTsRequest({ version: CLIENT_VERSION, negoTokens: [naechstes] }), done: false };
        }

        const useNonce = this.peerVersion >= NONCE_HASH_MIN_VERSION;
        const payload = useNonce
          ? bindingHash(CLIENT_TO_SERVER_MAGIC, this.nonce, this.serverPublicKey)
          : this.serverPublicKey;

        this.state = 'pubkey';
        return {
          send: encodeTsRequest({
            version: CLIENT_VERSION,
            negoTokens: naechstes ? [naechstes] : undefined,
            pubKeyAuth: this.kontext.seal(payload),
            clientNonce: useNonce ? this.nonce : undefined,
          }),
          done: false,
        };
      }

      case 'pubkey': {
        if (!req.pubKeyAuth) {
          throw new RdpAuthError(
            'CredSSP: Der Server hat die Kanalbindung nicht bestaetigt (pubKeyAuth fehlt). ' +
              'Meist bedeutet das falsche Zugangsdaten.',
          );
        }
        const received = this.kontext.unseal(req.pubKeyAuth);
        const expected =
          this.peerVersion >= NONCE_HASH_MIN_VERSION
            ? bindingHash(SERVER_TO_CLIENT_MAGIC, this.nonce, this.serverPublicKey)
            : incrementFirstByte(this.serverPublicKey);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
          throw new RdpAuthError(
            'CredSSP: Kanalbindung stimmt nicht - moeglicher Man-in-the-Middle zwischen Client und Server.',
          );
        }

        this.state = 'done';
        const creds = encodeTsCredentials(this.opts.domain, this.opts.user, this.opts.password);
        return {
          send: encodeTsRequest({ version: CLIENT_VERSION, authInfo: this.kontext.seal(creds) }),
          done: true,
        };
      }

      default:
        throw new RdpAuthError('CredSSP: unerwartete Nachricht nach Abschluss des Handshakes');
    }
  }
}

/** Legacy-Variante (CredSSP < 5): der Server liefert den Public Key mit +1 auf dem ersten Byte zurueck. */
function incrementFirstByte(key: Buffer): Buffer {
  const copy = Buffer.from(key);
  copy[0] = (copy[0] + 1) & 0xff;
  return copy;
}
