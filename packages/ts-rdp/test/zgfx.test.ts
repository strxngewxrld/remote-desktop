import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  SEGMENTED_MULTIPART,
  SEGMENTED_SINGLE,
  ZgfxDecompressor,
  ZgfxError,
  zgfxWrapUncompressed,
  PACKET_COMPR_TYPE_RDP8,
} from '../src/codec/zgfx.js';

/** Packt eine Bitfolge in Bytes und haengt das Abschlussbyte an. */
function bitstream(bits: string, rawTail: Uint8Array = new Uint8Array(0), trailer?: number): Buffer {
  const fuellbits = (8 - (bits.length % 8)) % 8;
  const gefuellt = bits + '0'.repeat(fuellbits);
  const bytes: number[] = [];
  for (let i = 0; i < gefuellt.length; i += 8) bytes.push(parseInt(gefuellt.slice(i, i + 8), 2));
  return Buffer.concat([
    Buffer.from(bytes),
    Buffer.from(rawTail),
    Buffer.from([trailer ?? fuellbits]),
  ]);
}

/** Komprimiertes Einzelsegment: Deskriptor, Flags, Bitstrom. */
function comprimiert(bits: string, rawTail?: Uint8Array, trailer?: number): Buffer {
  return Buffer.concat([
    Buffer.from([SEGMENTED_SINGLE, 0x20 | 0x04]),
    bitstream(bits, rawTail, trailer),
  ]);
}

/** Literal-Token: Praefix "0" gefolgt von acht Wertbits. */
function literal(zeichen: string): string {
  return '0' + zeichen.charCodeAt(0).toString(2).padStart(8, '0');
}

describe('ZGFX - unkomprimierte Segmente', () => {
  test('Einzelsegment wird unveraendert durchgereicht', () => {
    const daten = Buffer.from('Hallo Welt');
    const ergebnis = new ZgfxDecompressor().decompress(
      Buffer.concat([Buffer.from([SEGMENTED_SINGLE, 0x00]), daten]),
    );
    assert.equal(ergebnis.toString(), 'Hallo Welt');
  });

  test('zgfxWrapUncompressed erzeugt genau dieses Format', () => {
    const verpackt = zgfxWrapUncompressed(Buffer.from('abc'));
    assert.equal(verpackt[0], SEGMENTED_SINGLE);
    // Kopfbyte: Typ RDP 8.0, ohne das Bit fuer "komprimiert".
    assert.equal(verpackt[1], PACKET_COMPR_TYPE_RDP8);
    assert.equal(verpackt[1] & 0x20, 0, 'darf nicht als komprimiert markiert sein');
    assert.equal(new ZgfxDecompressor().decompress(verpackt).toString(), 'abc');
  });

  test('Mehrteiler werden in der richtigen Reihenfolge zusammengesetzt', () => {
    const teil = (inhalt: string) => {
      const segment = Buffer.concat([Buffer.from([0x00]), Buffer.from(inhalt)]);
      const laenge = Buffer.allocUnsafe(4);
      laenge.writeUInt32LE(segment.length, 0);
      return Buffer.concat([laenge, segment]);
    };
    const kopf = Buffer.alloc(7);
    kopf[0] = SEGMENTED_MULTIPART;
    kopf.writeUInt16LE(2, 1);
    kopf.writeUInt32LE(9, 3); // "Teil1" + "Teil2" ohne die 1 = 5 + 4
    const nachricht = Buffer.concat([kopf, teil('Teil1'), teil('eil2')]);
    assert.equal(new ZgfxDecompressor().decompress(nachricht).toString(), 'Teil1eil2');
  });

  test('Falsche Gesamtlaenge im Mehrteiler wird bemerkt', () => {
    const kopf = Buffer.alloc(7);
    kopf[0] = SEGMENTED_MULTIPART;
    kopf.writeUInt16LE(1, 1);
    kopf.writeUInt32LE(999, 3);
    const laenge = Buffer.allocUnsafe(4);
    laenge.writeUInt32LE(4, 0);
    const nachricht = Buffer.concat([kopf, laenge, Buffer.from([0x00]), Buffer.from('abc')]);
    assert.throws(() => new ZgfxDecompressor().decompress(nachricht), /weicht von der angekuendigten/);
  });

  test('Unbekannter Deskriptor wird abgewiesen', () => {
    assert.throws(() => new ZgfxDecompressor().decompress(Buffer.from([0x99, 0x00])), ZgfxError);
  });
});

describe('ZGFX - Huffman-kodierte Segmente', () => {
  test('Zwei Literale', () => {
    // "0" + 8 Wertbits ist das Token fuer ein beliebiges Byte.
    const ergebnis = new ZgfxDecompressor().decompress(comprimiert(literal('A') + literal('B')));
    assert.equal(ergebnis.toString(), 'AB');
  });

  test('Literal aus der Kurztabelle ohne Wertbits', () => {
    // Praefix 11000 steht fuer das Byte 0x00, 11001 fuer 0x01.
    const ergebnis = new ZgfxDecompressor().decompress(comprimiert('11000' + '11001'));
    assert.deepEqual([...ergebnis], [0x00, 0x01]);
  });

  test('Haeufige Bytes 0xFF und 0x66 haben eigene Praefixe', () => {
    const ergebnis = new ZgfxDecompressor().decompress(comprimiert('110110' + '11111111'));
    assert.deepEqual([...ergebnis], [0xff, 0x66]);
  });

  test('Match mit Abstand 1 wiederholt das letzte Byte', () => {
    // Literal 'A', dann Match: Praefix 10001, Abstand 1 (5 Bits), Laenge 3 ("0").
    const bits = literal('A') + '10001' + '00001' + '0';
    const ergebnis = new ZgfxDecompressor().decompress(comprimiert(bits));
    assert.equal(ergebnis.toString(), 'AAAA', 'ueberlappende Matches muessen sich fortsetzen');
  });

  test('Match mit laengerer Kodierung', () => {
    // Laenge != 3: "1", dann extra=2 Bits. count = 4 + Wert der 2 Bits.
    const bits = literal('X') + '10001' + '00001' + '1' + '0' + '10';
    const ergebnis = new ZgfxDecompressor().decompress(comprimiert(bits));
    assert.equal(ergebnis.toString(), 'XXXXXXX', '1 + (4 + 2) Zeichen');
  });

  test('Abstand 0 leitet einen unkodierten Abschnitt ein', () => {
    // Praefix 10001, Abstand 0, dann 15 Bits Laenge, danach rohe Bytes.
    const bits = '10001' + '00000' + (3).toString(2).padStart(15, '0');
    const ergebnis = new ZgfxDecompressor().decompress(comprimiert(bits, Buffer.from('XYZ'), 0));
    assert.equal(ergebnis.toString(), 'XYZ');
  });

  test('Der Verlauf bleibt ueber Nachrichten hinweg erhalten', () => {
    // Ein Match darf auf Daten einer frueheren Nachricht zeigen - genau dafuer
    // ist der Dekompressor zustandsbehaftet.
    const dekomp = new ZgfxDecompressor();
    assert.equal(dekomp.decompress(zgfxWrapUncompressed(Buffer.from('Q'))).toString(), 'Q');
    const ergebnis = dekomp.decompress(comprimiert('10001' + '00001' + '0'));
    assert.equal(ergebnis.toString(), 'QQQ', 'Rueckverweis in die vorige Nachricht');
  });

  test('Ein abgeschnittener Bitstrom wird gemeldet, nicht still verschluckt', () => {
    // Praefix 10001 verlangt fuenf Wertbits, hier endet der Strom vorher.
    assert.throws(
      () => new ZgfxDecompressor().decompress(comprimiert('1011111111111')),
      ZgfxError,
    );
  });
});
