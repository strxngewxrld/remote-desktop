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
  matchOnDetail?: boolean;
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

export interface OpenDialogOptions {
  title?: string;
  openLabel?: string;
  canSelectMany?: boolean;
  canSelectFiles?: boolean;
  canSelectFolders?: boolean;
  defaultUri?: Uri;
  filters?: Record<string, string[]>;
}

export interface SaveDialogOptions {
  title?: string;
  saveLabel?: string;
  defaultUri?: Uri;
  filters?: Record<string, string[]>;
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

/**
 * Verweis auf eine Farbe der Oberflaeche. Wie in VS Code haelt sie nur den
 * Schluessel - was daraus wird, entscheidet erst das Theme.
 */
export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
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
  /**
   * Die Optionen jeder Warnung, in derselben Reihenfolge wie `warnungen`.
   * Fuer Rueckfragen, bei denen `modal` den Unterschied macht: ein
   * nichtmodaler Hinweis verschwindet ungelesen wieder.
   */
  warnungsOptionen: [] as (MessageOptions | undefined)[],
  panels: [] as WebviewPanel[],
  statusleisten: [] as StatusBarItem[],
  baumAnbieter: new Map<string, TreeDataProvider<unknown>>(),
  schreibzugriffe: [] as SchreibZugriff[],
  /** Abgefragte Eingabefelder und Listen - fuer Tests, die den Dialogweg pruefen. */
  eingabefelder: [] as InputBoxOptions[],
  auswahllisten: [] as { eintraege: readonly QuickPickItem[]; optionen?: QuickPickOptions }[],
  /** Geoeffnete Datei-Dialoge. */
  oeffnenDialoge: [] as OpenDialogOptions[],
  speichernDialoge: [] as SaveDialogOptions[],
  /** Was ueber `workspace.fs.writeFile` geschrieben wurde. */
  geschriebeneDateien: [] as { pfad: string; inhalt: Uint8Array }[],
  /** Was ueber `workspace.fs.delete` geloescht wurde. */
  geloeschteDateien: [] as { pfad: string; papierkorb: boolean }[],
  /** Was ueber `workspace.fs.rename` verschoben wurde. */
  umbenannteDateien: [] as { von: string; nach: string }[],
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
  /** Rueckgaben fuer `showOpenDialog`. */
  dateiauswahlen: [] as (Uri[] | undefined)[],
  /** Rueckgaben fuer `showSaveDialog`. */
  speicherziele: [] as (Uri | undefined)[],
};

/** Wie `vscode.ExtensionKind`: 1 = UI (lokal), 2 = Workspace (dort, wo der Arbeitsbereich liegt). */
export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

/** Wie `vscode.UIKind`: 1 = Desktop, 2 = Browser. */
export enum UIKind {
  Desktop = 1,
  Web = 2,
}

/**
 * Ein Dateisystem im Arbeitsspeicher fuer `workspace.fs`. Tests legen den
 * Inhalt hier ab, statt echte Dateien anzulegen.
 */
export const dateien = new Map<string, Uint8Array>();

/** Die Einstellungen, vollstaendig als "abschnitt.schluessel". */
export const einstellungen = new Map<string, unknown>();

/**
 * Die Zwischenablage des Editors.
 *
 * `inhalt` ist der gespeicherte Text, `lesefehler`/`schreibfehler` zwingen den
 * naechsten Zugriff in einen Fehler - genau das braucht der Test fuer die
 * Rueckfallebene, denn in manchen Remote- und Web-Umgebungen wirft
 * `vscode.env.clipboard` tatsaechlich.
 */
export const zwischenablage = {
  inhalt: '',
  lesefehler: undefined as Error | undefined,
  schreibfehler: undefined as Error | undefined,
  /** Alles, was geschrieben wurde, in der Reihenfolge. */
  geschrieben: [] as string[],
};

/**
 * Wo VS Code die Extension laufen laesst.
 *
 * Unter Remote-SSH ist das der entfernte Rechner - genau der Unterschied, den
 * die Extension erkennen und protokollieren muss. Die Attrappe laesst Tests
 * beide Faelle durchspielen, ohne dass eine SSH-Verbindung noetig waere.
 */
export const umgebung = {
  /** `vscode.env.remoteName`: `undefined` lokal, sonst etwa `ssh-remote`. */
  fernart: undefined as string | undefined,
  /** Welche `ExtensionKind` `extensions.getExtension` melden soll. */
  geladenAls: ExtensionKind.Workspace as ExtensionKind | undefined,
  /** Ist die Extension ueberhaupt auffindbar? */
  bekannt: true,
  /** `vscode.env.uiKind`. */
  oberflaeche: UIKind.Desktop as UIKind,
};

export const extensions = {
  getExtension(id: string): { id: string; extensionKind: ExtensionKind | undefined } | undefined {
    if (!umgebung.bekannt) return undefined;
    return { id, extensionKind: umgebung.geladenAls };
  },
};

export const env = {
  get remoteName(): string | undefined {
    return umgebung.fernart;
  },
  get uiKind(): UIKind {
    return umgebung.oberflaeche;
  },
  clipboard: {
    readText(): Thenable<string> {
      if (zwischenablage.lesefehler) return Promise.reject(zwischenablage.lesefehler);
      return Promise.resolve(zwischenablage.inhalt);
    },
    writeText(text: string): Thenable<void> {
      if (zwischenablage.schreibfehler) return Promise.reject(zwischenablage.schreibfehler);
      zwischenablage.inhalt = text;
      zwischenablage.geschrieben.push(text);
      return Promise.resolve();
    },
  },
};

export function zuruecksetzen(): void {
  notizen.befehle.clear();
  notizen.ausgefuehrt.length = 0;
  notizen.kontext.clear();
  notizen.protokoll.length = 0;
  notizen.ausgabekanaele.length = 0;
  notizen.hinweise.length = 0;
  notizen.warnungen.length = 0;
  notizen.fehlermeldungen.length = 0;
  notizen.warnungsOptionen.length = 0;
  notizen.panels.length = 0;
  notizen.statusleisten.length = 0;
  notizen.baumAnbieter.clear();
  notizen.schreibzugriffe.length = 0;
  notizen.eingabefelder.length = 0;
  notizen.auswahllisten.length = 0;
  notizen.oeffnenDialoge.length = 0;
  notizen.speichernDialoge.length = 0;
  notizen.geschriebeneDateien.length = 0;
  notizen.geloeschteDateien.length = 0;
  notizen.umbenannteDateien.length = 0;
  antworten.eingaben.length = 0;
  antworten.auswahlen.length = 0;
  antworten.meldungen.length = 0;
  antworten.dateiauswahlen.length = 0;
  antworten.speicherziele.length = 0;
  einstellungen.clear();
  dateien.clear();
  fs.ordner.clear();
  workspaceFolders = undefined;
  zwischenablage.inhalt = '';
  zwischenablage.lesefehler = undefined;
  zwischenablage.schreibfehler = undefined;
  zwischenablage.geschrieben.length = 0;
  umgebung.fernart = undefined;
  umgebung.geladenAls = ExtensionKind.Workspace;
  umgebung.bekannt = true;
  umgebung.oberflaeche = UIKind.Desktop;
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
  /** Vordergrundfarbe; VS Code nimmt hier auch eine Zeichenkette an. */
  color: string | ThemeColor | undefined;
  /** VS Code wertet hier nur errorBackground/warningBackground aus. */
  backgroundColor: ThemeColor | undefined;
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
  /** Eigener Ablageort der Extension - dort landen die erzeugten Farbsymbole. */
  readonly globalStorageUri: Uri;

  constructor(wurzel = '/erweiterung') {
    this.extensionUri = Uri.file(wurzel);
    this.extensionPath = wurzel;
    this.globalStorageUri = Uri.file(wurzel + '/ablage');
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

/** Wie `vscode.FileType`: eine Bitmaske, Symlinks kommen kombiniert. */
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

/** Wie `vscode.FileStat`. Zeiten sind Millisekunden seit der Unix-Epoche. */
export interface FileStat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
}

/** Wie `vscode.WorkspaceFolder`. */
export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

/** Wie `vscode.WorkspaceFoldersChangeEvent`. */
export interface WorkspaceFoldersChangeEvent {
  readonly added: readonly WorkspaceFolder[];
  readonly removed: readonly WorkspaceFolder[];
}

const arbeitsbereichsAenderung = new EventEmitter<WorkspaceFoldersChangeEvent>();

/**
 * Die Ordner des Arbeitsbereichs. `undefined` heisst "kein Ordner geoeffnet" -
 * genau das liefert VS Code in einem leeren Fenster, und das ist ein Fall,
 * den die Laufwerksumleitung abfangen muss.
 */
export let workspaceFolders: WorkspaceFolder[] | undefined;

/** Die Ordner setzen und die Aenderung melden - wie ein echter Wechsel. */
export function setzeArbeitsbereichsOrdner(pfade: readonly string[]): void {
  const vorher = workspaceFolders ?? [];
  workspaceFolders =
    pfade.length === 0
      ? undefined
      : pfade.map((pfad, index) => ({
          uri: Uri.file(pfad),
          name: pfad.split('/').filter(Boolean).pop() ?? pfad,
          index,
        }));
  const jetzt = workspaceFolders ?? [];
  arbeitsbereichsAenderung.fire({
    added: jetzt.filter((o) => !vorher.some((v) => v.uri.fsPath === o.uri.fsPath)),
    removed: vorher.filter((v) => !jetzt.some((o) => o.uri.fsPath === v.uri.fsPath)),
  });
}

/**
 * `workspace.fs` gegen die Map `dateien` und die Menge `fs.ordner`.
 *
 * Verzeichnisse gibt es im Arbeitsspeicher nicht wirklich; als vorhanden gilt
 * ein Ordner, wenn er in `fs.ordner` steht oder eine Datei unter ihm liegt.
 * Das reicht, um `stat` und `readDirectory` glaubwuerdig zu beantworten.
 */
export const fs = {
  /**
   * Angelegte Ordner. Im Arbeitsspeicher gibt es keine echten Verzeichnisse -
   * festgehalten wird nur, dass die Extension ueberhaupt daran gedacht hat.
   */
  ordner: new Set<string>(),

  createDirectory(uri: Uri): Thenable<void> {
    fs.ordner.add(uri.fsPath);
    return Promise.resolve();
  },

  readFile(uri: Uri): Thenable<Uint8Array> {
    const inhalt = dateien.get(uri.fsPath);
    if (!inhalt) return Promise.reject(new Error(`Datei nicht gefunden: ${uri.fsPath}`));
    return Promise.resolve(inhalt);
  },

  writeFile(uri: Uri, inhalt: Uint8Array): Thenable<void> {
    dateien.set(uri.fsPath, inhalt);
    notizen.geschriebeneDateien.push({ pfad: uri.fsPath, inhalt });
    return Promise.resolve();
  },

  /** Gibt es unterhalb dieses Pfades irgendeine Datei? */
  istOrdner(pfad: string): boolean {
    if (fs.ordner.has(pfad)) return true;
    const praefix = pfad.endsWith('/') ? pfad : pfad + '/';
    for (const vorhandener of dateien.keys()) {
      if (vorhandener.startsWith(praefix)) return true;
    }
    for (const vorhandener of fs.ordner) {
      if (vorhandener.startsWith(praefix)) return true;
    }
    return false;
  },

  stat(uri: Uri): Thenable<FileStat> {
    const pfad = uri.fsPath;
    const inhalt = dateien.get(pfad);
    if (inhalt) {
      return Promise.resolve({ type: FileType.File, ctime: 1000, mtime: 2000, size: inhalt.length });
    }
    if (fs.istOrdner(pfad)) {
      return Promise.resolve({ type: FileType.Directory, ctime: 1000, mtime: 2000, size: 0 });
    }
    // Wie der echte Anbieter: fehlende Pfade werfen, sie liefern kein
    // undefined. Die Extension muss damit umgehen koennen.
    return Promise.reject(new Error(`FileNotFound: ${pfad}`));
  },

  readDirectory(uri: Uri): Thenable<[string, FileType][]> {
    const praefix = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';
    const gefunden = new Map<string, FileType>();
    for (const pfad of dateien.keys()) {
      if (!pfad.startsWith(praefix)) continue;
      const rest = pfad.substring(praefix.length);
      const erstes = rest.split('/')[0];
      if (!erstes) continue;
      gefunden.set(erstes, rest.includes('/') ? FileType.Directory : FileType.File);
    }
    for (const pfad of fs.ordner) {
      if (!pfad.startsWith(praefix)) continue;
      const erstes = pfad.substring(praefix.length).split('/')[0];
      if (erstes) gefunden.set(erstes, FileType.Directory);
    }
    return Promise.resolve([...gefunden.entries()]);
  },

  delete(uri: Uri, optionen?: { recursive?: boolean; useTrash?: boolean }): Thenable<void> {
    const pfad = uri.fsPath;
    notizen.geloeschteDateien.push({ pfad, papierkorb: optionen?.useTrash === true });
    if (dateien.delete(pfad)) return Promise.resolve();
    if (!fs.istOrdner(pfad)) return Promise.reject(new Error(`FileNotFound: ${pfad}`));
    const praefix = pfad + '/';
    const kinder = [...dateien.keys()].filter((p) => p.startsWith(praefix));
    if (kinder.length > 0 && optionen?.recursive !== true) {
      return Promise.reject(new Error(`FileNotEmpty: ${pfad}`));
    }
    for (const kind of kinder) dateien.delete(kind);
    fs.ordner.delete(pfad);
    return Promise.resolve();
  },

  rename(von: Uri, nach: Uri, optionen?: { overwrite?: boolean }): Thenable<void> {
    const inhalt = dateien.get(von.fsPath);
    if (inhalt === undefined) return Promise.reject(new Error(`FileNotFound: ${von.fsPath}`));
    if (dateien.has(nach.fsPath) && optionen?.overwrite !== true) {
      return Promise.reject(new Error(`FileExists: ${nach.fsPath}`));
    }
    dateien.delete(von.fsPath);
    dateien.set(nach.fsPath, inhalt);
    notizen.umbenannteDateien.push({ von: von.fsPath, nach: nach.fsPath });
    return Promise.resolve();
  },
};

export const workspace = {
  fs,

  get workspaceFolders(): WorkspaceFolder[] | undefined {
    return workspaceFolders;
  },
  onDidChangeWorkspaceFolders: arbeitsbereichsAenderung.event,

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
    notizen.warnungsOptionen.push(rest.find((e): e is MessageOptions => typeof e === 'object'));
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

  showOpenDialog(optionen: OpenDialogOptions = {}): Thenable<Uri[] | undefined> {
    notizen.oeffnenDialoge.push(optionen);
    return Promise.resolve(antworten.dateiauswahlen.shift());
  },

  showSaveDialog(optionen: SaveDialogOptions = {}): Thenable<Uri | undefined> {
    notizen.speichernDialoge.push(optionen);
    return Promise.resolve(antworten.speicherziele.shift());
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
