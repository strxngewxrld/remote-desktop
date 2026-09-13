import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RdpClient } from '../src/client.js';
import { ChannelReassembler, buildChannelChunks } from '../src/protocol/virtualChannel.js';
import { buildDataFirst, buildData } from '../src/protocol/dvc.js';

test('Static channel enforces actual length, sequence and resets after rejection', () => {
  const r = new ChannelReassembler(4);
  assert.throws(() => r.push({ totalLength: 4, flags: 2, data: Buffer.from('ab') }));
  r.push({ totalLength: 4, flags: 1, data: Buffer.from('abc') });
  assert.throws(() => r.push({ totalLength: 4, flags: 2, data: Buffer.from('de') }));
  assert.throws(() => r.push({ totalLength: 4, flags: 3, data: Buffer.from('abc') }));
  assert.equal(r.push({ totalLength: 2, flags: 3, data: Buffer.from('ok') })?.toString(), 'ok');
  for (const size of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => buildChannelChunks(Buffer.from('data'), size));
});

test('Dynamic channels reject oversized streams and ignore unopened channel IDs', () => {
  const client = new RdpClient({ host: 'unused' });
  const internal = client as any;
  const send = (pdu: Buffer) => { for (const chunk of buildChannelChunks(pdu)) internal.handleDynvc(chunk); };
  send(buildDataFirst(99, 4, Buffer.from('ab')));
  assert.equal(internal.dynamicFragments.size, 0);
  internal.dynamicChannels.set(1, 'test');
  assert.throws(() => send(buildDataFirst(1, 0xffffffff, Buffer.from('ab'))));
  send(buildDataFirst(1, 3, Buffer.from('ab')));
  assert.throws(() => send(buildData(1, Buffer.from('cd'))));
  assert.equal(internal.dynamicFragments.size, 0);
  const received: string[] = [];
  client.on('dynamicChannelData', e => received.push(e.data.toString()));
  send(buildDataFirst(1, 4, Buffer.from('ab')));
  send(buildData(1, Buffer.from('cd')));
  assert.deepEqual(received, ['abcd']);
  client.disconnect();
});

test('Fastpath FIRST replaces an abandoned update and orphan LAST is rejected', () => {
  const client = new RdpClient({ host: 'unused' });
  const internal = client as any;
  const received: string[] = [];
  internal.handleFastpathUpdate = (_code: number, r: any) => received.push(r.rest().toString());
  const send = (fragment: number, text: string) => {
    const data = Buffer.from(text);
    const header = Buffer.alloc(3);
    header[0] = fragment << 4;
    header.writeUInt16LE(data.length, 1);
    internal.handleFastpath({ flags: 0, payload: Buffer.concat([header, data]) });
  };
  assert.throws(() => send(1, 'orphan'));
  send(2, 'old');
  send(2, 'new');
  send(1, 'end');
  assert.deepEqual(received, ['newend']);
  client.disconnect();
});
