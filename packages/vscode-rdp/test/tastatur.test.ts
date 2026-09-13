/**
 * Mac-Tastenkuerzel in der Sitzung.
 *
 * Geprueft wird genau das, was am Ende auf dem Draht liegt: welche Scancodes
 * mit welchem E0-Praefix und in welcher Reihenfolge herausgehen. Die
 * Abbildung selbst folgt der Tabelle aus der Windows-App-Dokumentation
 * (Command+C/X/V/A/Z/F), und die Cmd-Taste ist dort die Windows-Taste.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
  MAC_KUERZEL_AUF_STRG,
  MacTastenabbildung,
  cmdAbbildungAktiv,
  type Tastenereignis,
} from '../src/keyboardLayouts.js';

/** Scancodes aus keymap.ts, hier noch einmal von Hand - als Gegenprobe. */
const STRG = 0x1d;
const WIN_LINKS = 0x5b;
const TASTEN: Record<string, number> = {
  KeyA: 0x1e,
  KeyC: 0x2e,
  KeyF: 0x21,
  KeyV: 0x2f,
  KeyX: 0x2d,
  KeyZ: 0x2c,
  KeyD: 0x20,
};

function kurz(ereignisse: Tastenereignis[]): string[] {
  return ereignisse.map(
    (e) => `${e.extended ? 'e0 ' : ''}${e.scancode.toString(16)}${e.down ? '↓' : '↑'}`,
  );
}

describe('Tastatur - wann die Cmd-Abbildung greift', () => {
  test('"auto" greift nur auf einem verlässlich gemeldeten Mac', () => {
    assert.equal(cmdAbbildungAktiv('auto', 'darwin', true), true);
    assert.equal(cmdAbbildungAktiv('auto', 'linux', true), false);
    assert.equal(cmdAbbildungAktiv('auto', 'win32', true), false);
  });

  test('"auto" rät nicht, wenn die Plattform unzuverlässig ist', () => {
    // Genau der Remote-SSH-Fall: der Extension-Host meldet "linux", der
    // Nutzer sitzt am Mac. Dann lieber nichts abbilden als das Falsche.
    assert.equal(cmdAbbildungAktiv('auto', 'darwin', false), false);
    assert.equal(cmdAbbildungAktiv('auto', undefined, false), false);
    assert.equal(cmdAbbildungAktiv('auto', 'unbekannt', true), false);
  });

  test('"on" und "off" entscheiden ohne Rücksicht auf die Plattform', () => {
    assert.equal(cmdAbbildungAktiv('on', 'linux', false), true);
    assert.equal(cmdAbbildungAktiv('off', 'darwin', true), false);
  });

  test('Ein unbekannter Einstellungswert verhält sich wie "auto"', () => {
    assert.equal(cmdAbbildungAktiv('vielleicht', 'darwin', true), true);
    assert.equal(cmdAbbildungAktiv(undefined, 'linux', true), false);
  });
});

describe('Tastatur - Cmd-Kürzel auf dem Draht', () => {
  for (const [code, bedeutung] of Object.entries(MAC_KUERZEL_AUF_STRG)) {
    test(`Cmd+${code.slice(3)} (${bedeutung}) geht als Strg+${code.slice(3)} hinaus`, () => {
      const a = new MacTastenabbildung();
      assert.deepEqual(a.taste('MetaLeft', true), { ereignisse: [], normalWeiter: false });

      const gedrueckt = a.taste(code, true);
      assert.equal(gedrueckt.normalWeiter, false, 'der gewöhnliche Weg bleibt aus');
      assert.deepEqual(kurz(gedrueckt.ereignisse), [
        `${STRG.toString(16)}↓`,
        `${TASTEN[code].toString(16)}↓`,
        `${TASTEN[code].toString(16)}↑`,
        `${STRG.toString(16)}↑`,
      ]);

      // macOS liefert dieses keyup oft gar nicht; kommt es doch, ist es zu viel.
      assert.deepEqual(a.taste(code, false), { ereignisse: [], normalWeiter: false });
      // Und die Windows-Taste geht nie hinaus.
      assert.deepEqual(a.taste('MetaLeft', false), { ereignisse: [], normalWeiter: false });
    });
  }

  test('Ohne Cmd bleibt alles, wie es war', () => {
    const a = new MacTastenabbildung();
    assert.deepEqual(a.taste('KeyC', true), { ereignisse: [], normalWeiter: true });
    assert.deepEqual(a.taste('KeyC', false), { ereignisse: [], normalWeiter: true });
  });

  test('Hält der Nutzer Strg schon, wird es nicht noch einmal gedrückt', () => {
    // Sonst löste das abschließende "Strg hoch" die Taste, die er hält.
    const a = new MacTastenabbildung();
    a.taste('ControlLeft', true);
    a.taste('MetaLeft', true);
    assert.deepEqual(kurz(a.taste('KeyZ', true).ereignisse), [
      `${TASTEN.KeyZ.toString(16)}↓`,
      `${TASTEN.KeyZ.toString(16)}↑`,
    ]);
  });

  test('Umschalt bleibt unangetastet, Cmd+Umschalt+Z wird zu Strg+Umschalt+Z', () => {
    const a = new MacTastenabbildung();
    assert.deepEqual(a.taste('ShiftLeft', true), { ereignisse: [], normalWeiter: true });
    a.taste('MetaLeft', true);
    assert.deepEqual(kurz(a.taste('KeyZ', true).ereignisse), [
      `${STRG.toString(16)}↓`,
      `${TASTEN.KeyZ.toString(16)}↓`,
      `${TASTEN.KeyZ.toString(16)}↑`,
      `${STRG.toString(16)}↑`,
    ]);
  });

  test('Cmd+Alt+V wird nicht abgebildet - es gehört dem Rückfallfeld', () => {
    const a = new MacTastenabbildung();
    a.taste('AltLeft', true);
    a.taste('MetaLeft', true);
    const v = a.taste('KeyV', true);
    assert.equal(v.normalWeiter, true, 'die Taste geht den gewöhnlichen Weg');
    assert.deepEqual(kurz(v.ereignisse), [`e0 ${WIN_LINKS.toString(16)}↓`]);
  });
});

describe('Tastatur - Cmd als Windows-Taste', () => {
  test('Cmd allein schickt erst einmal nichts', () => {
    const a = new MacTastenabbildung();
    assert.deepEqual(a.taste('MetaLeft', true), { ereignisse: [], normalWeiter: false });
    assert.equal(a.cmdGehalten, true);
    // Losgelassen, ohne dass etwas folgte: auch dann kein Win-Druck. Sonst
    // oeffnete jedes Antippen von Cmd das Startmenue des Servers.
    assert.deepEqual(a.taste('MetaLeft', false), { ereignisse: [], normalWeiter: false });
    assert.equal(a.cmdGehalten, false);
  });

  test('Cmd+D wird zu Win+D: die Windows-Taste kommt nachträglich', () => {
    const a = new MacTastenabbildung();
    a.taste('MetaLeft', true);
    const d = a.taste('KeyD', true);
    assert.deepEqual(kurz(d.ereignisse), [`e0 ${WIN_LINKS.toString(16)}↓`]);
    assert.equal(d.normalWeiter, true, 'die Taste D selbst geht den gewöhnlichen Weg');

    // Beim Loslassen von Cmd wird nachgeholt, was macOS verschweigt: das
    // keyup von D. Ohne das bliebe D auf dem Server gedrückt.
    assert.deepEqual(kurz(a.taste('MetaLeft', false).ereignisse), [
      `${TASTEN.KeyD.toString(16)}↑`,
      `e0 ${WIN_LINKS.toString(16)}↑`,
    ]);
  });

  test('Die Windows-Taste geht nur einmal je Cmd-Druck hinaus', () => {
    const a = new MacTastenabbildung();
    a.taste('MetaLeft', true);
    a.taste('KeyD', true);
    assert.deepEqual(a.taste('Digit1', true).ereignisse, [], 'kein zweiter Win-Druck');
  });

  test('Die rechte Cmd-Taste sendet die rechte Windows-Taste', () => {
    const a = new MacTastenabbildung();
    a.taste('MetaRight', true);
    assert.deepEqual(kurz(a.taste('KeyD', true).ereignisse), ['e0 5c↓']);
    assert.deepEqual(kurz(a.taste('MetaRight', false).ereignisse), [
      `${TASTEN.KeyD.toString(16)}↑`,
      'e0 5c↑',
    ]);
  });

  test('zuruecksetzen() vergisst alles - nach Fokusverlust weiß niemand mehr etwas', () => {
    const a = new MacTastenabbildung();
    a.taste('MetaLeft', true);
    a.taste('KeyD', true);
    a.zuruecksetzen();
    assert.equal(a.cmdGehalten, false);
    assert.deepEqual(a.taste('KeyC', true), { ereignisse: [], normalWeiter: true });
  });
});

// ------------------------------------------------- Meldung aus dem Webview

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { starteWebview } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

describe('Tastatur - das Webview meldet die Plattform', () => {
  test('Gleich beim Start geht die Plattform an den Host', () => {
    const w = starteWebview(skript, {}, { plattform: 'MacIntel' });
    const meldung = w.gesendet.find((n) => (n as { type?: string }).type === 'plattform');
    assert.deepEqual(meldung, { type: 'plattform', plattform: 'MacIntel' });
  });

  test('Auf anderen Rechnern steht dort deren Zeichenkette', () => {
    const w = starteWebview(skript, {}, { plattform: 'Win32' });
    const meldung = w.gesendet.find((n) => (n as { type?: string }).type === 'plattform');
    assert.deepEqual(meldung, { type: 'plattform', plattform: 'Win32' });
  });
});
