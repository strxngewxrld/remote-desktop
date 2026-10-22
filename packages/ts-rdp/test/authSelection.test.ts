import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { prepareNla } from '../src/crypto/authSelection.js';
import { decodeTsRequest, encodeTsRequest } from '../src/crypto/credssp.js';
import { kerberosStatusError, KerberosUnavailableError } from '../src/crypto/windowsKerberos.js';
import type { SecurityContext } from '../src/crypto/securityContext.js';

const credentials = { host: 'server.example.test', domain: 'TEST', user: 'tester', password: 'test-only' };
const key = Buffer.from('tls server key');

test('auto prefers Kerberos and disposes its context after use', async () => {
  let disposed = false;
  const security: SecurityContext = {
    async step() { return { token: Buffer.from('kerberos'), complete: false }; },
    async seal(data) { return data; }, async unseal(data) { return data; },
    dispose() { disposed = true; },
  };
  const prepared = await prepareNla('auto', credentials, key, () => assert.fail('fallback'), () => security);
  assert.equal(prepared.mechanism, 'kerberos');
  assert.equal(decodeTsRequest(prepared.initial).negoTokens?.[0].toString(), 'kerberos');
  assert.equal(disposed, false);
  prepared.dispose();
  assert.equal(disposed, true);
});

test('auto uses NTLM when local Kerberos prerequisites are absent', async () => {
  let fallbacks = 0;
  const prepared = await prepareNla('auto', credentials, key, () => fallbacks++, () => {
    throw new KerberosUnavailableError('not available');
  });
  assert.equal(prepared.mechanism, 'ntlm');
  assert.equal(decodeTsRequest(prepared.initial).negoTokens?.[0].subarray(0, 8).toString(), 'NTLMSSP\0');
  assert.equal(fallbacks, 1);
  prepared.dispose();
});

test('ticket availability failure falls back before sending any Kerberos token and disposes the provider', async () => {
  let disposed = false;
  const prepared = await prepareNla('auto', credentials, key, () => {}, () => ({
    async step() { throw new KerberosUnavailableError('target unknown'); },
    async seal() { throw new Error('unexpected'); }, async unseal() { throw new Error('unexpected'); },
    dispose() { disposed = true; },
  }));
  assert.equal(prepared.mechanism, 'ntlm');
  assert.equal(disposed, true);
});

test('explicit Kerberos never falls back, even when unavailable', async () => {
  await assert.rejects(prepareNla('kerberos', credentials, key, () => assert.fail('fallback'), () => {
    throw new KerberosUnavailableError('unavailable');
  }), KerberosUnavailableError);
});

test('explicit NTLM does not attempt Kerberos', async () => {
  const prepared = await prepareNla('ntlm', credentials, key, () => assert.fail('fallback'), () => {
    assert.fail('Kerberos should not be called');
  });
  assert.equal(prepared.mechanism, 'ntlm');
});

test('invalid credentials, integrity errors and provider timeouts never trigger fallback', async () => {
  for (const message of ['InvalidCredentials', 'UnknownCredentials', 'CredentialsExpired', 'BadBinding', 'MessageAltered', 'timeout']) {
    let disposed = false;
    await assert.rejects(prepareNla('auto', credentials, key, () => assert.fail('fallback'), () => ({
      async step() { throw kerberosStatusError(message); },
      async seal(data) { return data; }, async unseal(data) { return data; },
      dispose() { disposed = true; },
    })), /Kerberos\/SSPI/);
    assert.equal(disposed, true);
  }
});

test('only unambiguous SSPI availability statuses permit a retry', () => {
  for (const status of ['Unsupported', 'TargetUnknown'])
    assert.ok(kerberosStatusError(status) instanceof KerberosUnavailableError);
  for (const status of ['GenericFailure', 'UnknownCredentials', 'InvalidCredentials', 'BadBinding', 'MessageAltered'])
    assert.equal(kerberosStatusError(status) instanceof KerberosUnavailableError, false, status);
});

test('failure after the first Kerberos token never restarts authentication with NTLM', async () => {
  let steps = 0;
  const prepared = await prepareNla('auto', credentials, key, () => assert.fail('fallback'), () => ({
    async step() {
      if (steps++) throw new KerberosUnavailableError('server token rejected');
      return { token: Buffer.from('initial'), complete: false };
    },
    async seal(data) { return data; }, async unseal(data) { return data; }, dispose() {},
  }));
  await assert.rejects(async () => prepared.client.step(encodeTsRequest({ version: 6, negoTokens: [Buffer.from('reply')] })),
    KerberosUnavailableError);
  assert.equal(prepared.mechanism, 'kerberos');
  prepared.dispose();
});
