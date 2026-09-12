/**
 * Verwaltung der gespeicherten Verbindungen: Einstellungen, Ordnerbaum,
 * Vererbung, Passwortspeicher und die Baumansicht in der Seitenleiste.
 *
 * ## Aufbau von `rdp.connections`
 *
 * Die Einstellung ist eine Liste aus *Eintraegen*. Ein Eintrag ist entweder
 * eine Verbindung (erkennbar am `host`) oder ein Ordner (erkennbar an
 * `type: "folder"` beziehungsweise an `children`). Ordner duerfen beliebig
 * tief verschachtelt werden:
 *
 * ```jsonc
 * [
 *   { "name": "Alter Eintrag", "host": "10.0.0.1" },          // flaches Format
 *   {
 *     "type": "folder",
 *     "name": "Kunde A",
 *     "settings": { "domain": "KUNDEA", "colorDepth": 16 },   // wird vererbt
 *     "children": [
 *       { "name": "DC01", "host": "10.1.0.10", "tags": ["prod"] }
 *     ]
 *   }
 * ]
 * ```
 *
 * ## Abwaertskompatibilitaet
 *
 * Das alte flache Format ist ein Sonderfall des neuen: eine Liste ohne Ordner.
 * Es wird unveraendert gelesen und beim Speichern nicht angefasst - niemand
 * verliert beim Update seine Verbindungen, und ein Zurueckrollen der Extension
 * bleibt moeglich, solange keine Ordner angelegt wurden. Die Normalisierung
 * beim Lesen (`normalisiereBaum`) wirft nur kaputte Eintraege weg.
 *
 * ## Aufloesungsreihenfolge der Einstellungen
 *
 *   1. der Wert an der Verbindung selbst,
 *   2. der `settings`-Wert des unmittelbar umgebenden Ordners,
 *   3. der `settings`-Wert von dessen Elternordner (und so weiter nach oben),
 *   4. die globale Einstellung unter `rdp.*`.
 *
 * Kurz: Verbindung schlaegt Ordner, Ordner schlaegt Elternordner, Elternordner
 * schlaegt globale Einstellung. Die Stufen 1 bis 3 erledigt
 * `loeseVerbindungAuf`, Stufe 4 bleibt bei den Verbrauchern (`session.ts`),
 * weil dort ohnehin schon `?? config.get(...)` steht.
 */
import * as vscode from 'vscode';
import { BANDBREITEN_PROFILE, BandbreitenProfilName, istProfilName } from './bandbreite.js';

export interface RdpConnection {
  name: string;
  host: string;
  port?: number;
  username?: string;
  domain?: string;
  width?: number;
  height?: number;
  colorDepth?: number;
  keyboardLayout?: string;
  /** Freie Schlagworte, nach denen die Suche filtert. */
  tags?: string[];
  /** Bandbreitenprofil, siehe bandbreite.ts. */
  bandwidthProfile?: BandbreitenProfilName;
}

/** Die Felder, die ein Ordner an seine Verbindungen weitergibt. */
export interface VererbbareEinstellungen {
  port?: number;
  username?: string;
  domain?: string;
  width?: number;
  height?: number;
  colorDepth?: number;
  keyboardLayout?: string;
  bandwidthProfile?: BandbreitenProfilName;
}

export interface RdpFolder {
  type: 'folder';
  name: string;
  children: RdpBaumEintrag[];
  /** Wird an alle enthaltenen Verbindungen vererbt. */
  settings?: VererbbareEinstellungen;
  /** Ordner-Tags gelten zusaetzlich fuer jede enthaltene Verbindung. */
  tags?: string[];
}

export type RdpBaumEintrag = RdpFolder | RdpConnection;

/** Eine Verbindung samt ihrer Lage im Baum. */
export interface VerbindungsEintrag {
  /** Die Verbindung, so wie sie in den Einstellungen steht. */
  verbindung: RdpConnection;
  /** Indexweg von der Wurzel bis zu diesem Eintrag. */
  pfad: number[];
  /** Die umgebenden Ordner von aussen nach innen. */
  ordnerKette: RdpFolder[];
}

/**
 * Die vererbbaren Schluessel in einer Liste - so bleibt die Vererbung an einer
 * Stelle definiert und laeuft nicht mit neuen Feldern auseinander.
 */
export const VERERBBARE_SCHLUESSEL: readonly (keyof VererbbareEinstellungen)[] = [
  'port',
  'username',
  'domain',
  'width',
  'height',
  'colorDepth',
  'keyboardLayout',
  'bandwidthProfile',
];

const SECTION = 'rdp';

// -------------------------------------------------------------- Migration

/** Ist dieser Eintrag ein Ordner? */
export function istOrdner(eintrag: RdpBaumEintrag | undefined): eintrag is RdpFolder {
  return !!eintrag && (eintrag as RdpFolder).type === 'folder';
}

function textListe(wert: unknown): string[] | undefined {
  if (!Array.isArray(wert)) return undefined;
  const gefiltert = wert
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim());
  return gefiltert.length > 0 ? gefiltert : undefined;
}

function normalisiereEinstellungen(wert: unknown): VererbbareEinstellungen | undefined {
  if (!wert || typeof wert !== 'object') return undefined;
  const roh = wert as Record<string, unknown>;
  const ergebnis: Record<string, unknown> = {};
  for (const schluessel of VERERBBARE_SCHLUESSEL) {
    const v = roh[schluessel];
    if (v === undefined || v === null || v === '') continue;
    if (schluessel === 'bandwidthProfile') {
      if (istProfilName(v)) ergebnis[schluessel] = v;
      continue;
    }
    ergebnis[schluessel] = v;
  }
  return Object.keys(ergebnis).length > 0 ? (ergebnis as VererbbareEinstellungen) : undefined;
}

/**
 * Macht aus dem rohen Einstellungswert einen sauberen Baum.
 *
 * Hier laeuft die Migration: alte flache Eintraege kommen unveraendert durch,
 * kaputte Eintraege (kein Objekt, kein Host, kein Ordner) fliegen raus. Es wird
 * bewusst *nichts* zurueckgeschrieben - die Einstellungen bleiben so, wie der
 * Benutzer sie kennt, bis er selbst etwas aendert.
 */
export function normalisiereBaum(roh: unknown, tiefe = 0): RdpBaumEintrag[] {
  if (!Array.isArray(roh) || tiefe > 32) return [];
  const ergebnis: RdpBaumEintrag[] = [];
  for (const eintrag of roh) {
    if (!eintrag || typeof eintrag !== 'object' || Array.isArray(eintrag)) continue;
    const kandidat = eintrag as Record<string, unknown>;
    const istFolder =
      kandidat.type === 'folder' || (Array.isArray(kandidat.children) && typeof kandidat.host !== 'string');
    if (istFolder) {
      const name = typeof kandidat.name === 'string' && kandidat.name.trim() ? kandidat.name.trim() : 'Ordner';
      const ordner: RdpFolder = {
        type: 'folder',
        name,
        children: normalisiereBaum(kandidat.children, tiefe + 1),
      };
      const settings = normalisiereEinstellungen(kandidat.settings);
      if (settings) ordner.settings = settings;
      const tags = textListe(kandidat.tags);
      if (tags) ordner.tags = tags;
      ergebnis.push(ordner);
      continue;
    }
    if (typeof kandidat.host !== 'string' || kandidat.host.length === 0) continue;
    // Unbekannte Felder absichtlich mitnehmen: eine aeltere Extension soll
    // Eintraege einer neueren nicht beim ersten Speichern verstuemmeln.
    const { children: _kinder, type: _typ, ...rest } = kandidat;
    const verbindung = rest as unknown as RdpConnection;
    if (verbindung.tags !== undefined) {
      const tags = textListe(verbindung.tags);
      if (tags) verbindung.tags = tags;
      else delete verbindung.tags;
    }
    if (verbindung.bandwidthProfile !== undefined && !istProfilName(verbindung.bandwidthProfile)) {
      delete verbindung.bandwidthProfile;
    }
    ergebnis.push(verbindung);
  }
  return ergebnis;
}

// ----------------------------------------------------------------- Lesen

/** Der vollstaendige Baum aus den Einstellungen. */
export function getBaum(): RdpBaumEintrag[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>('connections');
  return normalisiereBaum(raw);
}

/** Alle Verbindungen samt Lage im Baum, in Tiefensuche-Reihenfolge. */
export function alleVerbindungen(baum: RdpBaumEintrag[] = getBaum()): VerbindungsEintrag[] {
  const ergebnis: VerbindungsEintrag[] = [];
  const gehe = (eintraege: RdpBaumEintrag[], pfad: number[], kette: RdpFolder[]): void => {
    eintraege.forEach((eintrag, index) => {
      if (istOrdner(eintrag)) gehe(eintrag.children, [...pfad, index], [...kette, eintrag]);
      else ergebnis.push({ verbindung: eintrag, pfad: [...pfad, index], ordnerKette: kette });
    });
  };
  gehe(baum, [], []);
  return ergebnis;
}

/**
 * Alle Verbindungen als flache Liste - die alte Schnittstelle. Ordner sind
 * darin aufgeloest, die Reihenfolge ist die Tiefensuche.
 */
export function getConnections(): RdpConnection[] {
  return alleVerbindungen().map((e) => e.verbindung);
}

/** Tags der Verbindung plus die Tags aller umgebenden Ordner, ohne Dubletten. */
export function effektiveTags(verbindung: RdpConnection, ordnerKette: RdpFolder[] = []): string[] {
  const gesehen = new Set<string>();
  const ergebnis: string[] = [];
  for (const tag of [...(verbindung.tags ?? []), ...ordnerKette.flatMap((o) => o.tags ?? [])]) {
    const schluessel = tag.toLowerCase();
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    ergebnis.push(tag);
  }
  return ergebnis;
}

/**
 * Wendet die Vererbung an: Verbindung schlaegt Ordner, Ordner schlaegt
 * Elternordner. Was danach noch offen ist, bleibt `undefined` und wird von der
 * globalen Einstellung gefuellt.
 */
export function loeseVerbindungAuf(eintrag: VerbindungsEintrag): RdpConnection {
  const ergebnis = { ...eintrag.verbindung } as Record<string, unknown>;
  // Von innen nach aussen laufen: der naechstgelegene Ordner kommt zuerst dran
  // und der erste gesetzte Wert gewinnt.
  for (const ordner of [...eintrag.ordnerKette].reverse()) {
    const settings = ordner.settings;
    if (!settings) continue;
    for (const schluessel of VERERBBARE_SCHLUESSEL) {
      const wert = settings[schluessel];
      if (wert === undefined) continue;
      if (ergebnis[schluessel] === undefined) ergebnis[schluessel] = wert;
    }
  }
  const tags = effektiveTags(eintrag.verbindung, eintrag.ordnerKette);
  if (tags.length > 0) ergebnis.tags = tags;
  return ergebnis as unknown as RdpConnection;
}

/** Voller Anzeigepfad einer Verbindung, etwa "Kunde A / Test / DC01". */
export function pfadText(eintrag: VerbindungsEintrag): string {
  return [...eintrag.ordnerKette.map((o) => o.name), eintrag.verbindung.name || eintrag.verbindung.host].join(' / ');
}

/** Passt die Verbindung zum Suchtext? Geprueft werden Name, Host, Tags, Ordner. */
export function passtZuSuche(eintrag: VerbindungsEintrag, suche: string): boolean {
  const text = suche.trim().toLowerCase();
  if (!text) return true;
  const felder = [
    eintrag.verbindung.name ?? '',
    eintrag.verbindung.host ?? '',
    ...effektiveTags(eintrag.verbindung, eintrag.ordnerKette),
    ...eintrag.ordnerKette.map((o) => o.name),
  ];
  return felder.some((f) => f.toLowerCase().includes(text));
}

// -------------------------------------------------------------- Schreiben

export async function saveConnections(connections: RdpBaumEintrag[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  // In den globalen Einstellungen ablegen, damit Verbindungen projektuebergreifend gelten.
  await config.update('connections', connections, vscode.ConfigurationTarget.Global);
}

/** Liefert die Kinderliste, in der der Eintrag an diesem Pfad liegt. */
function elternListe(baum: RdpBaumEintrag[], pfad: number[]): RdpBaumEintrag[] | undefined {
  let liste = baum;
  for (const index of pfad.slice(0, -1)) {
    const eintrag = liste[index];
    if (!istOrdner(eintrag)) return undefined;
    liste = eintrag.children;
  }
  return liste;
}

/** Der Eintrag an diesem Pfad, falls es ihn gibt. */
export function eintragAn(baum: RdpBaumEintrag[], pfad: number[]): RdpBaumEintrag | undefined {
  if (pfad.length === 0) return undefined;
  const liste = elternListe(baum, pfad);
  return liste?.[pfad[pfad.length - 1]!];
}

/** Haengt eine Verbindung an - ohne Pfad in die Wurzel, sonst in den Ordner. */
export async function addConnection(connection: RdpConnection, ordnerPfad: number[] = []): Promise<void> {
  const baum = getBaum();
  const ziel = ordnerPfad.length === 0 ? undefined : eintragAn(baum, ordnerPfad);
  if (istOrdner(ziel)) ziel.children.push(connection);
  else baum.push(connection);
  await saveConnections(baum);
}

/** Legt einen Ordner an - ohne Pfad in der Wurzel, sonst im Ordner. */
export async function addFolder(name: string, ordnerPfad: number[] = []): Promise<void> {
  const baum = getBaum();
  const ordner: RdpFolder = { type: 'folder', name, children: [] };
  const ziel = ordnerPfad.length === 0 ? undefined : eintragAn(baum, ordnerPfad);
  if (istOrdner(ziel)) ziel.children.push(ordner);
  else baum.push(ordner);
  await saveConnections(baum);
}

/** Ersetzt den Eintrag an diesem Pfad. */
export async function schreibeEintragAn(pfad: number[], eintrag: RdpBaumEintrag): Promise<void> {
  const baum = getBaum();
  const liste = elternListe(baum, pfad);
  const index = pfad[pfad.length - 1]!;
  if (!liste || index < 0 || index >= liste.length) return;
  liste[index] = eintrag;
  await saveConnections(baum);
}

/** Entfernt den Eintrag an diesem Pfad - bei einem Ordner samt Inhalt. */
export async function entferneEintragAn(pfad: number[]): Promise<void> {
  const baum = getBaum();
  const liste = elternListe(baum, pfad);
  const index = pfad[pfad.length - 1]!;
  if (!liste || index < 0 || index >= liste.length) return;
  liste.splice(index, 1);
  await saveConnections(baum);
}

/**
 * Verschiebt einen Eintrag in einen Ordner (leerer Zielpfad: in die Wurzel).
 * Ein Ordner darf nicht in sich selbst wandern.
 */
export async function verschiebeEintrag(quelle: number[], zielOrdner: number[]): Promise<boolean> {
  if (quelle.length === 0) return false;
  // Zielpfad liegt innerhalb der Quelle? Dann wuerde ein Ordner sein eigener
  // Nachfahre werden - der Baum haenge sich beim naechsten Durchlauf auf.
  if (zielOrdner.length >= quelle.length && quelle.every((wert, i) => zielOrdner[i] === wert)) return false;
  const baum = getBaum();
  const zielEintrag = zielOrdner.length === 0 ? undefined : eintragAn(baum, zielOrdner);
  if (zielOrdner.length > 0 && !istOrdner(zielEintrag)) return false;
  const quellListe = elternListe(baum, quelle);
  const quellIndex = quelle[quelle.length - 1]!;
  if (!quellListe || quellIndex < 0 || quellIndex >= quellListe.length) return false;
  const [eintrag] = quellListe.splice(quellIndex, 1);
  if (!eintrag) return false;
  const zielListe = istOrdner(zielEintrag) ? zielEintrag.children : baum;
  zielListe.push(eintrag);
  await saveConnections(baum);
  return true;
}

/**
 * Ersetzt die Verbindung an dieser Stelle der *flachen* Liste.
 *
 * Bleibt fuer Aufrufer erhalten, die noch mit Indizes arbeiten; der Index
 * bezieht sich auf `getConnections()`.
 */
export async function updateConnection(index: number, connection: RdpConnection): Promise<void> {
  const eintrag = alleVerbindungen()[index];
  if (!eintrag) return;
  await schreibeEintragAn(eintrag.pfad, connection);
}

/**
 * Entfernt genau den Eintrag an dieser Stelle der flachen Liste.
 *
 * Ueber den Namen zu vergleichen waere falsch: die Objekte aus
 * `getConnections()` sind frisch deserialisiert, die Identitaetspruefung
 * greift also nie, und der Namensvergleich allein loescht bei zwei gleich
 * benannten Verbindungen beide. Die Baumknoten fuehren ohnehin einen genauen
 * Pfad mit.
 */
export async function removeConnectionAt(index: number): Promise<void> {
  const eintrag = alleVerbindungen()[index];
  if (!eintrag) return;
  await entferneEintragAn(eintrag.pfad);
}

/** Schluessel im sicheren Speicher - Passwoerter gehoeren nie in settings.json. */
export function secretKey(connection: RdpConnection): string {
  const user = connection.domain ? `${connection.domain}\\${connection.username ?? ''}` : connection.username ?? '';
  return `rdp:${user}@${connection.host}:${connection.port ?? 3389}`;
}

// ------------------------------------------------------------ Baumansicht

export class ConnectionNode extends vscode.TreeItem {
  /** Die Verbindung, so wie sie gespeichert ist - zum Bearbeiten. */
  readonly connection: RdpConnection;
  /** Dieselbe Verbindung mit angewandter Ordnervererbung - zum Verbinden. */
  readonly aufgeloest: RdpConnection;
  readonly pfad: number[];
  readonly ordnerKette: RdpFolder[];

  constructor(eintrag: VerbindungsEintrag) {
    const verbindung = eintrag.verbindung;
    super(verbindung.name || verbindung.host, vscode.TreeItemCollapsibleState.None);
    this.connection = verbindung;
    this.pfad = eintrag.pfad;
    this.ordnerKette = eintrag.ordnerKette;
    this.aufgeloest = loeseVerbindungAuf(eintrag);

    const aufgeloest = this.aufgeloest;
    const user = aufgeloest.domain
      ? `${aufgeloest.domain}\\${aufgeloest.username ?? ''}`
      : aufgeloest.username ?? '';
    const tags = effektiveTags(verbindung, eintrag.ordnerKette);
    const basis = user ? `${user} · ${aufgeloest.host}` : aufgeloest.host;
    this.description = tags.length > 0 ? `${basis} · ${tags.map((t) => '#' + t).join(' ')}` : basis;
    const profil = aufgeloest.bandwidthProfile ? BANDBREITEN_PROFILE[aufgeloest.bandwidthProfile] : undefined;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${verbindung.name || verbindung.host}**`,
        '',
        `- Host: \`${aufgeloest.host}:${aufgeloest.port ?? 3389}\``,
        user ? `- Anmeldung: \`${user}\`` : '- Anmeldung: wird beim Verbinden abgefragt',
        aufgeloest.width && aufgeloest.height
          ? `- Auflösung: ${aufgeloest.width}×${aufgeloest.height}`
          : '- Auflösung: an Panelgröße angepasst',
        ...(eintrag.ordnerKette.length > 0
          ? [`- Ordner: ${eintrag.ordnerKette.map((o) => o.name).join(' / ')}`]
          : []),
        ...(profil ? [`- Bandbreite: ${profil.titel}`] : []),
        ...(tags.length > 0 ? [`- Tags: ${tags.join(', ')}`] : []),
      ].join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon('vm');
    this.contextValue = 'rdpConnection';
    this.command = {
      command: 'rdp.connectSaved',
      title: 'Verbinden',
      arguments: [this],
    };
  }

  /** Stelle in der flachen Liste - nur noch fuer altgediente Aufrufer. */
  get index(): number {
    const gesucht = this.pfad.join('.');
    return alleVerbindungen().findIndex((e) => e.pfad.join('.') === gesucht);
  }
}

export class FolderNode extends vscode.TreeItem {
  constructor(
    readonly ordner: RdpFolder,
    readonly pfad: number[],
    readonly ordnerKette: RdpFolder[],
    aufgeklappt = false,
  ) {
    super(
      ordner.name,
      aufgeklappt ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const geerbt = ordner.settings ?? {};
    const zeilen = VERERBBARE_SCHLUESSEL.filter((k) => geerbt[k] !== undefined).map((k) => `- ${k}: \`${geerbt[k]}\``);
    if (zeilen.length > 0) this.description = 'vererbt Einstellungen';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${ordner.name}**`,
        '',
        ...(zeilen.length > 0 ? ['Vererbte Einstellungen:', ...zeilen] : ['Ohne eigene Einstellungen']),
        ...(ordner.tags?.length ? [`- Tags: ${ordner.tags.join(', ')}`] : []),
      ].join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'rdpFolder';
  }
}

export type BaumKnoten = ConnectionNode | FolderNode;

export class ConnectionTreeProvider implements vscode.TreeDataProvider<BaumKnoten> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** Aktiver Suchfilter der Ansicht; leer bedeutet "alles zeigen". */
  private filter = '';

  refresh(): void {
    this._onDidChange.fire();
  }

  get suchfilter(): string {
    return this.filter;
  }

  setzeFilter(text: string): void {
    this.filter = text.trim();
    this.refresh();
  }

  getTreeItem(element: BaumKnoten): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BaumKnoten): BaumKnoten[] {
    if (element instanceof ConnectionNode) return [];
    const baum = getBaum();
    if (!element) return this.knotenFuer(baum, [], []);
    const knoten = element as FolderNode;
    return this.knotenFuer(knoten.ordner.children, knoten.pfad, [...knoten.ordnerKette, knoten.ordner]);
  }

  private knotenFuer(eintraege: RdpBaumEintrag[], pfad: number[], kette: RdpFolder[]): BaumKnoten[] {
    const knoten: BaumKnoten[] = [];
    eintraege.forEach((eintrag, index) => {
      const eigenerPfad = [...pfad, index];
      if (istOrdner(eintrag)) {
        // Bei aktivem Filter nur Ordner zeigen, in denen etwas uebrig bleibt -
        // sonst starrt der Benutzer auf leere Ordner.
        if (this.filter && !enthaeltTreffer(eintrag, [...kette, eintrag], this.filter)) return;
        knoten.push(new FolderNode(eintrag, eigenerPfad, kette, this.filter.length > 0));
        return;
      }
      const verbindungsEintrag: VerbindungsEintrag = { verbindung: eintrag, pfad: eigenerPfad, ordnerKette: kette };
      if (this.filter && !passtZuSuche(verbindungsEintrag, this.filter)) return;
      knoten.push(new ConnectionNode(verbindungsEintrag));
    });
    return knoten;
  }
}

/** Steckt im Ordner (oder tiefer) eine Verbindung, die zum Filter passt? */
function enthaeltTreffer(ordner: RdpFolder, kette: RdpFolder[], filter: string): boolean {
  for (const eintrag of ordner.children) {
    if (istOrdner(eintrag)) {
      if (enthaeltTreffer(eintrag, [...kette, eintrag], filter)) return true;
      continue;
    }
    if (passtZuSuche({ verbindung: eintrag, pfad: [], ordnerKette: kette }, filter)) return true;
  }
  return false;
}
