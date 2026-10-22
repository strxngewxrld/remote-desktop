import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { starteWebview } from './dom.js';

const skript = readFileSync(join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

describe('Webview - Windows-Hostkuerzel', () => {
  for (const [code, key] of [['KeyV', 'v'], ['End', 'End']]) {
    test(`Strg+Alt+${key} wird nicht zusaetzlich an den Server gesendet`, () => {
      const w = starteWebview(skript);
      w.sende({ type: 'state', state: 'connected' });
      w.loeseCanvasEreignisAus('focus', {});
      const event = {
        code, key, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
        preventDefault: () => assert.fail('Hostkuerzel muss VS Code erreichen'),
        stopPropagation: () => assert.fail('Hostkuerzel muss VS Code erreichen'),
      };
      w.loeseFensterEreignisAus('keydown', event);
      w.loeseFensterEreignisAus('keyup', event);
      assert.equal(w.gesendet.some((m: any) => m.type === 'key'), false);
    });
  }
});

describe('Webview - Maustasten', () => {
  function maus(w: ReturnType<typeof starteWebview>) {
    return w.gesendet.filter((m: any) => m.type === 'mouse' && m.kind === 'button');
  }
  const ereignis = (button: number) => ({ button, clientX: 10, clientY: 20, preventDefault: () => {} });

  test('Loslassen ohne Druecken auf der Sitzung geht nicht an den Server', () => {
    // Etwa ein Klick ins Zwischenablagefeld: mousedown dort, mouseup am Fenster.
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    w.sende({ type: 'state', state: 'connected' });
    w.loeseFensterEreignisAus('mouseup', ereignis(0));
    assert.deepEqual(maus(w), []);
  });

  test('Auf der Sitzung gedrueckt, am Fenster losgelassen: beides kommt an', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    w.sende({ type: 'state', state: 'connected' });
    w.loeseCanvasEreignisAus('mousedown', ereignis(2));
    w.loeseFensterEreignisAus('mouseup', ereignis(2));
    w.loeseFensterEreignisAus('mouseup', ereignis(2));
    assert.deepEqual(
      maus(w).map((m: any) => [m.button, m.down]),
      [['right', true], ['right', false]],
      'genau ein Loslassen je Druecken',
    );
  });
});

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

describe('Webview - Auflösung zieht mit', () => {
  /** Kurz warten, damit der Entprell-Zeitgeber ablaufen kann. */
  const warte = (ms: number) => new Promise((weiter) => setTimeout(weiter, ms));

  /** Alle Anfragen nach einer neuen Auflösung, die das Skript gestellt hat. */
  function anfragen(umgebung: ReturnType<typeof starteWebview>) {
    return umgebung.gesendet.filter((n: any) => n?.type === 'resizeRequest') as {
      width: number;
      height: number;
      devicePixelRatio: number;
    }[];
  }

  /** Eine verbundene Webview mit eingeschaltetem Mitziehen und kurzer Ruhezeit. */
  function verbunden(verzug = 30) {
    const umgebung = starteWebview(skript);
    umgebung.sende({
      type: 'init',
      width: 1076,
      height: 536,
      scaling: 'fit',
      smooth: false,
      dynamicResolution: true,
      resizeDelay: verzug,
    });
    return umgebung;
  }

  test('Eine Größenänderung wird nach der Ruhezeit gemeldet', async () => {
    const umgebung = verbunden();
    assert.equal(anfragen(umgebung).length, 0);

    umgebung.groesseAendern(1400, 700);
    // Unmittelbar danach ist noch nichts hinausgegangen - das ist der Sinn.
    assert.equal(anfragen(umgebung).length, 0);

    await warte(60);
    const gestellt = anfragen(umgebung);
    assert.equal(gestellt.length, 1);
    assert.equal(gestellt[0].width, 1400);
    assert.equal(gestellt[0].height, 700);
  });

  test('Vieles Ziehen hintereinander ergibt genau eine Anfrage - mit der letzten Größe', async () => {
    // Beim Ziehen an der Fensterkante feuert 'resize' dutzende Male. Jede
    // davon zu melden hiesse, dem Server dutzende Auflösungswechsel zuzumuten.
    const umgebung = verbunden();
    for (let breite = 1100; breite <= 1500; breite += 20) {
      umgebung.groesseAendern(breite, 700);
      await warte(2);
    }

    await warte(60);
    const gestellt = anfragen(umgebung);
    assert.equal(gestellt.length, 1, 'genau eine Anfrage nach dem ganzen Ziehen');
    assert.equal(gestellt[0].width, 1500);
  });

  test('Das Bild wird sofort mitskaliert, nicht erst nach der Ruhezeit', async () => {
    // Während des Ziehens soll das (unscharfe) Bild mitgehen; die scharfe
    // Auflösung kommt danach nach. Ohne das wirkte das Fenster eingefroren.
    //
    // Geprüft wird am Verkleinern: layout() deckelt den Maßstab bei 1, ein
    // größeres Panel ändert die Leinwandgröße daher gar nicht.
    const umgebung = verbunden();
    umgebung.groesseAendern(538, 268);
    assert.equal(umgebung.canvas.style.width, '538px', 'sofort neu skaliert');
    assert.equal(anfragen(umgebung).length, 0, 'aber noch nichts angefragt');
  });

  test('Dieselbe Größe wird nicht zweimal angefragt', async () => {
    const umgebung = verbunden();
    umgebung.groesseAendern(1400, 700);
    await warte(60);
    assert.equal(anfragen(umgebung).length, 1);

    // Ein 'resize' ohne echte Größenänderung - etwa beim Verschieben des Fensters.
    umgebung.loeseFensterEreignisAus('resize');
    await warte(60);
    assert.equal(anfragen(umgebung).length, 1);
  });

  test('Die bestätigte Größe des Servers löst keine neue Anfrage aus', async () => {
    // Sonst entstünde eine Schleife: anfragen, bestätigt bekommen, wieder
    // anfragen. Die Bestätigung kommt als 'init' mit der neuen Größe.
    const umgebung = verbunden();
    umgebung.groesseAendern(1400, 700);
    await warte(60);
    assert.equal(anfragen(umgebung).length, 1);

    umgebung.sende({ type: 'init', width: 1400, height: 700, scaling: 'fit', smooth: false });
    umgebung.loeseFensterEreignisAus('resize');
    await warte(60);
    assert.equal(anfragen(umgebung).length, 1);
  });

  test('Ist das Mitziehen aus, wird nie eine Größe gemeldet', async () => {
    // Das ist der Zustand bei fest eingetragener Auflösung und bei
    // abgeschalteter Einstellung: exakt das Verhalten von vorher.
    const umgebung = starteWebview(skript);
    umgebung.sende({
      type: 'init',
      width: 1076,
      height: 536,
      scaling: 'fit',
      smooth: false,
      dynamicResolution: false,
      resizeDelay: 30,
    });
    umgebung.groesseAendern(1400, 700);
    await warte(60);
    assert.equal(anfragen(umgebung).length, 0);
    // Skaliert wird aber weiterhin.
    assert.equal(umgebung.canvas.style.width.length > 0, true);
  });

  test('Ohne jede Angabe im init bleibt das Mitziehen aus', async () => {
    // Ein alter Host, der die neuen Felder nicht schickt, darf die Webview
    // nicht dazu bringen, unaufgefordert Anfragen zu stellen.
    const umgebung = starteWebview(skript);
    umgebung.sende({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
    umgebung.groesseAendern(1400, 700);
    await warte(60);
    assert.equal(anfragen(umgebung).length, 0);
  });

  test('Die Ruhezeit des Hosts wird übernommen', async () => {
    const umgebung = verbunden(150);
    umgebung.groesseAendern(1400, 700);
    await warte(60);
    assert.equal(anfragen(umgebung).length, 0, 'nach 60 ms ist die Ruhezeit von 150 ms noch nicht um');
    await warte(150);
    assert.equal(anfragen(umgebung).length, 1);
  });

  test('Die Pixeldichte des Fensters geht mit', async () => {
    // Der Host braucht sie, um bei eingeschaltetem rdp.highDpi zu rechnen.
    const umgebung = verbunden();
    umgebung.groesseAendern(1400, 700);
    await warte(60);
    assert.equal(anfragen(umgebung)[0].devicePixelRatio, 1);
  });
});

describe('Webview - Ausschnitt eines weiteren Monitors', () => {
  test('Kacheln in Desktopkoordinaten landen relativ zum Ursprung', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 800, height: 600, originX: 1024, originY: 0, scaling: 'fit', smooth: false });
    w.sende(bitmapNachricht([{ x: 1100, y: 10, w: 4, h: 4 }], 'uint8'));
    assert.deepEqual(
      w.gezeichnet.map((k) => [k.x, k.y]),
      [[76, 10]],
    );
  });

  test('Mauskoordinaten gehen in Desktopkoordinaten zurueck', () => {
    const w = starteWebview(skript);
    // Zeichenflaeche und Buehne gleich gross: ein CSS-Pixel ist ein Desktop-Pixel.
    w.sende({ type: 'init', width: 1076, height: 536, originX: 1024, originY: 0, scaling: 'fit', smooth: false });
    w.sende({ type: 'state', state: 'connected' });
    w.loeseCanvasEreignisAus('mousemove', { clientX: 10, clientY: 20 });
    const maus = w.gesendet.filter((m) => (m as { type?: string }).type === 'mouse') as { x: number; y: number }[];
    assert.deepEqual([maus.at(-1)!.x, maus.at(-1)!.y], [1034, 20]);
  });

  test('Ohne Ursprung bleibt alles wie bei einem Monitor', () => {
    const w = starteWebview(skript);
    w.sende({ type: 'init', width: 800, height: 600, scaling: 'fit', smooth: false });
    w.sende(bitmapNachricht([{ x: 10, y: 10, w: 4, h: 4 }], 'uint8'));
    assert.deepEqual(w.gezeichnet.map((k) => [k.x, k.y]), [[10, 10]]);
  });
});
