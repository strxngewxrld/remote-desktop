/**
 * Kerberos gegen einen echten KDC: MIT Kerberos, in einem Wegwerf-Realm.
 *
 * Der Test legt eine KDC-Datenbank in einem temporaeren Ordner an, traegt
 * Benutzer und den Dienst TERMSRV/localhost ein, exportiert dessen Schluessel
 * in eine Keytab und startet krb5kdc auf einem freien Port. Danach holt der
 * Client sein Ticket dort - und der Mock-RDP-Server prueft es mit dem
 * Schluessel, den MIT erzeugt hat.
 *
 * Ohne MIT Kerberos (`brew install krb5`) werden diese Tests uebersprungen.
 * KRB5_SBIN zeigt auf einen anderen Ort als /usr/local/opt/krb5/sbin.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { RdpClient } from '../src/client.js';
import { USAGE, entschluesseln } from '../src/kerberos/crypto.js';
import { leseTicketInhalt, prinzipalText, KDC_ERR } from '../src/kerberos/asn1.js';
import { holeDienstTicket, KerberosFehler } from '../src/kerberos/kdc.js';
import { MockRdpServer } from './mockServer.js';
import { leseKeytab, type KerberosOutcome } from './mockKerberos.js';

const REALM = 'TEST.LOKAL';
const DIENST = 'TERMSRV/localhost';

function findeSbin(): string | undefined {
  const kandidaten = [process.env.KRB5_SBIN, '/usr/local/opt/krb5/sbin', '/opt/homebrew/opt/krb5/sbin'];
  return kandidaten.find((p) => p && fs.existsSync(path.join(p, 'krb5kdc')));
}

const sbin = findeSbin();
const ueberspringen = sbin ? false : 'MIT Kerberos nicht installiert (brew install krb5)';

async function freierPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function warteAufPort(port: number, frist = 10000): Promise<void> {
  const ende = Date.now() + frist;
  for (;;) {
    const offen = await new Promise<boolean>((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => (s.destroy(), r(true)));
      s.on('error', () => r(false));
    });
    if (offen) return;
    if (Date.now() > ende) throw new Error('krb5kdc startet nicht');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function createTestCertificate(ordner: string): { cert: string; key: string } {
  const certPath = path.join(ordner, 'cert.pem');
  const keyPath = path.join(ordner, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

describe('Kerberos gegen MIT krb5kdc', { skip: ueberspringen }, () => {
  let ordner: string;
  let kdc: ChildProcess | undefined;
  let kdcPort: number;
  let keytab: string;
  const umgebung: NodeJS.ProcessEnv = { ...process.env };

  const kadmin = (befehl: string) =>
    execFileSync(path.join(sbin!, 'kadmin.local'), ['-r', REALM, '-q', befehl], { env: umgebung, stdio: 'pipe' });

  before(async () => {
    ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-krb5-'));
    kdcPort = await freierPort();
    keytab = path.join(ordner, 'dienst.keytab');
    const enctypes = 'aes256-cts-hmac-sha1-96:normal aes128-cts-hmac-sha1-96:normal';
    fs.writeFileSync(
      path.join(ordner, 'krb5.conf'),
      `[libdefaults]\n default_realm = ${REALM}\n dns_lookup_kdc = false\n\n` +
        `[realms]\n ${REALM} = {\n  kdc = 127.0.0.1:${kdcPort}\n }\n`,
    );
    fs.writeFileSync(
      path.join(ordner, 'kdc.conf'),
      `[kdcdefaults]\n kdc_ports = ${kdcPort}\n kdc_tcp_ports = ${kdcPort}\n\n` +
        `[realms]\n ${REALM} = {\n  database_name = ${path.join(ordner, 'principal')}\n` +
        `  key_stash_file = ${path.join(ordner, 'stash')}\n  acl_file = ${path.join(ordner, 'kadm5.acl')}\n` +
        `  supported_enctypes = ${enctypes}\n  max_life = 10h 0m 0s\n }\n\n` +
        `[logging]\n kdc = FILE:${path.join(ordner, 'kdc.log')}\n`,
    );
    fs.writeFileSync(path.join(ordner, 'kadm5.acl'), '');
    umgebung.KRB5_CONFIG = path.join(ordner, 'krb5.conf');
    umgebung.KRB5_KDC_PROFILE = path.join(ordner, 'kdc.conf');

    execFileSync(path.join(sbin!, 'kdb5_util'), ['create', '-s', '-r', REALM, '-P', 'master-geheim'], {
      env: umgebung,
      stdio: 'pipe',
    });
    kadmin('addprinc +requires_preauth -pw "Anna-Passw0rt" anna');
    kadmin('addprinc -pw "Bert-Passw0rt" bert');
    kadmin(`addprinc -randkey ${DIENST}`);
    kadmin(`ktadd -k ${keytab} ${DIENST}`);

    kdc = spawn(path.join(sbin!, 'krb5kdc'), ['-n', '-r', REALM], { env: umgebung, stdio: 'ignore' });
    await warteAufPort(kdcPort);
  });

  after(() => {
    kdc?.kill();
    if (ordner) fs.rmSync(ordner, { recursive: true, force: true });
  });

  const anmeldung = (benutzer: string, passwort: string) => ({
    realm: REALM,
    benutzer,
    passwort,
    kdc: [{ host: '127.0.0.1', port: kdcPort }],
  });

  test('Mit Vorab-Authentifizierung gibt es ein Ticket, das der Dienstschluessel aus der Keytab oeffnet', async () => {
    const ergebnis = await holeDienstTicket(anmeldung('anna', 'Anna-Passw0rt'), DIENST);
    assert.equal(prinzipalText(ergebnis.ticket.sname), DIENST);
    const dienst = leseKeytab(keytab).find((e) => e.schluessel.etype === ergebnis.ticket.encPart.etype)!;
    assert.ok(dienst, 'die Keytab enthaelt einen Schluessel fuer dieses Verfahren');
    const inhalt = leseTicketInhalt(entschluesseln(dienst.schluessel, USAGE.TICKET, ergebnis.ticket.encPart.cipher));
    assert.equal(prinzipalText(inhalt.cname), 'anna');
    assert.equal(inhalt.crealm, REALM);
    assert.deepEqual(inhalt.schluessel, ergebnis.sitzungsSchluessel, 'Client und Dienst haben denselben Sitzungsschluessel');
  });

  test('Ohne verlangte Vorab-Authentifizierung kommt das Salz aus der Antwort', async () => {
    const ergebnis = await holeDienstTicket(anmeldung('bert', 'Bert-Passw0rt'), DIENST);
    assert.equal(prinzipalText(ergebnis.cname), 'bert');
  });

  test('Ein falsches Passwort meldet der KDC als PREAUTH_FAILED', async () => {
    await assert.rejects(
      () => holeDienstTicket(anmeldung('anna', 'falsch'), DIENST),
      (err: unknown) => err instanceof KerberosFehler && err.code === KDC_ERR.PREAUTH_FAILED,
    );
  });

  test('Ein unbekannter Dienst wird als S_PRINCIPAL_UNKNOWN gemeldet', async () => {
    await assert.rejects(
      () => holeDienstTicket(anmeldung('anna', 'Anna-Passw0rt'), 'TERMSRV/gibtsnicht'),
      (err: unknown) => err instanceof KerberosFehler && err.code === KDC_ERR.S_PRINCIPAL_UNKNOWN,
    );
  });

  test('Ein unbekannter Benutzer wird als C_PRINCIPAL_UNKNOWN gemeldet', async () => {
    await assert.rejects(
      () => holeDienstTicket(anmeldung('niemand', 'x'), DIENST),
      (err: unknown) => err instanceof KerberosFehler && err.code === KDC_ERR.C_PRINCIPAL_UNKNOWN,
    );
  });

  test('NLA mit Kerberos: Ticket vom MIT-KDC, geprueft vom RDP-Server', async () => {
    const zertifikat = createTestCertificate(ordner);
    const server = new MockRdpServer({
      ...zertifikat,
      width: 800,
      height: 600,
      kerberos: { dienstSchluessel: leseKeytab(keytab).map((e) => e.schluessel), windowsWrap: true },
    });
    const port = await server.listen();
    const client = new RdpClient({
      host: 'localhost',
      port,
      domain: 'test.lokal',
      username: 'anna',
      password: 'Anna-Passw0rt',
      width: 800,
      height: 600,
      connectTimeout: 10000,
      authProtocol: 'kerberos',
      kerberos: { kdc: [{ host: '127.0.0.1', port: kdcPort }] },
    });
    try {
      const credssp = once(server, 'credssp');
      await client.connect();
      const [ergebnis] = (await credssp) as [KerberosOutcome];
      assert.equal(ergebnis.ticketBenutzer, `anna@${REALM}`);
      assert.equal(ergebnis.credentials.password, 'Anna-Passw0rt');
      assert.equal(ergebnis.clientMic, true);
    } finally {
      client.disconnect();
      server.close();
    }
  });
});

describe('Kerberos - Rueckfall auf NTLM', () => {
  test('negotiate nimmt NTLM, wenn kein KDC antwortet', async () => {
    const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-krb5-rueckfall-'));
    const server = new MockRdpServer({
      ...createTestCertificate(ordner),
      width: 800,
      height: 600,
      credentials: { domain: 'test.lokal', user: 'anna', password: 'pw' },
    });
    const port = await server.listen();
    const zeilen: string[] = [];
    const client = new RdpClient({
      host: 'localhost',
      port,
      domain: 'test.lokal',
      username: 'anna',
      password: 'pw',
      width: 800,
      height: 600,
      connectTimeout: 3000,
      authProtocol: 'negotiate',
      kerberos: { kdc: [{ host: '127.0.0.1', port: await freierPort() }] },
      logLevel: 'info',
      logSink: (_l, m) => zeilen.push(m),
    });
    try {
      const credssp = once(server, 'credssp');
      await client.connect();
      await credssp;
      assert.ok(zeilen.some((z) => z.includes('nicht erreichbar') && z.includes('NTLM')), zeilen.join('\n'));
      assert.ok(zeilen.some((z) => z.includes('(NTLM)')));
    } finally {
      client.disconnect();
      server.close();
      fs.rmSync(ordner, { recursive: true, force: true });
    }
  });

  test('negotiate nimmt NTLM ohne Versuch, wenn der Host eine IP-Adresse ist', async () => {
    const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rdp-krb5-ip-'));
    const server = new MockRdpServer({
      ...createTestCertificate(ordner),
      width: 800,
      height: 600,
      credentials: { domain: 'test.lokal', user: 'anna', password: 'pw' },
    });
    const port = await server.listen();
    const zeilen: string[] = [];
    const client = new RdpClient({
      host: '127.0.0.1',
      port,
      domain: 'test.lokal',
      username: 'anna',
      password: 'pw',
      width: 800,
      height: 600,
      authProtocol: 'negotiate',
      logLevel: 'info',
      logSink: (_l, m) => zeilen.push(m),
    });
    try {
      const credssp = once(server, 'credssp');
      await client.connect();
      await credssp;
      assert.ok(zeilen.some((z) => z.includes('IP-Adresse')), zeilen.join('\n'));
    } finally {
      client.disconnect();
      server.close();
      fs.rmSync(ordner, { recursive: true, force: true });
    }
  });
});
