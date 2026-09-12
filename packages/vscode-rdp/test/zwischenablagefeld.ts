/**
 * Gerade genug Browser, damit media/clipboard.js laufen kann.
 *
 * Bewusst eine eigene Attrappe neben test/dom.ts: dort geht es um die
 * Zeichenflaeche, hier um ein Formular. Zwei kleine, verstaendliche
 * Nachbauten sind leichter zu lesen als ein grosser, der beides kann.
 *
 * Das Skript wird als Quelltext geladen und unveraendert ausgefuehrt - ein
 * Nachbau wuerde den Fehler, den man sucht, nicht enthalten.
 */

export interface Tastenereignis {
  /** Hat das Skript `stopPropagation()` gerufen? */
  gestoppt: boolean;
  /** Hat das Skript `preventDefault()` gerufen? */
  verhindert: boolean;
}

export interface FeldUmgebung {
  /** Eine Nachricht vom Host schicken. */
  sende(nachricht: unknown): void;
  /** Einen Knopf anklicken. */
  klick(id: string): void;
  /** Eine Taste im Textfeld druecken. */
  taste(key: string, zusatz?: { ctrlKey?: boolean; metaKey?: boolean }): Tastenereignis;
  knopf(id: string): { disabled: boolean; title: string };
  readonly feld: { value: string; readOnly: boolean; markiert: boolean };
  readonly sichtbar: boolean;
  readonly status: string;
  /** Was das Skript an den Extension-Host geschickt hat. */
  readonly gesendet: unknown[];
  /** Was ueber `navigator.clipboard.writeText` in die Zwischenablage ging. */
  readonly browserZwischenablage: string[];
  /** Die Bruecke, die das Skript fuer main.js hinterlassen hat. */
  fensterApi(): { postMessage(n: unknown): void } | undefined;
}

class Element {
  hidden = false;
  disabled = false;
  readOnly = false;
  title = '';
  textContent = '';
  value = '';
  markiert = false;
  private readonly horcher = new Map<string, ((e: unknown) => void)[]>();

  addEventListener(typ: string, fn: (e: unknown) => void): void {
    const liste = this.horcher.get(typ) ?? [];
    liste.push(fn);
    this.horcher.set(typ, liste);
  }

  removeEventListener(): void {}
  focus(): void {}
  select(): void {
    this.markiert = true;
  }

  ausloesen(typ: string, ereignis: unknown): void {
    for (const fn of this.horcher.get(typ) ?? []) fn(ereignis);
  }

  /** Wie im Browser: ein Klick auf einen gesperrten Knopf tut nichts. */
  click(): void {
    if (this.disabled) return;
    this.ausloesen('click', { type: 'click' });
  }
}

export interface FeldOptionen {
  /** `navigator.clipboard.writeText` lehnt ab - die klassische Geste-Falle. */
  kopierenSchlaegtFehl?: boolean;
  /** Es gibt gar keine Clipboard-API (aeltere oder gesperrte Umgebungen). */
  ohneClipboardApi?: boolean;
}

export function starteZwischenablagefeld(skript: string, optionen: FeldOptionen = {}): FeldUmgebung {
  const gesendet: unknown[] = [];
  const browserZwischenablage: string[] = [];
  const nachrichtenHorcher: ((e: { data: unknown }) => void)[] = [];

  const ids = [
    'clipboard-panel',
    'clipboard-text',
    'clipboard-send',
    'clipboard-copy',
    'clipboard-close',
    'clipboard-status',
  ];
  const elemente = new Map<string, Element>(ids.map((id) => [id, new Element()]));
  // Wie im HTML: das Feld startet ausgeblendet.
  elemente.get('clipboard-panel')!.hidden = true;

  const api = {
    postMessage: (m: unknown) => gesendet.push(m),
    getState: () => undefined,
    setState: () => {},
  };

  const fenster: Record<string, unknown> = {
    addEventListener: (typ: string, fn: (e: { data: unknown }) => void) => {
      if (typ === 'message') nachrichtenHorcher.push(fn);
    },
    removeEventListener: () => {},
  };

  const navigator = optionen.ohneClipboardApi
    ? {}
    : {
        clipboard: {
          writeText: (text: string) => {
            if (optionen.kopierenSchlaegtFehl) {
              return Promise.reject(new DOMException_('NotAllowedError'));
            }
            browserZwischenablage.push(text);
            return Promise.resolve();
          },
        },
      };

  const umgebung = {
    acquireVsCodeApi: () => api,
    window: fenster,
    navigator,
    document: {
      getElementById: (id: string) => elemente.get(id) ?? null,
    },
    setTimeout,
    clearTimeout,
    console,
  };

  const namen = Object.keys(umgebung);
  const werte = namen.map((n) => (umgebung as Record<string, unknown>)[n]);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...namen, skript)(...werte);

  const feld = elemente.get('clipboard-text')!;

  return {
    sende: (nachricht) => {
      for (const fn of nachrichtenHorcher) fn({ data: nachricht });
    },
    klick: (id) => elemente.get(id)!.click(),
    taste: (key, zusatz = {}) => {
      const zustand: Tastenereignis = { gestoppt: false, verhindert: false };
      feld.ausloesen('keydown', {
        key,
        ctrlKey: zusatz.ctrlKey ?? false,
        metaKey: zusatz.metaKey ?? false,
        stopPropagation: () => {
          zustand.gestoppt = true;
        },
        preventDefault: () => {
          zustand.verhindert = true;
        },
      });
      return zustand;
    },
    knopf: (id) => elemente.get(id)!,
    feld,
    get sichtbar() {
      return !elemente.get('clipboard-panel')!.hidden;
    },
    get status() {
      return elemente.get('clipboard-status')!.textContent;
    },
    gesendet,
    browserZwischenablage,
    fensterApi: () => {
      const fn = fenster['acquireVsCodeApi'] as (() => { postMessage(n: unknown): void }) | undefined;
      return fn?.();
    },
  };
}

/** Node kennt DOMException nicht in jeder Fassung - ein Error tut es auch. */
class DOMException_ extends Error {}
