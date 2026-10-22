import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderNotices } from '../notices.mjs';

test('Notices include the full first-party license without listing build tools', async () => {
  const text = await renderNotices({ inputs: {} });
  assert.match(text, /First-party: ts-rdp/);
  assert.match(text, /Permission is hereby granted/);
  assert.match(text, /No third-party npm runtime/);
  assert.doesNotMatch(text, /##.*(?:esbuild|typescript|vsce)/);
  const german = await renderNotices({ inputs: {} }, 'de-AT');
  assert.match(german, /Lizenzhinweise zu enthaltenen Paketen/);
  assert.match(german, /keine npm-Laufzeitpakete von Drittanbietern/);
  assert.equal(german.split('MIT License')[1]?.split('SOFTWARE.')[0], text.split('MIT License')[1]?.split('SOFTWARE.')[0], 'Original license text must remain unchanged');
});

test('Notices use actual bundle inputs, deduplicate package files and reject missing licenses', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rdp-notices-'));
  const directory = join(temporary, 'node_modules', '@example', 'runtime');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@example/runtime', version: '2.0.0', license: 'MIT' }));
    const meta = { inputs: { [join(directory, 'index.js')]: {}, [join(directory, 'lib.js')]: {} } };
    await assert.rejects(renderNotices(meta), /No license text/);
    await writeFile(join(directory, 'LICENSE'), 'Complete runtime license\r\nCopyright example\r\n');
    const text = await renderNotices(meta);
    assert.equal(text.match(/## @example\/runtime 2.0.0/g)?.length, 1);
    assert.match(text, /Complete runtime license\nCopyright example/);
    assert.equal(text.includes('\r'), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
