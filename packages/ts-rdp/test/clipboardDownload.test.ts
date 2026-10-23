import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ClipboardDownload, parseRemoteFileList } from '../src/protocol/clipboardDownload.js';
import * as clip from '../src/protocol/cliprdr.js';

function manifest(entries: { name: string; size?: number; directory?: boolean; attributes?: number }[]): Buffer {
  const b = Buffer.alloc(4 + entries.length * 592); b.writeUInt32LE(entries.length);
  entries.forEach((e, i) => {
    const p = 4 + i * 592;
    b.writeUInt32LE(4 | (e.size === undefined ? 0 : 0x40), p);
    b.writeUInt32LE(e.attributes ?? (e.directory ? 0x10 : 0x80), p + 36);
    b.writeUInt32LE(e.size ?? 0, p + 68); b.write(e.name, p + 72, 518, 'utf16le');
  }); return b;
}

test('File descriptors preserve Unicode, nested paths, empty folders and zero-byte files', () => {
  assert.deepEqual(parseRemoteFileList(manifest([{ name: 'Ordner', directory: true }, { name: 'Ordner\\Grüße.txt', size: 3 }, { name: 'Leer', directory: true }, { name: 'zero', size: 0 }])), [
    { name: 'Ordner', directory: true, size: 0 }, { name: 'Ordner/Grüße.txt', directory: false, size: 3 }, { name: 'Leer', directory: true, size: 0 }, { name: 'zero', directory: false, size: 0 },
  ]);
});
for (const name of ['..\\x', 'a\\..\\x', '/etc/passwd', 'C:\\temp\\x', '\\\\server\\share', 'a:b', 'a\\', 'CON.txt', 'a.']) {
  test(`Reject unsafe remote path: ${name}`, () => assert.throws(() => parseRemoteFileList(manifest([{ name, size: 0 }]))));
}
test('Reject duplicate and conflicting paths, reparse points and truncated metadata', () => {
  for (const entries of [[{ name: 'x' }, { name: 'X' }], [{ name: 'a' }, { name: 'a\\b' }], [{ name: 'link', attributes: 0x400 }], [{ name: 'A/x' }, { name: 'a/y' }]])
    assert.throws(() => parseRemoteFileList(manifest(entries)));
  assert.throws(() => parseRemoteFileList(Buffer.from([255, 255, 255, 255])));
  assert.throws(() => parseRemoteFileList(manifest([{ name: 'a' }]).subarray(0, -1)));
});

test('Download negotiates server format ID and streams nested files in bounded ranges', async () => {
  const sent: clip.CliprdrPdu[] = [];
  const content = Buffer.alloc(150000); for (let i = 0; i < content.length; i++) content[i] = i % 251;
  const session = new clip.CliprdrSession({ send: bytes => {
    const pdu = clip.parseCliprdrPdu(bytes); sent.push(pdu);
    if (pdu.msgType === clip.CB_FORMAT_DATA_REQUEST) {
      assert.equal(pdu.body.readUInt32LE(), 0xd123);
      queueMicrotask(() => session.verarbeite(clip.buildFormatDataResponse(manifest([{ name: 'tree', directory: true }, { name: 'tree\\data.bin', size: content.length }, { name: 'tree\\empty', directory: true }, { name: 'zero', size: 0 }]))));
    }
    if (pdu.msgType === clip.CB_FILECONTENTS_REQUEST) {
      assert.equal(pdu.body.length, 24); assert.equal(pdu.body.readUInt32LE(4), 1);
      assert.equal(pdu.body.readUInt32LE(8), 2); assert.equal(pdu.body.readUInt32LE(16), 0);
      const offset = pdu.body.readUInt32LE(12), count = pdu.body.readUInt32LE(20); assert.ok(count <= 65536);
      queueMicrotask(() => session.verarbeite(clip.buildCliprdrPdu(clip.CB_FILECONTENTS_RESPONSE, clip.CB_RESPONSE_OK, Buffer.concat([pdu.body.subarray(0, 4), content.subarray(offset, offset + count)]))));
    }
  } });
  session.verarbeite(clip.buildClipboardCapabilities(clip.CB_USE_LONG_FORMAT_NAMES | clip.CB_STREAM_FILECLIP_ENABLED));
  session.verarbeite(clip.buildMonitorReady());
  session.verarbeite(clip.buildFormatList([{ formatId: 0xd123, name: 'FileGroupDescriptorW' }], { longFormatNames: true }));
  const result = await session.downloadServerFiles(content.length);
  assert.deepEqual(result[1].data, content); assert.equal(result[2].directory, true); assert.equal(result[3].data.length, 0);
  assert.equal(sent.filter(p => p.msgType === clip.CB_FILECONTENTS_REQUEST).length, 3);
});

function receiver(entries: Parameters<typeof manifest>[0], handle: (r: ClipboardDownload, request: Buffer) => void, max = 100, signal?: AbortSignal) {
  let id = 0;
  const r = new ClipboardDownload(body => handle(r, body), () => ++id, max, signal, 20);
  const run = () => r.run(() => queueMicrotask(() => { const data = manifest(entries); r.receive(data, true, data.length); }));
  return { r, run };
}
test('Unknown file sizes are queried before content and included in the total limit', async () => {
  const flags: number[] = [];
  const { run } = receiver([{ name: 'x' }], (r, body) => {
    const flag = body.readUInt32LE(8); flags.push(flag);
    const data = flag === 1 ? Buffer.from('0300000000000000', 'hex') : Buffer.from('abc');
    r.receive(data, true, data.length, body.readUInt32LE());
  });
  assert.equal((await run())[0].data.toString(), 'abc'); assert.deepEqual(flags, [1, 2]);
});
test('Aggregate size limit is checked before fetching content', async () => {
  const { run } = receiver([{ name: 'a', size: 60 }, { name: 'b', size: 60 }], () => assert.fail('Must not fetch content'));
  await assert.rejects(run(), /Größenbegrenzung/);
});
for (const kind of ['failed', 'oversized', 'truncated', 'eof', 'wrong-stream'] as const) {
  test(`Fail closed on ${kind} file response`, async () => {
    const { run } = receiver([{ name: 'x', size: 3 }], (r, body) => {
      const data = Buffer.alloc(kind === 'oversized' ? 4 : kind === 'eof' ? 0 : 3);
      r.receive(data, kind !== 'failed', kind === 'truncated' ? 99 : data.length, body.readUInt32LE() + (kind === 'wrong-stream' ? 1 : 0));
    });
    await assert.rejects(run());
  });
}
test('Cancellation and disconnect settle a pending transfer', async () => {
  const controller = new AbortController();
  const { run } = receiver([{ name: 'x', size: 3 }], () => controller.abort(), 100, controller.signal);
  await assert.rejects(run(), /abgebrochen/);
  const pending = new ClipboardDownload(() => {}, () => 1, 100);
  const task = pending.run(() => {}); pending.cancel(new Error('Disconnected')); await assert.rejects(task, /Disconnected/);
});
test('Clipboard replacement cancels the old manifest; disabled receiving never requests files', async () => {
  const session = new clip.CliprdrSession({ send: () => {} });
  session.verarbeite(clip.buildClipboardCapabilities(clip.CB_USE_LONG_FORMAT_NAMES | clip.CB_STREAM_FILECLIP_ENABLED));
  session.verarbeite(clip.buildMonitorReady());
  const formats = clip.buildFormatList([{ formatId: 99, name: 'FileGroupDescriptorW' }], { longFormatNames: true });
  session.verarbeite(formats);
  const task = session.downloadServerFiles(); session.verarbeite(formats);
  await assert.rejects(task, /geändert/);
  const disabled = new clip.CliprdrSession({ send: () => {}, richtung: 'nurSchreiben' });
  disabled.verarbeite(clip.buildMonitorReady()); disabled.verarbeite(formats);
  await assert.rejects(disabled.downloadServerFiles(), /Keine Remote-Dateien/);
});
