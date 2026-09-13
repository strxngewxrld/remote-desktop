import { lookupScancode } from 'ts-rdp';

/**
 * Windows-Tastaturlayout-IDs. Der Server benutzt die ID, um Scancodes auf
 * Zeichen abzubilden - sie muss also zur physischen Tastatur des Nutzers passen.
 */
export const KEYBOARD_LAYOUTS: Record<string, number> = {
  'de-DE': 0x00000407,
  'de-CH': 0x00000807,
  'de-AT': 0x00000c07,
  'en-US': 0x00000409,
  'en-GB': 0x00000809,
  'fr-FR': 0x0000040c,
  'fr-CH': 0x0000100c,
  'es-ES': 0x0000040a,
  'it-IT': 0x00000410,
  'pt-BR': 0x00000416,
  'nl-NL': 0x00000413,
  'sv-SE': 0x0000041d,
  'da-DK': 0x00000406,
  'nb-NO': 0x00000414,
  'fi-FI': 0x0000040b,
  'pl-PL': 0x00000415,
  'cs-CZ': 0x00000405,
  'hu-HU': 0x0000040e,
  'ru-RU': 0x00000419,
  'tr-TR': 0x0000041f,
  'ja-JP': 0x00000411,
  'ko-KR': 0x00000412,
  'zh-CN': 0x00000804,
};

/** Akzeptiert sowohl "de-DE" als auch "0x407" oder "1031". */
export function resolveKeyboardLayout(value: string | undefined, fallback = 'de-DE'): number {
  const candidate = value?.trim() || fallback;
  const known = KEYBOARD_LAYOUTS[candidate];
  if (known !== undefined) return known;
  const numeric = candidate.startsWith('0x') ? parseInt(candidate, 16) : Number(candidate);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return KEYBOARD_LAYOUTS[fallback] ?? 0x00000409;
}

// =============================== Mac-Tastenkuerzel in der Sitzung ===========

/**
 * Cmd-Kuerzel auf Strg abbilden - wie die Windows App von Microsoft.
 *
 * Auf dem Draht ist die Cmd-Taste die Windows-Taste (linke/rechte Meta,
 * Scancode 0x5b/0x5c mit E0-Praefix). Wer sie einfach weiterreicht, bekommt
 * auf dem Server Win+C statt Strg+C - und damit alles Moegliche, nur kein
 * Kopieren. Die Windows App loest das, indem sie eine feste Handvoll Kuerzel
 * uebersetzt; alles andere bleibt die Windows-Taste.
 *
 * Quelle: "Use keyboard, mouse, touch, and pen in Windows App", Reiter macOS
 * (learn.microsoft.com/windows-app/input-keyboard-mouse-touch-pen). Dort steht
 * die Tabelle Command+C/X/V/A/Z/F/W, und der Satz "the Command key on a Mac
 * keyboard equals the Windows key on a Windows keyboard". Die aeltere
 * Fassung fuer den Remote Desktop Client for macOS nennt dieselben Kuerzel
 * ohne Command+W und hat dafuer den Schalter "Use Mac shortcuts for copy,
 * cut, paste and select all, undo, and find" - daher auch hier eine
 * Einstellung.
 */

/** Werte der Einstellung `rdp.macCommandKey`. */
export type CmdAbbildungEinstellung = 'auto' | 'on' | 'off';

/**
 * Die Kuerzel, die uebersetzt werden, mit ihrer Bedeutung unter Windows.
 *
 * Command+W aus der Tabelle fehlt mit Absicht: unter macOS ist Cmd+W der
 * Menue-Kurzbefehl von VS Code zum Schliessen des Editors. Electron bedient
 * ihn, bevor das Webview das Ereignis ueberhaupt sieht - und wuerde er doch
 * einmal durchkommen, waere dem Nutzer der Weg aus der Sitzung genommen.
 */
export const MAC_KUERZEL_AUF_STRG: Record<string, string> = {
  KeyC: 'Kopieren',
  KeyX: 'Ausschneiden',
  KeyV: 'Einfügen',
  KeyA: 'Alles markieren',
  KeyZ: 'Rückgängig',
  KeyF: 'Suchen',
};

/** Scancode der linken Strg-Taste (Set 1), ohne E0-Praefix. */
const SCANCODE_STRG = 0x1d;

/**
 * Greift die Abbildung?
 *
 * `auto` heisst "nur auf macOS" - und zwar auf dem Rechner des *Nutzers*.
 * Unter Remote-SSH ist die Plattform des Extension-Hosts die des
 * Sprungbretts; verlaesslich ist nur, was das Webview meldet. Ist die
 * Plattform unbekannt oder unzuverlaessig, wird nicht geraten: dann bleibt
 * die Abbildung aus, und die Windows-Taste geht wie bisher hinaus.
 */
export function cmdAbbildungAktiv(
  einstellung: CmdAbbildungEinstellung | string | undefined,
  plattform: string | undefined,
  verlaesslich: boolean,
): boolean {
  if (einstellung === 'on') return true;
  if (einstellung === 'off') return false;
  return verlaesslich && plattform === 'darwin';
}

/** Ein einzelner Tastendruck auf dem Draht. */
export interface Tastenereignis {
  scancode: number;
  down: boolean;
  extended: boolean;
}

export interface Abbildungsergebnis {
  /** Was genau so an den Server geht. */
  ereignisse: Tastenereignis[];
  /** Zusaetzlich den gewoehnlichen Weg gehen (Scancode bzw. Unicode)? */
  normalWeiter: boolean;
}

/**
 * Zustandsmaschine fuer die Cmd-Taste.
 *
 * Drei Dinge muss sie leisten:
 *
 *  1. Die Windows-Taste zurueckhalten. Erst wenn feststeht, dass die naechste
 *     Taste *kein* uebersetztes Kuerzel ist, geht sie hinaus - sonst saehe der
 *     Server Win+Strg+C.
 *  2. Das uebersetzte Kuerzel am Stueck senden (Strg runter, Taste runter,
 *     Taste hoch, Strg hoch). Das ist kein Schoenheitsfehler, sondern noetig:
 *     solange Cmd gehalten wird, liefert macOS fuer die uebrigen Tasten gar
 *     kein keyup. Wer nur "runter" sendet, laesst die Taste auf dem Server
 *     haengen.
 *  3. Aus demselben Grund beim Loslassen von Cmd alles nachholen, was
 *     zwischendurch heruntergedrueckt wurde.
 *
 * Cmd+Alt+... wird nie uebersetzt. Das ist die Bedingung dafuer, dass
 * Cmd+Alt+V (das Rueckfallfeld der Zwischenablage) nicht mit Cmd+V kollidiert.
 */
export class MacTastenabbildung {
  /** Welche Cmd-Taste gerade unten ist, oder `undefined`. */
  private cmdTaste: string | undefined;
  /** Ist die Windows-Taste fuer diesen Cmd-Druck bereits hinausgegangen? */
  private winGesendet = false;
  private strgUnten = false;
  private altUnten = false;
  /** Tasten, deren Kuerzel wir selbst gesendet haben - ihr keyup ist zu viel. */
  private readonly synthetisch = new Set<string>();
  /** Tasten, die unter gehaltenem Cmd gewoehnlich hinausgingen. */
  private readonly unterCmd = new Set<string>();

  /** Steht die Cmd-Taste gerade unten? Nur fuer Tests und Diagnose. */
  get cmdGehalten(): boolean {
    return this.cmdTaste !== undefined;
  }

  /** Nach Fokusverlust oder Verbindungsabbruch: alles vergessen. */
  zuruecksetzen(): void {
    this.cmdTaste = undefined;
    this.winGesendet = false;
    this.strgUnten = false;
    this.altUnten = false;
    this.synthetisch.clear();
    this.unterCmd.clear();
  }

  private static windowsTaste(code: string): Tastenereignis | undefined {
    const m = lookupScancode(code);
    return m ? { scancode: m.code, down: true, extended: m.extended === true } : undefined;
  }

  taste(code: string, down: boolean): Abbildungsergebnis {
    if (code === 'ControlLeft' || code === 'ControlRight') this.strgUnten = down;
    if (code === 'AltLeft' || code === 'AltRight') this.altUnten = down;

    if (code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight') {
      return down ? this.cmdRunter(code) : this.cmdHoch();
    }

    if (down && this.cmdTaste && !this.altUnten && MAC_KUERZEL_AUF_STRG[code]) {
      return this.kuerzel(code);
    }
    if (!down && this.synthetisch.has(code)) {
      // Das keyup zu dem Kuerzel, das wir schon komplett gesendet haben.
      this.synthetisch.delete(code);
      return { ereignisse: [], normalWeiter: false };
    }
    if (down && this.cmdTaste) {
      // Kein uebersetztes Kuerzel: jetzt darf die Windows-Taste hinaus.
      const ereignisse: Tastenereignis[] = [];
      if (!this.winGesendet) {
        const win = MacTastenabbildung.windowsTaste(this.cmdTaste);
        if (win) ereignisse.push(win);
        this.winGesendet = true;
      }
      this.unterCmd.add(code);
      return { ereignisse, normalWeiter: true };
    }
    if (!down) this.unterCmd.delete(code);
    return { ereignisse: [], normalWeiter: true };
  }

  private cmdRunter(code: string): Abbildungsergebnis {
    this.cmdTaste = code;
    this.winGesendet = false;
    // Nichts senden: ob daraus Win+X oder Strg+C wird, entscheidet erst die
    // naechste Taste.
    return { ereignisse: [], normalWeiter: false };
  }

  private cmdHoch(): Abbildungsergebnis {
    const ereignisse: Tastenereignis[] = [];
    // Was unter gehaltenem Cmd heruntergedrueckt wurde, bekommt jetzt sein
    // Loslassen - macOS hat es uns vorenthalten.
    for (const offen of this.unterCmd) {
      const m = lookupScancode(offen);
      if (m) ereignisse.push({ scancode: m.code, down: false, extended: m.extended === true });
    }
    if (this.winGesendet && this.cmdTaste) {
      const m = lookupScancode(this.cmdTaste);
      if (m) ereignisse.push({ scancode: m.code, down: false, extended: m.extended === true });
    }
    this.unterCmd.clear();
    this.synthetisch.clear();
    this.cmdTaste = undefined;
    this.winGesendet = false;
    return { ereignisse, normalWeiter: false };
  }

  private kuerzel(code: string): Abbildungsergebnis {
    const m = lookupScancode(code);
    if (!m) return { ereignisse: [], normalWeiter: true };
    this.synthetisch.add(code);
    const extended = m.extended === true;
    const ereignisse: Tastenereignis[] = [];
    // Haelt der Nutzer Strg ohnehin schon (Strg+Cmd+Z etwa), waere ein
    // zusaetzliches Herunter/Hoch ein Fehler - es wuerde seine Taste loesen.
    if (!this.strgUnten) ereignisse.push({ scancode: SCANCODE_STRG, down: true, extended: false });
    ereignisse.push({ scancode: m.code, down: true, extended });
    ereignisse.push({ scancode: m.code, down: false, extended });
    if (!this.strgUnten) ereignisse.push({ scancode: SCANCODE_STRG, down: false, extended: false });
    return { ereignisse, normalWeiter: false };
  }
}
