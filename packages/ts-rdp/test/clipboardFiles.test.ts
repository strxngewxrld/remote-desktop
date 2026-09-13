import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as c from '../src/protocol/cliprdr.js';

function setup(richtung: c.ZwischenablageRichtung = 'beide') {
  const sent: Buffer[] = [];
  const texts: string[] = [];
  const session = new c.CliprdrSession({ send: b => sent.push(b), richtung, onServerText: t => texts.push(t) });
  session.verarbeite(c.buildClipboardCapabilities(0x0e));
  session.verarbeite(c.buildMonitorReady());
  return { session, sent, texts, last: () => c.parseCliprdrPdu(sent.at(-1)!) };
}

test('Dateiübertragung: Deskriptor, Größe, Teilbereiche, EOF und ungültige Anfragen', () => {
  const s = setup();
  assert.equal(s.session.meldeDateien([{ name: 'Größe.txt', data: Buffer.from('abcdef') }]), true);
  s.session.verarbeite(c.buildFormatDataRequest(c.FILE_GROUP_DESCRIPTOR));
  const descriptor = s.last().body;
  assert.equal(descriptor.length, 596);
  assert.equal(descriptor.readUInt32LE(0), 1);
  assert.equal(descriptor.readUInt32LE(4), 0x44);
  assert.equal(descriptor.readUInt32LE(72), 6);
  assert.equal(descriptor.subarray(76, 94).toString('utf16le'), 'Größe.txt');
  const request = (flags: number, offset: number, count: number, index = 0) => {
    const b = Buffer.alloc(24);
    [77, index, flags, offset, 0, count].forEach((n, i) => b.writeUInt32LE(n, i * 4));
    s.session.verarbeite(c.buildCliprdrPdu(8, 0, b));
    assert.equal(s.last().body.readUInt32LE(0), 77);
    return s.last();
  };
  assert.equal(request(1, 0, 8).body.readBigUInt64LE(4), 6n);
  assert.equal(request(2, 2, 3).body.subarray(4).toString(), 'cde');
  assert.equal(request(2, 6, 3).body.length, 4);
  assert.equal(request(3, 0, 8).msgFlags, 2);
  assert.equal(request(2, 0, 8, 9).msgFlags, 2);
  s.session.zuruecksetzen();
  assert.equal(request(2, 0, 8).msgFlags, 2);
});

test('Dateien: Richtungsgrenze, Größenlimit, ungültige Namen und doppelte Namen', () => {
  const files = [{ name: 'a.txt', data: Buffer.from('ab') }];
  assert.equal(setup('nurLesen').session.meldeDateien(files), false);
  const s = setup();
  assert.equal(s.session.meldeDateien(files, 1), false);
  assert.equal(s.session.meldeDateien([...files, ...files]), false);
  assert.throws(() => s.session.meldeDateien([{ name: '../a', data: Buffer.alloc(0) }]));
});

test('Dump-Regression: zwei Formatlisten vor den Antworten behalten beide Zuordnungen', () => {
  const s = setup();
  const formats = c.buildFormatList([{ formatId: 13, name: '' }], { longFormatNames: true });
  s.session.verarbeite(formats);
  s.session.verarbeite(formats);
  s.session.verarbeite(c.buildFormatDataResponse(c.kodiereUnicodeText('eins')));
  s.session.verarbeite(c.buildFormatDataResponse(c.kodiereUnicodeText('zwei')));
  assert.deepEqual(s.texts, ['eins', 'zwei']);
});
