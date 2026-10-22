import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodeTsRequest, encodeTsCredentials, encodeTsRequest, SecurityCredSspClient } from '../src/crypto/credssp.js';
import type { SecurityContext } from '../src/crypto/securityContext.js';
import { WindowsKerberosContext } from '../src/crypto/windowsKerberos.js';

const credentials = { domain: 'LAB', user: 'tester', password: 'test-only' };
const publicKey = Buffer.from('server public key');
function provider(completeInitially = false): SecurityContext & { sealed: Buffer[]; tokens: Array<Buffer | undefined> } {
  return {
    sealed: [], tokens: [],
    async step(token) {
      this.tokens.push(token);
      return { token: Buffer.from(token ? 'final' : 'initial'), complete: completeInitially || !!token };
    },
    async seal(data) { this.sealed.push(data); return Buffer.concat([Buffer.from('sealed:'), data]); },
    async unseal(data) { assert.equal(data.subarray(0, 7).toString(), 'sealed:'); return data.subarray(7); },
    dispose() {},
  };
}
function boundReply(nonce: Buffer): Buffer {
  const hash = createHash('sha256').update('CredSSP Server-To-Client Binding Hash\0', 'ascii').update(nonce).update(publicKey).digest();
  return encodeTsRequest({ version: 6, pubKeyAuth: Buffer.concat([Buffer.from('sealed:'), hash]) });
}

test('Kerberos continues negotiation, validates the TLS binding, then delegates encrypted credentials', async () => {
  const security = provider();
  const client = new SecurityCredSspClient(credentials, publicKey, security);
  const initial = decodeTsRequest(await client.start());
  assert.equal(initial.negoTokens?.[0].toString(), 'initial');
  assert.equal(initial.authInfo, undefined);
  const peerToken = Buffer.from('server mutual authentication');
  const next = await client.step(encodeTsRequest({ version: 6, negoTokens: [peerToken] }));
  assert.equal(next.done, false);
  const binding = decodeTsRequest(next.send!);
  assert.equal(binding.negoTokens?.[0].toString(), 'final');
  assert.equal(binding.clientNonce?.length, 32);
  assert.equal(security.sealed.length, 1, 'credentials have not been delegated yet');
  const final = await client.step(boundReply(binding.clientNonce!));
  assert.equal(final.done, true);
  assert.deepEqual(decodeTsRequest(final.send!).authInfo, Buffer.concat([Buffer.from('sealed:'), encodeTsCredentials('LAB', 'tester', 'test-only')]));
});

test('a context that completes initially sends its token and binding together', async () => {
  const client = new SecurityCredSspClient(credentials, publicKey, provider(true));
  const initial = decodeTsRequest(await client.start());
  assert.ok(initial.negoTokens?.[0]);
  assert.ok(initial.pubKeyAuth);
  assert.equal(initial.clientNonce?.length, 32);
  assert.equal((await client.step(boundReply(initial.clientNonce!))).done, true);
});

test('bad TLS binding never releases password credentials', async () => {
  const security = provider(true);
  const client = new SecurityCredSspClient(credentials, publicKey, security);
  await client.start();
  await assert.rejects(client.step(encodeTsRequest({ version: 6, pubKeyAuth: Buffer.from('sealed:wrong') })), /Kanalbindung/);
  assert.equal(security.sealed.length, 1);
});

test('old CredSSP versions and missing continuation tokens are rejected', async () => {
  for (const response of [{ version: 4, negoTokens: [Buffer.from('reply')] }, { version: 6 }]) {
    const client = new SecurityCredSspClient(credentials, publicKey, provider());
    await client.start();
    await assert.rejects(client.step(encodeTsRequest(response)), /CredSSP/);
  }
});

test('server authentication errors are surfaced without credential delegation', async () => {
  const security = provider();
  const client = new SecurityCredSspClient(credentials, publicKey, security);
  await client.start();
  await assert.rejects(client.step(encodeTsRequest({ version: 6, errorCode: 0xc000006d })), /c000006d/);
  assert.equal(security.sealed.length, 0);
});

test('Windows Kerberos refuses IP targets rather than falling back to NTLM', () => {
  assert.throws(() => new WindowsKerberosContext({ host: '127.0.0.1', ...credentials }), /FQDN|Windows Extension-Host/);
});
