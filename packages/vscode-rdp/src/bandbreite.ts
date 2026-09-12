/**
 * Bandbreitenprofile: vorgefertigte Saetze der TS_PERF_*-Flags, die im
 * Extended-Info-Paket (MS-RDPBCGR 2.2.1.11.1.1.1) an den Server gehen.
 *
 * Der Server schaltet daraufhin Effekte ab, die auf schmalen Leitungen viel
 * Bildaenderung fuer wenig Nutzen erzeugen - Hintergrundbild, Menueanimationen,
 * Designs, Schriftglaettung, Desktopkomposition.
 *
 * Die Konstanten stehen zwar auch in `ts-rdp` (protocol/sec.ts), werden von
 * dort aber nicht nach aussen gereicht. Sie sind hier deshalb noch einmal
 * benannt statt als nackte Hexzahlen im Code zu stehen.
 */

export const PERF_DISABLE_WALLPAPER = 0x00000001;
export const PERF_DISABLE_FULLWINDOWDRAG = 0x00000002;
export const PERF_DISABLE_MENUANIMATIONS = 0x00000004;
export const PERF_DISABLE_THEMING = 0x00000008;
export const PERF_DISABLE_CURSOR_SHADOW = 0x00000020;
export const PERF_DISABLE_CURSORSETTINGS = 0x00000040;
export const PERF_ENABLE_FONT_SMOOTHING = 0x00000080;
export const PERF_ENABLE_DESKTOP_COMPOSITION = 0x00000100;

export type BandbreitenProfilName = 'lan' | 'broadband' | 'mobile';

export interface BandbreitenProfil {
  titel: string;
  beschreibung: string;
  /** Die fertigen TS_PERF_*-Flags dieses Profils. */
  flags: number;
}

/**
 * Die drei Stufen orientieren sich an dem, was mstsc unter "Verbindungs-
 * geschwindigkeit" anbietet - von "alles an" bis "alles aus".
 */
export const BANDBREITEN_PROFILE: Record<BandbreitenProfilName, BandbreitenProfil> = {
  lan: {
    titel: 'LAN',
    beschreibung: 'Alle Effekte an, inklusive Desktopkomposition und Schriftglättung.',
    flags: PERF_ENABLE_FONT_SMOOTHING | PERF_ENABLE_DESKTOP_COMPOSITION,
  },
  broadband: {
    titel: 'Breitband',
    beschreibung: 'Hintergrundbild, Fensterinhalt beim Ziehen und Menüanimationen aus; Designs bleiben.',
    flags:
      PERF_DISABLE_WALLPAPER |
      PERF_DISABLE_FULLWINDOWDRAG |
      PERF_DISABLE_MENUANIMATIONS |
      PERF_ENABLE_FONT_SMOOTHING,
  },
  mobile: {
    titel: 'Mobil (langsam)',
    beschreibung: 'Alles aus: Hintergrundbild, Designs, Animationen, Schriftglättung, Zeigerschatten.',
    flags:
      PERF_DISABLE_WALLPAPER |
      PERF_DISABLE_FULLWINDOWDRAG |
      PERF_DISABLE_MENUANIMATIONS |
      PERF_DISABLE_THEMING |
      PERF_DISABLE_CURSOR_SHADOW |
      PERF_DISABLE_CURSORSETTINGS,
  },
};

/** Die Profilnamen in der Reihenfolge "viel Bandbreite zuerst". */
export const PROFIL_NAMEN: BandbreitenProfilName[] = ['lan', 'broadband', 'mobile'];

/** Ist der Wert einer der bekannten Profilnamen? */
export function istProfilName(wert: unknown): wert is BandbreitenProfilName {
  return typeof wert === 'string' && (PROFIL_NAMEN as string[]).includes(wert);
}

/** Liest eine Einstellung, die auch `undefined`/leer liefern darf. */
type EinzelEinstellung = <T>(schluessel: string, standard: T) => T;

/**
 * Die Performance-Flags fuer eine Sitzung.
 *
 * Ohne Profil bleibt es exakt beim bisherigen Verhalten: die fuenf einzelnen
 * `rdp.performance.*`-Schalter. Mit Profil gewinnt das Profil - es ist die
 * spezifischere Angabe, weil es an der Verbindung (oder an deren Ordner)
 * haengt und nicht global gilt.
 */
export function berechnePerformanceFlags(
  profil: BandbreitenProfilName | undefined,
  get: EinzelEinstellung,
): number {
  if (profil && BANDBREITEN_PROFILE[profil]) return BANDBREITEN_PROFILE[profil].flags;
  let flags = 0;
  if (get('performance.disableWallpaper', true)) flags |= PERF_DISABLE_WALLPAPER;
  if (get('performance.disableFullWindowDrag', true)) flags |= PERF_DISABLE_FULLWINDOWDRAG;
  if (get('performance.disableMenuAnimations', true)) flags |= PERF_DISABLE_MENUANIMATIONS;
  if (get('performance.disableThemes', false)) flags |= PERF_DISABLE_THEMING;
  if (get('performance.enableFontSmoothing', true)) flags |= PERF_ENABLE_FONT_SMOOTHING;
  return flags;
}

/**
 * Ordnet die `connection type` aus einer .rdp-Datei einem Profil zu.
 * Die Werte sind die von mstsc (MS-RDPBCGR TS_UD_CS_CORE / RDP-Datei).
 */
export function profilAusVerbindungsTyp(typ: number): BandbreitenProfilName | undefined {
  switch (typ) {
    case 1: // Modem (56 kBit/s)
    case 2: // Niedrige Geschwindigkeit (256 kBit/s - 2 MBit/s)
    case 3: // Satellit
      return 'mobile';
    case 4: // Hohe Geschwindigkeit (2 - 10 MBit/s)
    case 5: // WAN (10 MBit/s und mehr, hohe Latenz)
      return 'broadband';
    case 6: // LAN (10 MBit/s und mehr)
    case 7: // Automatische Erkennung
      return 'lan';
    default:
      return undefined;
  }
}
