import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { cliprdr } from 'ts-rdp';
import { sammleLokaleDateien } from '../src/macLokaleDateien.js';

async function mitBaum(lauf: (wurzel: string) => Promise<void>): Promise<void> {
  const wurzel = await mkdtemp(join(tmpdir(), 'rdp-lokal-test-'));
  try { await lauf(wurzel); } finally { await rm(wurzel, { recursive: true, force: true }); }
}

test('Ordner werden rekursiv eingesammelt: Eltern vor Kindern, leere Ordner, Groesse und mtime aus lstat', async () => {
  await mitBaum(async wurzel => {
    const zeit = new Date('2021-02-03T04:05:06.000Z');
    await mkdir(join(wurzel, 'Projekt', 'Leer'), { recursive: true });
    await mkdir(join(wurzel, 'Projekt', 'Unter'));
    await writeFile(join(wurzel, 'Projekt', 'Unter', 'a.txt'), 'Inhalt');
    await utimes(join(wurzel, 'Projekt', 'Unter', 'a.txt'), zeit, zeit);
    await writeFile(join(wurzel, 'lose.bin'), Buffer.from([1, 2, 3]));
    const ergebnis = await sammleLokaleDateien([join(wurzel, 'Projekt'), join(wurzel, 'lose.bin')], { maxBytes: 1000 });
    assert.deepEqual(ergebnis.quellen.map(q => [q.name, !!q.directory]), [
      ['Projekt', true], ['Projekt/Leer', true], ['Projekt/Unter', true], ['Projekt/Unter/a.txt', false], ['lose.bin', false],
    ]);
    const datei = ergebnis.quellen[3];
    assert.equal(datei.size, 6);
    assert.equal(datei.lastWriteTime!.getTime(), zeit.getTime());
    assert.equal(ergebnis.gesamtBytes, 9);
    assert.deepEqual(ergebnis.uebersprungen, []);
    // Inhalt wird erst beim Lesen geholt, ab beliebigem Offset.
    assert.equal((await datei.read(2, 3)).toString(), 'hal');
    // Das Ergebnis taugt direkt als Deskriptor fuer den Server.
    assert.equal(cliprdr.buildFileList(ergebnis.quellen).readUInt32LE(0), 5);
  });
});

test('Symlinks werden nicht verfolgt, sondern uebersprungen - auch auf Ordner und als oberste Ebene', async () => {
  await mitBaum(async wurzel => {
    await mkdir(join(wurzel, 'echt'));
    await writeFile(join(wurzel, 'echt', 'f.txt'), 'x');
    await writeFile(join(wurzel, 'ziel.txt'), 'geheim');
    await symlink(join(wurzel, 'ziel.txt'), join(wurzel, 'echt', 'link.txt'));
    await symlink(wurzel, join(wurzel, 'echt', 'schleife'));
    await symlink(join(wurzel, 'echt'), join(wurzel, 'alias'));
    const ergebnis = await sammleLokaleDateien([join(wurzel, 'echt'), join(wurzel, 'alias')], { maxBytes: 1000 });
    assert.deepEqual(ergebnis.quellen.map(q => q.name), ['echt', 'echt/f.txt']);
    assert.deepEqual(ergebnis.uebersprungen.map(p => p.slice(wurzel.length).split(sep).join('/')), ['/echt/link.txt', '/echt/schleife', '/alias']);
    assert.equal(ergebnis.gesamtBytes, 1);
  });
});

// O_NOFOLLOW gibt es unter Windows nicht; das Modul laeuft ohnehin nur auf macOS.
test('Lesen folgt keinem Symlink, der die Datei nach dem Einsammeln ersetzt', { skip: process.platform === 'win32' }, async () => {
  await mitBaum(async wurzel => {
    await writeFile(join(wurzel, 'a.txt'), 'abc');
    const { quellen } = await sammleLokaleDateien([join(wurzel, 'a.txt')], { maxBytes: 10 });
    await rm(join(wurzel, 'a.txt'));
    await writeFile(join(wurzel, 'geheim.txt'), 'abc');
    await symlink(join(wurzel, 'geheim.txt'), join(wurzel, 'a.txt'));
    await assert.rejects(quellen[0].read(0, 3));
  });
});

test('Schrumpft die Datei nach dem Einsammeln, liefert read weniger Byte (die Sitzung antwortet dann mit FAIL)', async () => {
  await mitBaum(async wurzel => {
    await writeFile(join(wurzel, 'a.txt'), 'abcdef');
    const { quellen } = await sammleLokaleDateien([join(wurzel, 'a.txt')], { maxBytes: 10 });
    await truncate(join(wurzel, 'a.txt'), 2);
    assert.equal((await quellen[0].read(0, 6)).length, 2);
  });
});

test('Gesamtgroesse und Eintragszahl werden vor dem Anbieten geprueft', async () => {
  await mitBaum(async wurzel => {
    await mkdir(join(wurzel, 'd'));
    for (let i = 0; i < 5; i++) await writeFile(join(wurzel, 'd', `f${i}`), '12345');
    await assert.rejects(sammleLokaleDateien([join(wurzel, 'd')], { maxBytes: 24 }), /Größenbegrenzung/);
    assert.equal((await sammleLokaleDateien([join(wurzel, 'd')], { maxBytes: 25 })).quellen.length, 6);
    await assert.rejects(sammleLokaleDateien([join(wurzel, 'd')], { maxBytes: 100, maxEintraege: 5 }), /zu viele/);
  });
});

test('Zwei oberste Eintraege mit gleichem Namen werden abgelehnt', async () => {
  await mitBaum(async wurzel => {
    await mkdir(join(wurzel, 'a'));
    await mkdir(join(wurzel, 'b'));
    await writeFile(join(wurzel, 'a', 'x.txt'), '1');
    await writeFile(join(wurzel, 'b', 'X.txt'), '2');
    await assert.rejects(sammleLokaleDateien([join(wurzel, 'a', 'x.txt'), join(wurzel, 'b', 'X.txt')], { maxBytes: 10 }), /Doppelter/);
  });
});
