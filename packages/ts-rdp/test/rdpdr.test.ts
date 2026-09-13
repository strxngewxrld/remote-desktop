/**
 * MS-RDPEFS: Kodierung und Auswertung der Nachrichten.
 *
 * Die erwarteten Bytes stammen entweder woertlich aus den Beispielen in
 * [MS-RDPEFS] 29.0 Abschnitt 4 oder sind aus den Feldtabellen der Abschnitte
 * 2.2.x und [MS-FSCC] 2.4/2.5 von Hand ausgerechnet. Gegen den eigenen
 * Kodierer wird nirgends geprueft - das wuerde nur bestaetigen, dass er mit
 * sich selbst einig ist.
 *
 * Eine Eigenheit der Spezifikation ist dabei aufgefallen und hier vermerkt:
 * das Beispiel 4.9 (Server Create Drive Request) ist in sich widerspruechlich.
 * Sein Bytestrom ist 56 Byte lang und seine Erlaeuterung zaehlt AllocationSize
 * mit vier Byte, waehrend die Feldtabelle in 2.2.1.4.1 acht Byte vorschreibt.
 * Massgeblich ist die Feldtabelle; das Beispiel wird deshalb nur fuer den
 * gemeinsamen 24-Byte-Kopf herangezogen.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  CAP_DRIVE_TYPE,
  CAP_GENERAL_TYPE,
  DRIVE_CAPABILITY_VERSION_02,
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_HIDDEN,
  FILE_ATTRIBUTE_NORMAL,
  FILE_ATTRIBUTE_READONLY,
  FileBothDirectoryInformation,
  FileDirectoryInformation,
  FileFullDirectoryInformation,
  FileNamesInformation,
  GENERAL_CAPABILITY_VERSION_02,
  IRP_MJ_CREATE,
  IRP_MJ_DIRECTORY_CONTROL,
  IRP_MJ_READ,
  IRP_MJ_SET_INFORMATION,
  IRP_MN_QUERY_DIRECTORY,
  PAKID_CORE_DEVICE_IOREQUEST,
  RDPDR_CTYP_CORE,
  STATUS_ACCESS_DENIED,
  STATUS_DEVICE_NOT_READY,
  belegterPlatz,
  buildClientAnnounceReply,
  buildClientCapabilities,
  buildClientNameRequest,
  buildCloseResponse,
  buildCreateResponse,
  buildDeviceListAnnounce,
  buildDeviceListRemove,
  buildFileBasicInformation,
  buildFileStandardInformation,
  buildFsDeviceInformation,
  buildFsSizeInformation,
  buildFsVolumeInformation,
  buildLaengeUndPuffer,
  buildRdpdrPdu,
  buildReadResponse,
  buildVerzeichnisEintrag,
  buildWriteResponse,
  dateiAttribute,
  fuegePfad,
  musterPasst,
  nachFiletime,
  parseCapabilities,
  parseDeviceAnnounceResponse,
  parseDeviceIoRequest,
  parseRdpdrPdu,
  parseRenameInformation,
  parseServerAnnounce,
  preferredDosName,
  trenneSuchmuster,
  zerlegePfad,
} from '../src/protocol/rdpdr.js';

/** Hexdump aus der Spezifikation in einen Puffer verwandeln. */
function hex(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'hex');
}

describe('RDPDR - Kopf und Handshake gegen die Beispiele aus MS-RDPEFS 4', () => {
  test('Server Announce Request (4.2) wird gelesen', () => {
    // 72 44 6e 49 01 00 0c 00 01 00 00 00
    const daten = hex('72 44 6e 49 01 00 0c 00 01 00 00 00');
    const pdu = parseRdpdrPdu(daten);
    assert.equal(pdu.component, RDPDR_CTYP_CORE);
    assert.equal(pdu.packetId, 0x496e);
    const announce = parseServerAnnounce(pdu.body);
    assert.deepEqual(announce, { versionMajor: 1, versionMinor: 0x000c, clientId: 1 });
  });

  test('Client Announce Reply (4.3) ergibt genau die Bytes der Spezifikation', () => {
    assert.deepEqual(buildClientAnnounceReply(1, 0x000c, 1), hex('72 44 43 43 01 00 0c 00 01 00 00 00'));
  });

  test('Client Name Request (4.4) ergibt genau die Bytes der Spezifikation', () => {
    // ComputerNameLen ist 0x1e: 14 Zeichen zu zwei Byte plus zwei Byte Nullzeichen.
    const erwartet = hex(
      '72 44 4e 43 01 00 00 00 00 00 00 00 1e 00 00 00' +
        '54 00 53 00 44 00 45 00 56 00 2d 00 53 00 45 00' +
        '4c 00 46 00 48 00 4f 00 53 00 54 00 00 00',
    );
    assert.equal(erwartet.length, 46);
    assert.deepEqual(buildClientNameRequest('TSDEV-SELFHOST'), erwartet);
  });

  test('Server Core Capability Request (4.6) wird in seine Saetze zerlegt', () => {
    const daten = hex(
      '72 44 50 53 05 00 00 00 01 00 2c 00 02 00 00 00' +
        '02 00 00 00 00 00 00 00 01 00 0c 00 ff ff 00 00' +
        '00 00 00 00 07 00 00 00 00 00 00 00 00 00 00 00' +
        '02 00 00 00 02 00 08 00 01 00 00 00 03 00 08 00' +
        '01 00 00 00 04 00 08 00 02 00 00 00 05 00 08 00' +
        '01 00 00 00',
    );
    assert.equal(daten.length, 84);
    const saetze = parseCapabilities(parseRdpdrPdu(daten).body);
    assert.equal(saetze.length, 5);
    assert.equal(saetze[0].capabilityType, CAP_GENERAL_TYPE);
    assert.equal(saetze[0].version, GENERAL_CAPABILITY_VERSION_02);
    // Der General-Satz ist 44 Byte lang, der Rumpf also 36 Byte.
    assert.equal(saetze[0].data.length, 36);
    // protocolMinorVersion steht im Rumpf ab Byte 10 (osType 4, osVersion 4,
    // protocolMajorVersion 2).
    assert.equal(saetze[0].data.readUInt16LE(10), 0x000c);
    assert.equal(saetze[3].capabilityType, CAP_DRIVE_TYPE);
    assert.equal(saetze[3].version, DRIVE_CAPABILITY_VERSION_02);
    assert.equal(saetze[3].data.length, 0);
  });

  test('Server Device Announce Response (4.1) wird gelesen', () => {
    const pdu = parseRdpdrPdu(hex('72 44 72 64 01 00 00 00 00 00 00 00'));
    assert.equal(pdu.packetId, 0x6472);
    assert.deepEqual(parseDeviceAnnounceResponse(pdu.body), { deviceId: 1, resultCode: 0 });
  });

  test('Client Drive Device List Remove (4.8) ergibt genau die Bytes der Spezifikation', () => {
    assert.deepEqual(buildDeviceListRemove([1]), hex('72 44 4d 44 01 00 00 00 01 00 00 00'));
  });

  test('Client Drive Create Response (4.10) ergibt genau die Bytes der Spezifikation', () => {
    // 21 Byte: Kopf 4, DeviceId 4, CompletionId 4, IoStatus 4, FileId 4, Information 1.
    const erwartet = hex('72 44 43 49 03 00 00 00 01 00 00 00 a3 00 00 c0 00 00 00 00 00');
    assert.equal(erwartet.length, 21);
    assert.deepEqual(buildCreateResponse(3, 1, STATUS_DEVICE_NOT_READY, 0, 0), erwartet);
  });
});

describe('RDPDR - Client Core Capability Response, aus 2.2.2.7.1 gerechnet', () => {
  test('Zwei Saetze: General (44 Byte, Version 2) und Drive (8 Byte, Version 2)', () => {
    const daten = buildClientCapabilities({ versionMinor: 0x000c });
    // Kopf 4 + numCapabilities/Padding 4 + 44 + 8 = 60 Byte.
    assert.equal(daten.length, 60);
    assert.deepEqual(daten.subarray(0, 4), hex('72 44 50 43')); // RDPDR_CTYP_CORE / PAKID_CORE_CLIENT_CAPABILITY
    assert.equal(daten.readUInt16LE(4), 2); // numCapabilities
    assert.equal(daten.readUInt16LE(6), 0); // Padding

    // CAPABILITY_HEADER des General-Satzes.
    assert.equal(daten.readUInt16LE(8), CAP_GENERAL_TYPE);
    assert.equal(daten.readUInt16LE(10), 44);
    assert.equal(daten.readUInt32LE(12), GENERAL_CAPABILITY_VERSION_02);
    // osType, osVersion
    assert.equal(daten.readUInt32LE(16), 0);
    assert.equal(daten.readUInt32LE(20), 0);
    assert.equal(daten.readUInt16LE(24), 1); // protocolMajorVersion, laut Spezifikation immer 1
    assert.equal(daten.readUInt16LE(26), 0x000c); // protocolMinorVersion
    assert.equal(daten.readUInt32LE(28), 0x00003fff); // ioCode1 ohne die beiden Sicherheitsbits
    assert.equal(daten.readUInt32LE(32), 0); // ioCode2
    assert.equal(daten.readUInt32LE(36), 0x00000005); // RDPDR_DEVICE_REMOVE_PDUS | RDPDR_USER_LOGGEDON_PDU
    assert.equal(daten.readUInt32LE(40), 0); // extraFlags1 - kein ENABLE_ASYNCIO
    assert.equal(daten.readUInt32LE(44), 0); // extraFlags2
    assert.equal(daten.readUInt32LE(48), 0); // SpecialTypeDeviceCap

    // Drive-Satz: nur der CAPABILITY_HEADER.
    assert.equal(daten.readUInt16LE(52), CAP_DRIVE_TYPE);
    assert.equal(daten.readUInt16LE(54), 8);
    assert.equal(daten.readUInt32LE(56), DRIVE_CAPABILITY_VERSION_02);
  });

  test('Weder Drucker- noch Smartcard-Satz werden angeboten', () => {
    const saetze = parseCapabilities(parseRdpdrPdu(buildClientCapabilities({ versionMinor: 0x000c })).body);
    assert.deepEqual(
      saetze.map((s) => s.capabilityType),
      [CAP_GENERAL_TYPE, CAP_DRIVE_TYPE],
    );
  });
});

describe('RDPDR - Geraeteliste nach 2.2.1.3 und 2.2.3.1', () => {
  test('Ein Dateisystemgeraet mit vollem Namen im DeviceData', () => {
    const daten = buildDeviceListAnnounce([{ deviceId: 1, name: 'Arbeitsbereich' }]);
    const pdu = parseRdpdrPdu(daten);
    assert.equal(pdu.packetId, 0x4441); // PAKID_CORE_DEVICELIST_ANNOUNCE
    const b = pdu.body;
    assert.equal(b.readUInt32LE(0), 1); // DeviceCount
    assert.equal(b.readUInt32LE(4), 0x00000008); // RDPDR_DTYP_FILESYSTEM
    assert.equal(b.readUInt32LE(8), 1); // DeviceId
    // PreferredDosName: acht Byte ASCII, nullterminiert - also sieben Zeichen.
    assert.deepEqual(b.subarray(12, 20), Buffer.from('Arbeits\0', 'ascii'));
    const laenge = b.readUInt32LE(20);
    assert.equal(laenge, ('Arbeitsbereich'.length + 1) * 2);
    assert.equal(b.subarray(24, 24 + laenge).toString('ucs2'), 'Arbeitsbereich\0');
    assert.equal(b.length, 24 + laenge);
  });

  test('PreferredDosName ersetzt die in 2.2.1.3 verbotenen Zeichen', () => {
    assert.equal(preferredDosName('a/b\\c|d'), 'a_b_c_d');
    assert.equal(preferredDosName('Vielzulangername'), 'Vielzul');
  });
});

describe('RDPDR - Device I/O Request nach 2.2.1.4', () => {
  test('Der 24-Byte-Kopf aus Beispiel 4.9 wird richtig gelesen', () => {
    const kopf = hex(
      '72 44 52 49' + // RDPDR_CTYP_CORE / PAKID_CORE_DEVICE_IOREQUEST
        '03 00 00 00' + // DeviceId
        '00 00 00 00' + // FileId
        '01 00 00 00' + // CompletionId
        '00 00 00 00' + // MajorFunction = IRP_MJ_CREATE
        '00 00 00 00', // MinorFunction
    );
    const pdu = parseRdpdrPdu(kopf);
    assert.equal(pdu.packetId, PAKID_CORE_DEVICE_IOREQUEST);
    // Der Rumpf endet hier hinter dem Kopf; die Create-Felder fehlen. Genau
    // das muss auffallen, statt Muell zu liefern.
    assert.throws(() => parseDeviceIoRequest(pdu.body.subarray(0, 10)));
  });

  test('Create Request mit achtbyteiger AllocationSize (2.2.1.4.1)', () => {
    const pfad = Buffer.from('\\repo\\datei.ts\0', 'ucs2');
    const body = Buffer.concat([
      hex('03 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00 00 00 00 00'), // DeviceId FileId CompletionId Major Minor
      hex('89 00 12 00'), // DesiredAccess
      hex('00 00 00 00 00 00 00 00'), // AllocationSize, acht Byte
      hex('80 00 00 00'), // FileAttributes
      hex('07 00 00 00'), // SharedAccess
      hex('01 00 00 00'), // CreateDisposition = FILE_OPEN
      hex('40 00 00 00'), // CreateOptions = FILE_NON_DIRECTORY_FILE
      (() => {
        const b = Buffer.allocUnsafe(4);
        b.writeUInt32LE(pfad.length, 0);
        return b;
      })(),
      pfad,
    ]);
    const req = parseDeviceIoRequest(body);
    assert.equal(req.art, 'create');
    assert.equal(req.deviceId, 3);
    assert.equal(req.completionId, 7);
    assert.equal(req.majorFunction, IRP_MJ_CREATE);
    if (req.art !== 'create') throw new Error('unerwartet');
    assert.equal(req.desiredAccess, 0x00120089);
    assert.equal(req.allocationSize, 0n);
    assert.equal(req.fileAttributes, 0x80);
    assert.equal(req.sharedAccess, 7);
    assert.equal(req.createDisposition, 1);
    assert.equal(req.createOptions, 0x40);
    assert.equal(req.path, '\\repo\\datei.ts');
  });

  test('Read Request: Length(4) Offset(8) Padding(20) nach 2.2.1.4.3', () => {
    const body = Buffer.concat([
      hex('01 00 00 00 05 00 00 00 09 00 00 00 03 00 00 00 00 00 00 00'),
      hex('00 10 00 00'), // Length = 4096
      hex('00 04 00 00 00 00 00 00'), // Offset = 1024
      Buffer.alloc(20),
    ]);
    const req = parseDeviceIoRequest(body);
    assert.equal(req.art, 'read');
    assert.equal(req.majorFunction, IRP_MJ_READ);
    if (req.art !== 'read') throw new Error('unerwartet');
    assert.equal(req.fileId, 5);
    assert.equal(req.length, 4096);
    assert.equal(req.offset, 1024n);
  });

  test('Write Request: die Nutzdaten stehen hinter 20 Byte Padding (2.2.1.4.4)', () => {
    const nutz = Buffer.from('hallo');
    const body = Buffer.concat([
      hex('01 00 00 00 05 00 00 00 09 00 00 00 04 00 00 00 00 00 00 00'),
      hex('05 00 00 00'), // Length
      hex('02 00 00 00 00 00 00 00'), // Offset = 2
      Buffer.alloc(20),
      nutz,
    ]);
    const req = parseDeviceIoRequest(body);
    assert.equal(req.art, 'write');
    if (req.art !== 'write') throw new Error('unerwartet');
    assert.equal(req.offset, 2n);
    assert.deepEqual(req.data, nutz);
  });

  test('Query Directory: InitialQuery(1) PathLength(4) Padding(23) nach 2.2.3.3.10', () => {
    const pfad = Buffer.from('\\repo\\*\0', 'ucs2');
    const laenge = Buffer.allocUnsafe(4);
    laenge.writeUInt32LE(pfad.length, 0);
    const body = Buffer.concat([
      hex('01 00 00 00 05 00 00 00 09 00 00 00 0c 00 00 00 01 00 00 00'),
      hex('03 00 00 00'), // FsInformationClass = FileBothDirectoryInformation
      hex('01'), // InitialQuery
      laenge,
      Buffer.alloc(23),
      pfad,
    ]);
    const req = parseDeviceIoRequest(body);
    assert.equal(req.art, 'queryDirectory');
    assert.equal(req.majorFunction, IRP_MJ_DIRECTORY_CONTROL);
    assert.equal(req.minorFunction, IRP_MN_QUERY_DIRECTORY);
    if (req.art !== 'queryDirectory') throw new Error('unerwartet');
    assert.equal(req.fsInformationClass, FileBothDirectoryInformation);
    assert.equal(req.initialQuery, true);
    assert.equal(req.path, '\\repo\\*');
  });

  test('Set Information: FsInformationClass(4) Length(4) Padding(24) nach 2.2.3.3.9', () => {
    const ziel = Buffer.from('\\repo\\neu.ts\0', 'ucs2');
    const rumpf = Buffer.concat([
      hex('01'), // ReplaceIfExists
      hex('00'), // RootDirectory, bei Netzwerkoperationen immer 0
      (() => {
        const b = Buffer.allocUnsafe(4);
        b.writeUInt32LE(ziel.length, 0);
        return b;
      })(),
      ziel,
    ]);
    const laenge = Buffer.allocUnsafe(4);
    laenge.writeUInt32LE(rumpf.length, 0);
    const body = Buffer.concat([
      hex('01 00 00 00 05 00 00 00 09 00 00 00 06 00 00 00 00 00 00 00'),
      hex('0a 00 00 00'), // FileRenameInformation
      laenge,
      Buffer.alloc(24),
      rumpf,
    ]);
    const req = parseDeviceIoRequest(body);
    assert.equal(req.art, 'setInformation');
    assert.equal(req.majorFunction, IRP_MJ_SET_INFORMATION);
    if (req.art !== 'setInformation') throw new Error('unerwartet');
    assert.equal(req.length, rumpf.length);
    const umbenennen = parseRenameInformation(req.buffer);
    assert.equal(umbenennen.replaceIfExists, true);
    assert.equal(umbenennen.fileName, '\\repo\\neu.ts');
  });
});

describe('RDPDR - Antwortrahmen nach 2.2.1.5', () => {
  test('Close Response traegt vier Byte Padding (2.2.1.5.2)', () => {
    const daten = buildCloseResponse(3, 8, 0);
    assert.equal(daten.length, 20);
    assert.deepEqual(daten.subarray(16), Buffer.alloc(4));
  });

  test('Read Response: Length und danach die Daten (2.2.1.5.3)', () => {
    const daten = buildReadResponse(3, 8, 0, Buffer.from('abc'));
    assert.equal(daten.readUInt32LE(16), 3);
    assert.deepEqual(daten.subarray(20), Buffer.from('abc'));
  });

  test('Write Response: geschriebene Zahl plus ein Byte Padding (2.2.1.5.4)', () => {
    const daten = buildWriteResponse(3, 8, 0, 17);
    assert.equal(daten.length, 21);
    assert.equal(daten.readUInt32LE(16), 17);
  });

  test('Leerer Puffer bekommt das optionale Padding-Byte, gefuellter nicht', () => {
    assert.equal(buildLaengeUndPuffer(1, 2, 0, Buffer.alloc(0)).length, 21);
    assert.equal(buildLaengeUndPuffer(1, 2, 0, Buffer.from('ab')).length, 22);
  });

  test('Der Kopf jeder Antwort ist RDPDR_CTYP_CORE / PAKID_CORE_DEVICE_IOCOMPLETION', () => {
    const daten = buildReadResponse(0x11223344, 0x55667788, 0xc0000022, Buffer.alloc(0));
    assert.deepEqual(daten.subarray(0, 4), hex('72 44 43 49'));
    assert.equal(daten.readUInt32LE(4), 0x11223344);
    assert.equal(daten.readUInt32LE(8), 0x55667788);
    assert.equal(daten.readUInt32LE(12), 0xc0000022);
  });
});

describe('MS-FSCC - Zeit und Attribute', () => {
  test('Die Unix-Epoche ist 116444736000000000 in Windows-Zeit', () => {
    // 11644473600 Sekunden zwischen dem 1.1.1601 und dem 1.1.1970, in
    // 100-ns-Schritten (MS-FSCC 2.1.1).
    assert.equal(nachFiletime(0), 116444736000000000n);
  });

  test('Eine bekannte Zeit wird richtig umgerechnet', () => {
    // 2001-01-01T00:00:00Z = 978307200 s nach der Unix-Epoche.
    const erwartet = (978307200n + 11644473600n) * 10000000n;
    assert.equal(nachFiletime(978307200000), erwartet);
  });

  test('Fehlende Zeiten werden null, nicht NaN', () => {
    assert.equal(nachFiletime(undefined), 0n);
    assert.equal(nachFiletime(Number.NaN), 0n);
  });

  test('Attribute nach 2.6: Verzeichnis, Nur-Lesen, Versteckt, sonst NORMAL', () => {
    assert.equal(
      dateiAttribute({ name: 'x', istVerzeichnis: true, groesse: 0 }),
      FILE_ATTRIBUTE_DIRECTORY,
    );
    assert.equal(dateiAttribute({ name: 'x', istVerzeichnis: false, groesse: 1 }), FILE_ATTRIBUTE_NORMAL);
    assert.equal(
      dateiAttribute({ name: 'x', istVerzeichnis: false, groesse: 1, nurLesen: true, versteckt: true }),
      FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN,
    );
    // NORMAL steht nie neben anderen Attributen (2.6).
    assert.equal(
      dateiAttribute({ name: 'x', istVerzeichnis: true, groesse: 0, nurLesen: true }) & FILE_ATTRIBUTE_NORMAL,
      0,
    );
  });

  test('AllocationSize ist ein Vielfaches der Clustergroesse', () => {
    assert.equal(belegterPlatz(0), 0);
    assert.equal(belegterPlatz(1), 4096);
    assert.equal(belegterPlatz(4096), 4096);
    assert.equal(belegterPlatz(4097), 8192);
  });
});

describe('MS-FSCC - Informationsklassen, Feld fuer Feld gerechnet', () => {
  const eintrag = {
    name: 'datei.ts',
    istVerzeichnis: false,
    groesse: 5000,
    erstellt: 978307200000,
    geaendert: 978307200000,
    zugegriffen: 978307200000,
  };
  const ft = (978307200n + 11644473600n) * 10000000n;

  test('FILE_BASIC_INFORMATION ist 36 Byte ohne Reserved (2.4.7 / MS-RDPEFS 2.2.3.3.8)', () => {
    const b = buildFileBasicInformation(eintrag);
    assert.equal(b.length, 36);
    assert.equal(b.readBigUInt64LE(0), ft); // CreationTime
    assert.equal(b.readBigUInt64LE(8), ft); // LastAccessTime
    assert.equal(b.readBigUInt64LE(16), ft); // LastWriteTime
    assert.equal(b.readBigUInt64LE(24), ft); // ChangeTime
    assert.equal(b.readUInt32LE(32), FILE_ATTRIBUTE_NORMAL);
  });

  test('FILE_STANDARD_INFORMATION ist 22 Byte ohne Reserved (2.4.41)', () => {
    const b = buildFileStandardInformation(eintrag);
    assert.equal(b.length, 22);
    assert.equal(b.readBigUInt64LE(0), 8192n); // AllocationSize: 5000 auf zwei Cluster
    assert.equal(b.readBigUInt64LE(8), 5000n); // EndOfFile
    assert.equal(b.readUInt32LE(16), 1); // NumberOfLinks
    assert.equal(b.readUInt8(20), 0); // DeletePending
    assert.equal(b.readUInt8(21), 0); // Directory
  });

  test('Bei einem Verzeichnis stehen EndOfFile auf 0 und Directory auf 1', () => {
    const b = buildFileStandardInformation({ name: 'src', istVerzeichnis: true, groesse: 999 });
    assert.equal(b.readBigUInt64LE(8), 0n);
    assert.equal(b.readUInt8(21), 1);
  });

  test('FILE_DIRECTORY_INFORMATION: 64 Byte Kopf, dann der Name (2.4.10)', () => {
    const b = buildVerzeichnisEintrag(eintrag, FileDirectoryInformation)!;
    const name = Buffer.from('datei.ts', 'ucs2');
    assert.equal(b.length, 64 + name.length);
    assert.equal(b.readUInt32LE(0), 0); // NextEntryOffset - ein Eintrag je Antwort
    assert.equal(b.readUInt32LE(4), 0); // FileIndex
    assert.equal(b.readBigUInt64LE(8), ft);
    assert.equal(b.readBigUInt64LE(16), ft);
    assert.equal(b.readBigUInt64LE(24), ft);
    assert.equal(b.readBigUInt64LE(32), ft);
    assert.equal(b.readBigUInt64LE(40), 5000n); // EndOfFile
    assert.equal(b.readBigUInt64LE(48), 8192n); // AllocationSize
    assert.equal(b.readUInt32LE(56), FILE_ATTRIBUTE_NORMAL);
    assert.equal(b.readUInt32LE(60), name.length);
    assert.deepEqual(b.subarray(64), name);
  });

  test('FILE_FULL_DIR_INFORMATION schiebt EaSize dazwischen: 68 Byte Kopf (2.4.14)', () => {
    const b = buildVerzeichnisEintrag(eintrag, FileFullDirectoryInformation)!;
    const name = Buffer.from('datei.ts', 'ucs2');
    assert.equal(b.length, 68 + name.length);
    assert.equal(b.readUInt32LE(60), name.length); // FileNameLength
    assert.equal(b.readUInt32LE(64), 0); // EaSize
    assert.deepEqual(b.subarray(68), name);
  });

  test('FILE_BOTH_DIR_INFORMATION haengt ShortName an: 94 Byte Kopf (2.4.8)', () => {
    const b = buildVerzeichnisEintrag(eintrag, FileBothDirectoryInformation)!;
    const name = Buffer.from('datei.ts', 'ucs2');
    assert.equal(b.length, 94 + name.length);
    assert.equal(b.readUInt32LE(64), 0); // EaSize
    assert.equal(b.readUInt8(68), 0); // ShortNameLength - kein 8.3-Name
    assert.equal(b.readUInt8(69), 0); // Reserved
    assert.deepEqual(b.subarray(70, 94), Buffer.alloc(24)); // ShortName
    assert.deepEqual(b.subarray(94), name);
  });

  test('FILE_NAMES_INFORMATION ist nur Offset, Index, Laenge und Name (2.4.26)', () => {
    const b = buildVerzeichnisEintrag(eintrag, FileNamesInformation)!;
    const name = Buffer.from('datei.ts', 'ucs2');
    assert.equal(b.length, 12 + name.length);
    assert.equal(b.readUInt32LE(8), name.length);
    assert.deepEqual(b.subarray(12), name);
  });

  test('Eine unbekannte Verzeichnisklasse liefert undefined statt geratener Bytes', () => {
    assert.equal(buildVerzeichnisEintrag(eintrag, 0x37), undefined);
  });

  test('FILE_FS_VOLUME_INFORMATION ist 17 Byte plus Bezeichnung (2.5.9)', () => {
    const b = buildFsVolumeInformation({
      bezeichnung: 'Code',
      seriennummer: 0x12345678,
      gesamtBytes: 0,
      freieBytes: 0,
      erstellt: 978307200000,
    });
    const label = Buffer.from('Code', 'ucs2');
    assert.equal(b.length, 17 + label.length);
    assert.equal(b.readBigUInt64LE(0), ft);
    assert.equal(b.readUInt32LE(8), 0x12345678);
    assert.equal(b.readUInt32LE(12), label.length);
    assert.equal(b.readUInt8(16), 0); // SupportsObjects
    assert.deepEqual(b.subarray(17), label);
  });

  test('FILE_FS_SIZE_INFORMATION rechnet Byte in Cluster um (2.5.8)', () => {
    const b = buildFsSizeInformation({
      bezeichnung: '',
      seriennummer: 0,
      gesamtBytes: 4096 * 100,
      freieBytes: 4096 * 25,
    });
    assert.equal(b.length, 24);
    assert.equal(b.readBigUInt64LE(0), 100n);
    assert.equal(b.readBigUInt64LE(8), 25n);
    assert.equal(b.readUInt32LE(16), 8); // Sektoren je Cluster
    assert.equal(b.readUInt32LE(20), 512); // Byte je Sektor
  });

  test('FILE_FS_DEVICE_INFORMATION meldet Platte und Terminaldienst-Geraet (2.5.10)', () => {
    const b = buildFsDeviceInformation({ bezeichnung: '', seriennummer: 0, gesamtBytes: 0, freieBytes: 0 });
    assert.equal(b.length, 8);
    assert.equal(b.readUInt32LE(0), 0x00000007); // FILE_DEVICE_DISK
    // FILE_REMOTE_DEVICE | FILE_DEVICE_IS_MOUNTED | FILE_CHARACTERISTIC_TS_DEVICE
    assert.equal(b.readUInt32LE(4), 0x00000010 | 0x00000020 | 0x00001000);
  });

  test('Im Nur-Lesen-Betrieb kommt FILE_READ_ONLY_DEVICE dazu', () => {
    const b = buildFsDeviceInformation({
      bezeichnung: '',
      seriennummer: 0,
      gesamtBytes: 0,
      freieBytes: 0,
      nurLesen: true,
    });
    assert.equal(b.readUInt32LE(4) & 0x00000002, 0x00000002);
  });
});

describe('RDPDR - Pfade: Fluchtversuche werden abgewiesen', () => {
  test('Die Wurzel ergibt keine Segmente', () => {
    const e = zerlegePfad('\\');
    assert.equal(e.ok, true);
    if (!e.ok) throw new Error('unerwartet');
    assert.deepEqual(e.segmente, []);
    assert.equal(fuegePfad(e.segmente), '');
  });

  test('Ein gewoehnlicher Pfad wird zerlegt', () => {
    const e = zerlegePfad('\\repo\\src\\datei.ts');
    assert.equal(e.ok, true);
    if (!e.ok) throw new Error('unerwartet');
    assert.deepEqual(e.segmente, ['repo', 'src', 'datei.ts']);
    assert.equal(fuegePfad(e.segmente), 'repo/src/datei.ts');
  });

  for (const boese of [
    '\\..',
    '\\..\\..\\etc\\passwd',
    '\\repo\\..\\..\\geheim',
    '..',
    '\\repo\\.\\..\\x',
    '\\...',
    '/../etc/passwd',
    '\\repo/../../etc/shadow',
    '\\repo\\..',
  ]) {
    test(`"${boese}" wird mit STATUS_ACCESS_DENIED abgewiesen`, () => {
      const e = zerlegePfad(boese);
      assert.equal(e.ok, false);
      if (e.ok) throw new Error('haette abgewiesen werden muessen');
      assert.equal(e.status, STATUS_ACCESS_DENIED);
    });
  }

  test('Auch ein einzelner Punkt als Segment wird abgewiesen', () => {
    assert.equal(zerlegePfad('\\repo\\.\\datei').ok, false);
  });

  test('Ein Nullzeichen im Segment wird abgewiesen', () => {
    const e = zerlegePfad('\\repo\\datei\0.ts');
    assert.equal(e.ok, false);
  });

  test('Die Geraetenamen aus 3.2.5.2.3 werden abgewiesen', () => {
    for (const name of ['COM1', 'com9', 'LPT3', 'prn', 'AUX', 'Aux']) {
      const e = zerlegePfad(`\\${name}`);
      assert.equal(e.ok, false, `${name} haette abgewiesen werden muessen`);
      if (e.ok) throw new Error('unerwartet');
      assert.equal(e.status, STATUS_ACCESS_DENIED);
    }
    // COM10 ist kein Geraetename - nur die Ziffern 1 bis 9 sind gemeint.
    assert.equal(zerlegePfad('\\COM10').ok, true);
  });

  test('Ein Punkt im Dateinamen ist natuerlich erlaubt', () => {
    const e = zerlegePfad('\\.env.example');
    assert.equal(e.ok, true);
    if (!e.ok) throw new Error('unerwartet');
    assert.deepEqual(e.segmente, ['.env.example']);
  });

  test('Doppelte Trenner werden uebersprungen, nicht als leeres Segment gezaehlt', () => {
    const e = zerlegePfad('\\\\repo\\\\src\\');
    assert.equal(e.ok, true);
    if (!e.ok) throw new Error('unerwartet');
    assert.deepEqual(e.segmente, ['repo', 'src']);
  });
});

describe('RDPDR - Suchmuster', () => {
  test('Stern und Fragezeichen wirken, alles andere ist woertlich', () => {
    assert.equal(musterPasst('*')('irgendwas'), true);
    assert.equal(musterPasst('*.ts')('datei.ts'), true);
    assert.equal(musterPasst('*.ts')('datei.js'), false);
    assert.equal(musterPasst('datei?.ts')('datei1.ts'), true);
    assert.equal(musterPasst('datei?.ts')('datei12.ts'), false);
    // Der Punkt ist ein gewoehnliches Zeichen, kein Platzhalter.
    assert.equal(musterPasst('a.b')('axb'), false);
  });

  test('Der Vergleich achtet nicht auf Gross- und Kleinschreibung', () => {
    assert.equal(musterPasst('*.TS')('Datei.ts'), true);
  });

  test('Das Muster wird vom Pfad getrennt', () => {
    assert.deepEqual(trenneSuchmuster('\\repo\\*'), { pfad: '\\repo', muster: '*' });
    assert.deepEqual(trenneSuchmuster('\\repo\\src\\*.ts'), { pfad: '\\repo\\src', muster: '*.ts' });
    assert.deepEqual(trenneSuchmuster('\\repo\\datei.ts'), { pfad: '\\repo\\datei.ts' });
  });
});

describe('RDPDR - kaputte Nachrichten', () => {
  test('Eine Nachricht kuerzer als der Kopf wird abgelehnt', () => {
    assert.throws(() => parseRdpdrPdu(Buffer.from([0x72, 0x44, 0x43])));
  });

  test('Ein Kopf ohne Rumpf ergibt einen leeren Rumpf', () => {
    const pdu = parseRdpdrPdu(buildRdpdrPdu(RDPDR_CTYP_CORE, 0x554c));
    assert.equal(pdu.body.length, 0);
  });

  test('Ein Capability-Satz mit zu kleiner Laenge beendet die Schleife, statt endlos zu laufen', () => {
    // numCapabilities = 3, erster Satz behauptet Laenge 2 - kleiner als sein Kopf.
    const body = hex('03 00 00 00 01 00 02 00 00 00 00 00');
    assert.deepEqual(parseCapabilities(body), []);
  });
});
