import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  buildChannelChunks,
  ChannelReassembler,
  parseChannelChunk,
  CHANNEL_FLAG_FIRST,
  CHANNEL_FLAG_LAST,
  CHANNEL_FLAG_SHOW_PROTOCOL,
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
});
