/**
 * Graphics Pipeline (MS-RDPEGFX) - Nachrichtenschicht.
 *
 * Der Weg der Daten: dynamischer Kanal "Microsoft::Windows::RDS::Graphics"
 * (src/protocol/dvc.ts) -> ZGFX-Dekompression (src/codec/zgfx.ts) -> diese
 * Datei. Ein dekomprimierter Block enthaelt regelmaessig *mehrere* PDUs
 * hintereinander (der Server buendelt einen ganzen Frame), deshalb liefert
 * `parseEgfxPdus` eine Liste und keine einzelne Nachricht.
 *
 * Alle Strukturen und Zahlenwerte stammen aus MS-RDPEGFX 2.2 und sind
 * nachgeschlagen statt erinnert. Zwei Stolpersteine, die das rechtfertigen:
 * PIXEL_FORMAT_XRGB_8888 ist 0x20 (keine laufende Nummer), und im
 * FRAME_ACKNOWLEDGE steht auf dem Draht zuerst `queueDepth` und erst danach
 * `frameId`.
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';

/** Name des dynamischen Kanals, auf dem die Pipeline laeuft (MS-RDPEGFX 1.3.1). */
export const EGFX_CHANNEL_NAME = 'Microsoft::Windows::RDS::Graphics';

/** Groesse des RDPGFX_HEADER (2.2.1.5): cmdId + flags + pduLength. */
export const EGFX_HEADER_SIZE = 8;

// --- Befehls-IDs (MS-RDPEGFX 2.2.1.5) ---------------------------------------

export const RDPGFX_CMDID_WIRETOSURFACE_1 = 0x0001;
export const RDPGFX_CMDID_WIRETOSURFACE_2 = 0x0002;
export const RDPGFX_CMDID_DELETEENCODINGCONTEXT = 0x0003;
export const RDPGFX_CMDID_SOLIDFILL = 0x0004;
export const RDPGFX_CMDID_SURFACETOSURFACE = 0x0005;
export const RDPGFX_CMDID_SURFACETOCACHE = 0x0006;
export const RDPGFX_CMDID_CACHETOSURFACE = 0x0007;
export const RDPGFX_CMDID_EVICTCACHEENTRY = 0x0008;
export const RDPGFX_CMDID_CREATESURFACE = 0x0009;
export const RDPGFX_CMDID_DELETESURFACE = 0x000a;
export const RDPGFX_CMDID_STARTFRAME = 0x000b;
export const RDPGFX_CMDID_ENDFRAME = 0x000c;
export const RDPGFX_CMDID_FRAMEACKNOWLEDGE = 0x000d;
export const RDPGFX_CMDID_RESETGRAPHICS = 0x000e;
export const RDPGFX_CMDID_MAPSURFACETOOUTPUT = 0x000f;
export const RDPGFX_CMDID_CACHEIMPORTOFFER = 0x0010;
export const RDPGFX_CMDID_CACHEIMPORTREPLY = 0x0011;
export const RDPGFX_CMDID_CAPSADVERTISE = 0x0012;
export const RDPGFX_CMDID_CAPSCONFIRM = 0x0013;
/** 0x0014 ist nicht vergeben. */
export const RDPGFX_CMDID_MAPSURFACETOWINDOW = 0x0015;
export const RDPGFX_CMDID_QOEFRAMEACKNOWLEDGE = 0x0016;
export const RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT = 0x0017;
export const RDPGFX_CMDID_MAPSURFACETOSCALEDWINDOW = 0x0018;

// --- Codec-IDs (MS-RDPEGFX 2.2.2.1 / 2.2.2.2) -------------------------------

export const RDPGFX_CODECID_UNCOMPRESSED = 0x0000;
export const RDPGFX_CODECID_CAVIDEO = 0x0003;
export const RDPGFX_CODECID_CLEARCODEC = 0x0008;
export const RDPGFX_CODECID_CAPROGRESSIVE = 0x0009;
export const RDPGFX_CODECID_PLANAR = 0x000a;
export const RDPGFX_CODECID_AVC420 = 0x000b;
export const RDPGFX_CODECID_ALPHA = 0x000c;
export const RDPGFX_CODECID_AVC444 = 0x000e;
export const RDPGFX_CODECID_AVC444V2 = 0x000f;

// --- Pixelformate (MS-RDPEGFX 2.2.1.4) --------------------------------------

/** 32 bpp ohne gueltigen Alphakanal. */
export const PIXEL_FORMAT_XRGB_8888 = 0x20;
/** 32 bpp mit gueltigem Alphakanal. */
export const PIXEL_FORMAT_ARGB_8888 = 0x21;

// --- Capability-Versionen und -Flags (MS-RDPEGFX 2.2.1.6, 2.2.3.x) ----------

export const RDPGFX_CAPVERSION_8 = 0x00080004;
export const RDPGFX_CAPVERSION_81 = 0x00080105;
export const RDPGFX_CAPVERSION_10 = 0x000a0002;
export const RDPGFX_CAPVERSION_101 = 0x000a0100;
export const RDPGFX_CAPVERSION_102 = 0x000a0200;
export const RDPGFX_CAPVERSION_103 = 0x000a0301;
export const RDPGFX_CAPVERSION_104 = 0x000a0400;
export const RDPGFX_CAPVERSION_105 = 0x000a0502;
export const RDPGFX_CAPVERSION_106 = 0x000a0600;
export const RDPGFX_CAPVERSION_107 = 0x000a0701;

/** Cache auf 16 MB begrenzt *und* RemoteFX statt RemoteFX Progressive. */
export const RDPGFX_CAPS_FLAG_THINCLIENT = 0x00000001;
/** Cache auf 16 MB begrenzt (ohne Aussage ueber den Codec). */
export const RDPGFX_CAPS_FLAG_SMALL_CACHE = 0x00000002;
/** Nur V8.1: H.264 in YUV420p wird unterstuetzt. */
export const RDPGFX_CAPS_FLAG_AVC420_ENABLED = 0x00000010;
/** Ab V10: H.264 wird *nicht* unterstuetzt. Ohne dieses Flag verlangt der Server YUV444. */
export const RDPGFX_CAPS_FLAG_AVC_DISABLED = 0x00000020;
/** Ab V10.3: H.264 in YUV444 wird bevorzugt. Schliesst AVC_DISABLED aus. */
export const RDPGFX_CAPS_FLAG_AVC_THINCLIENT = 0x00000040;
/** Ab V10.7: MAPSURFACETOSCALED*-Nachrichten werden nicht unterstuetzt. */
export const RDPGFX_CAPS_FLAG_SCALEDMAP_DISABLE = 0x00000080;

/** queueDepth-Sonderwerte im FRAME_ACKNOWLEDGE (2.2.2.13). */
export const QUEUE_DEPTH_UNAVAILABLE = 0x00000000;
export const SUSPEND_FRAME_ACKNOWLEDGEMENT = 0xffffffff;

// --- Gemeinsame Strukturen --------------------------------------------------

export interface EgfxHeader {
  cmdId: number;
  flags: number;
  pduLength: number;
}

/** RDPGFX_RECT16 (2.2.1.2): rechte und untere Kante liegen *ausserhalb*. */
export interface EgfxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** RDPGFX_POINT16 (2.2.1.1) - vorzeichenbehaftet. */
export interface EgfxPoint {
  x: number;
  y: number;
}

/** RDPGFX_COLOR32 (2.2.1.3), Reihenfolge auf dem Draht: B, G, R, XA. */
export interface EgfxColor {
  b: number;
  g: number;
  r: number;
  /** Alpha bei ARGB, sonst zu ignorieren. */
  a: number;
}

/** TS_MONITOR_DEF (MS-RDPBCGR 2.2.1.3.6.1), rechte/untere Kante inklusive. */
export interface EgfxMonitor {
  left: number;
  top: number;
  right: number;
  bottom: number;
  flags: number;
}

/**
 * RDPGFX_CAPSET (2.2.1.6). Beim Bauen genuegt `version` (plus optional
 * `flags`), beim Parsen sind alle Felder gefuellt.
 */
export interface EgfxCapsSet {
  version: number;
  /** Inhalt des 4-Byte-Flagsfelds; bei Versionen ohne Flagsfeld 0. */
  flags?: number;
  /** Rohes capsData-Feld, falls eine Version ein abweichendes Format hat. */
  capsData?: Buffer;
}

// --- Diskriminierte Union ueber cmdId ---------------------------------------

export interface EgfxWireToSurface1 {
  cmdId: typeof RDPGFX_CMDID_WIRETOSURFACE_1;
  surfaceId: number;
  codecId: number;
  pixelFormat: number;
  /** Zielrechteck auf der Surface; bei AVC-Codecs nur ein umschliessendes Rechteck. */
  destRect: EgfxRect;
  bitmapData: Buffer;
}

export interface EgfxWireToSurface2 {
  cmdId: typeof RDPGFX_CMDID_WIRETOSURFACE_2;
  surfaceId: number;
  codecId: number;
  codecContextId: number;
  pixelFormat: number;
  bitmapData: Buffer;
}

export interface EgfxDeleteEncodingContext {
  cmdId: typeof RDPGFX_CMDID_DELETEENCODINGCONTEXT;
  surfaceId: number;
  codecContextId: number;
}

export interface EgfxSolidFill {
  cmdId: typeof RDPGFX_CMDID_SOLIDFILL;
  surfaceId: number;
  fillPixel: EgfxColor;
  fillRects: EgfxRect[];
}

export interface EgfxSurfaceToSurface {
  cmdId: typeof RDPGFX_CMDID_SURFACETOSURFACE;
  surfaceIdSrc: number;
  surfaceIdDest: number;
  rectSrc: EgfxRect;
  destPts: EgfxPoint[];
}

export interface EgfxSurfaceToCache {
  cmdId: typeof RDPGFX_CMDID_SURFACETOCACHE;
  surfaceId: number;
  /** 64 Bit, deshalb bigint. */
  cacheKey: bigint;
  cacheSlot: number;
  rectSrc: EgfxRect;
}

export interface EgfxCacheToSurface {
  cmdId: typeof RDPGFX_CMDID_CACHETOSURFACE;
  cacheSlot: number;
  surfaceId: number;
  destPts: EgfxPoint[];
}

export interface EgfxEvictCacheEntry {
  cmdId: typeof RDPGFX_CMDID_EVICTCACHEENTRY;
  cacheSlot: number;
}

export interface EgfxCreateSurface {
  cmdId: typeof RDPGFX_CMDID_CREATESURFACE;
  surfaceId: number;
  width: number;
  height: number;
  pixelFormat: number;
}

export interface EgfxDeleteSurface {
  cmdId: typeof RDPGFX_CMDID_DELETESURFACE;
  surfaceId: number;
}

export interface EgfxStartFrame {
  cmdId: typeof RDPGFX_CMDID_STARTFRAME;
  /** Gepacktes Feld (ms:10, s:6, min:6, h:10), 0 wenn nicht verfuegbar. */
  timestamp: number;
  frameId: number;
}

export interface EgfxEndFrame {
  cmdId: typeof RDPGFX_CMDID_ENDFRAME;
  frameId: number;
}

export interface EgfxResetGraphics {
  cmdId: typeof RDPGFX_CMDID_RESETGRAPHICS;
  width: number;
  height: number;
  monitors: EgfxMonitor[];
}

export interface EgfxMapSurfaceToOutput {
  cmdId: typeof RDPGFX_CMDID_MAPSURFACETOOUTPUT;
  surfaceId: number;
  outputOriginX: number;
  outputOriginY: number;
}

export interface EgfxMapSurfaceToScaledOutput {
  cmdId: typeof RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT;
  surfaceId: number;
  outputOriginX: number;
  outputOriginY: number;
  targetWidth: number;
  targetHeight: number;
}

export interface EgfxCacheImportReply {
  cmdId: typeof RDPGFX_CMDID_CACHEIMPORTREPLY;
  /** Die ersten N Eintraege des letzten Angebots wurden uebernommen. */
  cacheSlots: number[];
}

export interface EgfxCapsConfirm {
  cmdId: typeof RDPGFX_CMDID_CAPSCONFIRM;
  capsSet: Required<EgfxCapsSet>;
}

/**
 * Alles, was wir (noch) nicht auswerten. Die Pipeline darf daran nicht
 * scheitern, sonst reisst eine einzige unbekannte Nachricht die ganze
 * Sitzung ab - `raw` enthaelt das komplette PDU inklusive Kopf zum Mitloggen.
 */
export interface EgfxUnknownPdu {
  cmdId: number;
  raw: Buffer;
}

export type EgfxPdu =
  | EgfxWireToSurface1
  | EgfxWireToSurface2
  | EgfxDeleteEncodingContext
  | EgfxSolidFill
  | EgfxSurfaceToSurface
  | EgfxSurfaceToCache
  | EgfxCacheToSurface
  | EgfxEvictCacheEntry
  | EgfxCreateSurface
  | EgfxDeleteSurface
  | EgfxStartFrame
  | EgfxEndFrame
  | EgfxResetGraphics
  | EgfxMapSurfaceToOutput
  | EgfxMapSurfaceToScaledOutput
  | EgfxCacheImportReply
  | EgfxCapsConfirm
  | EgfxUnknownPdu;

// --- Lesehilfen -------------------------------------------------------------

function readRect(r: BinaryReader): EgfxRect {
  return { left: r.uint16le(), top: r.uint16le(), right: r.uint16le(), bottom: r.uint16le() };
}

function readPoint(r: BinaryReader): EgfxPoint {
  return { x: r.int16le(), y: r.int16le() };
}

function readColor(r: BinaryReader): EgfxColor {
  return { b: r.uint8(), g: r.uint8(), r: r.uint8(), a: r.uint8() };
}

/**
 * Laengenangaben im PDU stammen vom Server und koennen luegen. Ohne diese
 * Pruefung wuerde der BinaryReader einen RangeError werfen, den der Aufrufer
 * nicht als Protokollfehler erkennt.
 */
function ensure(r: BinaryReader, bytes: number, was: string): void {
  if (r.remaining < bytes) {
    throw new RdpProtocolError(`EGFX: ${was} verlangt ${bytes} Byte, es sind nur ${r.remaining} da`);
  }
}

function readRects(r: BinaryReader, anzahl: number): EgfxRect[] {
  ensure(r, anzahl * 8, `${anzahl} Rechtecke`);
  const rects: EgfxRect[] = [];
  for (let i = 0; i < anzahl; i++) rects.push(readRect(r));
  return rects;
}

function readPoints(r: BinaryReader, anzahl: number): EgfxPoint[] {
  ensure(r, anzahl * 4, `${anzahl} Zielpunkte`);
  const pts: EgfxPoint[] = [];
  for (let i = 0; i < anzahl; i++) pts.push(readPoint(r));
  return pts;
}

function readCapsSet(r: BinaryReader): Required<EgfxCapsSet> {
  ensure(r, 8, 'RDPGFX_CAPSET');
  const version = r.uint32le();
  const laenge = r.uint32le();
  ensure(r, laenge, `capsData (Version 0x${version.toString(16)})`);
  const capsData = r.bytes(laenge);
  // Nur Versionen mit 4-Byte-Datenteil tragen ueberhaupt ein Flagsfeld.
  const flags = laenge >= 4 ? capsData.readUInt32LE(0) : 0;
  return { version, flags, capsData };
}

export function parseEgfxHeader(r: BinaryReader): EgfxHeader {
  ensure(r, EGFX_HEADER_SIZE, 'RDPGFX_HEADER');
  return { cmdId: r.uint16le(), flags: r.uint16le(), pduLength: r.uint32le() };
}

function parseBody(header: EgfxHeader, r: BinaryReader, raw: Buffer): EgfxPdu {
  switch (header.cmdId) {
    case RDPGFX_CMDID_WIRETOSURFACE_1: {
      ensure(r, 17, 'RDPGFX_WIRE_TO_SURFACE_PDU_1');
      const surfaceId = r.uint16le();
      const codecId = r.uint16le();
      const pixelFormat = r.uint8();
      const destRect = readRect(r);
      const laenge = r.uint32le();
      ensure(r, laenge, 'bitmapData');
      return { cmdId: RDPGFX_CMDID_WIRETOSURFACE_1, surfaceId, codecId, pixelFormat, destRect, bitmapData: r.bytes(laenge) };
    }
    case RDPGFX_CMDID_WIRETOSURFACE_2: {
      ensure(r, 13, 'RDPGFX_WIRE_TO_SURFACE_PDU_2');
      const surfaceId = r.uint16le();
      const codecId = r.uint16le();
      const codecContextId = r.uint32le();
      const pixelFormat = r.uint8();
      const laenge = r.uint32le();
      ensure(r, laenge, 'bitmapData');
      return { cmdId: RDPGFX_CMDID_WIRETOSURFACE_2, surfaceId, codecId, codecContextId, pixelFormat, bitmapData: r.bytes(laenge) };
    }
    case RDPGFX_CMDID_DELETEENCODINGCONTEXT: {
      ensure(r, 6, 'RDPGFX_DELETE_ENCODING_CONTEXT_PDU');
      return { cmdId: RDPGFX_CMDID_DELETEENCODINGCONTEXT, surfaceId: r.uint16le(), codecContextId: r.uint32le() };
    }
    case RDPGFX_CMDID_SOLIDFILL: {
      ensure(r, 8, 'RDPGFX_SOLIDFILL_PDU');
      const surfaceId = r.uint16le();
      const fillPixel = readColor(r);
      const anzahl = r.uint16le();
      return { cmdId: RDPGFX_CMDID_SOLIDFILL, surfaceId, fillPixel, fillRects: readRects(r, anzahl) };
    }
    case RDPGFX_CMDID_SURFACETOSURFACE: {
      ensure(r, 14, 'RDPGFX_SURFACE_TO_SURFACE_PDU');
      const surfaceIdSrc = r.uint16le();
      const surfaceIdDest = r.uint16le();
      const rectSrc = readRect(r);
      const anzahl = r.uint16le();
      return { cmdId: RDPGFX_CMDID_SURFACETOSURFACE, surfaceIdSrc, surfaceIdDest, rectSrc, destPts: readPoints(r, anzahl) };
    }
    case RDPGFX_CMDID_SURFACETOCACHE: {
      ensure(r, 20, 'RDPGFX_SURFACE_TO_CACHE_PDU');
      const surfaceId = r.uint16le();
      const cacheKey = r.bytes(8).readBigUInt64LE(0);
      const cacheSlot = r.uint16le();
      return { cmdId: RDPGFX_CMDID_SURFACETOCACHE, surfaceId, cacheKey, cacheSlot, rectSrc: readRect(r) };
    }
    case RDPGFX_CMDID_CACHETOSURFACE: {
      ensure(r, 6, 'RDPGFX_CACHE_TO_SURFACE_PDU');
      const cacheSlot = r.uint16le();
      const surfaceId = r.uint16le();
      const anzahl = r.uint16le();
      return { cmdId: RDPGFX_CMDID_CACHETOSURFACE, cacheSlot, surfaceId, destPts: readPoints(r, anzahl) };
    }
    case RDPGFX_CMDID_EVICTCACHEENTRY: {
      ensure(r, 2, 'RDPGFX_EVICT_CACHE_ENTRY_PDU');
      return { cmdId: RDPGFX_CMDID_EVICTCACHEENTRY, cacheSlot: r.uint16le() };
    }
    case RDPGFX_CMDID_CREATESURFACE: {
      ensure(r, 7, 'RDPGFX_CREATE_SURFACE_PDU');
      return {
        cmdId: RDPGFX_CMDID_CREATESURFACE,
        surfaceId: r.uint16le(),
        width: r.uint16le(),
        height: r.uint16le(),
        pixelFormat: r.uint8(),
      };
    }
    case RDPGFX_CMDID_DELETESURFACE: {
      ensure(r, 2, 'RDPGFX_DELETE_SURFACE_PDU');
      return { cmdId: RDPGFX_CMDID_DELETESURFACE, surfaceId: r.uint16le() };
    }
    case RDPGFX_CMDID_STARTFRAME: {
      ensure(r, 8, 'RDPGFX_START_FRAME_PDU');
      return { cmdId: RDPGFX_CMDID_STARTFRAME, timestamp: r.uint32le(), frameId: r.uint32le() };
    }
    case RDPGFX_CMDID_ENDFRAME: {
      ensure(r, 4, 'RDPGFX_END_FRAME_PDU');
      return { cmdId: RDPGFX_CMDID_ENDFRAME, frameId: r.uint32le() };
    }
    case RDPGFX_CMDID_RESETGRAPHICS: {
      ensure(r, 12, 'RDPGFX_RESET_GRAPHICS_PDU');
      const width = r.uint32le();
      const height = r.uint32le();
      const anzahl = r.uint32le();
      if (anzahl > 16) throw new RdpProtocolError(`EGFX: RESETGRAPHICS nennt ${anzahl} Monitore, erlaubt sind 16`);
      ensure(r, anzahl * 20, `${anzahl} Monitordefinitionen`);
      const monitors: EgfxMonitor[] = [];
      for (let i = 0; i < anzahl; i++) {
        monitors.push({
          left: r.int32le(),
          top: r.int32le(),
          right: r.int32le(),
          bottom: r.int32le(),
          flags: r.uint32le(),
        });
      }
      // Der Rest ist Padding auf die vorgeschriebenen 340 Byte und wird ignoriert.
      return { cmdId: RDPGFX_CMDID_RESETGRAPHICS, width, height, monitors };
    }
    case RDPGFX_CMDID_MAPSURFACETOOUTPUT: {
      ensure(r, 12, 'RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU');
      const surfaceId = r.uint16le();
      r.skip(2); // reserved
      return { cmdId: RDPGFX_CMDID_MAPSURFACETOOUTPUT, surfaceId, outputOriginX: r.uint32le(), outputOriginY: r.uint32le() };
    }
    case RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT: {
      ensure(r, 20, 'RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU');
      const surfaceId = r.uint16le();
      r.skip(2); // reserved
      return {
        cmdId: RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT,
        surfaceId,
        outputOriginX: r.uint32le(),
        outputOriginY: r.uint32le(),
        targetWidth: r.uint32le(),
        targetHeight: r.uint32le(),
      };
    }
    case RDPGFX_CMDID_CACHEIMPORTREPLY: {
      ensure(r, 2, 'RDPGFX_CACHE_IMPORT_REPLY_PDU');
      const anzahl = r.uint16le();
      ensure(r, anzahl * 2, `${anzahl} Cache-Slots`);
      const cacheSlots: number[] = [];
      for (let i = 0; i < anzahl; i++) cacheSlots.push(r.uint16le());
      return { cmdId: RDPGFX_CMDID_CACHEIMPORTREPLY, cacheSlots };
    }
    case RDPGFX_CMDID_CAPSCONFIRM: {
      return { cmdId: RDPGFX_CMDID_CAPSCONFIRM, capsSet: readCapsSet(r) };
    }
    default:
      return { cmdId: header.cmdId, raw };
  }
}

/**
 * Zerlegt einen (bereits ZGFX-dekomprimierten) Datenstrom in einzelne PDUs.
 * Der Strom muss vollstaendig sein: ein angeschnittenes PDU ist ein Fehler und
 * kein Grund zum Warten, denn die Reassemblierung passiert eine Schicht
 * tiefer im DVC.
 */
export function parseEgfxPdus(data: Buffer): EgfxPdu[] {
  const pdus: EgfxPdu[] = [];
  const r = new BinaryReader(data);
  while (r.remaining > 0) {
    if (r.remaining < EGFX_HEADER_SIZE) {
      throw new RdpProtocolError(`EGFX: abgeschnittener Kopf, nur noch ${r.remaining} Byte im Strom`);
    }
    const start = r.offset;
    const header = parseEgfxHeader(r);
    if (header.pduLength < EGFX_HEADER_SIZE) {
      throw new RdpProtocolError(`EGFX: pduLength ${header.pduLength} ist kleiner als der Kopf`);
    }
    if (start + header.pduLength > data.length) {
      throw new RdpProtocolError(
        `EGFX: abgeschnittenes PDU 0x${header.cmdId.toString(16)}: ${header.pduLength} Byte angekuendigt, ${data.length - start} vorhanden`,
      );
    }
    const ende = start + header.pduLength;
    pdus.push(parseBody(header, new BinaryReader(data.subarray(start + EGFX_HEADER_SIZE, ende)), data.subarray(start, ende)));
    // Absichtlich am pduLength entlang und nicht an der gelesenen Position:
    // unbekannte Felder am Ende eines PDU duerfen den Strom nicht verschieben.
    r.offset = ende;
  }
  return pdus;
}

// --- Schreibrichtung (Client -> Server) -------------------------------------

/** Setzt den RDPGFX_HEADER vor den Rumpf; pduLength zaehlt den Kopf mit. */
function buildEgfxPdu(cmdId: number, body: Buffer): Buffer {
  return writer()
    .uint16le(cmdId)
    .uint16le(0) // flags: laut 2.2.1.5 ohne Ausnahme null
    .uint32le(EGFX_HEADER_SIZE + body.length)
    .bytes(body)
    .toBuffer();
}

function capsData(set: EgfxCapsSet): Buffer {
  if (set.capsData) return set.capsData;
  // V10.1 ist die Ausnahme: 16 reservierte Nullbytes statt eines Flagsfelds (2.2.3.4).
  if (set.version === RDPGFX_CAPVERSION_101) return Buffer.alloc(16);
  return writer().uint32le(set.flags ?? 0).toBuffer();
}

/**
 * RDPGFX_CAPS_ADVERTISE_PDU (2.2.2.18). Der Server sucht sich daraus genau ein
 * Set aus und bestaetigt es mit CAPSCONFIRM, deshalb bietet der Aufrufer
 * sinnvollerweise mehrere Versionen an.
 */
export function buildCapsAdvertise(versions: EgfxCapsSet[]): Buffer {
  const body = writer().uint16le(versions.length);
  for (const set of versions) {
    const daten = capsData(set);
    body.uint32le(set.version).uint32le(daten.length).bytes(daten);
  }
  return buildEgfxPdu(RDPGFX_CMDID_CAPSADVERTISE, body.toBuffer());
}

/**
 * RDPGFX_FRAME_ACKNOWLEDGE_PDU (2.2.2.13). Achtung: auf dem Draht steht
 * queueDepth vor frameId, die Argumentreihenfolge hier ist eine andere.
 */
export function buildFrameAcknowledge(frameId: number, queueDepth: number, framesDecoded: number): Buffer {
  const body = writer().uint32le(queueDepth).uint32le(frameId).uint32le(framesDecoded);
  return buildEgfxPdu(RDPGFX_CMDID_FRAMEACKNOWLEDGE, body.toBuffer());
}

/**
 * Leeres RDPGFX_CACHE_IMPORT_OFFER_PDU (2.2.2.16). Wir fuehren keinen
 * persistenten Bitmap-Cache ueber Sitzungen hinweg, muessen den Server aber
 * darueber informieren, sonst wartet er auf das Angebot.
 */
export function buildCacheImportOffer(): Buffer {
  return buildEgfxPdu(RDPGFX_CMDID_CACHEIMPORTOFFER, writer().uint16le(0).toBuffer());
}
