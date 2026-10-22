import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PortableKerberosContext } from '../src/crypto/portableKerberos.js';
import { prepareNla } from '../src/crypto/authSelection.js';
import { KerberosUnavailableError } from '../src/crypto/windowsKerberos.js';
import { RdpAuthError } from '../src/core/errors.js';
import { KerberosFehler } from '../src/kerberos/kdc.js';
import { KerberosKontext } from '../src/kerberos/kontext.js';
import { KDC_ERR } from '../src/kerberos/asn1.js';

const credentials = { host: 'server.ad.test', user: 'alice', domain: 'AD.TEST', password: 'test-only' };
const key = Buffer.from('test TLS public key');

test('portable Kerberos rejects IP targets, missing realms and local accounts before contacting a KDC', async () => {
  for (const options of [
    { ...credentials, host: '127.0.0.1' }, { ...credentials, host: '::1' },
    { ...credentials, domain: 'AD' }, { ...credentials, domain: '.' },
    { ...credentials, domain: 'server' }, { ...credentials, user: 'server\\alice' },
  ]) {
    const context = new PortableKerberosContext(options, async () => assert.fail('No ticket request expected'));
    await assert.rejects(context.step(), KerberosUnavailableError);
    context.dispose();
  }
});

test('portable provider passes a normalized identity, explicit KDC and cancellation signal to ticket acquisition', async () => {
  const options = { ...credentials, user: 'AD\\alice', domain: 'AD', kerberos: {
    realm: 'other.test', kdc: [{ host: '127.0.0.1', port: 1088 }],
  } };
  const context = new PortableKerberosContext(options, async (login, service) => {
    assert.equal(service, 'TERMSRV/server.ad.test');
    assert.equal(login.realm, 'OTHER.TEST');
    assert.equal(login.benutzer, 'alice');
    assert.equal(login.passwort, 'test-only');
    assert.deepEqual(login.kdc, options.kerberos.kdc);
    assert.equal(login.signal?.aborted, false);
    throw new KerberosFehler('stop after checking identity', KDC_ERR.PREAUTH_FAILED);
  });
  await assert.rejects(context.step(), RdpAuthError);
  await assert.rejects(context.seal(Buffer.from('credentials')), /nicht aufgebaut/);
  context.dispose();
});

test('portable authentication errors, unknown KDC errors and timeouts never fall back to NTLM', async () => {
  for (const error of [
    new KerberosFehler('bad password', KDC_ERR.PREAUTH_FAILED),
    new KerberosFehler('unknown account', KDC_ERR.C_PRINCIPAL_UNKNOWN),
    new KerberosFehler('expired or revoked credentials', 18),
    new KerberosFehler('unsupported encryption', KDC_ERR.ETYPE_NOSUPP),
    new KerberosFehler('KDC timeout'), new Error('integrity failure'),
  ]) {
    await assert.rejects(prepareNla('auto', credentials, key, () => assert.fail('No fallback'), options =>
      new PortableKerberosContext(options, async () => { throw error; })));
  }
});

test('only an unknown service permits portable automatic fallback; explicit Kerberos still fails', async () => {
  const create = (options: typeof credentials) => new PortableKerberosContext(options, async () => {
    throw new KerberosFehler('unknown SPN', KDC_ERR.S_PRINCIPAL_UNKNOWN);
  });
  let fallbacks = 0;
  const prepared = await prepareNla('auto', credentials, key, () => fallbacks++, create);
  assert.equal(prepared.mechanism, 'ntlm');
  assert.equal(fallbacks, 1);
  prepared.dispose();
  await assert.rejects(prepareNla('kerberos', credentials, key, () => assert.fail('No fallback'), create), KerberosUnavailableError);
});

test('disposing during ticket acquisition cancels it and cannot resurrect a context', async () => {
  let complete!: (context: KerberosKontext) => void;
  let signal!: AbortSignal;
  const context = new PortableKerberosContext(credentials, async login => {
    signal = login.signal!;
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = context.step();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(context.step(), /unerwarteter Zustand/);
  context.dispose();
  assert.equal(signal.aborted, true);
  complete({ start() { assert.fail('Disposed context must never send a token'); } } as unknown as KerberosKontext);
  await rejected;
  await assert.rejects(context.step(), /unerwarteter Zustand/);
  await assert.rejects(context.unseal(Buffer.alloc(0)), /nicht aufgebaut/);
});

test('invalid KDC addresses and timeouts fail before ticket acquisition', async () => {
  for (const options of [
    { ...credentials, connectTimeout: -1 },
    { ...credentials, kerberos: { kdc: [{ host: '', port: 88 }] } },
    { ...credentials, kerberos: { kdc: [{ host: 'dc.ad.test', port: 0 }] } },
  ]) {
    const context = new PortableKerberosContext(options, async () => assert.fail('No ticket request expected'));
    await assert.rejects(context.step(), /ungueltig/);
    context.dispose();
  }
});

test('a service-unknown reply racing with cancellation cannot trigger NTLM fallback', async () => {
  let context!: PortableKerberosContext;
  let fail!: (reason: Error) => void;
  const result = prepareNla('auto', credentials, key, () => assert.fail('No fallback after cancellation'), options => {
    context = new PortableKerberosContext(options, async () => new Promise((_resolve, reject) => { fail = reject; }));
    return context;
  });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  context.dispose();
  fail(new KerberosFehler('unknown service', KDC_ERR.S_PRINCIPAL_UNKNOWN));
  await rejected;
});
