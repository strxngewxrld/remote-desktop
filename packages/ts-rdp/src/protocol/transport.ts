/**
 * Transportschicht: TCP, optionales TLS-Upgrade und TPKT-Framing.
 *
 * Der Verbindungsaufbau (X.224 -> TLS -> CredSSP -> MCS) ist ein streng
 * sequentieller Dialog. Deshalb bietet der Transport zwei Betriebsarten: ein
 * Pull-Modus mit `nextFrame()` fuer den Handshake und ein Push-Modus
 * (`startFlowing()`), der ab der aktiven Sitzung PDUs als Events liefert.
 */
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { elementLength } from '../asn1/der.js';
import { Logger, nullLogger } from '../core/log.js';
import { RdpError } from '../core/errors.js';
import { MODERN_TLS_PROFILE, TlsProfile } from './tlsProfiles.js';

export type FrameKind = 'tpkt' | 'der';

export interface RdpFrame {
  fastpath: boolean;
  /** Bei Fastpath: Header-Flags; bei Slowpath immer 0. */
  flags: number;
  /** Nutzdaten ohne TPKT-/Fastpath-Header. Beim Slowpath beginnt sie mit dem X.224-Header. */
  payload: Buffer;
}

export interface TransportOptions {
  host: string;
  port: number;
  logger?: Logger;
  /** Timeout fuer den TCP-Connect in Millisekunden. */
  connectTimeout?: number;
  /** Zertifikatspruefung. Selbstsignierte Zertifikate sind bei RDP die Regel. */
  rejectUnauthorized?: boolean;
  /** Wird nach dem TLS-Handshake aufgerufen; ein geworfener Fehler bricht die Verbindung ab. */
  verifyCertificate?: (cert: tls.PeerCertificate, socket: tls.TLSSocket) => void;
  /** Suiten und Protokollversionen fuer den TLS-Handshake. */
  tlsProfile?: TlsProfile;
}

interface PendingRead {
  kind: FrameKind;
  resolve: (value: Buffer) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class RdpTransport extends EventEmitter {
  private socket?: net.Socket | tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending?: PendingRead;
  private flowing = false;
  private closed = false;
  /** Fehler, der eintraf, waehrend kein nextFrame() wartete. */
  private pendingError?: Error;
  private readonly log: Logger;

  constructor(private readonly opts: TransportOptions) {
    super();
    this.log = opts.logger ?? nullLogger;
  }

  get tlsSocket(): tls.TLSSocket | undefined {
    return this.socket && 'getPeerCertificate' in this.socket ? (this.socket as tls.TLSSocket) : undefined;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
      socket.setNoDelay(true);
      const timeout = this.opts.connectTimeout ?? 15000;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RdpError(`Zeitueberschreitung beim Verbinden mit ${this.opts.host}:${this.opts.port}`, 'RDP_TIMEOUT'));
      }, timeout);

      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        this.attach(socket);
        this.log.debug(`TCP verbunden mit ${this.opts.host}:${this.opts.port}`);
        resolve();
      });
    });
  }

  /** Hebt die bestehende TCP-Verbindung auf TLS an (STARTTLS-Muster von RDP). */
  upgradeTls(): Promise<tls.TLSSocket> {
    const plain = this.socket;
    if (!plain) throw new RdpError('TLS-Upgrade ohne bestehende Verbindung');
    if (this.buffer.length > 0) {
      throw new RdpError('TLS-Upgrade mit ungelesenen Daten im Puffer - Protokollfehler');
    }
    this.detach(plain);

    return new Promise((resolve, reject) => {
      const profile = this.opts.tlsProfile ?? MODERN_TLS_PROFILE;
      const secure = tls.connect({
        socket: plain,
        servername: net.isIP(this.opts.host) ? undefined : this.opts.host,
        rejectUnauthorized: this.opts.rejectUnauthorized ?? false,
        // Windows-Server verhandeln je nach Patchstand nur aeltere Suites.
        ...profile,
      });
      const onError = (err: Error) => reject(err);
      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.removeListener('error', onError);
        try {
          this.opts.verifyCertificate?.(secure.getPeerCertificate(), secure);
        } catch (err) {
          secure.destroy();
          reject(err as Error);
          return;
        }
        this.attach(secure);
        this.log.debug(`TLS aufgebaut (${secure.getProtocol()}, ${secure.getCipher().name})`);
        resolve(secure);
      });
    });
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private detach(socket: net.Socket | tls.TLSSocket): void {
    socket.removeListener('data', this.onData);
    socket.removeListener('error', this.onError);
    socket.removeListener('close', this.onClose);
  }

  private onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  };

  private onError = (err: Error): void => {
    if (this.pending) {
      this.pending.reject(err);
      this.pending = undefined;
    } else {
      // Damit der naechste Lesevorgang nicht bis zum Zeitlimit blockiert.
      this.pendingError ??= err;
    }
    this.emit('error', err);
  };

  private onClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.pending?.reject(new RdpError('Verbindung vom Server geschlossen', 'RDP_CLOSED'));
    this.pending = undefined;
    this.emit('close');
  };

  /**
   * Ermittelt die Gesamtlaenge des naechsten Frames oder -1, wenn noch Daten
   * fehlen. TPKT (Version 3) und Fastpath teilen sich denselben Stream und
   * werden am ersten Byte unterschieden.
   */
  private frameLength(kind: FrameKind): number {
    const buf = this.buffer;
    if (kind === 'der') return elementLength(buf, 0);
    if (buf.length < 2) return -1;
    if (buf[0] === 3) {
      if (buf.length < 4) return -1;
      return buf.readUInt16BE(2);
    }
    // Fastpath: Laenge ist 1 oder 2 Byte, je nach oberstem Bit.
    if (buf[1] & 0x80) {
      if (buf.length < 3) return -1;
      return ((buf[1] & 0x7f) << 8) | buf[2];
    }
    return buf[1];
  }

  private takeFrame(kind: FrameKind): Buffer | undefined {
    const len = this.frameLength(kind);
    if (len < 0 || this.buffer.length < len) return undefined;
    if (len === 0) throw new RdpError('Frame mit Laenge 0 empfangen', 'RDP_PROTOCOL');
    const frame = this.buffer.subarray(0, len);
    this.buffer = this.buffer.subarray(len);
    return frame;
  }

  private drain(): void {
    // Zuerst einen wartenden Pull bedienen, danach ggf. in den Push-Modus.
    while (true) {
      if (this.pending) {
        const frame = this.takeFrame(this.pending.kind);
        if (!frame) return;
        const { resolve, timer } = this.pending;
        if (timer) clearTimeout(timer);
        this.pending = undefined;
        resolve(frame);
        continue;
      }
      if (!this.flowing) return;
      const frame = this.takeFrame('tpkt');
      if (!frame) return;
      try {
        this.emit('frame', parseFrame(frame));
      } catch (err) {
        this.emit('error', err);
        return;
      }
    }
  }

  /** Wartet auf genau einen Frame (Handshake-Phase). */
  nextFrame(kind: FrameKind, timeoutMs = 30000): Promise<Buffer> {
    if (this.pending) throw new RdpError('nextFrame() ist bereits aktiv');
    if (this.flowing) {
      // Sonst wuerde dieser Aufruf Frames aus dem Ereignisstrom abfangen.
      throw new RdpError('nextFrame() ist nach startFlowing() nicht mehr zulaessig');
    }
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = undefined;
      return Promise.reject(err);
    }
    if (this.closed) {
      return Promise.reject(new RdpError('Verbindung vom Server geschlossen', 'RDP_CLOSED'));
    }
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new RdpError('Zeitueberschreitung beim Warten auf die Serverantwort', 'RDP_TIMEOUT'));
      }, timeoutMs);
      this.pending = { kind, resolve, reject, timer };
      this.drain();
    });
  }

  /** Schaltet auf ereignisgesteuerte Zustellung um ('frame'-Events). */
  startFlowing(): void {
    this.flowing = true;
    this.drain();
  }

  write(data: Buffer): void {
    if (!this.socket || this.closed) throw new RdpError('Schreiben auf geschlossener Verbindung', 'RDP_CLOSED');
    this.socket.write(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.emit('close');
  }
}

/** Zerlegt einen vollstaendigen Frame in Header und Nutzdaten. */
export function parseFrame(frame: Buffer): RdpFrame {
  if (frame[0] === 3) {
    return { fastpath: false, flags: 0, payload: frame.subarray(4) };
  }
  const flags = (frame[0] >> 6) & 0x03;
  const headerLength = frame[1] & 0x80 ? 3 : 2;
  return { fastpath: true, flags, payload: frame.subarray(headerLength) };
}

/** Umhuellt Nutzdaten mit TPKT-Header und X.224-Data-Header. */
export function tpkt(payload: Buffer): Buffer {
  const total = payload.length + 7;
  const header = Buffer.from([0x03, 0x00, (total >> 8) & 0xff, total & 0xff, 0x02, 0xf0, 0x80]);
  return Buffer.concat([header, payload]);
}

/** TPKT-Header ohne X.224-Data-Header (nur fuer die Verbindungs-PDUs). */
export function tpktRaw(payload: Buffer): Buffer {
  const total = payload.length + 4;
  const header = Buffer.from([0x03, 0x00, (total >> 8) & 0xff, total & 0xff]);
  return Buffer.concat([header, payload]);
}
