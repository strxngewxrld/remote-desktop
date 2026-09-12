import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { md4 } from '../src/crypto/md4.js';
import { rc4, Rc4 } from '../src/crypto/rc4.js';
import { computeNtlmV2Response, ntowfv1, ntowfv2, buildAvPairs, parseAvPairs } from '../src/crypto/ntlm.js';
import { decodeTsRequest, encodeTsCredentials, encodeTsRequest } from '../src/crypto/credssp.js';

const hex = (b: Buffer) => b.toString('hex');

describe('MD4 (RFC 1320 Testvektoren)', () => {
  test('leerer String', () => {
    assert.equal(hex(md4(Buffer.from(''))), '31d6cfe0d16ae931b73c59d7e0c089c0');
  });
  test('"abc"', () => {
    assert.equal(hex(md4(Buffer.from('abc'))), 'a448017aaf21d8525fc10ae87aa6729d');
  });
  test('"message digest"', () => {
    assert.equal(hex(md4(Buffer.from('message digest'))), 'd9130a8164549fe818874806e1c7014b');
  });
  test('abcdefghijklmnopqrstuvwxyz', () => {
    assert.equal(hex(md4(Buffer.from('abcdefghijklmnopqrstuvwxyz'))), 'd79e1c308aa5bbcdeea8ed63df412da9');
  });
  test('langer Eingabewert ueber mehrere Bloecke', () => {
    const input = '12345678901234567890123456789012345678901234567890123456789012345678901234567890';
    assert.equal(hex(md4(Buffer.from(input))), 'e33b4ddc9c38f2199c3e7b164fcc0536');
  });
});

describe('RC4', () => {
  test('Testvektor "Key"/"Plaintext"', () => {
    assert.equal(hex(rc4(Buffer.from('Key'), Buffer.from('Plaintext'))), 'bbf316e8d940af0ad3');
  });
  test('Testvektor "Secret"/"Attack at dawn"', () => {
    assert.equal(hex(rc4(Buffer.from('Secret'), Buffer.from('Attack at dawn'))), '45a01f645fc35b383552544b9bf5');
  });
  test('Zustand bleibt ueber mehrere Aufrufe erhalten', () => {
    const stream = new Rc4(Buffer.from('Key'));
    const a = stream.update(Buffer.from('Plain'));
    const b = stream.update(Buffer.from('text'));
    assert.equal(hex(Buffer.concat([a, b])), 'bbf316e8d940af0ad3');
  });
});

describe('NTLMv2 (MS-NLMP 4.2.4 Testvektoren)', () => {
  // Benutzer "User", Domaene "Domain", Passwort "Password"
  const serverChallenge = Buffer.from('0123456789abcdef', 'hex');
  const clientChallenge = Buffer.from('aaaaaaaaaaaaaaaa', 'hex');
  const timestamp = Buffer.alloc(8);
  const targetInfo = Buffer.from(
    '02000c0044006f006d00610069006e00' + '01000c0053006500720076006500720000000000',
    'hex',
  );

  test('NTOWFv1 des Passworts', () => {
    assert.equal(hex(ntowfv1('Password')), 'a4f49c406510bdcab6824ee7c30fd852');
  });

  test('NTOWFv2 (NTLMv2-Hash)', () => {
    assert.equal(hex(ntowfv2('User', 'Password', 'Domain')), '0c868a403bfd7a93a3001ef22ef02e3f');
  });

  test('Session Base Key', () => {
    const result = computeNtlmV2Response({
      responseKey: ntowfv2('User', 'Password', 'Domain'),
      serverChallenge,
      clientChallenge,
      timestamp,
      targetInfo,
    });
    assert.equal(hex(result.sessionBaseKey), '8de40ccadbc14a82f15cb0ad0de95ca3');
  });

  test('NTProofStr steht am Anfang der NT-Antwort', () => {
    const result = computeNtlmV2Response({
      responseKey: ntowfv2('User', 'Password', 'Domain'),
      serverChallenge,
      clientChallenge,
      timestamp,
      targetInfo,
    });
    assert.equal(hex(result.ntProofStr), '68cd0ab851e51c96aabc927bebef6a1c');
    assert.equal(hex(result.ntChallengeResponse.subarray(0, 16)), hex(result.ntProofStr));
    // temp beginnt mit 0x01 0x01 und sechs Nullbytes
    assert.equal(hex(result.ntChallengeResponse.subarray(16, 24)), '0101000000000000');
  });

  test('LMv2-Antwort ist 24 Byte lang und endet auf die Client-Challenge', () => {
    const result = computeNtlmV2Response({
      responseKey: ntowfv2('User', 'Password', 'Domain'),
      serverChallenge,
      clientChallenge,
      timestamp,
      targetInfo,
    });
    assert.equal(result.lmChallengeResponse.length, 24);
    assert.equal(hex(result.lmChallengeResponse.subarray(16)), hex(clientChallenge));
  });
});

describe('NTLM AV-Paare', () => {
  test('Rundlauf durch parse/build', () => {
    const original = new Map([
      [0x0002, Buffer.from('Domain', 'ucs2')],
      [0x0001, Buffer.from('Server', 'ucs2')],
      [0x0007, Buffer.from('0102030405060708', 'hex')],
    ]);
    const parsed = parseAvPairs(buildAvPairs(original));
    assert.equal(parsed.size, 3);
    assert.equal(parsed.get(0x0002)!.toString('ucs2'), 'Domain');
    assert.equal(parsed.get(0x0007)!.toString('hex'), '0102030405060708');
  });

  test('EOL beendet die Liste', () => {
    const buf = Buffer.concat([
      Buffer.from('01000400', 'hex'),
      Buffer.from('4100', 'hex'),
      Buffer.from('00000000', 'hex'),
      Buffer.from('deadbeef', 'hex'),
    ]);
    const parsed = parseAvPairs(buf);
    assert.equal(parsed.size, 1);
  });
});

describe('CredSSP TSRequest', () => {
  test('Rundlauf mit allen Feldern', () => {
    const encoded = encodeTsRequest({
      version: 6,
      negoTokens: [Buffer.from('NTLMSSP\0', 'ascii')],
      pubKeyAuth: Buffer.from('0102030405', 'hex'),
      clientNonce: Buffer.alloc(32, 0xab),
    });
    const decoded = decodeTsRequest(encoded);
    assert.equal(decoded.version, 6);
    assert.equal(decoded.negoTokens!.length, 1);
    assert.equal(decoded.negoTokens![0].toString('ascii'), 'NTLMSSP\0');
    assert.equal(decoded.pubKeyAuth!.toString('hex'), '0102030405');
    assert.equal(decoded.clientNonce!.length, 32);
  });

  test('lange Werte nutzen die Langform der Laengenkodierung', () => {
    const big = Buffer.alloc(500, 0x41);
    const decoded = decodeTsRequest(encodeTsRequest({ version: 6, authInfo: big }));
    assert.equal(decoded.authInfo!.length, 500);
    assert.ok(decoded.authInfo!.equals(big));
  });

  test('TSCredentials enthaelt Domaene, Benutzer und Passwort als UTF-16', () => {
    const creds = encodeTsCredentials('CONTOSO', 'admin', 'geheim');
    // credType 1 gefolgt vom verschachtelten TSPasswordCreds-Blob
    assert.equal(creds[0], 0x30);
    assert.ok(creds.includes(Buffer.from('admin', 'ucs2')));
    assert.ok(creds.includes(Buffer.from('geheim', 'ucs2')));
    assert.ok(creds.includes(Buffer.from('CONTOSO', 'ucs2')));
  });

  test('Fehlercode wird gelesen', () => {
    const decoded = decodeTsRequest(encodeTsRequest({ version: 6, errorCode: 0x0005 }));
    assert.equal(decoded.errorCode, 5);
  });
});
