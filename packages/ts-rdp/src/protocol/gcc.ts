/**
 * GCC Conference Create Request/Response (T.124) samt der RDP-spezifischen
 * Client-/Server-Datenbloecke (MS-RDPBCGR 2.2.1.3 / 2.2.1.4).
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';
import * as per from './per.js';

const T124_OID = [0, 0, 20, 124, 0, 1];

export const CS_CORE = 0xc001;
export const CS_SECURITY = 0xc002;
export const CS_NET = 0xc003;
export const CS_CLUSTER = 0xc004;
export const CS_MONITOR = 0xc005;

export const SC_CORE = 0x0c01;
export const SC_SECURITY = 0x0c02;
export const SC_NET = 0x0c03;

export const RNS_UD_COLOR_8BPP = 0xca01;
export const RNS_UD_COLOR_16BPP_555 = 0xca02;
export const RNS_UD_COLOR_16BPP_565 = 0xca03;
export const RNS_UD_COLOR_24BPP = 0xca04;

export const RNS_UD_15BPP_SUPPORT = 0x0001;
export const RNS_UD_16BPP_SUPPORT = 0x0002;
export const RNS_UD_24BPP_SUPPORT = 0x0004;
export const RNS_UD_32BPP_SUPPORT = 0x0008;

export const RNS_UD_CS_SUPPORT_ERRINFO_PDU = 0x0001;
export const RNS_UD_CS_WANT_32BPP_SESSION = 0x0002;
export const RNS_UD_CS_SUPPORT_DYNVC_GFX_PROTOCOL = 0x0100;
export const RNS_UD_CS_SUPPORT_STATUSINFO_PDU = 0x0004;
export const RNS_UD_CS_VALID_CONNECTION_TYPE = 0x0020;
export const RNS_UD_CS_SUPPORT_MONITOR_LAYOUT_PDU = 0x0040;
export const RNS_UD_CS_SUPPORT_NETCHAR_AUTODETECT = 0x0080;
export const RNS_UD_CS_SUPPORT_DYNAMIC_TIME_ZONE = 0x0200;
export const RNS_UD_CS_SUPPORT_HEARTBEAT_PDU = 0x0400;

/** Optionen eines virtuellen Kanals (2.2.1.3.4.1). */
export const CHANNEL_OPTION_INITIALIZED = 0x80000000;
export const CHANNEL_OPTION_ENCRYPT_RDP = 0x40000000;
export const CHANNEL_OPTION_COMPRESS_RDP = 0x00800000;
export const CHANNEL_OPTION_SHOW_PROTOCOL = 0x00200000;

export interface ChannelDef {
  name: string;
  options: number;
}

export interface ClientCoreSettings {
  width: number;
  height: number;
  /** 15, 16, 24 oder 32 - bestimmt das Pixelformat der Bitmap-Updates. */
  colorDepth: number;
  keyboardLayout: number;
  clientName: string;
  selectedProtocol: number;
  /** Nur relevant, wenn der Server 32bpp-Sessions anbieten soll. */
  earlyCapabilityFlags?: number;
  /**
   * RDP-Version im Feld `version` (2.2.1.3.2). 0x00080004 heisst "RDP 5.0+",
   * 0x00080005 und hoeher stehen fuer RDP 10.x. Wer die Graphics Pipeline
   * anfordert, sollte sich nicht als Client von 2003 ausgeben.
   */
  clientVersion?: number;
  /** Buildnummer des Clients; Windows-Server leiten daraus Faehigkeiten ab. */
  clientBuild?: number;
  /**
   * Client Monitor Data (2.2.1.3.6) mitschicken. Die Graphics Pipeline rechnet
   * in Monitoren, nicht in Desktopmassen: RDPGFX_RESET_GRAPHICS traegt eine
   * Monitorliste, die der Server aus genau diesem Block aufbaut.
   */
  monitorLayout?: boolean;
}

function clientCoreData(s: ClientCoreSettings): Buffer {
  // highColorDepth kennt nur 4, 8, 15, 16 und 24 - eine 32-bpp-Sitzung wird
  // ueber RNS_UD_CS_WANT_32BPP_SESSION zusammen mit 24 angefordert.
  const highColor = s.colorDepth === 15 ? 15 : s.colorDepth === 16 ? 16 : 24;
  const supported =
    RNS_UD_15BPP_SUPPORT | RNS_UD_16BPP_SUPPORT | RNS_UD_24BPP_SUPPORT | RNS_UD_32BPP_SUPPORT;
  const earlyFlags =
    (s.earlyCapabilityFlags ?? RNS_UD_CS_SUPPORT_ERRINFO_PDU) |
    (s.colorDepth === 32 ? RNS_UD_CS_WANT_32BPP_SESSION : 0);
  const w = writer();
  w.uint32le(s.clientVersion ?? 0x00080004) // version
    .uint16le(s.width)
    .uint16le(s.height)
    .uint16le(RNS_UD_COLOR_16BPP_565)
    .uint16le(0xaa03) // SAS sequence
    .uint32le(s.keyboardLayout)
    .uint32le(s.clientBuild ?? 3790) // clientBuild
    .utf16le(s.clientName.substring(0, 15), 32)
    .uint32le(4) // keyboardType: IBM enhanced (101/102 Tasten)
    .uint32le(0) // keyboardSubType
    .uint32le(12) // keyboardFunctionKey
    .zeros(64) // imeFileName
    .uint16le(RNS_UD_COLOR_8BPP) // postBeta2ColorDepth
    .uint16le(1) // clientProductId
    .uint32le(0) // serialNumber
    .uint16le(highColor)
    .uint16le(supported)
    .uint16le(earlyFlags)
    .zeros(64) // clientDigProductId
    .uint8(0) // connectionType
    .uint8(0) // pad
    .uint32le(s.selectedProtocol);
  return w.toBuffer();
}

/** TS_MONITOR_PRIMARY (2.2.1.3.6.1). */
const TS_MONITOR_PRIMARY = 0x00000001;

/**
 * TS_UD_CS_MONITOR (2.2.1.3.6): ein einzelner, primaerer Monitor, der den
 * ganzen angeforderten Desktop abdeckt.
 *
 * Die Kanten sind *einschliessend*: ein 1024 Pixel breiter Monitor reicht von
 * 0 bis 1023. Der primaere Monitor muss bei (0,0) beginnen.
 */
function clientMonitorData(s: ClientCoreSettings): Buffer {
  return writer()
    .uint32le(0) // flags: laut Spezifikation unbenutzt
    .uint32le(1) // monitorCount
    .uint32le(0) // left
    .uint32le(0) // top
    .uint32le(s.width - 1) // right, einschliessend
    .uint32le(s.height - 1) // bottom, einschliessend
    .uint32le(TS_MONITOR_PRIMARY)
    .toBuffer();
}

function clientSecurityData(): Buffer {
  // Bei TLS/NLA uebernimmt die Transportschicht die Verschluesselung, darum
  // werden hier keine RDP-eigenen Verfahren angeboten.
  return writer().uint32le(0).uint32le(0).toBuffer();
}

function clientNetworkData(channels: ChannelDef[]): Buffer {
  const w = writer().uint32le(channels.length);
  for (const c of channels) {
    w.ascii(c.name.substring(0, 7), 8).uint32le(c.options);
  }
  return w.toBuffer();
}

function clientClusterData(): Buffer {
  // REDIRECTION_SUPPORTED | Redirect-Version 4 (0x0d = 1 | (4 << 2)).
  return writer().uint32le(0x0d).uint32le(0).toBuffer();
}

function block(type: number, data: Buffer): Buffer {
  return Buffer.concat([writer().uint16le(type).uint16le(data.length + 4).toBuffer(), data]);
}

export function buildClientData(settings: ClientCoreSettings, channels: ChannelDef[]): Buffer {
  return Buffer.concat([
    block(CS_CORE, clientCoreData(settings)),
    block(CS_CLUSTER, clientClusterData()),
    block(CS_SECURITY, clientSecurityData()),
    ...(channels.length ? [block(CS_NET, clientNetworkData(channels))] : []),
    ...(settings.monitorLayout ? [block(CS_MONITOR, clientMonitorData(settings))] : []),
  ]);
}

/** Verpackt die Clientdaten in einen GCC Conference Create Request. */
export function buildConferenceCreateRequest(userData: Buffer): Buffer {
  return Buffer.concat([
    per.writeChoice(0),
    per.writeObjectIdentifier(T124_OID),
    per.writeLength(userData.length + 14),
    per.writeChoice(0),
    per.writeSelection(0x08),
    per.writeNumericString('1', 1),
    per.writePadding(1),
    per.writeNumberOfSet(1),
    per.writeChoice(0xc0),
    per.writeOctetStream('Duca', 4),
    per.writeOctetStream(userData),
  ]);
}

export interface ServerCoreData {
  version: number;
  clientRequestedProtocols?: number;
  earlyCapabilityFlags?: number;
}

export interface ServerSecurityData {
  encryptionMethod: number;
  encryptionLevel: number;
  serverRandom?: Buffer;
  serverCertificate?: Buffer;
}

export interface ServerNetworkData {
  mcsChannelId: number;
  channelIds: number[];
}

export interface ServerData {
  core?: ServerCoreData;
  security?: ServerSecurityData;
  network?: ServerNetworkData;
}

/** Liest die Serverantwort und liefert die enthaltenen Datenbloecke. */
export function parseConferenceCreateResponse(payload: Buffer): ServerData {
  const r = new BinaryReader(payload);
  per.readChoice(r);
  per.readObjectIdentifier(r, T124_OID);
  per.readLength(r);
  per.readChoice(r);
  per.readInteger16(r, 1001); // nodeID
  per.readInteger(r); // tag
  per.readEnumerates(r); // result
  per.readNumberOfSet(r);
  per.readChoice(r);
  per.readOctetStream(r, 'McDn', 4);
  const length = per.readLength(r);
  return parseServerData(r.bytes(Math.min(length, r.remaining)));
}

export function parseServerData(buf: Buffer): ServerData {
  const r = new BinaryReader(buf);
  const out: ServerData = {};
  while (r.remaining >= 4) {
    const type = r.uint16le();
    const length = r.uint16le();
    if (length < 4 || length - 4 > r.remaining) {
      throw new RdpProtocolError(`GCC: ungueltige Blocklaenge ${length} fuer Typ 0x${type.toString(16)}`);
    }
    const body = new BinaryReader(r.bytes(length - 4));
    switch (type) {
      case SC_CORE:
        out.core = {
          version: body.remaining >= 4 ? body.uint32le() : 0,
          clientRequestedProtocols: body.remaining >= 4 ? body.uint32le() : undefined,
          earlyCapabilityFlags: body.remaining >= 4 ? body.uint32le() : undefined,
        };
        break;
      case SC_SECURITY: {
        const encryptionMethod = body.uint32le();
        const encryptionLevel = body.uint32le();
        const sec: ServerSecurityData = { encryptionMethod, encryptionLevel };
        if (body.remaining >= 8) {
          const randomLen = body.uint32le();
          const certLen = body.uint32le();
          if (randomLen <= body.remaining) sec.serverRandom = body.bytes(randomLen);
          if (certLen <= body.remaining) sec.serverCertificate = body.bytes(certLen);
        }
        out.security = sec;
        break;
      }
      case SC_NET: {
        const mcsChannelId = body.uint16le();
        const count = body.uint16le();
        const channelIds: number[] = [];
        for (let i = 0; i < count && body.remaining >= 2; i++) channelIds.push(body.uint16le());
        out.network = { mcsChannelId, channelIds };
        break;
      }
      default:
        break; // unbekannte Bloecke werden ignoriert
    }
  }
  return out;
}
