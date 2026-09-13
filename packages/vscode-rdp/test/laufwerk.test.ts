// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  FileType,
  antworten,
  dateien,
  fs as fsAttrappe,
  notizen,
  setzeArbeitsbereichsOrdner,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import {
  FREIGABE_SCHLUESSEL,
  frageFreigabe,
  gemerkteFreigaben,
  vergissFreigaben,
  vscodeArbeitsbereichZugriff,
} from '../src/arbeitsbereichZugriff.js';
import { ArbeitsbereichDateisystem, AUSSCHLUSS_VORGABEN } from '../src/arbeitsbereich.js';

/**
 * Die Bruecke zwischen `arbeitsbereich.ts` und VS Code.
 *
 * Hier wird geprueft, was `arbeitsbereich.test.ts` nicht pruefen kann, weil es
 * `vscode` bewusst nicht kennt: das Zusammensetzen der Uri, die Uebersetzung
 * der FileType-Bitmaske und die Rueckfrage samt gemerkter Antwort.
 */

function lege(pfad: string, inhalt: string): void {
  dateien.set(pfad, Buffer.from(inhalt, 'utf8'));
}

beforeEach(() => {
  zuruecksetzen();
});

describe('Laufwerk - Zugriff über vscode.workspace', () => {
  test('Ohne geöffneten Ordner gibt es keine Ordnernamen', () => {
    const zugriff = vscodeArbeitsbereichZugriff();
    assert.deepEqual([...zugriff.ordnernamen()], []);
  });

  test('Die Ordnernamen kommen aus dem Arbeitsbereich', () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend', '/arbeit/backend']);
    const zugriff = vscodeArbeitsbereichZugriff();
    assert.deepEqual([...zugriff.ordnernamen()], ['frontend', 'backend']);
  });

  test('Die Ordnerliste wird bei jedem Zugriff frisch geholt', () => {
    // Genau darauf beruht, dass ein neu geöffnetes Repository ohne neue
    // Sitzung im Explorer auftaucht.
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const zugriff = vscodeArbeitsbereichZugriff();
    assert.deepEqual([...zugriff.ordnernamen()], ['frontend']);
    setzeArbeitsbereichsOrdner(['/arbeit/frontend', '/arbeit/neu']);
    assert.deepEqual([...zugriff.ordnernamen()], ['frontend', 'neu']);
  });

  test('Segmente werden an die Uri des Ordners gehängt, nicht zusammengeklebt', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    lege('/arbeit/frontend/src/index.ts', 'export const a = 1;\n');
    const zugriff = vscodeArbeitsbereichZugriff();
    const angabe = await zugriff.stat(0, ['src', 'index.ts']);
    assert.equal(angabe?.art, 'datei');
    assert.equal(angabe?.groesse, 20);
  });

  test('Ein leeres Segmentfeld meint den Ordner selbst', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    lege('/arbeit/frontend/README.md', '# x\n');
    const zugriff = vscodeArbeitsbereichZugriff();
    assert.equal((await zugriff.stat(0, []))?.art, 'verzeichnis');
  });

  test('Ein Ordnerindex, den es nicht mehr gibt, wirft statt irgendwohin zu greifen', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const zugriff = vscodeArbeitsbereichZugriff();
    await assert.rejects(() => zugriff.stat(5, ['x']));
  });

  test('Ein verlinktes Verzeichnis gilt als Verzeichnis, nicht als "anderes"', async () => {
    // vscode.FileType ist eine Bitmaske: Directory|SymbolicLink ist 66. Wer
    // auf Gleichheit prüft, lässt jeden verlinkten Ordner durchfallen - und in
    // Repositories kommen die vor.
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    const zugriff = vscodeArbeitsbereichZugriff();
    const echterStat = fsAttrappe.stat;
    fsAttrappe.stat = () =>
      Promise.resolve({
        type: (FileType.Directory | FileType.SymbolicLink) as FileType,
        ctime: 1,
        mtime: 2,
        size: 0,
      });
    try {
      assert.equal((await zugriff.stat(0, ['verlinkt']))?.art, 'verzeichnis');
    } finally {
      fsAttrappe.stat = echterStat;
    }
  });

  test('Auflisten übersetzt die Arten', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    lege('/arbeit/frontend/README.md', '# x\n');
    lege('/arbeit/frontend/src/index.ts', 'x');
    const zugriff = vscodeArbeitsbereichZugriff();
    const eintraege = await zugriff.liste(0, []);
    assert.deepEqual(
      eintraege.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'README.md', art: 'datei' },
        { name: 'src', art: 'verzeichnis' },
      ],
    );
  });

  test('Gelöscht wird in den Papierkorb', async () => {
    // Wer im Explorer der Sitzung aus Versehen etwas löscht, löscht Quelltext
    // auf dem eigenen Rechner. Ein Weg zurück gehört dazu.
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    lege('/arbeit/frontend/weg.txt', 'x');
    const zugriff = vscodeArbeitsbereichZugriff();
    await zugriff.loesche(0, ['weg.txt'], false);
    assert.deepEqual(notizen.geloeschteDateien, [{ pfad: '/arbeit/frontend/weg.txt', papierkorb: true }]);
  });

  test('Umbenennen geht über workspace.fs.rename', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend', '/arbeit/backend']);
    lege('/arbeit/frontend/a.txt', 'x');
    const zugriff = vscodeArbeitsbereichZugriff();
    await zugriff.benenneUm(0, ['a.txt'], 1, ['b.txt'], true);
    assert.deepEqual(notizen.umbenannteDateien, [
      { von: '/arbeit/frontend/a.txt', nach: '/arbeit/backend/b.txt' },
    ]);
  });
});

describe('Laufwerk - das ganze Dateisystem über die Attrappe von VS Code', () => {
  function baue(nurLesen = true): ArbeitsbereichDateisystem {
    return new ArbeitsbereichDateisystem({
      zugriff: vscodeArbeitsbereichZugriff(),
      einstellungen: {
        aktiv: true,
        zugriff: nurLesen ? 'readOnly' : 'readWrite',
        nurLesen,
        ausschluss: AUSSCHLUSS_VORGABEN,
        laufwerksname: 'VS Code',
        maxDateigroesse: 64 * 1024 * 1024,
      },
    });
  }

  test('Die Wurzel zeigt die Repositories, darunter deren Inhalt', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend', '/arbeit/backend']);
    lege('/arbeit/frontend/README.md', '# Frontend\n');
    lege('/arbeit/backend/main.py', 'print(1)\n');
    const fs = baue();
    assert.deepEqual(
      (await fs.liste('')).map((e) => e.name).sort(),
      ['backend', 'frontend'],
    );
    assert.deepEqual((await fs.liste('frontend')).map((e) => e.name), ['README.md']);
    assert.equal((await fs.lies('frontend/README.md', 0, 100)).toString('utf8'), '# Frontend\n');
  });

  test('.git und .env erreichen den Server auch über diesen Weg nicht', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    lege('/arbeit/frontend/.git/config', '[core]\n');
    lege('/arbeit/frontend/.env', 'GEHEIM=1\n');
    lege('/arbeit/frontend/README.md', '# x\n');
    const fs = baue();
    assert.deepEqual((await fs.liste('frontend')).map((e) => e.name), ['README.md']);
    assert.equal(await fs.stat('frontend/.env'), undefined);
    assert.equal(await fs.stat('frontend/.git/config'), undefined);
  });

  test('Zwei Repositories mit gleichem Namen bekommen unterscheidbare Ordner', async () => {
    setzeArbeitsbereichsOrdner(['/kunde-a/app', '/kunde-b/app']);
    lege('/kunde-a/app/a.txt', 'A');
    lege('/kunde-b/app/b.txt', 'B');
    const fs = baue();
    assert.deepEqual(
      (await fs.liste('')).map((e) => e.name),
      ['app', 'app (2)'],
    );
    assert.equal((await fs.lies('app/a.txt', 0, 10)).toString('utf8'), 'A');
    assert.equal((await fs.lies('app (2)/b.txt', 0, 10)).toString('utf8'), 'B');
  });

  test('Ein leerer Arbeitsbereich ergibt eine leere Wurzel, keinen Fehler', async () => {
    const fs = baue();
    assert.deepEqual(await fs.liste(''), []);
    assert.equal((await fs.stat(''))?.istVerzeichnis, true);
  });

  test('Mit Schreibrecht landet Geschriebenes über workspace.fs im Arbeitsbereich', async () => {
    setzeArbeitsbereichsOrdner(['/arbeit/frontend']);
    lege('/arbeit/frontend/README.md', '# alt\n');
    const fs = baue(false);
    await fs.kuerze('frontend/README.md', 0);
    await fs.schreibe('frontend/README.md', 0, Buffer.from('# neu\n'));
    assert.equal(Buffer.from(dateien.get('/arbeit/frontend/README.md')!).toString('utf8'), '# neu\n');
  });
});

describe('Laufwerk - Rückfrage vor der Freigabe', () => {
  let kontext: ExtensionContext;

  beforeEach(() => {
    kontext = new ExtensionContext();
  });

  test('Beim ersten Mal wird gefragt, und zwar modal', async () => {
    antworten.meldungen.push('Freigeben');
    const erlaubt = await frageFreigabe(kontext, 'server:3389', ['frontend'], true);
    assert.equal(erlaubt, true);
    assert.equal(notizen.warnungen.length, 1);
    // Modal ist wesentlich: ein nichtmodaler Hinweis verschwindet ungelesen,
    // und eine Freigabe, die niemand gelesen hat, ist keine.
    assert.equal(notizen.warnungsOptionen[0]?.modal, true);
  });

  test('Die Frage nennt die Ordner und die Rechte', async () => {
    antworten.meldungen.push('Freigeben');
    await frageFreigabe(kontext, 'server:3389', ['frontend', 'backend'], true);
    const text = notizen.warnungen[0];
    assert.ok(text.includes('frontend'), text);
    assert.ok(text.includes('backend'), text);
    assert.ok(text.includes('nur lesen'), text);
    assert.ok(text.includes('server:3389'), text);
  });

  test('Bei Schreibrecht steht das auch in der Frage', async () => {
    antworten.meldungen.push('Freigeben');
    await frageFreigabe(kontext, 'server:3389', ['frontend'], false);
    assert.ok(notizen.warnungen[0].includes('lesen und schreiben'), notizen.warnungen[0]);
  });

  test('Viele Ordner werden gekürzt aufgezählt', async () => {
    antworten.meldungen.push('Freigeben');
    await frageFreigabe(kontext, 'server:3389', ['a', 'b', 'c', 'd', 'e'], true);
    assert.ok(notizen.warnungen[0].includes('und 2 weitere'), notizen.warnungen[0]);
  });

  test('"Freigeben" wird gemerkt und beim zweiten Mal nicht mehr gefragt', async () => {
    antworten.meldungen.push('Freigeben');
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), true);
    assert.deepEqual(gemerkteFreigaben(kontext), { 'server:3389': 'erlaubt' });

    notizen.warnungen.length = 0;
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), true);
    assert.equal(notizen.warnungen.length, 0, 'es darf nicht erneut gefragt werden');
  });

  test('"Nicht freigeben" wird ebenso gemerkt', async () => {
    antworten.meldungen.push('Nicht freigeben');
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), false);
    assert.deepEqual(gemerkteFreigaben(kontext), { 'server:3389': 'verweigert' });

    notizen.warnungen.length = 0;
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), false);
    assert.equal(notizen.warnungen.length, 0);
  });

  test('"Nur dieses Mal" gibt frei, merkt aber nichts', async () => {
    antworten.meldungen.push('Nur dieses Mal');
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), true);
    assert.deepEqual(gemerkteFreigaben(kontext), {});

    antworten.meldungen.push('Nur dieses Mal');
    notizen.warnungen.length = 0;
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), true);
    assert.equal(notizen.warnungen.length, 1, 'es muss erneut gefragt werden');
  });

  test('Escape gibt nichts frei und merkt nichts', async () => {
    // Kein Eintrag in antworten.meldungen heisst: der Benutzer hat abgebrochen.
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), false);
    assert.deepEqual(gemerkteFreigaben(kontext), {});
  });

  test('Die Antwort gilt je host:port, nicht für alle Server', async () => {
    antworten.meldungen.push('Freigeben');
    await frageFreigabe(kontext, 'a:3389', ['frontend'], true);
    notizen.warnungen.length = 0;
    antworten.meldungen.push('Nicht freigeben');
    assert.equal(await frageFreigabe(kontext, 'b:3389', ['frontend'], true), false);
    assert.equal(notizen.warnungen.length, 1, 'für einen anderen Server muss erneut gefragt werden');
    assert.deepEqual(gemerkteFreigaben(kontext), { 'a:3389': 'erlaubt', 'b:3389': 'verweigert' });
  });

  test('Auch ein anderer Port ist ein anderes Ziel', async () => {
    antworten.meldungen.push('Freigeben');
    await frageFreigabe(kontext, 'server:3389', ['frontend'], true);
    notizen.warnungen.length = 0;
    antworten.meldungen.push('Nicht freigeben');
    await frageFreigabe(kontext, 'server:13389', ['frontend'], true);
    assert.equal(notizen.warnungen.length, 1);
  });

  test('vergissFreigaben räumt alles weg', async () => {
    antworten.meldungen.push('Nicht freigeben');
    await frageFreigabe(kontext, 'server:3389', ['frontend'], true);
    await vergissFreigaben(kontext);
    assert.deepEqual(gemerkteFreigaben(kontext), {});
    assert.equal(kontext.globalState.get(FREIGABE_SCHLUESSEL), undefined);

    // Und danach wird wieder gefragt.
    notizen.warnungen.length = 0;
    antworten.meldungen.push('Freigeben');
    assert.equal(await frageFreigabe(kontext, 'server:3389', ['frontend'], true), true);
    assert.equal(notizen.warnungen.length, 1);
  });
});
