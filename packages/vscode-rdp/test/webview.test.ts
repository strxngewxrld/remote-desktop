import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { starteWebview } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

/** Eine Bitmap-Nachricht, wie session.ts sie zusammenstellt. */
function bitmapNachricht(
  kacheln: { x: number; y: number; w: number; h: number }[],
  form: 'uint8' | 'base64' | 'objekt',
): unknown {
  const rects: { x: number; y: number; w: number; h: number; offset: number; length: number }[] = [];
  const teile: Buffer[] = [];
  let offset = 0;
  for (const k of kacheln) {
    const laenge = k.w * k.h * 4;
    const puffer = Buffer.alloc(laenge);
    // Erkennbares Muster: erstes Pixel traegt die Lage, damit sich Kachel und
    // Zielort im Test einander zuordnen lassen.
    puffer[0] = k.x & 0xff;
    puffer[1] = k.y & 0xff;
    puffer[2] = k.w & 0xff;
    puffer[3] = 255;
    rects.push({ x: k.x, y: k.y, w: k.w, h: k.h, offset, length: laenge });
    teile.push(puffer);
    offset += laenge;
  }
  const daten = Buffer.concat(teile, offset);
  const alsForm =
    form === 'base64'
      ? daten.toString('base64')
      : form === 'uint8'
        ? new Uint8Array(daten)
        : // So sieht ein Uint8Array aus, wenn VS Code es als einfaches Objekt
          // durchreicht: nur numerische Schluessel, kein Prototyp.
          Object.fromEntries(Array.from(daten).map((b, i) => [String(i), b]));
  return { type: 'bitmap', rects, data: alsForm };
}

describe('Webview - Kacheln zeichnen', () => {
  for (const form of ['uint8', 'base64', 'objekt'] as const) {
    test(`Daten als ${form} werden gezeichnet`, () => {
      const w = starteWebview(skript);
      w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
      w.sende(bitmapNachricht([{ x: 10, y: 20, w: 8, h: 4 }], form));

      assert.equal(w.gezeichnet.length, 1, 'genau eine Kachel gezeichnet');
      const kachel = w.gezeichnet[0];
      assert.deepEqual([kachel.x, kachel.y, kachel.width, kachel.height], [10, 20, 8, 4]);
      assert.deepEqual(kachel.ersteBytes, [10, 20, 8, 255], 'die Nutzdaten kommen unveraendert an');
    });
  }

  test('Mehrere Kacheln einer Nachricht landen an ihren eigenen Stellen', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    w.sende(
      bitmapNachricht(
        [
          { x: 0, y: 0, w: 4, h: 4 },
          { x: 64, y: 32, w: 16, h: 8 },
          { x: 128, y: 96, w: 2, h: 2 },
        ],
        'uint8',
      ),
    );
    assert.equal(w.gezeichnet.length, 3);
    assert.deepEqual(
      w.gezeichnet.map((k) => [k.x, k.y, k.width, k.height]),
      [
        [0, 0, 4, 4],
        [64, 32, 16, 8],
        [128, 96, 2, 2],
      ],
    );
  });

  test('Eine Kachel mit falscher Laenge wird gemeldet, die uebrigen trotzdem gezeichnet', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    const nachricht = bitmapNachricht(
      [
        { x: 0, y: 0, w: 4, h: 4 },
        { x: 8, y: 0, w: 4, h: 4 },
      ],
      'uint8',
    ) as { rects: { length: number }[] };
    // Erste Kachel absichtlich verkuerzen.
    nachricht.rects[0].length -= 4;

    w.sende(nachricht);
    assert.equal(w.gezeichnet.length, 1, 'die heile Kachel wird gezeichnet');
    assert.ok(
      w.gesendet.some((m) => (m as { type?: string }).type === 'drawError'),
      'der Fehler wird nach oben gemeldet',
    );
  });
});

describe('Webview - Last', () => {
  /**
   * Regressionstest fuer einen Absturz des ganzen Fensters.
   *
   * Reicht VS Code die Binaerdaten als einfaches Objekt durch, lief die
   * Ruecksetzung in toBytes ueber Object.keys - bei einer 2-MB-Nachricht sind
   * das ueber zwei Millionen Zeichenketten samt Regex je Schluessel. Der
   * Renderer-Prozess hat das nicht ueberlebt, und VS Code schloss das Fenster.
   * Auffaellig wurde es erst, als mit dem Progressive-Codec Vollbildnachrichten
   * entstanden; vorher waren die Nachrichten klein genug.
   */
  test('eine Vollbildnachricht als einfaches Objekt bringt den Renderer nicht um', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });

    // Die Attrappe vor der Messung bauen: sie selbst zu erzeugen kostet
    // ebenfalls Zeit, und gemessen werden soll die Webview, nicht der Test.
    const nachricht = bitmapNachricht([{ x: 0, y: 0, w: 1076, h: 536 }], 'objekt');
    const start = Date.now();
    w.sende(nachricht);
    const dauer = Date.now() - start;

    assert.ok(
      w.gesendet.some((m) => (m as { type?: string }).type === 'binaryUnsupported'),
      'die Webview muss den Host auf Base64 umstellen lassen',
    );
    // Die Grenze ist bewusst eng: alles darueber waere fuer den Renderer eine
    // spuerbare Blockade, und genau daran ist das Fenster abgestuerzt.
    assert.ok(dauer < 100, `hat ${dauer} ms gebraucht; der Renderer darf dabei nicht stehen`);
  });

  test('eine Vollbildnachricht als Base64 wird zuegig gezeichnet', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    const nachricht = bitmapNachricht([{ x: 0, y: 0, w: 1076, h: 536 }], 'base64');
    const start = Date.now();
    w.sende(nachricht);
    assert.equal(w.gezeichnet.length, 1);
    assert.ok(Date.now() - start < 2000, 'Base64-Weg darf den Renderer nicht blockieren');
  });

  test('viele kleine Kacheln in einer Nachricht', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    // So viele Kacheln, wie ein Vollbildaufbau ueber die Graphics Pipeline
    // tatsaechlich erzeugt (gemessen: bis 153 Stueck in einer Nachricht).
    const kacheln = Array.from({ length: 153 }, (_, i) => ({
      x: (i % 17) * 64,
      y: Math.floor(i / 17) * 64,
      w: 64,
      h: 64,
    }));
    w.sende(bitmapNachricht(kacheln, 'uint8'));
    assert.equal(w.gezeichnet.length, 153);
  });
});
