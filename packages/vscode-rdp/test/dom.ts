/**
 * Gerade genug Browser, damit media/main.js laufen kann.
 *
 * Der Sinn: Das Skript im Webview ist der einzige Teil der Extension, der im
 * Renderer-Prozess von VS Code laeuft. Ein Fehler dort beendet das Fenster,
 * ohne dass im Extension-Host etwas auffaellt - deshalb muss er pruefbar sein,
 * ohne ein ganzes VS Code zu starten.
 */
export interface GezeichneteKachel {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Die ersten vier Bytes, damit sich Farben pruefen lassen. */
  ersteBytes: number[];
}

export interface WebviewUmgebung {
  /** Eine Nachricht an das Skript schicken, wie VS Code es tut. */
  sende(nachricht: unknown): void;
  /** Was das Skript an den Extension-Host zurueckgeschickt hat. */
  readonly gesendet: unknown[];
  /** Was auf die Zeichenflaeche gemalt wurde. */
  readonly gezeichnet: GezeichneteKachel[];
  readonly canvas: { width: number; height: number; style: Record<string, string> };
  /** Das Diagnose-Overlay, so wie es im Webview aussaehe. */
  readonly diagnose: { sichtbar: boolean; titel: string; text: string };
}

class ElementStub {
  style: Record<string, string> = {};
  textContent = '';
  hidden = false;
  width = 0;
  height = 0;
  readonly classList = {
    mengen: new Set<string>(),
    add: (c: string) => this.classList.mengen.add(c),
    remove: (c: string) => this.classList.mengen.delete(c),
    contains: (c: string) => this.classList.mengen.has(c),
    toggle: (c: string, an?: boolean) =>
      an === undefined || an ? this.classList.mengen.add(c) : this.classList.mengen.delete(c),
  };
  private readonly horcher = new Map<string, ((e: unknown) => void)[]>();

  addEventListener(typ: string, fn: (e: unknown) => void): void {
    const liste = this.horcher.get(typ) ?? [];
    liste.push(fn);
    this.horcher.set(typ, liste);
  }
  removeEventListener(): void {}
  getBoundingClientRect() {
    return { width: 1076, height: 536, left: 0, top: 0, right: 1076, bottom: 536 };
  }
  focus(): void {}
  setAttribute(): void {}
  getContext(): unknown {
    return undefined;
  }
  toDataURL(): string {
    return 'data:image/png;base64,';
  }
}

/**
 * Baut die Umgebung und fuehrt media/main.js darin aus.
 *
 * Das Skript wird bewusst als Quelltext geladen und nicht nachgebaut: ein
 * Nachbau wuerde den Fehler, den man sucht, nicht enthalten.
 */
export function starteWebview(skript: string): WebviewUmgebung {
  const gesendet: unknown[] = [];
  const gezeichnet: GezeichneteKachel[] = [];
  const nachrichtenHorcher: ((e: { data: unknown }) => void)[] = [];

  const canvas = new ElementStub();
  canvas.width = 1076;
  canvas.height = 536;
  const kontext = {
    putImageData(bild: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
      gezeichnet.push({
        x,
        y,
        width: bild.width,
        height: bild.height,
        ersteBytes: Array.from(bild.data.slice(0, 4)),
      });
    },
    fillRect() {},
    drawImage() {},
    clearRect() {},
    setTransform() {},
    scale() {},
  };
  (canvas as unknown as { getContext: () => unknown }).getContext = () => kontext;

  const elemente = new Map<string, ElementStub>([
    ['screen', canvas],
    ['stage', new ElementStub()],
    ['overlay', new ElementStub()],
    ['overlay-title', new ElementStub()],
    ['overlay-message', new ElementStub()],
    ['overlay-action', new ElementStub()],
    ['spinner', new ElementStub()],
    ['hint', new ElementStub()],
    ['diagnose', new ElementStub()],
    ['diagnose-titel', new ElementStub()],
    ['diagnose-werte', new ElementStub()],
  ]);

  // Wie im HTML: das Overlay startet ausgeblendet.
  elemente.get('diagnose')!.hidden = true;

  class ImageDataStub {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {
      if (!width || !height) throw new Error('ImageData braucht Breite und Hoehe');
      if (data.length !== width * height * 4) {
        throw new Error(`ImageData: ${data.length} Byte passen nicht zu ${width}x${height}`);
      }
    }
  }

  const umgebung = {
    acquireVsCodeApi: () => ({
      postMessage: (m: unknown) => gesendet.push(m),
      getState: () => undefined,
      setState: () => {},
    }),
    document: {
      getElementById: (id: string) => elemente.get(id) ?? new ElementStub(),
      createElement: () => new ElementStub(),
      addEventListener: () => {},
      removeEventListener: () => {},
      body: new ElementStub(),
      hasFocus: () => true,
      activeElement: null,
    },
    window: {
      addEventListener: (typ: string, fn: (e: { data: unknown }) => void) => {
        if (typ === 'message') nachrichtenHorcher.push(fn);
      },
      removeEventListener: () => {},
      devicePixelRatio: 1,
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 0;
      },
    },
    ImageData: ImageDataStub,
    atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary'),
    setTimeout,
    clearTimeout,
    console,
  };
  (umgebung.window as unknown as Record<string, unknown>).addEventListener = umgebung.window.addEventListener;

  // Das Skript erwartet globale Namen, also in einer Funktion mit genau diesen
  // Parametern ausfuehren - so bleibt der Quelltext unveraendert.
  const namen = Object.keys(umgebung);
  const werte = namen.map((n) => (umgebung as Record<string, unknown>)[n]);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...namen, skript)(...werte);

  return {
    sende: (nachricht: unknown) => {
      for (const fn of nachrichtenHorcher) fn({ data: nachricht });
    },
    gesendet,
    gezeichnet,
    canvas: canvas as unknown as WebviewUmgebung['canvas'],
    get diagnose() {
      return {
        sichtbar: !elemente.get('diagnose')!.hidden,
        titel: elemente.get('diagnose-titel')!.textContent,
        text: elemente.get('diagnose-werte')!.textContent,
      };
    },
  };
}
