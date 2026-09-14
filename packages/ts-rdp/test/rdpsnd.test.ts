import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { silentAudioReplies } from '../src/protocol/rdpsnd.js';

test('Silent RDPSND announces no formats or UDP, and sends required quality PDU', () => {
  const server = Buffer.alloc(42);
  server[0] = 7;
  server.writeUInt16LE(38, 2);
  server.writeUInt16LE(1, 18);
  server.writeUInt16LE(8, 21);
  const [formats, quality] = silentAudioReplies(server);
  assert.equal(formats!.length, 24);
  assert.equal(formats!.readUInt16LE(18), 0);
  assert.equal(formats!.readUInt16BE(16), 0);
  assert.equal(formats!.readUInt16LE(21), 6);
  assert.equal(quality!.toString('hex'), '0c00040002000000');
  server.writeUInt16LE(5, 21);
  assert.equal(silentAudioReplies(server).length, 1);
});

test('Silent RDPSND validates format lengths and acknowledges training without payload', () => {
  for (const hex of ['', '07000000', '07001400', '06000000']) {
    assert.throws(() => silentAudioReplies(Buffer.from(hex, 'hex')));
  }
  const malformed = Buffer.alloc(24);
  malformed[0] = 7;
  malformed.writeUInt16LE(20, 2);
  malformed.writeUInt16LE(1, 18);
  assert.throws(() => silentAudioReplies(malformed));
  assert.deepEqual(silentAudioReplies(Buffer.from('0600060034120600ffff', 'hex')), [Buffer.from('0600040034120600', 'hex')]);
  assert.deepEqual(silentAudioReplies(Buffer.from('02000000', 'hex')), []);
});
