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

/** Ein Aufruf von drawImage mit Quell- und Zielrechteck. */
export interface GezeichnetesVideobild {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Steuert den nachgebauten WebCodecs-Decoder. */
export interface VideoOptionen {
  /**
   * Gibt es die WebCodecs-API ueberhaupt? Aus heisst: `window.VideoDecoder`
   * fehlt, genau wie in einem Webview ohne Chromium-Videostack.
   */
  vorhanden?: boolean;
  /** Antwort von isConfigSupported. Voreinstellung: alles wird unterstuetzt. */
  unterstuetzt?: (codec: string) => boolean;
  /** isConfigSupported wirft, statt zu antworten. */
  konfigurationWirft?: boolean;
  /** Der Konstruktor oder configure wirft. */
  einrichtenWirft?: boolean;
  /**
   * Der Decoder nimmt Happen entgegen, gibt aber nie ein Bild aus - so
   * verhaelt sich ein haengender Hardwaredecoder.
   */
  nieAusgeben?: boolean;
}

/** Was der nachgebaute Decoder zu sehen bekam. */
export interface VideoSpur {
  /** Jede an isConfigSupported uebergebene Konfiguration. */
  geprueft: Array<Record<string, unknown>>;
  /** Jede an configure uebergebene Konfiguration. */
  konfiguriert: Array<Record<string, unknown>>;
  /** Die uebergebenen Happen, in Reihenfolge. */
  haeppchen: Array<{ type: string; timestamp: number; laenge: number; ersteBytes: number[] }>;
  /** Wurde der Decoder geschlossen? */
  geschlossen: boolean;
  /** Loest den Fehlerpfad des Decoders aus. */
  loeseFehlerAus(nachricht: string): void;
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
  /** Die Buehne auf eine neue Groesse bringen und 'resize' ausloesen. */
  groesseAendern(breite: number, hoehe: number): void;
  /** Ein Fensterereignis ausloesen, ohne die Groesse anzufassen. */
  loeseFensterEreignisAus(typ: string, ereignis?: unknown): void;
  /** Was ueber drawImage auf die Zeichenflaeche kam - der Weg der Videobilder. */
  readonly videobilder: GezeichnetesVideobild[];
  /**
   * Beide Zeichenwege in *einer* Reihenfolge: 'kachel' fuer putImageData,
   * 'video' fuer drawImage. Nur so laesst sich pruefen, dass eine Kachel kein
   * aelteres Videobild ueberholt.
   */
  readonly protokoll: string[];
  /** Der nachgebaute Decoder. */
  readonly video: VideoSpur;
  /** Laesst alle offenen Zusagen durchlaufen; das Webview arbeitet asynchron. */
  ruhe(ms?: number): Promise<void>;
}

class ElementStub {
  style: Record<string, string> = {};
  textContent = '';
  hidden = false;
  width = 0;
  height = 0;
  /**
   * Die Groesse, die getBoundingClientRect meldet. Veraenderbar, weil das
   * Mitziehen der Aufloesung genau davon abhaengt: die Buehne wird groesser,
   * und daraufhin soll eine neue Aufloesung angefragt werden.
   */
  rect = { width: 1076, height: 536 };
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
    const { width, height } = this.rect;
    return { width, height, left: 0, top: 0, right: width, bottom: height };
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
export function starteWebview(skript: string, videoOptionen: VideoOptionen = {}): WebviewUmgebung {
  const gesendet: unknown[] = [];
  const gezeichnet: GezeichneteKachel[] = [];
  const nachrichtenHorcher: ((e: { data: unknown }) => void)[] = [];
  /** Alle Fensterhorcher, nach Ereignisart - damit Tests sie ausloesen koennen. */
  const fensterHorcher = new Map<string, ((e: unknown) => void)[]>();

  const videobilder: GezeichnetesVideobild[] = [];
  const protokoll: string[] = [];
  const canvas = new ElementStub();
  canvas.width = 1076;
  canvas.height = 536;
  const kontext = {
    putImageData(bild: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
      protokoll.push('kachel');
      gezeichnet.push({
        x,
        y,
        width: bild.width,
        height: bild.height,
        ersteBytes: Array.from(bild.data.slice(0, 4)),
      });
    },
    fillRect() {},
    drawImage(
      _bild: unknown,
      sx?: number,
      sy?: number,
      sw?: number,
      sh?: number,
      dx?: number,
      dy?: number,
      dw?: number,
      dh?: number,
    ) {
      // Nur die neunstellige Form interessiert hier: so zeichnet der
      // Videoweg. Die Zeigerdarstellung benutzt die kurze Form.
      if (dh === undefined) return;
      protokoll.push('video');
      videobilder.push({
        sx: sx as number,
        sy: sy as number,
        sw: sw as number,
        sh: sh as number,
        dx: dx as number,
        dy: dy as number,
        dw: dw as number,
        dh: dh as number,
      });
    },
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

  // --- Nachgebaute WebCodecs-API ------------------------------------------
  //
  // Node bringt keinen VideoDecoder mit, und ein echter waere hier auch nicht
  // hilfreich: geprueft werden soll die Logik drumherum - Verfuegbarkeitspruefung,
  // key/delta, Reihenfolge, Rueckfall -, nicht H.264 selbst.
  const videoSpur: VideoSpur = {
    geprueft: [],
    konfiguriert: [],
    haeppchen: [],
    geschlossen: false,
    loeseFehlerAus: () => {},
  };

  class EncodedVideoChunkStub {
    readonly type: string;
    readonly timestamp: number;
    readonly data: Uint8Array;
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
      if (init.type !== 'key' && init.type !== 'delta') {
        throw new Error(`EncodedVideoChunk: unbekannter Typ "${init.type}"`);
      }
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.data = init.data;
    }
  }

  class VideoDecoderStub {
    state = 'unconfigured';
    private readonly ausgabe: (bild: unknown) => void;
    private readonly fehler: (err: Error) => void;

    constructor(init: { output: (bild: unknown) => void; error: (err: Error) => void }) {
      if (videoOptionen.einrichtenWirft) throw new Error('Decoder liess sich nicht anlegen');
      this.ausgabe = init.output;
      this.fehler = init.error;
      videoSpur.loeseFehlerAus = (nachricht: string) => this.fehler(new Error(nachricht));
    }

    static isConfigSupported(konfiguration: Record<string, unknown>): Promise<{ supported: boolean }> {
      videoSpur.geprueft.push(konfiguration);
      if (videoOptionen.konfigurationWirft) return Promise.reject(new Error('Konfiguration abgelehnt'));
      const pruefe = videoOptionen.unterstuetzt ?? (() => true);
      return Promise.resolve({ supported: pruefe(String(konfiguration.codec)) });
    }

    configure(konfiguration: Record<string, unknown>): void {
      videoSpur.konfiguriert.push(konfiguration);
      this.state = 'configured';
    }

    decode(chunk: EncodedVideoChunkStub): void {
      if (this.state !== 'configured') throw new Error('decode vor configure');
      videoSpur.haeppchen.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        laenge: chunk.data.length,
        ersteBytes: Array.from(chunk.data.slice(0, 4)),
      });
      if (videoOptionen.nieAusgeben) return;
      // Ein echter Decoder antwortet asynchron. Genau darauf kommt es an:
      // die Reihenfolge zwischen Kacheln und Videobildern haengt daran.
      queueMicrotask(() =>
        this.ausgabe({
          codedWidth: 1920,
          codedHeight: 1088,
          close: () => {},
        }),
      );
    }

    close(): void {
      this.state = 'closed';
      videoSpur.geschlossen = true;
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
        const liste = fensterHorcher.get(typ) ?? [];
        liste.push(fn as (e: unknown) => void);
        fensterHorcher.set(typ, liste);
      },
      removeEventListener: () => {},
      devicePixelRatio: 1,
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 0;
      },
      ...(videoOptionen.vorhanden === false
        ? {}
        : { VideoDecoder: VideoDecoderStub, EncodedVideoChunk: EncodedVideoChunkStub }),
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

  const loeseFensterEreignisAus = (typ: string, ereignis: unknown = {}) => {
    for (const fn of fensterHorcher.get(typ) ?? []) fn(ereignis);
  };

  return {
    sende: (nachricht: unknown) => {
      for (const fn of nachrichtenHorcher) fn({ data: nachricht });
    },
    groesseAendern: (breite: number, hoehe: number) => {
      elemente.get('stage')!.rect = { width: breite, height: hoehe };
      loeseFensterEreignisAus('resize');
    },
    loeseFensterEreignisAus,
    gesendet,
    gezeichnet,
    canvas: canvas as unknown as WebviewUmgebung['canvas'],
    videobilder,
    protokoll,
    video: videoSpur,
    // Ein Durchlauf der Mikrotasks reicht fuer den Normalfall; mit einer
    // Wartezeit laesst sich auch der Zeitgeber des Rueckfalls abwarten.
    ruhe: (ms = 0) => new Promise<void>((res) => setTimeout(res, ms)),
    get diagnose() {
      return {
        sichtbar: !elemente.get('diagnose')!.hidden,
        titel: elemente.get('diagnose-titel')!.textContent,
        text: elemente.get('diagnose-werte')!.textContent,
      };
    },
  };
}
