import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { BinaryWriter } from '../src/core/binary.js';
import * as egfx from '../src/protocol/egfx.js';

/** Prueft die cmdId und verengt den Union-Typ auf die passende Nachricht. */
type PduMit<C extends number> = Extract<egfx.EgfxPdu, { cmdId: C }>;
function erwarte<C extends number>(p: egfx.EgfxPdu, cmdId: C): PduMit<C> {
  assert.equal(p.cmdId, cmdId);
  return p as PduMit<C>;
}

/** Baut ein PDU mit RDPGFX_HEADER (2.2.1.5) um einen fertigen Rumpf herum. */
function pdu(cmdId: number, body: Buffer, pduLengthUeberschreiben?: number): Buffer {
  return new BinaryWriter()
    .uint16le(cmdId)
    .uint16le(0)
    .uint32le(pduLengthUeberschreiben ?? 8 + body.length)
    .bytes(body)
    .toBuffer();
}

function startFrame(frameId: number, timestamp = 0): Buffer {
  return pdu(egfx.RDPGFX_CMDID_STARTFRAME, new BinaryWriter().uint32le(timestamp).uint32le(frameId).toBuffer());
}

function endFrame(frameId: number): Buffer {
  return pdu(egfx.RDPGFX_CMDID_ENDFRAME, new BinaryWriter().uint32le(frameId).toBuffer());
}

function wireToSurface1(bitmapData: Buffer): Buffer {
  const body = new BinaryWriter()
    .uint16le(7) // surfaceId
    .uint16le(egfx.RDPGFX_CODECID_PLANAR)
    .uint8(egfx.PIXEL_FORMAT_XRGB_8888)
    .uint16le(10) // left
    .uint16le(20) // top
    .uint16le(110) // right
    .uint16le(70) // bottom
    .uint32le(bitmapData.length)
    .bytes(bitmapData)
    .toBuffer();
  return pdu(egfx.RDPGFX_CMDID_WIRETOSURFACE_1, body);
}

describe('EGFX-Kopf und Stromzerlegung (MS-RDPEGFX 2.2.1.5)', () => {
  test('Ein Strom mit mehreren PDUs wird vollständig zerlegt', () => {
    const strom = Buffer.concat([startFrame(42, 0x1234), wireToSurface1(Buffer.from('bild')), endFrame(42)]);
    const pdus = egfx.parseEgfxPdus(strom);
    assert.equal(pdus.length, 3);
    assert.deepEqual(pdus.map((p) => p.cmdId), [
      egfx.RDPGFX_CMDID_STARTFRAME,
      egfx.RDPGFX_CMDID_WIRETOSURFACE_1,
      egfx.RDPGFX_CMDID_ENDFRAME,
    ]);
  });

  test('Ein abgeschnittenes PDU am Stromende wird als Protokollfehler gemeldet', () => {
    const vollstaendig = Buffer.concat([startFrame(1), wireToSurface1(Buffer.alloc(16, 0xaa))]);
    const gekuerzt = vollstaendig.subarray(0, vollstaendig.length - 3);
    assert.throws(() => egfx.parseEgfxPdus(gekuerzt), /abgeschnitten/);
  });

  test('Ein angeschnittener Kopf am Stromende wird gemeldet', () => {
    const strom = Buffer.concat([endFrame(1), Buffer.from([0x0c, 0x00, 0x00])]);
    assert.throws(() => egfx.parseEgfxPdus(strom), /abgeschnittener Kopf/);
  });

  test('Eine pduLength kleiner als der Kopf wird abgewiesen', () => {
    const kaputt = pdu(egfx.RDPGFX_CMDID_ENDFRAME, new BinaryWriter().uint32le(1).toBuffer(), 4);
    assert.throws(() => egfx.parseEgfxPdus(kaputt), /kleiner als der Kopf/);
  });

  test('Eine unbekannte cmdId bricht den Strom nicht ab, sondern kommt als raw zurück', () => {
    const unbekannt = pdu(0x00ff, Buffer.from([1, 2, 3, 4]));
    const pdus = egfx.parseEgfxPdus(Buffer.concat([startFrame(5), unbekannt, endFrame(5)]));
    assert.equal(pdus.length, 3);
    const mitte = pdus[1];
    assert.equal(mitte.cmdId, 0x00ff);
    assert.ok('raw' in mitte);
    // raw traegt das komplette PDU inklusive Kopf, damit man es loggen kann.
    assert.equal(mitte.raw.length, 12);
    assert.ok(mitte.raw.equals(unbekannt));
  });

  test('Der Parser läuft an pduLength entlang, nicht an den gelesenen Bytes', () => {
    // RESETGRAPHICS ist mit Padding auf 340 Byte aufgefuellt; das darauf folgende
    // PDU wird nur gefunden, wenn das Padding korrekt uebersprungen wird.
    const strom = Buffer.concat([resetGraphics(), endFrame(9)]);
    const pdus = egfx.parseEgfxPdus(strom);
    assert.equal(pdus.length, 2);
    assert.equal(pdus[1].cmdId, egfx.RDPGFX_CMDID_ENDFRAME);
  });
});

function resetGraphics(): Buffer {
  const kopfUndDaten = new BinaryWriter()
    .uint32le(1920)
    .uint32le(1080)
    .uint32le(1)
    .uint32le(0)
    .uint32le(0)
    .uint32le(1919)
    .uint32le(1079)
    .uint32le(0x00000001) // TS_MONITOR_PRIMARY
    .toBuffer();
  // Das PDU muss laut 2.2.2.14 exakt 340 Byte gross sein.
  const padding = Buffer.alloc(340 - 8 - kopfUndDaten.length);
  return pdu(egfx.RDPGFX_CMDID_RESETGRAPHICS, Buffer.concat([kopfUndDaten, padding]), 340);
}

describe('EGFX-Nachrichten der Serverrichtung', () => {
  test('WIRETOSURFACE_1 liefert Codec, Pixelformat, Zielrechteck und Bilddaten', () => {
    const daten = Buffer.from('abcdefgh');
    const p = erwarte(egfx.parseEgfxPdus(wireToSurface1(daten))[0], egfx.RDPGFX_CMDID_WIRETOSURFACE_1);
    assert.equal(p.surfaceId, 7);
    assert.equal(p.codecId, egfx.RDPGFX_CODECID_PLANAR);
    assert.equal(p.pixelFormat, 0x20);
    assert.deepEqual(p.destRect, { left: 10, top: 20, right: 110, bottom: 70 });
    assert.ok(p.bitmapData.equals(daten));
  });

  test('Eine gelogene bitmapDataLength führt zum Protokollfehler statt zum RangeError', () => {
    const body = new BinaryWriter()
      .uint16le(1)
      .uint16le(egfx.RDPGFX_CODECID_UNCOMPRESSED)
      .uint8(egfx.PIXEL_FORMAT_ARGB_8888)
      .uint16le(0).uint16le(0).uint16le(4).uint16le(4)
      .uint32le(0x00ffffff) // deutlich mehr als vorhanden
      .bytes(Buffer.alloc(4))
      .toBuffer();
    assert.throws(() => egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_WIRETOSURFACE_1, body)), /bitmapData/);
  });

  test('WIRETOSURFACE_2 trägt die Kontext-ID des progressiven Codecs', () => {
    const body = new BinaryWriter()
      .uint16le(3)
      .uint16le(egfx.RDPGFX_CODECID_CAPROGRESSIVE)
      .uint32le(0xdeadbeef)
      .uint8(egfx.PIXEL_FORMAT_ARGB_8888)
      .uint32le(2)
      .bytes(Buffer.from([0xfe, 0xff]))
      .toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_WIRETOSURFACE_2, body))[0], egfx.RDPGFX_CMDID_WIRETOSURFACE_2);
    assert.equal(p.codecContextId, 0xdeadbeef);
    assert.equal(p.pixelFormat, 0x21);
    assert.ok(p.bitmapData.equals(Buffer.from([0xfe, 0xff])));
  });

  test('CREATESURFACE und DELETESURFACE', () => {
    const create = pdu(
      egfx.RDPGFX_CMDID_CREATESURFACE,
      new BinaryWriter().uint16le(2).uint16le(1024).uint16le(768).uint8(egfx.PIXEL_FORMAT_XRGB_8888).toBuffer(),
    );
    const del = pdu(egfx.RDPGFX_CMDID_DELETESURFACE, new BinaryWriter().uint16le(2).toBuffer());
    const roh = egfx.parseEgfxPdus(Buffer.concat([create, del]));
    const a = erwarte(roh[0], egfx.RDPGFX_CMDID_CREATESURFACE);
    const b = erwarte(roh[1], egfx.RDPGFX_CMDID_DELETESURFACE);
    assert.deepEqual([a.surfaceId, a.width, a.height, a.pixelFormat], [2, 1024, 768, 0x20]);
    assert.equal(b.surfaceId, 2);
  });

  test('RESETGRAPHICS liefert Grösse und Monitorliste, das Padding wird ignoriert', () => {
    const p = erwarte(egfx.parseEgfxPdus(resetGraphics())[0], egfx.RDPGFX_CMDID_RESETGRAPHICS);
    assert.equal(p.width, 1920);
    assert.equal(p.height, 1080);
    assert.deepEqual(p.monitors, [{ left: 0, top: 0, right: 1919, bottom: 1079, flags: 1 }]);
  });

  test('RESETGRAPHICS mit mehr als 16 Monitoren wird abgewiesen', () => {
    const body = new BinaryWriter().uint32le(800).uint32le(600).uint32le(17).toBuffer();
    assert.throws(() => egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_RESETGRAPHICS, body)), /Monitore/);
  });

  test('MAPSURFACETOOUTPUT überspringt das reservierte Feld', () => {
    const body = new BinaryWriter().uint16le(4).uint16le(0).uint32le(100).uint32le(200).toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_MAPSURFACETOOUTPUT, body))[0], egfx.RDPGFX_CMDID_MAPSURFACETOOUTPUT);
    assert.deepEqual([p.surfaceId, p.outputOriginX, p.outputOriginY], [4, 100, 200]);
  });

  test('MAPSURFACETOSCALEDOUTPUT trägt zusätzlich die Zielgrösse', () => {
    const body = new BinaryWriter()
      .uint16le(4).uint16le(0).uint32le(0).uint32le(0).uint32le(1280).uint32le(720)
      .toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT, body))[0], egfx.RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT);
    assert.deepEqual([p.targetWidth, p.targetHeight], [1280, 720]);
  });

  test('STARTFRAME und ENDFRAME klammern denselben frameId', () => {
    const roh = egfx.parseEgfxPdus(Buffer.concat([startFrame(0x11223344, 0x99), endFrame(0x11223344)]));
    const start = erwarte(roh[0], egfx.RDPGFX_CMDID_STARTFRAME);
    const ende = erwarte(roh[1], egfx.RDPGFX_CMDID_ENDFRAME);
    assert.equal(start.timestamp, 0x99);
    assert.equal(start.frameId, 0x11223344);
    assert.equal(ende.frameId, 0x11223344);
  });

  test('SOLIDFILL liest die Farbe in der Drahtreihenfolge B, G, R, XA', () => {
    const body = new BinaryWriter()
      .uint16le(1)
      .uint8(0x11).uint8(0x22).uint8(0x33).uint8(0x44)
      .uint16le(2)
      .uint16le(0).uint16le(0).uint16le(5).uint16le(5)
      .uint16le(7).uint16le(8).uint16le(9).uint16le(10)
      .toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_SOLIDFILL, body))[0], egfx.RDPGFX_CMDID_SOLIDFILL);
    assert.deepEqual(p.fillPixel, { b: 0x11, g: 0x22, r: 0x33, a: 0x44 });
    assert.equal(p.fillRects.length, 2);
    assert.deepEqual(p.fillRects[1], { left: 7, top: 8, right: 9, bottom: 10 });
  });

  test('SURFACETOSURFACE liest vorzeichenbehaftete Zielpunkte', () => {
    const body = new BinaryWriter()
      .uint16le(1).uint16le(2)
      .uint16le(0).uint16le(0).uint16le(16).uint16le(16)
      .uint16le(2)
      .int16le(-5).int16le(-6)
      .int16le(300).int16le(400)
      .toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_SURFACETOSURFACE, body))[0], egfx.RDPGFX_CMDID_SURFACETOSURFACE);
    assert.equal(p.surfaceIdSrc, 1);
    assert.equal(p.surfaceIdDest, 2);
    assert.deepEqual(p.destPts, [{ x: -5, y: -6 }, { x: 300, y: 400 }]);
  });

  test('SURFACETOCACHE liefert den 64-Bit-Cacheschlüssel als bigint', () => {
    const schluessel = Buffer.alloc(8);
    schluessel.writeBigUInt64LE(0x0102030405060708n, 0);
    const body = new BinaryWriter()
      .uint16le(1)
      .bytes(schluessel)
      .uint16le(33)
      .uint16le(0).uint16le(0).uint16le(8).uint16le(8)
      .toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_SURFACETOCACHE, body))[0], egfx.RDPGFX_CMDID_SURFACETOCACHE);
    assert.equal(p.cacheKey, 0x0102030405060708n);
    assert.equal(p.cacheSlot, 33);
    assert.deepEqual(p.rectSrc, { left: 0, top: 0, right: 8, bottom: 8 });
  });

  test('CACHETOSURFACE und EVICTCACHEENTRY', () => {
    const toSurface = pdu(
      egfx.RDPGFX_CMDID_CACHETOSURFACE,
      new BinaryWriter().uint16le(33).uint16le(1).uint16le(1).int16le(12).int16le(34).toBuffer(),
    );
    const evict = pdu(egfx.RDPGFX_CMDID_EVICTCACHEENTRY, new BinaryWriter().uint16le(33).toBuffer());
    const roh = egfx.parseEgfxPdus(Buffer.concat([toSurface, evict]));
    const a = erwarte(roh[0], egfx.RDPGFX_CMDID_CACHETOSURFACE);
    const b = erwarte(roh[1], egfx.RDPGFX_CMDID_EVICTCACHEENTRY);
    assert.equal(a.cacheSlot, 33);
    assert.deepEqual(a.destPts, [{ x: 12, y: 34 }]);
    assert.equal(b.cacheSlot, 33);
  });

  test('DELETEENCODINGCONTEXT liefert Surface und Kontext-ID', () => {
    const body = new BinaryWriter().uint16le(5).uint32le(0xcafebabe).toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_DELETEENCODINGCONTEXT, body))[0], egfx.RDPGFX_CMDID_DELETEENCODINGCONTEXT);
    assert.equal(p.surfaceId, 5);
    assert.equal(p.codecContextId, 0xcafebabe);
  });

  test('CACHEIMPORTREPLY liefert die zugeteilten Cache-Slots in Reihenfolge', () => {
    // Beispiel aus 2.2.2.17: importedEntriesCount 3, Slots 6, 9, 2.
    const body = new BinaryWriter().uint16le(3).uint16le(6).uint16le(9).uint16le(2).toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_CACHEIMPORTREPLY, body))[0], egfx.RDPGFX_CMDID_CACHEIMPORTREPLY);
    assert.deepEqual(p.cacheSlots, [6, 9, 2]);
  });

  test('CAPSCONFIRM liefert die vom Server gewählte Version samt Flags', () => {
    const body = new BinaryWriter()
      .uint32le(egfx.RDPGFX_CAPVERSION_104)
      .uint32le(4)
      .uint32le(egfx.RDPGFX_CAPS_FLAG_SMALL_CACHE | egfx.RDPGFX_CAPS_FLAG_AVC_DISABLED)
      .toBuffer();
    const p = erwarte(egfx.parseEgfxPdus(pdu(egfx.RDPGFX_CMDID_CAPSCONFIRM, body))[0], egfx.RDPGFX_CMDID_CAPSCONFIRM);
    assert.equal(p.capsSet.version, 0x000a0400);
    assert.equal(p.capsSet.flags, 0x22);
    assert.equal(p.capsSet.capsData.length, 4);
  });
});

describe('EGFX-Nachrichten der Clientrichtung', () => {
  test('buildCapsAdvertise schreibt Kopf, Zähler und je Set version/laenge/flags', () => {
    const buf = egfx.buildCapsAdvertise([
      { version: egfx.RDPGFX_CAPVERSION_8, flags: egfx.RDPGFX_CAPS_FLAG_THINCLIENT },
      { version: egfx.RDPGFX_CAPVERSION_81, flags: egfx.RDPGFX_CAPS_FLAG_SMALL_CACHE },
    ]);
    // 8 Byte Kopf + 2 Byte Zaehler + 2 * 12 Byte Capability-Set.
    assert.equal(buf.length, 34);
    assert.equal(buf.readUInt16LE(0), 0x0012);
    assert.equal(buf.readUInt16LE(2), 0, 'flags im Kopf müssen null sein');
    assert.equal(buf.readUInt32LE(4), 34, 'pduLength zählt den Kopf mit');
    assert.equal(buf.readUInt16LE(8), 2);
    assert.equal(buf.readUInt32LE(10), 0x00080004);
    assert.equal(buf.readUInt32LE(14), 4);
    assert.equal(buf.readUInt32LE(18), 0x00000001);
    assert.equal(buf.readUInt32LE(22), 0x00080105);
    assert.equal(buf.readUInt32LE(26), 4);
    assert.equal(buf.readUInt32LE(30), 0x00000002);
  });

  test('buildCapsAdvertise setzt fehlende Flags auf null', () => {
    const buf = egfx.buildCapsAdvertise([{ version: egfx.RDPGFX_CAPVERSION_10 }]);
    assert.equal(buf.length, 22);
    assert.equal(buf.readUInt32LE(10), 0x000a0002);
    assert.equal(buf.readUInt32LE(14), 4);
    assert.equal(buf.readUInt32LE(18), 0);
  });

  test('buildCapsAdvertise schreibt für V10.1 sechzehn reservierte Nullbytes', () => {
    // 2.2.3.4: VERSION101 hat kein Flagsfeld, sondern capsDataLength 0x10.
    const buf = egfx.buildCapsAdvertise([{ version: egfx.RDPGFX_CAPVERSION_101 }]);
    assert.equal(buf.readUInt32LE(10), 0x000a0100);
    assert.equal(buf.readUInt32LE(14), 16);
    assert.ok(buf.subarray(18).equals(Buffer.alloc(16)));
    assert.equal(buf.readUInt32LE(4), buf.length);
  });

  test('Ein selbst gebautes CAPSADVERTISE lässt sich als PDU wieder abgrenzen', () => {
    const strom = Buffer.concat([egfx.buildCapsAdvertise([{ version: egfx.RDPGFX_CAPVERSION_8 }]), egfx.buildCacheImportOffer()]);
    const pdus = egfx.parseEgfxPdus(strom);
    assert.deepEqual(pdus.map((p) => p.cmdId), [0x0012, 0x0010]);
  });

  test('buildFrameAcknowledge schreibt queueDepth vor frameId (2.2.2.13)', () => {
    const buf = egfx.buildFrameAcknowledge(0x11111111, 0x22222222, 0x33333333);
    assert.equal(buf.length, 20);
    assert.equal(buf.readUInt16LE(0), 0x000d);
    assert.equal(buf.readUInt16LE(2), 0);
    assert.equal(buf.readUInt32LE(4), 20);
    assert.equal(buf.readUInt32LE(8), 0x22222222, 'queueDepth steht zuerst');
    assert.equal(buf.readUInt32LE(12), 0x11111111, 'danach frameId');
    assert.equal(buf.readUInt32LE(16), 0x33333333, 'zuletzt totalFramesDecoded');
  });

  test('buildFrameAcknowledge kann die Bestätigungen abbestellen', () => {
    const buf = egfx.buildFrameAcknowledge(1, egfx.SUSPEND_FRAME_ACKNOWLEDGEMENT, 7);
    assert.equal(buf.readUInt32LE(8), 0xffffffff);
  });

  test('buildCacheImportOffer bietet null Einträge an', () => {
    const buf = egfx.buildCacheImportOffer();
    assert.equal(buf.length, 10);
    assert.equal(buf.readUInt16LE(0), 0x0010);
    assert.equal(buf.readUInt32LE(4), 10);
    assert.equal(buf.readUInt16LE(8), 0);
  });
});

describe('Spezifikationskonstanten', () => {
  test('Pixelformate und Capability-Flags haben die Werte aus MS-RDPEGFX', () => {
    assert.equal(egfx.PIXEL_FORMAT_XRGB_8888, 0x20);
    assert.equal(egfx.PIXEL_FORMAT_ARGB_8888, 0x21);
    assert.equal(egfx.RDPGFX_CAPS_FLAG_THINCLIENT, 0x00000001);
    assert.equal(egfx.RDPGFX_CAPS_FLAG_SMALL_CACHE, 0x00000002);
    assert.equal(egfx.RDPGFX_CAPS_FLAG_AVC420_ENABLED, 0x00000010);
    assert.equal(egfx.RDPGFX_CAPS_FLAG_AVC_DISABLED, 0x00000020);
    assert.equal(egfx.RDPGFX_CAPS_FLAG_AVC_THINCLIENT, 0x00000040);
    assert.equal(egfx.RDPGFX_CAPS_FLAG_SCALEDMAP_DISABLE, 0x00000080);
  });

  test('Capability-Versionen haben die Werte aus MS-RDPEGFX 2.2.1.6', () => {
    assert.equal(egfx.RDPGFX_CAPVERSION_8, 0x00080004);
    assert.equal(egfx.RDPGFX_CAPVERSION_81, 0x00080105);
    assert.equal(egfx.RDPGFX_CAPVERSION_10, 0x000a0002);
    assert.equal(egfx.RDPGFX_CAPVERSION_101, 0x000a0100);
    assert.equal(egfx.RDPGFX_CAPVERSION_102, 0x000a0200);
    assert.equal(egfx.RDPGFX_CAPVERSION_103, 0x000a0301);
    assert.equal(egfx.RDPGFX_CAPVERSION_104, 0x000a0400);
    assert.equal(egfx.RDPGFX_CAPVERSION_105, 0x000a0502);
    assert.equal(egfx.RDPGFX_CAPVERSION_106, 0x000a0600);
    assert.equal(egfx.RDPGFX_CAPVERSION_107, 0x000a0701);
  });
});
