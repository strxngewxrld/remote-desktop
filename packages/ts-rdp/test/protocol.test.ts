import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { BinaryReader, BinaryWriter } from '../src/core/binary.js';
import { buildConnectionRequest, parseConnectionConfirm } from '../src/protocol/x224.js';
import { buildConferenceCreateRequest, buildClientData, parseServerData } from '../src/protocol/gcc.js';
import * as mcs from '../src/protocol/mcs.js';
import * as pdu from '../src/protocol/pdu.js';
import * as ber from '../src/protocol/ber.js';
import { buildClientCapabilities, serializeCapabilities, parseCapabilities } from '../src/protocol/caps.js';
import { buildClientInfo } from '../src/protocol/sec.js';
import { parseBitmapUpdate } from '../src/protocol/updates.js';
import { parseFrame, tpkt, tpktRaw } from '../src/protocol/transport.js';
import { PROTOCOL_HYBRID, PROTOCOL_SSL } from '../src/protocol/constants.js';
import { lookupScancode } from '../src/protocol/keymap.js';

describe('BinaryReader/BinaryWriter', () => {
  test('Endianness wird eingehalten', () => {
    const buf = new BinaryWriter().uint16le(0x1234).uint16be(0x1234).uint32le(0xdeadbeef).toBuffer();
    assert.equal(buf.toString('hex'), '34121234efbeadde');
    const r = new BinaryReader(buf);
    assert.equal(r.uint16le(), 0x1234);
    assert.equal(r.uint16be(), 0x1234);
    assert.equal(r.uint32le(), 0xdeadbeef);
    assert.equal(r.remaining, 0);
  });

  test('UTF-16-Strings mit fester Laenge werden aufgefuellt und beschnitten', () => {
    const buf = new BinaryWriter().utf16le('PC', 32).toBuffer();
    assert.equal(buf.length, 32);
    assert.equal(new BinaryReader(buf).utf16le(32), 'PC');
  });

  test('Lesen ueber das Ende wirft einen Fehler', () => {
    const r = new BinaryReader(Buffer.alloc(2));
    assert.throws(() => r.uint32le(), RangeError);
  });
});

describe('X.224-Aushandlung', () => {
  test('Connection Request enthaelt die angeforderten Protokolle', () => {
    const req = buildConnectionRequest({ requestedProtocols: PROTOCOL_SSL | PROTOCOL_HYBRID });
    assert.equal(req[0], req.length - 1, 'li muss die Restlaenge angeben');
    assert.equal(req[1], 0xe0, 'TPDU-Code fuer Connection Request');
    const neg = req.subarray(req.length - 8);
    assert.equal(neg[0], 0x01, 'RDP_NEG_REQ');
    assert.equal(neg.readUInt16LE(2), 8);
    assert.equal(neg.readUInt32LE(4), 3);
  });

  test('Cookie wird vor die Negotiation-Struktur gesetzt', () => {
    const req = buildConnectionRequest({ requestedProtocols: PROTOCOL_SSL, cookie: 'admin' });
    assert.ok(req.includes(Buffer.from('Cookie: mstshash=admin\r\n', 'ascii')));
  });

  test('Connection Confirm liefert das gewaehlte Protokoll', () => {
    const confirm = Buffer.from([0x0e, 0xd0, 0, 0, 0, 0, 0, 0x02, 0x00, 0x08, 0x00, 0x02, 0x00, 0x00, 0x00]);
    assert.deepEqual(parseConnectionConfirm(confirm), { selectedProtocol: PROTOCOL_HYBRID, flags: 0 });
  });

  test('Negotiation Failure wird als verstaendlicher Fehler gemeldet', () => {
    const failure = Buffer.from([0x0e, 0xd0, 0, 0, 0, 0, 0, 0x03, 0x00, 0x08, 0x00, 0x05, 0x00, 0x00, 0x00]);
    assert.throws(() => parseConnectionConfirm(failure), /HYBRID_REQUIRED_BY_SERVER/);
  });

  test('Antwort ohne Negotiation-Struktur bedeutet Standard-RDP-Security', () => {
    const confirm = Buffer.from([0x06, 0xd0, 0, 0, 0, 0, 0]);
    assert.equal(parseConnectionConfirm(confirm).selectedProtocol, 0);
  });
});

describe('GCC / T.124', () => {
  test('Conference Create Request beginnt mit dem T.124-Identifier', () => {
    const ccr = buildConferenceCreateRequest(Buffer.alloc(20));
    assert.equal(ccr.subarray(0, 7).toString('hex'), '000500147c0001');
    // Nach der Laenge folgt die feste Praeambel mit dem "Duca"-Schluessel.
    const idx = ccr.indexOf(Buffer.from('Duca', 'ascii'));
    assert.ok(idx > 0);
    // choice(0) selection(0x08) numericString("1") padding numberOfSet(1) choice(0xc0) laenge(0)
    assert.equal(ccr.subarray(idx - 8, idx).toString('hex'), '000800100001c000');
  });

  test('Clientdatenbloecke tragen Typ und Laenge im Kopf', () => {
    const data = buildClientData(
      { width: 1024, height: 768, colorDepth: 16, keyboardLayout: 0x407, clientName: 'test', selectedProtocol: 3 },
      [],
    );
    assert.equal(data.readUInt16LE(0), 0xc001, 'CS_CORE zuerst');
    const coreLength = data.readUInt16LE(2);
    assert.equal(data.readUInt32LE(4), 0x00080004, 'RDP-Version 5+');
    assert.equal(data.readUInt16LE(8), 1024);
    assert.equal(data.readUInt16LE(10), 768);
    assert.equal(data.readUInt16LE(coreLength), 0xc004, 'danach CS_CLUSTER');
  });

  test('Serverdatenbloecke werden gelesen', () => {
    const sc = Buffer.concat([
      new BinaryWriter().uint16le(0x0c01).uint16le(16).uint32le(0x00080004).uint32le(3).uint32le(0).toBuffer(),
      new BinaryWriter().uint16le(0x0c03).uint16le(12).uint16le(1003).uint16le(2).uint16le(1004).uint16le(1005).toBuffer(),
    ]);
    const parsed = parseServerData(sc);
    assert.equal(parsed.core?.version, 0x00080004);
    assert.deepEqual(parsed.network, { mcsChannelId: 1003, channelIds: [1004, 1005] });
  });
});

describe('MCS', () => {
  test('Connect Initial ist BER-kodiert mit Application-Tag 101', () => {
    const initial = mcs.buildConnectInitial(Buffer.alloc(50));
    assert.equal(initial[0], 0x7f);
    assert.equal(initial[1], 101);
  });

  test('Connect Response wird geparst', () => {
    const userData = Buffer.from('GCC-Nutzdaten');
    const response = ber.wrapApplication(
      102,
      ber.writeEnumerated(0),
      ber.writeInteger(0),
      ber.writeSequence(ber.writeInteger(34), ber.writeInteger(3)),
      ber.writeOctetString(userData),
    );
    assert.ok(mcs.parseConnectResponse(response).equals(userData));
  });

  test('Connect Response mit Fehlerergebnis wirft', () => {
    const response = ber.wrapApplication(
      102,
      ber.writeEnumerated(1),
      ber.writeInteger(0),
      ber.writeSequence(ber.writeInteger(1)),
      ber.writeOctetString(Buffer.alloc(0)),
    );
    assert.throws(() => mcs.parseConnectResponse(response), /Ergebnis 1/);
  });

  test('AttachUserConfirm liefert die Benutzer-ID', () => {
    // Opcode 11<<2|2 = 0x2e, Ergebnis 0, Initiator 1007-1001 = 6
    const payload = Buffer.from([0x2e, 0x00, 0x00, 0x06]);
    assert.equal(mcs.parseAttachUserConfirm(payload), 1007);
  });

  test('SendDataRequest/Indication sind zueinander symmetrisch', () => {
    const data = Buffer.from('Nutzlast fuer den globalen Kanal');
    const request = mcs.buildSendDataRequest(1007, 1003, data);
    // Request (25<<2 = 0x64) in Indication (26<<2 = 0x68) umwandeln
    const indication = Buffer.from(request);
    indication[0] = 26 << 2;
    const parsed = mcs.parseSendDataIndication(indication);
    assert.equal(parsed?.userId, 1007);
    assert.equal(parsed?.channelId, 1003);
    assert.ok(parsed?.payload.equals(data));
  });

  test('Nutzlasten ueber 127 Byte nutzen die zweibyteige Laenge', () => {
    const data = Buffer.alloc(400, 0x41);
    const parsed = mcs.parseSendDataIndication(
      Buffer.concat([Buffer.from([26 << 2]), mcs.buildSendDataRequest(1007, 1003, data).subarray(1)]),
    );
    assert.equal(parsed?.payload.length, 400);
  });

  test('DisconnectProviderUltimatum wird als Verbindungsende gemeldet', () => {
    assert.equal(mcs.parseSendDataIndication(Buffer.from([8 << 2, 0x00])), undefined);
  });

  test('ChannelJoinConfirm wird geprueft', () => {
    const payload = Buffer.from([0x3e, 0x00, 0x00, 0x06, 0x03, 0xeb, 0x03, 0xeb]);
    assert.deepEqual(mcs.parseChannelJoinConfirm(payload), { userId: 1007, channelId: 1003 });
  });
});

describe('Share-PDUs', () => {
  test('Confirm Active traegt Share-ID und Capabilities', () => {
    const caps = buildClientCapabilities({ width: 800, height: 600, colorDepth: 16, keyboardLayout: 0x409 });
    const confirm = pdu.buildConfirmActive(0x12345678, 1007, caps);
    const r = new BinaryReader(confirm);
    const header = pdu.readShareControlHeader(r);
    assert.equal(header.pduType, 3, 'PDUTYPE_CONFIRMACTIVEPDU');
    assert.equal(header.pduSource, 1007);
    assert.equal(header.totalLength, confirm.length);
    assert.equal(r.uint32le(), 0x12345678);
    assert.equal(r.uint16le(), 0x03ea);
  });

  test('Capabilities ueberstehen Serialisieren und Parsen', () => {
    const caps = buildClientCapabilities({ width: 1024, height: 768, colorDepth: 16, keyboardLayout: 0x407 });
    const parsed = parseCapabilities(new BinaryReader(serializeCapabilities(caps)), caps.length);
    assert.equal(parsed.raw.size, caps.length);
    assert.equal(parsed.desktopWidth, 1024);
    assert.equal(parsed.desktopHeight, 768);
    assert.equal(parsed.preferredBitsPerPixel, 16);
  });

  test('Demand Active wird korrekt zerlegt', () => {
    const caps = buildClientCapabilities({ width: 1920, height: 1080, colorDepth: 16, keyboardLayout: 0x409 });
    const capsBuf = serializeCapabilities(caps);
    const source = Buffer.from('RDP\0', 'ascii');
    const body = new BinaryWriter()
      .uint32le(0xabcdef01)
      .uint16le(source.length)
      .uint16le(capsBuf.length + 4)
      .bytes(source)
      .uint16le(caps.length)
      .uint16le(0)
      .bytes(capsBuf)
      .toBuffer();
    const demand = pdu.parseDemandActive(new BinaryReader(body));
    assert.equal(demand.shareId, 0xabcdef01);
    assert.equal(demand.sourceDescriptor, 'RDP');
    assert.equal(demand.capabilities.desktopWidth, 1920);
  });

  test('Eingabe-PDU kodiert Mausereignisse', () => {
    const input = pdu.buildInputPdu(1, 1007, [pdu.mouseEvent(0x0800, 640, 480)]);
    const r = new BinaryReader(input);
    pdu.readShareControlHeader(r);
    const data = pdu.readShareDataHeader(r);
    assert.equal(data.pduType2, 0x1c, 'PDUTYPE2_INPUT');
    assert.equal(r.uint16le(), 1, 'ein Ereignis');
    r.uint16le();
    r.uint32le(); // eventTime
    assert.equal(r.uint16le(), 0x8001, 'INPUT_EVENT_MOUSE');
    assert.equal(r.uint16le(), 0x0800);
    assert.equal(r.uint16le(), 640);
    assert.equal(r.uint16le(), 480);
  });

  test('Share Control Header wird von einem Security Header unterschieden', () => {
    const sync = pdu.buildSynchronize(1, 1007, 0x3ea);
    assert.ok(pdu.looksLikeShareControl(sync));
    // Lizenz-PDU: Security Header mit SEC_LICENSE_PKT
    const license = Buffer.from([0x80, 0x00, 0x00, 0x00, 0xff, 0x03, 0x10, 0x00]);
    assert.equal(pdu.looksLikeShareControl(license), false);
  });
});

describe('Client Info PDU', () => {
  test('Laengenfelder zaehlen ohne Nullterminator', () => {
    const info = buildClientInfo({ domain: 'CONTOSO', username: 'admin', password: 'pw' });
    const r = new BinaryReader(info);
    r.uint32le(); // codePage
    const flags = r.uint32le();
    assert.ok(flags & 0x10, 'INFO_UNICODE gesetzt');
    assert.ok(flags & 0x08, 'INFO_AUTOLOGON gesetzt');
    assert.equal(r.uint16le(), 14, 'CONTOSO = 7 Zeichen * 2 Byte');
    assert.equal(r.uint16le(), 10, 'admin');
    assert.equal(r.uint16le(), 4, 'pw');
  });

  test('Passwort steht als UTF-16 mit Terminator im Paket', () => {
    const info = buildClientInfo({ domain: '', username: 'u', password: 'geheim' });
    assert.ok(info.includes(Buffer.from('geheim\0', 'ucs2')));
  });
});

describe('Bitmap-Update', () => {
  test('Rechtecke mit Kompressionskopf werden gelesen', () => {
    const data = Buffer.from('0102030405', 'hex');
    const update = new BinaryWriter()
      .uint16le(1)
      .uint16le(10) // destLeft
      .uint16le(20) // destTop
      .uint16le(73) // destRight
      .uint16le(83) // destBottom
      .uint16le(64)
      .uint16le(64)
      .uint16le(16)
      .uint16le(0x0001) // BITMAP_COMPRESSION ohne NO_BITMAP_COMPRESSION_HDR
      .uint16le(data.length + 8)
      .uint16le(0) // cbCompFirstRowSize
      .uint16le(data.length) // cbCompMainBodySize
      .uint16le(128) // cbScanWidth
      .uint16le(8192) // cbUncompressedSize
      .bytes(data)
      .toBuffer();

    const rects = parseBitmapUpdate(new BinaryReader(update));
    assert.equal(rects.length, 1);
    assert.equal(rects[0].destLeft, 10);
    assert.equal(rects[0].width, 64);
    assert.equal(rects[0].compressed, true);
    assert.ok(rects[0].data.equals(data), 'Kompressionskopf wird uebersprungen');
  });

  test('Unkomprimierte Rechtecke behalten ihre Nutzdaten', () => {
    const data = Buffer.alloc(32, 0x7f);
    const update = new BinaryWriter()
      .uint16le(1)
      .uint16le(0).uint16le(0).uint16le(3).uint16le(3)
      .uint16le(4).uint16le(4).uint16le(16)
      .uint16le(0)
      .uint16le(data.length)
      .bytes(data)
      .toBuffer();
    const rects = parseBitmapUpdate(new BinaryReader(update));
    assert.equal(rects[0].compressed, false);
    assert.equal(rects[0].data.length, 32);
  });
});

describe('TPKT-Rahmen', () => {
  test('tpkt() setzt Laenge und X.224-Datenkopf', () => {
    const frame = tpkt(Buffer.alloc(10));
    assert.equal(frame[0], 3);
    assert.equal(frame.readUInt16BE(2), 17);
    assert.equal(frame.subarray(4, 7).toString('hex'), '02f080');
    assert.equal(parseFrame(frame).payload.length, 13);
  });

  test('tpktRaw() laesst den X.224-Datenkopf weg', () => {
    const frame = tpktRaw(Buffer.alloc(10));
    assert.equal(frame.readUInt16BE(2), 14);
  });

  test('Fastpath-Rahmen werden am ersten Byte erkannt', () => {
    const short = Buffer.from([0x00, 0x05, 1, 2, 3]);
    assert.deepEqual(parseFrame(short), { fastpath: true, flags: 0, payload: Buffer.from([1, 2, 3]) });
    const long = Buffer.from([0x00, 0x81, 0x04, 9]);
    assert.equal(parseFrame(long).fastpath, true);
    assert.equal(parseFrame(long).payload.length, 1);
  });
});

describe('Tastaturzuordnung', () => {
  test('Buchstaben liefern Set-1-Scancodes', () => {
    assert.deepEqual(lookupScancode('KeyA'), { code: 0x1e });
    assert.deepEqual(lookupScancode('KeyZ'), { code: 0x2c });
    assert.deepEqual(lookupScancode('Escape'), { code: 0x01 });
  });

  test('Navigationstasten sind als erweitert markiert', () => {
    assert.deepEqual(lookupScancode('ArrowUp'), { code: 0x48, extended: true });
    assert.deepEqual(lookupScancode('Delete'), { code: 0x53, extended: true });
    assert.deepEqual(lookupScancode('ControlRight'), { code: 0x1d, extended: true });
  });

  test('Unbekannte Tasten liefern undefined', () => {
    assert.equal(lookupScancode('SuperFancyKey'), undefined);
  });
});
