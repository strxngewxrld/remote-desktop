/**
 * Zwischenablage ueber den statischen virtuellen Kanal `cliprdr`
 * (MS-RDPECLIP, Clipboard Virtual Channel Extension).
 *
 * Dieses Modul kennt nur Bytes und Text - es haengt weder am Client noch an
 * einem Betriebssystem. Gesendet wird ueber einen Rueckruf, den der Aufrufer
 * mitbringt (in der Regel `RdpClient.sendVirtualChannel('cliprdr', ...)`),
 * Eingehendes wird mit `verarbeite()` hineingereicht.
 *
 * Umgesetzt ist der Textteil des Protokolls: Handshake (CLIPRDR_CAPS,
 * CLIPRDR_MONITOR_READY, optional CLIPRDR_TEMP_DIRECTORY), die Ankuendigung
 * von Formaten (CLIPRDR_FORMAT_LIST samt Antwort) und der eigentliche
 * Datenaustausch (CLIPRDR_FORMAT_DATA_REQUEST/_RESPONSE). Dateiuebertragung
 * (FileGroupDescriptorW, CB_FILECONTENTS_*) ist ausdruecklich nicht dabei.
 *
 * Quellen (alle Abschnittsnummern aus [MS-RDPECLIP] 16.0 vom 23.04.2024):
 *  - 2.1     Transport: statischer Kanal, Name "CLIPRDR"
 *  - 2.2.1   CLIPRDR_HEADER: msgType(2) msgFlags(2) dataLen(4), Little Endian
 *  - 2.2.2.1 CLIPRDR_CAPS: clipHeader, cCapabilitiesSets(2), pad1(2), Saetze
 *  - 2.2.2.1.1   CLIPRDR_CAPS_SET: capabilitySetType(2), lengthCapability(2)
 *  - 2.2.2.1.1.1 CLIPRDR_GENERAL_CAPABILITY: + version(4), generalFlags(4)
 *  - 2.2.2.2 CLIPRDR_MONITOR_READY: nur der Kopf
 *  - 2.2.2.3 CLIPRDR_TEMP_DIRECTORY: clipHeader + wszTempDir(520 Byte)
 *  - 2.2.3.1 CLIPRDR_FORMAT_LIST: clipHeader + formatListData
 *  - 2.2.3.1.1.1 Short Format Name: formatId(4) + formatName(32 Byte)
 *  - 2.2.3.1.2.1 Long Format Name: formatId(4) + nullterminiertes UTF-16LE
 *  - 2.2.3.2 CLIPRDR_FORMAT_LIST_RESPONSE: nur der Kopf, Flag OK oder FAIL
 *  - 2.2.5.1 CLIPRDR_FORMAT_DATA_REQUEST: clipHeader + requestedFormatId(4)
 *  - 2.2.5.2 CLIPRDR_FORMAT_DATA_RESPONSE: clipHeader + requestedFormatData
 *  - 1.3.2.1 Initialisierungsreihenfolge
 *  - 6 Anhang A, Fussnote 1: manche Windows-Versionen haengen vier Byte an,
 *    die nicht in dataLen stecken und zu ignorieren sind.
 *
 * Die Textformate selbst sind Windows-Formate, nicht RDP-Formate; ihre
 * Bedeutung steht in "Standard Clipboard Formats" (Winuser.h):
 * CF_TEXT (1) und CF_UNICODETEXT (13) enden jede Zeile mit CR-LF, und ein
 * Nullzeichen beendet die Daten.
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';
import {
  CHANNEL_OPTION_COMPRESS_RDP,
  CHANNEL_OPTION_ENCRYPT_RDP,
  CHANNEL_OPTION_INITIALIZED,
  CHANNEL_OPTION_SHOW_PROTOCOL,
  ChannelDef,
} from './gcc.js';

// ------------------------------------------------------------------- Kanal

/**
 * Kanalname aus MS-RDPECLIP 2.1. Im Client Network Data steht er klein
 * geschrieben - der Name ist eine ASCII-Zeichenkette, und alle gaengigen
 * Clients (mstsc, FreeRDP) melden ihn als "cliprdr" an.
 */
export const CLIPRDR_CHANNEL_NAME = 'cliprdr';

/**
 * Optionsfeld des Kanals im Client Network Data (MS-RDPBCGR 2.2.1.3.4.1).
 *
 * Von den vier Bits traegt genau eines Bedeutung:
 *  - CHANNEL_OPTION_COMPRESS_RDP (0x00800000) erlaubt dem Server, die
 *    Kanaldaten mitzukomprimieren, wenn er ohnehin komprimiert. Zwischenablage
 *    ist Text, also genau der Fall, in dem sich das lohnt.
 *  - CHANNEL_OPTION_INITIALIZED, CHANNEL_OPTION_ENCRYPT_RDP und
 *    CHANNEL_OPTION_SHOW_PROTOCOL sind laut 2.2.1.3.4.1 ausdruecklich
 *    unbenutzt bzw. vom Server zu ignorieren. Ob der Kanalkopf sichtbar ist,
 *    entscheidet allein CHANNEL_FLAG_SHOW_PROTOCOL im Block selbst.
 *
 * Gesetzt werden sie trotzdem alle vier, weil mstsc genau diese Kombination
 * (0xC0A00000) sendet: es kostet nichts und faellt keinem Server auf.
 */
export const CLIPRDR_CHANNEL_OPTIONS =
  (CHANNEL_OPTION_INITIALIZED |
    CHANNEL_OPTION_ENCRYPT_RDP |
    CHANNEL_OPTION_COMPRESS_RDP |
    CHANNEL_OPTION_SHOW_PROTOCOL) >>>
  0;

/** Fertiger Eintrag fuer `RdpClientOptions.extraStaticChannels`. */
export const CLIPRDR_CHANNEL_DEF: ChannelDef = {
  name: CLIPRDR_CHANNEL_NAME,
  options: CLIPRDR_CHANNEL_OPTIONS,
};

// --------------------------------------------------------- Konstanten 2.2.1

export const CB_MONITOR_READY = 0x0001;
export const CB_FORMAT_LIST = 0x0002;
export const CB_FORMAT_LIST_RESPONSE = 0x0003;
export const CB_FORMAT_DATA_REQUEST = 0x0004;
export const CB_FORMAT_DATA_RESPONSE = 0x0005;
export const CB_TEMP_DIRECTORY = 0x0006;
export const CB_CLIP_CAPS = 0x0007;
export const CB_FILECONTENTS_REQUEST = 0x0008;
export const CB_FILECONTENTS_RESPONSE = 0x0009;
export const CB_LOCK_CLIPDATA = 0x000a;
export const CB_UNLOCK_CLIPDATA = 0x000b;

/**
 * Klarnamen der PDU-Typen fuer das Protokoll.
 *
 * Der Mitschnitt soll ohne Blick in die Spezifikation lesbar sein: wer im
 * Fehlerfall wissen will, an welcher Stelle von 1.3.2.1 der Ablauf stehen
 * bleibt, braucht die Namen und nicht die Zahlen.
 */
export const CLIPRDR_PDU_NAMEN: Record<number, string> = {
  [CB_MONITOR_READY]: 'MONITOR_READY',
  [CB_FORMAT_LIST]: 'FORMAT_LIST',
  [CB_FORMAT_LIST_RESPONSE]: 'FORMAT_LIST_RESPONSE',
  [CB_FORMAT_DATA_REQUEST]: 'FORMAT_DATA_REQUEST',
  [CB_FORMAT_DATA_RESPONSE]: 'FORMAT_DATA_RESPONSE',
  [CB_TEMP_DIRECTORY]: 'TEMP_DIRECTORY',
  [CB_CLIP_CAPS]: 'CLIP_CAPS',
  [CB_FILECONTENTS_REQUEST]: 'FILECONTENTS_REQUEST',
  [CB_FILECONTENTS_RESPONSE]: 'FILECONTENTS_RESPONSE',
  [CB_LOCK_CLIPDATA]: 'LOCK_CLIPDATA',
  [CB_UNLOCK_CLIPDATA]: 'UNLOCK_CLIPDATA',
};

/** Name eines PDU-Typs, sonst seine Nummer in Hexadezimalschreibweise. */
export function cliprdrPduName(msgType: number): string {
  return CLIPRDR_PDU_NAMEN[msgType] ?? `0x${msgType.toString(16).padStart(4, '0')}`;
}

export const CB_RESPONSE_OK = 0x0001;
export const CB_RESPONSE_FAIL = 0x0002;
export const CB_ASCII_NAMES = 0x0004;

/** Laenge des CLIPRDR_HEADER in Byte. */
export const CLIPRDR_HEADER_SIZE = 8;

// ----------------------------------------------------- Konstanten 2.2.2.1.1

export const CB_CAPSTYPE_GENERAL = 0x0001;
export const CB_CAPS_VERSION_1 = 0x00000001;
export const CB_CAPS_VERSION_2 = 0x00000002;

export const CB_USE_LONG_FORMAT_NAMES = 0x00000002;
export const CB_STREAM_FILECLIP_ENABLED = 0x00000004;
export const CB_FILECLIP_NO_FILE_PATHS = 0x00000008;
export const CB_CAN_LOCK_CLIPDATA = 0x00000010;
export const CB_HUGE_FILE_SUPPORT_ENABLED = 0x00000020;

/** Laenge eines General Capability Set samt seines eigenen Kopfes. */
export const CLIPRDR_GENERAL_CAPABILITY_SIZE = 12;

// ------------------------------------------------------- Windows-Formate

/** CF_TEXT: ANSI-Text, Zeilen mit CR-LF, abschliessendes Nullzeichen. */
export const CF_TEXT = 1;
/** CF_OEMTEXT: wie CF_TEXT, aber im OEM-Zeichensatz. */
export const CF_OEMTEXT = 7;
/** CF_UNICODETEXT: UTF-16LE, Zeilen mit CR-LF, abschliessendes Nullzeichen. */
export const CF_UNICODETEXT = 13;
/** CF_LOCALE: Gebietsschema, das Windows neben CF_TEXT ablegt. */
export const CF_LOCALE = 16;

/**
 * Textformate in der Reihenfolge, in der sie zu bevorzugen sind.
 *
 * CF_UNICODETEXT zuerst: nur dort geht kein Zeichen verloren. CF_TEXT ist die
 * Rueckfallebene fuer Server, die nichts anderes anbieten - dessen Zeichensatz
 * haengt an der Codepage der Sitzung und ist uns nicht bekannt.
 */
export const TEXTFORMATE_NACH_VORZUG = [CF_UNICODETEXT, CF_TEXT, CF_OEMTEXT] as const;

export function istTextformat(formatId: number): boolean {
  return formatId === CF_UNICODETEXT || formatId === CF_TEXT || formatId === CF_OEMTEXT;
}

// ------------------------------------------------------------ Kopf (2.2.1)

export interface CliprdrPdu {
  msgType: number;
  msgFlags: number;
  /** Angekuendigte Laenge des Rumpfes laut Kopf. */
  dataLen: number;
  /** Rumpf, bereits auf `dataLen` beschnitten. */
  body: Buffer;
}

/**
 * CLIPRDR_HEADER + Rumpf bauen.
 *
 * `dataLen` ist die Laenge des Rumpfes *ohne* den acht Byte langen Kopf.
 */
export function buildCliprdrPdu(msgType: number, msgFlags: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return writer().uint16le(msgType).uint16le(msgFlags).uint32le(body.length).bytes(body).toBuffer();
}

/**
 * CLIPRDR_HEADER lesen und den Rumpf abschneiden.
 *
 * Zwei Eigenheiten echter Server sind hier abgefangen:
 *  - Windows Server 2003 bis 2012 R2 haengen vier Byte an, die nicht in
 *    `dataLen` stecken (Anhang A, Fussnote 1). Deshalb wird der Rumpf auf
 *    `dataLen` gekuerzt und alles danach verworfen, statt es als Nutzdaten zu
 *    verstehen.
 *  - Faellt die Nachricht kuerzer aus als `dataLen` behauptet, wird genommen,
 *    was da ist. Eine harte Ablehnung wuerde eine ansonsten brauchbare
 *    Zwischenablage an einem Zaehlfehler des Servers scheitern lassen.
 */
export function parseCliprdrPdu(daten: Buffer): CliprdrPdu {
  if (daten.length < CLIPRDR_HEADER_SIZE) {
    throw new RdpProtocolError(
      `CLIPRDR: Nachricht kuerzer als der Kopf (${daten.length} von ${CLIPRDR_HEADER_SIZE} Byte)`,
    );
  }
  const r = new BinaryReader(daten);
  const msgType = r.uint16le();
  const msgFlags = r.uint16le();
  const dataLen = r.uint32le();
  const vorhanden = daten.length - CLIPRDR_HEADER_SIZE;
  const body = daten.subarray(CLIPRDR_HEADER_SIZE, CLIPRDR_HEADER_SIZE + Math.min(dataLen, vorhanden));
  return { msgType, msgFlags, dataLen, body };
}

// ---------------------------------------------------- Capabilities (2.2.2.1)

export interface CliprdrCapabilities {
  /** Version aus dem General Capability Set; nur zur Information. */
  version: number;
  generalFlags: number;
}

/**
 * CLIPRDR_CAPS mit genau einem General Capability Set.
 *
 * Mehr als einen Satz definiert die Spezifikation nicht (2.2.2.1.1 kennt nur
 * CB_CAPSTYPE_GENERAL), deshalb ist die Zahl hier fest.
 */
export function buildClipboardCapabilities(
  generalFlags: number,
  version: number = CB_CAPS_VERSION_2,
): Buffer {
  const satz = writer()
    .uint16le(CB_CAPSTYPE_GENERAL)
    .uint16le(CLIPRDR_GENERAL_CAPABILITY_SIZE)
    .uint32le(version)
    .uint32le(generalFlags)
    .toBuffer();
  const body = writer()
    .uint16le(1) // cCapabilitiesSets
    .uint16le(0) // pad1
    .bytes(satz)
    .toBuffer();
  return buildCliprdrPdu(CB_CLIP_CAPS, 0x0000, body);
}

/**
 * Rumpf eines CLIPRDR_CAPS lesen.
 *
 * Unbekannte Satztypen werden ueber `lengthCapability` uebersprungen. Fehlt der
 * General Capability Set ganz, gelten laut 2.2.2.1.1.1 die Vorgabewerte - also
 * `generalFlags = 0`, und damit kurze Formatnamen.
 */
export function parseClipboardCapabilities(body: Buffer): CliprdrCapabilities {
  const ergebnis: CliprdrCapabilities = { version: 0, generalFlags: 0 };
  if (body.length < 4) return ergebnis;
  const r = new BinaryReader(body);
  const anzahl = r.uint16le();
  r.uint16le(); // pad1
  for (let i = 0; i < anzahl && r.remaining >= 4; i++) {
    const typ = r.uint16le();
    const laenge = r.uint16le();
    // lengthCapability zaehlt die vier Byte des eigenen Kopfes mit.
    const rumpfLaenge = Math.min(Math.max(laenge - 4, 0), r.remaining);
    const rumpf = r.bytes(rumpfLaenge);
    if (typ === CB_CAPSTYPE_GENERAL && rumpf.length >= 8) {
      ergebnis.version = rumpf.readUInt32LE(0);
      ergebnis.generalFlags = rumpf.readUInt32LE(4);
    }
  }
  return ergebnis;
}

// ---------------------------------------------------- Monitor Ready (2.2.2.2)

export function buildMonitorReady(): Buffer {
  return buildCliprdrPdu(CB_MONITOR_READY, 0x0000);
}

// -------------------------------------------------- Temp Directory (2.2.2.3)

/** Feste Groesse des Feldes wszTempDir in Byte (260 UTF-16-Zeichen). */
export const TEMP_DIRECTORY_SIZE = 520;

/**
 * CLIPRDR_TEMP_DIRECTORY (optional, nur fuer Dateiuebertragung von Belang).
 *
 * Der Pfad wird als nullterminiertes UTF-16LE in ein Feld fester Groesse
 * geschrieben; ueberzaehlige Zeichen werden abgeschnitten, damit das
 * abschliessende Nullzeichen erhalten bleibt.
 */
export function buildTempDirectory(pfad: string): Buffer {
  const hoechstens = TEMP_DIRECTORY_SIZE / 2 - 1;
  const gekuerzt = pfad.length > hoechstens ? pfad.substring(0, hoechstens) : pfad;
  const body = writer().utf16le(gekuerzt + '\0', TEMP_DIRECTORY_SIZE).toBuffer();
  return buildCliprdrPdu(CB_TEMP_DIRECTORY, 0x0000, body);
}

export function parseTempDirectory(body: Buffer): string {
  return new BinaryReader(body).utf16le(Math.min(TEMP_DIRECTORY_SIZE, body.length));
}

// ------------------------------------------------------ Format List (2.2.3.1)

export interface CliprdrFormat {
  formatId: number;
  /** Leer, wenn das Format keinen Namen traegt (die Standardformate etwa). */
  name: string;
}

export interface FormatListOptions {
  /**
   * Lange Formatnamen verwenden (CB_USE_LONG_FORMAT_NAMES). Nur zulaessig,
   * wenn *beide* Seiten das Flag gesetzt haben (2.2.2.1.1.1).
   */
  longFormatNames: boolean;
  /**
   * Kurze Formatnamen in ASCII statt UTF-16 schreiben. Setzt zusaetzlich
   * CB_ASCII_NAMES im Kopf (2.2.3.1). Bei langen Namen bedeutungslos: dort
   * sind Unicode-Namen vorgeschrieben.
   */
  asciiNames?: boolean;
}

/** Feste Groesse des Namensfeldes einer CLIPRDR_SHORT_FORMAT_NAME. */
export const SHORT_FORMAT_NAME_SIZE = 32;

/**
 * CLIPRDR_FORMAT_LIST bauen.
 *
 * Eine leere Liste ist zulaessig und heisst "meine Zwischenablage ist leer" -
 * genau das schickt der Client im Handshake, solange er nichts anzubieten hat.
 */
export function buildFormatList(formate: readonly CliprdrFormat[], opts: FormatListOptions): Buffer {
  const w = writer();
  for (const format of formate) {
    w.uint32le(format.formatId);
    if (opts.longFormatNames) {
      // 2.2.3.1.2.1: nullterminiertes UTF-16LE. Formate ohne Namen bekommen
      // ein einzelnes Nullzeichen, nicht etwa gar nichts.
      w.utf16leNul(format.name ?? '');
    } else if (opts.asciiNames) {
      w.ascii(format.name ?? '', SHORT_FORMAT_NAME_SIZE);
    } else {
      w.utf16le(format.name ?? '', SHORT_FORMAT_NAME_SIZE);
    }
  }
  const flags = !opts.longFormatNames && opts.asciiNames ? CB_ASCII_NAMES : 0x0000;
  return buildCliprdrPdu(CB_FORMAT_LIST, flags, w.toBuffer());
}

/**
 * Rumpf einer CLIPRDR_FORMAT_LIST lesen.
 *
 * Welche Variante vorliegt, verraet der Rumpf nicht selbst - sie haengt an den
 * ausgehandelten Faehigkeiten. Deshalb muss der Aufrufer `longFormatNames`
 * mitgeben; `asciiNames` steht dagegen im Kopf (CB_ASCII_NAMES).
 */
export function parseFormatList(
  body: Buffer,
  opts: { longFormatNames: boolean; asciiNames?: boolean },
): CliprdrFormat[] {
  const formate: CliprdrFormat[] = [];
  const r = new BinaryReader(body);
  if (opts.longFormatNames) {
    while (r.remaining >= 4) {
      const formatId = r.uint32le();
      // Bis zum ersten UTF-16-Nullzeichen lesen. Fehlt es (abgeschnittene
      // Nachricht), gilt der Rest als Name.
      let laenge = 0;
      while (laenge + 1 < r.remaining && !(body[r.offset + laenge] === 0 && body[r.offset + laenge + 1] === 0)) {
        laenge += 2;
      }
      const name = r.bytes(laenge).toString('ucs2');
      if (r.remaining >= 2) r.skip(2); // das Nullzeichen
      formate.push({ formatId, name });
    }
    return formate;
  }

  const eintrag = 4 + SHORT_FORMAT_NAME_SIZE;
  while (r.remaining >= eintrag) {
    const formatId = r.uint32le();
    const roh = r.bytes(SHORT_FORMAT_NAME_SIZE);
    const entschluesselt = opts.asciiNames ? roh.toString('ascii') : roh.toString('ucs2');
    // Der Name endet am ersten Nullzeichen; dahinter steht nur Auffuellung.
    const ende = entschluesselt.indexOf('\0');
    formate.push({ formatId, name: ende < 0 ? entschluesselt : entschluesselt.substring(0, ende) });
  }
  return formate;
}

// --------------------------------------------- Format List Response (2.2.3.2)

export function buildFormatListResponse(erfolgreich: boolean): Buffer {
  return buildCliprdrPdu(CB_FORMAT_LIST_RESPONSE, erfolgreich ? CB_RESPONSE_OK : CB_RESPONSE_FAIL);
}

// ---------------------------------------------- Format Data Request (2.2.5.1)

export function buildFormatDataRequest(formatId: number): Buffer {
  return buildCliprdrPdu(CB_FORMAT_DATA_REQUEST, 0x0000, writer().uint32le(formatId).toBuffer());
}

export function parseFormatDataRequest(body: Buffer): number {
  if (body.length < 4) throw new RdpProtocolError('CLIPRDR: Format Data Request ohne requestedFormatId');
  return body.readUInt32LE(0);
}

// --------------------------------------------- Format Data Response (2.2.5.2)

/** Erfolgreiche Antwort mit Nutzdaten. */
export function buildFormatDataResponse(daten: Buffer): Buffer {
  return buildCliprdrPdu(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_OK, daten);
}

/**
 * Abschlaegige Antwort.
 *
 * Wichtig fuer die Bedienbarkeit: wer auf eine Anfrage gar nicht antwortet,
 * laesst die Gegenseite in einen Zeitablauf laufen - unter Windows haengt dann
 * das einfuegende Programm sekundenlang.
 */
export function buildFormatDataResponseFehler(): Buffer {
  return buildCliprdrPdu(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_FAIL);
}

// ------------------------------------------------------- Text und Zeilenenden

/**
 * Zeilenenden auf die Windows-Schreibweise bringen.
 *
 * CF_TEXT und CF_UNICODETEXT schreiben CR-LF vor. Ein macOS- oder Linux-Text
 * mit blossem LF kommt in Windows-Programmen sonst als eine einzige Zeile an
 * (Notepad zeigt Kaestchen), und das ist der haeufigste Fehler ueberhaupt bei
 * der Zwischenablage ueber RDP.
 *
 * Bereits vorhandene CR-LF bleiben CR-LF; ein einzelnes CR (alte Mac-Texte)
 * wird ebenfalls zu CR-LF. Zweimaliges Anwenden aendert nichts mehr.
 */
export function zeilenendenNachWindows(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

/**
 * Zeilenenden auf die lokale Schreibweise bringen (LF).
 *
 * Bewusst nicht plattformabhaengig: VS Code, macOS und Linux arbeiten mit LF,
 * und ein Editor unter Windows kommt mit LF ebenfalls zurecht. Umgekehrt
 * waeren CR-Zeichen in einer Shell oder in JSON-Dateien echter Aerger.
 */
export function zeilenendenNachLokal(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

/**
 * Text als CF_UNICODETEXT kodieren: UTF-16LE, CR-LF, abschliessendes
 * Nullzeichen.
 *
 * Das Nullzeichen ist kein Beiwerk: Windows liest den Puffer bis dorthin. Ohne
 * es haengt an den eingefuegten Text an, was gerade hinter dem Puffer im
 * Speicher steht.
 */
export function kodiereUnicodeText(text: string): Buffer {
  return Buffer.from(zeilenendenNachWindows(text) + '\0', 'ucs2');
}

/**
 * CF_UNICODETEXT lesen: bis zum ersten Nullzeichen, Zeilenenden nach LF.
 *
 * Eine ungerade Byte-Zahl (die vier angehaengten Byte aus Anhang A schlagen
 * hier durch, wenn ein Server sie doch mitzaehlt) wird abgerundet, statt ein
 * halbes Zeichen zu erzeugen.
 */
export function dekodiereUnicodeText(daten: Buffer): string {
  const geradzahlig = daten.subarray(0, daten.length - (daten.length % 2));
  const roh = geradzahlig.toString('ucs2');
  const ende = roh.indexOf('\0');
  return zeilenendenNachLokal(ende < 0 ? roh : roh.substring(0, ende));
}

/**
 * Text als CF_TEXT kodieren.
 *
 * CF_TEXT ist ANSI, und welche Codepage gilt, haengt an der Sitzung des
 * Servers - das Protokoll sagt es uns nicht. Genommen wird latin1: fuer den
 * westeuropaeischen Fall deckungsgleich mit Windows-1252, und Zeichen
 * ausserhalb werden zu '?', statt den Puffer zu verschieben. Wer verlustfrei
 * arbeiten will, nimmt CF_UNICODETEXT - deshalb steht es im Vorzug vorn.
 */
export function kodiereAnsiText(text: string): Buffer {
  const mitCrlf = zeilenendenNachWindows(text);
  const ersetzt = Array.from(mitCrlf, (z) => (z.charCodeAt(0) <= 0xff ? z : '?')).join('');
  return Buffer.from(ersetzt + '\0', 'latin1');
}

/** CF_TEXT lesen: bis zum ersten Nullbyte, Zeilenenden nach LF. */
export function dekodiereAnsiText(daten: Buffer): string {
  const ende = daten.indexOf(0);
  const roh = (ende < 0 ? daten : daten.subarray(0, ende)).toString('latin1');
  return zeilenendenNachLokal(roh);
}

/** Text im angegebenen Windows-Format kodieren. */
export function kodiereText(text: string, formatId: number): Buffer {
  return formatId === CF_UNICODETEXT ? kodiereUnicodeText(text) : kodiereAnsiText(text);
}

/** Text aus dem angegebenen Windows-Format lesen. */
export function dekodiereText(daten: Buffer, formatId: number): string {
  return formatId === CF_UNICODETEXT ? dekodiereUnicodeText(daten) : dekodiereAnsiText(daten);
}

/**
 * Das beste von uns unterstuetzte Textformat aus einer Formatliste waehlen.
 * Liefert `undefined`, wenn gar kein Text dabei ist (etwa nur ein Bild oder
 * eine Dateiliste).
 */
export function waehleTextformat(formate: readonly CliprdrFormat[]): number | undefined {
  for (const bevorzugt of TEXTFORMATE_NACH_VORZUG) {
    if (formate.some((f) => f.formatId === bevorzugt)) return bevorzugt;
  }
  return undefined;
}

// ------------------------------------------------------------------ Sitzung

/**
 * Erlaubte Richtungen.
 *
 *  - `beide`      - lesen und schreiben
 *  - `nurLesen`   - nur vom Server zu uns (Server kopiert, wir fuegen ein)
 *  - `nurSchreiben` - nur von uns zum Server
 *  - `aus`        - gar nichts; der Kanal wird dann gar nicht erst bedient
 */
export type ZwischenablageRichtung = 'beide' | 'nurLesen' | 'nurSchreiben' | 'aus';

/** Stufen des Sitzungsprotokolls, passend zu `Logger` aus `core/log.ts`. */
export type CliprdrLogStufe = 'info' | 'debug' | 'warn';

export interface CliprdrSessionOptions {
  /** Fertige CLIPRDR-Nachricht auf den Kanal geben. */
  send(daten: Buffer): void;
  /** Standard: `beide`. */
  richtung?: ZwischenablageRichtung;
  /**
   * Obergrenze fuer die Nutzdaten eines Formats in Byte, in beide Richtungen.
   * Standard 1 MiB. Ein Server soll uns nicht ueber die Zwischenablage
   * vollaufen lassen, und wir ihn nicht.
   */
  maxBytes?: number;
  /** Neuer Text vom Server (bereits mit lokalen Zeilenenden). */
  onServerText?(text: string): void;
  /**
   * Liefert den Text, den der Server bekommen soll, wenn er danach fragt.
   * `undefined` heisst "nichts da" und fuehrt zu CB_RESPONSE_FAIL.
   *
   * Bewusst synchron: CB_FORMAT_DATA_REQUEST will sofort eine Antwort, und
   * geliefert werden muss ohnehin genau der Text, der vorher angekuendigt
   * wurde - ein inzwischen neuerer waere falsch. Dass beim Handshake schon
   * etwas da ist, stellt `onBereit` sicher.
   */
  leseLokalenText?(): string | undefined;
  /**
   * Der Handshake ist durch (1.3.2.1 abgeschlossen), ab jetzt darf gemeldet
   * werden.
   *
   * Der Grund fuer diesen Rueckruf: `leseLokalenText()` ist synchron, die
   * Zwischenablage des Editors aber nicht. Faellt MONITOR_READY vor die erste
   * gelungene Lesung, kuendigt der Handshake eine leere Formatliste an - und
   * der Server fragt dann nie nach Daten, weil er glaubt, es gebe keine. Hier
   * kann der Aufrufer nachlesen und mit `melde()` richtigstellen.
   */
  onBereit?(): void;
  /**
   * Meldungen fuer das Sitzungsprotokoll.
   *
   * Die Stufe ist bewusst nachgestellt und darf fehlen - dann gilt `info`.
   * `debug` traegt den Ablauf PDU fuer PDU mit; das ist das Einzige, womit
   * sich im Nachhinein sagen laesst, an welcher Stelle des Handshakes aus
   * 1.3.2.1 eine Sitzung stehen geblieben ist.
   */
  log?(nachricht: string, stufe?: CliprdrLogStufe): void;
  /**
   * Optionales Verzeichnis fuer CLIPRDR_TEMP_DIRECTORY. Ohne Angabe wird das
   * PDU weggelassen - es betrifft ausschliesslich Dateiuebertragung.
   */
  tempDirectory?: string;
}

/** Standardgrenze fuer Zwischenablage-Nutzdaten: 1 MiB. */
export const STANDARD_MAX_BYTES = 1024 * 1024;

/**
 * Zustandsmaschine des Clients auf dem Kanal `cliprdr`.
 *
 * Sie kennt vier Ablaeufe:
 *
 *  1. Handshake. Der Server schickt CLIPRDR_CAPS und CLIPRDR_MONITOR_READY.
 *     Auf MONITOR_READY antworten wir mit unseren Faehigkeiten, optional dem
 *     Temp-Verzeichnis und einer ersten Formatliste (1.3.2.1).
 *  2. Der Server hat kopiert: CB_FORMAT_LIST kommt herein. Wir bestaetigen
 *     und fragen - sofern wir lesen duerfen - die Daten des besten Textformats
 *     an.
 *  3. Die Antwort CB_FORMAT_DATA_RESPONSE bringt den Text; er geht an
 *     `onServerText`.
 *  4. Wir haben kopiert: `melde()` schickt eine Formatliste. Fragt der Server
 *     daraufhin mit CB_FORMAT_DATA_REQUEST nach, antworten wir aus
 *     `leseLokalenText()`.
 */
export class CliprdrSession {
  /** Faehigkeiten, die wir selbst ankuendigen. */
  private readonly eigeneFlags = CB_USE_LONG_FORMAT_NAMES;
  private serverFlags = 0;
  private serverCapsGesehen = false;
  private bereit = false;
  /** Formate, die der Server zuletzt angeboten hat. */
  private serverFormate: CliprdrFormat[] = [];
  /** Format, dessen Daten wir gerade angefragt haben. */
  private offeneAnfrage: number | undefined;
  /** Zuletzt gemeldeter eigener Text - verhindert Endlosschleifen. */
  private zuletztGemeldet: string | undefined;
  /** Warnungen, die bereits herausgegangen sind (je Kennung nur einmal). */
  private readonly gewarnt = new Set<string>();
  /** Gezaehlte PDUs - beantwortet im Nachhinein "war da ueberhaupt Verkehr?". */
  private empfangen = 0;
  private gesendet = 0;
  /**
   * Eine gesendete Formatliste wartet noch auf CB_FORMAT_LIST_RESPONSE.
   *
   * Der Server ist laut 3.1.5.2 zur Antwort verpflichtet. Bleibt sie aus, ist
   * der Ablauf genau hier stehen geblieben - und das ist von aussen sonst
   * nicht zu sehen, weil ein stiller Kanal wie ein ruhiger Kanal aussieht.
   */
  private formatlisteUnbestaetigt = false;

  constructor(private readonly opts: CliprdrSessionOptions) {}

  get richtung(): ZwischenablageRichtung {
    return this.opts.richtung ?? 'beide';
  }

  /** Duerfen wir Text vom Server uebernehmen? */
  get darfLesen(): boolean {
    return this.richtung === 'beide' || this.richtung === 'nurLesen';
  }

  /** Duerfen wir Text an den Server geben? */
  get darfSchreiben(): boolean {
    return this.richtung === 'beide' || this.richtung === 'nurSchreiben';
  }

  get maxBytes(): number {
    const wert = this.opts.maxBytes;
    return wert !== undefined && Number.isFinite(wert) && wert > 0 ? Math.floor(wert) : STANDARD_MAX_BYTES;
  }

  /** Ist der Handshake so weit, dass wir senden duerfen? */
  get istBereit(): boolean {
    return this.bereit;
  }

  /** Steht eine gesendete Formatliste noch ohne Antwort des Servers da? */
  get wartetAufFormatlistenAntwort(): boolean {
    return this.formatlisteUnbestaetigt;
  }

  /** Gezaehlte PDUs beider Richtungen, fuer Fehlermeldungen und Diagnose. */
  get zaehler(): { gesendet: number; empfangen: number } {
    return { gesendet: this.gesendet, empfangen: this.empfangen };
  }

  /** Nutzt die Gegenseite lange Formatnamen? Nur wenn *beide* Seiten es tun. */
  get langeFormatnamen(): boolean {
    return (this.serverFlags & CB_USE_LONG_FORMAT_NAMES) !== 0 && (this.eigeneFlags & CB_USE_LONG_FORMAT_NAMES) !== 0;
  }

  private protokoll(nachricht: string, stufe: CliprdrLogStufe = 'info'): void {
    this.opts.log?.(nachricht, stufe);
  }

  /**
   * Eine Warnung genau einmal je Auffaelligkeit abgeben.
   *
   * Zwischenablage-Fehler wiederholen sich bei jedem Kopiervorgang; eine
   * Warnung je Vorgang macht den Mitschnitt unlesbar und verdeckt gerade die
   * Zeile, auf die es ankommt.
   */
  private warneEinmal(kennung: string, nachricht: string): void {
    if (this.gewarnt.has(kennung)) return;
    this.gewarnt.add(kennung);
    this.protokoll(nachricht, 'warn');
  }

  private sende(daten: Buffer): void {
    const kopf = daten.length >= CLIPRDR_HEADER_SIZE ? parseCliprdrPdu(daten) : undefined;
    if (kopf) {
      this.gesendet++;
      this.protokoll(
        `CLIPRDR: gesendet ${cliprdrPduName(kopf.msgType)}, Flags 0x${kopf.msgFlags
          .toString(16)
          .padStart(4, '0')}, ${kopf.dataLen} Byte Rumpf`,
        'debug',
      );
    }
    this.opts.send(daten);
  }

  /**
   * Eine vollstaendig zusammengesetzte Nachricht des Kanals verarbeiten.
   *
   * Wirft nicht: ein unverstaendliches PDU wird protokolliert und verworfen.
   * Eine kaputte Zwischenablage darf keine Sitzung beenden.
   */
  verarbeite(daten: Buffer): void {
    let pdu: CliprdrPdu;
    try {
      pdu = parseCliprdrPdu(daten);
    } catch (err) {
      this.protokoll(`CLIPRDR: Nachricht verworfen - ${(err as Error).message}`);
      return;
    }

    this.empfangen++;
    this.protokoll(
      `CLIPRDR: empfangen ${cliprdrPduName(pdu.msgType)}, Flags 0x${pdu.msgFlags
        .toString(16)
        .padStart(4, '0')}, ${pdu.dataLen} Byte Rumpf`,
      'debug',
    );

    try {
      switch (pdu.msgType) {
        case CB_CLIP_CAPS:
          this.behandleCaps(pdu);
          break;
        case CB_MONITOR_READY:
          this.behandleMonitorReady();
          break;
        case CB_FORMAT_LIST:
          this.behandleFormatList(pdu);
          break;
        case CB_FORMAT_LIST_RESPONSE:
          this.formatlisteUnbestaetigt = false;
          if ((pdu.msgFlags & CB_RESPONSE_FAIL) !== 0) {
            this.protokoll('CLIPRDR: der Server hat unsere Formatliste abgelehnt', 'warn');
          } else {
            this.protokoll('CLIPRDR: der Server hat unsere Formatliste bestaetigt', 'debug');
          }
          break;
        case CB_FORMAT_DATA_REQUEST:
          this.behandleFormatDataRequest(pdu);
          break;
        case CB_FORMAT_DATA_RESPONSE:
          this.behandleFormatDataResponse(pdu);
          break;
        case CB_FILECONTENTS_REQUEST:
          // Dateiuebertragung ist nicht umgesetzt. Wir kuendigen sie auch nicht
          // an (kein CB_STREAM_FILECLIP_ENABLED), also sollte das nie kommen -
          // wenn doch, darf der Server nicht in einen Zeitablauf laufen.
          this.protokoll('CLIPRDR: Dateianfrage abgelehnt - Dateiuebertragung ist nicht umgesetzt');
          this.sende(buildCliprdrPdu(CB_FILECONTENTS_RESPONSE, CB_RESPONSE_FAIL, writer().uint32le(0).toBuffer()));
          break;
        default:
          this.protokoll(`CLIPRDR: PDU-Typ 0x${pdu.msgType.toString(16)} wird nicht behandelt`);
      }
    } catch (err) {
      this.protokoll(`CLIPRDR: Fehler beim Verarbeiten von 0x${pdu.msgType.toString(16)} - ${(err as Error).message}`);
    }
  }

  private behandleCaps(pdu: CliprdrPdu): void {
    const caps = parseClipboardCapabilities(pdu.body);
    this.serverFlags = caps.generalFlags;
    this.serverCapsGesehen = true;
    this.protokoll(
      `CLIPRDR: Server-Faehigkeiten Version ${caps.version}, Flags 0x${caps.generalFlags.toString(16)}` +
        `${this.langeFormatnamen ? ' (lange Formatnamen)' : ' (kurze Formatnamen)'}`,
    );
  }

  /**
   * Antwort auf CLIPRDR_MONITOR_READY, in der Reihenfolge aus 1.3.2.1:
   * Faehigkeiten, dann optional das Temp-Verzeichnis, dann eine Formatliste.
   */
  private behandleMonitorReady(): void {
    if (!this.serverCapsGesehen) {
      // Zulaessig: CLIPRDR_CAPS ist optional (2.2.2.1). Dann gelten die
      // Vorgabewerte, also kurze Formatnamen.
      this.protokoll('CLIPRDR: Monitor Ready ohne vorherige Server-Faehigkeiten - es gelten die Vorgaben');
    }
    this.sende(buildClipboardCapabilities(this.eigeneFlags, CB_CAPS_VERSION_2));
    if (this.opts.tempDirectory) this.sende(buildTempDirectory(this.opts.tempDirectory));
    this.bereit = true;

    // Der Abschluss des Handshakes ist eine Formatliste - auch eine leere.
    // Wer sie weglaesst, bekommt von Windows keine Zwischenablage.
    const text = this.darfSchreiben ? this.opts.leseLokalenText?.() : undefined;
    this.sendeFormatliste(text);
    // Angekuendigt ist angekuendigt: sonst meldet die erste Aenderungspruefung
    // denselben Text gleich noch einmal. "Nichts da" und "leerer Text" sind
    // dabei dasselbe - beides ergibt eine leere Formatliste.
    this.zuletztGemeldet = text ?? '';
    this.protokoll(`CLIPRDR: Handshake abgeschlossen (Richtung: ${this.richtung})`);
    if (text === undefined && this.darfSchreiben) {
      this.protokoll(
        'CLIPRDR: beim Handshake war noch kein lokaler Text bekannt - die Formatliste ' +
          'wird nachgereicht, sobald die Zwischenablage gelesen ist',
        'debug',
      );
    }
    this.opts.onBereit?.();
  }

  private behandleFormatList(pdu: CliprdrPdu): void {
    this.serverFormate = parseFormatList(pdu.body, {
      longFormatNames: this.langeFormatnamen,
      asciiNames: (pdu.msgFlags & CB_ASCII_NAMES) !== 0,
    });
    // Bestaetigt wird immer, auch wenn wir nichts davon brauchen koennen:
    // ohne Antwort wartet Windows und meldet spaeter einen Kanalfehler.
    this.sende(buildFormatListResponse(true));

    if (!this.darfLesen) {
      this.protokoll('CLIPRDR: Formatliste des Servers ignoriert - Lesen ist abgeschaltet');
      return;
    }
    this.protokoll(
      `CLIPRDR: der Server bietet ${this.serverFormate.length} Format(e) an: ` +
        `${this.serverFormate.map((f) => f.name || f.formatId).join(', ') || 'leer'}`,
      'debug',
    );
    const format = waehleTextformat(this.serverFormate);
    if (format === undefined) {
      this.protokoll(
        `CLIPRDR: kein Textformat dabei (${this.serverFormate.map((f) => f.name || f.formatId).join(', ') || 'leer'})`,
      );
      return;
    }
    this.offeneAnfrage = format;
    this.protokoll(`CLIPRDR: frage die Daten von Format ${format} beim Server an`, 'debug');
    this.sende(buildFormatDataRequest(format));
  }

  private behandleFormatDataRequest(pdu: CliprdrPdu): void {
    const formatId = parseFormatDataRequest(pdu.body);
    if (!this.darfSchreiben) {
      this.protokoll('CLIPRDR: Datenanfrage abgelehnt - Schreiben ist abgeschaltet');
      this.sende(buildFormatDataResponseFehler());
      return;
    }
    if (!istTextformat(formatId)) {
      this.protokoll(`CLIPRDR: Format ${formatId} wird nicht angeboten`);
      this.sende(buildFormatDataResponseFehler());
      return;
    }
    const text = this.opts.leseLokalenText?.();
    if (text === undefined) {
      this.protokoll('CLIPRDR: Datenanfrage ohne lokalen Text beantwortet (FAIL)');
      this.sende(buildFormatDataResponseFehler());
      return;
    }
    const daten = kodiereText(text, formatId);
    if (daten.length > this.maxBytes) {
      this.protokoll(
        `CLIPRDR: ${daten.length} Byte ueberschreiten die Grenze von ${this.maxBytes} Byte - nicht gesendet`,
      );
      this.sende(buildFormatDataResponseFehler());
      return;
    }
    this.sende(buildFormatDataResponse(daten));
    this.protokoll(`CLIPRDR: ${daten.length} Byte als Format ${formatId} an den Server gegeben`);
  }

  private behandleFormatDataResponse(pdu: CliprdrPdu): void {
    const format = this.offeneAnfrage;
    this.offeneAnfrage = undefined;
    if ((pdu.msgFlags & CB_RESPONSE_OK) === 0) {
      this.protokoll('CLIPRDR: der Server konnte die angefragten Daten nicht liefern');
      return;
    }
    if (format === undefined) {
      this.protokoll('CLIPRDR: unerwartete Datenantwort ohne offene Anfrage');
      return;
    }
    if (!this.darfLesen) return;
    if (pdu.body.length > this.maxBytes) {
      this.protokoll(
        `CLIPRDR: ${pdu.body.length} Byte vom Server ueberschreiten die Grenze von ${this.maxBytes} Byte - verworfen`,
      );
      return;
    }
    const text = dekodiereText(pdu.body, format);
    // Der eigene Text gilt ab jetzt als der des Servers. Sonst meldet die
    // naechste Aenderungspruefung ihn zurueck und der Server fragt wieder an.
    this.zuletztGemeldet = text;
    this.protokoll(`CLIPRDR: ${pdu.body.length} Byte vom Server uebernommen (Format ${format})`);
    this.opts.onServerText?.(text);
  }

  /**
   * Dem Server melden, dass die lokale Zwischenablage neuen Text enthaelt.
   *
   * Liefert `true`, wenn eine Formatliste gesendet wurde. Unveraenderter Text
   * wird nicht erneut gemeldet: sonst schaukeln sich beide Seiten hoch, weil
   * jede uebernommene Aenderung sofort wieder als eigene gilt.
   */
  melde(text: string): boolean {
    if (!this.bereit || !this.darfSchreiben) return false;
    if (text === this.zuletztGemeldet) return false;
    const groesse = Buffer.byteLength(zeilenendenNachWindows(text) + '\0', 'ucs2');
    if (groesse > this.maxBytes) {
      this.protokoll(
        `CLIPRDR: lokale Zwischenablage mit ${groesse} Byte ueberschreitet die Grenze von ${this.maxBytes} Byte - nicht gemeldet`,
      );
      return false;
    }
    this.zuletztGemeldet = text;
    this.sendeFormatliste(text);
    return true;
  }

  /**
   * Formatliste senden: die Textformate, wenn Text da ist, sonst eine leere
   * Liste.
   */
  private sendeFormatliste(text: string | undefined): void {
    const formate: CliprdrFormat[] =
      text === undefined || text === ''
        ? []
        : [
            { formatId: CF_UNICODETEXT, name: '' },
            { formatId: CF_TEXT, name: '' },
          ];
    this.formatlisteUnbestaetigt = true;
    this.protokoll(
      `CLIPRDR: melde ${formate.length} Format(e) an den Server ` +
        `(${formate.map((f) => f.formatId).join(', ') || 'leer'}, ` +
        `${this.langeFormatnamen ? 'lange' : 'kurze'} Formatnamen)`,
      'debug',
    );
    this.sende(buildFormatList(formate, { longFormatNames: this.langeFormatnamen }));
  }

  /**
   * Meldung, wenn der Server auf eine Formatliste nicht antwortet.
   *
   * Der Aufrufer bringt die Uhr mit - diese Klasse kennt bewusst keine Timer.
   * Genau einmal, weil sonst jeder Kopiervorgang dieselbe Zeile erzeugt.
   */
  meldeAusbleibendeAntwort(wartezeitMs: number): void {
    if (!this.formatlisteUnbestaetigt) return;
    this.warneEinmal(
      'formatliste-ohne-antwort',
      `CLIPRDR: der Server hat unsere Formatliste seit ${Math.round(wartezeitMs / 1000)} s nicht ` +
        `beantwortet (MS-RDPECLIP 3.1.5.2 verlangt CB_FORMAT_LIST_RESPONSE). Bis dahin nimmt er ` +
        `nichts von uns an; bisher ${this.zaehler.gesendet} PDU gesendet, ${this.zaehler.empfangen} empfangen.`,
    );
  }

  /**
   * Zustand nach einem Verbindungsverlust vergessen. Die naechste Sitzung
   * faengt mit einem neuen Handshake an.
   */
  zuruecksetzen(): void {
    this.bereit = false;
    this.serverCapsGesehen = false;
    this.serverFlags = 0;
    this.serverFormate = [];
    this.offeneAnfrage = undefined;
    this.zuletztGemeldet = undefined;
    this.formatlisteUnbestaetigt = false;
    // Die Warnungen bleiben stehen: nach einem Wiederverbinden ist dieselbe
    // Auffaelligkeit dieselbe Auffaelligkeit, und zweimal gemeldet hilft nicht.
  }
}
