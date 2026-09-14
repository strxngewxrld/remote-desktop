// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  OutputChannel,
  ThemeIcon,
  antworten,
  einstellungen,
  notizen,
  window as fensterAttrappe,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConnectionNode,
  FolderNode,
  VERERBBARE_SCHLUESSEL,
  alleVerbindungen,
  effektiveFarbe,
  loeseVerbindungAuf,
  getBaum,
  normalisiereBaum,
} from '../src/connections.js';
import type { RdpBaumEintrag, RdpConnection, RdpFolder } from '../src/connections.js';
import { FARBEN, istFarbName, symbolDateiname, symbolSvg } from '../src/farben.js';
import { RdpSession, farbSymbolUri } from '../src/session.js';
import { CertificateTrustStore } from '../src/trust.js';
import { activate, deactivate } from '../src/extension.js';
import { starteWebview } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

/** Ein Baum aus Ordnern und Verbindungen, wie er in den Einstellungen stuende. */
function setzeBaum(baum: RdpBaumEintrag[]): void {
  einstellungen.set('rdp.connections', baum);
}

/** Die Verbindung mit diesem Namen, samt angewandter Ordnervererbung. */
function aufgeloest(name: string): RdpConnection {
  const eintrag = alleVerbindungen().find((e) => e.verbindung.name === name);
  assert.ok(eintrag, `Verbindung "${name}" steht nicht im Baum`);
  return loeseVerbindungAuf(eintrag);
}

// --------------------------------------------------------------- Vererbung

describe('Kennfarbe - Vererbung', () => {
  beforeEach(() => zuruecksetzen());

  test('Die Farbe laeuft durch dieselbe Vererbung wie jedes andere Feld', () => {
    // Wenn die Farbe hier fehlt, hat sie einen zweiten Aufloesungsweg - und
    // genau das soll sie nicht haben.
    assert.ok(VERERBBARE_SCHLUESSEL.includes('color'));
  });

  test('Ohne Angabe bleibt eine Verbindung farblos', () => {
    setzeBaum([{ name: 'Frei', host: '10.0.0.1' }]);
    assert.equal(aufgeloest('Frei').color, undefined);
  });

  test('Der Ordner faerbt alles, was in ihm liegt', () => {
    setzeBaum([
      {
        type: 'folder',
        name: 'Produktion',
        settings: { color: 'red' },
        children: [
          { name: 'DC01', host: '10.1.0.10' },
          { name: 'DC02', host: '10.1.0.11' },
        ],
      },
    ]);
    assert.equal(aufgeloest('DC01').color, 'red');
    assert.equal(aufgeloest('DC02').color, 'red');
  });

  test('Die Verbindung schlaegt den Ordner', () => {
    setzeBaum([
      {
        type: 'folder',
        name: 'Produktion',
        settings: { color: 'red' },
        children: [{ name: 'Ausnahme', host: '10.1.0.12', color: 'gray' }],
      },
    ]);
    assert.equal(aufgeloest('Ausnahme').color, 'gray');
  });

  test('Der naechstgelegene Ordner schlaegt den Elternordner', () => {
    setzeBaum([
      {
        type: 'folder',
        name: 'Kunde A',
        settings: { color: 'red' },
        children: [
          { name: 'Direkt', host: '10.1.0.1' },
          {
            type: 'folder',
            name: 'Test',
            settings: { color: 'green' },
            children: [{ name: 'TST01', host: '10.1.1.1' }],
          },
          {
            type: 'folder',
            name: 'Ohne eigene Farbe',
            children: [{ name: 'X01', host: '10.1.2.1' }],
          },
        ],
      },
    ]);
    assert.equal(aufgeloest('Direkt').color, 'red');
    assert.equal(aufgeloest('TST01').color, 'green', 'der innere Ordner gewinnt');
    assert.equal(aufgeloest('X01').color, 'red', 'ohne eigene Farbe erbt der Ordner weiter nach oben');
  });

  test('Die Herkunft der Farbe ist nachvollziehbar', () => {
    setzeBaum([
      {
        type: 'folder',
        name: 'Produktion',
        settings: { color: 'red' },
        children: [
          { name: 'Geerbt', host: '10.1.0.1' },
          { name: 'Eigen', host: '10.1.0.2', color: 'blue' },
        ],
      },
      { name: 'Wurzel', host: '10.2.0.1' },
    ]);
    const eintraege = alleVerbindungen();
    const nach = (name: string) => eintraege.find((e) => e.verbindung.name === name)!;

    assert.deepEqual(effektiveFarbe(nach('Geerbt')), { name: 'red', geerbtVon: 'Produktion' });
    assert.deepEqual(effektiveFarbe(nach('Eigen')), { name: 'blue' });
    assert.equal(effektiveFarbe(nach('Wurzel')), undefined);
  });

  test('Ein unbekannter Farbname wird beim Lesen verworfen, statt zu wirken', () => {
    const baum = normalisiereBaum([
      { name: 'Krumm', host: '10.0.0.1', color: 'neongruen' },
      { type: 'folder', name: 'Ordner', settings: { color: 42 }, children: [] },
    ]);
    assert.equal((baum[0] as RdpConnection).color, undefined);
    assert.equal((baum[1] as { settings?: { color?: unknown } }).settings, undefined);
  });

  test('Ein bekannter Farbname ueberlebt das Lesen unveraendert', () => {
    const baum = normalisiereBaum([
      { name: 'Gut', host: '10.0.0.1', color: 'purple' },
      { type: 'folder', name: 'Ordner', settings: { color: 'yellow' }, children: [] },
    ]);
    assert.equal((baum[0] as RdpConnection).color, 'purple');
    assert.equal((baum[1] as { settings?: { color?: unknown } }).settings?.color, 'yellow');
  });

  test('istFarbName laesst nur die sieben benannten Farben durch', () => {
    for (const name of Object.keys(FARBEN)) assert.equal(istFarbName(name), true, name);
    for (const murks of ['', 'Rot', '#ff0000', 42, null, undefined]) {
      assert.equal(istFarbName(murks), false, String(murks));
    }
  });
});

// ------------------------------------------------------------ Baumansicht

describe('Kennfarbe - Baumansicht', () => {
  beforeEach(() => zuruecksetzen());

  test('Das Symbol einer gefaerbten Verbindung traegt die Themefarbe', () => {
    setzeBaum([
      {
        type: 'folder',
        name: 'Produktion',
        settings: { color: 'red' },
        children: [{ name: 'DC01', host: '10.1.0.10' }],
      },
    ]);
    const knoten = new ConnectionNode(alleVerbindungen()[0]!);
    const symbol = knoten.iconPath as ThemeIcon;
    assert.ok(symbol instanceof ThemeIcon);
    assert.equal(symbol.id, 'vm');
    assert.equal(symbol.color?.id, FARBEN.red.themeFarbe);
  });

  test('Ohne Farbe bleibt das Symbol so, wie es war', () => {
    setzeBaum([{ name: 'Frei', host: '10.0.0.1' }]);
    const symbol = new ConnectionNode(alleVerbindungen()[0]!).iconPath as ThemeIcon;
    assert.equal(symbol.id, 'vm');
    assert.equal(symbol.color, undefined);
  });

  test('Der Tooltip nennt die Farbe und sagt, woher sie kommt', () => {
    setzeBaum([
      {
        type: 'folder',
        name: 'Produktion',
        settings: { color: 'red' },
        children: [
          { name: 'Geerbt', host: '10.1.0.1' },
          { name: 'Eigen', host: '10.1.0.2', color: 'blue' },
        ],
      },
    ]);
    const [geerbt, eigen] = alleVerbindungen().map((e) => new ConnectionNode(e));
    const text = (k: ConnectionNode) => String((k.tooltip as { value: string }).value);
    assert.match(text(geerbt!), /- Farbe: Rot \(geerbt von "Produktion"\)/);
    assert.match(text(eigen!), /- Farbe: Blau$/m);
  });

  test('Auch der Ordner selbst zeigt seine Farbe', () => {
    const ordner = new FolderNode(
      { type: 'folder', name: 'Produktion', settings: { color: 'orange' }, children: [] },
      [0],
      [],
    );
    const symbol = ordner.iconPath as ThemeIcon;
    assert.equal(symbol.id, 'folder');
    assert.equal(symbol.color?.id, FARBEN.orange.themeFarbe);
    assert.match(String((ordner.tooltip as { value: string }).value), /- Farbe: Orange \(gilt für alles im Ordner\)/);
  });
});

// ---------------------------------------------------------------- Manifest

describe('Kennfarbe - Manifest', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes: { colors?: { id: string; defaults: Record<string, string> }[] };
  };

  test('Jede Themefarbe, die der Code benutzt, ist auch beigetragen', () => {
    // Ein `ThemeColor` auf einen nicht registrierten Schluessel zeichnet
    // VS Code gar nicht - der Eintrag bliebe einfach farblos.
    const beigetragen = new Set((manifest.contributes.colors ?? []).map((c) => c.id));
    for (const farbe of Object.values(FARBEN)) {
      assert.ok(beigetragen.has(farbe.themeFarbe), `${farbe.themeFarbe} fehlt unter contributes.colors`);
    }
  });

  test('Jede beigetragene Farbe hat Vorgaben fuer alle vier Themearten', () => {
    for (const eintrag of manifest.contributes.colors ?? []) {
      for (const art of ['dark', 'light', 'highContrast', 'highContrastLight']) {
        assert.match(eintrag.defaults[art] ?? '', /^#[0-9a-f]{6}$/i, `${eintrag.id}.${art}`);
      }
    }
  });
});

// ------------------------------------------------------------- Panelsymbol

describe('Kennfarbe - Panelsymbol', () => {
  let kontext: ExtensionContext;

  beforeEach(() => {
    zuruecksetzen();
    kontext = new ExtensionContext();
  });

  afterEach(() => kontext.entsorgeAlles());

  test('Das erzeugte SVG traegt den Farbwert', () => {
    const svg = symbolSvg(FARBEN.green.hex);
    assert.ok(svg.startsWith('<svg '), svg.slice(0, 20));
    assert.ok(svg.includes(`stroke="${FARBEN.green.hex}"`));
    assert.ok(svg.includes(`fill="${FARBEN.green.hex}"`));
  });

  test('Die Datei landet im Ablageort der Extension', async () => {
    const ort = await farbSymbolUri(kontext as never, 'blue');
    assert.ok(ort, 'es gibt einen Ort');
    assert.equal(ort.fsPath, `/erweiterung/ablage/farbsymbole/${symbolDateiname('blue')}`);
    const geschrieben = notizen.geschriebeneDateien.at(-1);
    assert.equal(geschrieben?.pfad, ort.fsPath);
    assert.ok(Buffer.from(geschrieben!.inhalt).toString('utf8').includes(FARBEN.blue.hex));
  });

  test('Ohne Farbe wird gar nichts geschrieben', async () => {
    assert.equal(await farbSymbolUri(kontext as never, undefined), undefined);
    assert.equal(notizen.geschriebeneDateien.length, 0);
  });
});

// -------------------------------------------------------- Sitzung und Panel

describe('Kennfarbe - Sitzung', () => {
  let kontext: ExtensionContext;
  let ausgabe: OutputChannel;
  const offen: RdpSession[] = [];

  async function oeffne(verbindung: RdpConnection): Promise<RdpSession> {
    const sitzung = await RdpSession.open(kontext, verbindung, ausgabe, new CertificateTrustStore(kontext));
    offen.push(sitzung);
    return sitzung;
  }

  /** Die zuletzt ans Webview geschickte Farbnachricht. */
  function letzteFarbe(index = 0): Record<string, unknown> | undefined {
    const gesendet = notizen.panels[index]!.webview.gesendet;
    return gesendet.filter((n) => (n as { type?: string })?.type === 'farbe').at(-1) as
      | Record<string, unknown>
      | undefined;
  }

  beforeEach(() => {
    zuruecksetzen();
    kontext = new ExtensionContext();
    ausgabe = fensterAttrappe.createOutputChannel('Remote Desktop (RDP)');
  });

  afterEach(() => {
    for (const sitzung of offen.splice(0)) sitzung.dispose();
    kontext.entsorgeAlles();
  });

  test('Der Farbpunkt steht unabhängig von Tab-Symbolen direkt im Titel', async () => {
    einstellungen.set('workbench.editor.showIcons', false);
    await oeffne({ name: 'Prod', host: '10.0.0.1', color: 'red' });
    assert.equal(notizen.panels[0]!.title, '🔴 Prod');
    assert.equal(notizen.panels[0]!.iconPath, undefined);
  });

  test('Ohne Farbe bleibt es beim gewoehnlichen Symbol', async () => {
    await oeffne({ name: 'Frei', host: '10.0.0.1' });
    assert.equal(notizen.panels[0]!.iconPath?.toString(), 'file:///erweiterung/media/rdp-icon.svg');
  });

  test('Rahmenfarbe und -breite gehen ans Webview', async () => {
    const sitzung = await oeffne({ name: 'Prod', host: '10.0.0.1', color: 'red' });
    sitzung.applyConfiguration();
    assert.deepEqual(letzteFarbe(), { type: 'farbe', hex: FARBEN.red.hex, titel: 'Rot', breite: 3 });
  });

  test('Die Breite kommt aus der Einstellung', async () => {
    einstellungen.set('rdp.colorFrameWidth', 8);
    const sitzung = await oeffne({ name: 'Prod', host: '10.0.0.1', color: 'green' });
    sitzung.applyConfiguration();
    assert.equal(letzteFarbe()?.breite, 8);
  });

  test('Breite 0 schaltet den Rahmen ab, die Farbe bleibt sonst erhalten', async () => {
    einstellungen.set('rdp.colorFrameWidth', 0);
    const sitzung = await oeffne({ name: 'Prod', host: '10.0.0.1', color: 'green' });
    sitzung.applyConfiguration();
    assert.equal(letzteFarbe()?.breite, 0);
  });

  test('Ohne Kennfarbe wird gar keine Breite gemeldet', async () => {
    const sitzung = await oeffne({ name: 'Frei', host: '10.0.0.1' });
    sitzung.applyConfiguration();
    assert.deepEqual(letzteFarbe(), { type: 'farbe', hex: undefined, titel: undefined, breite: 0 });
  });
});

// ------------------------------------------------------------ Rahmen im DOM

describe('Kennfarbe - Rahmen im Webview', () => {
  test('Ohne Nachricht bleibt der Rahmen aus', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    assert.equal(w.rahmen.sichtbar, false);
  });

  test('Die Farbnachricht faerbt den Rahmen', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'farbe', hex: '#e51400', titel: 'Rot', breite: 4 });
    assert.equal(w.rahmen.sichtbar, true);
    assert.equal(w.rahmen.breite, '4px');
    assert.equal(w.rahmen.farbe, '#e51400');
  });

  test('Breite 0 oder fehlende Farbe blendet ihn wieder aus', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'farbe', hex: '#e51400', breite: 4 });
    w.sende({ type: 'farbe', hex: '#e51400', breite: 0 });
    assert.equal(w.rahmen.sichtbar, false);

    w.sende({ type: 'farbe', hex: '#e51400', breite: 4 });
    w.sende({ type: 'farbe', breite: 4 });
    assert.equal(w.rahmen.sichtbar, false);
  });

  test('Der Rahmen ruehrt die gemeldete Groesse nicht an', () => {
    // Der Kern der Sache: der farbige Rand darf die Aufloesung, die ueber
    // MS-RDPEDISP angefragt wird, um kein einziges Pixel verschieben.
    const ohne = starteWebview(skript);
    ohne.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false, dynamicResolution: true });
    ohne.groesseAendern(1400, 900);

    const mit = starteWebview(skript);
    mit.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false, dynamicResolution: true });
    mit.sende({ type: 'farbe', hex: '#e51400', breite: 12 });
    mit.groesseAendern(1400, 900);

    const anfragen = (u: typeof ohne) =>
      u.gesendet.filter((n) => (n as { type?: string })?.type === 'resizeRequest');
    return new Promise<void>((fertig) => {
      setTimeout(() => {
        assert.deepEqual(anfragen(mit), anfragen(ohne));
        assert.ok(anfragen(mit).length > 0, 'es wurde ueberhaupt eine Groesse angefragt');
        fertig();
      }, 600);
    });
  });
});

// ------------------------------------------------------------------ Befehl

describe('Kennfarbe - Befehl', () => {
  let kontext: ExtensionContext;

  beforeEach(() => {
    zuruecksetzen();
    kontext = new ExtensionContext();
  });

  afterEach(() => {
    deactivate();
    kontext.entsorgeAlles();
  });

  test('Die Auswahl bietet "keine Farbe" und alle benannten Farben', async () => {
    setzeBaum([{ name: 'DC01', host: '10.0.0.1' }]);
    activate(kontext);
    const knoten = new ConnectionNode(alleVerbindungen()[0]!);
    // Escape in der Auswahl: nichts darf geschrieben werden.
    await notizen.befehle.get('rdp.setColor')!(knoten);

    const liste = notizen.auswahllisten.at(-1)!;
    assert.equal(liste.eintraege.length, Object.keys(FARBEN).length + 1);
    assert.match(liste.eintraege[0]!.label, /Keine Farbe/);
    assert.deepEqual(
      liste.eintraege.slice(1).map((e) => e.detail),
      Object.values(FARBEN).map((f) => f.beschreibung),
    );
    assert.equal(notizen.schreibzugriffe.length, 0, 'ein Abbruch aendert nichts');
  });

  test('Die gewaehlte Farbe landet an der Verbindung', async () => {
    setzeBaum([{ name: 'DC01', host: '10.0.0.1' }]);
    activate(kontext);
    // Index 1 ist die erste echte Farbe, also Rot.
    notizen.auswahllisten.length = 0;
    antworten.auswahlen.push(1);
    await notizen.befehle.get('rdp.setColor')!(new ConnectionNode(alleVerbindungen()[0]!));
    assert.equal(aufgeloest('DC01').color, 'red');
  });

  test('An einem Ordner landet sie in den vererbten Einstellungen', async () => {
    setzeBaum([{ type: 'folder', name: 'Produktion', children: [{ name: 'DC01', host: '10.0.0.1' }] }]);
    activate(kontext);
    antworten.auswahlen.push(1);
    // Den Knoten aus dem echten Baum bauen - sonst schriebe der Befehl einen
    // Ordner zurueck, der seine Kinder gar nicht kennt.
    const eintrag = getBaum()[0] as RdpFolder;
    await notizen.befehle.get('rdp.setColor')!(new FolderNode(eintrag, [0], []));

    const geschrieben = notizen.schreibzugriffe.at(-1)!.wert as RdpBaumEintrag[];
    assert.equal((geschrieben[0] as { settings?: { color?: string } }).settings?.color, 'red');
    // Und die Verbindung darin erbt sie.
    assert.equal(aufgeloest('DC01').color, 'red');
  });

  test('"Keine Farbe" entfernt sie wieder', async () => {
    setzeBaum([{ name: 'DC01', host: '10.0.0.1', color: 'red' }]);
    activate(kontext);
    antworten.auswahlen.push(0);
    await notizen.befehle.get('rdp.setColor')!(new ConnectionNode(alleVerbindungen()[0]!));
    assert.equal(aufgeloest('DC01').color, undefined);
  });
});
