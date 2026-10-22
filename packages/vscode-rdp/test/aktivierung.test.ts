// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  antworten,
  einstellungen,
  notizen,
  workspace,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activate, deactivate } from '../src/extension.js';
import type { RdpConnection } from '../src/connections.js';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    keybindings: { command: string; key: string }[];
    viewsWelcome: { view: string; contents: string }[];
    configuration: { properties: Record<string, { scope?: string }> };
  };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as Manifest;

/** Die Befehle, die das Manifest der Oberflaeche verspricht. */
const versprocheneBefehle = manifest.contributes.commands.map((c) => c.command).sort();

let kontext: ExtensionContext;

beforeEach(() => {
  zuruecksetzen();
  kontext = new ExtensionContext();
});

afterEach(() => {
  deactivate();
  kontext.entsorgeAlles();
});

describe('Aktivierung', () => {
  test('activate laeuft ohne Ausnahme durch', () => {
    assert.doesNotThrow(() => activate(kontext));
  });

  test('Jeder im Manifest versprochene Befehl wird auch registriert', () => {
    activate(kontext);
    const registriert = [...notizen.befehle.keys()].sort();

    // Beide Richtungen pruefen: ein Befehl im Manifest ohne Registrierung
    // scheitert beim Benutzer stumm ("command not found"), eine Registrierung
    // ohne Manifest ist in der Oberflaeche nicht erreichbar.
    assert.deepEqual(registriert, versprocheneBefehle);
  });

  test('Menues und Tastenkuerzel verweisen nur auf deklarierte Befehle', () => {
    const bekannt = new Set(versprocheneBefehle);
    const verweise: { ort: string; befehl: string }[] = [];

    for (const [ort, eintraege] of Object.entries(manifest.contributes.menus)) {
      for (const eintrag of eintraege) verweise.push({ ort: `menus.${ort}`, befehl: eintrag.command });
    }
    for (const kuerzel of manifest.contributes.keybindings) {
      verweise.push({ ort: 'keybindings', befehl: kuerzel.command });
    }
    for (const willkommen of manifest.contributes.viewsWelcome) {
      for (const treffer of willkommen.contents.matchAll(/command:([\w.]+)/g)) {
        verweise.push({ ort: `viewsWelcome.${willkommen.view}`, befehl: treffer[1]! });
      }
    }

    const unbekannt = verweise.filter((v) => !bekannt.has(v.befehl));
    assert.deepEqual(unbekannt, [], 'Verweise auf nicht deklarierte Befehle');
    assert.ok(verweise.length > 0, 'das Manifest verweist ueberhaupt auf Befehle');
  });

  test('Alle Registrierungen haengen an context.subscriptions', () => {
    activate(kontext);
    assert.ok(notizen.befehle.size > 0);
    assert.ok(notizen.baumAnbieter.has('rdpConnections'), 'Baumansicht ist angemeldet');

    // VS Code entsorgt beim Neuladen genau diese Liste. Was nicht darin haengt,
    // ueberlebt das Neuladen und laesst die naechste Aktivierung scheitern.
    kontext.entsorgeAlles();

    assert.equal(notizen.befehle.size, 0, 'kein Befehl bleibt registriert');
    assert.equal(notizen.baumAnbieter.size, 0, 'keine Baumansicht bleibt angemeldet');
    assert.ok(
      notizen.ausgabekanaele.every((k) => k.entsorgt),
      'der Ausgabekanal wird mitentsorgt',
    );
    assert.ok(
      notizen.statusleisten.every((s) => s.entsorgt),
      'der Statusleisteneintrag wird mitentsorgt',
    );
  });

  test('Zweimal aktivieren ist nach dem Entsorgen wieder moeglich', () => {
    activate(kontext);
    kontext.entsorgeAlles();
    assert.doesNotThrow(() => activate(kontext));
  });

  test('deactivate wirft nicht, auch ohne offene Sitzung', () => {
    activate(kontext);
    assert.doesNotThrow(() => deactivate());
    assert.doesNotThrow(() => deactivate(), 'zweimal deaktivieren bleibt harmlos');
  });
});

describe('Einstellungen aus dem Arbeitsbereich', () => {
  // Ein fremdes Repository bringt seine .vscode/settings.json mit. Duerfte sie
  // diese Werte setzen, koennte sie Zertifikate abschalten, .env freigeben
  // oder eine Verbindung mit gespeichertem Passwort auf ihren Server lenken.
  const NUR_BENUTZER = [
    'rdp.authentication',
    'rdp.connections',
    'rdp.certificateTrust',
    'rdp.clipboard.enabled',
    'rdp.clipboard.direction',
    'rdp.clipboard.maxSizeKb',
    'rdp.clipboard.maxFileSizeMb',
    'rdp.driveRedirection.enabled',
    'rdp.driveRedirection.access',
    'rdp.driveRedirection.exclude',
    'rdp.driveRedirection.maxFileSizeMb',
  ];

  for (const schluessel of NUR_BENUTZER) {
    test(`${schluessel} gilt nur aus den Benutzereinstellungen`, () => {
      assert.equal(manifest.contributes.configuration.properties[schluessel]?.scope, 'application');
    });
  }
});

describe('Befehle ohne offene Sitzung', () => {
  beforeEach(() => activate(kontext));

  test('rdp.showLog oeffnet den Ausgabekanal', async () => {
    await notizen.befehle.get('rdp.showLog')!();
    assert.ok(
      notizen.ausgabekanaele.some((k) => k.sichtbar),
      'der Ausgabekanal wird sichtbar gemacht',
    );
  });

  for (const befehl of ['rdp.disconnect', 'rdp.sendCtrlAltDel', 'rdp.refreshScreen', 'rdp.toggleScaling']) {
    test(`${befehl} meldet die fehlende Sitzung, statt zu scheitern`, async () => {
      await notizen.befehle.get(befehl)!();
      assert.deepEqual(notizen.hinweise, ['Es ist keine RDP-Sitzung geöffnet.']);
      assert.deepEqual(notizen.fehlermeldungen, []);
    });
  }

  for (const befehl of ['rdp.connectSaved', 'rdp.editConnection', 'rdp.deleteConnection', 'rdp.clearCredentials']) {
    test(`${befehl} meldet die leere Liste, statt zu scheitern`, async () => {
      await notizen.befehle.get(befehl)!();
      assert.deepEqual(notizen.hinweise, ['Es sind keine Verbindungen gespeichert.']);
    });
  }

  test('rdp.forgetDriveApprovals loescht die gemerkten Antworten', async () => {
    // Gebraucht wird der Befehl gerade vor dem Verbinden: ein einmal
    // verweigertes Laufwerk taucht sonst nie wieder auf.
    await kontext.globalState.update('rdp.driveRedirection.freigaben', { 'a:3389': 'verweigert' });
    await notizen.befehle.get('rdp.forgetDriveApprovals')!();
    assert.equal(kontext.globalState.get('rdp.driveRedirection.freigaben'), undefined);
    assert.equal(notizen.hinweise.some((h) => h.includes('vergessen')), true);
  });

  test('rdp.refreshConnections stoesst die Baumansicht an', async () => {
    const anbieter = notizen.baumAnbieter.get('rdpConnections')!;
    let angestossen = 0;
    anbieter.onDidChangeTreeData!(() => angestossen++);

    await notizen.befehle.get('rdp.refreshConnections')!();
    assert.equal(angestossen, 1);
  });

  test('Eine geaenderte Verbindungsliste frischt die Baumansicht auf', () => {
    const anbieter = notizen.baumAnbieter.get('rdpConnections')!;
    let angestossen = 0;
    anbieter.onDidChangeTreeData!(() => angestossen++);

    workspace.meldeKonfigurationsAenderung(['rdp.connections']);
    assert.equal(angestossen, 1);

    workspace.meldeKonfigurationsAenderung(['rdp.logLevel']);
    assert.equal(angestossen, 1, 'ein unbeteiligter Wert loest nichts aus');
  });
});

describe('Verbindung anlegen', () => {
  beforeEach(() => activate(kontext));

  /** Liest heraus, was die Extension in die Einstellungen geschrieben hat. */
  function gespeicherteVerbindungen(): RdpConnection[] {
    return (einstellungen.get('rdp.connections') as RdpConnection[] | undefined) ?? [];
  }

  test('Host, Port, Domaene und Name landen in den globalen Einstellungen', async () => {
    antworten.eingaben.push('server.example.com:3390', 'DOMAENE\\benutzer', 'Mein Server');
    antworten.auswahlen.push(0); // "Standard verwenden" beim Tastaturlayout
    antworten.meldungen.push(undefined); // nicht sofort verbinden

    await notizen.befehle.get('rdp.addConnection')!();

    assert.deepEqual(gespeicherteVerbindungen(), [
      {
        name: 'Mein Server',
        host: 'server.example.com',
        port: 3390,
        username: 'benutzer',
        domain: 'DOMAENE',
        keyboardLayout: undefined,
      },
    ]);

    const schreibzugriff = notizen.schreibzugriffe.at(-1)!;
    assert.equal(schreibzugriff.schluessel, 'connections');
    assert.equal(schreibzugriff.ziel, 1, 'ConfigurationTarget.Global');
  });

  test('IPv6-Adressen in Klammern werden vom Port getrennt', async () => {
    antworten.eingaben.push('[fe80::1]:3390', '', 'Sechs');
    antworten.auswahlen.push(0);
    antworten.meldungen.push(undefined);

    await notizen.befehle.get('rdp.addConnection')!();

    const [verbindung] = gespeicherteVerbindungen();
    assert.equal(verbindung!.host, 'fe80::1');
    assert.equal(verbindung!.port, 3390);
  });

  test('Ohne Portangabe gilt 3389', async () => {
    antworten.eingaben.push('nur-ein-host', '', 'Ohne Port');
    antworten.auswahlen.push(0);
    antworten.meldungen.push(undefined);

    await notizen.befehle.get('rdp.addConnection')!();
    assert.equal(gespeicherteVerbindungen()[0]!.port, 3389);
  });

  test('Ein unmoeglicher Port wird abgelehnt und nichts gespeichert', async () => {
    antworten.eingaben.push('server:99999', '', 'Kaputt');

    await notizen.befehle.get('rdp.addConnection')!();

    assert.equal(notizen.fehlermeldungen.length, 1, 'der Benutzer erfaehrt davon');
    assert.deepEqual(gespeicherteVerbindungen(), []);
  });

  test('Das Passwort taucht nirgends in den Einstellungen auf', async () => {
    antworten.eingaben.push('server.example.com', 'benutzer', 'Mein Server');
    antworten.auswahlen.push(0);
    antworten.meldungen.push(undefined);

    await notizen.befehle.get('rdp.addConnection')!();

    // Der Vertrag aus dem Manifest: Passwoerter gehoeren in den sicheren
    // Speicher, nicht in settings.json. Also darf in den Einstellungen
    // ueberhaupt kein Feld dieses Namens entstehen.
    const abgelegt = JSON.stringify([...einstellungen.entries()]);
    assert.ok(!/passw/i.test(abgelegt), `kein Passwortfeld in den Einstellungen: ${abgelegt}`);
  });
});

describe('Verbindungen loeschen', () => {
  test('Es wird genau der ausgewaehlte Eintrag geloescht, nicht der gleichnamige', async () => {
    // Zuvor verglich removeConnection ueber `c !== connection || c.name !==
    // connection.name`. Die Objekte aus getConnections() sind frisch
    // deserialisiert, die Identitaetspruefung greift also nie - es wirkte
    // allein der Namensvergleich, und bei zwei gleich benannten Verbindungen
    // verschwanden beide.
    const { removeConnectionAt, getConnections } = await import('../src/connections.js');
    const eintraege = [
      { name: 'Gleich', host: '10.0.0.1' },
      { name: 'Gleich', host: '10.0.0.2' },
      { name: 'Anders', host: '10.0.0.3' },
    ];
    einstellungen.set('rdp.connections', eintraege);

    await removeConnectionAt(0);

    const uebrig = getConnections();
    assert.deepEqual(
      uebrig.map((c) => c.host),
      ['10.0.0.2', '10.0.0.3'],
      'nur der Eintrag an der gewaehlten Stelle ist weg',
    );
  });

  test('Ein Index ausserhalb der Liste aendert nichts', async () => {
    const { removeConnectionAt, getConnections } = await import('../src/connections.js');
    einstellungen.set('rdp.connections', [{ name: 'A', host: '10.0.0.1' }]);
    await removeConnectionAt(5);
    await removeConnectionAt(-1);
    assert.equal(getConnections().length, 1);
  });
});
