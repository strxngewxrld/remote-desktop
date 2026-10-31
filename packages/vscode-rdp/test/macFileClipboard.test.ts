import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import type { ClipboardSink } from 'ts-rdp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacFileClipboard } from '../src/macFileClipboard.js';

type Eintrag = { name: string; directory: boolean; data: Buffer; lastWriteTime?: Date };
/** Spielt Eintraege wie der Download in die Senke - Dateiinhalt in zwei Bloecken. */
async function fuettere(sink: ClipboardSink, eintraege: Eintrag[], mitten?: () => void): Promise<void> {
  for (const e of eintraege) {
    if (e.directory) { await sink.directory({ name: e.name, directory: true, size: 0, lastWriteTime: e.lastWriteTime }); continue; }
    const writer = await sink.file({ name: e.name, directory: false, size: e.data.length, lastWriteTime: e.lastWriteTime });
    try {
      const half = Math.ceil(e.data.length / 2);
      for (const part of [e.data.subarray(0, half), e.data.subarray(half)]) {
        if (part.length) await writer.write(part);
        mitten?.();
      }
    } catch (error) { await writer.close(error as Error); throw error; }
    await writer.close();
  }
}
const laden = (eintraege: Eintrag[], mitten?: () => void) => (sink: ClipboardSink) => fuettere(sink, eintraege, mitten);

test('Finder clipboard receives staged file URLs with exact bytes and nested empty directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
  try {
    let paths: string[] = [];
    const mac = new MacFileClipboard(async args => {
      if (args[0] === 'snapshot') return '17';
      assert.equal(args[1], '17'); paths = JSON.parse(args[2]); return 'written';
    }, root);
    await mac.receive(laden([
      { name: 'Grüße/a.bin', directory: false, data: Buffer.from([0, 1, 255]) },
      { name: 'Grüße/Leer', directory: true, data: Buffer.alloc(0) },
      { name: "quote'$(no-shell).txt", directory: false, data: Buffer.alloc(0) },
    ]), new AbortController().signal);
    assert.equal(paths.length, 2);
    assert.deepEqual(await readFile(join(paths[0], 'a.bin')), Buffer.from([0, 1, 255]));
    assert.ok((await stat(join(paths[0], 'Leer'))).isDirectory());
    if (process.platform !== 'win32') assert.equal((await stat(join(paths[0], 'a.bin'))).mode & 0o777, 0o600);
    assert.equal((await readFile(paths[1])).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const failure of ['changed', 'aborted', 'unsafe'] as const) {
  test(`Do not publish or leave partial files after ${failure} transfer`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
    try {
      const controller = new AbortController(); let publications = 0;
      const mac = new MacFileClipboard(async args => { if (args[0] === 'snapshot') return '1'; publications++; return 'changed'; }, root);
      await assert.rejects(mac.receive(async sink => {
        if (failure === 'aborted') controller.abort();
        await fuettere(sink, [{ name: failure === 'unsafe' ? '../outside' : 'a', directory: false, data: Buffer.from('a') }]);
      }, controller.signal));
      assert.equal(publications, failure === 'changed' ? 1 : 0);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
test('A later session copy prevents an older download replacing the pasteboard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
  try {
    const entry = { name: 'old', directory: false, data: Buffer.alloc(0) };
    let complete!: () => void;
    const delayed = new Promise<void>(resolve => complete = resolve);
    const names: string[][] = [];
    const mac = new MacFileClipboard(async args => { if (args[0] === 'snapshot') return '1'; names.push(JSON.parse(args[2])); return 'written'; }, root);
    const old = mac.receive(async sink => { await delayed; await fuettere(sink, [entry]); }, new AbortController().signal);
    await mac.receive(laden([{ name: 'new', directory: false, data: Buffer.from('new') }]), new AbortController().signal);
    const rejection = assert.rejects(old, /neuerer/); complete(); await rejection;
    assert.equal(names.length, 1); assert.ok(names[0][0].endsWith('/new'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Dateien werden blockweise geschrieben, mtime gesetzt (auch bei Ordnern nach den Kindern)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
  try {
    let paths: string[] = [];
    const mac = new MacFileClipboard(async args => { if (args[0] === 'snapshot') return '3'; paths = JSON.parse(args[2]); return 'written'; }, root);
    const dateiZeit = new Date('2019-04-05T06:07:08.000Z'), ordnerZeit = new Date('2018-01-02T03:04:05.000Z');
    await mac.receive(laden([
      { name: 'D', directory: true, data: Buffer.alloc(0), lastWriteTime: ordnerZeit },
      { name: 'D/inner', directory: true, data: Buffer.alloc(0), lastWriteTime: ordnerZeit },
      { name: 'D/inner/f.bin', directory: false, data: Buffer.from('abcdef'), lastWriteTime: dateiZeit },
      { name: 'D/ohneZeit.txt', directory: false, data: Buffer.from('x') },
    ]), new AbortController().signal);
    assert.equal(paths.length, 1);
    assert.equal((await readFile(join(paths[0], 'inner', 'f.bin'))).toString(), 'abcdef');
    assert.equal((await stat(join(paths[0], 'inner', 'f.bin'))).mtime.getTime(), dateiZeit.getTime());
    assert.equal((await stat(paths[0])).mtime.getTime(), ordnerZeit.getTime());
    assert.equal((await stat(join(paths[0], 'inner'))).mtime.getTime(), ordnerZeit.getTime());
    if (process.platform !== 'win32') assert.equal((await stat(paths[0])).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Abbruch mitten in einer grossen Datei entfernt Teildateien und Ordner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
  try {
    const controller = new AbortController(); let blocks = 0;
    const mac = new MacFileClipboard(async args => { if (args[0] === 'snapshot') return '1'; throw new Error('darf nicht veroeffentlichen'); }, root);
    await assert.rejects(mac.receive(laden([
      { name: 'D', directory: true, data: Buffer.alloc(0) }, { name: 'D/gross.bin', directory: false, data: Buffer.alloc(100) },
    ], () => { if (++blocks === 1) controller.abort(); }), controller.signal));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Ohne Dateien wird nichts veroeffentlicht; localPaths liest die JSON-Liste des Skripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
  try {
    const mac = new MacFileClipboard(async args => args[0] === 'list' ? JSON.stringify(['/a/b', 7, 'relativ', '/c/d']) : '1', root);
    await assert.rejects(mac.receive(async () => {}, new AbortController().signal), /Keine Dateien/);
    assert.deepEqual(await mac.localPaths(), ['/a/b', '/c/d']);
    assert.deepEqual(await new MacFileClipboard(async () => '', root).localPaths(), []);
    await assert.rejects(new MacFileClipboard(async () => '{}', root).localPaths());
  } finally { await rm(root, { recursive: true, force: true }); }
});
