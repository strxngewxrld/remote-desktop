/**
 * RemoteFX Progressive Codec (MS-RDPEGFX 2.2.4.2 und 3.3.8.2) -
 * RDPGFX_CODECID_CAPROGRESSIVE 0x0009.
 *
 * Der Codec ist eine Erweiterung des RemoteFX-Codecs (MS-RDPRFX): dieselbe
 * Kette aus Farbraumwechsel, dreistufiger Wavelettransformation,
 * Quantisierung, Linearisierung und RLGR-Entropiekodierung, ergaenzt um zwei
 * Dinge, die den Decoder zwingend zustandsbehaftet machen (3.1.8.1):
 *
 *   - Teilbanddifferenz ("sub-band diffing", 3.1.8.1.2): eine Kachel mit
 *     RFX_TILE_DIFFERENCE traegt nur die Differenz zu den Koeffizienten, die
 *     der Decoder bereits haelt. Ohne den alten Stand ist sie wertlos.
 *   - Progressive Uebertragung (3.1.8.1.3, 3.2.8.1.5): eine Kachel kommt in
 *     mehreren Stufen. WBT_TILE_FIRST liefert grob quantisierte Koeffizienten,
 *     jedes folgende WBT_TILE_UPGRADE schiebt weitere Bits von unten nach.
 *
 * Der Zustand haengt deshalb an der surfaceId und darin an der Kachelposition
 * (3.3.1.2 "Progressive Tile Contexts", 3.3.1.3 "Sub-Band Diffing Tile
 * Contexts"). Eine Nachricht enthaelt beliebig viele Kacheln mit eigenen
 * Koordinaten; RDPGFX_WIRE_TO_SURFACE_PDU_2 traegt selbst kein Zielrechteck.
 * decode() liefert darum verortete Kacheln.
 *
 * Zahlen, die hier nicht aus der Erinnerung, sondern aus der Spezifikation und
 * aus den durchgerechneten Beispielen stammen - jede einzelne davon war eine
 * Gelegenheit, sich um ein Bit zu vertun:
 *
 *   - Die Linearisierung laeuft HL1, LH1, HH1, HL2, LH2, HH2, HL3, LH3, HH3,
 *     LL3 (MS-RDPRFX 3.1.8.1.6). LL3 steht *hinten*, nicht vorn.
 *   - RFX_COMPONENT_CODEC_QUANT (2.2.4.2.1.5.2) zaehlt die Baender dagegen in
 *     der Reihenfolge LL3, HL3, LH3, HH3, HL2, LH2, HH2, HL1, LH1, HH1 - die
 *     Spezifikation weist ausdruecklich darauf hin, dass sie sich von
 *     TS_RFX_CODEC_QUANT unterscheidet.
 *   - Von den zwei Vierbitfeldern eines Bytes liegt das *erste* im unteren
 *     Nibble. Das steht in keinem Text, folgt aber zwingend aus dem Beispiel in
 *     MS-RDPRFX 4.2.4.1: dort ist das letzte Byte 0x98 und wird als HL1 = 8,
 *     HH1 = 9 aufgeloest.
 *   - Skalierung bei der Dequantisierung: 1 << (Quantisierungsfaktor - 6)
 *     (MS-RDPRFX 3.1.8.1.5, Figure 8). Die zusaetzlichen FIXPUNKT_BITS sind
 *     kein Teil der Formel, sondern die 11.5-Festkommadarstellung, mit der
 *     MS-RDPRFX 4.2.4.3 rechnet und ohne die die inverse DWT Stellen verliert.
 *   - Die inverse DWT benutzt die Gleichungen aus MS-RDPRFX 3.1.8.2.4
 *     (Figure 14): gerade X[2n] = L[n] - floor((H[n-1]+H[n]+1)/2), ungerade
 *     X[2n+1] = 2*H[n] + floor((X[2n]+X[2n+2])/2). Die Waagerechte zuerst,
 *     dann die Senkrechte - die Hintransformation macht es andersherum
 *     (MS-RDPRFX 3.1.8.1.4), und die Abschnittsnamen in 4.2.4.3 bestaetigen
 *     es ("Inverse DWT-X ...", danach "Inverse DWT-Y ...").
 *   - Die Reduce-Extrapolate-Variante (3.2.8.1.2.2) macht die Baender
 *     *ungleich* gross: 33/31 statt 32/32 auf Stufe 1, 17/16, 9/8. Die
 *     Groessen stammen aus der Abbildung "Bands resulting from the
 *     Reduce-Extrapolate DWT Method" und summieren sich wieder auf 4096.
 *   - Farbe: MS-RDPRFX 3.1.8.2.5 gibt [R G B] = [Y Cb Cr] * M an, mit
 *     Level-Shift +128 auf Y. Anders als bei den AYCoCg-Codecs in
 *     planar.ts/clear.ts wird hier *nicht* getauscht, siehe ycbcrNachRgba.
 */
import { RdpProtocolError } from '../core/errors.js';

// --- Blocktypen (2.2.4.2.1) -------------------------------------------------

export const WBT_SYNC = 0xccc0;
export const WBT_FRAME_BEGIN = 0xccc1;
export const WBT_FRAME_END = 0xccc2;
export const WBT_CONTEXT = 0xccc3;
export const WBT_REGION = 0xccc4;
export const WBT_TILE_SIMPLE = 0xccc5;
export const WBT_TILE_PROGRESSIVE_FIRST = 0xccc6;
export const WBT_TILE_PROGRESSIVE_UPGRADE = 0xccc7;

// --- Flags ------------------------------------------------------------------

/** RFX_PROGRESSIVE_CONTEXT (2.2.4.2.1.4): Teilbanddifferenz ist eingeschaltet. */
export const RFX_SUBBAND_DIFFING = 0x01;
/** RFX_PROGRESSIVE_REGION (2.2.4.2.1.5): DWT nach der Reduce-Extrapolate-Methode. */
export const RFX_DWT_REDUCE_EXTRAPOLATE = 0x01;
/** RFX_PROGRESSIVE_TILE_* (2.2.4.2.1.5.3/4): Kachel enthaelt eine Differenz. */
export const RFX_TILE_DIFFERENCE = 0x01;

/** Entropieverfahren (MS-RDPRFX 3.1.8.1.7.1 und 3.1.8.1.7.2). */
export const RLGR1 = 1;
export const RLGR3 = 3;
export type RlgrModus = typeof RLGR1 | typeof RLGR3;

// --- Feste Groessen ---------------------------------------------------------

/** Einzig zulaessige Kachelkante (2.2.4.2.1.4: "MUST be set to 0x0040"). */
const KACHELKANTE = 64;
/** Koeffizienten je Farbkomponente und Kachel (MS-RDPRFX 3.1.8.1.7). */
const KOEFFIZIENTEN = KACHELKANTE * KACHELKANTE;
/** Zehn Teilbaender je Komponente (2.2.4.2.1.5.2). */
const BAENDER = 10;
/** Laenge einer RFX_COMPONENT_CODEC_QUANT auf dem Draht. */
const QUANT_BYTES = 5;
/** Laenge einer RFX_PROGRESSIVE_CODEC_QUANT auf dem Draht (2.2.4.2.1.5.1). */
const PROG_QUANT_BYTES = 1 + 3 * QUANT_BYTES;

/**
 * Zusaetzliche Nachkommabits, mit denen die inverse DWT rechnet.
 *
 * MS-RDPRFX 4.2.4.3 fuehrt alle Zwischenwerte als 11.5-Festkommazahlen, also
 * um fuenf Bit nach links geschoben, und teilt erst bei der Farbumrechnung
 * wieder. Ohne diese fuenf Bit rundet jede der drei DWT-Stufen erneut ab und
 * das Ergebnis driftet sichtbar. Die Dumps der Spezifikation lassen sich nur
 * mit diesem Faktor nachrechnen.
 */
const FIXPUNKT_BITS = 5;
const FIXPUNKT_TEILER = 1 << FIXPUNKT_BITS;

/**
 * Obergrenze fuer die Anzahl der Quantisierungstabellen einer Region
 * (2.2.4.2.1.5: "MUST be in the range 0 to 7").
 */
const MAX_QUANT = 7;

/** Y, Cb, Cr - die drei Komponenten in genau dieser Reihenfolge. */
const KOMPONENTEN = 3;

// --- Teilbandtabelle --------------------------------------------------------

/**
 * Index eines Bandes in RFX_COMPONENT_CODEC_QUANT (2.2.4.2.1.5.2).
 *
 * Diese Reihenfolge ist *nicht* die der Linearisierung; sie gilt nur fuer die
 * Quantisierungstabellen. Die Konstanten stehen hier, damit unten in der
 * Bandtabelle sichtbar bleibt, welcher Quantisierungswert zu welchem Band
 * gehoert.
 */
const QI_LL3 = 0;
const QI_HL3 = 1;
const QI_LH3 = 2;
const QI_HH3 = 3;
const QI_HL2 = 4;
const QI_LH2 = 5;
const QI_HH2 = 6;
const QI_HL1 = 7;
const QI_LH1 = 8;
const QI_HH1 = 9;

interface Teilband {
  /** Name laut Spezifikation, ausschliesslich fuer Fehlermeldungen. */
  readonly name: string;
  /** Index in RFX_COMPONENT_CODEC_QUANT. */
  readonly quant: number;
  /** Versatz im linearisierten 4096-Werte-Block. */
  readonly offset: number;
  readonly breite: number;
  readonly hoehe: number;
}

function band(name: string, quant: number, offset: number, breite: number, hoehe: number): Teilband {
  return { name, quant, offset, breite, hoehe };
}

/**
 * Baender in der Reihenfolge der Linearisierung (MS-RDPRFX 3.1.8.1.6:
 * "HL1, LH1, HH1, HL2, LH2, HH2, HL3, LH3, HH3, and LL3").
 *
 * Diese Reihenfolge bestimmt gleichzeitig, in welcher Folge der Aufwertungslauf
 * (3.3.8.2.1.2) die Elemente durchgeht - der Nulllauf des SRL-Decoders laeuft
 * ueber Bandgrenzen hinweg weiter und haengt darum an genau dieser Folge.
 *
 * Groessen der Reduce-Extrapolate-Variante aus der Abbildung "Bands resulting
 * from the Reduce-Extrapolate DWT Method" (3.2.8.1.2.2): waagerecht 33 tiefe
 * und 31 hohe Werte auf Stufe 1, 17/16 auf Stufe 2, 9/8 auf Stufe 3.
 */
const BAENDER_EXTRAPOLIERT: readonly Teilband[] = [
  band('HL1', QI_HL1, 0, 31, 33),
  band('LH1', QI_LH1, 1023, 33, 31),
  band('HH1', QI_HH1, 2046, 31, 31),
  band('HL2', QI_HL2, 3007, 16, 17),
  band('LH2', QI_LH2, 3279, 17, 16),
  band('HH2', QI_HH2, 3551, 16, 16),
  band('HL3', QI_HL3, 3807, 8, 9),
  band('LH3', QI_LH3, 3879, 9, 8),
  band('HH3', QI_HH3, 3951, 8, 8),
  band('LL3', QI_LL3, 4015, 9, 9),
];

/** Dieselbe Folge fuer die urspruengliche DWT (3.2.8.1.2.1) mit 32/16/8er Baendern. */
const BAENDER_KLASSISCH: readonly Teilband[] = [
  band('HL1', QI_HL1, 0, 32, 32),
  band('LH1', QI_LH1, 1024, 32, 32),
  band('HH1', QI_HH1, 2048, 32, 32),
  band('HL2', QI_HL2, 3072, 16, 16),
  band('LH2', QI_LH2, 3328, 16, 16),
  band('HH2', QI_HH2, 3584, 16, 16),
  band('HL3', QI_HL3, 3840, 8, 8),
  band('LH3', QI_LH3, 3904, 8, 8),
  band('HH3', QI_HH3, 3968, 8, 8),
  band('LL3', QI_LL3, 4032, 8, 8),
];

/** Das LL3-Band steht in beiden Tabellen an letzter Stelle. */
const LL3_INDEX = BAENDER - 1;

interface DwtStufe {
  /** Anzahl der Tiefpasswerte, die in diese Stufe hineingehen. */
  readonly tief: number;
  /** Anzahl der tatsaechlich uebertragenen Hochpasswerte. */
  readonly hoch: number;
  /**
   * Anzahl der Hochpasswerte, mit denen gerechnet wird. Bei
   * Reduce-Extrapolate auf Stufe 1 ist das einer mehr als uebertragen:
   * "Adding a zero as the 32nd high-frequency element allows the final pass to
   * be performed in the same manner as the first two passes" (3.3.8.2.2).
   */
  readonly hochGesamt: number;
  /** Kantenlaenge des Ergebnisses dieser Stufe. */
  readonly ziel: number;
}

/**
 * Die drei Stufen der inversen DWT, von innen nach aussen.
 *
 * Reduce-Extrapolate rechnet auf Stufe 1 mit 33 + 32 = 65 Werten und wirft den
 * 65. weg: "The 65th element is an extrapolation of the previous two elements
 * and is not used; therefore, it is dropped" (3.3.8.2.2). Genau deshalb ist
 * ziel = 64 und nicht 65.
 */
const DWT_EXTRAPOLIERT: readonly DwtStufe[] = [
  { tief: 9, hoch: 8, hochGesamt: 8, ziel: 17 },
  { tief: 17, hoch: 16, hochGesamt: 16, ziel: 33 },
  { tief: 33, hoch: 31, hochGesamt: 32, ziel: 64 },
];

const DWT_KLASSISCH: readonly DwtStufe[] = [
  { tief: 8, hoch: 8, hochGesamt: 8, ziel: 16 },
  { tief: 16, hoch: 16, hochGesamt: 16, ziel: 32 },
  { tief: 32, hoch: 32, hochGesamt: 32, ziel: 64 },
];

// --- Leser ------------------------------------------------------------------

/**
 * Byteweiser Leser mit Grenzpruefung, die sagt, *welches* Feld nicht mehr
 * passte - genau wie ClearReader in src/codec/clear.ts und aus demselben
 * Grund: ein RangeError aus dem Buffer nennt das Feld nicht.
 */
class ProgLeser {
  private pos: number;

  constructor(private readonly buf: Buffer, start = 0, private readonly end = buf.length) {
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number, was: string): number {
    if (n < 0 || this.pos + n > this.end) {
      throw new RdpProtocolError(
        `Progressive: ${was} braucht ${n} Byte, ab Offset ${this.pos} stehen aber nur noch ${this.end - this.pos} bereit`,
      );
    }
    const start = this.pos;
    this.pos += n;
    return start;
  }

  u8(was: string): number {
    return this.buf[this.need(1, was)];
  }

  u16(was: string): number {
    return this.buf.readUInt16LE(this.need(2, was));
  }

  u32(was: string): number {
    return this.buf.readUInt32LE(this.need(4, was));
  }

  bytes(n: number, was: string): Buffer {
    const start = this.need(n, was);
    return this.buf.subarray(start, start + n);
  }
}

/**
 * Bitleser, der von oben nach unten durch jedes Byte laeuft:
 * "[0..N] -> [0..7](MSB..LSB),[8..15](MSB..LSB) ..." (MS-RDPRFX 3.1.8.1.7.3).
 *
 * Hinter dem Ende liefert er Nullbits statt zu werfen. Das ist bewusst und
 * nicht aus Bequemlichkeit: RLGR- und SRL-Stroeme enden an einer Bytegrenze und
 * der Decoder liest regelmaessig ein paar Fuellbits ueber das letzte
 * bedeutungstragende Bit hinaus. Gleichzeitig ist es die Bremse gegen
 * Endlosschleifen - ein Nulllauf, der nur noch Fuellbits liest, laeuft in die
 * Zaehlgrenze seines Aufrufers und bricht ab, statt ewig weiterzulaufen.
 *
 * Exportiert, damit test/progressive.test.ts die durchgerechneten Rohbit-
 * Beispiele aus MS-RDPEGFX 4.1.2 unmittelbar nachrechnen kann.
 */
export class BitLeser {
  /** Bitposition ab Pufferanfang. */
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  /** Liefert die naechsten n Bits als vorzeichenlose Zahl (n <= 24). */
  lies(n: number): number {
    let wert = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.pos >> 3;
      const bit = byte < this.buf.length ? (this.buf[byte] >> (7 - (this.pos & 7))) & 1 : 0;
      wert = (wert << 1) | bit;
      this.pos++;
    }
    return wert;
  }
}

// --- RLGR (MS-RDPRFX 3.1.8.1.7.3) -------------------------------------------

const KPMAX = 80;
const LSGR = 3;
const UP_GR = 4;
const DN_GR = 6;
const UQ_GR = 3;
const DQ_GR = 3;

/**
 * Obergrenze fuer die Zahl der fuehrenden Einsen im Golomb-Rice-Praefix.
 *
 * Die Schleife endet in jedem realen Strom von selbst, weil hinter dem
 * Pufferende Nullbits kommen. Die Grenze ist trotzdem da, damit die Aussage
 * "keine Schleife kann haengen" nicht von dieser Eigenschaft abhaengt.
 */
const MAX_VK = 1 << 16;

/** Zahl der Bits, die noetig sind, um `wert` darzustellen (GetMinBits). */
function bitBreite(wert: number): number {
  let n = 0;
  while (wert > 0) {
    n++;
    wert >>>= 1;
  }
  return n;
}

/** GetIntFrom2MagSign: aus (2 * Betrag - Vorzeichen) wieder eine ganze Zahl. */
function ausBetragVorzeichen(zweiMS: number): number {
  return zweiMS & 1 ? -((zweiMS + 1) >> 1) : zweiMS >> 1;
}

/**
 * RLGR1/RLGR3-Entropiedekodierung (MS-RDPRFX 3.1.8.1.7.3).
 *
 * Eins zu eins der Pseudocode der Spezifikation, mit zwei Ergaenzungen, die
 * dort fehlen und ohne die der Decoder an einem abgeschnittenen Strom haengen
 * bliebe:
 *   - Die Nulllaufschleife im RL-Modus prueft zusaetzlich, ob ueberhaupt noch
 *     Werte fehlen. Im Pseudocode tut das nur WriteZeroes, das den Zaehler
 *     "check and update" nennt, ohne die Schleife zu verlassen.
 *   - GetGRCode bricht nach MAX_VK fuehrenden Einsen ab.
 * Jeder Durchlauf der aeusseren Schleife schreibt mindestens einen Wert, der
 * Zaehler faellt also streng - damit kann sie nicht haengen.
 */
export function rlgrDekodieren(daten: Buffer, anzahl: number, modus: RlgrModus): Int32Array {
  if (anzahl < 0) {
    throw new RdpProtocolError(`Progressive: RLGR soll ${anzahl} Werte liefern, das ist keine Anzahl`);
  }
  const bits = new BitLeser(daten);
  const aus = new Int32Array(anzahl);
  let geschrieben = 0;

  let k = 1;
  let kp = k << LSGR;
  let kr = 1;
  let krp = kr << LSGR;

  // UpdateParam: Parameter fortschreiben, auf [0, KPMAX] begrenzen, k zurueck.
  const setzeKp = (delta: number): number => {
    kp += delta;
    if (kp > KPMAX) kp = KPMAX;
    if (kp < 0) kp = 0;
    return kp >> LSGR;
  };
  const setzeKrp = (delta: number): number => {
    krp += delta;
    if (krp > KPMAX) krp = KPMAX;
    if (krp < 0) krp = 0;
    return krp >> LSGR;
  };

  const schreibe = (wert: number): void => {
    if (geschrieben < anzahl) aus[geschrieben++] = wert;
  };
  const schreibeNullen = (n: number): void => {
    const ende = Math.min(anzahl, geschrieben + n);
    while (geschrieben < ende) aus[geschrieben++] = 0;
  };

  const grCode = (): number => {
    let vk = 0;
    while (bits.lies(1) === 1) {
      vk++;
      if (vk >= MAX_VK) {
        throw new RdpProtocolError(
          `Progressive: RLGR-Praefix mit ueber ${MAX_VK} fuehrenden Einsen - der Strom ist nicht RLGR-kodiert`,
        );
      }
    }
    const betrag = (vk << kr) | bits.lies(kr);
    if (vk === 0) kr = setzeKrp(-2);
    else if (vk !== 1) kr = setzeKrp(vk);
    return betrag;
  };

  while (geschrieben < anzahl) {
    if (k) {
      // RL-Modus: "0" ist ein Fluchtzeichen fuer einen Lauf von (1 << k) Nullen.
      while (geschrieben < anzahl && bits.lies(1) === 0) {
        schreibeNullen(1 << k);
        k = setzeKp(UP_GR);
      }
      if (geschrieben < anzahl) {
        schreibeNullen(bits.lies(k));
      }
      if (geschrieben < anzahl) {
        // Erst das Vorzeichen, dann Golomb-Rice von (Betrag - 1).
        const vorzeichen = bits.lies(1);
        const betrag = grCode() + 1;
        schreibe(vorzeichen ? -betrag : betrag);
        k = setzeKp(-DN_GR);
      }
    } else if (modus === RLGR1) {
      const betrag = grCode();
      if (betrag === 0) {
        schreibe(0);
        k = setzeKp(UQ_GR);
      } else {
        schreibe(ausBetragVorzeichen(betrag));
        k = setzeKp(-DQ_GR);
      }
    } else {
      // RLGR3 kodiert im GR-Modus die Summe zweier Werte und danach den
      // ersten Summanden in genau so vielen Bits, wie die Summe braucht.
      const summe = grCode();
      const nIdx = bitBreite(summe);
      const wert1 = bits.lies(nIdx);
      const wert2 = summe - wert1;
      if (wert1 && wert2) k = setzeKp(-2 * DQ_GR);
      else if (!wert1 && !wert2) k = setzeKp(2 * UQ_GR);
      schreibe(ausBetragVorzeichen(wert1));
      schreibe(ausBetragVorzeichen(wert2));
    }
  }

  return aus;
}

// --- SRL (MS-RDPEGFX 3.1.8.1.5) ---------------------------------------------

/** Anfangswert des Nulllauf-Parameters KP (3.1.8.1.5.1). */
const SRL_KP_START = 8;
const SRL_KP_MAX = 80;
const SRL_KP_AUF = 4;
const SRL_KP_AB = 6;

/**
 * Simplified-Run-Length-Decoder fuer die Aufwertungslaeufe (3.1.8.1.5).
 *
 * Aufbau des Stroms: abwechselnd eine Nulllauflaenge und *genau ein* Wert
 * ungleich null. Die Lauflaenge benutzt dieselbe Mechanik wie RLGR - "0" ist
 * ein Fluchtzeichen fuer (1 << K) Nullen, "1" leitet die restlichen K Bits ein
 * -, der Wert dahinter ist dagegen unaer kodiert und nicht Golomb-Rice
 * (3.1.8.1.5.2).
 *
 * Zwei Feinheiten, die aus dem Beispiel in 4.1.2.1.2 stammen und nicht aus dem
 * Fliesstext:
 *   - Nach dem Lauf folgt der Wert *ohne* eigene Lauflaenge. Genau deshalb
 *     reicht ein Zustandsbit ("wertFaellig") und keine erneute Laengenlesung.
 *   - Der Betrag (1 << nBits) - 1 wird nicht mit einer "1" abgeschlossen, weil
 *     er der groesste darstellbare ist.
 *
 * Exportiert, damit test/progressive.test.ts genau dieses Beispiel nachrechnen
 * kann, ohne eine ganze Kachel drumherum bauen zu muessen.
 */
export class SrlLeser {
  private readonly bits: BitLeser;
  private kp = SRL_KP_START;
  private k = SRL_KP_START >> 3;
  /** Noch auszugebende Nullen des laufenden Nulllaufs. */
  private nullen = 0;
  /** Nach einem abgeschlossenen Nulllauf folgt zwingend ein Wert. */
  private wertFaellig = false;

  /**
   * @param daten der SRL-Teilstrom einer Komponente
   * @param maxLauf Obergrenze fuer eine einzelne Nulllauflaenge. Sie sorgt
   *   dafuer, dass die Laengenschleife an einem abgeschnittenen Strom
   *   abbricht, statt aus Fuellnullen immer laengere Laeufe zu bauen.
   */
  constructor(daten: Buffer, private readonly maxLauf = KOEFFIZIENTEN) {
    this.bits = new BitLeser(daten);
  }

  /** Naechster Wert des Stroms; nBits ist die Bitzahl des aktuellen Bandes. */
  naechster(nBits: number): number {
    if (this.nullen > 0) {
      this.nullen--;
      return 0;
    }
    if (this.wertFaellig) {
      this.wertFaellig = false;
      return this.unaer(nBits);
    }
    this.nullen = this.nulllauf();
    this.wertFaellig = true;
    if (this.nullen > 0) {
      this.nullen--;
      return 0;
    }
    this.wertFaellig = false;
    return this.unaer(nBits);
  }

  /** Zero Run-Length Encoding (3.1.8.1.5.1), Leserichtung. */
  private nulllauf(): number {
    let lauf = 0;
    for (;;) {
      if (this.bits.lies(1) === 1) {
        lauf += this.bits.lies(this.k);
        this.kp = Math.max(0, this.kp - SRL_KP_AB);
        this.k = this.kp >> 3;
        return lauf;
      }
      lauf += 1 << this.k;
      this.kp = Math.min(SRL_KP_MAX, this.kp + SRL_KP_AUF);
      this.k = this.kp >> 3;
      // Jeder Durchlauf verlaengert den Lauf um mindestens eins; diese Grenze
      // macht daraus eine endliche Schleife, auch wenn nur noch Fuellnullen
      // kommen.
      if (lauf > this.maxLauf) return lauf;
    }
  }

  /** Unary Encoding (3.1.8.1.5.2), Leserichtung. */
  private unaer(nBits: number): number {
    if (nBits < 1 || nBits > 15) {
      throw new RdpProtocolError(`Progressive: SRL-Wert mit ${nBits} Bit Betrag ist nicht darstellbar`);
    }
    const negativ = this.bits.lies(1) === 1;
    const maxBetrag = (1 << nBits) - 1;
    let betrag = 1;
    while (betrag < maxBetrag && this.bits.lies(1) === 0) {
      betrag++;
    }
    return negativ ? -betrag : betrag;
  }
}

// --- Inverse DWT (MS-RDPRFX 3.1.8.2.4, MS-RDPEGFX 3.3.8.2.2) ----------------

/**
 * Eindimensionale inverse DWT ueber einen Tiefpass- und einen Hochpassstrang.
 *
 * Gerade Stellen: X[2n]   = L[n] - floor((H[n-1] + H[n] + 1) / 2)
 * Ungerade:       X[2n+1] = 2 * H[n] + floor((X[2n] + X[2n+2]) / 2)
 *
 * Die Spiegelung an den Raendern ("normal mirroring", 3.3.8.2.2) steckt in den
 * beiden Klemmungen: H[-1] wird zu H[0], und ein X[2n+2] hinter dem letzten
 * geraden Wert wird zu ebendiesem. Bei gleich vielen Tief- und Hochpasswerten
 * ist Letzteres genau die Spiegelung X[64] = X[62].
 *
 * `ev` ist ein Kratzpuffer fuer die geraden Werte. Er ist noetig, weil bei
 * Reduce-Extrapolate der letzte gerade Wert (X[64]) gebraucht wird, um X[63] zu
 * berechnen, aber selbst nicht mehr ins Ergebnis gehoert.
 */
function idwt1d(
  tief: Int32Array,
  tiefOff: number,
  tiefSchritt: number,
  nTief: number,
  hoch: Int32Array,
  hochOff: number,
  hochSchritt: number,
  nHoch: number,
  nHochGesamt: number,
  ziel: Int32Array,
  zielOff: number,
  zielSchritt: number,
  nZiel: number,
  ev: Int32Array,
): void {
  const h = (i: number): number => {
    if (i < 0) i = 0;
    else if (i >= nHochGesamt) i = nHochGesamt - 1;
    return i < nHoch ? hoch[hochOff + i * hochSchritt] : 0;
  };

  for (let n = 0; n < nTief; n++) {
    ev[n] = tief[tiefOff + n * tiefSchritt] - ((h(n - 1) + h(n) + 1) >> 1);
  }
  for (let n = 0; n < nTief; n++) {
    const p = 2 * n;
    if (p < nZiel) ziel[zielOff + p * zielSchritt] = ev[n];
  }
  for (let n = 0; n < nHochGesamt; n++) {
    const p = 2 * n + 1;
    if (p >= nZiel) break;
    const rechts = ev[n + 1 < nTief ? n + 1 : nTief - 1];
    ziel[zielOff + p * zielSchritt] = 2 * h(n) + ((ev[n] + rechts) >> 1);
  }
}

/**
 * Ein einzelner eindimensionaler Durchgang der inversen DWT.
 *
 * Dieselbe Rechnung, die inverseDwt fuer jede Zeile und jede Spalte jeder Stufe
 * ausfuehrt, nur einzeln aufrufbar - die durchgerechneten Zwischenstaende in
 * MS-RDPRFX 4.2.4.3 sind genau solche einzelnen Zeilen und Spalten.
 *
 * @param nHochGesamt Zahl der Hochpasswerte, mit denen gerechnet wird. Groesser
 *   als hoch.length heisst: die fehlenden sind null (Reduce-Extrapolate,
 *   3.3.8.2.2).
 */
export function inverseDwt1d(
  tief: ArrayLike<number>,
  hoch: ArrayLike<number>,
  nHochGesamt: number = hoch.length,
): Int32Array {
  const t = Int32Array.from(tief);
  const h = Int32Array.from(hoch);
  const aus = new Int32Array(t.length + nHochGesamt);
  idwt1d(t, 0, 1, t.length, h, 0, 1, h.length, nHochGesamt, aus, 0, 1, aus.length, new Int32Array(t.length + 1));
  return aus;
}

/**
 * Dreistufige inverse DWT ueber einen linearisierten Koeffizientenblock.
 *
 * Erwartet bereits dequantisierte Werte in der Bandreihenfolge der
 * Linearisierung und liefert 64 x 64 Werte zeilenweise von oben nach unten.
 * Je Stufe erst waagerecht (LL|HL und LH|HH), dann senkrecht (L|H) - die
 * Umkehrung der Hintransformation, die laut MS-RDPRFX 3.1.8.1.4 senkrecht
 * beginnt.
 */
export function inverseDwt(dequantisiert: Int32Array, reduceExtrapolate: boolean): Int32Array {
  if (dequantisiert.length !== KOEFFIZIENTEN) {
    throw new RdpProtocolError(
      `Progressive: inverse DWT braucht ${KOEFFIZIENTEN} Koeffizienten, bekommen hat sie ${dequantisiert.length}`,
    );
  }
  const baender = reduceExtrapolate ? BAENDER_EXTRAPOLIERT : BAENDER_KLASSISCH;
  const stufen = reduceExtrapolate ? DWT_EXTRAPOLIERT : DWT_KLASSISCH;

  const ll3 = baender[LL3_INDEX];
  let ll = new Int32Array(ll3.breite * ll3.hoehe);
  for (let i = 0; i < ll.length; i++) ll[i] = dequantisiert[ll3.offset + i];
  let llKante = ll3.breite;

  const ev = new Int32Array(KACHELKANTE + 2);

  for (let s = 0; s < stufen.length; s++) {
    const stufe = stufen[s];
    // Stufe 0 nimmt HL3/LH3/HH3 (Index 6,7,8), Stufe 1 die zweite Ebene, ...
    const hl = baender[6 - s * 3];
    const lh = baender[7 - s * 3];
    const hh = baender[8 - s * 3];

    // Waagerechter Durchgang.
    const lv = new Int32Array(stufe.ziel * stufe.tief);
    const hv = new Int32Array(stufe.ziel * stufe.hoch);
    for (let y = 0; y < stufe.tief; y++) {
      idwt1d(
        ll, y * llKante, 1, stufe.tief,
        dequantisiert, hl.offset + y * hl.breite, 1, stufe.hoch, stufe.hochGesamt,
        lv, y * stufe.ziel, 1, stufe.ziel, ev,
      );
    }
    for (let y = 0; y < stufe.hoch; y++) {
      idwt1d(
        dequantisiert, lh.offset + y * lh.breite, 1, stufe.tief,
        dequantisiert, hh.offset + y * hh.breite, 1, stufe.hoch, stufe.hochGesamt,
        hv, y * stufe.ziel, 1, stufe.ziel, ev,
      );
    }

    // Senkrechter Durchgang.
    const neu = new Int32Array(stufe.ziel * stufe.ziel);
    for (let x = 0; x < stufe.ziel; x++) {
      idwt1d(
        lv, x, stufe.ziel, stufe.tief,
        hv, x, stufe.ziel, stufe.hoch, stufe.hochGesamt,
        neu, x, stufe.ziel, stufe.ziel, ev,
      );
    }
    ll = neu;
    llKante = stufe.ziel;
  }

  return ll;
}

// --- Dequantisierung --------------------------------------------------------

/**
 * Macht die skalare Quantisierung rueckgaengig (MS-RDPRFX 3.1.8.2.3).
 *
 * Scale_value = 1 << (quantization_factor - 6), hier zusaetzlich um
 * FIXPUNKT_BITS erweitert. Faktoren unter 6 sind in MS-RDPRFX ausgeschlossen,
 * MS-RDPEGFX 2.2.4.2.1.5.2 laesst aber 0 bis 15 zu; ein negativer Schub wird
 * deshalb als arithmetische Rechtsverschiebung ausgefuehrt statt still ein
 * falsches Ergebnis zu liefern.
 */
export function dequantisiere(
  koeffizienten: Int32Array,
  quant: readonly number[],
  reduceExtrapolate: boolean,
): Int32Array {
  if (koeffizienten.length !== KOEFFIZIENTEN) {
    throw new RdpProtocolError(
      `Progressive: Dequantisierung braucht ${KOEFFIZIENTEN} Koeffizienten, bekommen hat sie ${koeffizienten.length}`,
    );
  }
  const baender = reduceExtrapolate ? BAENDER_EXTRAPOLIERT : BAENDER_KLASSISCH;
  const aus = new Int32Array(KOEFFIZIENTEN);
  for (const b of baender) {
    const schub = quant[b.quant] - 6 + FIXPUNKT_BITS;
    const ende = b.offset + b.breite * b.hoehe;
    if (schub >= 0) {
      for (let i = b.offset; i < ende; i++) aus[i] = koeffizienten[i] << schub;
    } else {
      for (let i = b.offset; i < ende; i++) aus[i] = koeffizienten[i] >> -schub;
    }
  }
  return aus;
}

// --- Farbumrechnung (MS-RDPRFX 3.1.8.2.5) -----------------------------------

/**
 * YCbCr nach RGBA, zeilenweise von oben nach unten.
 *
 * Die Matrix stammt woertlich aus MS-RDPRFX 3.1.8.2.5 (Figure 15):
 *   R = Y + 1.402525 * Cr
 *   G = Y - 0.343730 * Cb - 0.714401 * Cr
 *   B = Y + 1.769905 * Cb + 0.000013 * Cr
 * Y ist im Strom um 128 heruntergeschoben und wird hier zurueckgeschoben.
 *
 * Rot und Blau werden *nicht* getauscht. Das ist die offene Frage aus
 * planar.ts und clear.ts, und fuer diesen Codec ist sie eindeutig beantwortet:
 * planar.ts und der NSCodec-Zweig von clear.ts arbeiten im AYCoCg-Raum, wo
 * MS-RDPEGDI 3.1.9.1.1 den Tausch beschreibt. Hier ist der Farbraum YCbCr aus
 * MS-RDPRFX, und die Spezifikation liefert dazu in 4.2.4.4 einen
 * durchgerechneten XRGB-Dump: dessen erstes Pixel (Y = -1, Cb = 54, Cr = -66)
 * ergibt mit obiger Matrix R = 34, G = 156, B = 223 und steht im Dump als
 * 0x00229cdf, also R = 0x22, G = 0x9c, B = 0xdf. Ein Tausch wuerde daraus
 * 0x00df9c22 machen.
 *
 * Die Eingaben sind Festkommazahlen mit FIXPUNKT_BITS Nachkommastellen.
 */
export function ycbcrNachRgba(y: Int32Array, cb: Int32Array, cr: Int32Array): Uint8ClampedArray {
  const aus = new Uint8ClampedArray(KOEFFIZIENTEN * 4);
  for (let i = 0, o = 0; i < KOEFFIZIENTEN; i++, o += 4) {
    const yy = y[i] / FIXPUNKT_TEILER;
    const cbb = cb[i] / FIXPUNKT_TEILER;
    const crr = cr[i] / FIXPUNKT_TEILER;
    // Uint8ClampedArray erledigt das Begrenzen auf 0..255.
    aus[o] = Math.round(yy + 1.402525 * crr) + 128;
    aus[o + 1] = Math.round(yy - 0.34373 * cbb - 0.714401 * crr) + 128;
    aus[o + 2] = Math.round(yy + 1.769905 * cbb + 0.000013 * crr) + 128;
    aus[o + 3] = 255;
  }
  return aus;
}

// --- Zustand ----------------------------------------------------------------

/** Eine fertig dekodierte Kachel mit ihrer Lage auf der Zielflaeche. */
export interface ProgressiveTile {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA, zeilenweise von oben nach unten, width * height * 4 Byte. */
  rgba: Uint8ClampedArray;
}

/**
 * Zustand einer einzelnen Kachel (3.3.1.2 und 3.3.1.3).
 *
 * koeffizienten entspricht DecDwtQ: die regulaer quantisierten DWT-Werte, die
 * der Decoder gerade haelt. vorzeichen ist der Tri-State "Sign" aus 3.3.8.2.1.1
 * und entscheidet im Aufwertungslauf, ob ein Element aus dem SRL- oder aus dem
 * Rohbitstrom kommt. bitPos ist die Bitposition des letzten Laufs je Band;
 * aus der Differenz zur aktuellen ergibt sich, wie viele Rohbits zu lesen sind.
 */
interface KachelZustand {
  readonly koeffizienten: Int32Array[];
  readonly vorzeichen: Int8Array[];
  readonly bitPos: Int32Array[];
}

function neueKachel(): KachelZustand {
  const koeffizienten: Int32Array[] = [];
  const vorzeichen: Int8Array[] = [];
  const bitPos: Int32Array[] = [];
  for (let k = 0; k < KOMPONENTEN; k++) {
    koeffizienten.push(new Int32Array(KOEFFIZIENTEN));
    vorzeichen.push(new Int8Array(KOEFFIZIENTEN));
    bitPos.push(new Int32Array(BAENDER));
  }
  return { koeffizienten, vorzeichen, bitPos };
}

/**
 * Zustand einer Zielflaeche: ihre Kacheln, nach (yIdx << 16) | xIdx abgelegt.
 *
 * Mehr ist nicht noetig. RFX_PROGRESSIVE_CONTEXT traegt zwar Kachelgroesse und
 * Flags, beide sind aber fest (tileSize MUSS 64 sein) beziehungsweise ohne
 * Wirkung auf die Dekodierung: ob Teilbanddifferenz benutzt wird, sagt das
 * flags-Feld jeder einzelnen Kachel, nicht der Kontext.
 */
type Flaechenzustand = Map<number, KachelZustand>;

/** Ein Rechteck aus dem rects-Feld einer Region (TS_RFX_RECT). */
interface Rechteck {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Quantisierungswerte einer Region: je Tabelle zehn Werte in Bandreihenfolge. */
type Quanttabelle = number[];

/**
 * Kopf einer Kachel, soweit ihn alle drei Kachelarten gemeinsam haben.
 * Die Feldnamen stehen woertlich so in 2.2.4.2.1.5.3 bis 2.2.4.2.1.5.5.
 */
interface Kachelkopf {
  quantIdxY: number;
  quantIdxCb: number;
  quantIdxCr: number;
  xIdx: number;
  yIdx: number;
}

/** Eine vollstaendig eingelesene Region (2.2.4.2.1.5). */
interface Region {
  rects: Rechteck[];
  quantVals: Quanttabelle[];
  quantProgVals: Quanttabelle[][];
  reduceExtrapolate: boolean;
}

/** Alle Bitpositionen auf null - progressiveQuality 0xFF (2.2.4.2.1.5.4). */
const VOLLE_QUALITAET: Quanttabelle[] = [
  new Array(BAENDER).fill(0),
  new Array(BAENDER).fill(0),
  new Array(BAENDER).fill(0),
];

/**
 * Dekodierer fuer RDPGFX_CODECID_CAPROGRESSIVE.
 *
 * Eine Instanz je Verbindung. Der gesamte Zustand haengt an der surfaceId, weil
 * der Server denselben Kachelraster fuer jede Flaeche getrennt fortschreibt.
 */
export class ProgressiveDecoder {
  private readonly flaechen = new Map<number, Flaechenzustand>();

  /**
   * Verwirft den Zustand einer Flaeche - oder aller, wenn surfaceId fehlt.
   *
   * Aufzurufen, wenn der Server eine Flaeche loescht oder
   * RDPGFX_DELETE_ENCODING_CONTEXT_PDU schickt (3.3.1.1): die Kachelzustaende
   * duerfen eine geloeschte Flaeche nicht ueberleben, sonst wuerde eine spaeter
   * unter derselben Nummer angelegte Flaeche Differenzen gegen fremde Bilddaten
   * rechnen.
   */
  reset(surfaceId?: number): void {
    if (surfaceId === undefined) this.flaechen.clear();
    else this.flaechen.delete(surfaceId);
  }

  /**
   * Verarbeitet eine Nachricht und liefert die darin fertig gewordenen Kacheln.
   *
   * "Fertig geworden" heisst: jede Kachel, die in dieser Nachricht Daten
   * bekommen hat, wird mit ihrem neuen Stand ausgegeben. Ein Aufwertungslauf
   * liefert dieselbe Kachel also erneut, nur besser - das ist der Sinn des
   * Verfahrens und der Aufrufer muss sie erneut zeichnen.
   *
   * Die Kacheln sind bereits an den Rechtecken der Region beschnitten
   * (MS-RDPRFX 3.1.8.2.6): "it is valid for tiles to carry compressed
   * information for pixels outside of the region", und diese Pixel duerfen die
   * Flaeche nicht veraendern. Eine Kachel, die mehrere Rechtecke schneidet,
   * ergibt entsprechend mehrere Eintraege.
   */
  decode(src: Buffer, surfaceId: number): ProgressiveTile[] {
    const flaeche = this.flaeche(surfaceId);
    const ergebnis: ProgressiveTile[] = [];
    let o = 0;

    while (o < src.length) {
      if (src.length - o < 6) {
        throw new RdpProtocolError(
          `Progressive: abgeschnittener Strom - ab Offset ${o} stehen nur noch ${src.length - o} Byte, ` +
            'ein RFX_PROGRESSIVE_DATABLOCK-Kopf braucht 6',
        );
      }
      const blockType = src.readUInt16LE(o);
      const blockLen = src.readUInt32LE(o + 2);
      // blockLen enthaelt den Kopf selbst (2.2.4.2.1). Ein kleinerer Wert waere
      // nicht nur falsch, sondern wuerde die Schleife nicht vorankommen lassen.
      if (blockLen < 6) {
        throw new RdpProtocolError(
          `Progressive: blockLen ${blockLen} bei Offset ${o} ist kleiner als der Blockkopf (6 Byte)`,
        );
      }
      if (o + blockLen > src.length) {
        throw new RdpProtocolError(
          `Progressive: Block 0x${blockType.toString(16)} bei Offset ${o} gibt ${blockLen} Byte an, ` +
            `der Puffer hat ab dort aber nur ${src.length - o}`,
        );
      }
      const daten = src.subarray(o + 6, o + blockLen);

      switch (blockType) {
        case WBT_SYNC:
          this.liesSync(daten, blockLen);
          break;
        case WBT_FRAME_BEGIN:
          this.liesFrameBegin(daten, blockLen);
          break;
        case WBT_FRAME_END:
          if (blockLen !== 6) {
            throw new RdpProtocolError(
              `Progressive: RFX_PROGRESSIVE_FRAME_END hat blockLen ${blockLen}, 2.2.4.2.1.3 verlangt 6`,
            );
          }
          break;
        case WBT_CONTEXT:
          this.liesContext(daten, blockLen);
          break;
        case WBT_REGION:
          this.liesRegion(daten, flaeche, ergebnis);
          break;
        case WBT_TILE_SIMPLE:
        case WBT_TILE_PROGRESSIVE_FIRST:
        case WBT_TILE_PROGRESSIVE_UPGRADE:
          throw new RdpProtocolError(
            `Progressive: Kachelblock 0x${blockType.toString(16)} steht bei Offset ${o} ausserhalb einer ` +
              'RFX_PROGRESSIVE_REGION - ohne deren Quantisierungstabellen ist er nicht dekodierbar',
          );
        default:
          // 2.2.4.2.1: "If this field is not set to one of the specified
          // values, the decoder SHOULD ignore the contents". Uebersprungen wird
          // mit blockLen; das ist die einzige Laengenangabe, die es gibt, und
          // sie wurde oben bereits gegen den Puffer geprueft.
          break;
      }

      o += blockLen;
    }

    return ergebnis;
  }

  private flaeche(surfaceId: number): Flaechenzustand {
    let f = this.flaechen.get(surfaceId);
    if (!f) {
      f = new Map();
      this.flaechen.set(surfaceId, f);
    }
    return f;
  }

  /** RFX_PROGRESSIVE_SYNC (2.2.4.2.1.1). */
  private liesSync(daten: Buffer, blockLen: number): void {
    if (blockLen !== 12) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_SYNC hat blockLen ${blockLen}, 2.2.4.2.1.1 verlangt 12`,
      );
    }
    // magic und version sind laut Spezifikation beide "SHOULD ignore" - sie
    // werden deshalb gelesen, aber nicht bewertet.
    const r = new ProgLeser(daten);
    r.u32('RFX_PROGRESSIVE_SYNC::magic');
    r.u16('RFX_PROGRESSIVE_SYNC::version');
  }

  /** RFX_PROGRESSIVE_FRAME_BEGIN (2.2.4.2.1.2). */
  private liesFrameBegin(daten: Buffer, blockLen: number): void {
    if (blockLen !== 12) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_FRAME_BEGIN hat blockLen ${blockLen}, 2.2.4.2.1.2 verlangt 12 ` +
          '(die Regionen zaehlen ausdruecklich nicht mit)',
      );
    }
    const r = new ProgLeser(daten);
    r.u32('RFX_PROGRESSIVE_FRAME_BEGIN::frameIndex');
    r.u16('RFX_PROGRESSIVE_FRAME_BEGIN::regionCount');
    // regionCount wird bewusst nicht gegen die tatsaechliche Zahl der Regionen
    // geprueft: 2.2.4.2.1.2 verlangt ausdruecklich, eine zu grosse Angabe zu
    // ignorieren.
    //
    // Ebenso wenig wird mitgezaehlt, ob eine Region zwischen FRAME_BEGIN und
    // FRAME_END steht. 2.2.4.2.1.5 verlangt zwar, eine Region ausserhalb der
    // Klammer zu verwerfen, aber genau das hiesse Bildinhalt wegzuwerfen, wenn
    // ein Server die Klammer anders ueber die Nachrichten verteilt als
    // erwartet. Der Schaden waere unsichtbar; die Regel schuetzt dagegen vor
    // nichts, was hier vorkommen kann.
  }

  /** RFX_PROGRESSIVE_CONTEXT (2.2.4.2.1.4). */
  private liesContext(daten: Buffer, blockLen: number): void {
    if (blockLen !== 10) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_CONTEXT hat blockLen ${blockLen}, 2.2.4.2.1.4 verlangt 10`,
      );
    }
    const r = new ProgLeser(daten);
    r.u8('RFX_PROGRESSIVE_CONTEXT::ctxId');
    const tileSize = r.u16('RFX_PROGRESSIVE_CONTEXT::tileSize');
    // flags traegt nur RFX_SUBBAND_DIFFING. Ob eine Kachel eine Differenz ist,
    // steht in ihrem eigenen flags-Feld; der Kontext aendert daran nichts.
    r.u8('RFX_PROGRESSIVE_CONTEXT::flags');
    if (tileSize !== KACHELKANTE) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_CONTEXT::tileSize ist ${tileSize}, 2.2.4.2.1.4 verlangt 64`,
      );
    }
  }

  /** RFX_PROGRESSIVE_REGION (2.2.4.2.1.5) samt aller enthaltenen Kacheln. */
  private liesRegion(daten: Buffer, flaeche: Flaechenzustand, ergebnis: ProgressiveTile[]): void {
    const r = new ProgLeser(daten);
    const tileSize = r.u8('RFX_PROGRESSIVE_REGION::tileSize');
    const numRects = r.u16('RFX_PROGRESSIVE_REGION::numRects');
    const numQuant = r.u8('RFX_PROGRESSIVE_REGION::numQuant');
    const numProgQuant = r.u8('RFX_PROGRESSIVE_REGION::numProgQuant');
    const flags = r.u8('RFX_PROGRESSIVE_REGION::flags');
    const numTiles = r.u16('RFX_PROGRESSIVE_REGION::numTiles');
    const tileDataSize = r.u32('RFX_PROGRESSIVE_REGION::tileDataSize');

    if (tileSize !== KACHELKANTE) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_REGION::tileSize ist ${tileSize}, 2.2.4.2.1.5 verlangt 0x40`,
      );
    }
    if (numRects === 0) {
      throw new RdpProtocolError(
        'Progressive: RFX_PROGRESSIVE_REGION::numRects ist 0, 2.2.4.2.1.5 verlangt einen Wert groesser null',
      );
    }
    if (numQuant > MAX_QUANT) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_REGION::numQuant ist ${numQuant}, 2.2.4.2.1.5 laesst hoechstens ${MAX_QUANT} zu`,
      );
    }

    const erwartet = 12 + numRects * 8 + numQuant * QUANT_BYTES + numProgQuant * PROG_QUANT_BYTES + tileDataSize;
    if (erwartet !== daten.length) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_REGION gibt ${numRects} Rechtecke, ${numQuant} Quantisierungssaetze, ` +
          `${numProgQuant} progressive Saetze und ${tileDataSize} Byte Kacheldaten an - zusammen ${erwartet} Byte, ` +
          `der Block hat aber ${daten.length}`,
      );
    }

    const rects: Rechteck[] = [];
    for (let i = 0; i < numRects; i++) {
      rects.push({
        x: r.u16('TS_RFX_RECT::x'),
        y: r.u16('TS_RFX_RECT::y'),
        w: r.u16('TS_RFX_RECT::width'),
        h: r.u16('TS_RFX_RECT::height'),
      });
    }

    const quantVals: Quanttabelle[] = [];
    for (let i = 0; i < numQuant; i++) {
      quantVals.push(liesComponentQuant(r, `RFX_PROGRESSIVE_REGION::quantVals[${i}]`));
    }

    const quantProgVals: Quanttabelle[][] = [];
    for (let i = 0; i < numProgQuant; i++) {
      // RFX_PROGRESSIVE_CODEC_QUANT (2.2.4.2.1.5.1): quality, dann je eine
      // RFX_COMPONENT_CODEC_QUANT fuer Y, Cb und Cr. quality ist laut
      // Spezifikation "SHOULD be ignored by the decoder".
      r.u8(`RFX_PROGRESSIVE_CODEC_QUANT[${i}]::quality`);
      quantProgVals.push([
        liesComponentQuant(r, `RFX_PROGRESSIVE_CODEC_QUANT[${i}]::yQuantValues`),
        liesComponentQuant(r, `RFX_PROGRESSIVE_CODEC_QUANT[${i}]::cbQuantValues`),
        liesComponentQuant(r, `RFX_PROGRESSIVE_CODEC_QUANT[${i}]::crQuantValues`),
      ]);
    }

    const region: Region = {
      rects,
      quantVals,
      quantProgVals,
      reduceExtrapolate: (flags & RFX_DWT_REDUCE_EXTRAPOLATE) !== 0,
    };

    const kachelDaten = r.bytes(tileDataSize, 'RFX_PROGRESSIVE_REGION::tiles');
    const gezaehlt = this.liesKacheln(kachelDaten, region, flaeche, ergebnis);
    if (gezaehlt !== numTiles) {
      throw new RdpProtocolError(
        `Progressive: RFX_PROGRESSIVE_REGION::numTiles ist ${numTiles}, im tiles-Feld stehen aber ${gezaehlt} Bloecke`,
      );
    }
  }

  /** Durchlaeuft das tiles-Feld einer Region und liefert die Zahl der Bloecke. */
  private liesKacheln(
    daten: Buffer,
    region: Region,
    flaeche: Flaechenzustand,
    ergebnis: ProgressiveTile[],
  ): number {
    let o = 0;
    let anzahl = 0;

    while (o < daten.length) {
      if (daten.length - o < 6) {
        throw new RdpProtocolError(
          `Progressive: abgeschnittene Kachelliste - ab Offset ${o} stehen nur noch ${daten.length - o} Byte`,
        );
      }
      const blockType = daten.readUInt16LE(o);
      const blockLen = daten.readUInt32LE(o + 2);
      if (blockLen < 6) {
        throw new RdpProtocolError(`Progressive: Kachel bei Offset ${o} gibt blockLen ${blockLen} an (Minimum 6)`);
      }
      if (o + blockLen > daten.length) {
        throw new RdpProtocolError(
          `Progressive: Kachel bei Offset ${o} gibt ${blockLen} Byte an, im tiles-Feld stehen ab dort aber nur ` +
            `${daten.length - o}`,
        );
      }
      const rumpf = daten.subarray(o + 6, o + blockLen);

      switch (blockType) {
        case WBT_TILE_SIMPLE:
          this.kachelErstdurchgang(rumpf, region, flaeche, ergebnis, false);
          break;
        case WBT_TILE_PROGRESSIVE_FIRST:
          this.kachelErstdurchgang(rumpf, region, flaeche, ergebnis, true);
          break;
        case WBT_TILE_PROGRESSIVE_UPGRADE:
          this.kachelAufwertung(rumpf, region, flaeche, ergebnis);
          break;
        default:
          // 2.2.4.2.1.5: "The value of the blockType field of each block present
          // in the array MUST be WBT_TILE_SIMPLE, WBT_TILE_PROGRESSIVE_FIRST, or
          // WBT_TILE_PROGRESSIVE_UPGRADE." Hier gibt es nichts zu ignorieren.
          throw new RdpProtocolError(
            `Progressive: Blocktyp 0x${blockType.toString(16)} im tiles-Feld - erlaubt sind nur 0xccc5, 0xccc6 und 0xccc7`,
          );
      }

      anzahl++;
      o += blockLen;
    }

    return anzahl;
  }

  /**
   * WBT_TILE_SIMPLE (2.2.4.2.1.5.3) und WBT_TILE_PROGRESSIVE_FIRST
   * (2.2.4.2.1.5.4) - beide durchlaufen "Performing the First Progressive Pass"
   * (3.3.8.2.1.1), sie unterscheiden sich nur im Feld progressiveQuality.
   *
   * Eine einfache Kachel ist die progressive Kachel mit lauter Bitpositionen
   * null: PQF = 1, es bleibt nichts nachzuliefern.
   */
  private kachelErstdurchgang(
    rumpf: Buffer,
    region: Region,
    flaeche: Flaechenzustand,
    ergebnis: ProgressiveTile[],
    progressiv: boolean,
  ): void {
    const r = new ProgLeser(rumpf);
    const kopf = liesKachelkopf(r);
    const flags = r.u8('RFX_PROGRESSIVE_TILE::flags');
    const progQuant = progressiv
      ? this.waehleProgQuant(r.u8('RFX_PROGRESSIVE_TILE_FIRST::progressiveQuality'), region)
      : VOLLE_QUALITAET;
    const yLen = r.u16('RFX_PROGRESSIVE_TILE::yLen');
    const cbLen = r.u16('RFX_PROGRESSIVE_TILE::cbLen');
    const crLen = r.u16('RFX_PROGRESSIVE_TILE::crLen');
    const tailLen = r.u16('RFX_PROGRESSIVE_TILE::tailLen');
    const strom = [
      r.bytes(yLen, 'RFX_PROGRESSIVE_TILE::yData'),
      r.bytes(cbLen, 'RFX_PROGRESSIVE_TILE::cbData'),
      r.bytes(crLen, 'RFX_PROGRESSIVE_TILE::crData'),
    ];
    // tailData "SHOULD be ignored", muss aber vorhanden sein.
    r.bytes(tailLen, 'RFX_PROGRESSIVE_TILE::tailData');
    if (!r.eof) {
      throw new RdpProtocolError(
        `Progressive: hinter den Kacheldaten stehen noch ${r.remaining} Byte, die keine Laengenangabe deckt`,
      );
    }

    // 2.2.4.2.1.5.4: "The seven high bits of the flags field MAY be set to zero
    // by the encoder and MUST be ignored by the decoder."
    const differenz = (flags & RFX_TILE_DIFFERENCE) !== 0;

    const quant = this.waehleQuant(kopf, region);
    const zustand = this.kachel(flaeche, kopf);
    const baender = region.reduceExtrapolate ? BAENDER_EXTRAPOLIERT : BAENDER_KLASSISCH;

    for (let k = 0; k < KOMPONENTEN; k++) {
      const koeff = zustand.koeffizienten[k];
      const vorzeichen = zustand.vorzeichen[k];
      const bitPos = zustand.bitPos[k];

      // 3.3.8.2.1: "If the input data is for the first progressive chunk of a
      // tile [...] the Persistent progressive state MUST be cleared.
      // Furthermore, if the tile is an original tile [...] then the tile MUST be
      // zeroed out in the current frame."
      vorzeichen.fill(0);
      if (!differenz) koeff.fill(0);

      const roh = rlgrDekodieren(strom[k], KOEFFIZIENTEN, RLGR1);

      // 3.3.8.2.1.1: die LL3-Deltas aufsummieren - ausdruecklich auch dann,
      // wenn die Kachel eine Differenzkachel ist.
      const ll3 = baender[LL3_INDEX];
      let lauf = 0;
      const ll3Ende = ll3.offset + ll3.breite * ll3.hoehe;
      for (let i = ll3.offset; i < ll3Ende; i++) {
        lauf += roh[i];
        roh[i] = lauf;
      }

      for (const b of baender) {
        const pos = progQuant[k][b.quant];
        const pqf = 1 << pos;
        const ende = b.offset + b.breite * b.hoehe;
        const istLL3 = b.quant === QI_LL3;
        for (let i = b.offset; i < ende; i++) {
          const wert = roh[i];
          koeff[i] += wert * pqf;
          if (!istLL3) vorzeichen[i] = wert < 0 ? -1 : wert > 0 ? 1 : 0;
        }
        bitPos[b.quant] = pos;
      }
    }

    this.zeichne(zustand, kopf, quant, region, ergebnis);
  }

  /**
   * WBT_TILE_PROGRESSIVE_UPGRADE (2.2.4.2.1.5.5) - "Performing the Upgrade
   * Progressive Passes" (3.3.8.2.1.2).
   *
   * Der Block hat kein flags-Feld; auf progressiveQuality folgen unmittelbar
   * die sechs Laengen. Das ist der Unterschied zu WBT_TILE_PROGRESSIVE_FIRST,
   * an dem sich ein Parser leicht um ein Byte vertut.
   */
  private kachelAufwertung(
    rumpf: Buffer,
    region: Region,
    flaeche: Flaechenzustand,
    ergebnis: ProgressiveTile[],
  ): void {
    const r = new ProgLeser(rumpf);
    const kopf = liesKachelkopf(r);
    const progQuant = this.waehleProgQuant(r.u8('RFX_PROGRESSIVE_TILE_UPGRADE::progressiveQuality'), region);
    const laengen: number[] = [];
    for (const feld of ['ySrlLen', 'yRawLen', 'cbSrlLen', 'cbRawLen', 'crSrlLen', 'crRawLen']) {
      laengen.push(r.u16(`RFX_PROGRESSIVE_TILE_UPGRADE::${feld}`));
    }
    const srl: Buffer[] = [];
    const roh: Buffer[] = [];
    for (let k = 0; k < KOMPONENTEN; k++) {
      srl.push(r.bytes(laengen[k * 2], 'RFX_PROGRESSIVE_TILE_UPGRADE::SrlData'));
      roh.push(r.bytes(laengen[k * 2 + 1], 'RFX_PROGRESSIVE_TILE_UPGRADE::RawData'));
    }
    if (!r.eof) {
      throw new RdpProtocolError(
        `Progressive: hinter den Aufwertungsdaten stehen noch ${r.remaining} Byte, die keine Laengenangabe deckt`,
      );
    }

    const quant = this.waehleQuant(kopf, region);
    const zustand = this.kachel(flaeche, kopf);
    const baender = region.reduceExtrapolate ? BAENDER_EXTRAPOLIERT : BAENDER_KLASSISCH;

    for (let k = 0; k < KOMPONENTEN; k++) {
      const koeff = zustand.koeffizienten[k];
      const vorzeichen = zustand.vorzeichen[k];
      const bitPos = zustand.bitPos[k];
      const srlLeser = new SrlLeser(srl[k]);
      const rohLeser = new BitLeser(roh[k]);

      for (const b of baender) {
        const pos = progQuant[k][b.quant];
        const nBits = bitPos[b.quant] - pos;
        if (nBits === 0) {
          // 3.3.8.2.1.2: "a band in a given pass might not have any bits to
          // read. In this case, the decoder MUST skip the band". Wichtig: der
          // Nulllauf des SRL-Decoders laeuft dabei *nicht* weiter, weil hier
          // ueberhaupt keine Elemente gelesen werden.
          continue;
        }
        if (nBits < 0) {
          throw new RdpProtocolError(
            `Progressive: Aufwertung von Band ${b.name} soll von Bitposition ${bitPos[b.quant]} auf ${pos} ` +
              'steigen - eine Aufwertung kann die Qualitaet nicht verringern',
          );
        }
        const pqf = 1 << pos;
        const ende = b.offset + b.breite * b.hoehe;
        const istLL3 = b.quant === QI_LL3;

        for (let i = b.offset; i < ende; i++) {
          if (istLL3) {
            // 3.3.8.2.1.2: "When an LL3 element is decoded, input is always read
            // from the raw buffer and added to DecDwtQ." Kein Vorzeichen.
            koeff[i] += rohLeser.lies(nBits) * pqf;
            continue;
          }
          const s = vorzeichen[i];
          if (s === 0) {
            const wert = srlLeser.naechster(nBits);
            koeff[i] += wert * pqf;
            vorzeichen[i] = wert < 0 ? -1 : wert > 0 ? 1 : 0;
          } else {
            // Das Vorzeichen bleibt, was es war: im Rohstrom steht nur der
            // Betrag. Der durchgerechnete Fall in 4.1.2.2.5 bestaetigt das -
            // dort behaelt ein Element mit Sign = -1 sein Vorzeichen, obwohl
            // der gelesene Betrag positiv ist.
            const betrag = rohLeser.lies(nBits);
            koeff[i] += s > 0 ? betrag * pqf : -betrag * pqf;
          }
        }
        bitPos[b.quant] = pos;
      }
    }

    this.zeichne(zustand, kopf, quant, region, ergebnis);
  }

  /** quantIdxY/Cb/Cr in die Tabellen der Region aufloesen. */
  private waehleQuant(kopf: Kachelkopf, region: Region): Quanttabelle[] {
    const idx = [kopf.quantIdxY, kopf.quantIdxCb, kopf.quantIdxCr];
    return idx.map((i, k) => {
      if (i >= region.quantVals.length) {
        throw new RdpProtocolError(
          `Progressive: Kachel (${kopf.xIdx}, ${kopf.yIdx}) verweist mit quantIdx ${i} auf den ` +
            `${k + 1}. Quantisierungssatz, die Region liefert aber nur ${region.quantVals.length}`,
        );
      }
      return region.quantVals[i];
    });
  }

  /** progressiveQuality in die progressiven Tabellen der Region aufloesen. */
  private waehleProgQuant(quality: number, region: Region): Quanttabelle[] {
    // 2.2.4.2.1.5.4: "A value of 255 (0xFF) indicates a full progressive
    // quality table (the quality is 100%, and all the coefficients are zero)."
    if (quality === 0xff) return VOLLE_QUALITAET;
    if (quality >= region.quantProgVals.length) {
      throw new RdpProtocolError(
        `Progressive: progressiveQuality ${quality} verweist auf einen progressiven Quantisierungssatz, ` +
          `die Region liefert aber nur ${region.quantProgVals.length}`,
      );
    }
    return region.quantProgVals[quality];
  }

  private kachel(flaeche: Flaechenzustand, kopf: Kachelkopf): KachelZustand {
    const schluessel = (kopf.yIdx << 16) | kopf.xIdx;
    let z = flaeche.get(schluessel);
    if (!z) {
      z = neueKachel();
      flaeche.set(schluessel, z);
    }
    return z;
  }

  /**
   * Dequantisierung, inverse DWT und Farbumrechnung, danach Zuschnitt auf die
   * Rechtecke der Region.
   */
  private zeichne(
    zustand: KachelZustand,
    kopf: Kachelkopf,
    quant: Quanttabelle[],
    region: Region,
    ergebnis: ProgressiveTile[],
  ): void {
    const x0 = kopf.xIdx * KACHELKANTE;
    const y0 = kopf.yIdx * KACHELKANTE;

    // Erst den Zuschnitt bestimmen: eine Kachel, die kein Rechteck der Region
    // trifft, ist zwar Teil des Zustands, aber nichts zum Zeichnen - dann
    // bleibt der ganze Aufwand von Dequantisierung, DWT und Farbumrechnung
    // erspart.
    const ausschnitte: Rechteck[] = [];
    for (const rect of region.rects) {
      const xa = Math.max(x0, rect.x);
      const ya = Math.max(y0, rect.y);
      const xe = Math.min(x0 + KACHELKANTE, rect.x + rect.w);
      const ye = Math.min(y0 + KACHELKANTE, rect.y + rect.h);
      if (xa < xe && ya < ye) ausschnitte.push({ x: xa, y: ya, w: xe - xa, h: ye - ya });
    }
    if (ausschnitte.length === 0) return;

    const ebenen: Int32Array[] = [];
    for (let k = 0; k < KOMPONENTEN; k++) {
      const roh = dequantisiere(zustand.koeffizienten[k], quant[k], region.reduceExtrapolate);
      ebenen.push(inverseDwt(roh, region.reduceExtrapolate));
    }
    const rgba = ycbcrNachRgba(ebenen[0], ebenen[1], ebenen[2]);

    for (const { x: xa, y: ya, w, h } of ausschnitte) {
      if (w === KACHELKANTE && h === KACHELKANTE) {
        ergebnis.push({ x: xa, y: ya, width: w, height: h, rgba });
        continue;
      }
      const teil = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const q = ((ya - y0 + y) * KACHELKANTE + (xa - x0)) * 4;
        teil.set(rgba.subarray(q, q + w * 4), y * w * 4);
      }
      ergebnis.push({ x: xa, y: ya, width: w, height: h, rgba: teil });
    }
  }
}

// --- Hilfsfunktionen zum Einlesen -------------------------------------------

/**
 * RFX_COMPONENT_CODEC_QUANT (2.2.4.2.1.5.2): zehn Vierbitfelder in fuenf Byte,
 * in der Reihenfolge LL3, HL3, LH3, HH3, HL2, LH2, HH2, HL1, LH1, HH1.
 *
 * Das jeweils erste Feld eines Byte liegt im unteren Nibble. Belegt ist das
 * durch das Beispiel in MS-RDPRFX 4.2.4.1, wo das letzte Byte 0x98 als
 * HL1 = 8 und HH1 = 9 aufgeloest wird; die Aufzeichnung des Zielservers
 * bestaetigt es, weil nur diese Lesart monoton steigende Faktoren von LL3 nach
 * HH1 ergibt.
 */
function liesComponentQuant(r: ProgLeser, was: string): Quanttabelle {
  const werte: number[] = [];
  for (let i = 0; i < QUANT_BYTES; i++) {
    const b = r.u8(was);
    werte.push(b & 0x0f, b >> 4);
  }
  return werte;
}

/** Der gemeinsame Kopfteil aller drei Kachelarten. */
function liesKachelkopf(r: ProgLeser): Kachelkopf {
  return {
    quantIdxY: r.u8('RFX_PROGRESSIVE_TILE::quantIdxY'),
    quantIdxCb: r.u8('RFX_PROGRESSIVE_TILE::quantIdxCb'),
    quantIdxCr: r.u8('RFX_PROGRESSIVE_TILE::quantIdxCr'),
    xIdx: r.u16('RFX_PROGRESSIVE_TILE::xIdx'),
    yIdx: r.u16('RFX_PROGRESSIVE_TILE::yIdx'),
  };
}
