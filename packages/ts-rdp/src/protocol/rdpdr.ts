/**
 * Laufwerksumleitung ueber den statischen virtuellen Kanal `rdpdr`
 * (MS-RDPEFS, File System Virtual Channel Extension).
 *
 * Der Aufbau folgt `cliprdr.ts`: das Modul kennt nur Bytes und eine abstrakte
 * Dateisystemschnittstelle, es haengt weder am Client noch an einem
 * Betriebssystem. Gesendet wird ueber einen Rueckruf des Aufrufers (in der
 * Regel `RdpClient.sendVirtualChannel('rdpdr', ...)`), Eingehendes wird mit
 * `verarbeite()` hineingereicht.
 *
 * Umgesetzt ist der Weg, den der Windows-Explorer zum Lesen und Schreiben
 * eines umgeleiteten Laufwerks geht. Nicht umgesetzt sind Drucker-, Port- und
 * Smartcard-Umleitung (andere Geraetetypen, eigene Spezifikationen) sowie die
 * Sperrverwaltung mit echter Wirkung.
 *
 * Quellen (Abschnitte aus [MS-RDPEFS] 29.0 vom 23.04.2024):
 *  - 2.1       Transport: statischer Kanal, Name "RDPDR"
 *  - 2.2.1.1   RDPDR_HEADER: Component(2) PacketId(2), Little Endian
 *  - 2.2.1.2   CAPABILITY_HEADER: CapabilityType(2) CapabilityLength(2) Version(4)
 *  - 2.2.1.2.1 CAPABILITY_SET: Header(8) + capabilityData
 *  - 2.2.1.3   DEVICE_ANNOUNCE: DeviceType(4) DeviceId(4) PreferredDosName(8)
 *              DeviceDataLength(4) DeviceData(variabel)
 *  - 2.2.1.4   DR_DEVICE_IOREQUEST: Header(4) DeviceId(4) FileId(4)
 *              CompletionId(4) MajorFunction(4) MinorFunction(4) = 24 Byte
 *  - 2.2.1.4.1 DR_CREATE_REQ: + DesiredAccess(4) AllocationSize(8)
 *              FileAttributes(4) SharedAccess(4) CreateDisposition(4)
 *              CreateOptions(4) PathLength(4) Path(variabel)
 *  - 2.2.1.4.2 DR_CLOSE_REQ: + Padding(32)
 *  - 2.2.1.4.3 DR_READ_REQ: + Length(4) Offset(8) Padding(20)
 *  - 2.2.1.4.4 DR_WRITE_REQ: + Length(4) Offset(8) Padding(20) WriteData(variabel)
 *  - 2.2.1.4.5 DR_CONTROL_REQ: + OutputBufferLength(4) InputBufferLength(4)
 *              IoControlCode(4) Padding(20) InputBuffer(variabel)
 *  - 2.2.1.5   DR_DEVICE_IOCOMPLETION: Header(4) DeviceId(4) CompletionId(4)
 *              IoStatus(4) = 16 Byte
 *  - 2.2.1.5.1 DR_CREATE_RSP: + FileId(4) Information(1)
 *  - 2.2.1.5.2 DR_CLOSE_RSP: + Padding(4)
 *  - 2.2.1.5.3 DR_READ_RSP: + Length(4) ReadData(variabel)
 *  - 2.2.1.5.4 DR_WRITE_RSP: + Length(4) Padding(1, optional)
 *  - 2.2.1.5.5 DR_CONTROL_RSP: + OutputBufferLength(4) OutputBuffer(variabel)
 *  - 2.2.2.2   DR_CORE_SERVER_ANNOUNCE_REQ: Header + VersionMajor(2)
 *              VersionMinor(2) ClientId(4)
 *  - 2.2.2.3   DR_CORE_CLIENT_ANNOUNCE_RSP: gleicher Aufbau
 *  - 2.2.2.4   DR_CORE_CLIENT_NAME_REQ: Header + UnicodeFlag(4) CodePage(4)
 *              ComputerNameLen(4) ComputerName(variabel)
 *  - 2.2.2.5   DR_CORE_USER_LOGGEDON: nur der Kopf
 *  - 2.2.2.6   DR_CORE_SERVER_CLIENTID_CONFIRM: wie 2.2.2.2
 *  - 2.2.2.7   DR_CORE_CAPABILITY_REQ: Header + numCapabilities(2) Padding(2)
 *  - 2.2.2.7.1 GENERAL_CAPS_SET: Header(8) osType(4) osVersion(4)
 *              protocolMajorVersion(2) protocolMinorVersion(2) ioCode1(4)
 *              ioCode2(4) extendedPDU(4) extraFlags1(4) extraFlags2(4)
 *              SpecialTypeDeviceCap(4) - insgesamt 44 Byte bei Version 2
 *  - 2.2.2.7.4 DRIVE_CAPS_SET: nur der CAPABILITY_HEADER, 8 Byte
 *  - 2.2.2.8   DR_CORE_CAPABILITY_RSP: wie 2.2.2.7, anderer PacketId
 *  - 2.2.2.9   DR_CORE_DEVICELIST_ANNOUNCE_REQ: Header + DeviceCount(4) + Liste
 *  - 2.2.3.1   DR_DEVICELIST_ANNOUNCE: DeviceType = RDPDR_DTYP_FILESYSTEM,
 *              voller Name in DeviceData bei DRIVE_CAPABILITY_VERSION_02
 *  - 2.2.3.2   DR_DEVICELIST_REMOVE: Header + DeviceCount(4) + DeviceIds
 *  - 2.2.3.3.6 DR_DRIVE_QUERY_VOLUME_INFORMATION_REQ: + FsInformationClass(4)
 *              Length(4) Padding(24) QueryVolumeBuffer(variabel)
 *  - 2.2.3.3.8 DR_DRIVE_QUERY_INFORMATION_REQ: gleicher Aufbau
 *  - 2.2.3.3.9 DR_DRIVE_SET_INFORMATION_REQ: gleicher Aufbau
 *  - 2.2.3.3.9.1 RDP_FILE_RENAME_INFORMATION: ReplaceIfExists(1)
 *              RootDirectory(1) FileNameLength(4) FileName(variabel)
 *  - 2.2.3.3.10 DR_DRIVE_QUERY_DIRECTORY_REQ: + FsInformationClass(4)
 *              InitialQuery(1) PathLength(4) Padding(23) Path(variabel)
 *  - 2.2.3.3.11 DR_DRIVE_NOTIFY_CHANGE_DIRECTORY_REQ: + WatchTree(1)
 *              CompletionFilter(4) Padding(27)
 *  - 2.2.3.3.12 DR_DRIVE_LOCK_REQ: + Operation(4) F/Padding(4) NumLocks(4)
 *              Padding2(20) Locks(variabel)
 *  - 2.2.3.4.x Antworten des Clients, jeweils Length(4) + Buffer
 *  - 3.2.5.1.x Reihenfolge des Handshakes auf Clientseite
 *  - 3.2.5.2.3 verbotene Pfadnamen (COM1..9, LPT1..9, PRN, AUX)
 *  - 4.x       Beispielbytes, gegen die die Kodierung geprueft wird
 *
 * Die Informationsklassen stammen aus [MS-FSCC] 15.0 vom 23.04.2024:
 *  - 2.1.1   Zeitangaben: 64-Bit, 100-ns-Schritte seit dem 1.1.1601 UTC
 *  - 2.4.7   FileBasicInformation (0x04)
 *  - 2.4.8   FileBothDirectoryInformation (0x03)
 *  - 2.4.10  FileDirectoryInformation (0x01)
 *  - 2.4.11  FileDispositionInformation (0x0D)
 *  - 2.4.13  FileEndOfFileInformation (0x14)
 *  - 2.4.14  FileFullDirectoryInformation (0x02)
 *  - 2.4.6   FileAttributeTagInformation (0x23)
 *  - 2.4.26  FileNamesInformation (0x0C)
 *  - 2.4.37  FileRenameInformation (0x0A)
 *  - 2.4.41  FileStandardInformation (0x05)
 *  - 2.5.1   FileFsAttributeInformation (0x05)
 *  - 2.5.4   FileFsFullSizeInformation (0x07)
 *  - 2.5.8   FileFsSizeInformation (0x03)
 *  - 2.5.9   FileFsVolumeInformation (0x01)
 *  - 2.5.10  FileFsDeviceInformation (0x04)
 *  - 2.6     Dateiattribute
 *
 * Die NTSTATUS-Werte stehen in [MS-ERREF] 2.3.1.
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';
import {
  CHANNEL_OPTION_COMPRESS_RDP,
  CHANNEL_OPTION_ENCRYPT_RDP,
  CHANNEL_OPTION_INITIALIZED,
  ChannelDef,
} from './gcc.js';

// ------------------------------------------------------------------- Kanal

/**
 * Kanalname aus MS-RDPEFS 2.1. Im Client Network Data melden mstsc und FreeRDP
 * ihn klein geschrieben an; die Spezifikation schreibt "RDPDR", der Vergleich
 * ist ohnehin ohne Ruecksicht auf Gross- und Kleinschreibung.
 */
export const RDPDR_CHANNEL_NAME = 'rdpdr';

/**
 * Optionsfeld des Kanals im Client Network Data (MS-RDPBCGR 2.2.1.3.4.1).
 *
 * Wie bei cliprdr traegt von den Bits nur CHANNEL_OPTION_COMPRESS_RDP
 * Bedeutung - und die lohnt sich hier besonders: Quelltext komprimiert gut.
 * CHANNEL_OPTION_SHOW_PROTOCOL bleibt bewusst aus, weil mstsc es fuer rdpdr
 * ebenfalls nicht setzt.
 */
export const RDPDR_CHANNEL_OPTIONS =
  (CHANNEL_OPTION_INITIALIZED | CHANNEL_OPTION_ENCRYPT_RDP | CHANNEL_OPTION_COMPRESS_RDP) >>> 0;

/** Fertiger Eintrag fuer `RdpClientOptions.extraStaticChannels`. */
export const RDPDR_CHANNEL_DEF: ChannelDef = {
  name: RDPDR_CHANNEL_NAME,
  options: RDPDR_CHANNEL_OPTIONS,
};

// ------------------------------------------------------- Konstanten 2.2.1.1

/** Kernkomponente der Geraeteumleitung; fast alle PDUs tragen diese ID. */
export const RDPDR_CTYP_CORE = 0x4472;
/** Druckerkomponente (MS-RDPEPC) - wird hier nur erkannt, nicht bedient. */
export const RDPDR_CTYP_PRN = 0x5052;

export const PAKID_CORE_SERVER_ANNOUNCE = 0x496e;
export const PAKID_CORE_CLIENTID_CONFIRM = 0x4343;
export const PAKID_CORE_CLIENT_NAME = 0x434e;
export const PAKID_CORE_DEVICELIST_ANNOUNCE = 0x4441;
export const PAKID_CORE_DEVICE_REPLY = 0x6472;
export const PAKID_CORE_DEVICE_IOREQUEST = 0x4952;
export const PAKID_CORE_DEVICE_IOCOMPLETION = 0x4943;
export const PAKID_CORE_SERVER_CAPABILITY = 0x5350;
export const PAKID_CORE_CLIENT_CAPABILITY = 0x4350;
export const PAKID_CORE_DEVICELIST_REMOVE = 0x444d;
export const PAKID_CORE_USER_LOGGEDON = 0x554c;

/** Laenge des RDPDR_HEADER in Byte. */
export const RDPDR_HEADER_SIZE = 4;

// ------------------------------------------------------- Konstanten 2.2.1.2

export const CAP_GENERAL_TYPE = 0x0001;
export const CAP_PRINTER_TYPE = 0x0002;
export const CAP_PORT_TYPE = 0x0003;
export const CAP_DRIVE_TYPE = 0x0004;
export const CAP_SMARTCARD_TYPE = 0x0005;

export const GENERAL_CAPABILITY_VERSION_01 = 0x00000001;
export const GENERAL_CAPABILITY_VERSION_02 = 0x00000002;
export const DRIVE_CAPABILITY_VERSION_01 = 0x00000001;
export const DRIVE_CAPABILITY_VERSION_02 = 0x00000002;

/** Laenge eines CAPABILITY_HEADER in Byte. */
export const CAPABILITY_HEADER_SIZE = 8;
/** Laenge eines GENERAL_CAPS_SET der Version 2, Kopf eingerechnet. */
export const GENERAL_CAPS_SET_SIZE = 44;

/**
 * ioCode1 aus 2.2.2.7.1. Alle Bits von RDPDR_IRP_MJ_CREATE bis
 * RDPDR_IRP_MJ_LOCK_CONTROL sind laut Tabelle "unused, always set"; die beiden
 * obersten Bits (QUERY_SECURITY 0x4000, SET_SECURITY 0x8000) schalten dagegen
 * echte Anfragen frei. Windows selbst sendet 0x0000ffff (Beispiel 4.6), also
 * mit beiden Sicherheitsbits. Wir lassen sie aus: wer sie meldet, bekommt
 * IRP_MJ_QUERY_SECURITY geschickt und muss Sicherheitsbeschreibungen liefern -
 * und die haben wir nicht.
 */
export const RDPDR_IOCODE1_OHNE_SECURITY = 0x00003fff;

export const RDPDR_DEVICE_REMOVE_PDUS = 0x00000001;
export const RDPDR_CLIENT_DISPLAY_NAME_PDU = 0x00000002;
export const RDPDR_USER_LOGGEDON_PDU = 0x00000004;

// ------------------------------------------------------- Konstanten 2.2.1.3

export const RDPDR_DTYP_SERIAL = 0x00000001;
export const RDPDR_DTYP_PARALLEL = 0x00000002;
export const RDPDR_DTYP_PRINT = 0x00000004;
export const RDPDR_DTYP_FILESYSTEM = 0x00000008;
export const RDPDR_DTYP_SMARTCARD = 0x00000020;

/** Feste Groesse des Feldes PreferredDosName in Byte. */
export const PREFERRED_DOS_NAME_SIZE = 8;

/**
 * Zeichen, die laut 2.2.1.3 im PreferredDosName verboten sind. Ein ":" ist nur
 * als letztes Zeichen erlaubt - bei echten Laufwerken steht dort "C:".
 */
const VERBOTENE_DOSNAME_ZEICHEN = /[<>"/\\|]/;

// ------------------------------------------------------- Konstanten 2.2.1.4

export const IRP_MJ_CREATE = 0x00000000;
export const IRP_MJ_CLOSE = 0x00000002;
export const IRP_MJ_READ = 0x00000003;
export const IRP_MJ_WRITE = 0x00000004;
export const IRP_MJ_QUERY_INFORMATION = 0x00000005;
export const IRP_MJ_SET_INFORMATION = 0x00000006;
export const IRP_MJ_QUERY_VOLUME_INFORMATION = 0x0000000a;
export const IRP_MJ_SET_VOLUME_INFORMATION = 0x0000000b;
export const IRP_MJ_DIRECTORY_CONTROL = 0x0000000c;
export const IRP_MJ_DEVICE_CONTROL = 0x0000000e;
export const IRP_MJ_LOCK_CONTROL = 0x00000011;

export const IRP_MN_QUERY_DIRECTORY = 0x00000001;
export const IRP_MN_NOTIFY_CHANGE_DIRECTORY = 0x00000002;

/** Laenge des DR_DEVICE_IOREQUEST in Byte. */
export const DEVICE_IO_REQUEST_SIZE = 24;
/** Laenge des DR_DEVICE_IOCOMPLETION in Byte. */
export const DEVICE_IO_COMPLETION_SIZE = 16;

// --------------------------------------------- CreateDisposition (MS-SMB2 2.2.13)

export const FILE_SUPERSEDE = 0x00000000;
export const FILE_OPEN = 0x00000001;
export const FILE_CREATE = 0x00000002;
export const FILE_OPEN_IF = 0x00000003;
export const FILE_OVERWRITE = 0x00000004;
export const FILE_OVERWRITE_IF = 0x00000005;

// ------------------------------------------------ CreateOptions (MS-SMB2 2.2.13)

export const FILE_DIRECTORY_FILE = 0x00000001;
export const FILE_WRITE_THROUGH = 0x00000002;
export const FILE_NON_DIRECTORY_FILE = 0x00000040;
export const FILE_DELETE_ON_CLOSE = 0x00001000;
export const FILE_OPEN_REPARSE_POINT = 0x00200000;

// ------------------------------------------------ DesiredAccess (MS-SMB2 2.2.13.1)

export const FILE_READ_DATA = 0x00000001;
export const FILE_WRITE_DATA = 0x00000002;
export const FILE_APPEND_DATA = 0x00000004;
export const FILE_READ_EA = 0x00000008;
export const FILE_WRITE_EA = 0x00000010;
export const FILE_EXECUTE = 0x00000020;
export const FILE_DELETE_CHILD = 0x00000040;
export const FILE_READ_ATTRIBUTES = 0x00000080;
export const FILE_WRITE_ATTRIBUTES = 0x00000100;
export const DELETE = 0x00010000;
export const READ_CONTROL = 0x00020000;
export const WRITE_DAC = 0x00040000;
export const WRITE_OWNER = 0x00080000;
export const SYNCHRONIZE = 0x00100000;
export const GENERIC_ALL = 0x10000000;
export const GENERIC_EXECUTE = 0x20000000;
export const GENERIC_WRITE = 0x40000000;
export const GENERIC_READ = 0x80000000;

/**
 * Alle Bits, die einen Schreibwunsch ausdruecken.
 *
 * Wichtig fuer den Nur-Lesen-Betrieb: der Explorer oeffnet Dateien haeufig mit
 * GENERIC_READ, aber ein Speichern-Dialog verlangt FILE_WRITE_DATA. Wer nur
 * auf CreateDisposition schaut, laesst ein `FILE_OPEN` mit Schreibrecht durch
 * und scheitert erst beim Schreiben - also viel zu spaet.
 */
export const SCHREIBZUGRIFF_BITS =
  (FILE_WRITE_DATA |
    FILE_APPEND_DATA |
    FILE_WRITE_EA |
    FILE_WRITE_ATTRIBUTES |
    DELETE |
    FILE_DELETE_CHILD |
    WRITE_DAC |
    WRITE_OWNER |
    GENERIC_WRITE |
    GENERIC_ALL) >>>
  0;

// ----------------------------------------------- Information im DR_CREATE_RSP

export const FILE_SUPERSEDED = 0x00;
export const FILE_OPENED = 0x01;
export const FILE_OVERWRITTEN = 0x03;

// ------------------------------------------------------ NTSTATUS (MS-ERREF 2.3.1)

export const STATUS_SUCCESS = 0x00000000;
export const STATUS_BUFFER_OVERFLOW = 0x80000005;
export const STATUS_NO_MORE_FILES = 0x80000006;
export const STATUS_UNSUCCESSFUL = 0xc0000001;
export const STATUS_NOT_IMPLEMENTED = 0xc0000002;
export const STATUS_INVALID_PARAMETER = 0xc000000d;
export const STATUS_NO_SUCH_FILE = 0xc000000f;
export const STATUS_INVALID_DEVICE_REQUEST = 0xc0000010;
export const STATUS_END_OF_FILE = 0xc0000011;
export const STATUS_ACCESS_DENIED = 0xc0000022;
export const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
export const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
export const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
export const STATUS_DISK_FULL = 0xc000007f;
export const STATUS_DEVICE_NOT_READY = 0xc00000a3;
export const STATUS_FILE_IS_A_DIRECTORY = 0xc00000ba;
export const STATUS_NOT_SUPPORTED = 0xc00000bb;
export const STATUS_DIRECTORY_NOT_EMPTY = 0xc0000101;
export const STATUS_NOT_A_DIRECTORY = 0xc0000103;
export const STATUS_CANNOT_DELETE = 0xc0000121;

// ------------------------------------ Informationsklassen (MS-FSCC 2.4 / 2.5)

export const FileDirectoryInformation = 0x00000001;
export const FileFullDirectoryInformation = 0x00000002;
export const FileBothDirectoryInformation = 0x00000003;
export const FileBasicInformation = 0x00000004;
export const FileStandardInformation = 0x00000005;
export const FileRenameInformation = 0x0000000a;
export const FileNamesInformation = 0x0000000c;
export const FileDispositionInformation = 0x0000000d;
export const FileAllocationInformation = 0x00000013;
export const FileEndOfFileInformation = 0x00000014;
export const FileAttributeTagInformation = 0x00000023;

export const FileFsVolumeInformation = 0x00000001;
export const FileFsLabelInformation = 0x00000002;
export const FileFsSizeInformation = 0x00000003;
export const FileFsDeviceInformation = 0x00000004;
export const FileFsAttributeInformation = 0x00000005;
export const FileFsFullSizeInformation = 0x00000007;

// ------------------------------------------------- Dateiattribute (MS-FSCC 2.6)

export const FILE_ATTRIBUTE_READONLY = 0x00000001;
export const FILE_ATTRIBUTE_HIDDEN = 0x00000002;
export const FILE_ATTRIBUTE_SYSTEM = 0x00000004;
export const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
export const FILE_ATTRIBUTE_ARCHIVE = 0x00000020;
export const FILE_ATTRIBUTE_NORMAL = 0x00000080;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

// ------------------------------------- Volumenattribute (MS-FSCC 2.5.1) / Geraet

export const FILE_CASE_SENSITIVE_SEARCH = 0x00000001;
export const FILE_CASE_PRESERVED_NAMES = 0x00000002;
export const FILE_UNICODE_ON_DISK = 0x00000004;
export const FILE_READ_ONLY_VOLUME = 0x00080000;

export const FILE_DEVICE_DISK = 0x00000007;
export const FILE_REMOTE_DEVICE = 0x00000010;
export const FILE_DEVICE_IS_MOUNTED = 0x00000020;
export const FILE_READ_ONLY_DEVICE = 0x00000002;
export const FILE_CHARACTERISTIC_TS_DEVICE = 0x00001000;

// -------------------------------------------------------------- 64-Bit-Helfer

/** 64-Bit-Wert little endian schreiben. */
export function u64le(wert: bigint | number): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(wert) & 0xffffffffffffffffn, 0);
  return b;
}

/** 64-Bit-Wert little endian lesen, als vorzeichenbehaftetes BigInt. */
export function i64le(daten: Buffer, offset: number): bigint {
  return daten.readBigInt64LE(offset);
}

/**
 * Millisekunden seit der Unix-Epoche in eine Windows-Zeitangabe umrechnen
 * (MS-FSCC 2.1.1: 100-ns-Schritte seit dem 1.1.1601 UTC).
 *
 * Die 11644473600 Sekunden zwischen beiden Epochen sind ein fester Wert - die
 * Zeitspanne enthaelt keine Schaltsekunden, weil beide Skalen sie ignorieren.
 * Negative Ergebnisse (Zeiten vor 1601) werden auf 0 geklemmt: die
 * Verzeichnisklassen schreiben vor, dass der Wert nicht negativ sein darf.
 */
export const EPOCHENDIFFERENZ_MS = 11644473600000n;

export function nachFiletime(msSeitEpoche: number | undefined): bigint {
  if (msSeitEpoche === undefined || !Number.isFinite(msSeitEpoche)) return 0n;
  const wert = (BigInt(Math.round(msSeitEpoche)) + EPOCHENDIFFERENZ_MS) * 10000n;
  return wert < 0n ? 0n : wert;
}

/** Gegenrichtung: Windows-Zeitangabe in Millisekunden seit der Unix-Epoche. */
export function ausFiletime(filetime: bigint): number {
  return Number(filetime / 10000n - EPOCHENDIFFERENZ_MS);
}

// ------------------------------------------------------------ Kopf (2.2.1.1)

export interface RdpdrPdu {
  component: number;
  packetId: number;
  /** Rumpf ohne den vier Byte langen Kopf. */
  body: Buffer;
}

/** RDPDR_HEADER + Rumpf bauen. */
export function buildRdpdrPdu(component: number, packetId: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return writer().uint16le(component).uint16le(packetId).bytes(body).toBuffer();
}

/**
 * RDPDR_HEADER lesen.
 *
 * Anders als CLIPRDR traegt der Kopf keine Laengenangabe - der Kanal liefert
 * die Nachrichtengrenze. Der Rumpf ist also schlicht der Rest.
 */
export function parseRdpdrPdu(daten: Buffer): RdpdrPdu {
  if (daten.length < RDPDR_HEADER_SIZE) {
    throw new RdpProtocolError(
      `RDPDR: Nachricht kuerzer als der Kopf (${daten.length} von ${RDPDR_HEADER_SIZE} Byte)`,
    );
  }
  return {
    component: daten.readUInt16LE(0),
    packetId: daten.readUInt16LE(2),
    body: daten.subarray(RDPDR_HEADER_SIZE),
  };
}

// -------------------------------------------------- Server Announce (2.2.2.2)

export interface ServerAnnounce {
  versionMajor: number;
  versionMinor: number;
  clientId: number;
}

export function parseServerAnnounce(body: Buffer): ServerAnnounce {
  if (body.length < 8) throw new RdpProtocolError('RDPDR: Server Announce zu kurz');
  return {
    versionMajor: body.readUInt16LE(0),
    versionMinor: body.readUInt16LE(2),
    clientId: body.readUInt32LE(4),
  };
}

/**
 * DR_CORE_CLIENT_ANNOUNCE_RSP (2.2.2.3).
 *
 * Die ClientId waehlt nicht dieses Modul: 3.2.5.1.3 schreibt vor, dass der
 * Client ab VersionMinor 12 die des Servers uebernimmt und darunter eine
 * eigene Zufallszahl zieht. Beides entscheidet die Sitzung.
 */
export function buildClientAnnounceReply(versionMajor: number, versionMinor: number, clientId: number): Buffer {
  const body = writer().uint16le(versionMajor).uint16le(versionMinor).uint32le(clientId).toBuffer();
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_CLIENTID_CONFIRM, body);
}

// ----------------------------------------------- Client Name Request (2.2.2.4)

/**
 * DR_CORE_CLIENT_NAME_REQ mit Unicode-Namen.
 *
 * ComputerNameLen zaehlt das abschliessende Nullzeichen mit - im Beispiel 4.4
 * sind das fuer "TSDEV-SELFHOST" 30 Byte: 14 Zeichen zu je zwei Byte plus zwei
 * Byte Nullzeichen. CodePage muss laut 2.2.2.4 null sein.
 */
export function buildClientNameRequest(name: string): Buffer {
  const roh = Buffer.from(name + '\0', 'ucs2');
  const body = writer()
    .uint32le(1) // UnicodeFlag
    .uint32le(0) // CodePage
    .uint32le(roh.length)
    .bytes(roh)
    .toBuffer();
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_CLIENT_NAME, body);
}

// ---------------------------------------------------- Capabilities (2.2.2.7)

export interface RdpdrCapabilitySet {
  capabilityType: number;
  version: number;
  /** Rumpf ohne den acht Byte langen CAPABILITY_HEADER. */
  data: Buffer;
}

/**
 * Faehigkeiten des Servers lesen.
 *
 * Unbekannte Satztypen werden ueber CapabilityLength uebersprungen. Ein Satz,
 * der kuerzer als sein eigener Kopf zu sein behauptet, beendet die Schleife -
 * sonst liefe sie endlos.
 */
export function parseCapabilities(body: Buffer): RdpdrCapabilitySet[] {
  const saetze: RdpdrCapabilitySet[] = [];
  if (body.length < 4) return saetze;
  const r = new BinaryReader(body);
  const anzahl = r.uint16le();
  r.uint16le(); // Padding
  for (let i = 0; i < anzahl && r.remaining >= CAPABILITY_HEADER_SIZE; i++) {
    const capabilityType = r.uint16le();
    const laenge = r.uint16le();
    const version = r.uint32le();
    if (laenge < CAPABILITY_HEADER_SIZE) break;
    const rumpfLaenge = Math.min(laenge - CAPABILITY_HEADER_SIZE, r.remaining);
    saetze.push({ capabilityType, version, data: r.bytes(rumpfLaenge) });
  }
  return saetze;
}

export interface ClientCapabilitiesOptions {
  /** protocolMinorVersion im General Caps Set; identisch mit der Announce-Antwort. */
  versionMinor: number;
  /** Bitmaske aus 2.2.2.7.1; Standard ohne die beiden Sicherheitsbits. */
  ioCode1?: number;
  /** extendedPDU; Standard: Geraeteliste entfernen und User Logged On erlaubt. */
  extendedPdu?: number;
  /** Zahl der Geraete, die schon vor der Anmeldung umgeleitet werden. */
  specialTypeDeviceCap?: number;
}

/**
 * DR_CORE_CAPABILITY_RSP mit General- und Drive-Satz.
 *
 * Nur diese beiden: wir melden ausschliesslich Dateisystemgeraete an. Wer
 * CAP_PRINTER_TYPE oder CAP_SMARTCARD_TYPE mitschickt, bekommt vom Server
 * Anfragen fuer Geraete, die er nie angekuendigt hat.
 *
 * Der Drive-Satz meldet DRIVE_CAPABILITY_VERSION_02. Das ist keine Kosmetik:
 * erst damit darf der volle Laufwerksname im DeviceData stehen (2.2.3.1), und
 * nur so laesst sich ein Name jenseits der sieben Zeichen des
 * PreferredDosName anzeigen.
 */
export function buildClientCapabilities(opts: ClientCapabilitiesOptions): Buffer {
  const general = writer()
    .uint16le(CAP_GENERAL_TYPE)
    .uint16le(GENERAL_CAPS_SET_SIZE)
    .uint32le(GENERAL_CAPABILITY_VERSION_02)
    .uint32le(0) // osType - laut 2.2.2.7.1 ausdruecklich zu ignorieren
    .uint32le(0) // osVersion - unbenutzt
    .uint16le(1) // protocolMajorVersion, laut Spezifikation immer 1
    .uint16le(opts.versionMinor)
    .uint32le(opts.ioCode1 ?? RDPDR_IOCODE1_OHNE_SECURITY)
    .uint32le(0) // ioCode2, reserviert
    .uint32le(opts.extendedPdu ?? (RDPDR_DEVICE_REMOVE_PDUS | RDPDR_USER_LOGGEDON_PDU))
    .uint32le(0) // extraFlags1 - ohne ENABLE_ASYNCIO: wir beantworten der Reihe nach
    .uint32le(0) // extraFlags2, reserviert
    .uint32le(opts.specialTypeDeviceCap ?? 0)
    .toBuffer();
  const drive = writer()
    .uint16le(CAP_DRIVE_TYPE)
    .uint16le(CAPABILITY_HEADER_SIZE)
    .uint32le(DRIVE_CAPABILITY_VERSION_02)
    .toBuffer();
  const body = writer()
    .uint16le(2) // numCapabilities
    .uint16le(0) // Padding
    .bytes(general)
    .bytes(drive)
    .toBuffer();
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_CLIENT_CAPABILITY, body);
}

// ------------------------------------------------- Geraeteliste (2.2.2.9 / 2.2.3.1)

export interface RdpdrGeraet {
  deviceId: number;
  /** Name, der im Explorer erscheint. Voller Name, nicht der DOS-Name. */
  name: string;
}

/**
 * PreferredDosName aus einem Namen bilden.
 *
 * Acht Byte, nullterminiert, also hoechstens sieben Zeichen (2.2.1.3). Die
 * verbotenen Zeichen werden durch "_" ersetzt, statt den Namen abzulehnen:
 * eine Geraeteankuendigung mit einem verbotenen Zeichen wird vom Server mit
 * STATUS_ACCESS_DENIED quittiert, und dann fehlt das Laufwerk ganz.
 */
export function preferredDosName(name: string): string {
  const gesaeubert = Array.from(name, (z) => (VERBOTENE_DOSNAME_ZEICHEN.test(z) ? '_' : z)).join('');
  return gesaeubert.substring(0, PREFERRED_DOS_NAME_SIZE - 1);
}

/**
 * DR_DEVICELIST_ANNOUNCE fuer Dateisystemgeraete (2.2.3.1).
 *
 * DeviceData traegt den vollen Namen als nullterminiertes UTF-16LE. Das ist
 * nur zulaessig, weil wir DRIVE_CAPABILITY_VERSION_02 angekuendigt haben; ist
 * DeviceDataLength ungleich null, ignoriert der Server den PreferredDosName.
 * Gesetzt wird er trotzdem - fuer Server, die die Version 2 nicht koennen.
 */
export function buildDeviceListAnnounce(geraete: readonly RdpdrGeraet[]): Buffer {
  const w = writer().uint32le(geraete.length);
  for (const geraet of geraete) {
    const voll = Buffer.from(geraet.name + '\0', 'ucs2');
    w.uint32le(RDPDR_DTYP_FILESYSTEM)
      .uint32le(geraet.deviceId)
      .ascii(preferredDosName(geraet.name), PREFERRED_DOS_NAME_SIZE)
      .uint32le(voll.length)
      .bytes(voll);
  }
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_DEVICELIST_ANNOUNCE, w.toBuffer());
}

/** DR_DEVICELIST_REMOVE (2.2.3.2). */
export function buildDeviceListRemove(deviceIds: readonly number[]): Buffer {
  const w = writer().uint32le(deviceIds.length);
  for (const id of deviceIds) w.uint32le(id);
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_DEVICELIST_REMOVE, w.toBuffer());
}

/** DR_CORE_DEVICE_ANNOUNCE_RSP (2.2.2.1) lesen. */
export interface DeviceAnnounceResponse {
  deviceId: number;
  resultCode: number;
}

export function parseDeviceAnnounceResponse(body: Buffer): DeviceAnnounceResponse {
  if (body.length < 8) throw new RdpProtocolError('RDPDR: Device Announce Response zu kurz');
  return { deviceId: body.readUInt32LE(0), resultCode: body.readUInt32LE(4) };
}

// ------------------------------------------------- Device I/O Request (2.2.1.4)

/** Gemeinsamer Kopf jeder Anfrage des Servers an ein Geraet. */
export interface DeviceIoRequest {
  deviceId: number;
  fileId: number;
  completionId: number;
  majorFunction: number;
  minorFunction: number;
}

export interface CreateRequest extends DeviceIoRequest {
  art: 'create';
  desiredAccess: number;
  allocationSize: bigint;
  fileAttributes: number;
  sharedAccess: number;
  createDisposition: number;
  createOptions: number;
  /** Pfad in der Schreibweise des Servers, also mit Rueckstrichen. */
  path: string;
}

export interface CloseRequest extends DeviceIoRequest {
  art: 'close';
}

export interface ReadRequest extends DeviceIoRequest {
  art: 'read';
  length: number;
  offset: bigint;
}

export interface WriteRequest extends DeviceIoRequest {
  art: 'write';
  offset: bigint;
  data: Buffer;
}

export interface ControlRequest extends DeviceIoRequest {
  art: 'control';
  outputBufferLength: number;
  ioControlCode: number;
  inputBuffer: Buffer;
}

export interface QueryVolumeInformationRequest extends DeviceIoRequest {
  art: 'queryVolumeInformation';
  fsInformationClass: number;
}

export interface SetVolumeInformationRequest extends DeviceIoRequest {
  art: 'setVolumeInformation';
  fsInformationClass: number;
  buffer: Buffer;
}

export interface QueryInformationRequest extends DeviceIoRequest {
  art: 'queryInformation';
  fsInformationClass: number;
}

export interface SetInformationRequest extends DeviceIoRequest {
  art: 'setInformation';
  fsInformationClass: number;
  /** Laenge laut Feld - die Antwort muss sie unveraendert zurueckgeben. */
  length: number;
  buffer: Buffer;
}

export interface QueryDirectoryRequest extends DeviceIoRequest {
  art: 'queryDirectory';
  fsInformationClass: number;
  /** Erste Anfrage der Aufzaehlung? Sonst geht es beim naechsten Eintrag weiter. */
  initialQuery: boolean;
  path: string;
}

export interface NotifyChangeDirectoryRequest extends DeviceIoRequest {
  art: 'notifyChangeDirectory';
  watchTree: boolean;
  completionFilter: number;
}

export interface LockControlRequest extends DeviceIoRequest {
  art: 'lockControl';
  operation: number;
  /** Auf den Abschluss warten (Bit F aus 2.2.3.3.12)? */
  warten: boolean;
  numLocks: number;
}

/** Anfrage, deren MajorFunction wir nicht bedienen. */
export interface UnbekannteRequest extends DeviceIoRequest {
  art: 'unbekannt';
}

export type RdpdrRequest =
  | CreateRequest
  | CloseRequest
  | ReadRequest
  | WriteRequest
  | ControlRequest
  | QueryVolumeInformationRequest
  | SetVolumeInformationRequest
  | QueryInformationRequest
  | SetInformationRequest
  | QueryDirectoryRequest
  | NotifyChangeDirectoryRequest
  | LockControlRequest
  | UnbekannteRequest;

/**
 * Eine Serveranfrage lesen.
 *
 * Erwartet den Rumpf *ohne* RDPDR_HEADER, also ab DeviceId. Fehlende Bytes
 * hinter dem gemeinsamen Kopf fuehren zu einem RdpProtocolError - eine
 * halbgelesene Anfrage zu beantworten waere schlimmer als sie abzulehnen.
 */
export function parseDeviceIoRequest(body: Buffer): RdpdrRequest {
  if (body.length < DEVICE_IO_REQUEST_SIZE - RDPDR_HEADER_SIZE) {
    throw new RdpProtocolError(`RDPDR: Device I/O Request zu kurz (${body.length} Byte)`);
  }
  const r = new BinaryReader(body);
  const kopf: DeviceIoRequest = {
    deviceId: r.uint32le(),
    fileId: r.uint32le(),
    completionId: r.uint32le(),
    majorFunction: r.uint32le(),
    minorFunction: r.uint32le(),
  };

  switch (kopf.majorFunction) {
    case IRP_MJ_CREATE: {
      const desiredAccess = r.uint32le();
      const allocationSize = r.buffer.readBigUInt64LE(r.offset);
      r.skip(8);
      const fileAttributes = r.uint32le();
      const sharedAccess = r.uint32le();
      const createDisposition = r.uint32le();
      const createOptions = r.uint32le();
      const pathLength = r.uint32le();
      const vorhanden = Math.min(pathLength, r.remaining);
      return {
        ...kopf,
        art: 'create',
        desiredAccess,
        allocationSize,
        fileAttributes,
        sharedAccess,
        createDisposition,
        createOptions,
        path: r.utf16le(vorhanden),
      };
    }
    case IRP_MJ_CLOSE:
      // Padding(32) wird nicht gelesen; der Inhalt ist laut 2.2.1.4.2 beliebig.
      return { ...kopf, art: 'close' };
    case IRP_MJ_READ: {
      const length = r.uint32le();
      const offset = r.buffer.readBigUInt64LE(r.offset);
      return { ...kopf, art: 'read', length, offset };
    }
    case IRP_MJ_WRITE: {
      const length = r.uint32le();
      const offset = r.buffer.readBigUInt64LE(r.offset);
      r.skip(8);
      r.skip(20); // Padding
      const vorhanden = Math.min(length, r.remaining);
      return { ...kopf, art: 'write', offset, data: r.bytes(vorhanden) };
    }
    case IRP_MJ_DEVICE_CONTROL: {
      const outputBufferLength = r.uint32le();
      const inputBufferLength = r.uint32le();
      const ioControlCode = r.uint32le();
      r.skip(20); // Padding
      const vorhanden = Math.min(inputBufferLength, r.remaining);
      return { ...kopf, art: 'control', outputBufferLength, ioControlCode, inputBuffer: r.bytes(vorhanden) };
    }
    case IRP_MJ_QUERY_VOLUME_INFORMATION: {
      const fsInformationClass = r.uint32le();
      return { ...kopf, art: 'queryVolumeInformation', fsInformationClass };
    }
    case IRP_MJ_SET_VOLUME_INFORMATION: {
      const fsInformationClass = r.uint32le();
      const length = r.uint32le();
      r.skip(24); // Padding
      const vorhanden = Math.min(length, r.remaining);
      return { ...kopf, art: 'setVolumeInformation', fsInformationClass, buffer: r.bytes(vorhanden) };
    }
    case IRP_MJ_QUERY_INFORMATION: {
      const fsInformationClass = r.uint32le();
      return { ...kopf, art: 'queryInformation', fsInformationClass };
    }
    case IRP_MJ_SET_INFORMATION: {
      const fsInformationClass = r.uint32le();
      const length = r.uint32le();
      r.skip(24); // Padding
      const vorhanden = Math.min(length, r.remaining);
      return { ...kopf, art: 'setInformation', fsInformationClass, length, buffer: r.bytes(vorhanden) };
    }
    case IRP_MJ_DIRECTORY_CONTROL: {
      if (kopf.minorFunction === IRP_MN_QUERY_DIRECTORY) {
        const fsInformationClass = r.uint32le();
        const initialQuery = r.uint8() !== 0;
        const pathLength = r.uint32le();
        r.skip(23); // Padding
        const vorhanden = Math.min(pathLength, r.remaining);
        return { ...kopf, art: 'queryDirectory', fsInformationClass, initialQuery, path: r.utf16le(vorhanden) };
      }
      if (kopf.minorFunction === IRP_MN_NOTIFY_CHANGE_DIRECTORY) {
        const watchTree = r.uint8() !== 0;
        const completionFilter = r.uint32le();
        return { ...kopf, art: 'notifyChangeDirectory', watchTree, completionFilter };
      }
      return { ...kopf, art: 'unbekannt' };
    }
    case IRP_MJ_LOCK_CONTROL: {
      const operation = r.uint32le();
      // F ist das oberste Bit eines 32-Bit-Feldes, dessen restliche 31 Bit
      // Padding sind. Im Speicher steht es als Bit 0 des ersten Bytes: die
      // Bitnummerierung der Spezifikation zaehlt vom hoechstwertigen Bit.
      const warten = (r.uint8() & 0x80) !== 0;
      r.skip(3);
      const numLocks = r.uint32le();
      return { ...kopf, art: 'lockControl', operation, warten, numLocks };
    }
    default:
      return { ...kopf, art: 'unbekannt' };
  }
}

// ------------------------------------------------ Device I/O Response (2.2.1.5)

/** DR_DEVICE_IOCOMPLETION + beliebiger Rumpf. */
export function buildDeviceIoResponse(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  rumpf: Buffer = Buffer.alloc(0),
): Buffer {
  const body = writer().uint32le(deviceId).uint32le(completionId).uint32le(ioStatus).bytes(rumpf).toBuffer();
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_DEVICE_IOCOMPLETION, body);
}

/**
 * DR_CREATE_RSP (2.2.1.5.1).
 *
 * Das Feld Information wird immer geschrieben, auch im Fehlerfall. Die
 * Spezifikation erlaubt zwar, es bei IoStatus 0 wegzulassen, aber Windows
 * erwartet 21 Byte (2.2.3.4.1) - und ein Byte zu viel kostet nichts.
 */
export function buildCreateResponse(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  fileId: number,
  information: number,
): Buffer {
  return buildDeviceIoResponse(
    deviceId,
    completionId,
    ioStatus,
    writer().uint32le(fileId).uint8(information).toBuffer(),
  );
}

/** DR_CLOSE_RSP (2.2.1.5.2): vier Byte Padding. */
export function buildCloseResponse(deviceId: number, completionId: number, ioStatus: number): Buffer {
  return buildDeviceIoResponse(deviceId, completionId, ioStatus, Buffer.alloc(4));
}

/** DR_READ_RSP (2.2.1.5.3). */
export function buildReadResponse(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  daten: Buffer,
): Buffer {
  return buildDeviceIoResponse(deviceId, completionId, ioStatus, writer().uint32le(daten.length).bytes(daten).toBuffer());
}

/** DR_WRITE_RSP (2.2.1.5.4): geschriebene Byte-Zahl plus ein Byte Padding. */
export function buildWriteResponse(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  geschrieben: number,
): Buffer {
  return buildDeviceIoResponse(deviceId, completionId, ioStatus, writer().uint32le(geschrieben).uint8(0).toBuffer());
}

/** DR_CONTROL_RSP (2.2.1.5.5). */
export function buildControlResponse(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  ausgabe: Buffer = Buffer.alloc(0),
): Buffer {
  return buildDeviceIoResponse(
    deviceId,
    completionId,
    ioStatus,
    writer().uint32le(ausgabe.length).bytes(ausgabe).toBuffer(),
  );
}

/**
 * Antworten mit Length + Buffer: Query Volume Information (2.2.3.4.6),
 * Query Information (2.2.3.4.8) und Query Directory (2.2.3.4.10).
 *
 * Das optionale Padding-Byte wird nur bei leerem Puffer angehaengt. Windows
 * verlangt es dort: eine Antwort aus blossem Kopf und Length waere 20 Byte
 * lang, und darauf reagieren manche Server mit einem Kanalabbruch.
 */
export function buildLaengeUndPuffer(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  puffer: Buffer,
): Buffer {
  const w = writer().uint32le(puffer.length).bytes(puffer);
  if (puffer.length === 0) w.uint8(0);
  return buildDeviceIoResponse(deviceId, completionId, ioStatus, w.toBuffer());
}

/**
 * DR_DRIVE_SET_INFORMATION_RSP (2.2.3.4.9).
 *
 * Length muss die Laenge aus der Anfrage unveraendert wiederholen - das ist
 * kein Zaehler fuer geschriebene Bytes, sondern eine Bestaetigung.
 */
export function buildSetInformationResponse(
  deviceId: number,
  completionId: number,
  ioStatus: number,
  length: number,
): Buffer {
  return buildDeviceIoResponse(deviceId, completionId, ioStatus, writer().uint32le(length).uint8(0).toBuffer());
}

/** DR_DRIVE_LOCK_RSP (2.2.3.4.12): fuenf Byte Padding. */
export function buildLockResponse(deviceId: number, completionId: number, ioStatus: number): Buffer {
  return buildDeviceIoResponse(deviceId, completionId, ioStatus, Buffer.alloc(5));
}

// ======================================================================
//  Informationsklassen aus MS-FSCC
// ======================================================================

/**
 * Ein Verzeichniseintrag, so wie ihn dieses Modul braucht.
 *
 * Bewusst betriebssystemfrei: Zeiten in Millisekunden seit der Unix-Epoche,
 * Groesse in Byte. Die Umrechnung in Windows-Zeitangaben und -Attribute
 * passiert hier, nicht beim Aufrufer.
 */
export interface DateiEintrag {
  name: string;
  istVerzeichnis: boolean;
  /** Groesse in Byte; bei Verzeichnissen 0. */
  groesse: number;
  /** Erstellungszeit, Millisekunden seit der Unix-Epoche. */
  erstellt?: number;
  /** Zeit der letzten Aenderung. */
  geaendert?: number;
  /** Zeit des letzten Zugriffs; ohne Angabe wird `geaendert` genommen. */
  zugegriffen?: number;
  /** Schreibgeschuetzt - setzt FILE_ATTRIBUTE_READONLY. */
  nurLesen?: boolean;
  /** Versteckt - setzt FILE_ATTRIBUTE_HIDDEN (etwa fuer Namen mit fuehrendem Punkt). */
  versteckt?: boolean;
}

/** Groesse eines Clusters, nach der die AllocationSize aufgerundet wird. */
export const CLUSTERGROESSE = 4096;

/** Byte je Sektor, wie sie in den Volumenklassen gemeldet werden. */
export const BYTES_PRO_SEKTOR = 512;
/** Sektoren je Cluster - 8 mal 512 Byte ergeben die 4096 von oben. */
export const SEKTOREN_PRO_CLUSTER = CLUSTERGROESSE / BYTES_PRO_SEKTOR;

/** Belegten Platz auf ganze Cluster aufrunden (MS-FSCC 2.4.10: Vielfaches der Clustergroesse). */
export function belegterPlatz(groesse: number): number {
  return Math.ceil(Math.max(groesse, 0) / CLUSTERGROESSE) * CLUSTERGROESSE;
}

/**
 * Windows-Dateiattribute aus einem Eintrag bilden (MS-FSCC 2.6).
 *
 * FILE_ATTRIBUTE_NORMAL darf laut Spezifikation nur allein stehen ("this flag
 * MUST be ignored if other flags are set"), wird also nur gesetzt, wenn sonst
 * nichts zutrifft. Ohne irgendein Attribut zeigt der Explorer Dateien teils
 * gar nicht an - der Wert 0 ist in 2.6 ausdruecklich keiner.
 */
export function dateiAttribute(eintrag: DateiEintrag): number {
  let attribute = 0;
  if (eintrag.istVerzeichnis) attribute |= FILE_ATTRIBUTE_DIRECTORY;
  if (eintrag.nurLesen) attribute |= FILE_ATTRIBUTE_READONLY;
  if (eintrag.versteckt) attribute |= FILE_ATTRIBUTE_HIDDEN;
  if (attribute === 0) attribute = FILE_ATTRIBUTE_NORMAL;
  return attribute >>> 0;
}

/** Die vier Zeitstempel eines Eintrags als Windows-Zeitangaben. */
function zeiten(eintrag: DateiEintrag): {
  erstellt: bigint;
  zugegriffen: bigint;
  geaendert: bigint;
} {
  const geaendert = nachFiletime(eintrag.geaendert);
  return {
    erstellt: nachFiletime(eintrag.erstellt ?? eintrag.geaendert),
    zugegriffen: nachFiletime(eintrag.zugegriffen ?? eintrag.geaendert),
    geaendert,
  };
}

/**
 * Ein Eintrag in der angeforderten Verzeichnisklasse.
 *
 * Je Antwort wird genau ein Eintrag geliefert; der Server fragt mit
 * InitialQuery = 0 nach dem naechsten (2.2.3.3.10). Deshalb ist
 * NextEntryOffset immer 0 und es gibt keine Ausrichtung auf acht Byte -
 * die waere nur zwischen mehreren Eintraegen in einem Puffer noetig
 * (MS-FSCC 2.4.10).
 *
 * Liefert `undefined`, wenn die Klasse nicht unterstuetzt wird.
 */
export function buildVerzeichnisEintrag(eintrag: DateiEintrag, klasse: number): Buffer | undefined {
  const name = Buffer.from(eintrag.name, 'ucs2');
  const z = zeiten(eintrag);
  const groesse = eintrag.istVerzeichnis ? 0 : Math.max(eintrag.groesse, 0);

  if (klasse === FileNamesInformation) {
    // MS-FSCC 2.4.26: NextEntryOffset(4) FileIndex(4) FileNameLength(4) FileName
    return writer().uint32le(0).uint32le(0).uint32le(name.length).bytes(name).toBuffer();
  }

  if (
    klasse !== FileDirectoryInformation &&
    klasse !== FileFullDirectoryInformation &&
    klasse !== FileBothDirectoryInformation
  ) {
    return undefined;
  }

  // Gemeinsamer Anfang von MS-FSCC 2.4.10, 2.4.14 und 2.4.8.
  const w = writer()
    .uint32le(0) // NextEntryOffset - es folgt kein weiterer Eintrag
    .uint32le(0) // FileIndex - laut Spezifikation zu ignorieren
    .bytes(u64le(z.erstellt))
    .bytes(u64le(z.zugegriffen))
    .bytes(u64le(z.geaendert))
    .bytes(u64le(z.geaendert)) // ChangeTime: eine eigene Quelle dafuer gibt es nicht
    .bytes(u64le(groesse)) // EndOfFile
    .bytes(u64le(belegterPlatz(groesse))) // AllocationSize
    .uint32le(dateiAttribute(eintrag))
    .uint32le(name.length);

  if (klasse === FileDirectoryInformation) {
    return w.bytes(name).toBuffer();
  }

  // EaSize: wir fuehren keine erweiterten Attribute, also 0. Ein Reparse-Tag
  // steht hier nur, wenn FILE_ATTRIBUTE_REPARSE_POINT gesetzt waere - das
  // setzen wir nie.
  w.uint32le(0);

  if (klasse === FileFullDirectoryInformation) {
    return w.bytes(name).toBuffer();
  }

  // FileBothDirectoryInformation: ShortNameLength(1) Reserved(1) ShortName(24).
  // Ein 8.3-Kurzname wird nicht gebildet - ShortNameLength 0 heisst "keiner",
  // und alle Windows-Versionen seit langem kommen ohne aus.
  return w.uint8(0).uint8(0).zeros(24).bytes(name).toBuffer();
}

/** FILE_BASIC_INFORMATION (MS-FSCC 2.4.7) ohne das Reserved-Feld (MS-RDPEFS 2.2.3.3.8). */
export function buildFileBasicInformation(eintrag: DateiEintrag): Buffer {
  const z = zeiten(eintrag);
  return writer()
    .bytes(u64le(z.erstellt))
    .bytes(u64le(z.zugegriffen))
    .bytes(u64le(z.geaendert))
    .bytes(u64le(z.geaendert)) // ChangeTime
    .uint32le(dateiAttribute(eintrag))
    .toBuffer();
}

/** FILE_STANDARD_INFORMATION (MS-FSCC 2.4.41) ohne Reserved (MS-RDPEFS 2.2.3.3.8). */
export function buildFileStandardInformation(eintrag: DateiEintrag, loeschVorgemerkt = false): Buffer {
  const groesse = eintrag.istVerzeichnis ? 0 : Math.max(eintrag.groesse, 0);
  return writer()
    .bytes(u64le(belegterPlatz(groesse))) // AllocationSize
    .bytes(u64le(groesse)) // EndOfFile
    .uint32le(1) // NumberOfLinks - genau ein Verzeichniseintrag zeigt hierher
    .uint8(loeschVorgemerkt ? 1 : 0)
    .uint8(eintrag.istVerzeichnis ? 1 : 0)
    .toBuffer();
}

/** FILE_ATTRIBUTE_TAG_INFORMATION (MS-FSCC 2.4.6). */
export function buildFileAttributeTagInformation(eintrag: DateiEintrag): Buffer {
  // ReparseTag bleibt 0: ohne FILE_ATTRIBUTE_REPARSE_POINT ist das Feld laut
  // Spezifikation zu ignorieren.
  return writer().uint32le(dateiAttribute(eintrag)).uint32le(0).toBuffer();
}

export interface VolumenAngaben {
  /** Bezeichnung, die der Explorer neben dem Laufwerksbuchstaben anzeigt. */
  bezeichnung: string;
  /** Seriennummer; ein beliebiger Wert, laut 2.5.9 ohne vorgeschriebenes Format. */
  seriennummer: number;
  /** Gesamtgroesse in Byte, die gemeldet wird. */
  gesamtBytes: number;
  /** Freier Platz in Byte. Im Nur-Lesen-Betrieb null. */
  freieBytes: number;
  /** Erstellungszeit des Datentraegers, Millisekunden seit der Unix-Epoche. */
  erstellt?: number;
  /** Nur-Lesen: setzt FILE_READ_ONLY_VOLUME und FILE_READ_ONLY_DEVICE. */
  nurLesen?: boolean;
}

/** FILE_FS_VOLUME_INFORMATION (MS-FSCC 2.5.9) ohne Reserved (MS-RDPEFS 2.2.3.3.6). */
export function buildFsVolumeInformation(v: VolumenAngaben): Buffer {
  const bezeichnung = Buffer.from(v.bezeichnung, 'ucs2');
  return writer()
    .bytes(u64le(nachFiletime(v.erstellt)))
    .uint32le(v.seriennummer)
    .uint32le(bezeichnung.length)
    .uint8(0) // SupportsObjects - keine objektorientierten Dateisystemobjekte
    .bytes(bezeichnung)
    .toBuffer();
}

/** FILE_FS_SIZE_INFORMATION (MS-FSCC 2.5.8). */
export function buildFsSizeInformation(v: VolumenAngaben): Buffer {
  const gesamt = BigInt(Math.floor(v.gesamtBytes / CLUSTERGROESSE));
  const frei = BigInt(Math.floor(v.freieBytes / CLUSTERGROESSE));
  return writer()
    .bytes(u64le(gesamt))
    .bytes(u64le(frei))
    .uint32le(SEKTOREN_PRO_CLUSTER)
    .uint32le(BYTES_PRO_SEKTOR)
    .toBuffer();
}

/** FILE_FS_FULL_SIZE_INFORMATION (MS-FSCC 2.5.4). */
export function buildFsFullSizeInformation(v: VolumenAngaben): Buffer {
  const gesamt = BigInt(Math.floor(v.gesamtBytes / CLUSTERGROESSE));
  const frei = BigInt(Math.floor(v.freieBytes / CLUSTERGROESSE));
  return writer()
    .bytes(u64le(gesamt)) // TotalAllocationUnits
    .bytes(u64le(frei)) // CallerAvailableAllocationUnits
    .bytes(u64le(frei)) // ActualAvailableAllocationUnits
    .uint32le(SEKTOREN_PRO_CLUSTER)
    .uint32le(BYTES_PRO_SEKTOR)
    .toBuffer();
}

/**
 * FILE_FS_ATTRIBUTE_INFORMATION (MS-FSCC 2.5.1).
 *
 * FILE_CASE_SENSITIVE_SEARCH wird nicht gemeldet: der Explorer und die
 * Windows-Programme dahinter erwarten Pfadvergleiche ohne Ruecksicht auf
 * Gross- und Kleinschreibung. Ein Arbeitsbereich unter Linux ist zwar
 * unterscheidungsempfindlich, aber diese Eigenschaft hier zu melden bringt
 * Windows-Programme durcheinander, ohne das Verhalten zu aendern.
 *
 * MaximumComponentNameLength ist 255 Zeichen, also 510 Byte - der von 2.5.1
 * erlaubte Hoechstwert.
 */
export function buildFsAttributeInformation(v: VolumenAngaben, dateisystemName = 'NTFS'): Buffer {
  const name = Buffer.from(dateisystemName, 'ucs2');
  let flags = FILE_CASE_PRESERVED_NAMES | FILE_UNICODE_ON_DISK;
  if (v.nurLesen) flags |= FILE_READ_ONLY_VOLUME;
  return writer()
    .uint32le(flags >>> 0)
    .uint32le(510)
    .uint32le(name.length)
    .bytes(name)
    .toBuffer();
}

/**
 * FILE_FS_DEVICE_INFORMATION (MS-FSCC 2.5.10).
 *
 * FILE_CHARACTERISTIC_TS_DEVICE sagt Windows, dass das Geraet Teil eines
 * Terminaldienst-Stapels ist - genau das ist es. FILE_REMOTE_DEVICE haelt den
 * Explorer davon ab, den Papierkorb und die Indizierung darauf anzulegen.
 */
export function buildFsDeviceInformation(v: VolumenAngaben): Buffer {
  let merkmale = FILE_REMOTE_DEVICE | FILE_DEVICE_IS_MOUNTED | FILE_CHARACTERISTIC_TS_DEVICE;
  if (v.nurLesen) merkmale |= FILE_READ_ONLY_DEVICE;
  return writer().uint32le(FILE_DEVICE_DISK).uint32le(merkmale >>> 0).toBuffer();
}

/** RDP_FILE_RENAME_INFORMATION (MS-RDPEFS 2.2.3.3.9.1). */
export interface RenameInformation {
  replaceIfExists: boolean;
  /** Zielpfad in der Schreibweise des Servers, also mit Rueckstrichen. */
  fileName: string;
}

export function parseRenameInformation(puffer: Buffer): RenameInformation {
  if (puffer.length < 6) throw new RdpProtocolError('RDPDR: Rename-Information zu kurz');
  const replaceIfExists = puffer.readUInt8(0) !== 0;
  // RootDirectory (1 Byte) ist bei Netzwerkoperationen laut 2.2.3.3.9.1 immer 0.
  const laenge = puffer.readUInt32LE(2);
  const vorhanden = Math.min(laenge, puffer.length - 6);
  return {
    replaceIfExists,
    fileName: puffer.subarray(6, 6 + vorhanden).toString('ucs2').replace(/\0+$/, ''),
  };
}

/** FILE_END_OF_FILE_INFORMATION (MS-FSCC 2.4.13): ein einzelnes 64-Bit-Feld. */
export function parseEndOfFileInformation(puffer: Buffer): bigint {
  if (puffer.length < 8) throw new RdpProtocolError('RDPDR: EndOfFile-Information zu kurz');
  return puffer.readBigInt64LE(0);
}

// ======================================================================
//  Pfade
// ======================================================================

/**
 * Namen, die laut MS-RDPEFS 3.2.5.2.3 mit STATUS_ACCESS_DENIED abzulehnen
 * sind. Der Vergleich ist ohne Ruecksicht auf Gross- und Kleinschreibung.
 *
 * Der Grund ist alt und ernst: unter Windows sind das Geraetenamen, und ein
 * Zugriff auf "COM1" oeffnet die serielle Schnittstelle statt einer Datei.
 */
const VERBOTENE_PFADNAMEN = /^(?:lpt[1-9]|com[1-9]|prn|aux)$/i;

/** Ergebnis der Pfadpruefung. */
export type PfadErgebnis =
  | { ok: true; /** Segmente ohne fuehrenden oder abschliessenden Trenner. */ segmente: string[] }
  | { ok: false; status: number; grund: string };

/**
 * Einen Pfad des Servers in geprueft Segmente zerlegen.
 *
 * Der Server schickt Pfade in Windows-Schreibweise, relativ zum Geraet:
 * "\" fuer die Wurzel, "\repo\src\datei.ts" fuer eine Datei. Geprueft wird:
 *
 *  - "..", "." und Segmente, die nur aus Punkten bestehen, werden abgelehnt.
 *    Ein "." koennte man auffangen, aber es ist in einem Protokollpfad nichts
 *    als ein Versuch, und die Ablehnung kostet nichts.
 *  - Ein eingebetteter Schraegstrich wird wie ein Rueckstrich behandelt.
 *    Windows akzeptiert beides, und wer nur den Rueckstrich zerlegt, laesst
 *    "..%2f" und Verwandtes durch.
 *  - Nullzeichen beenden unter Windows und POSIX Zeichenketten in C; ein
 *    Segment mit Nullzeichen wird abgelehnt.
 *  - Die Geraetenamen aus 3.2.5.2.3 werden abgelehnt.
 *
 * Das ist die einzige Stelle, an der aus einer Zeichenkette des Servers ein
 * Pfad wird. Wer daran vorbei arbeitet, umgeht die Pruefung.
 */
export function zerlegePfad(pfad: string): PfadErgebnis {
  const segmente: string[] = [];
  for (const roh of pfad.split(/[\\/]/)) {
    if (roh === '') continue; // fuehrender Trenner oder Doppeltrenner
    if (roh.includes('\0')) {
      return { ok: false, status: STATUS_OBJECT_NAME_NOT_FOUND, grund: `Nullzeichen im Segment "${roh}"` };
    }
    if (/^\.+$/.test(roh)) {
      return { ok: false, status: STATUS_ACCESS_DENIED, grund: `Pfadsegment "${roh}" ist nicht erlaubt` };
    }
    if (VERBOTENE_PFADNAMEN.test(roh)) {
      return { ok: false, status: STATUS_ACCESS_DENIED, grund: `Geraetename "${roh}" ist nicht erlaubt` };
    }
    segmente.push(roh);
  }
  return { ok: true, segmente };
}

/**
 * Segmente wieder zu einem Pfad mit Schraegstrichen zusammensetzen.
 * Die Wurzel ist die leere Zeichenkette.
 */
export function fuegePfad(segmente: readonly string[]): string {
  return segmente.join('/');
}

/**
 * Ein Suchmuster des Servers ("*", "*.ts", "datei?.txt") in eine
 * Uebereinstimmungsfunktion uebersetzen.
 *
 * Ohne Muster oder bei "*" wird alles genommen. Der Vergleich laeuft ohne
 * Ruecksicht auf Gross- und Kleinschreibung, wie unter Windows ueblich.
 */
export function musterPasst(muster: string | undefined): (name: string) => boolean {
  if (!muster || muster === '*' || muster === '*.*') return () => true;
  const regex = new RegExp(
    '^' +
      Array.from(muster, (z) => {
        if (z === '*') return '.*';
        if (z === '?') return '.';
        return z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('') +
      '$',
    'i',
  );
  return (name: string) => regex.test(name);
}

/**
 * Einen Query-Directory-Pfad in Verzeichnis und Suchmuster trennen.
 *
 * Windows haengt das Muster an den Pfad: "\repo\*" fragt den Inhalt von
 * "repo" ab. Ein letztes Segment mit "*" oder "?" ist deshalb das Muster,
 * alles davor der Pfad.
 */
export function trenneSuchmuster(pfad: string): { pfad: string; muster?: string } {
  const teile = pfad.split(/[\\/]/);
  const letztes = teile[teile.length - 1] ?? '';
  if (letztes.includes('*') || letztes.includes('?')) {
    return { pfad: teile.slice(0, -1).join('\\'), muster: letztes };
  }
  return { pfad };
}

/**
 * Das Suchmuster einer Verzeichnisanfrage bestimmen.
 *
 * Hier stossen zwei Lesarten aufeinander. MS-RDPEFS 2.2.3.3.10 nennt das
 * Feld Path schlicht "the directory on which this operation will be
 * performed". In der Praxis haengt Windows aber das Suchmuster an - "\repo\*"
 * beim Blaettern, "\repo\desktop.ini" beim Pruefen, ob eine bestimmte Datei
 * da ist. Beides muss richtig beantwortet werden, und ein blosser Blick auf
 * Sternchen und Fragezeichen reicht nicht: "desktop.ini" traegt keines und
 * ist trotzdem ein Muster.
 *
 * Die Unterscheidung gelingt ueber das bereits geoeffnete Verzeichnis. Deckt
 * sich alles vor dem letzten Segment mit dem Pfad des Handles, dann ist das
 * letzte Segment das Muster. Sonst ist der ganze Pfad als Verzeichnis
 * gemeint, und es wird nicht gefiltert.
 *
 * `verzeichnis` kommt aus dem Handle, nicht aus der Anfrage. Das ist der
 * Punkt: der Pfad der Anfrage wird hier nur *verglichen*, niemals benutzt, um
 * auf das Dateisystem zuzugreifen.
 */
export function suchmusterFuer(anfragePfad: string, verzeichnis: string): string | undefined {
  const teile = anfragePfad.split(/[\\/]/).filter((t) => t !== '');
  if (teile.length === 0) return undefined;
  const davor = teile.slice(0, -1).join('/');
  if (davor.toLowerCase() !== verzeichnis.toLowerCase()) return undefined;
  return teile[teile.length - 1];
}

// ======================================================================
//  Dateisystem-Schnittstelle
// ======================================================================

/**
 * Das Dateisystem, das hinter einem umgeleiteten Laufwerk steht.
 *
 * Alle Pfade sind *relativ* und mit Schraegstrichen geschrieben; die Wurzel
 * ist die leere Zeichenkette. Sie kommen ausschliesslich aus `zerlegePfad()`,
 * sind also bereits gegen "..", Nullzeichen und Geraetenamen geprueft. Eine
 * Umsetzung darf sich darauf verlassen - muss aber trotzdem dafuer sorgen,
 * dass sie ihre eigene Wurzel nicht verlaesst (Gurt *und* Hosentraeger).
 *
 * Die Schreibmethoden sind allesamt optional. Fehlt eine, beantwortet die
 * Sitzung die zugehoerige Anfrage mit STATUS_ACCESS_DENIED - das ist der
 * Nur-Lesen-Betrieb, und er ist der Standard.
 */
export interface RdpdrDateisystem {
  /** Metadaten zu einem Pfad, oder `undefined`, wenn es ihn nicht gibt. */
  stat(pfad: string): Promise<DateiEintrag | undefined>;
  /** Inhalt eines Verzeichnisses. Bereits gefiltert, falls der Aufrufer filtert. */
  liste(pfad: string): Promise<DateiEintrag[]>;
  /** Bytes aus einer Datei lesen. Weniger als `laenge` zurueckzugeben ist erlaubt. */
  lies(pfad: string, offset: number, laenge: number): Promise<Buffer>;

  /** Bytes schreiben; liefert die Zahl der geschriebenen Bytes. */
  schreibe?(pfad: string, offset: number, daten: Buffer): Promise<number>;
  /** Datei oder Verzeichnis anlegen. */
  erzeuge?(pfad: string, istVerzeichnis: boolean): Promise<void>;
  /** Datei oder (leeres) Verzeichnis loeschen. */
  loesche?(pfad: string): Promise<void>;
  /** Umbenennen oder verschieben. */
  benenneUm?(von: string, nach: string, ersetzen: boolean): Promise<void>;
  /** Datei auf die angegebene Laenge bringen (FileEndOfFileInformation). */
  kuerze?(pfad: string, laenge: number): Promise<void>;
}

/** Ein Laufwerk, das dem Server angekuendigt wird. */
export interface RdpdrLaufwerk {
  /** Eindeutig je Sitzung; wird in jeder I/O-Anfrage mitgeschickt. */
  deviceId: number;
  /** Name, den der Explorer anzeigt. */
  name: string;
  dateisystem: RdpdrDateisystem;
  /** Angaben fuer die Volumenklassen; fehlende Felder werden ergaenzt. */
  volumen?: Partial<VolumenAngaben>;
}

// ======================================================================
//  Sitzung
// ======================================================================

/** Zustand einer vom Server geoeffneten Datei oder eines Verzeichnisses. */
interface OffeneDatei {
  fileId: number;
  deviceId: number;
  /** Relativer Pfad mit Schraegstrichen; die Wurzel ist "". */
  pfad: string;
  istVerzeichnis: boolean;
  /** FILE_DELETE_ON_CLOSE stand in den CreateOptions. */
  loeschBeimSchliessen: boolean;
  /** FileDispositionInformation ist gekommen. */
  loeschVorgemerkt: boolean;
  /** Der Server hat Schreibzugriff angefragt. */
  schreibend: boolean;
  /** Aufzaehlung: die Eintraege der ersten Anfrage, danach fortlaufend. */
  eintraege?: DateiEintrag[];
  index: number;
  /** CompletionIds offener NotifyChange-Anfragen auf diesem Handle. */
  offeneBenachrichtigungen: number[];
}

export interface RdpdrSessionOptions {
  /** Fertige RDPDR-Nachricht auf den Kanal geben. */
  send(daten: Buffer): void;
  /** Rechnername fuer DR_CORE_CLIENT_NAME_REQ (2.2.2.4). */
  computerName: string;
  /**
   * Die Laufwerke, die angekuendigt werden sollen.
   *
   * Wird genau einmal je Sitzung aufgerufen, und zwar erst dann, wenn der
   * Handshake so weit ist, dass die Ankuendigung ueberhaupt hinausgehen darf.
   * Genau hier gehoert die Rueckfrage beim Benutzer hin: eine leere Liste
   * heisst "nichts freigeben", und die Sitzung laeuft ohne Laufwerk weiter.
   */
  laufwerke(): Promise<readonly RdpdrLaufwerk[]> | readonly RdpdrLaufwerk[];
  /**
   * Nur lesen. Standard `true` - der Server bekommt Quelltext zu sehen, und
   * das Schreibrecht dazu muss ausdruecklich erteilt werden.
   */
  nurLesen?: boolean;
  /**
   * Obergrenze fuer eine einzelne Leseantwort in Byte. Standard 4 MiB.
   * 2.2.3.4.3 erlaubt ausdruecklich, weniger zu liefern als angefragt.
   */
  maxLeseBytes?: number;
  /** Meldungen fuer das Sitzungsprotokoll. */
  log?(nachricht: string): void;
}

/** Standardgrenze fuer eine Leseantwort: 4 MiB. */
export const STANDARD_MAX_LESE_BYTES = 4 * 1024 * 1024;

/**
 * Von uns unterstuetzte Nebenversion des Protokolls (2.2.2.3).
 *
 * 0x000C und nicht 0x000D: erst ab 13 verlangt der Server das Anhaengen per
 * Offset 0xFFFFFFFFFFFFFFFF (2.2.1.4.4), und dafuer muesste das Dateisystem
 * eine eigene Anhaengeoperation mitbringen. Version 12 kennen alle
 * Windows-Server seit Windows 7.
 */
export const RDPDR_VERSION_MINOR = 0x000c;

/** Nebenversionen, die 2.2.2.3 ueberhaupt zulaesst. */
const ERLAUBTE_NEBENVERSIONEN = [0x0002, 0x0005, 0x000a, 0x000c, 0x000d] as const;

/**
 * Die hoechste zulaessige Nebenversion waehlen, die der Server auch versteht.
 *
 * Ein Server, der 0x0005 ankuendigt, bekommt von uns 0x0005 - eine hoehere
 * Zahl waere eine Behauptung ueber ihn, nicht ueber uns.
 */
export function waehleNebenversion(serverMinor: number): number {
  const obergrenze = Math.min(serverMinor, RDPDR_VERSION_MINOR);
  let gewaehlt: number = ERLAUBTE_NEBENVERSIONEN[0];
  for (const kandidat of ERLAUBTE_NEBENVERSIONEN) {
    if (kandidat <= obergrenze) gewaehlt = kandidat;
  }
  return gewaehlt;
}

/**
 * Zustandsmaschine des Clients auf dem Kanal `rdpdr`.
 *
 * Der Ablauf folgt MS-RDPEFS 3.2.5.1:
 *
 *  1. Der Server schickt DR_CORE_SERVER_ANNOUNCE_REQ. Wir antworten sofort
 *     mit DR_CORE_CLIENT_ANNOUNCE_RSP und direkt danach mit
 *     DR_CORE_CLIENT_NAME_REQ.
 *  2. Der Server schickt DR_CORE_CAPABILITY_REQ. Wir antworten mit unseren
 *     Faehigkeiten (General- und Drive-Satz).
 *  3. Der Server bestaetigt die ClientId (DR_CORE_SERVER_CLIENTID_CONFIRM)
 *     und meldet spaeter die Anmeldung (DR_CORE_USER_LOGGEDON).
 *  4. Sobald Faehigkeiten und Bestaetigung da sind - oder spaetestens bei der
 *     Anmeldung - kuendigen wir die Laufwerke an. Genau einmal: 3.2.5.1.9
 *     schreibt vor, dass eine Ankuendigung nur bisher unbekannte Geraete
 *     enthalten darf.
 *  5. Danach beantworten wir Device-I/O-Anfragen, bis der Kanal endet.
 */
export class RdpdrSession {
  private serverVersionMinor = 0;
  private nebenversion = RDPDR_VERSION_MINOR;
  private clientId = 0;
  private capsGesehen = false;
  private clientIdBestaetigt = false;
  private angekuendigt = false;
  /** Laeuft die Ankuendigung gerade (die Rueckfrage ist asynchron)? */
  private kuendigtGerade = false;
  private readonly laufwerke = new Map<number, RdpdrLaufwerk>();
  private readonly offeneDateien = new Map<number, OffeneDatei>();
  private naechsteFileId = 1;
  private beendet = false;

  constructor(private readonly opts: RdpdrSessionOptions) {}

  get nurLesen(): boolean {
    return this.opts.nurLesen !== false;
  }

  get maxLeseBytes(): number {
    const wert = this.opts.maxLeseBytes;
    return wert !== undefined && Number.isFinite(wert) && wert > 0 ? Math.floor(wert) : STANDARD_MAX_LESE_BYTES;
  }

  /** Sind die Laufwerke bereits angekuendigt? */
  get istBereit(): boolean {
    return this.angekuendigt;
  }

  /** Nur Protokollzustand, keine Datei- oder Anmeldeinhalte. */
  get diagnose() {
    return {
      serverAnnounce: this.serverVersionMinor !== 0,
      capabilities: this.capsGesehen,
      clientIdBestaetigt: this.clientIdBestaetigt,
      freigabeLaeuft: this.kuendigtGerade,
      listeVerarbeitet: this.angekuendigt,
      laufwerke: this.laufwerke.size,
    };
  }

  /** Zahl der gerade offenen Datei-Handles - fuer Protokoll und Tests. */
  get offeneHandles(): number {
    return this.offeneDateien.size;
  }

  private protokoll(nachricht: string): void {
    this.opts.log?.(nachricht);
  }

  private sende(daten: Buffer): void {
    if (this.beendet) return;
    this.opts.send(daten);
  }

  /**
   * Die Sitzung stilllegen.
   *
   * Danach geht nichts mehr hinaus - wichtig, wenn die Verbindung weg ist und
   * noch asynchrone Dateioperationen unterwegs sind, deren Antwort ins Leere
   * liefe.
   */
  dispose(): void {
    this.beendet = true;
    this.offeneDateien.clear();
  }

  /**
   * Alles auf Anfang.
   *
   * 3.2.5.1.2: Kommt ein Server Announce mitten in einer laufenden Sitzung,
   * hat der Server neu verbunden. Dann sind alle Anfragen hinfaellig und alle
   * Geraetereferenzen freizugeben.
   */
  zuruecksetzen(): void {
    this.serverVersionMinor = 0;
    this.nebenversion = RDPDR_VERSION_MINOR;
    this.clientId = 0;
    this.capsGesehen = false;
    this.clientIdBestaetigt = false;
    this.angekuendigt = false;
    this.kuendigtGerade = false;
    this.laufwerke.clear();
    this.offeneDateien.clear();
    this.naechsteFileId = 1;
    this.beendet = false;
  }

  // -------------------------------------------------------------- Eingang

  /**
   * Eine vollstaendig zusammengesetzte Nachricht des Kanals verarbeiten.
   *
   * Wirft nicht: ein unverstaendliches PDU wird protokolliert und verworfen.
   * Ein kaputtes Laufwerk darf keine Sitzung beenden.
   */
  verarbeite(daten: Buffer): void {
    if (this.beendet) return;
    let pdu: RdpdrPdu;
    try {
      pdu = parseRdpdrPdu(daten);
    } catch (err) {
      this.protokoll(`RDPDR: Nachricht verworfen - ${(err as Error).message}`);
      return;
    }

    if (pdu.component !== RDPDR_CTYP_CORE) {
      // RDPDR_CTYP_PRN gehoert zur Druckerumleitung (MS-RDPEPC). Wir kuendigen
      // keine Drucker an, also kommt das hoechstens von einem Server, der sich
      // vertut - stillschweigend verwerfen ist richtig.
      this.protokoll(`RDPDR: Komponente 0x${pdu.component.toString(16)} wird nicht bedient`);
      return;
    }

    try {
      switch (pdu.packetId) {
        case PAKID_CORE_SERVER_ANNOUNCE:
          this.behandleServerAnnounce(pdu.body);
          break;
        case PAKID_CORE_SERVER_CAPABILITY:
          this.behandleCapabilities(pdu.body);
          break;
        case PAKID_CORE_CLIENTID_CONFIRM:
          this.behandleClientIdConfirm(pdu.body);
          break;
        case PAKID_CORE_USER_LOGGEDON:
          this.protokoll('RDPDR: der Server meldet die Anmeldung');
          this.kuendigeAn();
          break;
        case PAKID_CORE_DEVICE_REPLY:
          this.behandleDeviceReply(pdu.body);
          break;
        case PAKID_CORE_DEVICE_IOREQUEST:
          this.behandleIoRequest(pdu.body);
          break;
        default:
          this.protokoll(`RDPDR: PacketId 0x${pdu.packetId.toString(16)} wird nicht behandelt`);
      }
    } catch (err) {
      this.protokoll(
        `RDPDR: Fehler beim Verarbeiten von 0x${pdu.packetId.toString(16)} - ${(err as Error).message}`,
      );
    }
  }

  // ------------------------------------------------------------ Handshake

  private behandleServerAnnounce(body: Buffer): void {
    if (this.angekuendigt || this.capsGesehen) {
      // 3.2.5.1.2: ein zweites Announce heisst "neue Sitzung".
      this.protokoll('RDPDR: erneutes Server Announce - die Sitzung faengt von vorn an');
      this.zuruecksetzen();
    }
    const announce = parseServerAnnounce(body);
    this.serverVersionMinor = announce.versionMinor;
    this.nebenversion = waehleNebenversion(announce.versionMinor);

    // 3.2.5.1.3: ab Nebenversion 12 uebernimmt der Client die ClientId des
    // Servers, darunter zieht er eine eigene Zufallszahl.
    this.clientId =
      announce.versionMinor >= 0x000c ? announce.clientId : Math.floor(Math.random() * 0xffffffff) >>> 0;

    this.protokoll(
      `RDPDR: Server-Version ${announce.versionMajor}.${announce.versionMinor}, ` +
        `wir antworten mit 1.${this.nebenversion} (ClientId 0x${this.clientId.toString(16)})`,
    );
    this.sende(buildClientAnnounceReply(1, this.nebenversion, this.clientId));
    // 3.2.5.1.4: der Rechnername folgt unmittelbar.
    this.sende(buildClientNameRequest(this.opts.computerName));
  }

  private behandleCapabilities(body: Buffer): void {
    const saetze = parseCapabilities(body);
    const namen = saetze
      .map((s) => `0x${s.capabilityType.toString(16)} (v${s.version})`)
      .join(', ');
    this.protokoll(`RDPDR: Server-Faehigkeiten: ${namen || 'keine'}`);
    const drive = saetze.find((s) => s.capabilityType === CAP_DRIVE_TYPE);
    if (!drive) {
      // Kein Drive-Satz heisst: der Server will keine Laufwerke. Wir kuendigen
      // trotzdem an - manche Server lassen den Satz weg und nehmen Laufwerke
      // dennoch entgegen; die Device Announce Response sagt es uns dann.
      this.protokoll('RDPDR: der Server nennt keinen Drive-Satz - wir kuendigen trotzdem an');
    }
    this.capsGesehen = true;
    this.sende(buildClientCapabilities({ versionMinor: this.nebenversion }));
    this.kuendigeAn();
  }

  private behandleClientIdConfirm(body: Buffer): void {
    const bestaetigt = parseServerAnnounce(body); // gleicher Aufbau wie 2.2.2.2
    if (bestaetigt.clientId !== this.clientId) {
      // Kein Grund abzubrechen: 2.2.2.6 verlangt Gleichheit, aber ein
      // abweichender Wert bringt nichts durcheinander - die ClientId kommt in
      // keiner weiteren Nachricht vor.
      this.protokoll(
        `RDPDR: der Server bestaetigt ClientId 0x${bestaetigt.clientId.toString(16)}, ` +
          `wir hatten 0x${this.clientId.toString(16)} geschickt`,
      );
    }
    this.clientIdBestaetigt = true;
    this.kuendigeAn();
  }

  /**
   * Die Laufwerke ankuendigen - genau einmal.
   *
   * 3.2.5.1.9 nennt zwei Ausloeser: unmittelbar nach der Anmeldung, oder nach
   * Faehigkeiten *und* ClientId-Bestaetigung. Welcher zuerst eintritt, ist
   * dem Server ueberlassen; wir nehmen den frueheren und sperren danach.
   */
  private kuendigeAn(): void {
    if (this.angekuendigt || this.kuendigtGerade) return;
    if (!this.capsGesehen || !this.clientIdBestaetigt) return;
    this.kuendigtGerade = true;

    void (async () => {
      let liste: readonly RdpdrLaufwerk[] = [];
      try {
        liste = await this.opts.laufwerke();
      } catch (err) {
        this.protokoll(`RDPDR: die Laufwerksliste konnte nicht ermittelt werden - ${(err as Error).message}`);
      }
      if (this.beendet) return;
      this.kuendigtGerade = false;
      this.angekuendigt = true;

      if (liste.length === 0) {
        // Voellig in Ordnung: abgeschaltet, leerer Arbeitsbereich oder
        // verneinte Rueckfrage. Der Server bekommt dann gar keine
        // Geraeteliste, und die Sitzung laeuft wie ohne diese Erweiterung.
        this.protokoll('RDPDR: keine Laufwerke freigegeben - der Kanal bleibt leer');
        return;
      }

      this.laufwerke.clear();
      for (const laufwerk of liste) this.laufwerke.set(laufwerk.deviceId, laufwerk);
      this.sende(buildDeviceListAnnounce(liste.map((l) => ({ deviceId: l.deviceId, name: l.name }))));
      this.protokoll(
        `RDPDR: ${liste.length} Laufwerk(e) angekuendigt (${liste.map((l) => l.name).join(', ')})` +
          `${this.nurLesen ? ', nur lesen' : ', lesen und schreiben'}`,
      );
    })();
  }

  private behandleDeviceReply(body: Buffer): void {
    const antwort = parseDeviceAnnounceResponse(body);
    const laufwerk = this.laufwerke.get(antwort.deviceId);
    const name = laufwerk?.name ?? `Geraet ${antwort.deviceId}`;
    if (antwort.resultCode === STATUS_SUCCESS) {
      this.protokoll(`RDPDR: "${name}" ist im Explorer verfuegbar`);
      return;
    }
    // 3.2.5.1.1: alles ausser STATUS_SUCCESS heisst, dass das Geraet nicht
    // umgeleitet wird. Wir vergessen es, damit spaetere Anfragen darauf nicht
    // ins Leere laufen.
    this.laufwerke.delete(antwort.deviceId);
    this.protokoll(
      `RDPDR: der Server hat "${name}" abgelehnt (NTSTATUS 0x${antwort.resultCode.toString(16)})`,
    );
  }

  // ----------------------------------------------------- Device I/O (2.2.3.3)

  /**
   * Eine Serveranfrage an ein Laufwerk bearbeiten.
   *
   * Die eigentliche Arbeit ist asynchron (das Dateisystem kann entfernt sein),
   * der Eingang aber nicht. Deshalb wird hier nur ausgeloest; jede Antwort
   * findet ueber die CompletionId zurueck zu ihrer Anfrage (2.2.1.5).
   */
  private behandleIoRequest(body: Buffer): void {
    let anfrage: RdpdrRequest;
    try {
      anfrage = parseDeviceIoRequest(body);
    } catch (err) {
      // Ohne CompletionId koennen wir gar nicht antworten. Der Server laeuft
      // dann in einen Zeitablauf - besser als eine Antwort auf gut Glueck.
      this.protokoll(`RDPDR: unlesbare I/O-Anfrage verworfen - ${(err as Error).message}`);
      return;
    }

    const laufwerk = this.laufwerke.get(anfrage.deviceId);
    if (!laufwerk) {
      this.protokoll(`RDPDR: Anfrage fuer unbekanntes Geraet ${anfrage.deviceId} abgelehnt`);
      this.sende(buildDeviceIoResponse(anfrage.deviceId, anfrage.completionId, STATUS_INVALID_DEVICE_REQUEST));
      return;
    }

    void this.bearbeite(laufwerk, anfrage).catch((err: Error) => {
      // Eine unerwartete Ausnahme darf keine offene Anfrage hinterlassen:
      // Windows blockiert den Explorer, bis die Antwort da ist.
      this.protokoll(`RDPDR: ${anfrage.art} fehlgeschlagen - ${err.message}`);
      this.sende(this.fehlerAntwort(anfrage, STATUS_UNSUCCESSFUL));
    });
  }

  /**
   * Eine Fehlerantwort im Rahmen der jeweiligen Anfrageart.
   *
   * Die Rahmen unterscheiden sich: Windows liest die Antwort nach der Art der
   * Anfrage, nicht nach dem IoStatus. Eine blosse 16-Byte-Antwort auf ein
   * IRP_MJ_CREATE laesst manche Server den Kanal abbrechen.
   */
  private fehlerAntwort(anfrage: RdpdrRequest, status: number): Buffer {
    const { deviceId, completionId } = anfrage;
    switch (anfrage.art) {
      case 'create':
        return buildCreateResponse(deviceId, completionId, status, 0, 0);
      case 'close':
        return buildCloseResponse(deviceId, completionId, status);
      case 'read':
        return buildReadResponse(deviceId, completionId, status, Buffer.alloc(0));
      case 'write':
        return buildWriteResponse(deviceId, completionId, status, 0);
      case 'control':
        return buildControlResponse(deviceId, completionId, status);
      case 'setInformation':
        return buildSetInformationResponse(deviceId, completionId, status, anfrage.length);
      case 'setVolumeInformation':
        return buildSetInformationResponse(deviceId, completionId, status, anfrage.buffer.length);
      case 'lockControl':
        return buildLockResponse(deviceId, completionId, status);
      case 'queryInformation':
      case 'queryVolumeInformation':
      case 'queryDirectory':
      case 'notifyChangeDirectory':
        return buildLaengeUndPuffer(deviceId, completionId, status, Buffer.alloc(0));
      default:
        return buildDeviceIoResponse(deviceId, completionId, status);
    }
  }

  private async bearbeite(laufwerk: RdpdrLaufwerk, anfrage: RdpdrRequest): Promise<void> {
    switch (anfrage.art) {
      case 'create':
        return this.bearbeiteCreate(laufwerk, anfrage);
      case 'close':
        return this.bearbeiteClose(laufwerk, anfrage);
      case 'read':
        return this.bearbeiteRead(laufwerk, anfrage);
      case 'write':
        return this.bearbeiteWrite(laufwerk, anfrage);
      case 'queryInformation':
        return this.bearbeiteQueryInformation(laufwerk, anfrage);
      case 'setInformation':
        return this.bearbeiteSetInformation(laufwerk, anfrage);
      case 'queryVolumeInformation':
        return this.bearbeiteQueryVolumeInformation(laufwerk, anfrage);
      case 'queryDirectory':
        return this.bearbeiteQueryDirectory(laufwerk, anfrage);
      case 'notifyChangeDirectory':
        return this.bearbeiteNotifyChange(anfrage);
      case 'lockControl':
        // Ohne echte Sperrverwaltung: wir melden Erfolg. Eine Ablehnung
        // laesst Programme, die vor dem Schreiben sperren, gar nicht erst
        // starten - und Nebenlaeufigkeit gibt es hier ohnehin keine, weil
        // ENABLE_ASYNCIO nicht angekuendigt ist.
        this.protokoll(`RDPDR: Sperranfrage (Operation ${anfrage.operation}) bestaetigt, ohne zu sperren`);
        this.sende(buildLockResponse(anfrage.deviceId, anfrage.completionId, STATUS_SUCCESS));
        return;
      case 'control':
        // 2.2.3.3.5 zaehlt die moeglichen FSCTL-Codes auf; wir setzen keinen
        // davon um. STATUS_NOT_SUPPORTED mit leerem Ausgabepuffer ist die
        // ehrliche Antwort - und Windows kommt damit zurecht.
        this.protokoll(`RDPDR: FSCTL 0x${anfrage.ioControlCode.toString(16)} wird nicht unterstuetzt`);
        this.sende(
          buildControlResponse(anfrage.deviceId, anfrage.completionId, STATUS_NOT_SUPPORTED, Buffer.alloc(0)),
        );
        return;
      case 'setVolumeInformation':
        // Die einzige Klasse waere FileFsLabelInformation (2.2.3.3.7). Den
        // Namen des Laufwerks bestimmt der Arbeitsbereich, nicht der Server.
        this.protokoll('RDPDR: Umbenennen des Datentraegers abgelehnt');
        this.sende(
          buildSetInformationResponse(
            anfrage.deviceId,
            anfrage.completionId,
            STATUS_ACCESS_DENIED,
            anfrage.buffer.length,
          ),
        );
        return;
      default:
        this.protokoll(
          `RDPDR: MajorFunction 0x${anfrage.majorFunction.toString(16)}` +
            `/0x${anfrage.minorFunction.toString(16)} wird nicht unterstuetzt`,
        );
        this.sende(buildDeviceIoResponse(anfrage.deviceId, anfrage.completionId, STATUS_NOT_SUPPORTED));
    }
  }

  // ------------------------------------------------------------ Create

  private async bearbeiteCreate(laufwerk: RdpdrLaufwerk, anfrage: CreateRequest): Promise<void> {
    const antwort = (status: number, fileId = 0, information = 0): void => {
      this.sende(buildCreateResponse(anfrage.deviceId, anfrage.completionId, status, fileId, information));
    };

    const zerlegt = zerlegePfad(anfrage.path);
    if (!zerlegt.ok) {
      this.protokoll(`RDPDR: Create abgewiesen - ${zerlegt.grund} (Pfad "${anfrage.path}")`);
      antwort(zerlegt.status);
      return;
    }
    const pfad = fuegePfad(zerlegt.segmente);

    // Schreibwunsch in zwei Stufen. Sicher ist er schon an den Zugriffsbits,
    // an einer veraendernden CreateDisposition und an FILE_DELETE_ON_CLOSE zu
    // erkennen - das laesst sich ohne Blick aufs Dateisystem entscheiden.
    const veraenderndeDisposition =
      anfrage.createDisposition === FILE_CREATE ||
      anfrage.createDisposition === FILE_OVERWRITE ||
      anfrage.createDisposition === FILE_OVERWRITE_IF ||
      anfrage.createDisposition === FILE_SUPERSEDE;
    const sicherSchreibend =
      (anfrage.desiredAccess & SCHREIBZUGRIFF_BITS) !== 0 ||
      veraenderndeDisposition ||
      (anfrage.createOptions & FILE_DELETE_ON_CLOSE) !== 0;

    if (sicherSchreibend && this.nurLesen) {
      this.protokoll(`RDPDR: Schreibzugriff auf "${pfad || '\\'}" abgelehnt - das Laufwerk ist nur lesbar`);
      antwort(STATUS_ACCESS_DENIED);
      return;
    }

    const vorhanden = pfad === '' ? { name: '', istVerzeichnis: true, groesse: 0 } : await laufwerk.dateisystem.stat(pfad);

    // Die zweite Stufe ist FILE_OPEN_IF: "oeffnen, sonst anlegen". Ob das ein
    // Schreibwunsch ist, haengt daran, ob die Datei schon da ist. Pauschal
    // abzulehnen waere zu streng - manche Programme oeffnen grundsaetzlich so,
    // auch wenn sie nur lesen wollen.
    const willSchreiben = sicherSchreibend || (anfrage.createDisposition === FILE_OPEN_IF && !vorhanden);
    if (willSchreiben && this.nurLesen) {
      this.protokoll(
        `RDPDR: Anlegen von "${pfad || '\\'}" abgelehnt - das Laufwerk ist nur lesbar`,
      );
      antwort(STATUS_ACCESS_DENIED);
      return;
    }

    if (vorhanden) {
      if ((anfrage.createOptions & FILE_DIRECTORY_FILE) !== 0 && !vorhanden.istVerzeichnis) {
        antwort(STATUS_NOT_A_DIRECTORY);
        return;
      }
      if ((anfrage.createOptions & FILE_NON_DIRECTORY_FILE) !== 0 && vorhanden.istVerzeichnis) {
        antwort(STATUS_FILE_IS_A_DIRECTORY);
        return;
      }
      if (anfrage.createDisposition === FILE_CREATE) {
        antwort(STATUS_OBJECT_NAME_COLLISION);
        return;
      }
      // Ueberschreiben heisst: Inhalt weg, Handle bleibt.
      const ueberschreiben =
        anfrage.createDisposition === FILE_OVERWRITE ||
        anfrage.createDisposition === FILE_OVERWRITE_IF ||
        anfrage.createDisposition === FILE_SUPERSEDE;
      if (ueberschreiben && !vorhanden.istVerzeichnis) {
        if (!laufwerk.dateisystem.kuerze) {
          antwort(STATUS_ACCESS_DENIED);
          return;
        }
        await laufwerk.dateisystem.kuerze(pfad, 0);
      }
    } else {
      if (anfrage.createDisposition === FILE_OPEN || anfrage.createDisposition === FILE_OVERWRITE) {
        // Kein Fehlerprotokoll: der Explorer fragt bei jedem Verzeichniswechsel
        // nach desktop.ini, Thumbs.db und autorun.inf. Das ist der Normalfall.
        antwort(STATUS_OBJECT_NAME_NOT_FOUND);
        return;
      }
      if (!laufwerk.dateisystem.erzeuge) {
        antwort(STATUS_ACCESS_DENIED);
        return;
      }
      const alsVerzeichnis = (anfrage.createOptions & FILE_DIRECTORY_FILE) !== 0;
      await laufwerk.dateisystem.erzeuge(pfad, alsVerzeichnis);
      this.protokoll(`RDPDR: "${pfad}" ${alsVerzeichnis ? 'als Verzeichnis' : ''} angelegt`);
    }

    const eintrag = pfad === '' ? { name: '', istVerzeichnis: true, groesse: 0 } : await laufwerk.dateisystem.stat(pfad);
    if (!eintrag) {
      // Angelegt und trotzdem nicht da - das ist ein Fehler des Dateisystems.
      antwort(STATUS_UNSUCCESSFUL);
      return;
    }

    const fileId = this.naechsteFileId++;
    this.offeneDateien.set(fileId, {
      fileId,
      deviceId: anfrage.deviceId,
      pfad,
      istVerzeichnis: eintrag.istVerzeichnis,
      loeschBeimSchliessen: (anfrage.createOptions & FILE_DELETE_ON_CLOSE) !== 0,
      loeschVorgemerkt: false,
      schreibend: willSchreiben,
      index: 0,
      offeneBenachrichtigungen: [],
    });

    // 2.2.3.4.1: FILE_OPENED nur bei FILE_OPEN_IF, FILE_OVERWRITTEN nur bei
    // FILE_OVERWRITE_IF, sonst FILE_SUPERSEDED. Das haengt allein an der
    // CreateDisposition, nicht daran, was tatsaechlich passiert ist.
    const information =
      anfrage.createDisposition === FILE_OPEN_IF
        ? FILE_OPENED
        : anfrage.createDisposition === FILE_OVERWRITE_IF
          ? FILE_OVERWRITTEN
          : FILE_SUPERSEDED;
    antwort(STATUS_SUCCESS, fileId, information);
  }

  // ------------------------------------------------------------- Close

  private async bearbeiteClose(laufwerk: RdpdrLaufwerk, anfrage: CloseRequest): Promise<void> {
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei) {
      // Ein Close auf ein unbekanntes Handle ist kein Drama - antworten muss
      // man trotzdem, sonst wartet der Server.
      this.sende(buildCloseResponse(anfrage.deviceId, anfrage.completionId, STATUS_SUCCESS));
      return;
    }
    this.offeneDateien.delete(anfrage.fileId);

    // 2.2.3.4.11: offene NotifyChange-Anfragen werden beim Schliessen mit
    // leerem Puffer abgeschlossen. Wer sie liegen laesst, blockiert den
    // Explorer-Thread, der auf die Benachrichtigung wartet.
    for (const completionId of datei.offeneBenachrichtigungen) {
      this.sende(buildLaengeUndPuffer(anfrage.deviceId, completionId, STATUS_SUCCESS, Buffer.alloc(0)));
    }

    if ((datei.loeschBeimSchliessen || datei.loeschVorgemerkt) && datei.pfad !== '') {
      if (this.nurLesen || !laufwerk.dateisystem.loesche) {
        this.protokoll(`RDPDR: Loeschen von "${datei.pfad}" beim Schliessen abgelehnt - nur lesen`);
      } else {
        try {
          await laufwerk.dateisystem.loesche(datei.pfad);
          this.protokoll(`RDPDR: "${datei.pfad}" geloescht`);
        } catch (err) {
          // Der Close muss trotzdem gelingen: 2.2.1.5.2 kennt keinen Weg,
          // "geschlossen, aber nicht geloescht" zu melden.
          this.protokoll(`RDPDR: "${datei.pfad}" konnte nicht geloescht werden - ${(err as Error).message}`);
        }
      }
    }

    this.sende(buildCloseResponse(anfrage.deviceId, anfrage.completionId, STATUS_SUCCESS));
  }

  // -------------------------------------------------------------- Read

  private async bearbeiteRead(laufwerk: RdpdrLaufwerk, anfrage: ReadRequest): Promise<void> {
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei) {
      this.sende(
        buildReadResponse(anfrage.deviceId, anfrage.completionId, STATUS_INVALID_DEVICE_REQUEST, Buffer.alloc(0)),
      );
      return;
    }
    if (datei.istVerzeichnis) {
      this.sende(
        buildReadResponse(anfrage.deviceId, anfrage.completionId, STATUS_INVALID_DEVICE_REQUEST, Buffer.alloc(0)),
      );
      return;
    }

    const offset = Number(anfrage.offset);
    const laenge = Math.min(anfrage.length, this.maxLeseBytes);
    const daten = await laufwerk.dateisystem.lies(datei.pfad, offset, laenge);
    if (daten.length === 0 && anfrage.length > 0) {
      // NT-Semantik: am Dateiende liefert ein Lesen STATUS_END_OF_FILE, nicht
      // Erfolg mit null Bytes. 2.2.3.4.3 nennt fuer den Erfolgsfall
      // ausdruecklich "any number between one and ...".
      this.sende(buildReadResponse(anfrage.deviceId, anfrage.completionId, STATUS_END_OF_FILE, Buffer.alloc(0)));
      return;
    }
    this.sende(buildReadResponse(anfrage.deviceId, anfrage.completionId, STATUS_SUCCESS, daten));
  }

  // ------------------------------------------------------------- Write

  private async bearbeiteWrite(laufwerk: RdpdrLaufwerk, anfrage: WriteRequest): Promise<void> {
    const antwort = (status: number, geschrieben = 0): void => {
      this.sende(buildWriteResponse(anfrage.deviceId, anfrage.completionId, status, geschrieben));
    };
    if (this.nurLesen || !laufwerk.dateisystem.schreibe) {
      this.protokoll('RDPDR: Schreibanfrage abgelehnt - das Laufwerk ist nur lesbar');
      antwort(STATUS_ACCESS_DENIED);
      return;
    }
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei || datei.istVerzeichnis) {
      antwort(STATUS_INVALID_DEVICE_REQUEST);
      return;
    }
    if (!datei.schreibend) {
      // Der Server hat das Handle ohne Schreibrecht geoeffnet.
      antwort(STATUS_ACCESS_DENIED);
      return;
    }

    // 2.2.1.4.4: 0xFFFFFFFFFFFFFFFF heisst "anhaengen", aber erst ab
    // Nebenversion 13. Wir kuendigen 12 an, also darf das nicht kommen - wenn
    // es doch kommt, ist Ablehnen ehrlicher als an Offset 2^64 zu schreiben.
    if (anfrage.offset === 0xffffffffffffffffn) {
      this.protokoll('RDPDR: Anhaengen (Offset -1) wird nicht unterstuetzt - wir melden Version 1.12');
      antwort(STATUS_NOT_SUPPORTED);
      return;
    }

    const geschrieben = await laufwerk.dateisystem.schreibe(datei.pfad, Number(anfrage.offset), anfrage.data);
    antwort(STATUS_SUCCESS, geschrieben);
  }

  // -------------------------------------------------- Query Information

  private async bearbeiteQueryInformation(
    laufwerk: RdpdrLaufwerk,
    anfrage: QueryInformationRequest,
  ): Promise<void> {
    const antwort = (status: number, puffer: Buffer = Buffer.alloc(0)): void => {
      this.sende(buildLaengeUndPuffer(anfrage.deviceId, anfrage.completionId, status, puffer));
    };
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei) {
      antwort(STATUS_INVALID_DEVICE_REQUEST);
      return;
    }
    const eintrag = await this.eintragZu(laufwerk, datei);
    if (!eintrag) {
      antwort(STATUS_OBJECT_NAME_NOT_FOUND);
      return;
    }

    switch (anfrage.fsInformationClass) {
      case FileBasicInformation:
        antwort(STATUS_SUCCESS, buildFileBasicInformation(eintrag));
        return;
      case FileStandardInformation:
        antwort(STATUS_SUCCESS, buildFileStandardInformation(eintrag, datei.loeschVorgemerkt));
        return;
      case FileAttributeTagInformation:
        antwort(STATUS_SUCCESS, buildFileAttributeTagInformation(eintrag));
        return;
      default:
        // 2.2.3.3.8 nennt genau diese drei Klassen. Alles andere kommt von
        // einem Server, der mehr versucht, als das Protokoll vorsieht.
        this.protokoll(
          `RDPDR: Informationsklasse 0x${anfrage.fsInformationClass.toString(16)} wird nicht unterstuetzt`,
        );
        antwort(STATUS_NOT_SUPPORTED);
    }
  }

  // ---------------------------------------------------- Set Information

  private async bearbeiteSetInformation(
    laufwerk: RdpdrLaufwerk,
    anfrage: SetInformationRequest,
  ): Promise<void> {
    const antwort = (status: number): void => {
      this.sende(buildSetInformationResponse(anfrage.deviceId, anfrage.completionId, status, anfrage.length));
    };
    if (this.nurLesen) {
      this.protokoll('RDPDR: Aenderungsanfrage abgelehnt - das Laufwerk ist nur lesbar');
      antwort(STATUS_ACCESS_DENIED);
      return;
    }
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei) {
      antwort(STATUS_INVALID_DEVICE_REQUEST);
      return;
    }

    switch (anfrage.fsInformationClass) {
      case FileRenameInformation: {
        if (!laufwerk.dateisystem.benenneUm) {
          antwort(STATUS_ACCESS_DENIED);
          return;
        }
        const info = parseRenameInformation(anfrage.buffer);
        const zerlegt = zerlegePfad(info.fileName);
        if (!zerlegt.ok) {
          this.protokoll(`RDPDR: Umbenennen abgewiesen - ${zerlegt.grund} (Ziel "${info.fileName}")`);
          antwort(zerlegt.status);
          return;
        }
        const ziel = fuegePfad(zerlegt.segmente);
        if (ziel === '') {
          // Die Wurzel laesst sich nicht umbenennen, und ein leeres Ziel
          // wuerde beim Dateisystem als "alles" ankommen.
          antwort(STATUS_ACCESS_DENIED);
          return;
        }
        await laufwerk.dateisystem.benenneUm(datei.pfad, ziel, info.replaceIfExists);
        this.protokoll(`RDPDR: "${datei.pfad}" heisst jetzt "${ziel}"`);
        datei.pfad = ziel;
        antwort(STATUS_SUCCESS);
        return;
      }
      case FileDispositionInformation: {
        // 2.2.3.3.9: der Puffer ist leer, DeletePending gilt als gesetzt.
        // Geloescht wird erst beim Schliessen - so will es die NT-Semantik,
        // und der Server schickt gleich darauf ein IRP_MJ_CLOSE.
        if (!laufwerk.dateisystem.loesche) {
          antwort(STATUS_ACCESS_DENIED);
          return;
        }
        datei.loeschVorgemerkt = true;
        this.protokoll(`RDPDR: "${datei.pfad}" ist zum Loeschen vorgemerkt`);
        antwort(STATUS_SUCCESS);
        return;
      }
      case FileEndOfFileInformation:
      case FileAllocationInformation: {
        if (!laufwerk.dateisystem.kuerze) {
          antwort(STATUS_ACCESS_DENIED);
          return;
        }
        const laenge = Number(parseEndOfFileInformation(anfrage.buffer));
        if (laenge < 0) {
          antwort(STATUS_INVALID_PARAMETER);
          return;
        }
        await laufwerk.dateisystem.kuerze(datei.pfad, laenge);
        antwort(STATUS_SUCCESS);
        return;
      }
      case FileBasicInformation: {
        // Zeiten und Attribute lassen sich ueber vscode.workspace.fs nicht
        // setzen. Ein Fehler waere hier die schlechtere Antwort: Windows
        // setzt die Zeitstempel am Ende jedes Kopiervorgangs, und ein
        // abgelehntes SetInformation laesst den ganzen Kopiervorgang
        // scheitern, obwohl die Daten vollstaendig angekommen sind.
        this.protokoll(`RDPDR: Zeiten und Attribute von "${datei.pfad}" werden nicht uebernommen`);
        antwort(STATUS_SUCCESS);
        return;
      }
      default:
        this.protokoll(
          `RDPDR: Setzen der Klasse 0x${anfrage.fsInformationClass.toString(16)} wird nicht unterstuetzt`,
        );
        antwort(STATUS_NOT_SUPPORTED);
    }
  }

  // --------------------------------------------- Query Volume Information

  private async bearbeiteQueryVolumeInformation(
    laufwerk: RdpdrLaufwerk,
    anfrage: QueryVolumeInformationRequest,
  ): Promise<void> {
    const antwort = (status: number, puffer: Buffer = Buffer.alloc(0)): void => {
      this.sende(buildLaengeUndPuffer(anfrage.deviceId, anfrage.completionId, status, puffer));
    };
    const volumen = this.volumenAngaben(laufwerk);

    switch (anfrage.fsInformationClass) {
      case FileFsVolumeInformation:
        antwort(STATUS_SUCCESS, buildFsVolumeInformation(volumen));
        return;
      case FileFsSizeInformation:
        antwort(STATUS_SUCCESS, buildFsSizeInformation(volumen));
        return;
      case FileFsFullSizeInformation:
        antwort(STATUS_SUCCESS, buildFsFullSizeInformation(volumen));
        return;
      case FileFsAttributeInformation:
        antwort(STATUS_SUCCESS, buildFsAttributeInformation(volumen));
        return;
      case FileFsDeviceInformation:
        antwort(STATUS_SUCCESS, buildFsDeviceInformation(volumen));
        return;
      default:
        // 2.2.3.3.6 nennt genau diese fuenf Klassen.
        this.protokoll(
          `RDPDR: Volumenklasse 0x${anfrage.fsInformationClass.toString(16)} wird nicht unterstuetzt`,
        );
        antwort(STATUS_NOT_SUPPORTED);
    }
  }

  /** Volumenangaben eines Laufwerks, mit Vorgaben fuer alles Fehlende. */
  private volumenAngaben(laufwerk: RdpdrLaufwerk): VolumenAngaben {
    const eigen = laufwerk.volumen ?? {};
    // Die gemeldete Groesse ist frei erfunden und muss es sein: der
    // Arbeitsbereich hat keine eigene Partition, und `workspace.fs` kennt
    // keinen freien Platz. Ein Wert von null wuerde den Explorer glauben
    // lassen, das Laufwerk sei voll - dann verweigert er jedes Kopieren.
    const gesamt = eigen.gesamtBytes ?? 64 * 1024 * 1024 * 1024;
    return {
      bezeichnung: eigen.bezeichnung ?? laufwerk.name,
      seriennummer: eigen.seriennummer ?? this.seriennummerAus(laufwerk.name),
      gesamtBytes: gesamt,
      freieBytes: eigen.freieBytes ?? (this.nurLesen ? 0 : Math.floor(gesamt / 2)),
      erstellt: eigen.erstellt,
      nurLesen: eigen.nurLesen ?? this.nurLesen,
    };
  }

  /**
   * Eine stabile Seriennummer aus dem Laufwerksnamen ableiten.
   *
   * Stabil ist wichtiger als eindeutig: Windows merkt sich Ansichtsoptionen je
   * Seriennummer. Eine Zufallszahl je Sitzung setzt die Spalteneinstellungen
   * des Explorers bei jeder Verbindung zurueck.
   */
  private seriennummerAus(name: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // -------------------------------------------------------- Query Directory

  private async bearbeiteQueryDirectory(
    laufwerk: RdpdrLaufwerk,
    anfrage: QueryDirectoryRequest,
  ): Promise<void> {
    const antwort = (status: number, puffer: Buffer = Buffer.alloc(0)): void => {
      this.sende(buildLaengeUndPuffer(anfrage.deviceId, anfrage.completionId, status, puffer));
    };
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei || !datei.istVerzeichnis) {
      antwort(STATUS_INVALID_DEVICE_REQUEST);
      return;
    }

    if (anfrage.initialQuery || datei.eintraege === undefined) {
      // Das Verzeichnis steht im Handle, nicht im Pfad der Anfrage: das Handle
      // hat die Pfadpruefung schon hinter sich, und nur der Musterteil der
      // Anfrage ist hier ueberhaupt von Belang.
      const muster = suchmusterFuer(anfrage.path, datei.pfad);
      const passt = musterPasst(muster);
      const inhalt = await laufwerk.dateisystem.liste(datei.pfad);
      const eintraege = this.mitPunkteintraegen(inhalt).filter((e) => passt(e.name));
      datei.eintraege = eintraege;
      datei.index = 0;
      if (eintraege.length === 0) {
        // 2.2.3.3.10: bei InitialQuery ungleich null und keinem Treffer ist
        // STATUS_NO_SUCH_FILE vorgeschrieben, nicht STATUS_NO_MORE_FILES.
        antwort(STATUS_NO_SUCH_FILE);
        return;
      }
    }

    const eintrag = datei.eintraege[datei.index];
    if (!eintrag) {
      // 2.2.3.3.10: kein weiterer Eintrag.
      antwort(STATUS_NO_MORE_FILES);
      return;
    }
    const puffer = buildVerzeichnisEintrag(eintrag, anfrage.fsInformationClass);
    if (!puffer) {
      this.protokoll(
        `RDPDR: Verzeichnisklasse 0x${anfrage.fsInformationClass.toString(16)} wird nicht unterstuetzt`,
      );
      antwort(STATUS_NOT_SUPPORTED);
      return;
    }
    datei.index++;
    antwort(STATUS_SUCCESS, puffer);
  }

  /**
   * "." und ".." vor die Liste setzen.
   *
   * Windows erwartet sie: FindFirstFile liefert sie auf jedem Verzeichnis,
   * auch auf der Wurzel eines Laufwerks. Fehlen sie, halten manche Programme
   * das Verzeichnis fuer beschaedigt. Gefaehrlich sind sie nicht - ein
   * spaeterer Zugriff auf den Pfad "\.." wird von `zerlegePfad()` abgewiesen.
   */
  private mitPunkteintraegen(inhalt: readonly DateiEintrag[]): DateiEintrag[] {
    const jetzt = Date.now();
    const punkt = (name: string): DateiEintrag => ({
      name,
      istVerzeichnis: true,
      groesse: 0,
      erstellt: jetzt,
      geaendert: jetzt,
      zugegriffen: jetzt,
    });
    return [punkt('.'), punkt('..'), ...inhalt];
  }

  // ------------------------------------------------- NotifyChange Directory

  /**
   * Eine Benachrichtigungsanfrage entgegennehmen und offen halten.
   *
   * Wir ueberwachen nichts: `workspace.fs` bietet keine Aenderungsmeldungen,
   * die sich hier einhaengen liessen, und ein sofortiges
   * STATUS_NOT_SUPPORTED bringt den Explorer dazu, es sofort wieder zu
   * versuchen - eine Schleife, die nur CPU frisst.
   *
   * Die Anfrage offen zu lassen ist genau das, was 2.2.3.4.11 beschreibt: der
   * Puffer der Antwort "MUST be empty when the Server Close Drive Request
   * message has been issued and no drive-specific events have occurred".
   * Beim Schliessen des Handles wird sie leer abgeschlossen. Die Folge ist
   * nur, dass der Explorer nicht von selbst aktualisiert - F5 hilft.
   */
  private async bearbeiteNotifyChange(anfrage: NotifyChangeDirectoryRequest): Promise<void> {
    const datei = this.offeneDateien.get(anfrage.fileId);
    if (!datei) {
      this.sende(
        buildLaengeUndPuffer(anfrage.deviceId, anfrage.completionId, STATUS_INVALID_DEVICE_REQUEST, Buffer.alloc(0)),
      );
      return;
    }
    datei.offeneBenachrichtigungen.push(anfrage.completionId);
  }

  // ------------------------------------------------------------- Hilfen

  /** Metadaten zu einem offenen Handle; die Wurzel gibt es immer. */
  private async eintragZu(laufwerk: RdpdrLaufwerk, datei: OffeneDatei): Promise<DateiEintrag | undefined> {
    if (datei.pfad === '') {
      return { name: laufwerk.name, istVerzeichnis: true, groesse: 0 };
    }
    return laufwerk.dateisystem.stat(datei.pfad);
  }
}
