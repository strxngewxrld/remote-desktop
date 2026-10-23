import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacFileClipboard } from '../src/macFileClipboard.js';

test('Finder clipboard receives staged file URLs with exact bytes and nested empty directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdp-clipboard-test-'));
  try {
    let paths: string[] = [];
    const mac = new MacFileClipboard(async args => {
      if (args[0] === 'snapshot') return '17';
      assert.equal(args[1], '17'); paths = JSON.parse(args[2]); return 'written';
    }, root);
    await mac.receive(async () => [
      { name: 'Grüße/a.bin', directory: false, data: Buffer.from([0, 1, 255]) },
      { name: 'Grüße/Leer', directory: true, data: Buffer.alloc(0) },
      { name: "quote'$(no-shell).txt", directory: false, data: Buffer.alloc(0) },
    ], new AbortController().signal);
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
      await assert.rejects(mac.receive(async () => {
        if (failure === 'aborted') controller.abort();
        return [{ name: failure === 'unsafe' ? '../outside' : 'a', directory: false, data: Buffer.from('a') }];
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
    let complete!: (value: typeof entry[]) => void;
    const delayed = new Promise<typeof entry[]>(resolve => complete = resolve);
    const names: string[][] = [];
    const mac = new MacFileClipboard(async args => { if (args[0] === 'snapshot') return '1'; names.push(JSON.parse(args[2])); return 'written'; }, root);
    const old = mac.receive(() => delayed, new AbortController().signal);
    await mac.receive(async () => [{ name: 'new', directory: false, data: Buffer.from('new') }], new AbortController().signal);
    const rejection = assert.rejects(old, /neuerer/); complete([entry]); await rejection;
    assert.equal(names.length, 1); assert.ok(names[0][0].endsWith('/new'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
