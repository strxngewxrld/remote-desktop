import { strict as assert } from 'node:assert';
import * as net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { frageKdc } from '../src/kerberos/kdc.js';
import { schluesselAusPasswort, ETYPE_AES256_CTS_HMAC_SHA1_96 } from '../src/kerberos/crypto.js';
import { app, seq, ctx, int, generalString, zeit, prinzipal } from '../src/kerberos/asn1.js';
import { prepareNla } from '../src/crypto/authSelection.js';
import { RdpAuthError } from '../src/core/errors.js';

async function withKdc(reply: (socket: net.Socket) => void, run: (port: number) => Promise<void>) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => reply(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run((server.address() as net.AddressInfo).port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('KDC TCP framing handles fragmented headers and bodies', async () => {
  const body = Buffer.from('independent KDC response');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  await withKdc(socket => {
    socket.write(header.subarray(0, 2));
    setTimeout(() => {
      socket.write(Buffer.concat([header.subarray(2), body.subarray(0, 3)]));
      setTimeout(() => { if (!socket.destroyed) socket.end(body.subarray(3)); }, 5);
    }, 5);
  }, async port => {
    assert.deepEqual(await frageKdc({ host: '127.0.0.1', port }, Buffer.from('request')), body);
  });
});

test('KDC rejects oversized, zero-length and truncated replies', async () => {
  for (const length of [0, 16 * 1024 * 1024 + 1, 8]) {
    await withKdc(socket => {
      const header = Buffer.alloc(4); header.writeUInt32BE(length);
      socket.end(Buffer.concat([header, Buffer.from('abc')]));
    }, async port => {
      await assert.rejects(frageKdc({ host: '127.0.0.1', port }, Buffer.from('request')), /unplausible|ohne Antwort/);
    });
  }
});

test('KDC operations respect timeouts and cancellation', async () => {
  await withKdc(() => {}, async port => {
    const address = { host: '127.0.0.1', port };
    await assert.rejects(frageKdc(address, Buffer.from('request'), 20), /antwortet nicht/);
    const controller = new AbortController();
    const result = frageKdc(address, Buffer.from('request'), 1000, controller.signal);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    await assert.rejects(frageKdc(address, Buffer.from('request'), 1000, controller.signal), { name: 'AbortError' });
  });
});

test('KDC cannot request unbounded password derivation work', () => {
  for (const iterations of [0, -1, 1.5, 1_000_001, 0xffffffff, NaN, Infinity])
    assert.throws(() => schluesselAusPasswort(ETYPE_AES256_CTS_HMAC_SHA1_96, 'test', 'salt', iterations), /Iterationszahl/);
});

test('non-Windows default NLA provider contacts the configured KDC and fails closed on rejected credentials',
  { skip: process.platform === 'win32' }, async () => {
    let requests = 0;
    await withKdc(socket => {
      requests++;
      const body = app(30, seq(ctx(0, int(5)), ctx(1, int(30)), ctx(4, zeit(new Date())),
        ctx(5, int(0)), ctx(6, int(24)), ctx(9, generalString('AD.TEST')),
        ctx(10, prinzipal({ typ: 2, teile: ['krbtgt', 'AD.TEST'] }))));
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      socket.end(Buffer.concat([header, body]));
    }, async port => {
      await assert.rejects(prepareNla('auto', {
        host: 'server.ad.test', domain: 'AD.TEST', user: 'alice', password: 'test-only',
        kerberos: { kdc: [{ host: '127.0.0.1', port }] },
      }, Buffer.from('TLS key'), () => assert.fail('Credential failures must not fall back')), RdpAuthError);
      assert.equal(requests, 1);
    });
  });
