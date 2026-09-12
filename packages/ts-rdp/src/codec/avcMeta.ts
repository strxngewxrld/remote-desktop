/**
 * H.264-Rahmenstrukturen der Graphics Pipeline (MS-RDPEGFX 2.2.4.4 bis 2.2.4.6).
 *
 * Diese Datei ist *kein* H.264-Decoder. Sie zerlegt nur die Huelle, die der
 * Server um die eigentlichen Bitstreams legt, damit der Aufrufer die rohen
 * Annex-B-Daten an WebCodecs weiterreichen kann. Alles ab dem ersten
 * NAL-Startcode bleibt unangetastet.
 *
 * Der Weg der Daten: RDPGFX_WIRE_TO_SURFACE_PDU_1 (2.2.2.1) mit codecId
 * RDPGFX_CODECID_AVC420 (0x000B) traegt im Feld bitmapData einen
 * RFX_AVC420_BITMAP_STREAM, bei AVC444 (0x000E) bzw. AVC444V2 (0x000F) einen
 * RFX_AVC444_BITMAP_STREAM bzw. RFX_AVC444V2_BITMAP_STREAM.
 *
 * Achtung bei der Abschnittsnumerierung: die AVC-Strukturen liegen in der
 * aktuellen Fassung des Dokuments unter 2.2.4.4 (RFX_AVC420_BITMAP_STREAM),
 * 2.2.4.4.1 (RFX_AVC420_METABLOCK), 2.2.4.4.2 (RDPGFX_AVC420_QUANT_QUALITY),
 * 2.2.4.5 (RFX_AVC444_BITMAP_STREAM) und 2.2.4.6 (RFX_AVC444V2_BITMAP_STREAM).
 * Aeltere Notizen, die den METABLOCK unter 2.2.4.4 fuehren, sind veraltet.
 *
 * Zur Leserichtung der Bitmaskendiagramme: das Diagramm laeuft von links nach
 * rechts vom niederwertigsten zum hoechstwertigen Bit. Belegt wird das im
 * selben Dokument durch 2.2.4.5: dort steht cbAvc420EncodedBitstream1 (30 Bit)
 * links und LC (2 Bit) rechts, und LC sind die *oberen* zwei Bits des
 * 32-Bit-Werts. Dieselbe Leserichtung gilt fuer qpVal in 2.2.4.4.2.
 */
import { BinaryReader } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';

/** RDPGFX_AVC420_QUANT_QUALITY (2.2.4.4.2): qpVal + qualityVal, zusammen 2 Byte. */
export const AVC420_QUANT_QUALITY_SIZE = 2;

/** RDPGFX_RECT16 (2.2.1.2): vier UINT16. */
const RECT16_SIZE = 8;

/** Je Region ein Rechteck *und* ein Quant-Quality-Paar (2.2.4.4.1). */
const BYTES_PRO_REGION = RECT16_SIZE + AVC420_QUANT_QUALITY_SIZE;

// --- LC-Werte aus 2.2.4.5 / 2.2.4.6 -----------------------------------------

/** Bitstream 1 traegt den YUV420-Rahmen, Bitstream 2 den Chroma420-Rahmen. */
export const AVC444_LC_YUV420_UND_CHROMA420 = 0x0;
/** Nur Bitstream 1 mit dem YUV420-Rahmen; Chroma folgt ggf. in spaeteren Rahmen. */
export const AVC444_LC_NUR_YUV420 = 0x1;
/** Nur Bitstream 1, darin aber der *Chroma420*-Rahmen; kein YUV420-Rahmen. */
export const AVC444_LC_NUR_CHROMA420 = 0x2;
/** 0x3 ist laut Spezifikation ein ungueltiger Zustand ("MUST NOT occur"). */
export const AVC444_LC_UNGUELTIG = 0x3;

// --- Ergebnisstrukturen -----------------------------------------------------

/** RDPGFX_RECT16 (2.2.1.2): rechte und untere Kante liegen *ausserhalb*. */
export interface AvcRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Ein Eintrag des METABLOCK: Rechteck aus regionRects samt dem zugehoerigen
 * Eintrag aus quantQualityVals. Beide Felder sind laut 2.2.4.4.1 gleich lang,
 * deshalb werden sie hier zu einem Objekt zusammengezogen.
 */
export interface AvcRegion {
  rect: AvcRect;
  /** qp-Bitfeld, 6 Bit (2.2.4.4.2). */
  qp: number;
  /** qualityVal, laut Spezifikation 0 bis 100. */
  quality: number;
  /** p-Bit: die Region ist progressiv kodiert (2.2.4.4.2). */
  progressive: boolean;
}

/** RFX_AVC420_BITMAP_STREAM (2.2.4.4). */
export interface Avc420Stream {
  /** Die Regionsmaske aus dem METABLOCK, in Stromreihenfolge. */
  regions: AvcRegion[];
  /** avc420EncodedBitstream: H.264 im Byte-Stream-Format nach Annex B. */
  bitstream: Buffer;
}

/**
 * RFX_AVC444_BITMAP_STREAM (2.2.4.5) bzw. RFX_AVC444V2_BITMAP_STREAM (2.2.4.6).
 *
 * `luma` und `chroma` sind bewusst optional: welcher der beiden Teilrahmen
 * ueberhaupt vorhanden ist, entscheidet allein LC.
 */
export interface Avc444Stream {
  /** Rohwert des LC-Felds, damit der Aufrufer die Kombination steuern kann. */
  lc: number;
  /** YUV420-Teilrahmen, fehlt bei LC = 0x2. */
  luma?: Avc420Stream;
  /** Chroma420-Teilrahmen, fehlt bei LC = 0x1. */
  chroma?: Avc420Stream;
}

// --- Lesehilfen -------------------------------------------------------------

/**
 * Die Laengenangaben stammen vom Server und koennen luegen. Ohne diese Pruefung
 * wuerde der BinaryReader einen RangeError werfen, den der Aufrufer nicht als
 * Protokollfehler erkennt.
 */
function ensure(r: BinaryReader, bytes: number, was: string): void {
  if (r.remaining < bytes) {
    throw new RdpProtocolError(`AVC420: ${was} verlangt ${bytes} Byte, es sind nur ${r.remaining} da`);
  }
}

/**
 * RFX_AVC420_METABLOCK (2.2.4.4.1). Erst alle Rechtecke, *dann* alle
 * Quant-Quality-Paare - die beiden Arrays sind nicht verschraenkt.
 */
function parseMetablock(r: BinaryReader): AvcRegion[] {
  ensure(r, 4, 'numRegionRects');
  const anzahl = r.uint32le();

  // numRegionRects ist ein UINT32 und damit bis zu 4 Milliarden gross. Die
  // Schranke vor der Schleife verhindert, dass eine erfundene Anzahl erst nach
  // dem Anlegen eines riesigen Arrays auffliegt.
  if (anzahl * BYTES_PRO_REGION > r.remaining) {
    throw new RdpProtocolError(
      `AVC420: numRegionRects = ${anzahl} verlangt ${anzahl * BYTES_PRO_REGION} Byte ` +
        `fuer regionRects und quantQualityVals, der METABLOCK hat aber nur noch ${r.remaining}`,
    );
  }

  const rects: AvcRect[] = [];
  for (let i = 0; i < anzahl; i++) {
    rects.push({ left: r.uint16le(), top: r.uint16le(), right: r.uint16le(), bottom: r.uint16le() });
  }

  const regions: AvcRegion[] = [];
  for (let i = 0; i < anzahl; i++) {
    // qpVal (2.2.4.4.2): qp in Bit 0-5, r (reserviert) in Bit 6, p in Bit 7.
    const qpVal = r.uint8();
    regions.push({
      rect: rects[i],
      qp: qpVal & 0x3f,
      progressive: (qpVal & 0x80) !== 0,
      quality: r.uint8(),
    });
    // Bit 6 ist reserviert und wird laut Spezifikation nicht ausgewertet.
  }
  return regions;
}

// --- Oeffentliche Parser ----------------------------------------------------

/**
 * RFX_AVC420_BITMAP_STREAM (2.2.4.4): METABLOCK, danach der komplette Rest der
 * Nutzlast als H.264-Bitstream. Eine Laengenangabe fuer den Bitstream gibt es
 * nicht, seine Grenze ist das Ende des uebergebenen Puffers.
 */
export function parseAvc420(data: Buffer): Avc420Stream {
  const r = new BinaryReader(data);
  const regions = parseMetablock(r);
  const bitstream = r.rest();
  // Ein Rahmen ohne Bitstream ist kein gueltiger Rahmen. Ohne diese Pruefung
  // wanderte ein leerer Puffer bis in den Decoder und der Fehler tauchte weit
  // weg von seiner Ursache wieder auf.
  if (bitstream.length === 0) {
    throw new RdpProtocolError('AVC420: avc420EncodedBitstream ist leer, der METABLOCK fuellt die ganze Nutzlast');
  }
  return { regions, bitstream };
}

/**
 * RFX_AVC444_BITMAP_STREAM (2.2.4.5). Der Kopf ist ein einziges UINT32:
 * cbAvc420EncodedBitstream1 in Bit 0-29, LC in Bit 30-31.
 *
 * cbAvc420EncodedBitstream1 zaehlt nur den *YUV420*-Rahmen. Nur bei LC = 0x0
 * steht daher wirklich eine Trennstelle zwischen zwei Teilrahmen darin; in den
 * beiden anderen Faellen gibt es nur einen Teilrahmen, der bis zum Ende der
 * Nutzlast reicht (bei LC = 0x2 muss das Feld laut Spezifikation sogar null
 * sein, weil gar kein YUV420-Rahmen vorhanden ist).
 *
 * RFX_AVC444V2_BITMAP_STREAM (2.2.4.6) hat exakt dasselbe Drahtformat - laut
 * 2.2.4.6 unterscheidet sich nur das Verfahren, mit dem die beiden Teilrahmen
 * hinterher zusammengefuehrt werden. Derselbe Parser passt also fuer beide.
 */
export function parseAvc444(data: Buffer): Avc444Stream {
  if (data.length < 4) {
    throw new RdpProtocolError(
      `AVC444: avc420EncodedBitstreamInfo verlangt 4 Byte, es sind nur ${data.length} da`,
    );
  }
  const info = data.readUInt32LE(0);
  const cb = info & 0x3fffffff;
  const lc = info >>> 30;
  const rumpf = data.subarray(4);

  if (lc === AVC444_LC_UNGUELTIG) {
    throw new RdpProtocolError('AVC444: LC = 0x3 ist laut MS-RDPEGFX 2.2.4.5 ein ungueltiger Zustand');
  }

  if (lc === AVC444_LC_YUV420_UND_CHROMA420) {
    if (cb > rumpf.length) {
      throw new RdpProtocolError(
        `AVC444: cbAvc420EncodedBitstream1 = ${cb}, nach dem Kopf sind aber nur ${rumpf.length} Byte da`,
      );
    }
    return {
      lc,
      luma: parseAvc420(rumpf.subarray(0, cb)),
      chroma: parseAvc420(rumpf.subarray(cb)),
    };
  }

  // LC = 0x1 und LC = 0x2: ein einziger Teilrahmen, der den Rest fuellt. Eine
  // von null verschiedene Laengenangabe, die nicht dazu passt, ist ein
  // Widerspruch im PDU und wird gemeldet statt stillschweigend uebergangen -
  // sie deutet auf eine abgeschnittene Nutzlast hin.
  if (cb !== 0 && cb !== rumpf.length) {
    throw new RdpProtocolError(
      `AVC444: LC = 0x${lc.toString(16)} laesst nur einen Teilrahmen zu, ` +
        `cbAvc420EncodedBitstream1 = ${cb} widerspricht aber den ${rumpf.length} Byte nach dem Kopf`,
    );
  }
  const einziger = parseAvc420(rumpf);
  return lc === AVC444_LC_NUR_YUV420 ? { lc, luma: einziger } : { lc, chroma: einziger };
}

/**
 * RFX_AVC444V2_BITMAP_STREAM (2.2.4.6) - gleiches Drahtformat wie 2.2.4.5, nur
 * ein anderes Kombinationsverfahren (3.3.8.3.3 statt 3.3.8.3.2). Als eigener
 * Name exportiert, damit an der Aufrufstelle sichtbar bleibt, welche codecId
 * gemeint war.
 */
export const parseAvc444V2 = parseAvc444;
