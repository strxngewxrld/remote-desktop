/**
 * Remote-SSH: laeuft die Extension am richtigen Ort, und sagt sie es auch?
 *
 * Ein echter SSH-Aufbau laesst sich im Testlauf nicht herstellen. Was sich
 * pruefen laesst, ist alles, was davor kommt: das Versprechen des Manifests,
 * die Auskunft der Extension ueber ihren eigenen Standort, die Warnung fuer
 * den einen Fall, in dem es still schiefginge, und die Frage, welche
 * Plattform fuer die Tastatur zustaendig ist.
 */
import {
  ExtensionContext,
  ExtensionKind,
  UIKind,
  notizen,
  umgebung,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXTENSION_ID,
  Laufzeitumgebung,
  activate,
  beschreibeLaufzeit,
  dateisystemHinweis,
  deactivate,
  ermittleLaufzeit,
  laufzeitWarnung,
  normalisierePlattform,
  sitzungsHerkunftszeile,
  tastaturPlattform,
  verbindungsHerkunft,
} from '../src/extension.js';

interface Manifest {
  publisher: string;
  name: string;
  main?: string;
  extensionKind?: string[];
  contributes: { commands: { command: string; title: string }[] };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as Manifest;

let kontext: ExtensionContext;

beforeEach(() => {
  zuruecksetzen();
  kontext = new ExtensionContext();
});

afterEach(() => {
  deactivate();
  kontext.entsorgeAlles();
});

describe('Manifest - wo VS Code die Extension laden soll', () => {
  test('extensionKind ist ausdruecklich "workspace"', () => {
    // Der Verbindungsaufbau muss vom Rechner ausgehen, an dem der
    // Arbeitsbereich haengt. Nur so ist ein Windows-Server erreichbar, der
    // hinter dem SSH-Rechner liegt.
    assert.deepEqual(manifest.extensionKind, ['workspace']);
  });

  test('"ui" steht nicht in der Rangfolge', () => {
    // Mit "ui" irgendwo in der Liste duerfte VS Code die Extension lokal
    // laden - die Verbindung kaeme dann vom Arbeitsplatz und der Server waere
    // unerreichbar, ohne dass irgendetwas danach aussaehe.
    assert.equal(manifest.extensionKind?.includes('ui'), false);
  });

  test('EXTENSION_ID passt zu publisher und name', () => {
    assert.equal(EXTENSION_ID, `${manifest.publisher}.${manifest.name}`);
  });

  test('die Extension hat einen main-Einstiegspunkt', () => {
    // Daraus leitet VS Code "workspace" auch ohne die Angabe ab; die Angabe
    // macht aus der Ableitung eine Zusage.
    assert.ok(manifest.main);
  });

  test('der Diagnosebefehl steht im Manifest', () => {
    const befehle = manifest.contributes.commands.map((c) => c.command);
    assert.ok(befehle.includes('rdp.showEnvironment'));
  });
});

describe('Laufzeitumgebung erkennen', () => {
  test('ohne remoteName ist die Umgebung lokal', () => {
    const u = ermittleLaufzeit();
    assert.equal(u.entfernt, false);
    assert.equal(u.fernart, undefined);
    assert.equal(u.geladenAls, 'workspace');
    assert.equal(u.hostPlattform, process.platform);
  });

  test('mit remoteName ist die Umgebung entfernt', () => {
    umgebung.fernart = 'ssh-remote';
    const u = ermittleLaufzeit();
    assert.equal(u.entfernt, true);
    assert.equal(u.fernart, 'ssh-remote');
  });

  test('ein leerer remoteName zaehlt nicht als entfernt', () => {
    umgebung.fernart = '';
    const u = ermittleLaufzeit();
    assert.equal(u.entfernt, false);
    assert.equal(u.fernart, undefined);
  });

  test('UI-Host wird als "ui" gemeldet', () => {
    umgebung.geladenAls = ExtensionKind.UI;
    assert.equal(ermittleLaufzeit().geladenAls, 'ui');
  });

  test('kennt VS Code die Extension nicht, bleibt der Ort unbekannt', () => {
    umgebung.bekannt = false;
    assert.equal(ermittleLaufzeit().geladenAls, 'unbekannt');
  });

  test('der Browser-Fall wird erkannt', () => {
    umgebung.oberflaeche = UIKind.Web;
    assert.equal(ermittleLaufzeit().imBrowser, true);
  });
});

describe('Auskunft im Protokoll', () => {
  const lokal: Laufzeitumgebung = {
    entfernt: false,
    fernart: undefined,
    hostPlattform: 'darwin',
    imBrowser: false,
    geladenAls: 'workspace',
  };
  const entfernt: Laufzeitumgebung = {
    entfernt: true,
    fernart: 'ssh-remote',
    hostPlattform: 'linux',
    imBrowser: false,
    geladenAls: 'workspace',
  };

  test('lokal nennt den eigenen Rechner als Ausgangspunkt', () => {
    const text = beschreibeLaufzeit(lokal).join('\n');
    assert.match(text, /lokal/);
    assert.match(text, /darwin/);
    assert.equal(verbindungsHerkunft(lokal), 'dieser Rechner (lokal)');
  });

  test('entfernt nennt die Fernart als Ausgangspunkt', () => {
    const text = beschreibeLaufzeit(entfernt).join('\n');
    assert.match(text, /ssh-remote/);
    assert.match(text, /linux/);
    assert.match(text, /Dateisystem des entfernten Rechners/);
    assert.equal(verbindungsHerkunft(entfernt), 'entfernter Rechner (ssh-remote)');
  });

  test('der Hinweis auf das Dateisystem erscheint nur entfernt', () => {
    assert.equal(dateisystemHinweis(lokal), '');
    assert.match(dateisystemHinweis(entfernt), /ssh-remote/);
  });

  test('die Sitzungszeile nennt Ziel und Ausgangspunkt', () => {
    const zeile = sitzungsHerkunftszeile(entfernt, 'srv01', 3389);
    assert.match(zeile, /srv01:3389/);
    assert.match(zeile, /ssh-remote/);
  });
});

describe('Warnung statt stillem Fehlschlag', () => {
  test('lokal gibt es nichts zu warnen', () => {
    assert.equal(laufzeitWarnung(ermittleLaufzeit()), undefined);
  });

  test('entfernt und richtig geladen gibt es nichts zu warnen', () => {
    umgebung.fernart = 'ssh-remote';
    assert.equal(laufzeitWarnung(ermittleLaufzeit()), undefined);
  });

  test('entferntes Fenster, lokal geladen: das wird erklaert', () => {
    umgebung.fernart = 'ssh-remote';
    umgebung.geladenAls = ExtensionKind.UI;
    const warnung = laufzeitWarnung(ermittleLaufzeit());
    assert.ok(warnung, 'es muss eine Warnung geben');
    assert.match(warnung, /remote\.extensionKind/);
    assert.match(warnung, /nicht vom entfernten Rechner/);
  });

  test('unbekannter Ort verweist auf "Show Running Extensions"', () => {
    umgebung.fernart = 'ssh-remote';
    umgebung.bekannt = false;
    assert.match(String(laufzeitWarnung(ermittleLaufzeit())), /Show Running Extensions/);
  });
});

describe('Plattform fuer die Tastaturabbildung', () => {
  const entfernteUmgebung: Laufzeitumgebung = {
    entfernt: true,
    fernart: 'ssh-remote',
    hostPlattform: 'linux',
    imBrowser: false,
    geladenAls: 'workspace',
  };
  const lokaleUmgebung: Laufzeitumgebung = { ...entfernteUmgebung, entfernt: false, fernart: undefined, hostPlattform: 'darwin' };

  test('navigator-Namen werden auf process.platform-Namen gebracht', () => {
    assert.equal(normalisierePlattform('MacIntel'), 'darwin');
    assert.equal(normalisierePlattform('Win32'), 'win32');
    assert.equal(normalisierePlattform('Linux x86_64'), 'linux');
    assert.equal(normalisierePlattform('darwin'), 'darwin');
    assert.equal(normalisierePlattform(undefined), undefined);
    assert.equal(normalisierePlattform(''), undefined);
  });

  test('unbekannte Namen werden nicht geraten, sondern durchgereicht', () => {
    assert.equal(normalisierePlattform('SunOS'), 'SunOS');
  });

  test('die Meldung des Webviews gewinnt - auch gegen den Host', () => {
    // Der Kern des Remote-SSH-Falls: Host linux, Nutzer am Mac. Nach
    // process.platform wuerde eine Cmd-Abbildung nie greifen.
    const gewaehlt = tastaturPlattform(entfernteUmgebung, 'MacIntel');
    assert.equal(gewaehlt.plattform, 'darwin');
    assert.equal(gewaehlt.quelle, 'webview');
    assert.equal(gewaehlt.verlaesslich, true);
  });

  test('lokal darf der Extension-Host einspringen', () => {
    const gewaehlt = tastaturPlattform(lokaleUmgebung);
    assert.equal(gewaehlt.plattform, 'darwin');
    assert.equal(gewaehlt.quelle, 'extension-host');
    assert.equal(gewaehlt.verlaesslich, true);
  });

  test('entfernt und ohne Meldung ist der Host nur ein Notbehelf', () => {
    const gewaehlt = tastaturPlattform(entfernteUmgebung);
    assert.equal(gewaehlt.plattform, 'linux');
    assert.equal(gewaehlt.quelle, 'extension-host');
    assert.equal(gewaehlt.verlaesslich, false);
  });
});

describe('Der Weg durch die Extension', () => {
  test('activate schreibt die Umgebung ins Protokoll', () => {
    activate(kontext);
    const text = notizen.protokoll.join('\n');
    assert.match(text, /Extension-Host/);
    assert.match(text, /RDP-Verbindungen gehen aus von/);
  });

  test('activate warnt sichtbar, wenn die Extension am falschen Ort laeuft', () => {
    umgebung.fernart = 'ssh-remote';
    umgebung.geladenAls = ExtensionKind.UI;
    activate(kontext);
    assert.equal(notizen.warnungen.length, 1);
    assert.match(notizen.warnungen[0]!, /ssh-remote/);
    assert.match(notizen.protokoll.join('\n'), /WARNUNG:/);
  });

  test('activate warnt nicht, wenn alles stimmt', () => {
    umgebung.fernart = 'ssh-remote';
    activate(kontext);
    assert.equal(notizen.warnungen.length, 0);
  });

  test('rdp.showEnvironment gibt es und er berichtet ueber den entfernten Host', async () => {
    umgebung.fernart = 'ssh-remote';
    activate(kontext);
    notizen.protokoll.length = 0;
    notizen.hinweise.length = 0;
    const befehl = notizen.befehle.get('rdp.showEnvironment');
    assert.ok(befehl, 'der Befehl muss registriert sein');
    await befehl();
    const text = notizen.protokoll.join('\n');
    assert.match(text, /Laufzeitumgebung/);
    assert.match(text, /ssh-remote/);
    assert.equal(notizen.hinweise.length, 1);
    assert.match(notizen.hinweise[0]!, /ssh-remote/);
  });

  test('der Befehl meldet einen Wechsel der Umgebung nach der Aktivierung', () => {
    activate(kontext);
    // Das Fenster wechselt: erst lokal, dann an einen entfernten Rechner.
    umgebung.fernart = 'ssh-remote';
    notizen.protokoll.length = 0;
    notizen.befehle.get('rdp.showEnvironment')!();
    assert.match(notizen.protokoll.join('\n'), /ssh-remote/);
  });
});
