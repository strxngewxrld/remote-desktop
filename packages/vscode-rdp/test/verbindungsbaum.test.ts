// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import { einstellungen, notizen, zuruecksetzen } from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import {
  ConnectionNode,
  ConnectionTreeProvider,
  FolderNode,
  RdpBaumEintrag,
  addConnection,
  addFolder,
  alleVerbindungen,
  effektiveTags,
  entferneEintragAn,
  getBaum,
  getConnections,
  istOrdner,
  loeseVerbindungAuf,
  normalisiereBaum,
  passtZuSuche,
  pfadText,
  removeConnectionAt,
  schreibeEintragAn,
  secretKey,
  updateConnection,
  verschiebeEintrag,
} from '../src/connections.js';

/** Das alte, flache Format - genau so, wie es heute in settings.json steht. */
const ALTES_FLACHES_FORMAT = [
  { name: 'Alt A', host: '10.0.0.1' },
  { name: 'Alt B', host: '10.0.0.2', port: 3390, username: 'benutzer', domain: 'DOM', colorDepth: 16 },
  { name: 'Alt C', host: '10.0.0.3', keyboardLayout: 'en-US' },
];

function setze(wert: unknown): void {
  einstellungen.set('rdp.connections', wert);
}

beforeEach(() => zuruecksetzen());

describe('Migration vom alten flachen Format', () => {
  test('Eine flache Liste bleibt vollstaendig und in ihrer Reihenfolge erhalten', () => {
    setze(ALTES_FLACHES_FORMAT);

    // Das ist die harte Anforderung: nach dem Update darf niemand eine
    // Verbindung verlieren - auch kein Feld daran.
    assert.deepEqual(getConnections(), ALTES_FLACHES_FORMAT);
    assert.deepEqual(getBaum(), ALTES_FLACHES_FORMAT);
  });

  test('Alte Eintraege liegen in der Wurzel und haben keine Ordnerkette', () => {
    setze(ALTES_FLACHES_FORMAT);
    assert.deepEqual(
      alleVerbindungen().map((e) => ({ pfad: e.pfad, ordner: e.ordnerKette.length })),
      [
        { pfad: [0], ordner: 0 },
        { pfad: [1], ordner: 0 },
        { pfad: [2], ordner: 0 },
      ],
    );
  });

  test('Ohne Ordner aendert die Aufloesung nichts am alten Eintrag', () => {
    setze(ALTES_FLACHES_FORMAT);
    for (const eintrag of alleVerbindungen()) {
      assert.deepEqual(loeseVerbindungAuf(eintrag), eintrag.verbindung);
    }
  });

  test('Ein neuer Ordner neben alten Eintraegen laesst diese unberuehrt', async () => {
    setze([...ALTES_FLACHES_FORMAT]);
    await addFolder('Kunde A');
    await addConnection({ name: 'Neu', host: '10.9.9.9' }, [3]);

    const baum = einstellungen.get('rdp.connections') as RdpBaumEintrag[];
    assert.deepEqual(baum.slice(0, 3), ALTES_FLACHES_FORMAT, 'die alten Eintraege stehen unveraendert vorn');
    assert.equal(istOrdner(baum[3]!), true);
    assert.deepEqual(getConnections().map((c) => c.name), ['Alt A', 'Alt B', 'Alt C', 'Neu']);
  });

  test('Loeschen ueber den alten Index trifft weiterhin genau einen Eintrag', async () => {
    setze([
      { name: 'Gleich', host: '10.0.0.1' },
      { name: 'Gleich', host: '10.0.0.2' },
    ]);
    await removeConnectionAt(0);
    assert.deepEqual(getConnections().map((c) => c.host), ['10.0.0.2']);
  });

  test('Der alte Index zaehlt auch quer durch Ordner weiter', async () => {
    setze([
      { name: 'Wurzel', host: '10.0.0.1' },
      { type: 'folder', name: 'Ordner', children: [{ name: 'Drin', host: '10.0.0.2' }] },
    ]);
    await updateConnection(1, { name: 'Umbenannt', host: '10.0.0.2' });

    const baum = getBaum();
    assert.equal(istOrdner(baum[1]!), true);
    assert.equal((baum[1] as { children: { name: string }[] }).children[0]!.name, 'Umbenannt');
  });

  test('Kaputte Eintraege fliegen raus, ohne den Rest mitzunehmen', () => {
    setze([
      null,
      'kein Objekt',
      42,
      { name: 'ohne Host' },
      { name: 'leerer Host', host: '' },
      ['auch kein Objekt'],
      { name: 'Gut', host: '10.0.0.1' },
    ]);
    assert.deepEqual(getConnections(), [{ name: 'Gut', host: '10.0.0.1' }]);
  });

  test('Ist die Einstellung gar keine Liste, bleibt der Baum leer', () => {
    setze({ name: 'kaputt' });
    assert.deepEqual(getBaum(), []);
    setze(undefined);
    assert.deepEqual(getBaum(), []);
  });

  test('Ein Ordner ohne type, aber mit children wird trotzdem als Ordner erkannt', () => {
    setze([{ name: 'Halbfertig', children: [{ name: 'Drin', host: '10.0.0.5' }] }]);
    const [ordner] = getBaum();
    assert.equal(istOrdner(ordner!), true);
    assert.deepEqual(getConnections().map((c) => c.host), ['10.0.0.5']);
  });

  test('Unbekannte Felder an einer Verbindung ueberleben das Lesen', () => {
    setze([{ name: 'A', host: '10.0.0.1', zukunftsfeld: 'bitte behalten' }]);
    assert.deepEqual(getConnections(), [{ name: 'A', host: '10.0.0.1', zukunftsfeld: 'bitte behalten' }]);
  });

  test('Ein unsinniges Bandbreitenprofil wird verworfen statt weitergereicht', () => {
    setze([{ name: 'A', host: '10.0.0.1', bandwidthProfile: 'quantenfunk' }]);
    assert.deepEqual(getConnections(), [{ name: 'A', host: '10.0.0.1' }]);
  });

  test('Eine masslos tiefe Verschachtelung bricht die Normalisierung nicht', () => {
    let baum: unknown = [{ name: 'Tief', host: '10.0.0.1' }];
    for (let i = 0; i < 60; i++) baum = [{ type: 'folder', name: `E${i}`, children: baum }];
    assert.doesNotThrow(() => normalisiereBaum(baum));
  });
});

describe('Vererbung der Ordnereinstellungen', () => {
  beforeEach(() => {
    setze([
      {
        type: 'folder',
        name: 'Kunde A',
        tags: ['kunde-a'],
        settings: { domain: 'KUNDEA', username: 'aussen', colorDepth: 16, bandwidthProfile: 'broadband' },
        children: [
          { name: 'Direkt', host: '10.1.0.1' },
          {
            type: 'folder',
            name: 'Test',
            settings: { username: 'innen', bandwidthProfile: 'mobile' },
            children: [
              { name: 'Erbt', host: '10.1.1.1' },
              { name: 'Eigen', host: '10.1.1.2', username: 'selbst', colorDepth: 32, bandwidthProfile: 'lan' },
            ],
          },
        ],
      },
    ]);
  });

  function aufgeloest(name: string) {
    const eintrag = alleVerbindungen().find((e) => e.verbindung.name === name)!;
    return loeseVerbindungAuf(eintrag);
  }

  test('Der Ordner reicht seine Einstellungen an die Verbindung durch', () => {
    const direkt = aufgeloest('Direkt');
    assert.equal(direkt.domain, 'KUNDEA');
    assert.equal(direkt.username, 'aussen');
    assert.equal(direkt.colorDepth, 16);
    assert.equal(direkt.bandwidthProfile, 'broadband');
  });

  test('Der naehere Ordner schlaegt den Elternordner', () => {
    const erbt = aufgeloest('Erbt');
    assert.equal(erbt.username, 'innen', 'der Unterordner gewinnt');
    assert.equal(erbt.bandwidthProfile, 'mobile', 'auch beim Profil');
    assert.equal(erbt.domain, 'KUNDEA', 'was er nicht setzt, kommt von oben');
    assert.equal(erbt.colorDepth, 16);
  });

  test('Die Verbindung schlaegt jeden Ordner', () => {
    const eigen = aufgeloest('Eigen');
    assert.equal(eigen.username, 'selbst');
    assert.equal(eigen.colorDepth, 32);
    assert.equal(eigen.bandwidthProfile, 'lan');
    assert.equal(eigen.domain, 'KUNDEA', 'nur die gesetzten Felder werden ueberschrieben');
  });

  test('Die volle Reihenfolge in einem Zug: Verbindung, Ordner, Elternordner, global', () => {
    // Was keine Ebene setzt, bleibt offen - die globale Einstellung fuellt es
    // erst beim Verbindungsaufbau (session.ts: `?? config.get(...)`).
    assert.equal(aufgeloest('Erbt').keyboardLayout, undefined);
    assert.equal(aufgeloest('Erbt').width, undefined);
  });

  test('Die gespeicherte Verbindung bleibt unveraendert - aufgeloest wird nur eine Kopie', () => {
    const eintrag = alleVerbindungen().find((e) => e.verbindung.name === 'Direkt')!;
    loeseVerbindungAuf(eintrag);
    assert.equal(eintrag.verbindung.domain, undefined, 'in den Einstellungen steht weiterhin nichts');
  });

  test('Tags der Ordner gelten zusaetzlich fuer die Verbindung', () => {
    setze([
      {
        type: 'folder',
        name: 'Kunde',
        tags: ['kunde', 'prod'],
        children: [{ name: 'A', host: '10.0.0.1', tags: ['dc', 'PROD'] }],
      },
    ]);
    const eintrag = alleVerbindungen()[0]!;
    assert.deepEqual(effektiveTags(eintrag.verbindung, eintrag.ordnerKette), ['dc', 'PROD', 'kunde']);
  });

  test('Das Passwort haengt an der aufgeloesten Anmeldung, nicht an der leeren', () => {
    const eintrag = alleVerbindungen().find((e) => e.verbindung.name === 'Direkt')!;
    assert.equal(secretKey(loeseVerbindungAuf(eintrag)), 'rdp:KUNDEA\\aussen@10.1.0.1:3389');
  });
});

describe('Suche und Filter', () => {
  beforeEach(() => {
    setze([
      { name: 'Buchhaltung', host: '10.0.0.1', tags: ['prod'] },
      {
        type: 'folder',
        name: 'Labor',
        children: [
          { name: 'Versuch', host: 'lab-01.example.com', tags: ['test'] },
          { name: 'Zweiter', host: '10.5.5.5' },
        ],
      },
    ]);
  });

  test('Gesucht wird ueber Name, Host, Tag und Ordnername', () => {
    const eintraege = alleVerbindungen();
    const treffer = (text: string) => eintraege.filter((e) => passtZuSuche(e, text)).map((e) => e.verbindung.name);

    assert.deepEqual(treffer('buch'), ['Buchhaltung'], 'Name, Gross- und Kleinschreibung egal');
    assert.deepEqual(treffer('lab-01'), ['Versuch'], 'Host');
    assert.deepEqual(treffer('test'), ['Versuch'], 'Tag');
    assert.deepEqual(treffer('Labor'), ['Versuch', 'Zweiter'], 'Ordnername');
    assert.deepEqual(treffer(''), ['Buchhaltung', 'Versuch', 'Zweiter'], 'leere Suche zeigt alles');
  });

  test('Der Pfadtext nennt Ordner und Verbindung', () => {
    const eintrag = alleVerbindungen().find((e) => e.verbindung.name === 'Versuch')!;
    assert.equal(pfadText(eintrag), 'Labor / Versuch');
  });

  test('Der Filter der Baumansicht blendet leere Ordner aus', () => {
    const baum = new ConnectionTreeProvider();
    baum.setzeFilter('buch');
    const wurzel = baum.getChildren();
    assert.deepEqual(wurzel.map((k) => k.label), ['Buchhaltung'], 'der Ordner ohne Treffer verschwindet');
  });

  test('Ein Ordner bleibt sichtbar, wenn tief drin etwas passt', () => {
    const baum = new ConnectionTreeProvider();
    baum.setzeFilter('versuch');
    const wurzel = baum.getChildren();
    assert.deepEqual(wurzel.map((k) => k.label), ['Labor']);
    const kinder = baum.getChildren(wurzel[0]!);
    assert.deepEqual(kinder.map((k) => k.label), ['Versuch'], 'und darin nur der Treffer');
  });

  test('Ohne Filter zeigt die Ansicht wieder alles', () => {
    const baum = new ConnectionTreeProvider();
    baum.setzeFilter('buch');
    baum.setzeFilter('');
    assert.deepEqual(baum.getChildren().map((k) => k.label), ['Buchhaltung', 'Labor']);
  });
});

describe('Baumansicht', () => {
  beforeEach(() => {
    setze([
      { name: 'Wurzel', host: '10.0.0.1' },
      {
        type: 'folder',
        name: 'Kunde',
        settings: { domain: 'DOM' },
        children: [{ name: 'Drin', host: '10.0.0.2' }],
      },
    ]);
  });

  test('Die Wurzel zeigt Verbindungen und Ordner nebeneinander', () => {
    const baum = new ConnectionTreeProvider();
    const wurzel = baum.getChildren();
    assert.equal(wurzel.length, 2);
    assert.ok(wurzel[0] instanceof ConnectionNode);
    assert.ok(wurzel[1] instanceof FolderNode);
    assert.equal(wurzel[1]!.contextValue, 'rdpFolder', 'das Kontextmenue unterscheidet die beiden');
  });

  test('Der Ordnerknoten liefert seine Kinder samt Vererbung', () => {
    const baum = new ConnectionTreeProvider();
    const ordner = baum.getChildren()[1]!;
    const kinder = baum.getChildren(ordner) as ConnectionNode[];
    assert.equal(kinder.length, 1);
    assert.equal(kinder[0]!.aufgeloest.domain, 'DOM', 'der Knoten kennt den geerbten Wert');
    assert.equal(kinder[0]!.connection.domain, undefined, 'gespeichert ist er trotzdem nicht');
    assert.deepEqual(kinder[0]!.pfad, [1, 0]);
  });

  test('Eine Verbindung hat keine Kinder', () => {
    const baum = new ConnectionTreeProvider();
    assert.deepEqual(baum.getChildren(baum.getChildren()[0]!), []);
  });

  test('refresh meldet die Aenderung an VS Code', () => {
    const baum = new ConnectionTreeProvider();
    let gemeldet = 0;
    baum.onDidChangeTreeData(() => gemeldet++);
    baum.refresh();
    baum.setzeFilter('x');
    assert.equal(gemeldet, 2);
  });
});

describe('Umbauen des Baums', () => {
  beforeEach(() => {
    setze([
      { name: 'A', host: '10.0.0.1' },
      { type: 'folder', name: 'Ziel', children: [] },
    ]);
  });

  test('Eine Verbindung wandert in einen Ordner', async () => {
    assert.equal(await verschiebeEintrag([0], [1]), true);
    const baum = getBaum();
    assert.equal(baum.length, 1);
    assert.deepEqual(alleVerbindungen().map((e) => e.pfad), [[0, 0]]);
  });

  test('Aus dem Ordner geht es auch wieder zurueck in die Wurzel', async () => {
    await verschiebeEintrag([0], [1]);
    assert.equal(await verschiebeEintrag([0, 0], []), true);
    assert.deepEqual(alleVerbindungen().map((e) => e.pfad), [[1]]);
  });

  test('Ein Ordner darf nicht in sich selbst wandern', async () => {
    setze([{ type: 'folder', name: 'O', children: [{ type: 'folder', name: 'U', children: [] }] }]);
    assert.equal(await verschiebeEintrag([0], [0, 0]), false, 'in das eigene Kind nicht');
    assert.equal(await verschiebeEintrag([0], [0]), false, 'in sich selbst auch nicht');
  });

  test('Ein Pfad ins Leere aendert nichts', async () => {
    const vorher = getBaum();
    await schreibeEintragAn([7], { name: 'X', host: '1.2.3.4' });
    await entferneEintragAn([7]);
    await entferneEintragAn([0, 3]);
    assert.deepEqual(getBaum(), vorher);
  });

  test('Das Loeschen eines Ordners nimmt seinen Inhalt mit', async () => {
    setze([
      { type: 'folder', name: 'Weg', children: [{ name: 'Mit', host: '10.0.0.1' }] },
      { name: 'Bleibt', host: '10.0.0.2' },
    ]);
    await entferneEintragAn([0]);
    assert.deepEqual(getConnections().map((c) => c.name), ['Bleibt']);
  });

  test('Geschrieben wird in die globalen Einstellungen', async () => {
    await addFolder('Neu');
    const schreibzugriff = notizen.schreibzugriffe.at(-1)!;
    assert.equal(schreibzugriff.schluessel, 'connections');
    assert.equal(schreibzugriff.ziel, 1, 'ConfigurationTarget.Global');
  });
});
