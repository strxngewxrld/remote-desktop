import { einstellungen, zuruecksetzen, ExtensionContext, antworten } from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { loeseCredentialsAuf, credentialSecretKey, parseUsername } from '../src/connections.js';
import { verwalteCredentials, waehleAnmeldung } from '../src/credentials.js';
import { RdpSession } from '../src/session.js';

beforeEach(() => zuruecksetzen());
const admin = { id: 'admin', name: 'Admin', username: 'administrator' };
const user = { id: 'user', name: 'Benutzer', username: 'user' };

test('Verbinden als wählt einmalig ein anderes Profil ohne den Standard zu ändern', async () => {
  const connection = { name: 'Server', host: 'server', credentials: [admin, user], defaultCredential: admin.id };
  antworten.auswahlen.push(1);
  const selected = await waehleAnmeldung(connection);
  assert.equal(selected?.defaultCredential, user.id);
  assert.deepEqual(selected?.credentials, [user]);
  assert.equal(connection.defaultCredential, admin.id);
  assert.equal(connection.credentials.length, 2);
});

test('Verbinden als unterstützt neue Zugangsdaten und Abbruch', async () => {
  const connection = { name: 'Server', host: 'server', username: 'alt', credentials: [admin] };
  antworten.auswahlen.push(1);
  const selected = await waehleAnmeldung(connection);
  assert.equal(selected?.promptCredentials, true);
  assert.equal(selected?.username, undefined);
  assert.deepEqual(selected?.credentials, []);
  assert.equal(await waehleAnmeldung(connection), undefined);
});

test('Domäne und UPN bleiben erhalten; unvollständige Anmeldungen werden abgelehnt', () => {
  assert.deepEqual(parseUsername(' DOM\\alice '), { domain: 'DOM', username: 'alice' });
  assert.deepEqual(parseUsername('alice@example.com'), { username: 'alice@example.com' });
  for (const invalid of ['', '   ', 'DOM\\', '\\alice', 'DOM\\\\alice']) assert.equal(parseUsername(invalid), undefined);
});

test('Ungültige Profilkonfiguration wird verworfen und beschädigte Anzeigenamen werden ersetzt', () => {
  const result = loeseCredentialsAuf([null, { credentials: [null, { id: '', username: 'x' }, { ...admin, name: {} }] }] as any);
  assert.deepEqual(result.credentials, [{ ...admin, name: admin.username }]);
});

test('Profile werden additiv vererbt; der nächste Default gewinnt', () => {
  const result = loeseCredentialsAuf([{ credentials: [admin], defaultCredential: 'admin' }, { credentials: [user], defaultCredential: 'user' }, {}]);
  assert.deepEqual(result.credentials, [admin, user]);
  assert.equal(result.defaultCredential, 'user');
  assert.equal(loeseCredentialsAuf([{ credentials: [admin], defaultCredential: 'admin' }, { defaultCredential: '' }]).defaultCredential, undefined);
});

test('Immer fragen unterbricht Vererbung; Unterordner darf eigene Profile verwenden', () => {
  const parents = [{ credentials: [admin], defaultCredential: 'admin' }, { promptCredentials: true }];
  assert.deepEqual(loeseCredentialsAuf(parents).credentials, []);
  assert.equal(loeseCredentialsAuf(parents).promptCredentials, true);
  assert.deepEqual(loeseCredentialsAuf([...parents, { credentials: [user], promptCredentials: false }]).credentials, [user]);
});


test('Zugangsdatenverwaltung trennt Profilmetadaten vom Passwort', async () => {
  const context = new ExtensionContext();
  antworten.auswahlen.push(0);
  antworten.eingaben.push('Admin', 'DOM\\alice', 'test-secret');
  await verwalteCredentials(context);
  const stored = einstellungen.get('rdp.authentication') as { credentials: (typeof admin & { domain?: string })[] };
  assert.equal(stored.credentials[0]!.domain, 'DOM');
  assert.equal(stored.credentials[0]!.username, 'alice');
  assert.equal(JSON.stringify(stored).includes('test-secret'), false);
  assert.equal(await context.secrets.get(credentialSecretKey(stored.credentials[0]!.id)), 'test-secret');
});

test('Standardprofil verwendet seinen Secret-Schlüssel; mehrere Profile ohne Standard fragen nach', async () => {
  const context = new ExtensionContext();
  await context.secrets.store(credentialSecretKey(admin.id), 'admin-secret');
  await context.secrets.store(credentialSecretKey(user.id), 'user-secret');
  const state = { connection: { host: 'host', credentials: [admin, user], defaultCredential: 'user' }, context };
  const resolve = (RdpSession.prototype as any).resolveCredentials;
  assert.equal((await resolve.call(state)).password, 'user-secret');
  state.connection.defaultCredential = '';
  antworten.auswahlen.push(0);
  assert.equal((await resolve.call(state)).password, 'admin-secret');
  assert.equal(await resolve.call(state), undefined, 'Escape bricht die Anmeldung ab');
});

test('Ohne Profil wird bei jeder Anmeldung gefragt und kein Passwort wiederverwendet', async () => {
  const context = new ExtensionContext();
  const state = { connection: { host: 'host' }, context };
  const resolve = (RdpSession.prototype as any).resolveCredentials;
  antworten.eingaben.push('DOM\\alice', 'first', 'bob', 'second');
  assert.deepEqual(await resolve.call(state), { username: 'alice', password: 'first', shouldSave: false });
  assert.deepEqual(await resolve.call(state), { username: 'bob', password: 'second', shouldSave: false });
  assert.equal((state.connection as any).domain, '');
});
