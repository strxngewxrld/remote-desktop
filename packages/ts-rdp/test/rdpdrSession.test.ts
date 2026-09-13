/**
 * MS-RDPEFS: die Zustandsmaschine des Clients.
 *
 * Hier wird nicht mehr das Feldlayout geprueft (das tut rdpdr.test.ts gegen
 * die Spezifikationsbytes), sondern das Verhalten: Reihenfolge des
 * Handshakes, Nur-Lesen, Pfadpruefung, Verzeichnisaufzaehlung.
 *
 * Das Dateisystem ist ein Attrappenspeicher im Arbeitsspeicher. Er nimmt
 * absichtlich auch Pfade entgegen, die er nie bekommen duerfte - so faellt
 * auf, wenn die Pfadpruefung der Sitzung sie doch durchlaesst.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { setTimeout as schlafe } from 'node:timers/promises';
import {
  DELETE,
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_CREATE,
  FILE_DELETE_ON_CLOSE,
  FILE_DIRECTORY_FILE,
  FILE_NON_DIRECTORY_FILE,
  FILE_OPEN,
  FILE_OPENED,
  FILE_OPEN_IF,
  FILE_OVERWRITE_IF,
  FILE_OVERWRITTEN,
  FILE_SUPERSEDED,
  FileBasicInformation,
  FileBothDirectoryInformation,
  FileDispositionInformation,
  FileFsAttributeInformation,
  FileFsDeviceInformation,
  FileFsFullSizeInformation,
  FileFsSizeInformation,
  FileFsVolumeInformation,
  FileRenameInformation,
  FileStandardInformation,
  GENERIC_READ,
  GENERIC_WRITE,
  IRP_MJ_CLOSE,
  IRP_MJ_CREATE,
  IRP_MJ_DEVICE_CONTROL,
  IRP_MJ_DIRECTORY_CONTROL,
  IRP_MJ_QUERY_INFORMATION,
  IRP_MJ_QUERY_VOLUME_INFORMATION,
  IRP_MJ_READ,
  IRP_MJ_SET_INFORMATION,
  IRP_MJ_WRITE,
  IRP_MN_QUERY_DIRECTORY,
  PAKID_CORE_CLIENTID_CONFIRM,
  PAKID_CORE_CLIENT_CAPABILITY,
  PAKID_CORE_CLIENT_NAME,
  PAKID_CORE_DEVICELIST_ANNOUNCE,
  PAKID_CORE_DEVICE_IOCOMPLETION,
  PAKID_CORE_SERVER_ANNOUNCE,
  PAKID_CORE_SERVER_CAPABILITY,
  PAKID_CORE_USER_LOGGEDON,
  RDPDR_CTYP_CORE,
  RdpdrDateisystem,
  RdpdrSession,
  STATUS_ACCESS_DENIED,
  STATUS_END_OF_FILE,
  STATUS_INVALID_DEVICE_REQUEST,
  STATUS_NOT_SUPPORTED,
  STATUS_NO_MORE_FILES,
  STATUS_NO_SUCH_FILE,
  STATUS_OBJECT_NAME_NOT_FOUND,
  STATUS_SUCCESS,
  buildRdpdrPdu,
  parseRdpdrPdu,
  waehleNebenversion,
  type DateiEintrag,
} from '../src/protocol/rdpdr.js';

// --------------------------------------------------------- Attrappenspeicher

/** Ein Dateisystem im Arbeitsspeicher. Schluessel sind Pfade mit Schraegstrich. */
class Speicher implements RdpdrDateisystem {
  /** Pfad -> Inhalt. Verzeichnisse stehen mit `undefined` drin. */
  readonly eintraege = new Map<string, Buffer | undefined>();
  /** Pfade, die trotz Pfadpruefung angefragt wurden - muss leer bleiben. */
  readonly angefragt: string[] = [];

  constructor(inhalt: Record<string, string | null>) {
    for (const [pfad, wert] of Object.entries(inhalt)) {
      this.eintraege.set(pfad, wert === null ? undefined : Buffer.from(wert, 'utf8'));
    }
  }

  private merke(pfad: string): void {
    this.angefragt.push(pfad);
  }

  async stat(pfad: string): Promise<DateiEintrag | undefined> {
    this.merke(pfad);
    if (!this.eintraege.has(pfad)) return undefined;
    const inhalt = this.eintraege.get(pfad);
    return {
      name: pfad.split('/').pop() ?? pfad,
      istVerzeichnis: inhalt === undefined,
      groesse: inhalt?.length ?? 0,
      erstellt: 1000000,
      geaendert: 1000000,
    };
  }

  async liste(pfad: string): Promise<DateiEintrag[]> {
    this.merke(pfad);
    const praefix = pfad === '' ? '' : pfad + '/';
    const kinder: DateiEintrag[] = [];
    for (const [p, inhalt] of this.eintraege) {
      if (!p.startsWith(praefix)) continue;
      const rest = p.substring(praefix.length);
      if (rest === '' || rest.includes('/')) continue;
      kinder.push({
        name: rest,
        istVerzeichnis: inhalt === undefined,
        groesse: inhalt?.length ?? 0,
        erstellt: 1000000,
        geaendert: 1000000,
      });
    }
    return kinder;
  }

  async lies(pfad: string, offset: number, laenge: number): Promise<Buffer> {
    this.merke(pfad);
    const inhalt = this.eintraege.get(pfad);
    if (!inhalt) return Buffer.alloc(0);
    return inhalt.subarray(offset, offset + laenge);
  }

  async schreibe(pfad: string, offset: number, daten: Buffer): Promise<number> {
    const alt = this.eintraege.get(pfad) ?? Buffer.alloc(0);
    const neu = Buffer.alloc(Math.max(alt.length, offset + daten.length));
    alt.copy(neu, 0);
    daten.copy(neu, offset);
    this.eintraege.set(pfad, neu);
    return daten.length;
  }

  async erzeuge(pfad: string, istVerzeichnis: boolean): Promise<void> {
    this.eintraege.set(pfad, istVerzeichnis ? undefined : Buffer.alloc(0));
  }

  async loesche(pfad: string): Promise<void> {
    this.eintraege.delete(pfad);
  }

  async benenneUm(von: string, nach: string): Promise<void> {
    const inhalt = this.eintraege.get(von);
    this.eintraege.delete(von);
    this.eintraege.set(nach, inhalt);
  }

  async kuerze(pfad: string, laenge: number): Promise<void> {
    const alt = this.eintraege.get(pfad) ?? Buffer.alloc(0);
    const neu = Buffer.alloc(laenge);
    alt.copy(neu, 0, 0, Math.min(alt.length, laenge));
    this.eintraege.set(pfad, neu);
  }
}

/** Ein nur lesendes Dateisystem: die Schreibmethoden fehlen ganz. */
function nurLesend(speicher: Speicher): RdpdrDateisystem {
  return {
    stat: (p) => speicher.stat(p),
    liste: (p) => speicher.liste(p),
    lies: (p, o, l) => speicher.lies(p, o, l),
  };
}

// ----------------------------------------------------------------- Gerueste

const DEVICE_ID = 3;

interface Aufbau {
  sitzung: RdpdrSession;
  gesendet: Buffer[];
  speicher: Speicher;
  protokoll: string[];
}

function baue(opts: { nurLesen?: boolean; speicher?: Speicher; schreibbar?: boolean } = {}): Aufbau {
  const gesendet: Buffer[] = [];
  const protokoll: string[] = [];
  const speicher =
    opts.speicher ??
    new Speicher({
      repo: null,
      'repo/src': null,
      'repo/src/index.ts': 'const a = 1;\n',
      'repo/README.md': '# Repo\n',
    });
  const sitzung = new RdpdrSession({
    send: (daten) => gesendet.push(daten),
    computerName: 'VSCODE',
    nurLesen: opts.nurLesen,
    log: (n) => protokoll.push(n),
    laufwerke: () => [
      {
        deviceId: DEVICE_ID,
        name: 'Arbeitsbereich',
        dateisystem: opts.schreibbar === false ? nurLesend(speicher) : speicher,
      },
    ],
  });
  return { sitzung, gesendet, speicher, protokoll };
}

/** DR_CORE_SERVER_ANNOUNCE_REQ bauen (2.2.2.2). */
function serverAnnounce(versionMinor = 0x000c, clientId = 0x1234): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt16LE(1, 0);
  body.writeUInt16LE(versionMinor, 2);
  body.writeUInt32LE(clientId, 4);
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_SERVER_ANNOUNCE, body);
}

/** DR_CORE_CAPABILITY_REQ mit einem Drive-Satz (2.2.2.7). */
function serverCapabilities(): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt16LE(1, 0); // numCapabilities
  body.writeUInt16LE(0, 2); // Padding
  body.writeUInt16LE(0x0004, 4); // CAP_DRIVE_TYPE
  body.writeUInt16LE(8, 6);
  body.writeUInt32LE(2, 8); // DRIVE_CAPABILITY_VERSION_02
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_SERVER_CAPABILITY, body);
}

function clientIdConfirm(clientId = 0x1234): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt16LE(1, 0);
  body.writeUInt16LE(0x000c, 2);
  body.writeUInt32LE(clientId, 4);
  return buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_CLIENTID_CONFIRM, body);
}

/** Den gemeinsamen 24-Byte-Kopf einer I/O-Anfrage bauen (2.2.1.4). */
function ioKopf(fileId: number, completionId: number, major: number, minor = 0): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt32LE(DEVICE_ID, 0);
  b.writeUInt32LE(fileId, 4);
  b.writeUInt32LE(completionId, 8);
  b.writeUInt32LE(major, 12);
  b.writeUInt32LE(minor, 16);
  return b;
}

function ioNachricht(teile: Buffer[]): Buffer {
  return buildRdpdrPdu(RDPDR_CTYP_CORE, 0x4952 /* PAKID_CORE_DEVICE_IOREQUEST */, Buffer.concat(teile));
}

function create(
  completionId: number,
  pfad: string,
  opts: { access?: number; disposition?: number; options?: number } = {},
): Buffer {
  const pfadBytes = Buffer.from(pfad + '\0', 'ucs2');
  const fest = Buffer.alloc(32);
  fest.writeUInt32LE((opts.access ?? GENERIC_READ) >>> 0, 0);
  // AllocationSize (8 Byte) bleibt null
  fest.writeUInt32LE(0, 12); // FileAttributes
  fest.writeUInt32LE(0, 16); // SharedAccess
  fest.writeUInt32LE(opts.disposition ?? FILE_OPEN, 20);
  fest.writeUInt32LE(opts.options ?? 0, 24);
  fest.writeUInt32LE(pfadBytes.length, 28);
  return ioNachricht([ioKopf(0, completionId, IRP_MJ_CREATE), fest, pfadBytes]);
}

function close(fileId: number, completionId: number): Buffer {
  return ioNachricht([ioKopf(fileId, completionId, IRP_MJ_CLOSE), Buffer.alloc(32)]);
}

function read(fileId: number, completionId: number, offset: number, laenge: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(laenge, 0);
  b.writeBigUInt64LE(BigInt(offset), 4);
  return ioNachricht([ioKopf(fileId, completionId, IRP_MJ_READ), b]);
}

function write(fileId: number, completionId: number, offset: number, daten: Buffer): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(daten.length, 0);
  b.writeBigUInt64LE(BigInt(offset), 4);
  return ioNachricht([ioKopf(fileId, completionId, IRP_MJ_WRITE), b, daten]);
}

function queryInfo(fileId: number, completionId: number, klasse: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(klasse, 0);
  return ioNachricht([ioKopf(fileId, completionId, IRP_MJ_QUERY_INFORMATION), b]);
}

function queryVolume(fileId: number, completionId: number, klasse: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(klasse, 0);
  return ioNachricht([ioKopf(fileId, completionId, IRP_MJ_QUERY_VOLUME_INFORMATION), b]);
}

function setInfo(fileId: number, completionId: number, klasse: number, puffer: Buffer): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(klasse, 0);
  b.writeUInt32LE(puffer.length, 4);
  return ioNachricht([ioKopf(fileId, completionId, IRP_MJ_SET_INFORMATION), b, puffer]);
}

function queryDir(
  fileId: number,
  completionId: number,
  pfad: string,
  initial: boolean,
  klasse = FileBothDirectoryInformation,
): Buffer {
  const pfadBytes = Buffer.from(pfad + '\0', 'ucs2');
  const b = Buffer.alloc(32);
  b.writeUInt32LE(klasse, 0);
  b.writeUInt8(initial ? 1 : 0, 4);
  b.writeUInt32LE(pfadBytes.length, 5);
  return ioNachricht([
    ioKopf(fileId, completionId, IRP_MJ_DIRECTORY_CONTROL, IRP_MN_QUERY_DIRECTORY),
    b,
    pfadBytes,
  ]);
}

/** RDP_FILE_RENAME_INFORMATION bauen (2.2.3.3.9.1). */
function renameInfo(ziel: string, ersetzen = true): Buffer {
  const name = Buffer.from(ziel, 'ucs2');
  const kopf = Buffer.alloc(6);
  kopf.writeUInt8(ersetzen ? 1 : 0, 0);
  kopf.writeUInt8(0, 1);
  kopf.writeUInt32LE(name.length, 2);
  return Buffer.concat([kopf, name]);
}

/** Die letzte Antwort auf eine CompletionId heraussuchen. */
function antwortZu(gesendet: readonly Buffer[], completionId: number): { status: number; rumpf: Buffer } {
  for (let i = gesendet.length - 1; i >= 0; i--) {
    const pdu = parseRdpdrPdu(gesendet[i]);
    if (pdu.packetId !== PAKID_CORE_DEVICE_IOCOMPLETION) continue;
    if (pdu.body.readUInt32LE(4) !== completionId) continue;
    return { status: pdu.body.readUInt32LE(8), rumpf: pdu.body.subarray(12) };
  }
  throw new Error(`keine Antwort auf CompletionId ${completionId}`);
}

/** Die Sitzung bis zur angekuendigten Geraeteliste bringen. */
async function bisBereit(a: Aufbau): Promise<void> {
  a.sitzung.verarbeite(serverAnnounce());
  a.sitzung.verarbeite(serverCapabilities());
  a.sitzung.verarbeite(clientIdConfirm());
  // Die Laufwerksliste wird asynchron geholt (dort sitzt spaeter die
  // Rueckfrage beim Benutzer), also einmal die Ereignisschleife durchlassen.
  await schlafe(0);
}

/** Ein Handle oeffnen und seine FileId liefern. */
async function oeffne(
  a: Aufbau,
  pfad: string,
  opts: Parameters<typeof create>[2] = {},
  completionId = 900,
): Promise<{ status: number; fileId: number }> {
  a.sitzung.verarbeite(create(completionId, pfad, opts));
  await schlafe(0);
  const antwort = antwortZu(a.gesendet, completionId);
  return { status: antwort.status, fileId: antwort.rumpf.readUInt32LE(0) };
}

// -------------------------------------------------------------------- Tests

describe('RDPDR-Sitzung - Handshake nach 3.2.5.1', () => {
  test('Auf das Server Announce folgen Antwort und Rechnername, in dieser Reihenfolge', () => {
    const a = baue();
    a.sitzung.verarbeite(serverAnnounce());
    assert.equal(a.gesendet.length, 2);
    assert.equal(parseRdpdrPdu(a.gesendet[0]).packetId, PAKID_CORE_CLIENTID_CONFIRM);
    assert.equal(parseRdpdrPdu(a.gesendet[1]).packetId, PAKID_CORE_CLIENT_NAME);
  });

  test('Ab Nebenversion 12 wird die ClientId des Servers uebernommen (3.2.5.1.3)', () => {
    const a = baue();
    a.sitzung.verarbeite(serverAnnounce(0x000c, 0xabcdef01));
    assert.equal(parseRdpdrPdu(a.gesendet[0]).body.readUInt32LE(4), 0xabcdef01);
  });

  test('Unter Nebenversion 12 zieht der Client eine eigene ClientId', () => {
    const a = baue();
    a.sitzung.verarbeite(serverAnnounce(0x000a, 0xabcdef01));
    assert.notEqual(parseRdpdrPdu(a.gesendet[0]).body.readUInt32LE(4), 0xabcdef01);
  });

  test('Die Nebenversion wird nie hoeher gemeldet, als der Server kann', () => {
    assert.equal(waehleNebenversion(0x000d), 0x000c); // wir koennen hoechstens 12
    assert.equal(waehleNebenversion(0x000c), 0x000c);
    assert.equal(waehleNebenversion(0x000a), 0x000a);
    assert.equal(waehleNebenversion(0x0005), 0x0005);
    assert.equal(waehleNebenversion(0x0003), 0x0002); // nur die Werte aus 2.2.2.3
    assert.equal(waehleNebenversion(0x0000), 0x0002);
  });

  test('Auf die Faehigkeiten des Servers folgt unsere Antwort', () => {
    const a = baue();
    a.sitzung.verarbeite(serverAnnounce());
    a.sitzung.verarbeite(serverCapabilities());
    assert.equal(parseRdpdrPdu(a.gesendet[2]).packetId, PAKID_CORE_CLIENT_CAPABILITY);
  });

  test('Die Geraeteliste geht erst nach Faehigkeiten und ClientId-Bestaetigung hinaus', async () => {
    const a = baue();
    a.sitzung.verarbeite(serverAnnounce());
    a.sitzung.verarbeite(serverCapabilities());
    await schlafe(0);
    assert.equal(
      a.gesendet.some((d) => parseRdpdrPdu(d).packetId === PAKID_CORE_DEVICELIST_ANNOUNCE),
      false,
    );
    a.sitzung.verarbeite(clientIdConfirm());
    await schlafe(0);
    assert.equal(a.sitzung.istBereit, true);
    assert.equal(
      a.gesendet.filter((d) => parseRdpdrPdu(d).packetId === PAKID_CORE_DEVICELIST_ANNOUNCE).length,
      1,
    );
  });

  test('Ein spaeteres User Logged On kuendigt nicht erneut an (3.2.5.1.9)', async () => {
    const a = baue();
    await bisBereit(a);
    a.sitzung.verarbeite(buildRdpdrPdu(RDPDR_CTYP_CORE, PAKID_CORE_USER_LOGGEDON));
    await schlafe(0);
    assert.equal(
      a.gesendet.filter((d) => parseRdpdrPdu(d).packetId === PAKID_CORE_DEVICELIST_ANNOUNCE).length,
      1,
    );
  });

  test('Eine leere Laufwerksliste kuendigt gar nichts an und meldet keinen Fehler', async () => {
    const gesendet: Buffer[] = [];
    const protokoll: string[] = [];
    const sitzung = new RdpdrSession({
      send: (d) => gesendet.push(d),
      computerName: 'VSCODE',
      log: (n) => protokoll.push(n),
      laufwerke: () => [],
    });
    sitzung.verarbeite(serverAnnounce());
    sitzung.verarbeite(serverCapabilities());
    sitzung.verarbeite(clientIdConfirm());
    await schlafe(0);
    assert.equal(
      gesendet.some((d) => parseRdpdrPdu(d).packetId === PAKID_CORE_DEVICELIST_ANNOUNCE),
      false,
    );
    assert.equal(
      protokoll.some((n) => n.includes('keine Laufwerke freigegeben')),
      true,
    );
  });

  test('Eine abgelehnte Rueckfrage beendet die Sitzung nicht', async () => {
    const gesendet: Buffer[] = [];
    const sitzung = new RdpdrSession({
      send: (d) => gesendet.push(d),
      computerName: 'VSCODE',
      laufwerke: () => Promise.reject(new Error('vom Benutzer abgelehnt')),
    });
    sitzung.verarbeite(serverAnnounce());
    sitzung.verarbeite(serverCapabilities());
    sitzung.verarbeite(clientIdConfirm());
    await schlafe(0);
    assert.equal(sitzung.istBereit, true);
    assert.equal(
      gesendet.some((d) => parseRdpdrPdu(d).packetId === PAKID_CORE_DEVICELIST_ANNOUNCE),
      false,
    );
  });

  test('Ein zweites Server Announce setzt die Sitzung zurueck (3.2.5.1.2)', async () => {
    const a = baue();
    await bisBereit(a);
    const vorher = a.gesendet.length;
    a.sitzung.verarbeite(serverAnnounce());
    assert.equal(a.sitzung.istBereit, false);
    assert.equal(a.sitzung.offeneHandles, 0);
    assert.equal(parseRdpdrPdu(a.gesendet[vorher]).packetId, PAKID_CORE_CLIENTID_CONFIRM);
  });

  test('Nach dispose() geht nichts mehr hinaus', () => {
    const a = baue();
    a.sitzung.dispose();
    a.sitzung.verarbeite(serverAnnounce());
    assert.equal(a.gesendet.length, 0);
  });

  test('Eine fremde Komponente wird verworfen, nicht beantwortet', () => {
    const a = baue();
    a.sitzung.verarbeite(buildRdpdrPdu(0x5052 /* RDPDR_CTYP_PRN */, 0x5043));
    assert.equal(a.gesendet.length, 0);
  });

  test('Muell auf dem Kanal beendet die Sitzung nicht', () => {
    const a = baue();
    a.sitzung.verarbeite(Buffer.from([0x01]));
    a.sitzung.verarbeite(Buffer.from('unfug'));
    a.sitzung.verarbeite(serverAnnounce());
    assert.equal(a.gesendet.length, 2);
  });
});

describe('RDPDR-Sitzung - Oeffnen und Lesen', () => {
  test('Eine vorhandene Datei laesst sich oeffnen und lesen', async () => {
    const a = baue();
    await bisBereit(a);
    const { status, fileId } = await oeffne(a, '\\repo\\README.md');
    assert.equal(status, STATUS_SUCCESS);
    assert.notEqual(fileId, 0);

    a.sitzung.verarbeite(read(fileId, 10, 0, 4096));
    await schlafe(0);
    const antwort = antwortZu(a.gesendet, 10);
    assert.equal(antwort.status, STATUS_SUCCESS);
    assert.equal(antwort.rumpf.readUInt32LE(0), 7); // "# Repo\n"
    assert.equal(antwort.rumpf.subarray(4).toString('utf8'), '# Repo\n');
  });

  test('Am Dateiende antwortet das Lesen mit STATUS_END_OF_FILE', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md');
    a.sitzung.verarbeite(read(fileId, 11, 9999, 4096));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 11).status, STATUS_END_OF_FILE);
  });

  test('Die Wurzel ist immer vorhanden und ist ein Verzeichnis', async () => {
    const a = baue();
    await bisBereit(a);
    const { status, fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
    assert.equal(status, STATUS_SUCCESS);
    a.sitzung.verarbeite(queryInfo(fileId, 20, FileStandardInformation));
    await schlafe(0);
    const antwort = antwortZu(a.gesendet, 20);
    assert.equal(antwort.status, STATUS_SUCCESS);
    // Directory-Flag steht an Byte 21 des Puffers (hinter Length).
    assert.equal(antwort.rumpf.readUInt8(4 + 21), 1);
  });

  test('Eine fehlende Datei ergibt STATUS_OBJECT_NAME_NOT_FOUND', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\desktop.ini');
    assert.equal(status, STATUS_OBJECT_NAME_NOT_FOUND);
  });

  test('FILE_NON_DIRECTORY_FILE auf ein Verzeichnis ergibt STATUS_FILE_IS_A_DIRECTORY', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo', { options: FILE_NON_DIRECTORY_FILE });
    assert.equal(status, 0xc00000ba);
  });

  test('FILE_DIRECTORY_FILE auf eine Datei ergibt STATUS_NOT_A_DIRECTORY', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\README.md', { options: FILE_DIRECTORY_FILE });
    assert.equal(status, 0xc0000103);
  });

  test('Das Information-Feld haengt allein an der CreateDisposition (2.2.3.4.1)', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    for (const [disposition, erwartet] of [
      [FILE_OPEN, FILE_SUPERSEDED],
      [FILE_OPEN_IF, FILE_OPENED],
      [FILE_OVERWRITE_IF, FILE_OVERWRITTEN],
    ] as const) {
      a.gesendet.length = 0;
      a.sitzung.verarbeite(create(30, '\\repo\\README.md', { disposition, access: GENERIC_READ }));
      await schlafe(0);
      const antwort = antwortZu(a.gesendet, 30);
      assert.equal(antwort.status, STATUS_SUCCESS, `Disposition ${disposition}`);
      assert.equal(antwort.rumpf.readUInt8(4), erwartet, `Disposition ${disposition}`);
    }
  });

  test('Ein Lesen auf ein unbekanntes Handle wird abgelehnt statt ignoriert', async () => {
    const a = baue();
    await bisBereit(a);
    a.sitzung.verarbeite(read(999, 31, 0, 16));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 31).status, STATUS_INVALID_DEVICE_REQUEST);
  });

  test('Eine Anfrage an ein unbekanntes Geraet wird abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const nachricht = create(32, '\\repo');
    // DeviceId im Rumpf auf einen Wert setzen, den wir nie angekuendigt haben.
    nachricht.writeUInt32LE(99, 4);
    a.sitzung.verarbeite(nachricht);
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 32).status, STATUS_INVALID_DEVICE_REQUEST);
  });
});

describe('RDPDR-Sitzung - Pfad-Fluchtversuche', () => {
  for (const boese of ['\\..', '\\..\\..\\etc\\passwd', '\\repo\\..\\..\\geheim', '\\repo/../../etc/shadow']) {
    test(`Create auf "${boese}" wird mit STATUS_ACCESS_DENIED abgewiesen`, async () => {
      const a = baue();
      await bisBereit(a);
      const vorher = a.speicher.angefragt.length;
      const { status } = await oeffne(a, boese);
      assert.equal(status, STATUS_ACCESS_DENIED);
      // Entscheidend: das Dateisystem wurde gar nicht erst gefragt.
      assert.equal(a.speicher.angefragt.length, vorher);
    });
  }

  test('Ein Geraetename wie COM1 wird abgewiesen (3.2.5.2.3)', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\COM1');
    assert.equal(status, STATUS_ACCESS_DENIED);
  });

  test('Umbenennen auf einen Pfad mit ".." wird abgewiesen', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    a.sitzung.verarbeite(setInfo(fileId, 40, FileRenameInformation, renameInfo('\\..\\..\\entfuehrt.md')));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 40).status, STATUS_ACCESS_DENIED);
    assert.equal(a.speicher.eintraege.has('repo/README.md'), true);
  });

  test('Umbenennen auf die Wurzel wird abgewiesen', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    a.sitzung.verarbeite(setInfo(fileId, 41, FileRenameInformation, renameInfo('\\')));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 41).status, STATUS_ACCESS_DENIED);
  });

  test('Kein einziger Pfad mit ".." erreicht jemals das Dateisystem', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    for (const boese of ['\\..', '\\repo\\..\\..', '\\repo\\.\\..', '\\...\\x']) {
      await oeffne(a, boese, {}, 500 + boese.length);
    }
    assert.equal(
      a.speicher.angefragt.some((p) => p.includes('..')),
      false,
    );
  });
});

describe('RDPDR-Sitzung - Nur-Lesen ist der Standard', () => {
  test('Ohne Angabe ist die Sitzung nur lesbar', () => {
    assert.equal(baue().sitzung.nurLesen, true);
  });

  test('Ein Oeffnen mit Schreibwunsch wird schon beim Create abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    assert.equal(status, STATUS_ACCESS_DENIED);
  });

  test('Auch DELETE im DesiredAccess gilt als Schreibwunsch', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_READ | DELETE });
    assert.equal(status, STATUS_ACCESS_DENIED);
  });

  test('Auch eine anlegende CreateDisposition gilt als Schreibwunsch', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\neu.txt', {
      access: GENERIC_READ,
      disposition: FILE_CREATE,
    });
    assert.equal(status, STATUS_ACCESS_DENIED);
    assert.equal(a.speicher.eintraege.has('repo/neu.txt'), false);
  });

  test('Auch FILE_DELETE_ON_CLOSE gilt als Schreibwunsch', async () => {
    const a = baue();
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\README.md', {
      access: GENERIC_READ,
      options: FILE_DELETE_ON_CLOSE,
    });
    assert.equal(status, STATUS_ACCESS_DENIED);
  });

  test('Ein Schreiben auf ein lesend geoeffnetes Handle wird abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md');
    a.sitzung.verarbeite(write(fileId, 50, 0, Buffer.from('boese')));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 50).status, STATUS_ACCESS_DENIED);
    assert.equal(a.speicher.eintraege.get('repo/README.md')?.toString('utf8'), '# Repo\n');
  });

  test('Set Information wird im Nur-Lesen-Betrieb abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md');
    a.sitzung.verarbeite(setInfo(fileId, 51, FileDispositionInformation, Buffer.alloc(0)));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 51).status, STATUS_ACCESS_DENIED);
    assert.equal(a.speicher.eintraege.has('repo/README.md'), true);
  });

  test('Das Laufwerk meldet sich als schreibgeschuetzt an (FILE_READ_ONLY_VOLUME)', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryVolume(fileId, 52, FileFsAttributeInformation));
    await schlafe(0);
    const antwort = antwortZu(a.gesendet, 52);
    assert.equal((antwort.rumpf.readUInt32LE(4) & 0x00080000) !== 0, true);
  });

  test('Fehlt dem Dateisystem die Schreibmethode, wird ebenfalls abgelehnt', async () => {
    // Nicht die Einstellung, sondern die Faehigkeit: unter Remote-SSH kann ein
    // Dateisystem lesbar und trotzdem nicht beschreibbar sein.
    const a = baue({ nurLesen: false, schreibbar: false });
    await bisBereit(a);
    const { fileId, status } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    assert.equal(status, STATUS_SUCCESS);
    a.sitzung.verarbeite(write(fileId, 53, 0, Buffer.from('x')));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 53).status, STATUS_ACCESS_DENIED);
  });
});

describe('RDPDR-Sitzung - Schreiben, wenn es erlaubt ist', () => {
  test('Anlegen, schreiben, lesen', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { status, fileId } = await oeffne(a, '\\repo\\neu.txt', {
      access: GENERIC_WRITE,
      disposition: FILE_CREATE,
    });
    assert.equal(status, STATUS_SUCCESS);
    a.sitzung.verarbeite(write(fileId, 60, 0, Buffer.from('hallo')));
    await schlafe(0);
    const antwort = antwortZu(a.gesendet, 60);
    assert.equal(antwort.status, STATUS_SUCCESS);
    assert.equal(antwort.rumpf.readUInt32LE(0), 5);
    assert.equal(a.speicher.eintraege.get('repo/neu.txt')?.toString('utf8'), 'hallo');
  });

  test('FILE_CREATE auf eine vorhandene Datei ergibt STATUS_OBJECT_NAME_COLLISION', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { status } = await oeffne(a, '\\repo\\README.md', {
      access: GENERIC_WRITE,
      disposition: FILE_CREATE,
    });
    assert.equal(status, 0xc0000035);
  });

  test('Umbenennen verschiebt die Datei', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    a.sitzung.verarbeite(setInfo(fileId, 61, FileRenameInformation, renameInfo('\\repo\\LIESMICH.md')));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 61).status, STATUS_SUCCESS);
    assert.equal(a.speicher.eintraege.has('repo/LIESMICH.md'), true);
    assert.equal(a.speicher.eintraege.has('repo/README.md'), false);
  });

  test('FileDispositionInformation loescht erst beim Schliessen', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', { access: DELETE });
    a.sitzung.verarbeite(setInfo(fileId, 62, FileDispositionInformation, Buffer.alloc(0)));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 62).status, STATUS_SUCCESS);
    // Noch da: NT loescht beim letzten Schliessen, nicht beim Vormerken.
    assert.equal(a.speicher.eintraege.has('repo/README.md'), true);
    a.sitzung.verarbeite(close(fileId, 63));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 63).status, STATUS_SUCCESS);
    assert.equal(a.speicher.eintraege.has('repo/README.md'), false);
  });

  test('FILE_DELETE_ON_CLOSE loescht beim Schliessen', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', {
      access: DELETE,
      options: FILE_DELETE_ON_CLOSE,
    });
    a.sitzung.verarbeite(close(fileId, 64));
    await schlafe(0);
    assert.equal(a.speicher.eintraege.has('repo/README.md'), false);
  });

  test('FileBasicInformation wird bestaetigt, ohne etwas zu aendern', async () => {
    // Sonst scheitert jeder Kopiervorgang des Explorers am Schluss.
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    a.sitzung.verarbeite(setInfo(fileId, 65, FileBasicInformation, Buffer.alloc(36)));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 65).status, STATUS_SUCCESS);
  });

  test('Die Antwort auf Set Information wiederholt die Laenge der Anfrage (2.2.3.4.9)', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md', { access: GENERIC_WRITE });
    const puffer = Buffer.alloc(36);
    a.sitzung.verarbeite(setInfo(fileId, 66, FileBasicInformation, puffer));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 66).rumpf.readUInt32LE(0), 36);
  });
});

describe('RDPDR-Sitzung - Verzeichnisaufzaehlung nach 2.2.3.3.10', () => {
  test('Je Anfrage genau ein Eintrag, "." und ".." zuerst', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo', { options: FILE_DIRECTORY_FILE });

    const namen: string[] = [];
    for (let i = 0; i < 10; i++) {
      a.sitzung.verarbeite(queryDir(fileId, 100 + i, '\\repo\\*', i === 0));
      await schlafe(0);
      const antwort = antwortZu(a.gesendet, 100 + i);
      if (antwort.status === STATUS_NO_MORE_FILES) break;
      assert.equal(antwort.status, STATUS_SUCCESS);
      const puffer = antwort.rumpf.subarray(4);
      // FILE_BOTH_DIR_INFORMATION: FileNameLength steht bei Byte 60,
      // der Name beginnt bei Byte 94.
      const laenge = puffer.readUInt32LE(60);
      namen.push(puffer.subarray(94, 94 + laenge).toString('ucs2'));
    }
    assert.deepEqual(namen, ['.', '..', 'src', 'README.md']);
  });

  test('Nach dem letzten Eintrag kommt STATUS_NO_MORE_FILES', async () => {
    const a = baue({ speicher: new Speicher({ leer: null }) });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\leer', { options: FILE_DIRECTORY_FILE });
    // "." und ".." sind zwei Eintraege, danach ist Schluss.
    for (const [i, erwartet] of [[0, STATUS_SUCCESS], [1, STATUS_SUCCESS], [2, STATUS_NO_MORE_FILES]] as const) {
      a.sitzung.verarbeite(queryDir(fileId, 110 + i, '\\leer\\*', i === 0));
      await schlafe(0);
      assert.equal(antwortZu(a.gesendet, 110 + i).status, erwartet);
    }
  });

  test('Ein Muster ohne Treffer ergibt beim ersten Mal STATUS_NO_SUCH_FILE', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryDir(fileId, 120, '\\repo\\gibtsnicht.xyz', true));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 120).status, STATUS_NO_SUCH_FILE);
  });

  test('Das Suchmuster filtert', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\src', { options: FILE_DIRECTORY_FILE });
    const namen: string[] = [];
    for (let i = 0; i < 10; i++) {
      a.sitzung.verarbeite(queryDir(fileId, 130 + i, '\\repo\\src\\*.ts', i === 0));
      await schlafe(0);
      const antwort = antwortZu(a.gesendet, 130 + i);
      if (antwort.status !== STATUS_SUCCESS) break;
      const puffer = antwort.rumpf.subarray(4);
      namen.push(puffer.subarray(94, 94 + puffer.readUInt32LE(60)).toString('ucs2'));
    }
    // "." und ".." passen nicht auf "*.ts".
    assert.deepEqual(namen, ['index.ts']);
  });

  test('Eine Aufzaehlung auf einem Dateihandle wird abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md');
    a.sitzung.verarbeite(queryDir(fileId, 140, '\\repo\\README.md', true));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 140).status, STATUS_INVALID_DEVICE_REQUEST);
  });

  test('Eine unbekannte Verzeichnisklasse wird belegt abgelehnt, nicht geraten', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryDir(fileId, 141, '\\repo\\*', true, 0x37));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 141).status, STATUS_NOT_SUPPORTED);
  });

  test('Das Verzeichnis kommt aus dem Handle, nicht aus dem Pfad der Anfrage', async () => {
    // Ein Server, der ein Handle auf "repo" hat und danach nach "\\etc\\*"
    // fragt, darf nicht den Inhalt von "etc" bekommen.
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo', { options: FILE_DIRECTORY_FILE });
    a.speicher.angefragt.length = 0;
    a.sitzung.verarbeite(queryDir(fileId, 142, '\\..\\..\\etc\\*', true));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 142).status, STATUS_SUCCESS);
    assert.deepEqual(a.speicher.angefragt, ['repo']);
  });
});

describe('RDPDR-Sitzung - Volumen- und Dateiinformationen', () => {
  test('Alle fuenf Volumenklassen aus 2.2.3.3.6 werden beantwortet', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
    const klassen = [
      FileFsVolumeInformation,
      FileFsSizeInformation,
      FileFsFullSizeInformation,
      FileFsAttributeInformation,
      FileFsDeviceInformation,
    ];
    for (const [i, klasse] of klassen.entries()) {
      a.sitzung.verarbeite(queryVolume(fileId, 150 + i, klasse));
      await schlafe(0);
      const antwort = antwortZu(a.gesendet, 150 + i);
      assert.equal(antwort.status, STATUS_SUCCESS, `Klasse 0x${klasse.toString(16)}`);
      assert.equal(antwort.rumpf.readUInt32LE(0) > 0, true);
    }
  });

  test('Eine unbekannte Volumenklasse wird belegt abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryVolume(fileId, 160, 0x42));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 160).status, STATUS_NOT_SUPPORTED);
  });

  test('Der freie Platz ist im Nur-Lesen-Betrieb null', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryVolume(fileId, 161, FileFsSizeInformation));
    await schlafe(0);
    const puffer = antwortZu(a.gesendet, 161).rumpf.subarray(4);
    assert.equal(puffer.readBigUInt64LE(0) > 0n, true); // Gesamtgroesse
    assert.equal(puffer.readBigUInt64LE(8), 0n); // frei
  });

  test('Im Schreibbetrieb wird freier Platz gemeldet - sonst kopiert Windows nicht', async () => {
    const a = baue({ nurLesen: false });
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryVolume(fileId, 162, FileFsSizeInformation));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 162).rumpf.subarray(4).readBigUInt64LE(8) > 0n, true);
  });

  test('Die Seriennummer haengt am Namen und bleibt ueber Sitzungen gleich', async () => {
    const lies = async (): Promise<number> => {
      const a = baue();
      await bisBereit(a);
      const { fileId } = await oeffne(a, '\\', { options: FILE_DIRECTORY_FILE });
      a.sitzung.verarbeite(queryVolume(fileId, 163, FileFsVolumeInformation));
      await schlafe(0);
      return antwortZu(a.gesendet, 163).rumpf.subarray(4).readUInt32LE(8);
    };
    assert.equal(await lies(), await lies());
  });

  test('FileBasicInformation eines Verzeichnisses traegt FILE_ATTRIBUTE_DIRECTORY', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo', { options: FILE_DIRECTORY_FILE });
    a.sitzung.verarbeite(queryInfo(fileId, 170, FileBasicInformation));
    await schlafe(0);
    const puffer = antwortZu(a.gesendet, 170).rumpf.subarray(4);
    assert.equal(puffer.readUInt32LE(32) & FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_DIRECTORY);
  });

  test('Eine unbekannte Informationsklasse wird belegt abgelehnt', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo');
    a.sitzung.verarbeite(queryInfo(fileId, 171, 0x99));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 171).status, STATUS_NOT_SUPPORTED);
  });
});

describe('RDPDR-Sitzung - was nicht unterstuetzt wird, wird belegt abgelehnt', () => {
  test('Device Control antwortet mit STATUS_NOT_SUPPORTED und leerem Puffer', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo');
    const b = Buffer.alloc(32);
    b.writeUInt32LE(1024, 0); // OutputBufferLength
    b.writeUInt32LE(0, 4); // InputBufferLength
    b.writeUInt32LE(0x000900a4, 8); // irgendein FSCTL
    a.sitzung.verarbeite(ioNachricht([ioKopf(fileId, 180, IRP_MJ_DEVICE_CONTROL), b]));
    await schlafe(0);
    const antwort = antwortZu(a.gesendet, 180);
    assert.equal(antwort.status, STATUS_NOT_SUPPORTED);
    assert.equal(antwort.rumpf.readUInt32LE(0), 0);
  });

  test('Eine unbekannte MajorFunction bleibt nicht unbeantwortet', async () => {
    const a = baue();
    await bisBereit(a);
    a.sitzung.verarbeite(ioNachricht([ioKopf(0, 181, 0x00000009 /* IRP_MJ_QUERY_EA */), Buffer.alloc(32)]));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 181).status, STATUS_NOT_SUPPORTED);
  });

  test('Eine Sperranfrage wird bestaetigt, ohne zu sperren', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md');
    const b = Buffer.alloc(32);
    b.writeUInt32LE(2, 0); // RDP_LOWIO_OP_SHAREDLOCK
    a.sitzung.verarbeite(ioNachricht([ioKopf(fileId, 182, 0x00000011 /* IRP_MJ_LOCK_CONTROL */), b]));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 182).status, STATUS_SUCCESS);
  });

  test('Eine offene NotifyChange-Anfrage wird beim Schliessen leer abgeschlossen (2.2.3.4.11)', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo', { options: FILE_DIRECTORY_FILE });
    const b = Buffer.alloc(32);
    b.writeUInt8(1, 0); // WatchTree
    b.writeUInt32LE(0x0000001f, 1); // CompletionFilter
    a.sitzung.verarbeite(
      ioNachricht([ioKopf(fileId, 190, IRP_MJ_DIRECTORY_CONTROL, 2 /* IRP_MN_NOTIFY_CHANGE_DIRECTORY */), b]),
    );
    await schlafe(0);
    // Noch keine Antwort: die Anfrage bleibt offen.
    assert.throws(() => antwortZu(a.gesendet, 190));

    a.sitzung.verarbeite(close(fileId, 191));
    await schlafe(0);
    const antwort = antwortZu(a.gesendet, 190);
    assert.equal(antwort.status, STATUS_SUCCESS);
    assert.equal(antwort.rumpf.readUInt32LE(0), 0);
  });

  test('Ein Close auf ein unbekanntes Handle wird trotzdem beantwortet', async () => {
    const a = baue();
    await bisBereit(a);
    a.sitzung.verarbeite(close(777, 192));
    await schlafe(0);
    assert.equal(antwortZu(a.gesendet, 192).status, STATUS_SUCCESS);
  });

  test('Ein Fehler im Dateisystem wird zur Antwort, nicht zum Absturz', async () => {
    const kaputt: RdpdrDateisystem = {
      stat: () => Promise.reject(new Error('Netzwerk weg')),
      liste: () => Promise.reject(new Error('Netzwerk weg')),
      lies: () => Promise.reject(new Error('Netzwerk weg')),
    };
    const gesendet: Buffer[] = [];
    const sitzung = new RdpdrSession({
      send: (d) => gesendet.push(d),
      computerName: 'VSCODE',
      laufwerke: () => [{ deviceId: DEVICE_ID, name: 'X', dateisystem: kaputt }],
    });
    sitzung.verarbeite(serverAnnounce());
    sitzung.verarbeite(serverCapabilities());
    sitzung.verarbeite(clientIdConfirm());
    await schlafe(0);
    sitzung.verarbeite(create(200, '\\repo\\datei.ts'));
    await schlafe(0);
    assert.equal(antwortZu(gesendet, 200).status, 0xc0000001); // STATUS_UNSUCCESSFUL
  });

  test('Handles werden beim Schliessen wieder freigegeben', async () => {
    const a = baue();
    await bisBereit(a);
    const { fileId } = await oeffne(a, '\\repo\\README.md');
    assert.equal(a.sitzung.offeneHandles, 1);
    a.sitzung.verarbeite(close(fileId, 201));
    await schlafe(0);
    assert.equal(a.sitzung.offeneHandles, 0);
  });
});
