/**
 * Automatischer Wiederverbindungsaufbau: ARC-Pakete, Pruefwert und Rueckzug.
 *
 * Die erwarteten Bytes sind hier von Hand aus MS-RDPBCGR zusammengesetzt und
 * nicht vom eigenen Encoder erzeugt - sonst pruefte der Test nur, dass der
 * Code mit sich selbst uebereinstimmt. Die HMAC-Werte stammen aus einer
 * unabhaengigen Rechnung mit `openssl dgst -md5 -mac HMAC`.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { BinaryReader } from '../src/core/binary.js';
import { backoffWartezeit, BackoffOptions } from '../src/core/backoff.js';
import {
  ARC_PACKET_LENGTH,
  AUTO_RECONNECT_VERSION_1,
  buildAutoReconnectCookie,
  buildClientAutoReconnectPacket,
  buildSaveSessionInfoWithCookie,
  buildServerAutoReconnectPacket,
  computeSecurityVerifier,
  INFOTYPE_LOGON,
  INFOTYPE_LOGON_EXTENDED_INFO,
  LOGON_EX_AUTORECONNECTCOOKIE,
  LOGON_EX_LOGONERRORS,
  parseClientAutoReconnectPacket,
  parseSaveSessionInfo,
  parseServerAutoReconnectPacket,
  SITZUNG_ENDGUELTIG_BEENDET,
} from '../src/protocol/autoReconnect.js';
import { buildClientCapabilities, AUTORECONNECT_SUPPORTED, CAPSTYPE_GENERAL } from '../src/protocol/caps.js';
import { buildClientInfo } from '../src/protocol/sec.js';

/** Zufallszahl des Servers in den Beispielen unten. */
const ARC_RANDOM_HEX = '000102030405060708090a0b0c0d0e0f';
const ARC_RANDOM = Buffer.from(ARC_RANDOM_HEX, 'hex');
const LOGON_ID = 42; // 0x2a

/**
 * ARC_SC_PRIVATE_PACKET (2.2.4.2), Feld fuer Feld von Hand gesetzt:
 *   cbLen   = 0x0000001c  ->  1c 00 00 00
 *   Version = 0x00000001  ->  01 00 00 00
 *   LogonId = 0x0000002a  ->  2a 00 00 00
 *   ArcRandomBits (16 Byte)
 */
const ARC_SC_HEX = '1c000000' + '01000000' + '2a000000' + ARC_RANDOM_HEX;

/**
 * HMAC_MD5(ARC_RANDOM, 32 Nullbytes) - der Pruefwert unter TLS/NLA (5.5).
 * Unabhaengig gerechnet:
 *   openssl dgst -md5 -mac HMAC -macopt hexkey:000102...0f  <32 Nullbytes>
 */
const VERIFIER_HEX = 'b639c8731638618b707972aa6e96cf90';

/** ARC_CS_PRIVATE_PACKET (2.2.4.3) zu genau diesem Cookie. */
const ARC_CS_HEX = '1c000000' + '01000000' + '2a000000' + VERIFIER_HEX;

describe('ARC-Pakete (MS-RDPBCGR 2.2.4.2 / 2.2.4.3)', () => {
  test('Das Server-Paket wird nach dem Feldplan der Spezifikation gelesen', () => {
    const p = parseServerAutoReconnectPacket(Buffer.from(ARC_SC_HEX, 'hex'));
    assert.equal(p.version, AUTO_RECONNECT_VERSION_1);
    assert.equal(p.logonId, LOGON_ID);
    assert.equal(p.arcRandom.toString('hex'), ARC_RANDOM_HEX);
  });

  test('Das Server-Paket wird byteweise so geschrieben, wie es gelesen wird', () => {
    const gebaut = buildServerAutoReconnectPacket({
      version: AUTO_RECONNECT_VERSION_1,
      logonId: LOGON_ID,
      arcRandom: ARC_RANDOM,
    });
    assert.equal(gebaut.toString('hex'), ARC_SC_HEX);
    assert.equal(gebaut.length, ARC_PACKET_LENGTH);
  });

  test('Ein cbLen ungleich 0x1c wird abgelehnt', () => {
    // Dasselbe Paket, nur mit cbLen = 0x20.
    const falsch = Buffer.from('20000000' + '01000000' + '2a000000' + ARC_RANDOM_HEX, 'hex');
    assert.throws(() => parseServerAutoReconnectPacket(falsch), /cbLen/);
  });

  test('Ein zu kurzes Paket wird abgelehnt', () => {
    assert.throws(() => parseServerAutoReconnectPacket(Buffer.from('1c000000', 'hex')), /Byte lang/);
  });

  test('Das Client-Paket traegt den Pruefwert an der Stelle der Zufallszahl', () => {
    const gebaut = buildClientAutoReconnectPacket({
      version: AUTO_RECONNECT_VERSION_1,
      logonId: LOGON_ID,
      securityVerifier: Buffer.from(VERIFIER_HEX, 'hex'),
    });
    assert.equal(gebaut.toString('hex'), ARC_CS_HEX);
  });

  test('Das Client-Paket wird aus von Hand gesetzten Bytes richtig gelesen', () => {
    const p = parseClientAutoReconnectPacket(Buffer.from(ARC_CS_HEX, 'hex'));
    assert.equal(p.version, 1);
    assert.equal(p.logonId, LOGON_ID);
    assert.equal(p.securityVerifier.toString('hex'), VERIFIER_HEX);
  });

  test('Der Pruefwert von Version und Sitzungsnummer haengt nur am Cookie', () => {
    // Ein zweiter Cookie mit anderer Sitzungsnummer, gleiche Zufallszahl:
    // der Pruefwert bleibt derselbe, nur LogonId wandert mit.
    const cookie = { version: 1, logonId: 0x11223344, arcRandom: ARC_RANDOM };
    const paket = buildAutoReconnectCookie(cookie);
    assert.equal(paket.toString('hex'), '1c000000' + '01000000' + '44332211' + VERIFIER_HEX);
  });
});

describe('Pruefwert nach MS-RDPBCGR 5.5', () => {
  test('SecurityVerifier = HMAC_MD5(ArcRandom, 32 Nullbytes) unter TLS/NLA', () => {
    assert.equal(computeSecurityVerifier(ARC_RANDOM).toString('hex'), VERIFIER_HEX);
  });

  test('Eine andere Zufallszahl ergibt einen anderen Pruefwert', () => {
    // openssl dgst -md5 -mac HMAC -macopt hexkey:ffeeddccbbaa99887766554433221100
    const schluessel = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
    assert.equal(
      computeSecurityVerifier(schluessel).toString('hex'),
      '2ced82e1827cbc19e91fd35ef8b43307',
    );
  });

  test('Die HMAC-Rechnung stimmt mit dem Testvektor aus RFC 2104 ueberein', () => {
    // Schluessel 16 mal 0x0b, Daten "Hi There" - der veroeffentlichte Wert.
    // Das belegt, dass geschluesselt und gehasht nicht vertauscht sind.
    const schluessel = Buffer.alloc(16, 0x0b);
    assert.equal(
      computeSecurityVerifier(schluessel, Buffer.from('Hi There', 'ascii')).toString('hex'),
      '9294727a3638bb1c13f48ef8158bfc9d',
    );
  });

  test('Eine Zufallszahl falscher Laenge wird abgelehnt', () => {
    assert.throws(() => computeSecurityVerifier(Buffer.alloc(8)), /16 Byte/);
  });
});

describe('Save Session Info PDU (MS-RDPBCGR 2.2.10.1.1)', () => {
  /**
   * Von Hand gesetzt, ab dem Feld infoType:
   *   infoType      = 0x00000003 (INFOTYPE_LOGON_EXTENDED_INFO)
   *   Length        = 0x0026 (2 + 4 + 4 + 28)
   *   FieldsPresent = 0x00000001 (LOGON_EX_AUTORECONNECTCOOKIE)
   *   cbFieldData   = 0x0000001c
   *   FieldData     = ARC_SC_PRIVATE_PACKET
   *   Pad           = 570 Nullbytes
   */
  const PDU_HEX = '03000000' + '2600' + '01000000' + '1c000000' + ARC_SC_HEX;

  test('Der Cookie wird aus dem Logon Info Extended herausgeloest', () => {
    const roh = Buffer.concat([Buffer.from(PDU_HEX, 'hex'), Buffer.alloc(570)]);
    const info = parseSaveSessionInfo(new BinaryReader(roh));
    assert.equal(info.infoType, INFOTYPE_LOGON_EXTENDED_INFO);
    assert.equal(info.fieldsPresent, LOGON_EX_AUTORECONNECTCOOKIE);
    assert.equal(info.autoReconnectCookie?.logonId, LOGON_ID);
    assert.equal(info.autoReconnectCookie?.arcRandom.toString('hex'), ARC_RANDOM_HEX);
  });

  test('Der eigene Aufbau ergibt genau diese Bytes', () => {
    const gebaut = buildSaveSessionInfoWithCookie({
      version: AUTO_RECONNECT_VERSION_1,
      logonId: LOGON_ID,
      arcRandom: ARC_RANDOM,
    });
    assert.equal(gebaut.subarray(0, PDU_HEX.length / 2).toString('hex'), PDU_HEX);
    assert.equal(gebaut.length, PDU_HEX.length / 2 + 570);
  });

  test('Eine reine Anmeldebestaetigung liefert keinen Cookie', () => {
    // INFOTYPE_LOGON mit Logon Info Version 1 dahinter - kein Cookie.
    const roh = Buffer.concat([Buffer.from('00000000', 'hex'), Buffer.alloc(100)]);
    const info = parseSaveSessionInfo(new BinaryReader(roh));
    assert.equal(info.infoType, INFOTYPE_LOGON);
    assert.equal(info.autoReconnectCookie, undefined);
  });

  test('Sind nur Anmeldefehler gemeldet, bleibt der Cookie leer', () => {
    const roh = Buffer.concat([
      Buffer.from('03000000' + '1200' + '02000000', 'hex'),
      Buffer.alloc(570),
    ]);
    const info = parseSaveSessionInfo(new BinaryReader(roh));
    assert.equal(info.fieldsPresent, LOGON_EX_LOGONERRORS);
    assert.equal(info.autoReconnectCookie, undefined);
  });

  test('Ein abgeschnittenes PDU kostet keine Sitzung', () => {
    // Cookie angekuendigt, Nutzdaten fehlen: kein Wurf, nur kein Cookie.
    const roh = Buffer.from('03000000' + '2600' + '01000000' + '1c000000' + '1c000000', 'hex');
    const info = parseSaveSessionInfo(new BinaryReader(roh));
    assert.equal(info.infoType, INFOTYPE_LOGON_EXTENDED_INFO);
    assert.equal(info.autoReconnectCookie, undefined);
  });
});

describe('Cookie im Client Info PDU (MS-RDPBCGR 2.2.1.11.1.1.1)', () => {
  const zugang = { domain: '', username: 'u', password: 'p' };

  test('Ohne Cookie endet das Paket wie bisher hinter performanceFlags', () => {
    const ohne = buildClientInfo(zugang);
    const mit = buildClientInfo({ ...zugang, autoReconnectCookie: Buffer.from(ARC_CS_HEX, 'hex') });
    // cbAutoReconnectCookie (2 Byte) plus die 28 Byte des Pakets.
    assert.equal(mit.length - ohne.length, 30);
    assert.equal(mit.subarray(0, ohne.length).toString('hex'), ohne.toString('hex'));
  });

  test('cbAutoReconnectCookie steht auf 0x001c, danach folgt das Paket', () => {
    const info = buildClientInfo({
      ...zugang,
      autoReconnectCookie: Buffer.from(ARC_CS_HEX, 'hex'),
    });
    const schwanz = info.subarray(info.length - 30);
    assert.equal(schwanz.readUInt16LE(0), 0x001c);
    assert.equal(schwanz.subarray(2).toString('hex'), ARC_CS_HEX);
  });

  test('Ein Cookie falscher Laenge wird abgelehnt', () => {
    assert.throws(
      () => buildClientInfo({ ...zugang, autoReconnectCookie: Buffer.alloc(20) }),
      /28 Byte/,
    );
  });
});

describe('Capability AUTORECONNECT_SUPPORTED (MS-RDPBCGR 2.2.7.1.1)', () => {
  function generalSatz(autoReconnect?: boolean): Buffer {
    const caps = buildClientCapabilities(
      { width: 800, height: 600, colorDepth: 32, keyboardLayout: 0x409 },
      autoReconnect === undefined ? {} : { autoReconnect },
    );
    const general = caps.find((c) => c.type === CAPSTYPE_GENERAL);
    assert.ok(general, 'Das General Capability Set muss enthalten sein');
    return general.data;
  }

  test('Ohne Auto-Reconnect bleibt der Satz Byte fuer Byte der alte', () => {
    // Die bisherige, vier Byte zu lange Fassung - hier festgenagelt, damit ein
    // Umbau nicht unbemerkt den Draht bestehender Verbindungen veraendert.
    assert.equal(generalSatz().toString('hex'), '010003000002000000000000050400000000000000000000');
    assert.equal(generalSatz(false).toString('hex'), generalSatz().toString('hex'));
  });

  test('Mit Auto-Reconnect steht extraFlags auf dem Offset der Spezifikation', () => {
    const satz = generalSatz(true);
    // Rumpf 20 Byte, mit Kopf also lengthCapability 24 (2.2.7.1.1);
    // extraFlags liegt auf Offset 10 des Rumpfes.
    assert.equal(satz.length, 20);
    const extraFlags = satz.readUInt16LE(10);
    assert.equal(extraFlags & AUTORECONNECT_SUPPORTED, AUTORECONNECT_SUPPORTED);
    assert.equal(satz.toString('hex'), '010003000002000000000d040000000000000000');
  });

  test('Ohne Auto-Reconnect ist das Flag nicht gesetzt', () => {
    assert.equal(generalSatz().readUInt16LE(12) & AUTORECONNECT_SUPPORTED, 0);
  });
});

describe('Rueckzug mit Streuung', () => {
  const ohneStreuung: BackoffOptions = {
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2,
    jitter: 0,
  };

  test('Die Wartezeit verdoppelt sich und laeuft in die Obergrenze', () => {
    const folge = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffWartezeit(n, ohneStreuung));
    assert.deepEqual(folge, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test('Die Streuung liegt genau im vereinbarten Band', () => {
    const mitStreuung: BackoffOptions = { ...ohneStreuung, jitter: 0.25 };
    // zufall() == 0.5 bedeutet keine Abweichung, 0 heisst minus 25 Prozent,
    // knapp 1 heisst plus 25 Prozent.
    assert.equal(backoffWartezeit(3, mitStreuung, () => 0.5), 4000);
    assert.equal(backoffWartezeit(3, mitStreuung, () => 0), 3000);
    assert.equal(backoffWartezeit(3, mitStreuung, () => 1), 5000);
  });

  test('Auch mit Streuung wird die Obergrenze nie ueberschritten', () => {
    const mitStreuung: BackoffOptions = { ...ohneStreuung, jitter: 0.5 };
    for (let versuch = 1; versuch <= 12; versuch++) {
      assert.ok(backoffWartezeit(versuch, mitStreuung, () => 1) <= 30000);
      assert.ok(backoffWartezeit(versuch, mitStreuung, () => 0) >= 0);
    }
  });

  test('Gedeckelt wird vor dem Streuen, nicht danach', () => {
    // Sonst laege die Streuung um einen Wert herum, den die Obergrenze
    // laengst verboten hat: 64000 statt 30000.
    const mitStreuung: BackoffOptions = { ...ohneStreuung, jitter: 0.25 };
    assert.equal(backoffWartezeit(7, mitStreuung, () => 0.5), 30000);
    assert.equal(backoffWartezeit(7, mitStreuung, () => 0), 22500);
  });

  test('Die Versuchsnummer zaehlt ab 1', () => {
    assert.throws(() => backoffWartezeit(0, ohneStreuung), RangeError);
  });
});

describe('Endgueltig beendete Sitzungen', () => {
  test('Abmeldung und Uebernahme schliessen eine Wiederholung aus', () => {
    assert.ok(SITZUNG_ENDGUELTIG_BEENDET.has(0x0000000c)); // LOGOFF_BY_USER
    assert.ok(SITZUNG_ENDGUELTIG_BEENDET.has(0x00000005)); // DISCONNECTED_BY_OTHERCONNECTION
    assert.ok(SITZUNG_ENDGUELTIG_BEENDET.has(0x00000003)); // IDLE_TIMEOUT
  });

  test('Ein Serverfehler ohne Sitzungsende bleibt wiederholbar', () => {
    assert.ok(!SITZUNG_ENDGUELTIG_BEENDET.has(0x00000006)); // OUT_OF_MEMORY
    assert.ok(!SITZUNG_ENDGUELTIG_BEENDET.has(0x0000000f)); // CLOSE_STACK_ON_DRIVER_NOT_READY
  });
});
