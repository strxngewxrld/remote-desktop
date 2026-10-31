/**
 * Webview: wann die Panelgroesse an den Host geht - ResizeObserver,
 * devicePixelRatio, Abweichung nach dem 'init' und ausdrueckliche Bitte.
 */
import { starteWebview } from './dom.js';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');
const warte = (ms: number) => new Promise((weiter) => setTimeout(weiter, ms));

function anfragen(u: ReturnType<typeof starteWebview>) {
  return u.gesendet.filter((n: any) => n?.type === 'resizeRequest') as {
    width: number;
    height: number;
    devicePixelRatio: number;
    erzwingen?: boolean;
  }[];
}

function verbunden(dynamisch = true) {
  const u = starteWebview(skript);
  u.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false, dynamicResolution: dynamisch, resizeDelay: 20 });
  return u;
}

describe('Webview - Groessenmeldung', () => {
  test('Ein ResizeObserver auf der Buehne meldet auch ohne Fensterereignis', async () => {
    const u = verbunden();
    u.groesseNurBeobachter(1300, 700);
    await warte(60);
    assert.equal(anfragen(u).length, 1);
    assert.equal(anfragen(u)[0].width, 1300);
  });

  test('Ein Wechsel der Pixeldichte meldet erneut, auch bei gleicher Groesse', async () => {
    const u = verbunden();
    u.dprAendern(2);
    await warte(60);
    const a = anfragen(u);
    assert.equal(a.length, 1);
    assert.equal(a[0].devicePixelRatio, 2);
    assert.equal(a[0].width, 1076);
    // Die Abfrage ist neu aufgebaut: ein zweiter Wechsel wird wieder bemerkt.
    u.dprAendern(1);
    await warte(60);
    assert.equal(anfragen(u).length, 2);
  });

  test('Aenderte sich das Fenster vor dem init, geht die Abweichung danach hinaus', async () => {
    // Vor dem init ist das Mitziehen aus; die Webview darf die Groesse trotzdem
    // nicht als gemeldet verbuchen, nur weil sie zufaellig zur Buehne passt.
    const u = starteWebview(skript);
    u.groesseAendern(1400, 800); // nach 'ready' (1076x536)
    u.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false, dynamicResolution: true, resizeDelay: 20 });
    await warte(60);
    const a = anfragen(u);
    assert.equal(a.length, 1);
    assert.equal(a[0].width, 1400);
  });

  test('Ohne Abweichung schickt das init keine Meldung', async () => {
    const u = verbunden();
    await warte(60);
    assert.equal(anfragen(u).length, 0);
  });

  test('groesseMelden antwortet sofort und erzwingen, auch bei ausgeschaltetem Mitziehen', () => {
    const u = verbunden(false);
    u.groesseAendern(1500, 900);
    assert.equal(anfragen(u).length, 0);
    u.sende({ type: 'groesseMelden' });
    const a = anfragen(u);
    assert.equal(a.length, 1);
    assert.equal(a[0].erzwingen, true);
    assert.equal(a[0].width, 1500);
    // Eine zweite Bitte mit unveraenderter Groesse wird trotzdem beantwortet.
    u.sende({ type: 'groesseMelden' });
    assert.equal(anfragen(u).length, 2);
  });
});
