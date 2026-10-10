/**
 * Display Update Virtual Channel Extension (MS-RDPEDISP).
 *
 * Damit sagt der Client dem Server waehrend der laufenden Sitzung, wie gross
 * sein Desktop sein soll - ohne Neuverbindung. Der Server macht den Anfang und
 * nennt in einem DISPLAYCONTROL_CAPS_PDU seine Grenzen; danach darf der Client
 * beliebig oft ein DISPLAYCONTROL_MONITOR_LAYOUT_PDU schicken.
 *
 * Transport ist ein dynamischer virtueller Kanal (MS-RDPEDISP 2.1) mit dem
 * Namen `Microsoft::Windows::RDS::DisplayControl`. Anders als bei der Graphics
 * Pipeline gibt es hier *keine* ZGFX-Huelle - die Nutzdaten liegen roh auf dem
 * Kanal.
 *
 * Belegt an der Spezifikation, Fassung 10.0 vom 23.04.2024:
 *   2.2.1.1   DISPLAYCONTROL_HEADER
 *   2.2.2.1   DISPLAYCONTROL_CAPS_PDU
 *   2.2.2.2   DISPLAYCONTROL_MONITOR_LAYOUT_PDU
 *   2.2.2.2.1 DISPLAYCONTROL_MONITOR_LAYOUT
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';

/** Name des dynamischen Kanals (MS-RDPEDISP 2.1). */
export const DISPLAY_CONTROL_CHANNEL_NAME = 'Microsoft::Windows::RDS::DisplayControl';

// ------------------------------------------------- Konstanten der Spezifikation

/** DISPLAYCONTROL_PDU_TYPE_CAPS - Server an Client (2.2.1.1). */
export const DISPLAYCONTROL_PDU_TYPE_CAPS = 0x00000005;
/** DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT - Client an Server (2.2.1.1). */
export const DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT = 0x00000002;

/** Dieser Monitor ist der primaere (2.2.2.2.1, Feld Flags). */
export const DISPLAYCONTROL_MONITOR_PRIMARY = 0x00000001;

/** Laenge des DISPLAYCONTROL_HEADER in Bytes (2.2.1.1). */
export const DISPLAYCONTROL_HEADER_LAENGE = 8;
/** Laenge einer DISPLAYCONTROL_MONITOR_LAYOUT-Struktur (2.2.2.2, MonitorLayoutSize). */
export const MONITOR_LAYOUT_LAENGE = 40;
/** Laenge eines DISPLAYCONTROL_CAPS_PDU (2.2.2.1). */
export const CAPS_PDU_LAENGE = DISPLAYCONTROL_HEADER_LAENGE + 12;

/**
 * Grenzen der Felder Width und Height (2.2.2.2.1).
 *
 * Achtung beim Lesen der Spezifikation: die Forderung "MUST NOT be an odd
 * value" steht ausschliesslich bei **Width**. Fuer Height ist nur der Bereich
 * vorgeschrieben. Wir halten uns daran und runden nur die Breite gerade ab -
 * eine ungerade Hoehe ist zulaessig.
 */
export const MIN_MONITOR_BREITE = 200;
export const MAX_MONITOR_BREITE = 8192;
export const MIN_MONITOR_HOEHE = 200;
export const MAX_MONITOR_HOEHE = 8192;

/** Werte des Felds Orientation (2.2.2.2.1). */
export const ORIENTATION_LANDSCAPE = 0;
export const ORIENTATION_PORTRAIT = 90;
export const ORIENTATION_LANDSCAPE_FLIPPED = 180;
export const ORIENTATION_PORTRAIT_FLIPPED = 270;

/**
 * Zulaessige Werte des Felds DeviceScaleFactor (2.2.2.2.1). Jeder andere Wert
 * fuehrt dazu, dass der Server *beide* Skalierungsfelder verwirft.
 */
export const DEVICE_SCALE_FACTORS = [100, 140, 180] as const;
/** Bereich des Felds DesktopScaleFactor (2.2.2.2.1). */
export const MIN_DESKTOP_SCALE_FACTOR = 100;
export const MAX_DESKTOP_SCALE_FACTOR = 500;

/** Bereich, in dem PhysicalWidth/PhysicalHeight ueberhaupt beachtet werden (2.2.2.2.1). */
export const MIN_PHYSICAL_MM = 10;
export const MAX_PHYSICAL_MM = 10000;

// ------------------------------------------------------------------ Strukturen

/** DISPLAYCONTROL_HEADER (2.2.1.1). */
export interface DisplayControlHeader {
  /** DISPLAYCONTROL_PDU_TYPE_*. */
  type: number;
  /** Laenge des ganzen PDU **einschliesslich** dieser acht Kopfbytes. */
  length: number;
}

/** DISPLAYCONTROL_CAPS_PDU (2.2.2.1) - was der Server zulaesst. */
export interface DisplayControlCaps {
  /** Hoechstzahl der Monitore, die der Server unterstuetzt. */
  maxNumMonitors: number;
  /** Faktor A der Flaechengrenze. */
  maxMonitorAreaFactorA: number;
  /** Faktor B der Flaechengrenze. */
  maxMonitorAreaFactorB: number;
}

/** DISPLAYCONTROL_MONITOR_LAYOUT (2.2.2.2.1). */
export interface MonitorLayout {
  /** Bitmaske, derzeit nur DISPLAYCONTROL_MONITOR_PRIMARY. */
  flags: number;
  /** x-Koordinate der linken oberen Ecke, relativ zum primaeren Monitor. */
  left: number;
  /** y-Koordinate der linken oberen Ecke, relativ zum primaeren Monitor. */
  top: number;
  width: number;
  height: number;
  /** Physische Breite in Millimetern; 0 heisst "unbekannt, bitte ignorieren". */
  physicalWidth: number;
  /** Physische Hoehe in Millimetern; 0 heisst "unbekannt, bitte ignorieren". */
  physicalHeight: number;
  /** 0, 90, 180 oder 270. */
  orientation: number;
  /** Skalierung des Desktops in Prozent, 100..500. */
  desktopScaleFactor: number;
  /** Skalierung des Geraets in Prozent, 100, 140 oder 180. */
  deviceScaleFactor: number;
}

/**
 * Hoechstflaeche der gesamten Anordnung in Quadratpixeln (2.2.2.1).
 *
 * Die Spezifikation rechnet sie ausdruecklich als Produkt aller drei Felder -
 * MaxNumMonitors geht also mit ein, obwohl es dem Namen nach eine Stueckzahl ist.
 */
export function maximaleGesamtflaeche(caps: DisplayControlCaps): number {
  return caps.maxNumMonitors * caps.maxMonitorAreaFactorA * caps.maxMonitorAreaFactorB;
}

// --------------------------------------------------------------------- Lesen

export function parseDisplayControlHeader(buf: Buffer): DisplayControlHeader {
  if (buf.length < DISPLAYCONTROL_HEADER_LAENGE) {
    throw new RdpProtocolError(`EDISP: Kopf braucht ${DISPLAYCONTROL_HEADER_LAENGE} Byte, es kamen ${buf.length}`);
  }
  const r = new BinaryReader(buf);
  return { type: r.uint32le(), length: r.uint32le() };
}

/**
 * DISPLAYCONTROL_CAPS_PDU lesen (2.2.2.1).
 *
 * `Length` wird geprueft, aber nicht als Schnittgrenze benutzt: entscheidend
 * ist, dass die drei Felder wirklich da sind.
 */
export function parseCapsPdu(buf: Buffer): DisplayControlCaps {
  const kopf = parseDisplayControlHeader(buf);
  if (kopf.type !== DISPLAYCONTROL_PDU_TYPE_CAPS) {
    throw new RdpProtocolError(`EDISP: erwartet wurde ein CAPS-PDU, es kam Typ 0x${kopf.type.toString(16)}`);
  }
  if (buf.length < CAPS_PDU_LAENGE) {
    throw new RdpProtocolError(`EDISP: CAPS-PDU braucht ${CAPS_PDU_LAENGE} Byte, es kamen ${buf.length}`);
  }
  const r = new BinaryReader(buf);
  r.skip(DISPLAYCONTROL_HEADER_LAENGE);
  return {
    maxNumMonitors: r.uint32le(),
    maxMonitorAreaFactorA: r.uint32le(),
    maxMonitorAreaFactorB: r.uint32le(),
  };
}

/**
 * DISPLAYCONTROL_MONITOR_LAYOUT_PDU lesen (2.2.2.2).
 *
 * Der Client baut dieses PDU eigentlich nur, dies ist die Gegenrichtung fuer
 * Tests und den Mock-Server. `MonitorLayoutSize` wird ausgewertet statt
 * angenommen - ein Server, der die Struktur einmal verlaengert, bleibt lesbar.
 */
export function parseMonitorLayoutPdu(buf: Buffer): MonitorLayout[] {
  const kopf = parseDisplayControlHeader(buf);
  if (kopf.type !== DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT) {
    throw new RdpProtocolError(`EDISP: erwartet wurde ein MONITOR_LAYOUT-PDU, es kam Typ 0x${kopf.type.toString(16)}`);
  }
  if (buf.length < DISPLAYCONTROL_HEADER_LAENGE + 8) {
    throw new RdpProtocolError('EDISP: MONITOR_LAYOUT-PDU ist zu kurz fuer seine eigenen Laengenfelder');
  }
  const r = new BinaryReader(buf);
  r.skip(DISPLAYCONTROL_HEADER_LAENGE);
  const layoutGroesse = r.uint32le();
  const anzahl = r.uint32le();
  if (layoutGroesse < MONITOR_LAYOUT_LAENGE) {
    throw new RdpProtocolError(`EDISP: MonitorLayoutSize ${layoutGroesse} ist kleiner als die Struktur`);
  }
  const noetig = DISPLAYCONTROL_HEADER_LAENGE + 8 + anzahl * layoutGroesse;
  if (buf.length < noetig) {
    throw new RdpProtocolError(`EDISP: ${anzahl} Monitore brauchen ${noetig} Byte, es kamen ${buf.length}`);
  }

  const monitore: MonitorLayout[] = [];
  for (let i = 0; i < anzahl; i++) {
    const anfang = DISPLAYCONTROL_HEADER_LAENGE + 8 + i * layoutGroesse;
    const m = new BinaryReader(buf.subarray(anfang, anfang + layoutGroesse));
    monitore.push({
      flags: m.uint32le(),
      // Left und Top sind vorzeichenbehaftet: ein Monitor darf links vom
      // primaeren stehen und hat dann ein negatives Left.
      left: m.int32le(),
      top: m.int32le(),
      width: m.uint32le(),
      height: m.uint32le(),
      physicalWidth: m.uint32le(),
      physicalHeight: m.uint32le(),
      orientation: m.uint32le(),
      desktopScaleFactor: m.uint32le(),
      deviceScaleFactor: m.uint32le(),
    });
  }
  return monitore;
}

// -------------------------------------------------------------------- Bauen

/** DISPLAYCONTROL_CAPS_PDU bauen (2.2.2.1) - fuer Tests und Mock-Server. */
export function buildCapsPdu(caps: DisplayControlCaps): Buffer {
  return writer()
    .uint32le(DISPLAYCONTROL_PDU_TYPE_CAPS)
    .uint32le(CAPS_PDU_LAENGE)
    .uint32le(caps.maxNumMonitors)
    .uint32le(caps.maxMonitorAreaFactorA)
    .uint32le(caps.maxMonitorAreaFactorB)
    .toBuffer();
}

/**
 * DISPLAYCONTROL_MONITOR_LAYOUT_PDU bauen (2.2.2.2).
 *
 * Die Anordnung muss **vollstaendig** sein: auch wenn sich nur ein Monitor
 * aendert, gehoeren alle in die Liste.
 */
export function buildMonitorLayoutPdu(monitore: MonitorLayout[]): Buffer {
  if (monitore.length === 0) throw new RdpProtocolError('EDISP: eine Anordnung ohne Monitore gibt es nicht');
  const laenge = DISPLAYCONTROL_HEADER_LAENGE + 8 + monitore.length * MONITOR_LAYOUT_LAENGE;
  const w = writer()
    .uint32le(DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT)
    .uint32le(laenge)
    .uint32le(MONITOR_LAYOUT_LAENGE)
    .uint32le(monitore.length);
  for (const m of monitore) {
    w.uint32le(m.flags)
      // Negative Koordinaten gehen als Zweierkomplement raus; >>> 0 macht aus
      // -1 die 0xFFFFFFFF, die auf dem Draht stehen muss.
      .uint32le(m.left >>> 0)
      .uint32le(m.top >>> 0)
      .uint32le(m.width)
      .uint32le(m.height)
      .uint32le(m.physicalWidth)
      .uint32le(m.physicalHeight)
      .uint32le(m.orientation)
      .uint32le(m.desktopScaleFactor)
      .uint32le(m.deviceScaleFactor);
  }
  return w.toBuffer();
}

// ------------------------------------------------------------- Zurechtruecken

/** Nachster zulaessiger DeviceScaleFactor zu einem beliebigen Wunschwert. */
export function naechsterDeviceScaleFactor(wunsch: number): number {
  let beste = DEVICE_SCALE_FACTORS[0] as number;
  for (const kandidat of DEVICE_SCALE_FACTORS) {
    if (Math.abs(kandidat - wunsch) < Math.abs(beste - wunsch)) beste = kandidat;
  }
  return beste;
}

/**
 * Eine Wunschgroesse auf das bringen, was die Spezifikation erlaubt.
 *
 * Breite: 200..8192 und gerade (2.2.2.2.1). Hoehe: 200..8192.
 * Das Abrunden auf gerade Breite geschieht **nach** dem Begrenzen, damit aus
 * 8192 nicht durch eine ungerade Zwischenstufe 8191 wird.
 */
export function begrenzeMonitorGroesse(breite: number, hoehe: number): { width: number; height: number } {
  const b = Math.max(MIN_MONITOR_BREITE, Math.min(MAX_MONITOR_BREITE, Math.floor(breite) || MIN_MONITOR_BREITE));
  const h = Math.max(MIN_MONITOR_HOEHE, Math.min(MAX_MONITOR_HOEHE, Math.floor(hoehe) || MIN_MONITOR_HOEHE));
  return { width: b - (b % 2), height: h };
}

/**
 * Einen einzelnen primaeren Monitor beschreiben - der Normalfall fuer einen
 * Client, der genau ein Fenster zeigt.
 *
 * Die Groesse wird dabei bereits auf die Grenzen der Spezifikation gebracht.
 * `desktopScaleFactor` und `deviceScaleFactor` werden auf gueltige Werte
 * gezogen; ein ungueltiges Paar wuerde der Server sonst komplett verwerfen und
 * stillschweigend mit 100 % weiterarbeiten.
 */
export function primaerMonitor(
  breite: number,
  hoehe: number,
  skalierung?: { desktopScaleFactor?: number; deviceScaleFactor?: number },
): MonitorLayout {
  const { width, height } = begrenzeMonitorGroesse(breite, hoehe);
  const desktop = Math.max(
    MIN_DESKTOP_SCALE_FACTOR,
    Math.min(MAX_DESKTOP_SCALE_FACTOR, Math.round(skalierung?.desktopScaleFactor ?? 100)),
  );
  return {
    // Der primaere Monitor sitzt per Definition bei (0, 0) (2.2.2.2.1).
    flags: DISPLAYCONTROL_MONITOR_PRIMARY,
    left: 0,
    top: 0,
    width,
    height,
    // 0 liegt ausserhalb von 10..10000 mm und heisst damit "ignorieren".
    physicalWidth: 0,
    physicalHeight: 0,
    orientation: ORIENTATION_LANDSCAPE,
    desktopScaleFactor: desktop,
    deviceScaleFactor: naechsterDeviceScaleFactor(skalierung?.deviceScaleFactor ?? 100),
  };
}

/**
 * Mehrere Monitore nebeneinander beschreiben, der erste ist der primaere.
 *
 * Alle sitzen oben buendig, jeder rechts neben seinem Vorgaenger. Das haelt
 * alle Koordinaten nicht negativ: der primaere Monitor liegt bei (0, 0), und
 * damit faellt der Desktopursprung mit seinem zusammen. Jede Groesse wird wie
 * bei `primaerMonitor` auf die Grenzen der Spezifikation gebracht.
 */
export function anordnungNebeneinander(
  groessen: ReadonlyArray<{ width: number; height: number }>,
  skalierung?: { desktopScaleFactor?: number; deviceScaleFactor?: number },
): MonitorLayout[] {
  let links = 0;
  return groessen.map((g, i) => {
    const monitor = primaerMonitor(g.width, g.height, skalierung);
    if (i > 0) {
      monitor.flags = 0;
      monitor.left = links;
    }
    links += monitor.width;
    return monitor;
  });
}

/**
 * Prueft eine Anordnung gegen die Grenzen des Servers (2.2.2.2 und 3.2.5.2).
 *
 * Rueckgabe ist der Grund, warum die Anordnung nicht geschickt werden darf,
 * oder `undefined`, wenn alles passt. Ohne Caps vom Server gibt es nichts zu
 * pruefen - dann greift nur die Feldpruefung aus der Strukturbeschreibung.
 */
export function pruefeAnordnung(monitore: MonitorLayout[], caps?: DisplayControlCaps): string | undefined {
  if (monitore.length === 0) return 'Die Anordnung enthaelt keinen Monitor';
  for (const m of monitore) {
    if (m.width < MIN_MONITOR_BREITE || m.width > MAX_MONITOR_BREITE) {
      return `Breite ${m.width} liegt ausserhalb von ${MIN_MONITOR_BREITE}..${MAX_MONITOR_BREITE}`;
    }
    if (m.width % 2 !== 0) return `Breite ${m.width} ist ungerade`;
    if (m.height < MIN_MONITOR_HOEHE || m.height > MAX_MONITOR_HOEHE) {
      return `Hoehe ${m.height} liegt ausserhalb von ${MIN_MONITOR_HOEHE}..${MAX_MONITOR_HOEHE}`;
    }
  }
  if (!caps) return undefined;
  if (monitore.length > caps.maxNumMonitors) {
    return `${monitore.length} Monitore, der Server erlaubt hoechstens ${caps.maxNumMonitors}`;
  }
  const flaeche = monitore.reduce((summe, m) => summe + m.width * m.height, 0);
  const grenze = maximaleGesamtflaeche(caps);
  if (flaeche > grenze) return `Gesamtflaeche ${flaeche} uebersteigt die erlaubten ${grenze} Quadratpixel`;
  return undefined;
}
