/**
 * Kerberos ohne KDC: Zielermittlung, GSS-Wrap in beiden Richtungen und der
 * ganze CredSSP-Ablauf gegen den Test-Acceptor - mit einem Ticket, das der
 * Test selbst ausstellt. Ob ein fremder KDC dasselbe Ticket akzeptiert, prueft
 * `kerberosMit.test.ts` gegen MIT Kerberos.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  ETYPE_AES256_CTS_HMAC_SHA1_96,
  USAGE,
  verschluesseln,
  zufallsSchluessel,
} from '../src/kerberos/crypto.js';
import {
  NT_PRINCIPAL,
  NT_SRV_INST,
  app,
  baueTicket,
  ctx,
  flags32,
  generalString,
  prinzipal,
  schluessel,
  seq,
  ticketAusBytes,
  zeit,
} from '../src/kerberos/asn1.js';
import { GssKrb5Sitzung } from '../src/kerberos/gss.js';
import { KerberosKontext } from '../src/kerberos/kontext.js';
import { kerberosZiel } from '../src/kerberos/ziel.js';
import { CredSspClient } from '../src/crypto/credssp.js';
import { MockKerberosCredSspServer } from './mockKerberos.js';

describe('Kerberos - geht es fuer diese Verbindung?', () => {
  test('Eine IP-Adresse hat keinen SPN', () => {
    const z = kerberosZiel({ host: '10.0.0.5', benutzer: 'anna', domain: 'firma.de' });
    assert.equal(z.ok, false);
  });

  test('Der Realm kommt aus benutzer@domaene, dann aus einer DNS-Domaene', () => {
    assert.deepEqual(kerberosZiel({ host: 'srv.firma.de', benutzer: 'anna@firma.de' }), {
      ok: true,
      realm: 'FIRMA.DE',
      benutzer: 'anna',
      dienst: 'TERMSRV/srv.firma.de',
    });
    const z = kerberosZiel({ host: 'srv', benutzer: 'anna', domain: 'firma.de' });
    assert.equal(z.ok && z.realm, 'FIRMA.DE');
  });

  test('Ein NetBIOS-Domaenenname reicht nicht', () => {
    const z = kerberosZiel({ host: 'srv', benutzer: 'anna', domain: 'FIRMA' });
    assert.equal(z.ok, false);
    assert.ok(!z.ok && z.grund.includes('NetBIOS'));
  });

  test('Ein vorgegebener Realm gewinnt', () => {
    const z = kerberosZiel({ host: 'srv', benutzer: 'anna@x.de', domain: 'FIRMA', realm: 'ad.firma.de' });
    assert.equal(z.ok && z.realm, 'AD.FIRMA.DE');
  });
});

describe('Kerberos - Wrap und MIC (RFC 4121)', () => {
  const k = zufallsSchluessel(ETYPE_AES256_CTS_HMAC_SHA1_96);

  test('Initiator und Acceptor verstehen sich in beiden Richtungen', () => {
    const client = new GssKrb5Sitzung(k, 'initiator', true, 100, 500);
    const server = new GssKrb5Sitzung(k, 'acceptor', true, 500, 100);
    assert.equal(server.unwrap(client.wrap(Buffer.from('hallo'))).toString(), 'hallo');
    assert.equal(client.unwrap(server.wrap(Buffer.from('zurueck'))).toString(), 'zurueck');
    const liste = Buffer.from('mechs');
    server.verifyMic(liste, client.getMic(liste));
  });

  test('Ein Token im Windows-Stil (EC 16, RRC 28, gedreht um 44) wird gelesen', () => {
    const client = new GssKrb5Sitzung(k, 'initiator', true, 1, 2);
    const server = new GssKrb5Sitzung(k, 'acceptor', true, 2, 1);
    const daten = randomBytes(32);
    assert.deepEqual(client.unwrap(server.wrap(daten, { ec: 16, rrc: 28, drehung: 44 })), daten);
    assert.deepEqual(client.unwrap(server.wrap(daten, { ec: 16, rrc: 28 })), daten, 'und nach RFC 4121 gedreht');
  });

  test('Ein eigenes Token wird nicht als das der Gegenseite angenommen', () => {
    const client = new GssKrb5Sitzung(k, 'initiator', true, 1, 2);
    assert.throws(() => client.unwrap(client.wrap(Buffer.from('x'))), /Richtung/);
  });
});

/** Ein Dienst-Ticket ausstellen, wie es ein KDC tun wuerde. */
function stelleTicketAus(dienstSchluessel: ReturnType<typeof zufallsSchluessel>) {
  const sitzungsSchluessel = zufallsSchluessel(ETYPE_AES256_CTS_HMAC_SHA1_96);
  const cname = { typ: NT_PRINCIPAL, teile: ['anna'] };
  const jetzt = new Date();
  const encTicketPart = app(
    3,
    seq(
      ctx(0, flags32(0x40000000)),
      ctx(1, schluessel(sitzungsSchluessel)),
      ctx(2, generalString('FIRMA.DE')),
      ctx(3, prinzipal(cname)),
      ctx(4, seq(ctx(0, Buffer.from([0x02, 0x01, 0x01])), ctx(1, Buffer.from([0x04, 0x00])))),
      ctx(5, zeit(jetzt)),
      ctx(7, zeit(new Date(jetzt.getTime() + 3600_000))),
    ),
  );
  const roh = baueTicket('FIRMA.DE', { typ: NT_SRV_INST, teile: ['TERMSRV', 'srv.firma.de'] }, {
    etype: dienstSchluessel.etype,
    kvno: 2,
    cipher: verschluesseln(dienstSchluessel, USAGE.TICKET, encTicketPart),
  });
  return {
    ticket: ticketAusBytes(roh),
    sitzungsSchluessel,
    crealm: 'FIRMA.DE',
    cname,
    kdc: { host: 'kdc.test', port: 88 },
  };
}

describe('Kerberos - CredSSP gegen den Test-Acceptor', () => {
  const publicKey = randomBytes(270);

  for (const variante of [
    { name: 'mit mechListMIC (wie Windows)', mechListMic: true, windowsWrap: false },
    { name: 'ohne mechListMIC', mechListMic: false, windowsWrap: false },
    { name: 'mit Wrap-Tokens im Windows-Stil', mechListMic: true, windowsWrap: true },
  ]) {
    test(variante.name, () => {
      const dienst = zufallsSchluessel(ETYPE_AES256_CTS_HMAC_SHA1_96);
      const server = new MockKerberosCredSspServer({
        dienstSchluessel: [dienst],
        publicKey,
        mechListMic: variante.mechListMic,
        windowsWrap: variante.windowsWrap,
      });
      const client = new CredSspClient(
        { domain: 'FIRMA', user: 'anna', password: 'geheim' },
        publicKey,
        KerberosKontext.ausTicket(stelleTicketAus(dienst)),
      );

      let nachricht: Buffer | undefined = client.start();
      let ergebnis;
      for (let runde = 0; runde < 5 && nachricht; runde++) {
        const antwort = server.step(nachricht);
        if (antwort.outcome) {
          ergebnis = antwort.outcome;
          break;
        }
        const weiter = client.step(antwort.send!);
        nachricht = weiter.send;
      }
      assert.ok(ergebnis, 'die Zugangsdaten sind beim Server angekommen');
      assert.deepEqual(ergebnis.credentials, { domain: 'FIRMA', user: 'anna', password: 'geheim' });
      assert.equal(ergebnis.ticketBenutzer, 'anna@FIRMA.DE');
      assert.equal(ergebnis.clientMic, variante.mechListMic);
    });
  }

  test('Ein Ticket fuer einen anderen Dienst scheitert beim Server', () => {
    const server = new MockKerberosCredSspServer({ dienstSchluessel: [zufallsSchluessel(ETYPE_AES256_CTS_HMAC_SHA1_96)], publicKey });
    const client = new CredSspClient(
      { domain: '', user: 'anna', password: 'x' },
      publicKey,
      KerberosKontext.ausTicket(stelleTicketAus(zufallsSchluessel(ETYPE_AES256_CTS_HMAC_SHA1_96))),
    );
    assert.throws(() => server.step(client.start()), /Integritaet/);
  });
});
