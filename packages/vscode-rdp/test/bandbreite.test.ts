// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import { einstellungen, zuruecksetzen } from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import {
  BANDBREITEN_PROFILE,
  PERF_DISABLE_CURSORSETTINGS,
  PERF_DISABLE_CURSOR_SHADOW,
  PERF_DISABLE_FULLWINDOWDRAG,
  PERF_DISABLE_MENUANIMATIONS,
  PERF_DISABLE_THEMING,
  PERF_DISABLE_WALLPAPER,
  PERF_ENABLE_DESKTOP_COMPOSITION,
  PERF_ENABLE_FONT_SMOOTHING,
  PROFIL_NAMEN,
  berechnePerformanceFlags,
  istProfilName,
  profilAusVerbindungsTyp,
} from '../src/bandbreite.js';
import { alleVerbindungen, loeseVerbindungAuf } from '../src/connections.js';

/**
 * Die Schalter, wie sie das Manifest voreinstellt. Genau so fragte der alte
 * Code sie ab - der Vergleich haelt fest, dass sich ohne Profil nichts aendert.
 */
const STANDARD_SCHALTER: Record<string, boolean> = {
  'performance.disableWallpaper': true,
  'performance.disableFullWindowDrag': true,
  'performance.disableMenuAnimations': true,
  'performance.disableThemes': false,
  'performance.enableFontSmoothing': true,
};

function schalter(werte: Record<string, boolean> = STANDARD_SCHALTER) {
  return <T>(schluessel: string, standard: T): T =>
    (schluessel in werte ? (werte[schluessel] as unknown as T) : standard);
}

beforeEach(() => zuruecksetzen());

describe('Performance-Flags ohne Profil', () => {
  test('Die Voreinstellung ergibt genau die bisherigen Flags', () => {
    // 0x87 ist das, was der Code vor den Bandbreitenprofilen geschickt hat.
    assert.equal(berechnePerformanceFlags(undefined, schalter()), 0x87);
  });

  test('Jeder Schalter setzt sein eigenes Bit', () => {
    const nurEiner = (name: string, bit: number) => {
      const aus = Object.fromEntries(Object.keys(STANDARD_SCHALTER).map((k) => [k, false]));
      assert.equal(berechnePerformanceFlags(undefined, schalter({ ...aus, [name]: true })), bit);
    };
    nurEiner('performance.disableWallpaper', PERF_DISABLE_WALLPAPER);
    nurEiner('performance.disableFullWindowDrag', PERF_DISABLE_FULLWINDOWDRAG);
    nurEiner('performance.disableMenuAnimations', PERF_DISABLE_MENUANIMATIONS);
    nurEiner('performance.disableThemes', PERF_DISABLE_THEMING);
    nurEiner('performance.enableFontSmoothing', PERF_ENABLE_FONT_SMOOTHING);
  });

  test('Alles abgeschaltet ergibt null Flags', () => {
    const aus = Object.fromEntries(Object.keys(STANDARD_SCHALTER).map((k) => [k, false]));
    assert.equal(berechnePerformanceFlags(undefined, schalter(aus)), 0);
  });
});

describe('Die Profile', () => {
  test('LAN laesst alles an und schaltet die Desktopkomposition frei', () => {
    assert.equal(
      BANDBREITEN_PROFILE.lan.flags,
      PERF_ENABLE_FONT_SMOOTHING | PERF_ENABLE_DESKTOP_COMPOSITION,
    );
  });

  test('Breitband nimmt Hintergrundbild, Ziehen und Animationen weg, laesst Designs', () => {
    const flags = BANDBREITEN_PROFILE.broadband.flags;
    assert.equal(flags & PERF_DISABLE_WALLPAPER, PERF_DISABLE_WALLPAPER);
    assert.equal(flags & PERF_DISABLE_FULLWINDOWDRAG, PERF_DISABLE_FULLWINDOWDRAG);
    assert.equal(flags & PERF_DISABLE_MENUANIMATIONS, PERF_DISABLE_MENUANIMATIONS);
    assert.equal(flags & PERF_ENABLE_FONT_SMOOTHING, PERF_ENABLE_FONT_SMOOTHING);
    assert.equal(flags & PERF_DISABLE_THEMING, 0, 'Designs bleiben an');
  });

  test('Mobil schaltet jeden Effekt ab', () => {
    const flags = BANDBREITEN_PROFILE.mobile.flags;
    for (const bit of [
      PERF_DISABLE_WALLPAPER,
      PERF_DISABLE_FULLWINDOWDRAG,
      PERF_DISABLE_MENUANIMATIONS,
      PERF_DISABLE_THEMING,
      PERF_DISABLE_CURSOR_SHADOW,
      PERF_DISABLE_CURSORSETTINGS,
    ]) {
      assert.equal(flags & bit, bit);
    }
    assert.equal(flags & PERF_ENABLE_FONT_SMOOTHING, 0, 'keine Schriftglaettung');
    assert.equal(flags & PERF_ENABLE_DESKTOP_COMPOSITION, 0, 'keine Desktopkomposition');
  });

  test('Jedes Profil hat Titel, Beschreibung und Flags', () => {
    for (const name of PROFIL_NAMEN) {
      const profil = BANDBREITEN_PROFILE[name];
      assert.ok(profil.titel.length > 0);
      assert.ok(profil.beschreibung.length > 0);
      assert.equal(typeof profil.flags, 'number');
    }
  });

  test('Ein Profil schlaegt die einzelnen Schalter', () => {
    assert.equal(berechnePerformanceFlags('mobile', schalter()), BANDBREITEN_PROFILE.mobile.flags);
    assert.equal(berechnePerformanceFlags('lan', schalter()), BANDBREITEN_PROFILE.lan.flags);
  });

  test('Ein unbekannter Profilname faellt auf die Schalter zurueck', () => {
    assert.equal(berechnePerformanceFlags('gibtsnicht' as never, schalter()), 0x87);
    assert.equal(istProfilName('gibtsnicht'), false);
    assert.equal(istProfilName('lan'), true);
    assert.equal(istProfilName(6), false);
  });
});

describe('Profil und Verbindungsverwaltung', () => {
  test('Das Profil erbt sich wie jede andere Einstellung', () => {
    einstellungen.set('rdp.connections', [
      {
        type: 'folder',
        name: 'Aussenstelle',
        settings: { bandwidthProfile: 'mobile' },
        children: [
          { name: 'Erbt', host: '10.0.0.1' },
          { name: 'Eigen', host: '10.0.0.2', bandwidthProfile: 'lan' },
        ],
      },
    ]);
    const profil = (name: string) =>
      loeseVerbindungAuf(alleVerbindungen().find((e) => e.verbindung.name === name)!).bandwidthProfile;

    assert.equal(profil('Erbt'), 'mobile');
    assert.equal(profil('Eigen'), 'lan');

    // Und daraus werden dann die Flags der Sitzung.
    assert.equal(berechnePerformanceFlags(profil('Erbt'), schalter()), BANDBREITEN_PROFILE.mobile.flags);
  });
});

describe('Verbindungsart aus einer .rdp-Datei', () => {
  test('Langsame Leitungen werden mobil, schnelle LAN', () => {
    assert.equal(profilAusVerbindungsTyp(1), 'mobile');
    assert.equal(profilAusVerbindungsTyp(3), 'mobile');
    assert.equal(profilAusVerbindungsTyp(4), 'broadband');
    assert.equal(profilAusVerbindungsTyp(5), 'broadband');
    assert.equal(profilAusVerbindungsTyp(6), 'lan');
    assert.equal(profilAusVerbindungsTyp(7), 'lan');
  });

  test('Eine Verbindungsart, die wir nicht kennen, wird nicht geraten', () => {
    assert.equal(profilAusVerbindungsTyp(0), undefined);
    assert.equal(profilAusVerbindungsTyp(99), undefined);
  });
});
