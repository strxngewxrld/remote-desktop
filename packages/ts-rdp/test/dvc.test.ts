import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  buildChannelChunks,
  begrenzeChunkGroesse,
  ChannelReassembler,
  parseChannelChunk,
  parseVirtualChannelCapability,
  CHANNEL_CHUNK_LENGTH,
  CHANNEL_FLAG_FIRST,
  CHANNEL_FLAG_LAST,
  CHANNEL_FLAG_SHOW_PROTOCOL,
  MAX_CHUNK_SIZE,
} from '../src/protocol/virtualChannel.js';
import * as dvc from '../src/protocol/dvc.js';
import { BinaryWriter } from '../src/core/binary.js';

describe('Statische virtuelle Kanaele', () => {
  test('Kurze Nachrichten passen in einen Block', () => {
    const [block] = buildChannelChunks(Buffer.from('hallo'), 1600);
    const chunk = parseChannelChunk(block);
    assert.equal(chunk.totalLength, 5);
    assert.ok(chunk.flags & CHANNEL_FLAG_FIRST);
    assert.ok(chunk.flags & CHANNEL_FLAG_LAST);
    assert.equal(chunk.data.toString(), 'hallo');
  });

  test('Einteilige Nachrichten tragen kein SHOW_PROTOCOL', () => {
    // Sonst reicht der Empfaenger den Kanalkopf an den Endpunkt weiter, und
    // der sieht acht Byte Muell vor seinen Nutzdaten (MS-RDPBCGR 3.1.5.2.1).
    const [block] = buildChannelChunks(Buffer.from('kurz'), 1600);
    assert.equal(parseChannelChunk(block).flags & CHANNEL_FLAG_SHOW_PROTOCOL, 0);
  });

  test('Aufgeteilte Nachrichten tragen SHOW_PROTOCOL in jedem Block', () => {
    // Dort ist es vorgeschrieben, damit der Empfaenger zusammensetzen kann.
    for (const block of buildChannelChunks(Buffer.alloc(3000), 1000)) {
      assert.ok(parseChannelChunk(block).flags & CHANNEL_FLAG_SHOW_PROTOCOL);
    }
  });

  test('Lange Nachrichten werden aufgeteilt und wieder zusammengesetzt', () => {
    const original = Buffer.alloc(4000, 0x41);
    const bloecke = buildChannelChunks(original, 1600);
    assert.equal(bloecke.length, 3);

    const zusammensetzer = new ChannelReassembler();
    let ergebnis: Buffer | undefined;
    for (const block of bloecke) ergebnis = zusammensetzer.push(parseChannelChunk(block));
    assert.ok(ergebnis);
    assert.equal(ergebnis.length, 4000);
    assert.ok(ergebnis.equals(original));
  });

  test('Nur der erste Block traegt FIRST, nur der letzte LAST', () => {
    const bloecke = buildChannelChunks(Buffer.alloc(3000), 1000).map(parseChannelChunk);
    assert.ok(bloecke[0].flags & CHANNEL_FLAG_FIRST);
    assert.equal(bloecke[1].flags & CHANNEL_FLAG_FIRST, 0);
    assert.equal(bloecke[0].flags & CHANNEL_FLAG_LAST, 0);
    assert.ok(bloecke[bloecke.length - 1].flags & CHANNEL_FLAG_LAST);
  });

  test('Unvollstaendige Nachrichten liefern noch kein Ergebnis', () => {
    const zusammensetzer = new ChannelReassembler();
    const bloecke = buildChannelChunks(Buffer.alloc(3000), 1000);
    assert.equal(zusammensetzer.push(parseChannelChunk(bloecke[0])), undefined);
    assert.equal(zusammensetzer.push(parseChannelChunk(bloecke[1])), undefined);
    assert.ok(zusammensetzer.push(parseChannelChunk(bloecke[2])));
  });

  test('Eine unsinnig grosse Laengenangabe wird abgewiesen', () => {
    const boesartig = new BinaryWriter().uint32le(0x7fffffff).uint32le(CHANNEL_FLAG_FIRST).toBuffer();
    const zusammensetzer = new ChannelReassembler(1024);
    assert.throws(() => zusammensetzer.push(parseChannelChunk(boesartig)), /Obergrenze/);
  });

  test('Eine Nutzlast von genau einer Chunkgroesse bleibt ein einziger Block', () => {
    // Grenzfall: bei >= statt > entstuende hier ein zweiter, leerer Block -
    // der Empfaenger wartet dann auf ein LAST, das schon durch ist.
    const bloecke = buildChannelChunks(Buffer.alloc(1000, 0x5a), 1000);
    assert.equal(bloecke.length, 1);
    const block = parseChannelChunk(bloecke[0]);
    assert.equal(block.totalLength, 1000);
    assert.equal(block.data.length, 1000);
    assert.ok(block.flags & CHANNEL_FLAG_FIRST);
    assert.ok(block.flags & CHANNEL_FLAG_LAST);
    assert.equal(block.flags & CHANNEL_FLAG_SHOW_PROTOCOL, 0, 'einteilig, also kein SHOW_PROTOCOL');
  });

  test('Ein Byte mehr als eine Chunkgroesse ergibt zwei Bloecke', () => {
    const bloecke = buildChannelChunks(Buffer.alloc(1001), 1000).map(parseChannelChunk);
    assert.equal(bloecke.length, 2);
    assert.equal(bloecke[0].data.length, 1000);
    assert.equal(bloecke[1].data.length, 1);
  });

  test('Nutzlasten ueber zwei Chunks hinaus werden vollstaendig uebertragen', () => {
    const original = Buffer.alloc(2500);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const bloecke = buildChannelChunks(original, 1000);
    assert.equal(bloecke.length, 3);

    const zerlegt = bloecke.map(parseChannelChunk);
    // Die Gesamtlaenge steht in *jedem* Block, nicht nur im ersten.
    for (const block of zerlegt) assert.equal(block.totalLength, 2500);
    assert.deepEqual(zerlegt.map((b) => b.data.length), [1000, 1000, 500]);

    const zusammensetzer = new ChannelReassembler();
    const ergebnis = zerlegt.map((b) => zusammensetzer.push(b)).filter(Boolean);
    assert.equal(ergebnis.length, 1);
    assert.ok(ergebnis[0]!.equals(original));
  });

  test('Eine leere Nachricht ergibt genau einen Block mit FIRST und LAST', () => {
    const bloecke = buildChannelChunks(Buffer.alloc(0), 1000);
    assert.equal(bloecke.length, 1);
    const block = parseChannelChunk(bloecke[0]);
    assert.equal(block.totalLength, 0);
    assert.equal(block.data.length, 0);
    assert.ok(block.flags & (CHANNEL_FLAG_FIRST | CHANNEL_FLAG_LAST));
  });

  test('Ein neuer FIRST-Block verwirft eine abgebrochene Nachricht', () => {
    // Bricht der Server mittendrin ab, darf der Rest nicht in die naechste
    // Nachricht sickern.
    const zusammensetzer = new ChannelReassembler();
    const abgebrochen = buildChannelChunks(Buffer.alloc(2500, 0x11), 1000);
    assert.equal(zusammensetzer.push(parseChannelChunk(abgebrochen[0])), undefined);

    const vollstaendig = buildChannelChunks(Buffer.from('neu'), 1000);
    const ergebnis = zusammensetzer.push(parseChannelChunk(vollstaendig[0]));
    assert.equal(ergebnis?.toString(), 'neu');
  });

  test('Die Chunkgroesse des Servers wird auf den zulaessigen Bereich begrenzt', () => {
    // MS-RDPBCGR 2.2.7.1.10: mindestens 1600, hoechstens 16256.
    assert.equal(begrenzeChunkGroesse(undefined), CHANNEL_CHUNK_LENGTH);
    assert.equal(begrenzeChunkGroesse(16), CHANNEL_CHUNK_LENGTH);
    assert.equal(begrenzeChunkGroesse(4096), 4096);
    assert.equal(begrenzeChunkGroesse(1_000_000), MAX_CHUNK_SIZE);
  });

  test('VCChunkSize wird aus dem Capability Set gelesen', () => {
    const mitGroesse = new BinaryWriter().uint32le(1).uint32le(4096).toBuffer();
    assert.deepEqual(parseVirtualChannelCapability(mitGroesse), { flags: 1, chunkSize: 4096 });

    // Ohne das optionale Feld bleibt es bei der Vorgabe.
    const ohneGroesse = new BinaryWriter().uint32le(0).toBuffer();
    assert.equal(parseVirtualChannelCapability(ohneGroesse).chunkSize, CHANNEL_CHUNK_LENGTH);
  });
});

describe('Dynamische virtuelle Kanaele (MS-RDPEDYC)', () => {
  test('Capability-Anfrage des Servers wird gelesen', () => {
    const anfrage = new BinaryWriter()
      .uint8(dvc.DVC_CMD_CAPABILITY << 4)
      .uint8(0)
      .uint16le(3)
      .toBuffer();
    const pdu = dvc.parseDvcPdu(anfrage);
    assert.equal(pdu.cmd, dvc.DVC_CMD_CAPABILITY);
    assert.equal(pdu.version, 3);
  });

  test('Unsere Capability-Antwort hat das richtige Format', () => {
    const antwort = dvc.buildCapabilitiesResponse(1);
    assert.equal(antwort[0] >> 4, dvc.DVC_CMD_CAPABILITY);
    assert.equal(antwort.readUInt16LE(2), 1);
  });

  test('Kanaleroeffnung mit Namen wird gelesen', () => {
    const name = Buffer.from('Microsoft::Windows::RDS::Graphics\0', 'ascii');
    const anfrage = Buffer.concat([Buffer.from([(dvc.DVC_CMD_CREATE << 4) | 0, 0x03]), name]);
    const pdu = dvc.parseDvcPdu(anfrage);
    assert.equal(pdu.cmd, dvc.DVC_CMD_CREATE);
    assert.equal(pdu.channelId, 3);
    assert.equal(pdu.name, 'Microsoft::Windows::RDS::Graphics');
  });

  test('Kanal-IDs werden in der kleinstmoeglichen Breite geschrieben', () => {
    const klein = dvc.buildCreateResponse(3, dvc.DVC_CREATION_STATUS_OK);
    assert.equal(klein[0] & 0x03, 0, 'ein Byte');
    assert.equal(klein.length, 6);

    const gross = dvc.buildCreateResponse(0x1234, dvc.DVC_CREATION_STATUS_OK);
    assert.equal(gross[0] & 0x03, 1, 'zwei Byte');
    assert.equal(gross.readUInt16LE(1), 0x1234);
  });

  test('Absage traegt den Statuscode STATUS_NOT_SUPPORTED', () => {
    const antwort = dvc.buildCreateResponse(3, dvc.DVC_CREATION_STATUS_NO_LISTENER);
    assert.equal(antwort.readUInt32LE(2), 0xc0000001);
  });

  test('DATA_FIRST liefert die Gesamtlaenge mit', () => {
    // Kopf: Cmd 2, Sp 1 (Laenge als 16 Bit), cbId 0
    const kopf = (dvc.DVC_CMD_DATA_FIRST << 4) | (1 << 2) | 0;
    const nachricht = new BinaryWriter()
      .uint8(kopf)
      .uint8(7) // Kanal-ID
      .uint16le(5000)
      .bytes(Buffer.alloc(100, 0xab))
      .toBuffer();
    const pdu = dvc.parseDvcPdu(nachricht);
    assert.equal(pdu.cmd, dvc.DVC_CMD_DATA_FIRST);
    assert.equal(pdu.channelId, 7);
    assert.equal(pdu.totalLength, 5000);
    assert.equal(pdu.data!.length, 100);
  });

  test('DATA ohne Laengenangabe wird gelesen', () => {
    const nachricht = Buffer.concat([
      Buffer.from([(dvc.DVC_CMD_DATA << 4) | 0, 7]),
      Buffer.from('nutzdaten'),
    ]);
    const pdu = dvc.parseDvcPdu(nachricht);
    assert.equal(pdu.cmd, dvc.DVC_CMD_DATA);
    assert.equal(pdu.channelId, 7);
    assert.equal(pdu.data!.toString(), 'nutzdaten');
  });

  test('Unsere Datennachricht ist zur Gegenrichtung symmetrisch', () => {
    const pdu = dvc.parseDvcPdu(dvc.buildData(42, Buffer.from('hallo')));
    assert.equal(pdu.cmd, dvc.DVC_CMD_DATA);
    assert.equal(pdu.channelId, 42);
    assert.equal(pdu.data!.toString(), 'hallo');
  });

  test('Close wird gelesen und geschrieben', () => {
    const pdu = dvc.parseDvcPdu(dvc.buildClose(9));
    assert.equal(pdu.cmd, dvc.DVC_CMD_CLOSE);
    assert.equal(pdu.channelId, 9);
  });

  test('Ungueltiges cbId wird abgewiesen', () => {
    assert.throws(() => dvc.parseDvcPdu(Buffer.from([(dvc.DVC_CMD_DATA << 4) | 3, 0, 0, 0, 0])), /cbId/);
  });

  test('DATA_FIRST ist zur Gegenrichtung symmetrisch', () => {
    const pdu = dvc.parseDvcPdu(dvc.buildDataFirst(7, 5000, Buffer.alloc(100, 0xab)));
    assert.equal(pdu.cmd, dvc.DVC_CMD_DATA_FIRST);
    assert.equal(pdu.channelId, 7);
    assert.equal(pdu.totalLength, 5000);
    assert.equal(pdu.data!.length, 100);
  });

  test('Die Breite des Laengenfelds richtet sich nach der Gesamtlaenge', () => {
    const klein = dvc.buildDataFirst(1, 200, Buffer.alloc(10));
    assert.equal((klein[0] >> 2) & 0x03, 0, 'ein Byte Laenge');
    const mittel = dvc.buildDataFirst(1, 5000, Buffer.alloc(10));
    assert.equal((mittel[0] >> 2) & 0x03, 1, 'zwei Byte Laenge');
    const gross = dvc.buildDataFirst(1, 100000, Buffer.alloc(10));
    assert.equal((gross[0] >> 2) & 0x03, 2, 'vier Byte Laenge');
    assert.equal(dvc.parseDvcPdu(gross).totalLength, 100000);
  });

  test('Kleine Nutzlasten ergeben ein einzelnes DATA ohne Laengenfeld', () => {
    const teile = dvc.buildDataSegments(5, Buffer.alloc(100, 0x7), 1600);
    assert.equal(teile.length, 1);
    assert.equal(dvc.parseDvcPdu(teile[0]).cmd, dvc.DVC_CMD_DATA);
  });

  test('Eine Nutzlast genau an der Grenze bleibt ein einzelnes DATA', () => {
    // Kopf: ein Byte Cmd/cbId plus ein Byte Kanal-ID.
    const teile = dvc.buildDataSegments(5, Buffer.alloc(1600 - 2), 1600);
    assert.equal(teile.length, 1);
    assert.equal(teile[0].length, 1600);
  });

  test('Ein Byte darueber wird in DATA_FIRST und DATA zerlegt', () => {
    const teile = dvc.buildDataSegments(5, Buffer.alloc(1600 - 1), 1600);
    assert.equal(teile.length, 2);
    assert.equal(dvc.parseDvcPdu(teile[0]).cmd, dvc.DVC_CMD_DATA_FIRST);
    assert.equal(dvc.parseDvcPdu(teile[1]).cmd, dvc.DVC_CMD_DATA);
  });

  test('Grosse Nutzlasten kommen vollstaendig und in der Reihenfolge an', () => {
    const original = Buffer.alloc(10000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) & 0xff;
    const teile = dvc.buildDataSegments(0x1234, original, 1600);

    assert.ok(teile.length > 2, `erwartet mehrere PDUs, waren ${teile.length}`);
    for (const teil of teile) {
      assert.ok(teil.length <= 1600, `PDU zu gross: ${teil.length} Byte`);
    }

    const kopf = dvc.parseDvcPdu(teile[0]);
    assert.equal(kopf.cmd, dvc.DVC_CMD_DATA_FIRST);
    assert.equal(kopf.channelId, 0x1234);
    assert.equal(kopf.totalLength, original.length, 'die Gesamtlaenge steht im ersten PDU');

    const stuecke = teile.map((teil) => {
      const pdu = dvc.parseDvcPdu(teil);
      assert.equal(pdu.channelId, 0x1234);
      return pdu.data!;
    });
    for (const teil of teile.slice(1)) {
      assert.equal(dvc.parseDvcPdu(teil).cmd, dvc.DVC_CMD_DATA);
    }
    assert.ok(Buffer.concat(stuecke).equals(original));
  });

  test('Die Segmentierung beruecksichtigt die Breite der Kanal-ID', () => {
    // Eine vierstellige Kanal-ID kostet zwei zusaetzliche Kopfbytes; wer damit
    // nicht rechnet, schickt PDUs, die knapp ueber die Chunkgrenze ragen.
    const gross = dvc.buildDataSegments(0x1234, Buffer.alloc(5000), 1600);
    for (const teil of gross) assert.ok(teil.length <= 1600);
    const klein = dvc.buildDataSegments(3, Buffer.alloc(5000), 1600);
    for (const teil of klein) assert.ok(teil.length <= 1600);
    // Mit dem schmaleren Kopf passt mehr Nutzlast in dieselbe Anzahl PDUs.
    assert.ok(
      dvc.parseDvcPdu(klein[0]).data!.length > dvc.parseDvcPdu(gross[0]).data!.length,
    );
  });

  test('Eine Chunkgroesse ohne Platz fuer den Kopf wird abgewiesen', () => {
    assert.throws(() => dvc.buildDataSegments(0x1234, Buffer.alloc(100), 4), /Chunkgroesse/);
  });
});
