/**
 * Minimaler RDP-Server fuer die Integrationstests.
 *
 * Er spricht die Servergegenseite der Verbindungssequenz aus MS-RDPBCGR 1.3.1.1
 * weit genug, um einen echten Client bis zur aktiven Sitzung zu bringen:
 * X.224-Aushandlung, TLS, MCS, Lizenzmeldung, Capability Exchange. Danach
 * koennen Tests gezielt Updates einspeisen und die Eingaben des Clients pruefen.
 */
import { EventEmitter } from 'node:events';
import { createPublicKey } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { elementLength } from '../src/asn1/der.js';
import { MockCredSspServer } from './mockCredssp.js';
import { BinaryReader, BinaryWriter } from '../src/core/binary.js';
import * as ber from '../src/protocol/ber.js';
import * as per from '../src/protocol/per.js';
import * as mcs from '../src/protocol/mcs.js';
import * as pdu from '../src/protocol/pdu.js';
import { buildClientCapabilities, serializeCapabilities } from '../src/protocol/caps.js';
import { parseFrame, tpkt, tpktRaw } from '../src/protocol/transport.js';
import * as dvc from '../src/protocol/dvc.js';
import { CS_NET } from '../src/protocol/gcc.js';
import { zgfxWrapUncompressed } from '../src/codec/zgfx.js';
import { buildChannelChunks, ChannelReassembler, parseChannelChunk } from '../src/protocol/virtualChannel.js';
import {
  buildSaveSessionInfoWithCookie,
  ServerAutoReconnectPacket,
} from '../src/protocol/autoReconnect.js';
import {
  FASTPATH_UPDATETYPE_BITMAP,
  MCS_GLOBAL_CHANNEL,
  PDUTYPE_DATAPDU,
  PDUTYPE_DEACTIVATEALLPDU,
  PDUTYPE_DEMANDACTIVEPDU,
  PDUTYPE2_FONTMAP,
  PDUTYPE2_SAVE_SESSION_INFO,
  SEC_LICENSE_PKT,
  TYPE_RDP_NEG_RSP,
} from '../src/protocol/constants.js';

const T124_OID = [0, 0, 20, 124, 0, 1];
const USER_ID = 1007;
/** Name des statischen Kanals, ueber den alle dynamischen Kanaele laufen. */
const DYNVC_NAME = 'drdynvc';
/** Erste DVC-Kanal-ID, die der Server vergibt - Windows faengt ebenfalls klein an. */
const ERSTE_DVC_ID = 7;

export interface MockServerOptions {
  cert: string;
  key: string;
  width: number;
  height: number;
  /** Vom Server gewaehltes Protokoll im Negotiation Response. */
  selectedProtocol?: number;
  /** Wenn gesetzt, verlangt der Server NLA und prueft diese Zugangsdaten. */
  credentials?: { domain: string; user: string; password: string };
  /** Ob der Server das Refresh Rect PDU anbietet (echte Windows-Server tun das). */
  refreshRectSupport?: boolean;
  /** I/O-Kanal, den der Server im Server Network Data nennt (Standard 1003). */
  ioChannelId?: number;
  /** Farbtiefe, die der Server im Demand Active vorgibt (Standard 32). */
  colorDepth?: number;
  /** Nur diese Suiten anbieten - zum Nachstellen aelterer Serverkonfigurationen. */
  ciphers?: string;
  maxTlsVersion?: 'TLSv1.2' | 'TLSv1.3';
  /**
   * Laesst den ersten TLS-Handshake scheitern (keine gemeinsame Suite), damit
   * der Wiederholversuch des Clients geprueft werden kann.
   */
  failFirstTlsHandshake?: boolean;
  /**
   * Fastpath-Bilddaten, die noch vor dem Demand Active PDU gesendet werden.
   * Sie landen dadurch zwingend im Zwischenspeicher des Clients - so laesst
   * sich pruefen, dass sie erst nach dem 'connect'-Ereignis ausgeliefert werden.
   */
  bitmapBeforeActivation?: Buffer;
  /**
   * Dynamische virtuelle Kanaele, die der Server nach der Aktivierung
   * eroeffnet - in dieser Reihenfolge und ab ID 7 durchnummeriert. Ist die
   * Liste gesetzt, faehrt der Server auf `drdynvc` die DVC-Aushandlung.
   */
  dynamicChannels?: string[];
  /**
   * Version, die der Server in der DVC-Capability-Anfrage anbietet
   * (Standard 3, wie aktuelle Windows-Server).
   */
  dvcVersion?: number;
  /**
   * VCChunkSize im Virtual Channel Capability Set des Demand Active PDU.
   * Ohne Angabe gilt CHANNEL_CHUNK_LENGTH (1600).
   */
  vcChunkSize?: number;
}

export interface ReceivedInput {
  pduType2: number;
  events: Array<{ messageType: number; flags: number; param1: number; param2: number }>;
}

/** Antwort des Clients auf eine DVC-Capability-Anfrage. */
export interface DvcCapsResponse {
  version: number;
}

/** Antwort des Clients auf eine DVC-CREATE-Anfrage. */
export interface DvcCreateResponse {
  channelId: number;
  /** 0 = angenommen, sonst ein NTSTATUS wie STATUS_NOT_SUPPORTED. */
  status: number;
  /** Name, unter dem der Server den Kanal eroeffnet hat. */
  name: string;
}

/** Zusammengesetzte Nachricht, die der Client auf einem statischen Kanal geschickt hat. */
export interface StaticChannelData {
  channelId: number;
  name: string;
  data: Buffer;
}

/** Nutzdaten, die der Client auf einem dynamischen Kanal geschickt hat. */
export interface DvcData {
  channelId: number;
  name: string;
  /** Noch in der ZGFX-Huelle - die Auswertung gehoert in den Test. */
  data: Buffer;
}

export class MockRdpServer extends EventEmitter {
  private server: net.Server;
  private socket?: tls.TLSSocket;
  /** Alle je angenommenen Sockets - sonst haelt ein Rest den Testprozess offen. */
  private readonly openSockets = new Set<net.Socket | tls.TLSSocket>();
  private buffer = Buffer.alloc(0);
  private tlsActive = false;
  private credssp?: MockCredSspServer;
  /** Zaehlt die TLS-Aufbauversuche - fuer den Test des Wiederholversuchs. */
  tlsAttempts = 0;
  /** Kanaele, auf denen der Client tatsaechlich gesendet hat. */
  readonly clientChannels = new Set<number>();

  /** Statische virtuelle Kanaele aus dem Client Network Data: Name -> MCS-Kanal-ID. */
  readonly virtualChannelIds = new Map<string, number>();
  /** Vom Server eroeffnete dynamische Kanaele: Name -> DVC-Kanal-ID. */
  readonly dynamicChannelIds = new Map<string, number>();
  /**
   * Reihenfolge, in der die Antworten des Clients eingetroffen sind, z.B.
   * ['capsResponse', 'createResponse:7', 'data:7'].
   *
   * Ein echter Server verwirft Nutzdaten auf einem Kanal, dessen Annahme er
   * noch nicht gesehen hat. Dieses Protokoll macht genau diese Reihenfolge
   * pruefbar, statt sie dem Zufall zu ueberlassen.
   */
  readonly empfangeneReihenfolge: string[] = [];

  /** MCS-Kanal-ID von drdynvc, sofern der Client den Kanal angemeldet hat. */
  private dynvcChannelId?: number;
  private dynvcReassembler = new ChannelReassembler();
  /** Zusammensetzer je statischem Kanal ausser drdynvc. */
  private readonly statischeZusammensetzer = new Map<number, ChannelReassembler>();
  /** Jeder empfangene Block eines statischen Kanals, ungefiltert. */
  readonly statischeBloecke: Array<{ channelId: number; length: number }> = [];
  /** Offene DATA_FIRST-Folgen je DVC-Kanal. */
  private readonly dvcFragmente = new Map<number, { erwartet: number; teile: Buffer[] }>();

  private get ioChannel(): number {
    return this.opts.ioChannelId ?? MCS_GLOBAL_CHANNEL;
  }

  private get dvcVersion(): number {
    return this.opts.dvcVersion ?? 3;
  }

  constructor(private readonly opts: MockServerOptions) {
    super();
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        resolve((this.server.address() as net.AddressInfo).port);
      });
    });
  }

  close(): void {
    for (const socket of this.openSockets) socket.destroy();
    this.openSockets.clear();
    this.socket?.destroy();
    this.server.close();
  }

  /** Schickt ein Fastpath-Update an den verbundenen Client. */
  sendFastpathUpdate(updateCode: number, data: Buffer): void {
    const body = new BinaryWriter().uint8(updateCode).uint16le(data.length).bytes(data).toBuffer();
    const total = body.length + 2;
    if (total > 0x7f) {
      this.write(Buffer.concat([Buffer.from([0x00, 0x80 | ((total + 1) >> 8), (total + 1) & 0xff]), body]));
    } else {
      this.write(Buffer.concat([Buffer.from([0x00, total]), body]));
    }
  }

  /**
   * Schickt ein Save Session Info PDU mit Auto-Reconnect-Cookie
   * (MS-RDPBCGR 2.2.10.1) - genau das, was Windows tut, sobald der Benutzer
   * angemeldet ist.
   */
  sendSaveSessionInfo(cookie: ServerAutoReconnectPacket): void {
    this.sendSlowpath(
      pdu.writeShareControlHeader(
        PDUTYPE_DATAPDU,
        0x03ea,
        pdu.writeShareDataHeader(
          0x000103ea,
          PDUTYPE2_SAVE_SESSION_INFO,
          buildSaveSessionInfoWithCookie(cookie),
        ),
      ),
    );
  }

  /**
   * Reisst die laufende Verbindung ab, bleibt aber auf dem Port erreichbar -
   * so wie eine Netzstoerung, nach der der Server noch da ist.
   */
  trenneVerbindung(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  /** Nimmt keine weiteren Verbindungen mehr an, ohne den Port freizugeben. */
  verweigereVerbindungen(): void {
    this.server.close();
    this.trenneVerbindung();
  }

  sendSlowpath(payload: Buffer): void {
    this.write(tpkt(mcs.buildSendDataIndication(USER_ID, this.ioChannel, payload)));
  }

  /**
   * Schickt Nutzdaten auf einem dynamischen Kanal, ZGFX-verpackt.
   *
   * Die Graphics Pipeline erwartet jede Nachricht in dieser Huelle, deshalb
   * steckt sie hier drin und nicht im Test: sonst muesste jeder Aufrufer
   * daran denken.
   */
  sendDynamicChannelData(name: string, payload: Buffer): void {
    const id = this.dynamicChannelIds.get(name);
    if (id === undefined) throw new Error(`Dynamischer Kanal "${name}" ist nicht offen`);
    this.sendDynvc(dvc.buildData(id, zgfxWrapUncompressed(payload)));
  }

  /**
   * Schickt Nutzdaten auf einem statischen virtuellen Kanal - in Bloecken der
   * Groesse, die der Server selbst im Capability Set genannt hat.
   */
  sendStaticChannelData(name: string, payload: Buffer): void {
    const id = this.virtualChannelIds.get(name);
    if (id === undefined) throw new Error(`Statischer Kanal "${name}" ist nicht angemeldet`);
    for (const chunk of buildChannelChunks(payload, this.opts.vcChunkSize ?? 1600)) {
      this.write(tpkt(mcs.buildSendDataIndication(USER_ID, id, chunk)));
    }
  }

  /** Name eines statischen Kanals, sonst die ID als Zeichenkette. */
  private statischerName(channelId: number): string {
    for (const [name, id] of this.virtualChannelIds) if (id === channelId) return name;
    return String(channelId);
  }

  /** Bloecke eines statischen Kanals zu ganzen Nachrichten zusammensetzen. */
  private handleStatischenKanal(channelId: number, payload: Buffer): void {
    // Jeden einzelnen Block mitschreiben: nur so laesst sich pruefen, dass der
    // Client die ausgehandelte Chunkgrenze einhaelt.
    this.statischeBloecke.push({ channelId, length: payload.length });
    let zusammensetzer = this.statischeZusammensetzer.get(channelId);
    if (!zusammensetzer) {
      zusammensetzer = new ChannelReassembler();
      this.statischeZusammensetzer.set(channelId, zusammensetzer);
    }
    const vollstaendig = zusammensetzer.push(parseChannelChunk(payload));
    if (!vollstaendig) return;
    const name = this.statischerName(channelId);
    this.empfangeneReihenfolge.push(`static:${name}`);
    this.emit('staticChannelData', { channelId, name, data: vollstaendig } as StaticChannelData);
  }

  /** Schickt eine fertige DVC-Nachricht als Bloecke des statischen Kanals. */
  private sendDynvc(message: Buffer): void {
    if (this.dynvcChannelId === undefined) return;
    for (const chunk of buildChannelChunks(message)) {
      this.write(tpkt(mcs.buildSendDataIndication(USER_ID, this.dynvcChannelId, chunk)));
    }
  }

  private write(data: Buffer): void {
    this.socket?.write(data);
  }

  private handleConnection(socket: net.Socket): void {
    this.openSockets.add(socket);
    socket.on('close', () => this.openSockets.delete(socket));
    // Jede Verbindung beginnt wieder unverschluesselt bei der X.224-Aushandlung.
    this.buffer = Buffer.alloc(0);
    this.tlsActive = false;
    this.credssp = undefined;
    this.socket = undefined;
    // Auch die Kanalzuordnung gilt nur fuer die jeweilige Verbindung.
    this.virtualChannelIds.clear();
    this.dynamicChannelIds.clear();
    this.dynvcChannelId = undefined;
    this.dynvcReassembler = new ChannelReassembler();
    this.statischeZusammensetzer.clear();
    this.statischeBloecke.length = 0;
    this.dvcFragmente.clear();
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain(socket);
    });
    socket.on('error', () => {});
  }

  private drain(socket: net.Socket | tls.TLSSocket): void {
    for (;;) {
      if (this.credssp) {
        const length = elementLength(this.buffer, 0);
        if (length < 0) return;
        const message = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        try {
          const result = this.credssp.step(message);
          if (result.send) this.write(result.send);
          if (result.outcome) {
            this.credssp = undefined;
            this.emit('credssp', result.outcome);
          }
        } catch (err) {
          if (this.listenerCount('error') > 0) this.emit('error', err);
          this.socket?.destroy();
          socket.destroy();
          return;
        }
        continue;
      }
      if (this.buffer.length < 4) return;
      if (this.buffer[0] !== 3) return; // nur TPKT wird erwartet
      const length = this.buffer.readUInt16BE(2);
      if (this.buffer.length < length) return;
      const frame = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      try {
        this.handleFrame(frame, socket);
      } catch (err) {
        // Windows trennt bei fehlgeschlagener Anmeldung ebenfalls einfach die Verbindung.
        if (this.listenerCount('error') > 0) this.emit('error', err);
        this.socket?.destroy();
        socket.destroy();
        return;
      }
    }
  }

  private handleFrame(frame: Buffer, socket: net.Socket | tls.TLSSocket): void {
    const payload = parseFrame(frame).payload;

    if (!this.tlsActive) {
      // Erster Frame: X.224 Connection Request -> Confirm, danach TLS.
      const selected = this.opts.selectedProtocol ?? (this.opts.credentials ? 3 : 1);
      const confirm = new BinaryWriter()
        .uint8(0x0e)
        .uint8(0xd0)
        .uint16be(0)
        .uint16be(0x1234)
        .uint8(0)
        .uint8(TYPE_RDP_NEG_RSP)
        .uint8(0)
        .uint16le(8)
        .uint32le(selected)
        .toBuffer();
      socket.write(tpktRaw(confirm));
      this.upgradeToTls(socket as net.Socket);
      return;
    }

    // Ab hier: X.224-Datenkopf (3 Byte) abschneiden, Rest ist MCS.
    const mcsData = payload.subarray(3);
    const opcode = mcsData[0] >> 2;

    if (mcsData[0] === 0x7f) {
      this.handleConnectInitial(mcsData);
      return;
    }

    switch (opcode) {
      case 1: // ErectDomainRequest
        return;
      case 10: // AttachUserRequest
        this.write(tpkt(Buffer.from([(11 << 2) | 2, 0x00, ...toBe16(USER_ID - 1001)])));
        return;
      case 14: {
        // ChannelJoinRequest
        const r = new BinaryReader(mcsData);
        r.uint8();
        const initiator = per.readInteger16(r, 1001);
        const channelId = per.readInteger16(r);
        this.write(
          tpkt(
            Buffer.concat([
              Buffer.from([(15 << 2) | 2, 0x00]),
              Buffer.from(toBe16(initiator - 1001)),
              Buffer.from(toBe16(channelId)),
              Buffer.from(toBe16(channelId)),
            ]),
          ),
        );
        return;
      }
      case 25: {
        // SendDataRequest: Nutzlast auswerten
        const request = mcs.parseSendDataRequest(mcsData);
        if (request) {
          this.clientChannels.add(request.channelId);
          if (request.channelId === this.dynvcChannelId) this.handleDynvcFromClient(request.payload);
          else if (request.channelId !== this.ioChannel) {
            this.handleStatischenKanal(request.channelId, request.payload);
          } else this.handleClientPdu(request.payload);
        }
        return;
      }
      default:
        return;
    }
  }

  private upgradeToTls(socket: net.Socket): void {
    socket.removeAllListeners('data');
    this.tlsAttempts++;
    // Beim ersten Versuch nur eine ECDSA-Suite anbieten: zusammen mit dem
    // RSA-Zertifikat gibt es keine gemeinsame Suite, der Handshake scheitert.
    const sabotage = this.opts.failFirstTlsHandshake && this.tlsAttempts === 1;
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      cert: this.opts.cert,
      key: this.opts.key,
      ...(sabotage
        ? { ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384', maxVersion: 'TLSv1.2' as const, minVersion: 'TLSv1.2' as const }
        : {}),
      ...(this.opts.ciphers ? { ciphers: this.opts.ciphers } : {}),
      ...(this.opts.maxTlsVersion ? { maxVersion: this.opts.maxTlsVersion, minVersion: 'TLSv1' as const } : {}),
    });
    this.socket = secure;
    this.openSockets.add(secure);
    secure.on('close', () => this.openSockets.delete(secure));
    this.tlsActive = true;
    secure.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain(secure);
    });
    secure.on('error', () => {});
    secure.on('secure', () => this.emit('tls'));
    if (this.opts.credentials) {
      this.credssp = new MockCredSspServer({
        ...this.opts.credentials,
        publicKey: createPublicKey(this.opts.cert).export({ type: 'pkcs1', format: 'der' }),
      });
    }
  }

  private handleConnectInitial(data: Buffer): void {
    // Jeder angemeldete statische Kanal bekommt eine ID direkt hinter dem
    // I/O-Kanal. Der Client ordnet Namen und IDs allein ueber die Reihenfolge
    // zu, also muss die Reihenfolge des Client Network Data erhalten bleiben.
    this.virtualChannelIds.clear();
    this.dynvcChannelId = undefined;
    const namen = clientChannelNames(data);
    namen.forEach((name, index) => {
      const id = this.ioChannel + 1 + index;
      this.virtualChannelIds.set(name, id);
      if (name === DYNVC_NAME) this.dynvcChannelId = id;
    });

    const netzwerk = new BinaryWriter().uint16le(this.ioChannel).uint16le(namen.length);
    for (const name of namen) netzwerk.uint16le(this.virtualChannelIds.get(name)!);
    // channelIdArray ist auf 4 Byte auszurichten (MS-RDPBCGR 2.2.1.4.4).
    if (namen.length % 2 === 1) netzwerk.uint16le(0);

    // Antwort: MCS Connect Response mit GCC Conference Create Response.
    const serverData = Buffer.concat([
      blockOf(0x0c01, new BinaryWriter().uint32le(0x00080004).uint32le(1).uint32le(0).toBuffer()),
      blockOf(0x0c02, new BinaryWriter().uint32le(0).uint32le(0).toBuffer()),
      blockOf(0x0c03, netzwerk.toBuffer()),
    ]);

    const gccResponse = Buffer.concat([
      per.writeChoice(0),
      per.writeObjectIdentifier(T124_OID),
      per.writeLength(serverData.length + 14),
      per.writeChoice(0),
      per.writeInteger16(0x79f3, 1001),
      per.writeInteger(1),
      per.writeEnumerates(0),
      per.writeNumberOfSet(1),
      per.writeChoice(0xc0),
      per.writeOctetStream('McDn', 4),
      per.writeLength(serverData.length),
      serverData,
    ]);

    const response = ber.wrapApplication(
      102,
      ber.writeEnumerated(0),
      ber.writeInteger(0),
      ber.writeSequence(
        ber.writeInteger(22),
        ber.writeInteger(3),
        ber.writeInteger(0),
        ber.writeInteger(1),
        ber.writeInteger(0),
        ber.writeInteger(1),
        ber.writeInteger(0xffff),
        ber.writeInteger(2),
      ),
      ber.writeOctetString(gccResponse),
    );
    this.write(tpkt(response));
  }

  private handleClientPdu(payload: Buffer): void {
    // Client Info PDU: erkennbar am Security Header mit SEC_INFO_PKT.
    if (payload.length >= 4 && (payload.readUInt16LE(0) & 0x0040) !== 0 && !pdu.looksLikeShareControl(payload)) {
      this.emit('clientInfo', payload.subarray(4));
      this.sendLicenseOk();
      if (this.opts.bitmapBeforeActivation) {
        this.sendFastpathUpdate(FASTPATH_UPDATETYPE_BITMAP, this.opts.bitmapBeforeActivation);
      }
      this.sendDemandActive();
      return;
    }

    if (!pdu.looksLikeShareControl(payload)) return;
    const r = new BinaryReader(payload);
    const header = pdu.readShareControlHeader(r);

    if (header.pduType === 3) {
      this.emit('confirmActive', payload);
      return;
    }
    if (header.pduType !== PDUTYPE_DATAPDU) return;

    const data = pdu.readShareDataHeader(r);
    if (data.pduType2 === 0x27) {
      // Font List -> Font Map, damit die Aktivierung abgeschlossen ist.
      this.sendFontMap();
      this.emit('activated');
      this.starteDvc();
      return;
    }
    if (data.pduType2 === 0x1c) {
      const count = r.uint16le();
      r.uint16le();
      const events = [];
      for (let i = 0; i < count; i++) {
        r.uint32le();
        events.push({
          messageType: r.uint16le(),
          flags: r.uint16le(),
          param1: r.uint16le(),
          param2: r.uint16le(),
        });
      }
      this.emit('input', { pduType2: data.pduType2, events } as ReceivedInput);
    }
  }

  // ------------------------------------------------- Dynamische Kanaele (DVC)

  /**
   * Beginnt die DVC-Aushandlung. Zuerst nur die Capability-Anfrage: ein echter
   * Server eroeffnet erst Kanaele, wenn der Client eine Version bestaetigt hat
   * (MS-RDPEDYC 3.2.5.1). Die CREATE-Anfragen folgen deshalb in
   * `eroeffneDynamischeKanaele`.
   */
  private starteDvc(): void {
    if (!this.opts.dynamicChannels || this.dynvcChannelId === undefined) return;
    this.sendDynvc(buildDvcCapabilitiesRequest(this.dvcVersion));
  }

  private eroeffneDynamischeKanaele(): void {
    const namen = this.opts.dynamicChannels ?? [];
    namen.forEach((name, index) => {
      const id = ERSTE_DVC_ID + index;
      this.dynamicChannelIds.set(name, id);
      this.sendDynvc(buildDvcCreateRequest(id, name));
    });
  }

  /** Name eines vom Server eroeffneten Kanals - fuer Meldungen und Ereignisse. */
  private dvcName(channelId: number): string {
    for (const [name, id] of this.dynamicChannelIds) if (id === channelId) return name;
    return String(channelId);
  }

  /** Bloecke des statischen Kanals zu DVC-Nachrichten zusammensetzen. */
  private handleDynvcFromClient(payload: Buffer): void {
    const vollstaendig = this.dynvcReassembler.push(parseChannelChunk(payload));
    if (!vollstaendig) return;

    // Die CREATE-Antwort des Clients traegt statt des Namens einen 4-Byte-
    // Status. `parseDvcPdu` liest hier den Namen der *Anfrage* - deshalb wird
    // dieser eine Fall von Hand zerlegt.
    const cmd = (vollstaendig[0] >> 4) & 0x0f;
    if (cmd === dvc.DVC_CMD_CREATE) {
      const r = new BinaryReader(vollstaendig);
      const cbId = r.uint8() & 0x03;
      const channelId = cbId === 0 ? r.uint8() : cbId === 1 ? r.uint16le() : r.uint32le();
      const status = r.remaining >= 4 ? r.uint32le() : 0;
      this.empfangeneReihenfolge.push(`createResponse:${channelId}`);
      this.emit('dvcCreateResponse', { channelId, status, name: this.dvcName(channelId) } as DvcCreateResponse);
      return;
    }

    const nachricht = dvc.parseDvcPdu(vollstaendig);
    switch (nachricht.cmd) {
      case dvc.DVC_CMD_CAPABILITY:
        this.empfangeneReihenfolge.push('capsResponse');
        this.emit('dvcCapsResponse', { version: nachricht.version ?? 0 } as DvcCapsResponse);
        this.eroeffneDynamischeKanaele();
        return;

      case dvc.DVC_CMD_DATA_FIRST:
        this.dvcFragmente.set(nachricht.channelId!, {
          erwartet: nachricht.totalLength ?? 0,
          teile: [nachricht.data ?? Buffer.alloc(0)],
        });
        this.pruefeDvcFragment(nachricht.channelId!);
        return;

      case dvc.DVC_CMD_DATA: {
        const offen = this.dvcFragmente.get(nachricht.channelId!);
        if (offen) {
          offen.teile.push(nachricht.data ?? Buffer.alloc(0));
          this.pruefeDvcFragment(nachricht.channelId!);
        } else {
          this.meldeDvcData(nachricht.channelId!, nachricht.data ?? Buffer.alloc(0));
        }
        return;
      }

      case dvc.DVC_CMD_CLOSE:
        this.empfangeneReihenfolge.push(`close:${nachricht.channelId}`);
        this.emit('dvcClose', { channelId: nachricht.channelId! });
        return;

      default:
        return;
    }
  }

  private pruefeDvcFragment(channelId: number): void {
    const offen = this.dvcFragmente.get(channelId);
    if (!offen) return;
    const laenge = offen.teile.reduce((summe, teil) => summe + teil.length, 0);
    if (laenge < offen.erwartet) return;
    this.dvcFragmente.delete(channelId);
    this.meldeDvcData(channelId, Buffer.concat(offen.teile));
  }

  private meldeDvcData(channelId: number, data: Buffer): void {
    this.empfangeneReihenfolge.push(`data:${channelId}`);
    this.emit('dvcData', { channelId, name: this.dvcName(channelId), data } as DvcData);
  }

  private sendLicenseOk(): void {
    const body = new BinaryWriter()
      .uint16le(SEC_LICENSE_PKT)
      .uint16le(0)
      .uint8(0xff) // ERROR_ALERT
      .uint8(0x03)
      .uint16le(16)
      .uint32le(0x00000007) // STATUS_VALID_CLIENT
      .uint32le(0x00000002)
      .uint16le(0x0004)
      .uint16le(0)
      .toBuffer();
    this.sendSlowpath(body);
  }

  private sendDemandActive(): void {
    const caps = serializeCapabilities(
      buildClientCapabilities(
        {
          width: this.opts.width,
          height: this.opts.height,
          colorDepth: this.opts.colorDepth ?? 32,
          keyboardLayout: 0x409,
        },
        this.opts.vcChunkSize ? { virtualChannelChunkSize: this.opts.vcChunkSize } : {},
      ),
    );
    // Das General Capability Set steht an erster Stelle; refreshRectSupport
    // liegt 20 Byte hinter dem 4 Byte langen Kopf.
    caps[24] = this.opts.refreshRectSupport === false ? 0 : 1;
    const source = Buffer.from('RDP\0', 'ascii');
    const body = new BinaryWriter()
      .uint32le(0x000103ea)
      .uint16le(source.length)
      .uint16le(caps.length + 4)
      .bytes(source)
      .uint16le(17)
      .uint16le(0)
      .bytes(caps)
      .uint32le(0)
      .toBuffer();
    this.sendSlowpath(pdu.writeShareControlHeader(PDUTYPE_DEMANDACTIVEPDU, 0x03ea, body));
  }

  /**
   * Spielt nach, was Windows beim Wechsel vom Anmeldebildschirm auf den
   * Benutzerdesktop tut: Sitzung deaktivieren und sofort neu aktivieren.
   */
  reactivate(): void {
    const source = Buffer.from('RDP\0', 'ascii');
    const body = new BinaryWriter()
      .uint32le(0x000103ea)
      .uint16le(source.length)
      .bytes(source)
      .toBuffer();
    this.sendSlowpath(pdu.writeShareControlHeader(PDUTYPE_DEACTIVATEALLPDU, 0x03ea, body));
    this.sendDemandActive();
  }

  private sendFontMap(): void {
    const body = new BinaryWriter().uint16le(0).uint16le(0).uint16le(0x0003).uint16le(4).toBuffer();
    this.sendSlowpath(
      pdu.writeShareControlHeader(
        PDUTYPE_DATAPDU,
        0x03ea,
        pdu.writeShareDataHeader(0x000103ea, PDUTYPE2_FONTMAP, body),
      ),
    );
  }
}

function toBe16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/**
 * Liest die im Client Network Data angemeldeten Kanalnamen aus dem MCS Connect
 * Initial.
 *
 * Statt BER und PER vollstaendig zurueckzubauen wird auf die T.124-Kennung
 * "Duca" gesucht: direkt dahinter steht die PER-Laenge der Clientdaten und
 * dann deren Bloecke. Fuer einen Testserver reicht das - die Bloecke selbst
 * werden sauber durchlaufen.
 */
function clientChannelNames(mcsData: Buffer): string[] {
  const marker = mcsData.indexOf('Duca', 0, 'ascii');
  if (marker < 0) return [];
  const r = new BinaryReader(mcsData, marker + 4);
  const laenge = per.readLength(r);
  const userData = new BinaryReader(r.bytes(Math.min(laenge, r.remaining)));

  while (userData.remaining >= 4) {
    const typ = userData.uint16le();
    const blockLaenge = userData.uint16le();
    if (blockLaenge < 4 || blockLaenge - 4 > userData.remaining) return [];
    const body = new BinaryReader(userData.bytes(blockLaenge - 4));
    if (typ !== CS_NET) continue;
    const anzahl = body.uint32le();
    const namen: string[] = [];
    for (let i = 0; i < anzahl && body.remaining >= 12; i++) {
      // 8 Byte Name (nullterminiert) + 4 Byte Optionen je Eintrag.
      const roh = body.ascii(8);
      const ende = roh.indexOf('\0');
      namen.push(ende < 0 ? roh : roh.substring(0, ende));
      body.uint32le();
    }
    return namen;
  }
  return [];
}

/**
 * DYNVC_CAPS_REQ (MS-RDPEDYC 2.2.1.1). Ab Version 2 folgen vier
 * PriorityCharge-Felder; der Client darf sie ignorieren, aber sie gehoeren
 * auf den Draht, damit hier keine kuerzere Nachricht steht als bei Windows.
 */
function buildDvcCapabilitiesRequest(version: number): Buffer {
  const w = new BinaryWriter().uint8(dvc.DVC_CMD_CAPABILITY << 4).uint8(0).uint16le(version);
  if (version >= 2) w.uint16le(0).uint16le(0).uint16le(0).uint16le(0);
  return w.toBuffer();
}

/** DYNVC_CREATE_REQ (MS-RDPEDYC 2.2.2.1); cbId 0, die Test-IDs sind einstellig. */
function buildDvcCreateRequest(channelId: number, name: string): Buffer {
  if (channelId > 0xff) throw new Error(`DVC-Kanal-ID ${channelId} passt nicht in ein Byte`);
  return new BinaryWriter()
    .uint8(dvc.DVC_CMD_CREATE << 4)
    .uint8(channelId)
    .ascii(name)
    .uint8(0) // Nullterminierung des Namens
    .toBuffer();
}

function blockOf(type: number, data: Buffer): Buffer {
  return Buffer.concat([new BinaryWriter().uint16le(type).uint16le(data.length + 4).toBuffer(), data]);
}
