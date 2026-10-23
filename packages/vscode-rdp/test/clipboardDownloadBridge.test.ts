import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cliprdr } from 'ts-rdp';
import { Zwischenablagebruecke } from '../src/zwischenablage.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function descriptor(): Buffer {
  const data = Buffer.alloc(596); data.writeUInt32LE(1); data.writeUInt32LE(0x44, 4);
  data.writeUInt32LE(0x80, 40); data.writeUInt32LE(3, 72); data.write('a.txt', 76, 'utf16le'); return data;
}
test('Remote file copy uses the receiver and does not echo the native clipboard empty text', async () => {
  const sent: cliprdr.CliprdrPdu[] = [];
  let local = 'before', complete!: () => void;
  const done = new Promise<void>(resolve => complete = resolve);
  const bridge = new Zwischenablagebruecke({
    einstellungen: { aktiv: true, richtung: 'beide', maxBytes: 1024, abfrageIntervallMs: 0 },
    speicher: { lesen: async () => local, schreiben: async () => {} }, anWebview: () => {}, log: () => {},
    send: data => {
      const p = cliprdr.parseCliprdrPdu(data); sent.push(p);
      if (p.msgType === cliprdr.CB_FORMAT_DATA_REQUEST) queueMicrotask(() => bridge.verarbeite(cliprdr.buildFormatDataResponse(descriptor())));
      if (p.msgType === cliprdr.CB_FILECONTENTS_REQUEST) queueMicrotask(() => bridge.verarbeite(cliprdr.buildCliprdrPdu(cliprdr.CB_FILECONTENTS_RESPONSE, cliprdr.CB_RESPONSE_OK, Buffer.concat([p.body.subarray(0, 4), Buffer.from('abc')]))));
    },
    dateien: { maxBytes: 100, empfangen: async load => { const files = await load(); assert.equal(files[0].data.toString(), 'abc'); local = ''; complete(); } },
  });
  try {
    bridge.verarbeite(cliprdr.buildClipboardCapabilities(cliprdr.CB_USE_LONG_FORMAT_NAMES | cliprdr.CB_STREAM_FILECLIP_ENABLED));
    bridge.verarbeite(cliprdr.buildMonitorReady()); await tick();
    const before = sent.filter(p => p.msgType === cliprdr.CB_FORMAT_LIST).length;
    bridge.verarbeite(cliprdr.buildFormatList([{ formatId: 123, name: 'FileGroupDescriptorW' }], { longFormatNames: true }));
    await done; await tick();
    assert.equal(await bridge.pruefeLokal(), false);
    assert.equal(sent.filter(p => p.msgType === cliprdr.CB_FORMAT_LIST).length, before);
  } finally { bridge.dispose(); }
});
test('Closing the session aborts an outstanding file receiver', async () => {
  let signal: AbortSignal | undefined;
  const bridge = new Zwischenablagebruecke({
    einstellungen: { aktiv: true, richtung: 'nurLesen', maxBytes: 1024, abfrageIntervallMs: 0 },
    speicher: { lesen: async () => '', schreiben: async () => {} }, anWebview: () => {}, log: () => {}, send: () => {},
    dateien: { maxBytes: 100, empfangen: async (load, value) => { signal = value; await load(); } },
  });
  bridge.verarbeite(cliprdr.buildClipboardCapabilities(cliprdr.CB_USE_LONG_FORMAT_NAMES | cliprdr.CB_STREAM_FILECLIP_ENABLED));
  bridge.verarbeite(cliprdr.buildMonitorReady());
  bridge.verarbeite(cliprdr.buildFormatList([{ formatId: 123, name: 'FileGroupDescriptorW' }], { longFormatNames: true }));
  await tick(); assert.equal(signal?.aborted, false);
  bridge.dispose(); assert.equal(signal?.aborted, true); await tick();
});
