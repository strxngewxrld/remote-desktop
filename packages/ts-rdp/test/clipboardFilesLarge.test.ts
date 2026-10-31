/**
 * Ordner, Zeitstempel und Dateien ueber 4 GiB in beide Richtungen - ohne je
 * einen grossen Puffer anzulegen: die Quellen erzeugen ihre Bytes aus dem Offset.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as c from '../src/protocol/cliprdr.js';
import {
  ClipboardDownload,
  dateZuFiletime,
  filetimeZuDate,
  parseRemoteFileList,
  type ClipboardFileWriter,
  type ClipboardSink,
  type RemoteClipboardEntry,
} from '../src/protocol/clipboardDownload.js';

const GiB = 1024 ** 3;
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Deterministische Bytes: der Wert haengt nur an der absoluten Position. */
const muster = (offset: number, length: number): Buffer => {
  const b = Buffer.alloc(length);
  for (let i = 0; i < length; i++) b[i] = ((offset + i) * 7) & 0xff;
  return b;
};
const quelle = (name: string, size: number, extra: Partial<c.ClipboardFileSource> = {}): c.ClipboardFileSource =>
  ({ name, size, read: async (o, l) => muster(o, l), ...extra });
const ordner = (name: string, lastWriteTime?: Date): c.ClipboardFileSource =>
  ({ name, size: 0, directory: true, lastWriteTime, read: async () => Buffer.alloc(0) });

test('FILETIME: Roundtrip auf Millisekunden, 0 und Unsinn ergeben kein Datum', () => {
  for (const d of [new Date(0), new Date('2024-02-29T12:34:56.789Z'), new Date('1999-12-31T23:59:59.001Z')])
    assert.equal(filetimeZuDate(dateZuFiletime(d))!.getTime(), d.getTime());
  assert.equal(dateZuFiletime(new Date(0)), 116444736000000000n);
  assert.equal(filetimeZuDate(0n), undefined);
  assert.equal(filetimeZuDate(-5n), undefined);
  assert.equal(dateZuFiletime(new Date(NaN)), 0n);
});

test('Deskriptor: Ordner, Pfade mit Backslash, Zeitstempel und 64-Bit-Groesse laufen durch parseRemoteFileList', () => {
  const t1 = new Date('2023-05-06T07:08:09.123Z'), t2 = new Date('2020-01-02T03:04:05.000Z');
  const liste = c.buildFileList([
    ordner('Projekt', t1), ordner('Projekt/Leer'), ordner('Projekt/Unter'),
    quelle('Projekt/Unter/gross.bin', 5 * GiB + 3, { lastWriteTime: t2 }), quelle('lose.txt', 0),
  ]);
  assert.equal(liste.length, 4 + 5 * 592);
  const d = (i: number) => 4 + i * 592;
  assert.equal(liste.readUInt32LE(d(0)), 0x4 | 0x20 | 0x4000);
  assert.equal(liste.readUInt32LE(d(0) + 36), 0x10);
  assert.equal(liste.readUInt32LE(d(1)), 0x4 | 0x4000); // ohne Zeit kein FD_WRITESTIME
  assert.equal(liste.readUInt32LE(d(3)), 0x4 | 0x20 | 0x40 | 0x4000);
  assert.equal(liste.readUInt32LE(d(3) + 64), 1); // sizeHigh
  assert.equal(liste.readUInt32LE(d(3) + 68), (5 * GiB + 3) % 2 ** 32);
  assert.ok(liste.subarray(d(3) + 72, d(3) + 592).toString('utf16le').startsWith('Projekt\\Unter\\gross.bin\0'));
  assert.deepEqual(parseRemoteFileList(liste), [
    { name: 'Projekt', directory: true, size: 0, lastWriteTime: t1 },
    { name: 'Projekt/Leer', directory: true, size: 0 },
    { name: 'Projekt/Unter', directory: true, size: 0 },
    { name: 'Projekt/Unter/gross.bin', directory: false, size: 5 * GiB + 3, lastWriteTime: t2 },
    { name: 'lose.txt', directory: false, size: 0 },
  ]);
});

test('Deskriptor: Namen werden je Segment geprueft, Elternordner muessen davor stehen', () => {
  for (const name of ['a//b', '../x', 'a/./b', 'a\\b', 'a/b:c', 'ende.', 'a/ende ', '/abs', 'a/', ''])
    assert.throws(() => c.buildFileList([quelle(name, 1)]), Error, name);
  assert.throws(() => c.buildFileList([quelle('d/f', 1), ordner('d')]), /Elternordner/);
  assert.throws(() => c.buildFileList([quelle('d/f', 1)]), /Elternordner/);
  assert.throws(() => c.buildFileList([ordner('D'), ordner('d')]), /Doppelter/);
  assert.throws(() => c.buildFileList([quelle('x', -1)]), /Dateigröße/);
  assert.throws(() => c.buildFileList(Array.from({ length: 4097 }, (_, i) => quelle(`f${i}`, 0))), /Zu viele/);
  assert.doesNotThrow(() => c.buildFileList([ordner('d'), quelle('d/f', 1)]));
  // Die einfache Form im Speicher bleibt gueltig.
  assert.equal(c.buildFileList([{ name: 'a.txt', data: Buffer.from('xyz') }]).readUInt32LE(4 + 68), 3);
});

// ---- Zum Server: SIZE/RANGE ----

function sitzung(serverFlags = 0x2e) {
  const gesendet: Buffer[] = [];
  const log: string[] = [];
  const s = new c.CliprdrSession({ send: (b) => gesendet.push(b), log: (m) => log.push(m) });
  s.verarbeite(c.buildClipboardCapabilities(serverFlags));
  s.verarbeite(c.buildMonitorReady());
  gesendet.length = 0;
  const antwort = async (stream: number, index: number, flags: number, offset: number, count: number) => {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(stream, 0); b.writeInt32LE(index, 4); b.writeUInt32LE(flags, 8);
    b.writeUInt32LE(offset % 2 ** 32, 12); b.writeUInt32LE(Math.floor(offset / 2 ** 32), 16); b.writeUInt32LE(count, 20);
    const vorher = gesendet.length;
    s.verarbeite(c.buildCliprdrPdu(c.CB_FILECONTENTS_REQUEST, 0, b));
    while (gesendet.length === vorher) await tick();
    const pdu = c.parseCliprdrPdu(gesendet[vorher]);
    assert.equal(pdu.msgType, c.CB_FILECONTENTS_RESPONSE);
    assert.equal(pdu.body.readUInt32LE(0), stream, 'streamId wird zurueckgegeben');
    return pdu;
  };
  return { s, gesendet, log, antwort };
}

test('SIZE und RANGE mit 64-Bit-Groesse und Offset ueber 4 GiB; cbRequested wird begrenzt', async () => {
  const gross = 6 * GiB + 100;
  const laengen: number[] = [];
  // Nur kleine Antworten werden wirklich erzeugt; bei grossen Anfragen zaehlt die angefragte Laenge.
  const q = quelle('gross.bin', gross, { read: async (o, l) => { laengen.push(l); return l > 4096 ? Buffer.alloc(l) : muster(o, l); } });
  const { s, antwort } = sitzung();
  assert.equal(s.meldeDateien([q], 10 * GiB), true);
  const size = await antwort(1, 0, 1, 0, 8);
  assert.equal(size.msgFlags, c.CB_RESPONSE_OK);
  assert.equal(size.body.readBigUInt64LE(4), BigInt(gross));
  const bereich = await antwort(2, 0, 2, 5 * GiB + 10, 64);
  assert.equal(bereich.msgFlags, c.CB_RESPONSE_OK);
  assert.ok(bereich.body.subarray(4).equals(muster(5 * GiB + 10, 64)));
  assert.equal(laengen.at(-1), 64);
  // Letzter Block wird auf den Rest gekuerzt, dahinter kommt eine leere Antwort.
  await antwort(3, 0, 2, gross - 10, 4096);
  assert.equal(laengen.at(-1), 10);
  const ende = await antwort(4, 0, 2, gross, 4096);
  assert.equal(ende.msgFlags, c.CB_RESPONSE_OK);
  assert.equal(ende.body.length, 4);
  // Genau 8 MiB werden voll geliefert, mehr wird abgelehnt statt still gekuerzt.
  const grenzAnfrage = await antwort(5, 0, 2, 0, c.MAX_DATEIANTWORT_BYTES);
  assert.equal(grenzAnfrage.msgFlags, c.CB_RESPONSE_OK);
  assert.equal(grenzAnfrage.body.length, 4 + c.MAX_DATEIANTWORT_BYTES);
  const zuGross = await antwort(6, 0, 2, 0, 0xffffffff);
  assert.equal(zuGross.msgFlags, c.CB_RESPONSE_FAIL);
  assert.equal(zuGross.body.readUInt32LE(0), 6);
});

test('Fehlerantworten: Offset hinter dem Ende, Ordner, falscher Index, Lesefehler, Kurzlesung, Lock-Laenge', async () => {
  const { s, gesendet, antwort } = sitzung();
  let modus: 'ok' | 'wirft' | 'kurz' = 'ok';
  const q = quelle('d/a.bin', 100, {
    read: async (o, l) => { if (modus === 'wirft') throw new Error('EIO'); return modus === 'kurz' ? Buffer.alloc(l - 1) : muster(o, l); },
  });
  assert.equal(s.meldeDateien([ordner('d'), q], 1000), true);
  const fail = (p: c.CliprdrPdu) => assert.equal(p.msgFlags, c.CB_RESPONSE_FAIL);
  fail(await antwort(1, 1, 2, 101, 8));
  fail(await antwort(2, 0, 2, 0, 8)); // Ordner
  fail(await antwort(3, 5, 2, 0, 8));
  fail(await antwort(4, -1, 2, 0, 8));
  fail(await antwort(5, 1, 1, 4, 8)); // SIZE mit Offset
  fail(await antwort(6, 1, 3, 0, 8));
  modus = 'wirft'; fail(await antwort(7, 1, 2, 0, 8));
  modus = 'kurz'; fail(await antwort(8, 1, 2, 0, 8));
  modus = 'ok';
  assert.equal((await antwort(9, 1, 2, 0, 8)).msgFlags, c.CB_RESPONSE_OK);
  // Mit ausgehandeltem Locking haengt der Server eine clipDataId an (28 Byte).
  const b = Buffer.alloc(28); b.writeUInt32LE(10, 0); b.writeUInt32LE(2, 8); b.writeInt32LE(1, 4); b.writeUInt32LE(4, 20);
  const vorher = gesendet.length;
  s.verarbeite(c.buildCliprdrPdu(c.CB_FILECONTENTS_REQUEST, 0, b));
  while (gesendet.length === vorher) await tick();
  assert.equal(c.parseCliprdrPdu(gesendet[vorher]).msgFlags, c.CB_RESPONSE_OK);
});

test('Dateien ueber 4 GiB werden nur angeboten, wenn der Server CB_HUGE_FILE_SUPPORT_ENABLED meldet', () => {
  const gross = quelle('gross.bin', 4 * GiB);
  assert.equal(sitzung(0x0e).s.meldeDateien([gross], 8 * GiB), false);
  assert.equal(sitzung(0x2e).s.meldeDateien([gross], 8 * GiB), true);
  assert.equal(sitzung(0x0e).s.meldeDateien([quelle('klein', 4 * GiB - 1)], 8 * GiB), true);
});

test('Gesamtgrenze zaehlt nur Dateien; Duplikate (ohne Gross-/Kleinschreibung) werden abgelehnt', () => {
  const { s } = sitzung();
  assert.equal(s.meldeDateien([ordner('d'), quelle('d/a', 10)], 9), false);
  assert.equal(s.meldeDateien([ordner('d'), quelle('d/a', 10)], 10), true);
  assert.equal(s.meldeDateien([quelle('a', 1), quelle('A', 1)], 100), false);
});

test('Ein neues Angebot verwirft laufende Lesungen: sie werden mit FAIL beantwortet, nicht vermischt', async () => {
  const { s, gesendet } = sitzung();
  let freigeben!: () => void;
  const warten = new Promise<void>((r) => { freigeben = r; });
  const alt = quelle('alt', 10, { read: async (o, l) => { await warten; return muster(o, l); } });
  s.meldeDateien([alt], 100);
  gesendet.length = 0;
  const b = Buffer.alloc(24); b.writeUInt32LE(11, 0); b.writeUInt32LE(2, 8); b.writeUInt32LE(4, 20);
  s.verarbeite(c.buildCliprdrPdu(c.CB_FILECONTENTS_REQUEST, 0, b));
  await tick();
  s.melde('anderer Text'); // neue Revision
  freigeben();
  await tick(); await tick();
  const antworten = gesendet.map((g) => c.parseCliprdrPdu(g)).filter((p) => p.msgType === c.CB_FILECONTENTS_RESPONSE);
  assert.equal(antworten.length, 1);
  assert.equal(antworten[0].msgFlags, c.CB_RESPONSE_FAIL);
  assert.equal(antworten[0].body.readUInt32LE(0), 11);
});

test('Mehrere Anfragen hintereinander werden in Reihenfolge und mit der jeweils eigenen streamId beantwortet', async () => {
  const { s, gesendet } = sitzung();
  s.meldeDateien([quelle('a', 100)], 1000);
  gesendet.length = 0;
  for (const [id, offset] of [[21, 0], [22, 50], [23, 10]]) {
    const b = Buffer.alloc(24); b.writeUInt32LE(id, 0); b.writeUInt32LE(2, 8); b.writeUInt32LE(offset, 12); b.writeUInt32LE(5, 20);
    s.verarbeite(c.buildCliprdrPdu(c.CB_FILECONTENTS_REQUEST, 0, b));
  }
  while (gesendet.length < 3) await tick();
  const p = gesendet.map((g) => c.parseCliprdrPdu(g));
  assert.deepEqual(p.map((x) => x.body.readUInt32LE(0)), [21, 22, 23]);
  assert.ok(p[1].body.subarray(4).equals(muster(50, 5)));
  assert.ok(p[2].body.subarray(4).equals(muster(10, 5)));
});

test('LOCK_CLIPDATA und UNLOCK_CLIPDATA vom Server sind kein Fehler', async () => {
  const { s, gesendet, log } = sitzung();
  s.verarbeite(c.buildCliprdrPdu(c.CB_LOCK_CLIPDATA, 0, Buffer.alloc(4, 1)));
  s.verarbeite(c.buildCliprdrPdu(c.CB_UNLOCK_CLIPDATA, 0, Buffer.alloc(4, 1)));
  await tick();
  assert.equal(gesendet.length, 0);
  assert.ok(!log.some((l) => /nicht behandelt|Fehler/.test(l)));
});

// ---- Vom Server: Senke ----

function manifest(eintraege: { name: string; size?: number; directory?: boolean; time?: Date }[]): Buffer {
  return c.buildFileList(eintraege.map((e) => e.directory ? ordner(e.name, e.time) : quelle(e.name, e.size ?? 0, { lastWriteTime: e.time })));
}

/** Gemeinsamer Nullpuffer: grosse Dateien kosten so keinen Speicher. */
const NULLEN = Buffer.alloc(1 << 20);
type Anfrage = { offset: number; count: number };

/** Server, der Bytes aus `muster` liefert. `kuerzen` begrenzt die Antworten, `eingriff` laeuft vor jeder. */
function empfaenger(
  liste: Buffer, max: number,
  opts: { signal?: AbortSignal; kuerzen?: number; anfragen?: Anfrage[]; leer?: boolean } = {},
  eingriff?: () => void,
) {
  let id = 0;
  const r: ClipboardDownload = new ClipboardDownload((body) => {
    const stream = body.readUInt32LE(0), flags = body.readUInt32LE(8);
    if (flags !== 2) return;
    const offset = body.readUInt32LE(12) + body.readUInt32LE(16) * 2 ** 32;
    const count = body.readUInt32LE(20);
    opts.anfragen?.push({ offset, count });
    const n = Math.min(count, opts.kuerzen ?? count);
    queueMicrotask(() => { eingriff?.(); const data = opts.leer ? NULLEN.subarray(0, n) : muster(offset, n); r.receive(data, true, n, stream); });
  }, () => ++id, max, opts.signal, 2000);
  const stream = (sink: ClipboardSink) => r.stream(() => queueMicrotask(() => r.receive(liste, true, liste.length)), sink);
  return { r, stream };
}

function aufzeichnung() {
  const ereignisse: string[] = [];
  const dateien = new Map<string, { bytes: number; hash: ReturnType<typeof createHash>; geschlossen?: Error | 'ok' }>();
  const zeit = (e: RemoteClipboardEntry) => e.lastWriteTime ? ` @${e.lastWriteTime.toISOString()}` : '';
  const sink: ClipboardSink = {
    directory: (e) => { ereignisse.push(`dir ${e.name}${zeit(e)}`); },
    file: (e): ClipboardFileWriter => {
      const f: { bytes: number; hash: ReturnType<typeof createHash>; geschlossen?: Error | 'ok' } = { bytes: 0, hash: createHash('sha256') };
      dateien.set(e.name, f); ereignisse.push(`file ${e.name}${zeit(e)}`);
      return { write: (chunk) => { f.bytes += chunk.length; f.hash.update(chunk); }, close: (err) => { f.geschlossen = err ?? 'ok'; } };
    },
  };
  return { sink, ereignisse, dateien };
}

test('Download: die Senke bekommt Ordner, Dateien und Zeitstempel in Listenreihenfolge', async () => {
  const t = new Date('2022-03-04T05:06:07.000Z');
  const a = aufzeichnung();
  const { stream } = empfaenger(manifest([
    { name: 'Ordner', directory: true, time: t }, { name: 'Ordner/a.txt', size: 5, time: t },
    { name: 'Ordner/Leer', directory: true }, { name: 'null', size: 0 },
  ]), 100);
  await stream(a.sink);
  assert.deepEqual(a.ereignisse, [
    `dir Ordner @${t.toISOString()}`, `file Ordner/a.txt @${t.toISOString()}`, 'dir Ordner/Leer', 'file null',
  ]);
  assert.equal(a.dateien.get('Ordner/a.txt')!.bytes, 5);
  assert.equal(a.dateien.get('null')!.geschlossen, 'ok');
});

test('Download: 70-MiB-Datei wird in Bloecken von hoechstens 1 MiB gestreamt (Hash statt Puffer)', async () => {
  const groesse = 70 * 1024 * 1024 + 123;
  const a = aufzeichnung(); const anfragen: Anfrage[] = [];
  const { stream } = empfaenger(manifest([{ name: 'gross.bin', size: groesse }]), groesse, { anfragen });
  await stream(a.sink);
  const soll = createHash('sha256');
  for (let o = 0; o < groesse; o += 1 << 20) soll.update(muster(o, Math.min(1 << 20, groesse - o)));
  const f = a.dateien.get('gross.bin')!;
  assert.equal(f.bytes, groesse);
  assert.equal(f.hash.digest('hex'), soll.digest('hex'));
  assert.ok(anfragen.every((x) => x.count <= 1 << 20));
  assert.equal(anfragen.length, 71);
});

test('Download: Datei ueber 4 GiB mit 64-Bit-Offsets; kurze Antworten werden fortgesetzt', async () => {
  const groesse = 4 * GiB + 7;
  const anfragen: Anfrage[] = [];
  const a = aufzeichnung();
  await empfaenger(manifest([{ name: 'riesig.bin', size: groesse }]), 5 * GiB, { anfragen, leer: true }).stream(a.sink);
  assert.equal(a.dateien.get('riesig.bin')!.bytes, groesse);
  assert.ok(anfragen.some((x) => x.offset >= 2 ** 32), 'Offset ueber 4 GiB wurde angefragt');
  assert.equal(anfragen.at(-1)!.offset + anfragen.at(-1)!.count, groesse);
  const b = aufzeichnung();
  await empfaenger(manifest([{ name: 'k', size: 350_000 }]), 1e6, { kuerzen: 100_000 }).stream(b.sink);
  assert.equal(b.dateien.get('k')!.bytes, 350_000);
});

test('Download: die Gesamtgrenze greift vor dem ersten Inhaltsabruf; es gibt keine feste Obergrenze mehr', async () => {
  const a = aufzeichnung();
  const { stream } = empfaenger(manifest([{ name: 'a', size: 6 * GiB }, { name: 'b', size: 6 * GiB }]), 10 * GiB, {
    anfragen: { push: () => assert.fail('kein Inhaltsabruf') } as unknown as Anfrage[],
  });
  await assert.rejects(stream(a.sink), /Größenbegrenzung/);
  assert.deepEqual(a.ereignisse, []);
  // 300 MiB unter einer 400-MiB-Grenze (frueher auf 256 MiB gedeckelt) sind zulaessig.
  const b = aufzeichnung();
  await empfaenger(manifest([{ name: 'x', size: 300 * 1024 * 1024 }]), 400 * 1024 * 1024, { leer: true }).stream(b.sink);
  assert.equal(b.dateien.get('x')!.bytes, 300 * 1024 * 1024);
});

test('Download: Abbruch mitten im Stream schliesst den Schreiber mit Fehler und beendet den Lauf', async () => {
  const controller = new AbortController();
  const a = aufzeichnung(); let n = 0;
  const { stream } = empfaenger(manifest([{ name: 'Ordner', directory: true }, { name: 'Ordner/x.bin', size: 5 << 20 }]), 1e9,
    { signal: controller.signal }, () => { if (++n === 2) controller.abort(); });
  await assert.rejects(stream(a.sink), /abgebrochen/);
  const f = a.dateien.get('Ordner/x.bin')!;
  assert.ok(f.geschlossen instanceof Error);
  assert.ok(f.bytes < 5 << 20);
});

test('Download: Schreibfehler der Senke bricht ab und raeumt den Schreiber auf', async () => {
  let geschlossen: Error | undefined;
  const sink: ClipboardSink = {
    directory: () => {},
    file: () => ({ write: () => { throw new Error('Platte voll'); }, close: (e) => { geschlossen = e; } }),
  };
  await assert.rejects(empfaenger(manifest([{ name: 'a', size: 10 }]), 100).stream(sink), /Platte voll/);
  assert.equal(geschlossen?.message, 'Platte voll');
});

test('Download ueber die Sitzung: streamServerFiles liefert Ordner und Zeitstempel; downloadServerFiles bleibt kompatibel', async () => {
  const t = new Date('2021-07-08T09:10:11.000Z');
  const liste = manifest([{ name: 'D', directory: true, time: t }, { name: 'D/f', size: 3000, time: t }]);
  const bauen = () => {
    const s: c.CliprdrSession = new c.CliprdrSession({ send: (bytes) => {
      const pdu = c.parseCliprdrPdu(bytes);
      if (pdu.msgType === c.CB_FORMAT_DATA_REQUEST) queueMicrotask(() => s.verarbeite(c.buildFormatDataResponse(liste)));
      if (pdu.msgType === c.CB_FILECONTENTS_REQUEST) {
        const o = pdu.body.readUInt32LE(12), n = pdu.body.readUInt32LE(20);
        queueMicrotask(() => s.verarbeite(c.buildCliprdrPdu(c.CB_FILECONTENTS_RESPONSE, c.CB_RESPONSE_OK, Buffer.concat([pdu.body.subarray(0, 4), muster(o, n)]))));
      }
    } });
    s.verarbeite(c.buildClipboardCapabilities(0x2e)); s.verarbeite(c.buildMonitorReady());
    s.verarbeite(c.buildFormatList([{ formatId: 0xd123, name: 'FileGroupDescriptorW' }], { longFormatNames: true }));
    return s;
  };
  const a = aufzeichnung();
  await bauen().streamServerFiles(a.sink, 10_000);
  assert.deepEqual(a.ereignisse, [`dir D @${t.toISOString()}`, `file D/f @${t.toISOString()}`]);
  const speicher = await bauen().downloadServerFiles(10_000);
  assert.equal(speicher[1].data.length, 3000);
  assert.equal(speicher[1].lastWriteTime?.getTime(), t.getTime());
});
