/**
 * Capability Sets (MS-RDPBCGR 2.2.7).
 *
 * Der Client meldet bewusst *keine* Drawing-Orders als unterstuetzt: das
 * orderSupport-Array bleibt leer, dadurch faellt der Server auf reine
 * Bitmap-Updates zurueck - genau das, was dieser Client dekodieren kann.
 */
import { BinaryReader, writer } from '../core/binary.js';

export const CAPSTYPE_GENERAL = 0x0001;
export const CAPSTYPE_BITMAP = 0x0002;
export const CAPSTYPE_ORDER = 0x0003;
export const CAPSTYPE_BITMAPCACHE = 0x0004;
export const CAPSTYPE_CONTROL = 0x0005;
export const CAPSTYPE_ACTIVATION = 0x0007;
export const CAPSTYPE_POINTER = 0x0008;
export const CAPSTYPE_SHARE = 0x0009;
export const CAPSTYPE_COLORCACHE = 0x000a;
export const CAPSTYPE_SOUND = 0x000c;
export const CAPSTYPE_INPUT = 0x000d;
export const CAPSTYPE_FONT = 0x000e;
export const CAPSTYPE_BRUSH = 0x000f;
export const CAPSTYPE_GLYPHCACHE = 0x0010;
export const CAPSTYPE_OFFSCREENCACHE = 0x0011;
export const CAPSTYPE_BITMAPCACHE_HOSTSUPPORT = 0x0012;
export const CAPSTYPE_BITMAPCACHE_REV2 = 0x0013;
export const CAPSTYPE_VIRTUALCHANNEL = 0x0014;
export const CAPSTYPE_DRAWNINEGRIDCACHE = 0x0015;
export const CAPSTYPE_DRAWGDIPLUS = 0x0016;
export const CAPSTYPE_RAIL = 0x0017;
export const CAPSTYPE_WINDOW = 0x0018;
export const CAPSETTYPE_MULTIFRAGMENTUPDATE = 0x001a;
export const CAPSETTYPE_LARGE_POINTER = 0x001b;
export const CAPSETTYPE_SURFACE_COMMANDS = 0x001c;
export const CAPSETTYPE_BITMAP_CODECS = 0x001d;
export const CAPSETTYPE_FRAME_ACKNOWLEDGE = 0x001e;

/** extraFlags im General Capability Set. */
export const FASTPATH_OUTPUT_SUPPORTED = 0x0001;
export const NO_BITMAP_COMPRESSION_HDR = 0x0400;
export const LONG_CREDENTIALS_SUPPORTED = 0x0004;
export const AUTORECONNECT_SUPPORTED = 0x0008;
export const ENC_SALTED_CHECKSUM = 0x0010;

/** cmdFlags im Surface Commands Capability Set (2.2.7.2.9). */
export const SURFCMDS_SETSURFACEBITS = 0x00000002;
export const SURFCMDS_FRAMEMARKER = 0x00000010;
export const SURFCMDS_STREAMSURFACEBITS = 0x00000040;

/** inputFlags im Input Capability Set. */
export const INPUT_FLAG_SCANCODES = 0x0001;
export const INPUT_FLAG_MOUSEX = 0x0004;
export const INPUT_FLAG_FASTPATH_INPUT = 0x0008;
export const INPUT_FLAG_UNICODE = 0x0010;
export const INPUT_FLAG_FASTPATH_INPUT2 = 0x0020;

export interface CapabilitySet {
  type: number;
  data: Buffer;
}

export interface ClientCapabilityOptions {
  width: number;
  height: number;
  colorDepth: number;
  keyboardLayout: number;
}

/**
 * Stellschrauben am Capability-Satz.
 *
 * Welchen Weg ein Server zum Senden von Grafik waehlt, haengt allein davon ab,
 * was der Client anbietet - und manche Server senden gar nichts, wenn ihnen die
 * Auswahl nicht passt. Damit sich das nachmessen statt erraten laesst, sind die
 * fraglichen Punkte hier einzeln schaltbar.
 */
export interface CapabilityProfile {
  /**
   * Zeichenbefehle als unterstuetzt melden. Der Client kann sie *nicht*
   * dekodieren - nur zur Messung, ob ein Server ueberhaupt zu senden beginnt.
   */
  orders?: boolean;
  /** Surface Commands anbieten (Standard: ja). */
  surfaceCommands?: boolean;
  /** Bitmap-Cache-Capability mitschicken (Standard: ja). */
  bitmapCache?: boolean;
  /** Frame Acknowledge anbieten und Frames bestaetigen (Standard: nein). */
  frameAcknowledge?: boolean;
  /** Groesse des Reassemblierungspuffers fuer Fastpath-Updates. */
  multifragmentMaxRequestSize?: number;
  /**
   * CAPSETTYPE_LARGE_POINTER anbieten (Standard: nein). Der echte Client und
   * FreeRDP schicken ihn mit; ob dieser Server ihn fuer die Graphics Pipeline
   * braucht, ist eine Messfrage.
   */
  largePointer?: boolean;
  /** CAPSETTYPE_BITMAP_CODECS als leere Liste anbieten (Standard: nein). */
  bitmapCodecs?: boolean;
  /** VCChunkSize im Virtual-Channel-Satz; 0 laesst das Feld weg (Standard 1600). */
  virtualChannelChunkSize?: number;
  /** flags im Virtual-Channel-Satz (Standard 0 = VCCAPS_NO_COMPR). */
  virtualChannelFlags?: number;
  /**
   * AUTORECONNECT_SUPPORTED im General Capability Set melden (Standard: nein).
   *
   * Der Schalter gehoert mit dem Auswerten des Auto-Reconnect-Cookies
   * zusammen: die Capability ist eine Zusage an den Server, nach einem Abbruch
   * mit einem ARC_CS_PRIVATE_PACKET zurueckzukommen. Wer sie meldet, ohne den
   * Cookie zu verarbeiten, verspricht etwas, das er nicht einloest. Der
   * RdpClient setzt das Flag deshalb selbst, sobald autoReconnect aktiv ist.
   */
  autoReconnect?: boolean;
}

/** Indizes im orderSupport-Feld, die ein handelsueblicher Client meldet. */
const COMMON_ORDERS = [0, 1, 2, 3, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27];

function cap(type: number, body: Buffer): CapabilitySet {
  return { type, data: body };
}

/**
 * TS_GENERAL_CAPABILITYSET (MS-RDPBCGR 2.2.7.1.1).
 *
 * Hier steckt eine Altlast, und sie ist wichtig genug fuer eine Erklaerung:
 * der Satz wird seit jeher vier Byte zu lang geschrieben. generalCompressionTypes
 * und generalCompressionLevel belegen darin je vier Byte, die Spezifikation
 * sieht fuer beide nur zwei vor. Dadurch rutscht extraFlags von Offset 10 auf
 * Offset 12 - ein Server, der sich an 2.2.7.1.1 haelt, liest dort eine Null
 * und sieht folglich *keines* der gemeldeten Flags.
 *
 * Diese Fassung zu aendern wuerde den Draht fuer jede bestehende Verbindung
 * veraendern, und der Client laeuft damit nachweislich. Sie bleibt deshalb der
 * Normalfall. Nur wer Auto-Reconnect anfordert, bekommt den Satz in der Form
 * der Spezifikation - sonst laege AUTORECONNECT_SUPPORTED an einer Stelle, an
 * der der Server niemals nachschaut, und das ganze Verfahren liefe leer.
 *
 * Die Laenge generell geradezuruecken waere richtig, gehoert aber nicht in
 * diese Aenderung: das ist eine eigene Entscheidung, die an einem echten
 * Server nachzumessen ist.
 */
function generalCapability(autoReconnect: boolean): CapabilitySet {
  const extraFlags =
    LONG_CREDENTIALS_SUPPORTED |
    NO_BITMAP_COMPRESSION_HDR |
    FASTPATH_OUTPUT_SUPPORTED |
    (autoReconnect ? AUTORECONNECT_SUPPORTED : 0);

  const w = writer();
  w.uint16le(1) // osMajorType: Windows
    .uint16le(3) // osMinorType: Windows NT
    .uint16le(0x0200) // protocolVersion
    .uint16le(0); // pad2octetsA

  if (autoReconnect) {
    // Wie in 2.2.7.1.1: je zwei Byte. Rumpf 20 Byte, lengthCapability 24.
    w.uint16le(0) // generalCompressionTypes
      .uint16le(extraFlags)
      .uint16le(0) // updateCapabilityFlag
      .uint16le(0) // remoteUnshareFlag
      .uint16le(0); // generalCompressionLevel
  } else {
    // Die bisherige, vier Byte zu lange Fassung - unveraendert.
    w.uint32le(0) // generalCompressionTypes
      .uint16le(extraFlags)
      .uint16le(0) // updateCapabilityFlag
      .uint16le(0) // remoteUnshareFlag
      .uint32le(0); // generalCompressionLevel
  }

  w.uint8(0) // refreshRectSupport
    .uint8(0); // suppressOutputSupport
  return cap(CAPSTYPE_GENERAL, w.toBuffer());
}

function bitmapCapability(o: ClientCapabilityOptions): CapabilitySet {
  const w = writer();
  w.uint16le(o.colorDepth)
    .uint16le(1) // receive1BitPerPixel
    .uint16le(1) // receive4BitsPerPixel
    .uint16le(1) // receive8BitsPerPixel
    .uint16le(o.width)
    .uint16le(o.height)
    .uint16le(0)
    .uint16le(1) // desktopResizeFlag
    .uint16le(1) // bitmapCompressionFlag
    .uint8(0) // highColorFlags
    .uint8(0) // drawingFlags
    .uint16le(1) // multipleRectangleSupport
    .uint16le(0);
  return cap(CAPSTYPE_BITMAP, w.toBuffer());
}

function orderCapability(withOrders: boolean): CapabilitySet {
  const NEGOTIATEORDERSUPPORT = 0x0002;
  const ZEROBOUNDSDELTASUPPORT = 0x0008;
  const COLORINDEXSUPPORT = 0x0020;
  const orderSupport = Buffer.alloc(32);
  if (withOrders) {
    for (const index of COMMON_ORDERS) orderSupport[index] = 1;
  }
  const w = writer();
  w.zeros(16) // terminalDescriptor
    .uint32le(0)
    .uint16le(1) // desktopSaveXGranularity
    .uint16le(20) // desktopSaveYGranularity
    .uint16le(0)
    .uint16le(1) // maximumOrderLevel
    .uint16le(0) // numberFonts
    .uint16le(NEGOTIATEORDERSUPPORT | ZEROBOUNDSDELTASUPPORT | COLORINDEXSUPPORT)
    .bytes(orderSupport)
    .uint16le(0) // textFlags
    .uint16le(0) // orderSupportExFlags
    .uint32le(0)
    .uint32le(230400) // desktopSaveSize
    .uint16le(0)
    .uint16le(0)
    .uint16le(0) // textANSICodePage
    .uint16le(0);
  return cap(CAPSTYPE_ORDER, w.toBuffer());
}

function bitmapCacheCapability(): CapabilitySet {
  // Kein Cache: alle Zellgroessen 0, der Server schickt dann jede Bitmap komplett.
  return cap(CAPSTYPE_BITMAPCACHE, writer().zeros(24).zeros(12).toBuffer());
}

function pointerCapability(): CapabilitySet {
  const w = writer();
  w.uint16le(1) // colorPointerFlag: Farbzeiger werden unterstuetzt
    .uint16le(20) // colorPointerCacheSize
    .uint16le(20); // pointerCacheSize
  return cap(CAPSTYPE_POINTER, w.toBuffer());
}

function inputCapability(o: ClientCapabilityOptions): CapabilitySet {
  const w = writer();
  w.uint16le(INPUT_FLAG_SCANCODES | INPUT_FLAG_MOUSEX | INPUT_FLAG_UNICODE)
    .uint16le(0)
    .uint32le(o.keyboardLayout)
    .uint32le(4) // keyboardType
    .uint32le(0) // keyboardSubType
    .uint32le(12) // keyboardFunctionKey
    .zeros(64); // imeFileName
  return cap(CAPSTYPE_INPUT, w.toBuffer());
}

function brushCapability(): CapabilitySet {
  return cap(CAPSTYPE_BRUSH, writer().uint32le(0).toBuffer());
}

function glyphCacheCapability(): CapabilitySet {
  const w = writer();
  for (let i = 0; i < 10; i++) w.uint16le(254).uint16le(4);
  w.uint32le(0x01000100) // fragCache
    .uint16le(0) // glyphSupportLevel: keine Glyph-Orders
    .uint16le(0);
  return cap(CAPSTYPE_GLYPHCACHE, w.toBuffer());
}

function offscreenCapability(): CapabilitySet {
  return cap(CAPSTYPE_OFFSCREENCACHE, writer().uint32le(0).uint16le(0).uint16le(0).toBuffer());
}

/**
 * TS_VIRTUALCHANNEL_CAPABILITYSET (2.2.7.1.10).
 *
 * `flags` ist VCCAPS_NO_COMPR, solange wir keine Kanalkompression koennen.
 * `VCChunkSize` ist laut Spezifikation in Client-Richtung zu ignorieren - ob
 * sich Windows daran haelt, ist eine Messfrage, deshalb einstellbar. Ist die
 * Groesse 0, entfaellt das Feld ganz (der Satz ist dann acht Byte lang).
 */
function virtualChannelCapability(profile: CapabilityProfile): CapabilitySet {
  const flags = profile.virtualChannelFlags ?? 0;
  const chunk = profile.virtualChannelChunkSize ?? 1600;
  const w = writer().uint32le(flags);
  if (chunk > 0) w.uint32le(chunk);
  return cap(CAPSTYPE_VIRTUALCHANNEL, w.toBuffer());
}

function soundCapability(): CapabilitySet {
  return cap(CAPSTYPE_SOUND, writer().uint16le(0).uint16le(0).toBuffer());
}

function controlCapability(): CapabilitySet {
  const w = writer();
  w.uint16le(0).uint16le(0).uint16le(2).uint16le(2);
  return cap(CAPSTYPE_CONTROL, w.toBuffer());
}

function activationCapability(): CapabilitySet {
  return cap(CAPSTYPE_ACTIVATION, writer().zeros(8).toBuffer());
}

function fontCapability(): CapabilitySet {
  return cap(CAPSTYPE_FONT, writer().uint16le(0x0001).uint16le(0).toBuffer());
}

function colorCacheCapability(): CapabilitySet {
  return cap(CAPSTYPE_COLORCACHE, writer().uint16le(6).uint16le(0).toBuffer());
}

function shareCapability(): CapabilitySet {
  return cap(CAPSTYPE_SHARE, writer().uint16le(0).uint16le(0).toBuffer());
}

/**
 * Surface Commands (2.2.7.2.9).
 *
 * Aktuelle Windows-Versionen liefern Bildschirminhalte bevorzugt als
 * Surface Bits statt als klassische Bitmap-Updates. Ohne diese Capability
 * bleibt der Bildschirm bei ihnen schlicht leer. Da wir keine Bitmap-Codecs
 * anbieten, bleibt dem Server nur codecID 0 - also unkomprimierte Pixel,
 * die dieser Client direkt verarbeiten kann.
 */
function surfaceCommandsCapability(): CapabilitySet {
  const w = writer();
  w.uint32le(SURFCMDS_SETSURFACEBITS | SURFCMDS_FRAMEMARKER | SURFCMDS_STREAMSURFACEBITS).uint32le(0);
  return cap(CAPSETTYPE_SURFACE_COMMANDS, w.toBuffer());
}

/**
 * Frame Acknowledge (2.2.7.2.7). Wird sie angeboten, klammert der Server seine
 * Updates in Frame-Marker und erwartet Bestaetigungen.
 */
function frameAcknowledgeCapability(): CapabilitySet {
  return cap(CAPSETTYPE_FRAME_ACKNOWLEDGE, writer().uint32le(2).toBuffer());
}

/**
 * TS_LARGE_POINTER_CAPABILITYSET (2.2.7.2.7): ein einziges Flagsfeld.
 * 0x1 erlaubt 96x96-Zeiger, 0x2 zusaetzlich 384x384.
 */
function largePointerCapability(): CapabilitySet {
  return cap(CAPSETTYPE_LARGE_POINTER, writer().uint16le(0x0001 | 0x0002).toBuffer());
}

/**
 * TS_BITMAPCODECS_CAPABILITYSET (2.2.7.2.10) mit leerer Liste: bitmapCodecCount
 * null, kein Eintrag. Sagt aus "ich kenne keinen der klassischen Codecs" - fuer
 * die Graphics Pipeline ist das folgerichtig, denn deren Codecs werden
 * getrennt ueber CAPS_ADVERTISE ausgehandelt.
 */
function bitmapCodecsCapability(): CapabilitySet {
  return cap(CAPSETTYPE_BITMAP_CODECS, writer().uint8(0).toBuffer());
}

function multifragmentCapability(maxRequestSize: number): CapabilitySet {
  // MaxRequestSize begrenzt, wie gross ein zusammenhaengendes Fastpath-Update
  // sein darf. Ein Vollbild als unkomprimierte Surface Bits sprengt 64 KB
  // muehelos (1920x1080x4 sind rund 8 MB), deshalb hier der Wert, den auch
  // moderne Clients melden.
  return cap(CAPSETTYPE_MULTIFRAGMENTUPDATE, writer().uint32le(maxRequestSize).toBuffer());
}

export function buildClientCapabilities(
  o: ClientCapabilityOptions,
  profile: CapabilityProfile = {},
): CapabilitySet[] {
  const caps: CapabilitySet[] = [
    generalCapability(profile.autoReconnect === true),
    bitmapCapability(o),
    orderCapability(profile.orders === true),
  ];
  if (profile.bitmapCache !== false) caps.push(bitmapCacheCapability());
  caps.push(
    pointerCapability(),
    inputCapability(o),
    brushCapability(),
    glyphCacheCapability(),
    offscreenCapability(),
    virtualChannelCapability(profile),
    soundCapability(),
    controlCapability(),
    activationCapability(),
    fontCapability(),
    colorCacheCapability(),
    shareCapability(),
    multifragmentCapability(profile.multifragmentMaxRequestSize ?? 0x3f0000),
  );
  if (profile.surfaceCommands !== false) caps.push(surfaceCommandsCapability());
  if (profile.frameAcknowledge === true) caps.push(frameAcknowledgeCapability());
  if (profile.largePointer === true) caps.push(largePointerCapability());
  if (profile.bitmapCodecs === true) caps.push(bitmapCodecsCapability());
  return caps;
}

export function serializeCapabilities(caps: CapabilitySet[]): Buffer {
  const parts: Buffer[] = [];
  for (const c of caps) {
    parts.push(writer().uint16le(c.type).uint16le(c.data.length + 4).bytes(c.data).toBuffer());
  }
  return Buffer.concat(parts);
}

export interface ServerCapabilities {
  /** Vom Server gemeldete Desktopgroesse, falls im Bitmap Capability Set enthalten. */
  desktopWidth?: number;
  desktopHeight?: number;
  preferredBitsPerPixel?: number;
  refreshRectSupport?: boolean;
  raw: Map<number, Buffer>;
}

export function parseCapabilities(r: BinaryReader, count: number): ServerCapabilities {
  const raw = new Map<number, Buffer>();
  const out: ServerCapabilities = { raw };
  for (let i = 0; i < count && r.remaining >= 4; i++) {
    const type = r.uint16le();
    const length = r.uint16le();
    if (length < 4 || length - 4 > r.remaining) break;
    const body = r.bytes(length - 4);
    raw.set(type, body);
    if (type === CAPSTYPE_BITMAP && body.length >= 12) {
      out.preferredBitsPerPixel = body.readUInt16LE(0);
      out.desktopWidth = body.readUInt16LE(8);
      out.desktopHeight = body.readUInt16LE(10);
    } else if (type === CAPSTYPE_GENERAL && body.length >= 22) {
      out.refreshRectSupport = body.readUInt8(20) !== 0;
    }
  }
  return out;
}
