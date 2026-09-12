/**
 * Vorbereitung eines H.264-Teilbildes fuer einen fremden Decoder.
 *
 * Auch diese Datei dekodiert nichts. Sie beantwortet die drei Fragen, die ein
 * WebCodecs-`VideoDecoder` beantwortet haben will, bevor man ihm den ersten
 * Happen gibt - und die sich alle allein aus dem Annex-B-Bytestrom beantworten
 * lassen, ohne ein einziges Makroblock zu dekodieren:
 *
 *   1. Wie heisst der Codec? (`avc1.PPCCLL`, gebildet aus dem SPS)
 *   2. Ist dieser Happen ein Schluesselbild (`key`) oder ein Folgebild (`delta`)?
 *   3. Sind die Parametersaetze (SPS und PPS) schon vorbeigekommen?
 *
 * Warum hier und nicht drueben im Webview: dort laeuft der Decoder, aber dort
 * laeuft kein Test. Die Analyse ist reine Byteschieberei, also gehoert sie auf
 * die Seite, die unter `node:test` pruefbar ist. Das Webview bekommt nur noch
 * das Ergebnis und muss es nicht noch einmal selbst herleiten.
 *
 * Belege:
 * - Annex-B-Bytestromformat und NAL-Kopf: [ITU-H.264] Annex B bzw. 7.3.1.
 *   MS-RDPEGFX 2.2.4.4 verlangt ausdruecklich dieses Format fuer
 *   avc420EncodedBitstream.
 * - Die Zuordnung `avc1.PPCCLL` stammt aus RFC 6381 Abschnitt 3.3: auf "avc1."
 *   folgen profile_idc, das Byte mit den constraint_set-Flags und level_idc,
 *   jeweils zweistellig hexadezimal.
 * - Dass regionRects das dekodierte Bild beschneiden und nicht verschieben,
 *   steht in MS-RDPEGFX 2.2.4.4: "the width and height of the MPEG-4 AVC/H.264
 *   codec bitstream MUST be aligned to a multiple of 16 and MUST be cropped by
 *   the region mask specified in the regionRects field".
 */
import { AvcRegion } from './avcMeta.js';

// --- NAL-Einheitstypen ([ITU-H.264] Tabelle 7-1) ----------------------------

/** Coded slice of a non-IDR picture - ein Folgebild. */
export const NAL_SLICE_NICHT_IDR = 1;
/** Coded slice of an IDR picture - ein Schluesselbild. */
export const NAL_SLICE_IDR = 5;
/** Sequence parameter set. */
export const NAL_SPS = 7;
/** Picture parameter set. */
export const NAL_PPS = 8;

/** Ergebnis der Bitstromanalyse. */
export interface AvcBitstromAnalyse {
  /** Die NAL-Typen in Stromreihenfolge. Vor allem zur Fehlersuche. */
  nalTypen: number[];
  /**
   * Enthaelt der Happen eine IDR-Scheibe? Nur dann darf er bei WebCodecs als
   * `type: 'key'` durchgehen.
   *
   * Ein SPS allein reicht ausdruecklich nicht: WebCodecs verlangt, dass ein
   * Schluesselbild fuer sich allein dekodierbar ist, und ein Parametersatz
   * ohne Scheibe ergibt kein Bild.
   */
  schluesselbild: boolean;
  /** Sind sowohl SPS als auch PPS in diesem Happen enthalten? */
  hatParametersaetze: boolean;
  /**
   * `avc1.PPCCLL`, sofern ein auswertbares SPS dabei war. Fehlt es, kennt der
   * Aufrufer den Codecnamen noch nicht und darf noch nicht konfigurieren.
   */
  codecString?: string;
}

// --- Annex B ----------------------------------------------------------------

/**
 * Laeuft die Startcodes des Bytestroms ab und liefert zu jedem die Position des
 * darauffolgenden NAL-Kopfbytes.
 *
 * Startcode ist nach [ITU-H.264] Annex B entweder 0x00 0x00 0x01 oder
 * 0x00 0x00 0x00 0x01. Die kurze Form ist in der langen enthalten, deshalb
 * genuegt es, auf 0x00 0x00 0x01 zu suchen - das fuehrende Nullbyte der langen
 * Form gehoert dann zum `zero_byte` davor.
 */
function nalAnfaenge(bitstream: Buffer): number[] {
  const anfaenge: number[] = [];
  for (let i = 0; i + 2 < bitstream.length; i++) {
    if (bitstream[i] === 0 && bitstream[i + 1] === 0 && bitstream[i + 2] === 1) {
      const kopf = i + 3;
      if (kopf < bitstream.length) anfaenge.push(kopf);
      i += 2;
    }
  }
  return anfaenge;
}

/**
 * Nimmt die Emulation-Prevention-Bytes wieder heraus ([ITU-H.264] 7.4.1.1):
 * eine Folge 0x00 0x00 0x03 im NAL-Rumpf stand urspruenglich fuer 0x00 0x00.
 *
 * Gebraucht wird das nur fuer die ersten Bytes des SPS. Theoretisch koennte
 * schon dort ein 0x03 stehen (bei profile_idc 0 und leeren constraint-Flags);
 * praktisch nie, aber ein Sonderfall, der irgendwann doch eintritt, ist genau
 * die Sorte Fehler, die man hinterher nicht findet.
 */
function entferneEmulationsbytes(rumpf: Buffer, hoechstens: number): number[] {
  const raus: number[] = [];
  let nullen = 0;
  for (let i = 0; i < rumpf.length && raus.length < hoechstens; i++) {
    const b = rumpf[i];
    if (nullen >= 2 && b === 0x03) {
      nullen = 0;
      continue;
    }
    raus.push(b);
    nullen = b === 0 ? nullen + 1 : 0;
  }
  return raus;
}

function hex2(wert: number): string {
  return wert.toString(16).padStart(2, '0');
}

/**
 * Bildet den Codecnamen aus den ersten drei Bytes des SPS-Rumpfs.
 *
 * Nach [ITU-H.264] 7.3.2.1 beginnt seq_parameter_set_data mit profile_idc (8
 * Bit), den constraint_set-Flags samt reserved_zero_2bits (zusammen 8 Bit) und
 * level_idc (8 Bit) - drei ganze Bytes, noch vor dem ersten
 * Exp-Golomb-kodierten Feld. Genau diese drei Bytes verlangt RFC 6381 3.3.
 */
export function codecStringAusSps(spsRumpf: Buffer): string | undefined {
  const bytes = entferneEmulationsbytes(spsRumpf, 3);
  if (bytes.length < 3) return undefined;
  return `avc1.${hex2(bytes[0])}${hex2(bytes[1])}${hex2(bytes[2])}`;
}

/**
 * Zerlegt einen Annex-B-Strom so weit, wie der Decoder es wissen muss.
 *
 * Der Bitstream selbst bleibt unangetastet - er wird spaeter Byte fuer Byte so
 * an den Decoder gereicht, wie er vom Draht kam. Deshalb gibt es hier auch
 * keine `description`: die gehoert zum AVCC-Format mit Laengenpraefixen, und
 * wer sie bei Annex-B-Daten setzt, bekommt von WebCodecs stumme Fehler oder
 * ein grau flackerndes Bild.
 */
export function analysiereBitstrom(bitstream: Buffer): AvcBitstromAnalyse {
  const anfaenge = nalAnfaenge(bitstream);
  const nalTypen: number[] = [];
  let schluesselbild = false;
  let hatSps = false;
  let hatPps = false;
  let codecString: string | undefined;

  for (let i = 0; i < anfaenge.length; i++) {
    const kopf = anfaenge[i];
    const typ = bitstream[kopf] & 0x1f;
    nalTypen.push(typ);
    if (typ === NAL_SLICE_IDR) schluesselbild = true;
    if (typ === NAL_PPS) hatPps = true;
    if (typ === NAL_SPS) {
      hatSps = true;
      // Der Rumpf endet dort, wo der naechste Startcode beginnt. Ein paar
      // Nullbytes zuviel am Ende schaden nicht, es werden nur drei gelesen.
      const ende = i + 1 < anfaenge.length ? anfaenge[i + 1] : bitstream.length;
      codecString = codecString ?? codecStringAusSps(bitstream.subarray(kopf + 1, ende));
    }
  }

  return { nalTypen, schluesselbild, hatParametersaetze: hatSps && hatPps, codecString };
}

// --- Regionen ---------------------------------------------------------------

/**
 * Ein zu zeichnender Ausschnitt: wo er im dekodierten Bild liegt und wo er auf
 * dem Bildschirm hingehoert.
 *
 * Quelle und Ziel unterscheiden sich nur um den Ursprung, an dem die Surface
 * auf den Ausgabebereich abgebildet ist. Das dekodierte Bild liegt am
 * Surface-Ursprung, nicht am destRect: destRect ist bei AVC laut MS-RDPEGFX
 * 2.2.2.1 ausdruecklich nur ein umschliessendes Rechteck ("This field specifies
 * a bounding rectangle if the codecId field contains ... AVC420 ...") und damit
 * kein Versatz. Was wirklich gezeichnet wird, sagen die regionRects.
 */
export interface AvcZeichenbereich {
  /** Quelle im dekodierten Bild, in Surface-Koordinaten. */
  sx: number;
  sy: number;
  breite: number;
  hoehe: number;
  /** Ziel auf dem Bildschirm. */
  zx: number;
  zy: number;
}

/** Lage und Groesse der Ziel-Surface, so weit der Renderer sie braucht. */
export interface AvcSurfaceLage {
  width: number;
  height: number;
  /** Ursprung auf dem Bildschirm; fehlt, solange die Surface nicht abgebildet ist. */
  outputX: number;
  outputY: number;
}

/**
 * Beschneidet die Regionen an den Surface-Grenzen und rechnet sie auf
 * Bildschirmkoordinaten um.
 *
 * Beschnitten wird, weil der Server ein an 16 ausgerichtetes Bild schickt und
 * die letzte Region bis in diesen Ueberhang hineinragen kann. Regionen, von
 * denen nichts uebrig bleibt, fallen heraus - sonst landet spaeter ein
 * `drawImage` mit Breite 0 im Renderer, und der wirft.
 */
export function avcZeichenbereiche(
  regionen: readonly AvcRegion[],
  surface: AvcSurfaceLage,
): AvcZeichenbereich[] {
  const raus: AvcZeichenbereich[] = [];
  for (const region of regionen) {
    const left = Math.max(0, region.rect.left);
    const top = Math.max(0, region.rect.top);
    const right = Math.min(surface.width, region.rect.right);
    const bottom = Math.min(surface.height, region.rect.bottom);
    const breite = right - left;
    const hoehe = bottom - top;
    if (breite <= 0 || hoehe <= 0) continue;
    raus.push({
      sx: left,
      sy: top,
      breite,
      hoehe,
      zx: surface.outputX + left,
      zy: surface.outputY + top,
    });
  }
  return raus;
}
