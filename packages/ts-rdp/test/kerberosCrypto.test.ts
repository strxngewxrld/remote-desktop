import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
  ETYPE_AES128_CTS_HMAC_SHA1_96,
  ETYPE_AES256_CTS_HMAC_SHA1_96,
  aesCtsEntschluesseln,
  aesCtsVerschluesseln,
  entschluesseln,
  nfold,
  pruefsumme,
  schluesselAusPasswort,
  verschluesseln,
  zufallsSchluessel,
} from '../src/kerberos/crypto.js';

/**
 * Die Werte in dieser Datei stammen aus den Anhaengen von RFC 3961 und
 * RFC 3962, nicht aus dem Code. Bricht einer, ist der Code falsch.
 */
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('Kerberos - n-fold (RFC 3961 A.1)', () => {
  const faelle: Array<[number, string, string]> = [
    [64, '012345', 'be072631276b1955'],
    [56, 'password', '78a07b6caf85fa'],
    [64, 'Rough Consensus, and Running Code', 'bb6ed30870b7f0e0'],
    [168, 'password', '59e4a8ca7c0385c3c37b3f6d2000247cb6e6bd5b3e'],
    [192, 'MASSACHVSETTS INSTITVTE OF TECHNOLOGY', 'db3b0d8f0b061e603282b308a50841229ad798fab9540c1b'],
    [168, 'Q', '518a54a215a8452a518a54a215a8452a518a54a215'],
    [168, 'ba', 'fb25d531ae8974499f52fd92ea9857c4ba24cf297e'],
    [64, 'kerberos', '6b65726265726f73'],
    [128, 'kerberos', '6b65726265726f737b9b5b2b93132b93'],
    [168, 'kerberos', '8372c236344e5f1550cd0747e15d62ca7a5a3bcea4'],
    [256, 'kerberos', '6b65726265726f737b9b5b2b93132b935c9bdcdad95c9899c4cae4dee6d6cae4'],
  ];
  for (const [bits, eingabe, erwartet] of faelle) {
    test(`${bits}-fold("${eingabe}")`, () => {
      assert.equal(nfold(Buffer.from(eingabe, 'ascii'), bits).toString('hex'), erwartet);
    });
  }
});

describe('Kerberos - AES-CTS (RFC 3962 Anhang B)', () => {
  const schluessel = hex('636869636b656e207465726979616b69');
  const faelle: Array<[string, string]> = [
    ['4920776f756c64206c696b652074686520', 'c6353568f2bf8cb4d8a580362da7ff7f97'],
    [
      '4920776f756c64206c696b65207468652047656e6572616c20476175277320',
      'fc00783e0efdb2c1d445d4c8eff7ed2297687268d6ecccc0c07b25e25ecfe5',
    ],
    [
      '4920776f756c64206c696b65207468652047656e6572616c2047617527732043',
      '39312523a78662d5be7fcbcc98ebf5a897687268d6ecccc0c07b25e25ecfe584',
    ],
    [
      '4920776f756c64206c696b65207468652047656e6572616c20476175277320436869636b656e2c20706c656173652c',
      '97687268d6ecccc0c07b25e25ecfe584b3fffd940c16a18c1b5549d2f838029e39312523a78662d5be7fcbcc98ebf5',
    ],
  ];
  for (const [klar, geheim] of faelle) {
    test(`${klar.length / 2} Byte`, () => {
      assert.equal(aesCtsVerschluesseln(schluessel, hex(klar)).toString('hex'), geheim);
      assert.equal(aesCtsEntschluesseln(schluessel, hex(geheim)).toString('hex'), klar);
    });
  }

  test('Genau ein Block wird schlicht verschluesselt und kommt zurueck', () => {
    const block = Buffer.alloc(16, 7);
    assert.deepEqual(aesCtsEntschluesseln(schluessel, aesCtsVerschluesseln(schluessel, block)), block);
  });
});

describe('Kerberos - string-to-key (RFC 3962 Anhang B)', () => {
  const salz = 'ATHENA.MIT.EDUraeburn';
  const faelle: Array<[number, string, string]> = [
    [1, '42263c6e89f4fc28b8df68ee09799f15', 'fe697b52bc0d3ce14432ba036a92e65bbb52280990a2fa27883998d72af30161'],
    [2, 'c651bf29e2300ac27fa469d693bdda13', 'a2e16d16b36069c135d5e9d2e25f896102685618b95914b467c67622225824ff'],
    [1200, '4c01cd46d632d01e6dbe230a01ed642a', '55a6ac740ad17b4846941051e1e8b0a7548d93b0ab30a8bc3ff16280382b8c2a'],
  ];
  for (const [iterationen, aes128, aes256] of faelle) {
    test(`"password", ${iterationen} Iteration(en)`, () => {
      assert.equal(
        schluesselAusPasswort(ETYPE_AES128_CTS_HMAC_SHA1_96, 'password', salz, iterationen).wert.toString('hex'),
        aes128,
      );
      assert.equal(
        schluesselAusPasswort(ETYPE_AES256_CTS_HMAC_SHA1_96, 'password', salz, iterationen).wert.toString('hex'),
        aes256,
      );
    });
  }
});

describe('Kerberos - Verschluesseln mit Integritaetsschutz', () => {
  for (const etype of [ETYPE_AES128_CTS_HMAC_SHA1_96, ETYPE_AES256_CTS_HMAC_SHA1_96]) {
    test(`etype ${etype}: hin und zurueck, auch fuer kurze Klartexte`, () => {
      const schluessel = zufallsSchluessel(etype);
      for (const laenge of [0, 1, 15, 16, 17, 100]) {
        const klar = Buffer.alloc(laenge, 0x42);
        const geheim = verschluesseln(schluessel, 3, klar);
        assert.equal(geheim.length, 16 + laenge + 12);
        assert.deepEqual(entschluesseln(schluessel, 3, geheim), klar);
      }
    });
  }

  test('Eine andere Schluesselverwendung oder ein veraendertes Byte faellt auf', () => {
    const schluessel = zufallsSchluessel(ETYPE_AES256_CTS_HMAC_SHA1_96);
    const geheim = verschluesseln(schluessel, 3, Buffer.from('geheim'));
    assert.throws(() => entschluesseln(schluessel, 4, geheim), /Integritaet/);
    geheim[5]! ^= 1;
    assert.throws(() => entschluesseln(schluessel, 3, geheim), /Integritaet/);
  });

  test('Die Pruefsumme ist 96 Bit lang und haengt an der Verwendung', () => {
    const schluessel = zufallsSchluessel(ETYPE_AES128_CTS_HMAC_SHA1_96);
    const a = pruefsumme(schluessel, 6, Buffer.from('x'));
    assert.equal(a.length, 12);
    assert.notDeepEqual(a, pruefsumme(schluessel, 7, Buffer.from('x')));
  });
});
