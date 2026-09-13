import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as net from 'node:net';
import { RdpTransport, tpktRaw } from '../src/protocol/transport.js';
import { readElement, elementLength, children } from '../src/asn1/der.js';

test('DER rejects truncated and signed-overflow lengths without moving backwards', () => {
  for (const hex of ['3084ffffffff', '308480000000', '308201', '3080', '30850102030405']) {
    assert.throws(() => readElement(Buffer.from(hex, 'hex')));
    assert.throws(() => [...children(Buffer.from(hex, 'hex'))]);
  }
  assert.equal(elementLength(Buffer.from('3084ffffffff', 'hex')), -1);
  assert.equal(elementLength(Buffer.from('308201', 'hex')), -1);
  assert.throws(() => elementLength(Buffer.from('3080', 'hex')));
});

test('Closing transport rejects an active read immediately', async () => {
  const transport = new RdpTransport({ host: 'localhost', port: 1 });
  const pending = transport.nextFrame('tpkt', 10000);
  transport.close();
  await assert.rejects(pending, { code: 'RDP_CLOSED' });
  assert.equal((transport as any).pending, undefined);
});

test('Malformed streaming frames are contained even without an error listener', async () => {
  for (const hex of ['03000000', '03000001', '008001', '0001', '3080']) {
    const transport = new RdpTransport({ host: 'localhost', port: 1 });
    const pending = transport.nextFrame(hex === '3080' ? 'der' : 'tpkt');
    assert.doesNotThrow(() => (transport as any).onData(Buffer.from(hex, 'hex')));
    await assert.rejects(pending);
    assert.equal((transport as any).closed, true);
  }
});

test('A failed read clears its timer instead of cancelling the next read', async () => {
  const transport = new RdpTransport({ host: 'localhost', port: 1 });
  const first = transport.nextFrame('tpkt', 10);
  (transport as any).onError(new Error('read failed'));
  await assert.rejects(first, /read failed/);
  const second = transport.nextFrame('tpkt', 1000);
  await new Promise(resolve => setTimeout(resolve, 25));
  (transport as any).onData(tpktRaw(Buffer.from('data')));
  assert.equal((await second).subarray(4).toString(), 'data');
  transport.close();
});

test('A silent TLS peer times out and user cancellation settles the handshake', async t => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.resume(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const port = (server.address() as net.AddressInfo).port;
  const timeout = new RdpTransport({ host: '127.0.0.1', port, connectTimeout: 100 });
  t.after(() => timeout.close());
  await timeout.connect();
  await assert.rejects(timeout.upgradeTls(), { code: 'RDP_TIMEOUT' });
  const cancelled = new RdpTransport({ host: '127.0.0.1', port, connectTimeout: 10000 });
  t.after(() => cancelled.close());
  await cancelled.connect();
  const handshake = cancelled.upgradeTls();
  cancelled.close();
  await assert.rejects(handshake, { code: 'RDP_CLOSED' });
});
