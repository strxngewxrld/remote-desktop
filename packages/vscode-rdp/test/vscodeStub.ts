/**
 * Attrappe der VS-Code-API fuer den Extension-Host.
 *
 * Der Sinn ist derselbe wie bei test/dom.ts, nur eine Etage tiefer: src/ laeuft
 * im Extension-Host und kann dort nur gegen `vscode` uebersetzt und ausgefuehrt
 * werden. Ein echtes VS Code zu starten ist fuer einen Testlauf zu schwer -
 * also wird genau der Ausschnitt nachgebaut, den src/ benutzt, und zwar so,
 * dass er *aufzeichnet*, was die Extension tut. Geprueft wird hinterher das
 * Aufgezeichnete, nicht der Rueckgabewert einer Attrappe.
 *
 * Zwei Dinge sind noetig, damit `import * as vscode from 'vscode'` hier landet:
 *  - beim Uebersetzen der `paths`-Eintrag in tsconfig.test.json,
 *  - zur Laufzeit der Haken am Modulaufloeser ganz unten in dieser Datei.
 * Deshalb muss diese Datei in jeder Testdatei als *erstes* importiert werden.
 */

// ---------------------------------------------------------------- Grundlagen

export type Thenable<T> = PromiseLike<T>;

export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable;

/**
 * Zustand ausserhalb der Klasse, damit die Instanz strukturell nur `dispose()`
 * anbietet.
 *
 * `@types/vscode` deklariert Disposable ohne eigene Felder; jedes Objekt mit
 * `dispose()` ist dort zuweisbar - etwa ein StatusBarItem. Haette die Attrappe
 * Felder, waere sie *strenger* als die Wirklichkeit und wuerde Code als Fehler
 * melden, der in VS Code einwandfrei laeuft. Genau das ist hier passiert.
 */
const aufraeumer = new WeakMap<object, { fn: () => void; erledigt: boolean }>();

export class Disposable {
  constructor(aufraeumen: () => void) {
    aufraeumer.set(this, { fn: aufraeumen, erledigt: false });
  }

  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }

  dispose(): void {
    const eintrag = aufraeumer.get(this);
    if (!eintrag || eintrag.erledigt) return;
    eintrag.erledigt = true;
    eintrag.fn();
  }
}


export class EventEmitter<T> {
  private readonly horcher: ((e: T) => unknown)[] = [];

  readonly event: Event<T> = (listener, thisArgs) => {
    const gebunden = thisArgs ? listener.bind(thisArgs) : listener;
    this.horcher.push(gebunden);
    return new Disposable(() => {
      const index = this.horcher.indexOf(gebunden);
      if (index >= 0) this.horcher.splice(index, 1);
    });
  };

  fire(daten: T): void {
    // Kopie: ein Horcher darf sich waehrend der Zustellung abmelden.
    for (const h of [...this.horcher]) h(daten);
  }

  dispose(): void {
    this.horcher.length = 0;
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
  ) {}

  static file(pfad: string): Uri {
    return new Uri('file', '', pfad.startsWith('/') ? pfad : '/' + pfad);
  }

  static parse(wert: string): Uri {
    const treffer = /^([a-zA-Z][\w+.-]*):\/\/([^/]*)(\/.*)?$/.exec(wert);
    if (!treffer) return Uri.file(wert);
    return new Uri(treffer[1]!, treffer[2]!, treffer[3] ?? '');
  }

  static joinPath(basis: Uri, ...teile: string[]): Uri {
    const pfad = [basis.path.replace(/\/+$/, ''), ...teile.map((t) => t.replace(/^\/+/, ''))].join('/');
    return new Uri(basis.scheme, basis.authority, pfad);
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

// ------------------------------------------------------------ Aufzaehlungen

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// ------------------------------------------------------- Einfache Datentypen

export interface Command {
  command: string;
  title: string;
  tooltip?: string;
  arguments?: unknown[];
}

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  ignoreFocusOut?: boolean;
  canPickMany?: boolean;
  matchOnDescription?: boolean;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?: (wert: string) => string | undefined | null | Thenable<string | undefined | null>;
}

export interface MessageOptions {
  modal?: boolean;
  detail?: string;
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(abschnitt: string): boolean;
}

export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

export interface TreeDataProvider<T> {
  onDidChangeTreeData?: Event<unknown>;
  getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
  getChildren(element?: T): ProviderResult<T[]>;
}

export class MarkdownString {
  isTrusted?: boolean;
  supportThemeIcons?: boolean;

  constructor(public value: string = '') {}

  appendMarkdown(wert: string): MarkdownString {
    this.value += wert;
    return this;
  }
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  constructor(readonly id: string) {}
}

export class TreeItem {
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  iconPath?: Uri | ThemeIcon | { light: Uri; dark: Uri };
  contextValue?: string;
  command?: Command;
  id?: string;
  resourceUri?: Uri;

  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

// ------------------------------------------------------------- Aufzeichnung

export interface SchreibZugriff {
  abschnitt: string;
  schluessel: string;
  wert: unknown;
  ziel?: ConfigurationTarget;
}

/**
 * Alles, was die Extension nach aussen getan hat. Die Tests lesen hier ab -
 * so sind sie an das beobachtbare Verhalten gebunden und nicht an den Aufbau
 * des Codes.
 */
export const notizen = {
  /** Registrierte Befehle: Name -> Rueckruf. */
  befehle: new Map<string, (...argumente: any[]) => unknown>(),
  /** Aufrufe von `commands.executeCommand` in ihrer Reihenfolge. */
  ausgefuehrt: [] as { befehl: string; argumente: unknown[] }[],
  /** Werte, die ueber `setContext` gesetzt wurden. */
  kontext: new Map<string, unknown>(),
  /** Alle Zeilen aller Ausgabekanaele. */
  protokoll: [] as string[],
  ausgabekanaele: [] as OutputChannel[],
  hinweise: [] as string[],
  warnungen: [] as string[],
  fehlermeldungen: [] as string[],
  panels: [] as WebviewPanel[],
  statusleisten: [] as StatusBarItem[],
  baumAnbieter: new Map<string, TreeDataProvider<unknown>>(),
  schreibzugriffe: [] as SchreibZugriff[],
  /** Abgefragte Eingabefelder und Listen - fuer Tests, die den Dialogweg pruefen. */
  eingabefelder: [] as InputBoxOptions[],
  auswahllisten: [] as { eintraege: readonly QuickPickItem[]; optionen?: QuickPickOptions }[],
};

/**
 * Antworten, die die Attrappe der Reihe nach zurueckgibt. Leer bedeutet
 * "abgebrochen" (undefined) - so verhaelt sich VS Code, wenn der Benutzer
 * Escape drueckt.
 */
export const antworten = {
  /** Rueckgaben fuer `showInputBox`. */
  eingaben: [] as (string | undefined)[],
  /** Index des gewaehlten Eintrags fuer `showQuickPick`. */
  auswahlen: [] as (number | undefined)[],
  /** Rueckgaben fuer `showInformationMessage`/`showWarningMessage`/`showErrorMessage`. */
  meldungen: [] as (string | undefined)[],
};

/** Die Einstellungen, vollstaendig als "abschnitt.schluessel". */
export const einstellungen = new Map<string, unknown>();

export function zuruecksetzen(): void {
  notizen.befehle.clear();
  notizen.ausgefuehrt.length = 0;
  notizen.kontext.clear();
  notizen.protokoll.length = 0;
  notizen.ausgabekanaele.length = 0;
  notizen.hinweise.length = 0;
  notizen.warnungen.length = 0;
  notizen.fehlermeldungen.length = 0;
  notizen.panels.length = 0;
  notizen.statusleisten.length = 0;
  notizen.baumAnbieter.clear();
  notizen.schreibzugriffe.length = 0;
  notizen.eingabefelder.length = 0;
  notizen.auswahllisten.length = 0;
  antworten.eingaben.length = 0;
  antworten.auswahlen.length = 0;
  antworten.meldungen.length = 0;
  einstellungen.clear();
}

// ------------------------------------------------------------------ Webview

export class Webview {
  html = '';
  options: Record<string, unknown> = {};
  readonly cspSource = 'vscode-webview://pruefstand';
  /** Alles, was der Extension-Host ins Webview geschickt hat. */
  readonly gesendet: unknown[] = [];

  private readonly eingang = new EventEmitter<any>();
  readonly onDidReceiveMessage: Event<any> = this.eingang.event;

  asWebviewUri(uri: Uri): Uri {
    return Uri.parse(`https://pruefstand.vscode-webview.net${uri.path}`);
  }

  postMessage(nachricht: unknown): Thenable<boolean> {
    this.gesendet.push(nachricht);
    return Promise.resolve(true);
  }

  /** Eine Nachricht aus dem Webview-Skript, so wie VS Code sie durchreicht. */
  vomWebview(nachricht: unknown): void {
    this.eingang.fire(nachricht);
  }
}

export interface WebviewPanelOnDidChangeViewStateEvent {
  readonly webviewPanel: WebviewPanel;
}

export class WebviewPanel {
  readonly webview = new Webview();
  iconPath?: Uri | { light: Uri; dark: Uri };
  active = true;
  visible = true;
  /** Wurde `dispose()` bereits aufgerufen? */
  entsorgt = false;

  private readonly beimEntsorgen = new EventEmitter<void>();
  private readonly beimZustandswechsel = new EventEmitter<WebviewPanelOnDidChangeViewStateEvent>();
  readonly onDidDispose: Event<void> = this.beimEntsorgen.event;
  readonly onDidChangeViewState: Event<WebviewPanelOnDidChangeViewStateEvent> =
    this.beimZustandswechsel.event;

  constructor(
    readonly viewType: string,
    public title: string,
    public viewColumn: ViewColumn | undefined,
    readonly options: Record<string, unknown>,
  ) {}

  reveal(spalte?: ViewColumn): void {
    if (spalte !== undefined) this.viewColumn = spalte;
    this.visible = true;
    this.beimZustandswechsel.fire({ webviewPanel: this });
  }

  /** Fokuswechsel nachstellen, damit `onDidChangeViewState` pruefbar ist. */
  setzeAktiv(aktiv: boolean): void {
    this.active = aktiv;
    this.visible = aktiv || this.visible;
    this.beimZustandswechsel.fire({ webviewPanel: this });
  }

  dispose(): void {
    if (this.entsorgt) return;
    this.entsorgt = true;
    this.beimEntsorgen.fire();
  }
}

// ---------------------------------------------------- Kanaele und Statusleiste

export class OutputChannel {
  readonly zeilen: string[] = [];
  sichtbar = false;
  entsorgt = false;

  constructor(readonly name: string) {}

  append(wert: string): void {
    this.zeilen.push(wert);
    notizen.protokoll.push(wert);
  }

  appendLine(wert: string): void {
    this.zeilen.push(wert);
    notizen.protokoll.push(wert);
  }

  replace(wert: string): void {
    this.zeilen.length = 0;
    this.append(wert);
  }

  clear(): void {
    this.zeilen.length = 0;
  }

  show(): void {
    this.sichtbar = true;
  }

  hide(): void {
    this.sichtbar = false;
  }

  dispose(): void {
    this.entsorgt = true;
  }
}

export class StatusBarItem {
  text = '';
  tooltip: string | MarkdownString | undefined;
  command: string | Command | undefined;
  name: string | undefined;
  sichtbar = false;
  entsorgt = false;

  constructor(
    readonly alignment: StatusBarAlignment,
    readonly priority?: number,
  ) {}

  show(): void {
    this.sichtbar = true;
  }

  hide(): void {
    this.sichtbar = false;
  }

  dispose(): void {
    this.entsorgt = true;
  }
}

// ----------------------------------------------------------- Kontext/Speicher

export class SecretStorage {
  readonly werte = new Map<string, string>();
  private readonly aenderung = new EventEmitter<{ key: string }>();
  readonly onDidChange: Event<{ key: string }> = this.aenderung.event;

  get(schluessel: string): Thenable<string | undefined> {
    return Promise.resolve(this.werte.get(schluessel));
  }

  store(schluessel: string, wert: string): Thenable<void> {
    this.werte.set(schluessel, wert);
    this.aenderung.fire({ key: schluessel });
    return Promise.resolve();
  }

  delete(schluessel: string): Thenable<void> {
    this.werte.delete(schluessel);
    this.aenderung.fire({ key: schluessel });
    return Promise.resolve();
  }
}

export class Memento {
  readonly werte = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.werte.keys()];
  }

  get<T>(schluessel: string): T | undefined;
  get<T>(schluessel: string, standard: T): T;
  get<T>(schluessel: string, standard?: T): T | undefined {
    return this.werte.has(schluessel) ? (this.werte.get(schluessel) as T) : standard;
  }

  update(schluessel: string, wert: unknown): Thenable<void> {
    if (wert === undefined) this.werte.delete(schluessel);
    else this.werte.set(schluessel, wert);
    return Promise.resolve();
  }

  setKeysForSync(): void {}
}

export class ExtensionContext {
  readonly subscriptions: { dispose(): unknown }[] = [];
  readonly secrets = new SecretStorage();
  readonly globalState = new Memento();
  readonly workspaceState = new Memento();
  readonly extensionUri: Uri;
  readonly extensionPath: string;

  constructor(wurzel = '/erweiterung') {
    this.extensionUri = Uri.file(wurzel);
    this.extensionPath = wurzel;
  }

  /** Raeumt auf wie VS Code beim Deaktivieren. */
  entsorgeAlles(): void {
    for (const d of this.subscriptions.splice(0)) d.dispose();
  }
}

// ------------------------------------------------------------ Konfiguration

const konfigurationsAenderung = new EventEmitter<ConfigurationChangeEvent>();

export class WorkspaceConfiguration {
  constructor(private readonly abschnitt: string) {}

  private voll(schluessel: string): string {
    return this.abschnitt ? `${this.abschnitt}.${schluessel}` : schluessel;
  }

  get<T>(schluessel: string): T | undefined;
  get<T>(schluessel: string, standard: T): T;
  get<T>(schluessel: string, standard?: T): T | undefined {
    const name = this.voll(schluessel);
    return einstellungen.has(name) ? (einstellungen.get(name) as T) : standard;
  }

  has(schluessel: string): boolean {
    return einstellungen.has(this.voll(schluessel));
  }

  update(schluessel: string, wert: unknown, ziel?: ConfigurationTarget): Thenable<void> {
    const name = this.voll(schluessel);
    einstellungen.set(name, wert);
    notizen.schreibzugriffe.push({ abschnitt: this.abschnitt, schluessel, wert, ziel });
    konfigurationsAenderung.fire({
      affectsConfiguration: (gefragt: string) => name === gefragt || name.startsWith(gefragt + '.'),
    });
    return Promise.resolve();
  }
}

export const workspace = {
  getConfiguration(abschnitt = ''): WorkspaceConfiguration {
    return new WorkspaceConfiguration(abschnitt);
  },
  onDidChangeConfiguration: konfigurationsAenderung.event,
  /** Eine Aenderung anstossen, ohne den Wert wirklich zu schreiben. */
  meldeKonfigurationsAenderung(abschnitte: string[]): void {
    konfigurationsAenderung.fire({
      affectsConfiguration: (gefragt: string) =>
        abschnitte.some((a) => a === gefragt || a.startsWith(gefragt + '.')),
    });
  },
};

// ----------------------------------------------------------------- Befehle

export const commands = {
  registerCommand(befehl: string, rueckruf: (...argumente: any[]) => unknown): Disposable {
    // VS Code laesst denselben Befehl kein zweites Mal zu. Das hier
    // nachzubilden ist kein Selbstzweck: eine doppelte Registrierung waere in
    // der echten Umgebung ein harter Fehler beim Aktivieren.
    if (notizen.befehle.has(befehl)) {
      throw new Error(`Der Befehl "${befehl}" ist bereits registriert.`);
    }
    notizen.befehle.set(befehl, rueckruf);
    return new Disposable(() => notizen.befehle.delete(befehl));
  },

  executeCommand<T = unknown>(befehl: string, ...argumente: any[]): Thenable<T | undefined> {
    notizen.ausgefuehrt.push({ befehl, argumente });
    if (befehl === 'setContext') {
      notizen.kontext.set(String(argumente[0]), argumente[1]);
      return Promise.resolve(undefined);
    }
    const rueckruf = notizen.befehle.get(befehl);
    if (!rueckruf) return Promise.resolve(undefined);
    return Promise.resolve(rueckruf(...argumente)) as Thenable<T | undefined>;
  },

  getCommands(): Thenable<string[]> {
    return Promise.resolve([...notizen.befehle.keys()]);
  },
};

// ------------------------------------------------------------------ Fenster

function naechsteMeldungsantwort(auswahlmoeglichkeiten: string[]): string | undefined {
  const antwort = antworten.meldungen.shift();
  if (antwort === undefined) return undefined;
  if (auswahlmoeglichkeiten.length > 0 && !auswahlmoeglichkeiten.includes(antwort)) {
    throw new Error(
      `Antwort "${antwort}" wird von dieser Meldung nicht angeboten (${auswahlmoeglichkeiten.join(', ')}).`,
    );
  }
  return antwort;
}

function nurTexte(rest: Array<string | MessageOptions>): string[] {
  return rest.filter((e): e is string => typeof e === 'string');
}

export const window = {
  createOutputChannel(name: string): OutputChannel {
    const kanal = new OutputChannel(name);
    notizen.ausgabekanaele.push(kanal);
    return kanal;
  },

  createStatusBarItem(alignment: StatusBarAlignment, priority?: number): StatusBarItem {
    const eintrag = new StatusBarItem(alignment, priority);
    notizen.statusleisten.push(eintrag);
    return eintrag;
  },

  createWebviewPanel(
    viewType: string,
    title: string,
    spalte: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
    options: Record<string, unknown> = {},
  ): WebviewPanel {
    const gewaehlt = typeof spalte === 'object' ? spalte.viewColumn : spalte;
    const panel = new WebviewPanel(viewType, title, gewaehlt, options);
    notizen.panels.push(panel);
    return panel;
  },

  registerTreeDataProvider<T>(sicht: string, anbieter: TreeDataProvider<T>): Disposable {
    notizen.baumAnbieter.set(sicht, anbieter as TreeDataProvider<unknown>);
    return new Disposable(() => notizen.baumAnbieter.delete(sicht));
  },

  showInformationMessage(
    nachricht: string,
    ...rest: Array<string | MessageOptions>
  ): Thenable<string | undefined> {
    notizen.hinweise.push(nachricht);
    return Promise.resolve(naechsteMeldungsantwort(nurTexte(rest)));
  },

  showWarningMessage(
    nachricht: string,
    ...rest: Array<string | MessageOptions>
  ): Thenable<string | undefined> {
    notizen.warnungen.push(nachricht);
    return Promise.resolve(naechsteMeldungsantwort(nurTexte(rest)));
  },

  showErrorMessage(
    nachricht: string,
    ...rest: Array<string | MessageOptions>
  ): Thenable<string | undefined> {
    notizen.fehlermeldungen.push(nachricht);
    return Promise.resolve(naechsteMeldungsantwort(nurTexte(rest)));
  },

  showInputBox(optionen: InputBoxOptions = {}): Thenable<string | undefined> {
    notizen.eingabefelder.push(optionen);
    const wert = antworten.eingaben.shift();
    // Die Pruefung ist Teil des Vertrags: was VS Code ablehnen wuerde, darf
    // hier nicht als Ergebnis durchgehen.
    if (wert !== undefined && optionen.validateInput) {
      const fehler = optionen.validateInput(wert);
      if (typeof fehler === 'string' && fehler.length > 0) {
        throw new Error(`Eingabe "${wert}" wird von validateInput abgelehnt: ${fehler}`);
      }
    }
    return Promise.resolve(wert);
  },

  showQuickPick<T extends QuickPickItem>(
    eintraege: readonly T[],
    optionen?: QuickPickOptions,
  ): Thenable<T | undefined> {
    notizen.auswahllisten.push({ eintraege, optionen });
    const index = antworten.auswahlen.shift();
    if (index === undefined) return Promise.resolve(undefined);
    const gewaehlt = eintraege[index];
    if (!gewaehlt) throw new Error(`Auswahl ${index} gibt es in dieser Liste nicht.`);
    return Promise.resolve(gewaehlt);
  },
};

// ---------------------------------------------------------- Laufzeit-Haken

/**
 * Der uebersetzte CommonJS-Code enthaelt weiterhin `require("vscode")` - tsc
 * schreibt `paths` beim Ausgeben nicht um. Deshalb wird die Aufloesung hier
 * einmalig umgebogen. Das passiert beim Laden dieser Datei, also muss sie in
 * jeder Testdatei vor den Modulen aus src/ importiert werden.
 */
function installiereHaken(): void {
  const modul = require('node:module') as {
    _resolveFilename(anfrage: string, ...rest: unknown[]): string;
    __vscodeAttrappe?: boolean;
  };
  if (modul.__vscodeAttrappe) return;
  modul.__vscodeAttrappe = true;
  const original = modul._resolveFilename;
  modul._resolveFilename = function (this: unknown, anfrage: string, ...rest: unknown[]): string {
    if (anfrage === 'vscode') return __filename;
    return original.call(this, anfrage, ...rest);
  };
}

installiereHaken();
