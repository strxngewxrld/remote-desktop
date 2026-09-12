import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import * as edisp from '../src/protocol/edisp.js';
import { RdpProtocolError } from '../src/core/errors.js';

/**
 * Die Bytefolgen in dieser Datei sind von Hand aus MS-RDPEDISP gerechnet, nicht
 * vom Code erzeugt. Sie duerfen deshalb nie an den Code angepasst werden - wenn
 * sie brechen, ist der Code falsch, nicht der Test.
 */
describe('MS-RDPEDISP - DISPLAYCONTROL_CAPS_PDU', () => {
  // 2.2.2.1: Header (Type 0x00000005, Length 20) + MaxNumMonitors +
  // MaxMonitorAreaFactorA + MaxMonitorAreaFactorB, alles 32 Bit Little Endian.
  //   Type              5  -> 05 00 00 00
  //   Length           20  -> 14 00 00 00   (8 Byte Kopf + 3 * 4 Byte)
  //   MaxNumMonitors   16  -> 10 00 00 00
  //   AreaFactorA    3840  -> 00 0f 00 00
  //   AreaFactorB    2400  -> 60 09 00 00
  const CAPS_BYTES = Buffer.from('050000001400000010000000000f00006009 0000'.replace(/ /g, ''), 'hex');

  test('Ein von Hand gerechnetes CAPS-PDU wird richtig gelesen', () => {
    const caps = edisp.parseCapsPdu(CAPS_BYTES);
    assert.equal(caps.maxNumMonitors, 16);
    assert.equal(caps.maxMonitorAreaFactorA, 3840);
    assert.equal(caps.maxMonitorAreaFactorB, 2400);
  });

  test('Der Kopf traegt Typ 5 und die Gesamtlaenge einschliesslich seiner selbst', () => {
    const kopf = edisp.parseDisplayControlHeader(CAPS_BYTES);
    assert.equal(kopf.type, edisp.DISPLAYCONTROL_PDU_TYPE_CAPS);
    // 2.2.1.1: "This value MUST include the length of the DISPLAYCONTROL_HEADER".
    assert.equal(kopf.length, CAPS_BYTES.length);
    assert.equal(kopf.length, 20);
  });

  test('Gebautes und gerechnetes CAPS-PDU sind Byte fuer Byte gleich', () => {
    const gebaut = edisp.buildCapsPdu({
      maxNumMonitors: 16,
      maxMonitorAreaFactorA: 3840,
      maxMonitorAreaFactorB: 2400,
    });
    assert.deepEqual(gebaut, CAPS_BYTES);
  });

  test('Die Flaechengrenze ist das Produkt aller drei Felder', () => {
    // 2.2.2.1 rechnet ausdruecklich MaxNumMonitors * A * B - die Stueckzahl
    // geht also mit ein. Wer nur A * B nimmt, verschenkt den Faktor 16.
    assert.equal(edisp.maximaleGesamtflaeche(edisp.parseCapsPdu(CAPS_BYTES)), 16 * 3840 * 2400);
  });

  test('Ein PDU mit falschem Typ wird abgelehnt, nicht fehlgedeutet', () => {
    const falsch = Buffer.from(CAPS_BYTES);
    falsch.writeUInt32LE(edisp.DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT, 0);
    assert.throws(() => edisp.parseCapsPdu(falsch), RdpProtocolError);
  });

  test('Ein abgeschnittenes CAPS-PDU wirft, statt Nullen zu erfinden', () => {
    assert.throws(() => edisp.parseCapsPdu(CAPS_BYTES.subarray(0, 16)), RdpProtocolError);
    assert.throws(() => edisp.parseCapsPdu(Buffer.alloc(4)), RdpProtocolError);
  });
});

describe('MS-RDPEDISP - DISPLAYCONTROL_MONITOR_LAYOUT_PDU', () => {
  // 2.2.2.2 mit einer DISPLAYCONTROL_MONITOR_LAYOUT (2.2.2.2.1) fuer 1920x1080:
  //   Type                  2 -> 02 00 00 00
  //   Length               56 -> 38 00 00 00   (8 Kopf + 4 + 4 + 40)
  //   MonitorLayoutSize    40 -> 28 00 00 00   (2.2.2.2: MUST be 40)
  //   NumMonitors           1 -> 01 00 00 00
  //   Flags                 1 -> 01 00 00 00   (DISPLAYCONTROL_MONITOR_PRIMARY)
  //   Left                  0 -> 00 00 00 00
  //   Top                   0 -> 00 00 00 00
  //   Width              1920 -> 80 07 00 00
  //   Height             1080 -> 38 04 00 00
  //   PhysicalWidth         0 -> 00 00 00 00   (ausserhalb 10..10000 = ignorieren)
  //   PhysicalHeight        0 -> 00 00 00 00
  //   Orientation           0 -> 00 00 00 00   (ORIENTATION_LANDSCAPE)
  //   DesktopScaleFactor  100 -> 64 00 00 00
  //   DeviceScaleFactor   100 -> 64 00 00 00
  const EIN_MONITOR = Buffer.from(
    [
      '02000000',
      '38000000',
      '28000000',
      '01000000',
      '01000000',
      '00000000',
      '00000000',
      '80070000',
      '38040000',
      '00000000',
      '00000000',
      '00000000',
      '64000000',
      '64000000',
    ].join(''),
    'hex',
  );

  test('Ein einzelner primaerer Monitor ergibt genau die gerechneten 56 Byte', () => {
    const pdu = edisp.buildMonitorLayoutPdu([edisp.primaerMonitor(1920, 1080)]);
    assert.equal(pdu.length, 56);
    assert.deepEqual(pdu, EIN_MONITOR);
  });

  test('Die Gesamtlaenge im Kopf ist 16 + 40 je Monitor', () => {
    const kopf = edisp.parseDisplayControlHeader(EIN_MONITOR);
    assert.equal(kopf.type, edisp.DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT);
    assert.equal(kopf.length, edisp.DISPLAYCONTROL_HEADER_LAENGE + 8 + edisp.MONITOR_LAYOUT_LAENGE);
    assert.equal(kopf.length, EIN_MONITOR.length);
  });

  test('Das gerechnete PDU laesst sich wieder in Felder zerlegen', () => {
    const [m] = edisp.parseMonitorLayoutPdu(EIN_MONITOR);
    assert.equal(m.flags, edisp.DISPLAYCONTROL_MONITOR_PRIMARY);
    assert.equal(m.left, 0);
    assert.equal(m.top, 0);
    assert.equal(m.width, 1920);
    assert.equal(m.height, 1080);
    assert.equal(m.physicalWidth, 0);
    assert.equal(m.physicalHeight, 0);
    assert.equal(m.orientation, edisp.ORIENTATION_LANDSCAPE);
    assert.equal(m.desktopScaleFactor, 100);
    assert.equal(m.deviceScaleFactor, 100);
  });

  test('MonitorLayoutSize steht fest auf 40', () => {
    // 2.2.2.2: "This field MUST be set to 40 bytes". Ein Server, der hier etwas
    // anderes liest, bricht die Verbindung ab.
    assert.equal(EIN_MONITOR.readUInt32LE(8), 40);
    const zwei = edisp.buildMonitorLayoutPdu([edisp.primaerMonitor(1024, 768), edisp.primaerMonitor(800, 600)]);
    assert.equal(zwei.readUInt32LE(8), 40);
  });

  test('Ein zweiter Monitor links vom primaeren bekommt ein negatives Left im Zweierkomplement', () => {
    // Left = -1920: 0x100000000 - 0x780 = 0xFFFFF880, Little Endian 80 f8 ff ff.
    const links: edisp.MonitorLayout = { ...edisp.primaerMonitor(1920, 1080), flags: 0, left: -1920, top: 0 };
    const pdu = edisp.buildMonitorLayoutPdu([edisp.primaerMonitor(1920, 1080), links]);
    assert.equal(pdu.length, 96);
    assert.equal(pdu.readUInt32LE(4), 96);
    assert.equal(pdu.readUInt32LE(12), 2);
    // Zweiter Monitor beginnt bei 16 + 40 = 56, sein Left liegt vier Byte weiter.
    assert.equal(pdu.subarray(60, 64).toString('hex'), '80f8ffff');
    assert.equal(edisp.parseMonitorLayoutPdu(pdu)[1].left, -1920);
  });

  test('Eine Anordnung ohne Monitore gibt es nicht', () => {
    assert.throws(() => edisp.buildMonitorLayoutPdu([]), RdpProtocolError);
  });

  test('Ein PDU, das weniger Monitore mitbringt als es ankuendigt, wirft', () => {
    const verkuerzt = Buffer.from(EIN_MONITOR);
    verkuerzt.writeUInt32LE(3, 12); // NumMonitors luegt
    assert.throws(() => edisp.parseMonitorLayoutPdu(verkuerzt), RdpProtocolError);
  });
});

describe('MS-RDPEDISP - Grenzen der Spezifikation', () => {
  test('Die Breite wird auf gerade Werte abgerundet', () => {
    // 2.2.2.2.1: Width "MUST NOT be an odd value".
    assert.equal(edisp.begrenzeMonitorGroesse(1367, 768).width, 1366);
    assert.equal(edisp.begrenzeMonitorGroesse(1366, 768).width, 1366);
  });

  test('Die Hoehe darf ungerade bleiben', () => {
    // Die Forderung "nicht ungerade" steht in 2.2.2.2.1 ausschliesslich bei
    // Width. Eine Hoehe zusaetzlich abzurunden waere eine erfundene Regel.
    assert.equal(edisp.begrenzeMonitorGroesse(1920, 1081).height, 1081);
  });

  test('Zu kleine Werte werden auf 200 angehoben', () => {
    const klein = edisp.begrenzeMonitorGroesse(40, 12);
    assert.deepEqual(klein, { width: 200, height: 200 });
  });

  test('Zu grosse Werte werden auf 8192 gedeckelt, und 8192 ist gerade', () => {
    const gross = edisp.begrenzeMonitorGroesse(99999, 99999);
    assert.deepEqual(gross, { width: 8192, height: 8192 });
  });

  test('Ein ungueltiger DeviceScaleFactor wird auf den naechsten erlaubten gezogen', () => {
    // 2.2.2.2.1: nur 100, 140 oder 180. Alles andere laesst den Server *beide*
    // Skalierungsfelder verwerfen - deshalb nie ungeprueft durchreichen.
    assert.equal(edisp.naechsterDeviceScaleFactor(100), 100);
    assert.equal(edisp.naechsterDeviceScaleFactor(140), 140);
    assert.equal(edisp.naechsterDeviceScaleFactor(180), 180);
    assert.equal(edisp.naechsterDeviceScaleFactor(150), 140);
    assert.equal(edisp.naechsterDeviceScaleFactor(200), 180);
    assert.equal(edisp.naechsterDeviceScaleFactor(0), 100);
  });

  test('DesktopScaleFactor bleibt zwischen 100 und 500 Prozent', () => {
    assert.equal(edisp.primaerMonitor(800, 600, { desktopScaleFactor: 50 }).desktopScaleFactor, 100);
    assert.equal(edisp.primaerMonitor(800, 600, { desktopScaleFactor: 900 }).desktopScaleFactor, 500);
    assert.equal(edisp.primaerMonitor(800, 600, { desktopScaleFactor: 200 }).desktopScaleFactor, 200);
  });

  test('Der primaere Monitor sitzt bei (0, 0) und traegt das Primaer-Flag', () => {
    const m = edisp.primaerMonitor(1280, 800);
    assert.equal(m.left, 0);
    assert.equal(m.top, 0);
    assert.equal(m.flags & edisp.DISPLAYCONTROL_MONITOR_PRIMARY, edisp.DISPLAYCONTROL_MONITOR_PRIMARY);
  });

  test('Zu viele Monitore werden gegen MaxNumMonitors erkannt', () => {
    const caps = { maxNumMonitors: 1, maxMonitorAreaFactorA: 8192, maxMonitorAreaFactorB: 8192 };
    const zwei = [edisp.primaerMonitor(800, 600), edisp.primaerMonitor(800, 600)];
    assert.match(edisp.pruefeAnordnung(zwei, caps) ?? '', /hoechstens 1/);
    assert.equal(edisp.pruefeAnordnung([zwei[0]], caps), undefined);
  });

  test('Eine zu grosse Gesamtflaeche wird erkannt', () => {
    // 1 * 100 * 100 = 10000 Quadratpixel erlaubt; 200x200 sind 40000.
    const caps = { maxNumMonitors: 1, maxMonitorAreaFactorA: 100, maxMonitorAreaFactorB: 100 };
    assert.match(edisp.pruefeAnordnung([edisp.primaerMonitor(200, 200)], caps) ?? '', /Gesamtflaeche/);
  });

  test('Ohne Caps wird nur gegen die Feldgrenzen geprueft', () => {
    assert.equal(edisp.pruefeAnordnung([edisp.primaerMonitor(1920, 1080)]), undefined);
    const ungerade: edisp.MonitorLayout = { ...edisp.primaerMonitor(1920, 1080), width: 1921 };
    assert.match(edisp.pruefeAnordnung([ungerade]) ?? '', /ungerade/);
  });

  test('Der Kanalname steht genau so in der Spezifikation', () => {
    // 2.1 - ein Tippfehler hier bleibt sonst bis zum echten Server unbemerkt.
    assert.equal(edisp.DISPLAY_CONTROL_CHANNEL_NAME, 'Microsoft::Windows::RDS::DisplayControl');
  });
});
