/**
 * Der VS-Code-Arbeitsbereich als umgeleitetes Laufwerk.
 *
 * Die Protokollarbeit steckt in `ts-rdp` (MS-RDPEFS, Kanal `rdpdr`); hier
 * haengt sie an den Ordnern des Arbeitsbereichs.
 *
 * Diese Datei kommt bewusst ohne `vscode` aus: sie arbeitet gegen die schmale
 * Schnittstelle `ArbeitsbereichZugriff`, die `session.ts` mit
 * `vscode.workspace.fs` und `vscode.workspace.workspaceFolders` fuellt. So
 * laesst sich das Verhalten ohne laufendes VS Code pruefen - und, viel
 * wichtiger, so kann hier gar kein `node:fs` hineinrutschen.
 *
 * Warum `workspace.fs` und niemals `node:fs`: die Extension laeuft unter
 * Remote-SSH auf dem entfernten Rechner (`extensionKind: ["workspace"]`). Die
 * Ordner des Arbeitsbereichs liegen dann dort, und ihre Pfade sind keine
 * lokalen Dateipfade. `workspace.fs` geht ueber den Dateisystemanbieter von VS
 * Code und trifft in beiden Faellen das Richtige; `node:fs` faende im
 * Remote-Fall zufaellig etwas und im lokalen Fall das Falsche.
 *
 * ------------------------------------------------------------------
 * Warum ein Laufwerk mit einem Ordner je Repository, nicht ein Laufwerk
 * je Repository:
 *
 *  1. Laufwerksbuchstaben sind knapp. Windows hat 26, davon sind C: und
 *     meistens noch ein paar weitere vergeben. Wer fuenf Repositories
 *     oeffnet, will nicht fuenf davon verbrauchen.
 *  2. Repositories kommen und gehen. Ein Ordner, der im Arbeitsbereich
 *     dazukommt, taucht bei der naechsten Verzeichnisabfrage einfach auf -
 *     ohne ein einziges Protokoll-PDU. Ein neues Laufwerk dagegen braucht
 *     eine Geraeteankuendigung, ein entferntes eine Abmeldung, und beides
 *     verschiebt im Explorer die Buchstaben der uebrigen.
 *  3. Pfade bleiben gueltig. Wird ein Repository umbenannt, aendert sich ein
 *     Ordnername - bei mehreren Laufwerken aendert sich ein Buchstabe, und
 *     jede gemerkte Verknuepfung im Explorer zeigt ins Leere.
 *
 * Der Preis ist eine Ebene mehr im Pfad. Das ist er wert.
 */
import {
  musterPasst,
  type DateiEintrag,
  type RdpdrDateisystem,
  type RdpdrLaufwerk,
} from 'ts-rdp';

// ------------------------------------------------------------ Einstellungen

/** Schluessel der Einstellungen unterhalb von `rdp.`. */
export const LAUFWERK_EINSTELLUNGEN = {
  aktiv: 'driveRedirection.enabled',
  zugriff: 'driveRedirection.access',
  ausschluss: 'driveRedirection.exclude',
  laufwerksname: 'driveRedirection.driveName',
  maxDateigroesseMb: 'driveRedirection.maxFileSizeMb',
} as const;

/** Werte der Einstellung `rdp.driveRedirection.access`. */
export type ZugriffsArt = 'readOnly' | 'readWrite';

/**
 * Vorgaben fuer den Ausschluss.
 *
 * Die Auswahl folgt einer einfachen Frage: was faende ein Angreifer auf dem
 * Server, wenn er sich durch den Arbeitsbereich liest?
 *
 *  - `.git` enthaelt die gesamte Geschichte, auch geloeschte Zugangsdaten,
 *    und in `.git/config` stehen haeufig Zugriffstoken in den Fernzweigen.
 *  - `node_modules` ist gross und uninteressant; mitgeschickt kostet es nur
 *    Zeit, und Postinstall-Skripte darin gehoeren erst recht niemandem.
 *  - `.env` und seine Verwandten sind der uebliche Ort fuer Geheimnisse.
 *  - Schluesseldateien (`*.pem`, `*.key`, `*.pfx`, `*.p12`) sowie `.ssh`,
 *    `.aws`, `.npmrc` und `.netrc` tragen Anmeldedaten.
 *
 * Die Liste ist eine Einstellung, kein Gesetz - wer `.git` braucht, kann sie
 * streichen. Die Vorgabe soll aber die vorsichtige sein.
 */
export const AUSSCHLUSS_VORGABEN: readonly string[] = [
  '.git',
  'node_modules',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '.ssh',
  '.aws',
  '.npmrc',
  '.netrc',
];

/** Standardwerte - identisch mit den Vorgaben in package.json. */
export const LAUFWERK_VORGABEN = {
  aktiv: true,
  /**
   * Nur lesen. Der Server bekommt Quelltext zu sehen; das Schreibrecht dazu
   * muss ausdruecklich erteilt werden, nicht stillschweigend mitgeliefert.
   */
  zugriff: 'readOnly' as ZugriffsArt,
  ausschluss: AUSSCHLUSS_VORGABEN,
  laufwerksname: 'VS Code',
  /**
   * `workspace.fs.readFile` liest immer die ganze Datei in den Speicher - es
   * gibt keine Teilabfrage. Eine Obergrenze ist deshalb kein Schikane,
   * sondern der Schutz des Extension-Hosts vor einem Server, der die
   * 3-Gigabyte-Datei im Repository anfragt.
   */
  maxDateigroesseMb: 64,
};

export interface LaufwerkEinstellungen {
  aktiv: boolean;
  zugriff: ZugriffsArt;
  nurLesen: boolean;
  ausschluss: readonly string[];
  laufwerksname: string;
  /** Obergrenze in Byte, aus `maxFileSizeMb` gerechnet. */
  maxDateigroesse: number;
}

/** Die Einstellungen aus einer beliebigen Konfigurationsquelle lesen. */
export function leseEinstellungen(
  hole: <T>(schluessel: string, vorgabe: T) => T,
): LaufwerkEinstellungen {
  const aktiv = hole(LAUFWERK_EINSTELLUNGEN.aktiv, LAUFWERK_VORGABEN.aktiv) !== false;
  const rohZugriff = hole<string>(LAUFWERK_EINSTELLUNGEN.zugriff, LAUFWERK_VORGABEN.zugriff);
  // Ein unbekannter Wert (von Hand in die settings.json geschrieben) darf
  // niemals mehr erlauben als die Vorgabe.
  const zugriff: ZugriffsArt = rohZugriff === 'readWrite' ? 'readWrite' : 'readOnly';

  const rohAusschluss = hole<unknown>(LAUFWERK_EINSTELLUNGEN.ausschluss, LAUFWERK_VORGABEN.ausschluss);
  const ausschluss = Array.isArray(rohAusschluss)
    ? rohAusschluss.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [...LAUFWERK_VORGABEN.ausschluss];

  const rohName = hole<string>(LAUFWERK_EINSTELLUNGEN.laufwerksname, LAUFWERK_VORGABEN.laufwerksname);
  const laufwerksname = typeof rohName === 'string' && rohName.trim() !== '' ? rohName.trim() : LAUFWERK_VORGABEN.laufwerksname;

  const rohMb = hole<number>(LAUFWERK_EINSTELLUNGEN.maxDateigroesseMb, LAUFWERK_VORGABEN.maxDateigroesseMb);
  const mb = typeof rohMb === 'number' && Number.isFinite(rohMb) && rohMb > 0 ? rohMb : LAUFWERK_VORGABEN.maxDateigroesseMb;

  return {
    aktiv,
    zugriff,
    nurLesen: zugriff !== 'readWrite',
    ausschluss,
    laufwerksname,
    maxDateigroesse: Math.floor(mb * 1024 * 1024),
  };
}

// ---------------------------------------------------------------- Ausschluss

/**
 * Eine Pruefung, ob ein Pfad ausgeschlossen ist.
 *
 * Ein Muster ohne Schraegstrich wird gegen *jedes* Segment geprueft: `.git`
 * schliesst damit auch `repo/src/.git` aus, nicht nur das oberste. Ein Muster
 * mit Schraegstrich wird gegen den ganzen relativen Pfad geprueft, so dass
 * sich `doku/geheim` gezielt ausschliessen laesst.
 *
 * Der Vergleich achtet nicht auf Gross- und Kleinschreibung. Unter Windows
 * waere `.GIT` derselbe Ordner, und ein Ausschluss, den man durch
 * Grossschreibung umgeht, ist keiner.
 */
export function baueAusschluss(muster: readonly string[]): (segmente: readonly string[]) => boolean {
  const proSegment: ((name: string) => boolean)[] = [];
  const proPfad: ((pfad: string) => boolean)[] = [];
  for (const m of muster) {
    // Rueckstriche wie Schraegstriche behandeln und ein fuehrendes "./"
    // wegnehmen - beides schreibt man beim Konfigurieren leicht hin.
    const wert = m.replace(/\\/g, '/').replace(/^\.\//, '');
    if (wert === '') continue;
    if (wert.includes('/')) {
      proPfad.push(musterPasst(wert));
    } else {
      proSegment.push(musterPasst(wert));
    }
  }
  return (segmente: readonly string[]): boolean => {
    for (const segment of segmente) {
      for (const passt of proSegment) {
        if (passt(segment)) return true;
      }
    }
    const pfad = segmente.join('/');
    for (const passt of proPfad) {
      if (passt(pfad)) return true;
    }
    return false;
  };
}

// -------------------------------------------------------------- Ordnernamen

/**
 * Zeichen, die Windows in Dateinamen nicht zulaesst.
 *
 * Ein Ordner des Arbeitsbereichs kann sie tragen (unter Linux ist ein ":" im
 * Namen erlaubt), und ein Explorer, der einen solchen Namen bekommt, zeigt
 * den Eintrag entweder gar nicht oder kann ihn nicht oeffnen.
 */
const UNTER_WINDOWS_VERBOTEN = /[\\/:*?"<>|]/g;

/**
 * Aus den Ordnern des Arbeitsbereichs eindeutige, windowstaugliche Namen
 * machen.
 *
 * Zwei Repositories koennen denselben Basisnamen haben ("app" in zwei
 * Organisationen ist der Normalfall). Der zweite bekommt dann " (2)". Die
 * Reihenfolge ist die des Arbeitsbereichs, damit die Zuordnung stabil bleibt,
 * solange sich nichts aendert.
 */
export function eindeutigeOrdnernamen(namen: readonly string[]): string[] {
  const ergebnis: string[] = [];
  const vergeben = new Map<string, number>();
  for (const roh of namen) {
    let name = roh.replace(UNTER_WINDOWS_VERBOTEN, '_').replace(/[.\s]+$/, '').trim();
    if (name === '') name = 'Ordner';
    const schluessel = name.toLowerCase();
    const bisher = vergeben.get(schluessel);
    if (bisher === undefined) {
      vergeben.set(schluessel, 1);
      ergebnis.push(name);
      continue;
    }
    let zaehler = bisher + 1;
    let kandidat = `${name} (${zaehler})`;
    while (vergeben.has(kandidat.toLowerCase())) {
      zaehler++;
      kandidat = `${name} (${zaehler})`;
    }
    vergeben.set(schluessel, zaehler);
    vergeben.set(kandidat.toLowerCase(), 1);
    ergebnis.push(kandidat);
  }
  return ergebnis;
}

// ------------------------------------------------------------ Zugriffsschicht

/** Art eines Eintrags, wie `vscode.FileType` sie kennt. */
export type EintragsArt = 'datei' | 'verzeichnis' | 'anderes';

export interface DateiAngabe {
  art: EintragsArt;
  /** Groesse in Byte. */
  groesse: number;
  /** Millisekunden seit der Unix-Epoche, oder 0. */
  erstellt: number;
  geaendert: number;
}

/**
 * Der schmale Ausschnitt aus `vscode.workspace`, den dieses Modul braucht.
 *
 * Alle Methoden bekommen den Index eines Arbeitsbereichsordners und die
 * bereits geprueften Pfadsegmente darunter - niemals eine zusammengesetzte
 * Zeichenkette. Das Zusammensetzen bleibt in `session.ts` und laeuft dort
 * ueber `vscode.Uri.joinPath`, also ueber die einzige API, die dabei auch
 * entfernte Schemata richtig behandelt.
 */
export interface ArbeitsbereichZugriff {
  /** Anzeigenamen der Ordner, in der Reihenfolge des Arbeitsbereichs. */
  ordnernamen(): readonly string[];
  stat(ordner: number, segmente: readonly string[]): Promise<DateiAngabe | undefined>;
  liste(ordner: number, segmente: readonly string[]): Promise<Array<{ name: string; art: EintragsArt }>>;
  liesDatei(ordner: number, segmente: readonly string[]): Promise<Uint8Array>;
  schreibeDatei(ordner: number, segmente: readonly string[], daten: Uint8Array): Promise<void>;
  erzeugeVerzeichnis(ordner: number, segmente: readonly string[]): Promise<void>;
  loesche(ordner: number, segmente: readonly string[], rekursiv: boolean): Promise<void>;
  benenneUm(
    ordner: number,
    von: readonly string[],
    nachOrdner: number,
    nach: readonly string[],
    ueberschreiben: boolean,
  ): Promise<void>;
}

// ------------------------------------------------------------- Dateisystem

/** Ein aufgeloester Pfad: welcher Ordner, und was darunter. */
interface Aufgeloest {
  /** -1 heisst: die Wurzel des Laufwerks selbst. */
  ordner: number;
  segmente: string[];
}

export interface ArbeitsbereichDateisystemOptionen {
  zugriff: ArbeitsbereichZugriff;
  einstellungen: LaufwerkEinstellungen;
  log?(nachricht: string): void;
}

/**
 * Der Arbeitsbereich als Dateisystem fuer die RDPDR-Sitzung.
 *
 * Die Wurzel ist kuenstlich: sie enthaelt je Ordner des Arbeitsbereichs ein
 * Verzeichnis. Darunter geht es in den echten Ordner.
 *
 * Ausgeschlossene Pfade gibt es aus Sicht des Servers schlicht nicht: sie
 * fehlen in der Auflistung, und `stat` liefert `undefined`. Das ist staerker
 * als eine Zugriffsverweigerung - wer nur "kein Zutritt" meldet, verraet
 * immer noch, dass es die Datei gibt.
 */
export class ArbeitsbereichDateisystem implements RdpdrDateisystem {
  private readonly istAusgeschlossen: (segmente: readonly string[]) => boolean;
  /**
   * Zwischenspeicher fuer die zuletzt gelesene Datei.
   *
   * `workspace.fs.readFile` kennt keine Teilabfrage - jeder Leseaufruf holt
   * die ganze Datei. Der Explorer liest aber in Bloecken von 64 KiB. Ohne
   * diesen Zwischenspeicher wuerde eine 10-MiB-Datei 160-mal vollstaendig
   * uebertragen.
   */
  private letzteDatei?: { schluessel: string; inhalt: Buffer; zeit: number };

  constructor(private readonly opts: ArbeitsbereichDateisystemOptionen) {
    this.istAusgeschlossen = baueAusschluss(opts.einstellungen.ausschluss);
  }

  private protokoll(nachricht: string): void {
    this.opts.log?.(nachricht);
  }

  /** Anzeigenamen der Ordner, dedupliziert und windowstauglich. */
  private namen(): string[] {
    return eindeutigeOrdnernamen(this.opts.zugriff.ordnernamen());
  }

  /**
   * Einen Pfad des Laufwerks auf einen Arbeitsbereichsordner abbilden.
   *
   * Liefert `undefined`, wenn das erste Segment keinem Ordner entspricht oder
   * der Pfad ausgeschlossen ist. Die zweite Pruefung auf ".." ist Absicht: die
   * Protokollschicht hat sie schon gemacht, aber diese Klasse haelt den
   * Schluessel zum Dateisystem, und eine zweite Pruefung an der Tuer kostet
   * nichts.
   */
  private aufloesen(pfad: string): Aufgeloest | undefined {
    const roh = pfad.split('/').filter((s) => s !== '');
    for (const segment of roh) {
      if (segment === '.' || segment === '..' || segment.includes('\0') || segment.includes('\\')) {
        this.protokoll(`Laufwerk: Pfad "${pfad}" abgewiesen - unerlaubtes Segment "${segment}"`);
        return undefined;
      }
    }
    if (roh.length === 0) return { ordner: -1, segmente: [] };

    const namen = this.namen();
    // Windows vergleicht Dateinamen ohne Ruecksicht auf Gross- und
    // Kleinschreibung, und der Explorer schickt sie zurueck, wie der Benutzer
    // sie getippt hat.
    const index = namen.findIndex((n) => n.toLowerCase() === roh[0].toLowerCase());
    if (index < 0) return undefined;

    const segmente = roh.slice(1);
    if (segmente.length > 0 && this.istAusgeschlossen(segmente)) return undefined;
    return { ordner: index, segmente };
  }

  /** Aus einer Angabe von `workspace.fs` einen Verzeichniseintrag machen. */
  private eintrag(name: string, angabe: DateiAngabe): DateiEintrag {
    return {
      name,
      istVerzeichnis: angabe.art === 'verzeichnis',
      groesse: angabe.art === 'verzeichnis' ? 0 : angabe.groesse,
      erstellt: angabe.erstellt || angabe.geaendert,
      geaendert: angabe.geaendert,
      zugegriffen: angabe.geaendert,
      nurLesen: this.opts.einstellungen.nurLesen,
      // Unter Unix beginnen versteckte Dateien mit einem Punkt. Windows kennt
      // dafuer ein Attribut - so sieht ".gitignore" im Explorer aus wie das,
      // was es ist, ohne dass es verschwindet.
      versteckt: name.startsWith('.'),
    };
  }

  async stat(pfad: string): Promise<DateiEintrag | undefined> {
    const ziel = this.aufloesen(pfad);
    if (!ziel) return undefined;
    if (ziel.ordner < 0) {
      return { name: this.opts.einstellungen.laufwerksname, istVerzeichnis: true, groesse: 0 };
    }
    const name = ziel.segmente[ziel.segmente.length - 1] ?? this.namen()[ziel.ordner];
    try {
      const angabe = await this.opts.zugriff.stat(ziel.ordner, ziel.segmente);
      if (!angabe) return undefined;
      return this.eintrag(name, angabe);
    } catch {
      // `workspace.fs.stat` wirft bei fehlenden Dateien. Das ist hier kein
      // Fehler, sondern die Antwort - der Explorer fragt bei jedem
      // Verzeichniswechsel nach desktop.ini und Thumbs.db.
      return undefined;
    }
  }

  async liste(pfad: string): Promise<DateiEintrag[]> {
    const ziel = this.aufloesen(pfad);
    if (!ziel) return [];

    // Die Wurzel ist kuenstlich: sie zeigt die Ordner des Arbeitsbereichs.
    if (ziel.ordner < 0) {
      const namen = this.namen();
      const eintraege: DateiEintrag[] = [];
      for (let i = 0; i < namen.length; i++) {
        let geaendert = 0;
        try {
          geaendert = (await this.opts.zugriff.stat(i, []))?.geaendert ?? 0;
        } catch {
          // Ein Ordner, der gerade nicht erreichbar ist (abgehaengtes
          // Netzlaufwerk), soll trotzdem erscheinen - nur eben ohne Datum.
        }
        eintraege.push({
          name: namen[i],
          istVerzeichnis: true,
          groesse: 0,
          erstellt: geaendert,
          geaendert,
          zugegriffen: geaendert,
          nurLesen: this.opts.einstellungen.nurLesen,
        });
      }
      return eintraege;
    }

    let roh: Array<{ name: string; art: EintragsArt }>;
    try {
      roh = await this.opts.zugriff.liste(ziel.ordner, ziel.segmente);
    } catch (err) {
      this.protokoll(`Laufwerk: "${pfad}" konnte nicht gelesen werden - ${(err as Error).message}`);
      return [];
    }

    const eintraege: DateiEintrag[] = [];
    for (const { name, art } of roh) {
      if (this.istAusgeschlossen([...ziel.segmente, name])) continue;
      let angabe: DateiAngabe | undefined;
      try {
        angabe = await this.opts.zugriff.stat(ziel.ordner, [...ziel.segmente, name]);
      } catch {
        angabe = undefined;
      }
      eintraege.push(
        this.eintrag(name, angabe ?? { art, groesse: 0, erstellt: 0, geaendert: 0 }),
      );
    }
    return eintraege;
  }

  /**
   * Einen Ausschnitt aus einer Datei lesen.
   *
   * Der Umweg ueber die ganze Datei ist nicht zu vermeiden: `workspace.fs`
   * bietet keine Teilabfrage. Deshalb der Zwischenspeicher, deshalb die
   * Groessengrenze.
   */
  async lies(pfad: string, offset: number, laenge: number): Promise<Buffer> {
    const ziel = this.aufloesen(pfad);
    if (!ziel || ziel.ordner < 0) return Buffer.alloc(0);

    const schluessel = `${ziel.ordner}:${ziel.segmente.join('/')}`;
    const zwischengespeichert = this.letzteDatei;
    if (zwischengespeichert && zwischengespeichert.schluessel === schluessel) {
      return zwischengespeichert.inhalt.subarray(offset, offset + laenge);
    }

    const angabe = await this.opts.zugriff.stat(ziel.ordner, ziel.segmente);
    if (angabe && angabe.groesse > this.opts.einstellungen.maxDateigroesse) {
      const mb = Math.round(this.opts.einstellungen.maxDateigroesse / (1024 * 1024));
      this.protokoll(
        `Laufwerk: "${pfad}" ist ${Math.round(angabe.groesse / (1024 * 1024))} MB gross und ` +
          `ueberschreitet die Grenze von ${mb} MB - nicht gelesen`,
      );
      throw new Error(`Datei groesser als ${mb} MB`);
    }

    const roh = await this.opts.zugriff.liesDatei(ziel.ordner, ziel.segmente);
    const inhalt = Buffer.from(roh.buffer, roh.byteOffset, roh.byteLength);
    this.letzteDatei = { schluessel, inhalt, zeit: Date.now() };
    return inhalt.subarray(offset, offset + laenge);
  }

  /** Den Zwischenspeicher verwerfen - nach jeder Aenderung. */
  private vergiss(): void {
    this.letzteDatei = undefined;
  }

  // ------------------------------------------------------------ Schreiben

  /**
   * Bytes in eine Datei schreiben.
   *
   * Auch hier der Umweg ueber die ganze Datei: `workspace.fs.writeFile`
   * ersetzt sie vollstaendig. Fuer eine Datei im Arbeitsbereich ist das
   * tragbar; fuer ein Archiv von mehreren Gigabyte waere es das nicht -
   * deshalb gilt die Groessengrenze in beide Richtungen.
   */
  async schreibe(pfad: string, offset: number, daten: Buffer): Promise<number> {
    const ziel = this.aufloesen(pfad);
    if (!ziel || ziel.ordner < 0) throw new Error(`Pfad "${pfad}" ist nicht beschreibbar`);
    const alt = await this.inhaltOder(ziel, Buffer.alloc(0));
    const neueGroesse = Math.max(alt.length, offset + daten.length);
    if (neueGroesse > this.opts.einstellungen.maxDateigroesse) {
      const mb = Math.round(this.opts.einstellungen.maxDateigroesse / (1024 * 1024));
      throw new Error(`Datei wuerde die Grenze von ${mb} MB ueberschreiten`);
    }
    const neu = Buffer.alloc(neueGroesse);
    alt.copy(neu, 0);
    daten.copy(neu, offset);
    await this.opts.zugriff.schreibeDatei(ziel.ordner, ziel.segmente, neu);
    this.vergiss();
    return daten.length;
  }

  async erzeuge(pfad: string, istVerzeichnis: boolean): Promise<void> {
    const ziel = this.aufloesen(pfad);
    if (!ziel || ziel.ordner < 0 || ziel.segmente.length === 0) {
      // Ein neuer Ordner unmittelbar in der Wurzel waere ein neuer
      // Arbeitsbereichsordner - das entscheidet der Benutzer in VS Code,
      // nicht der Server.
      throw new Error(`"${pfad}" kann nicht angelegt werden`);
    }
    if (istVerzeichnis) {
      await this.opts.zugriff.erzeugeVerzeichnis(ziel.ordner, ziel.segmente);
    } else {
      await this.opts.zugriff.schreibeDatei(ziel.ordner, ziel.segmente, new Uint8Array(0));
    }
    this.vergiss();
  }

  async loesche(pfad: string): Promise<void> {
    const ziel = this.aufloesen(pfad);
    if (!ziel || ziel.ordner < 0 || ziel.segmente.length === 0) {
      throw new Error(`"${pfad}" kann nicht geloescht werden`);
    }
    // Nicht rekursiv: ein nicht leeres Verzeichnis soll scheitern. Windows
    // loescht Verzeichnisse von innen nach aussen, und ein rekursives Loeschen
    // hier wuerde aus einem irrtuemlich geloeschten Ordner im Explorer einen
    // ganzen verlorenen Teilbaum machen.
    await this.opts.zugriff.loesche(ziel.ordner, ziel.segmente, false);
    this.vergiss();
  }

  async benenneUm(von: string, nach: string, ersetzen: boolean): Promise<void> {
    const quelle = this.aufloesen(von);
    const ziel = this.aufloesen(nach);
    if (!quelle || quelle.ordner < 0 || quelle.segmente.length === 0) {
      throw new Error(`"${von}" kann nicht umbenannt werden`);
    }
    if (!ziel || ziel.ordner < 0 || ziel.segmente.length === 0) {
      // Auch hier: das Ziel darf kein Arbeitsbereichsordner und nicht die
      // Wurzel sein, und ein ausgeschlossenes Ziel loest gar nicht erst auf.
      throw new Error(`"${nach}" ist kein erlaubtes Ziel`);
    }
    await this.opts.zugriff.benenneUm(quelle.ordner, quelle.segmente, ziel.ordner, ziel.segmente, ersetzen);
    this.vergiss();
  }

  async kuerze(pfad: string, laenge: number): Promise<void> {
    const ziel = this.aufloesen(pfad);
    if (!ziel || ziel.ordner < 0 || ziel.segmente.length === 0) {
      throw new Error(`"${pfad}" kann nicht gekuerzt werden`);
    }
    if (laenge > this.opts.einstellungen.maxDateigroesse) {
      const mb = Math.round(this.opts.einstellungen.maxDateigroesse / (1024 * 1024));
      throw new Error(`Datei wuerde die Grenze von ${mb} MB ueberschreiten`);
    }
    const alt = await this.inhaltOder(ziel, Buffer.alloc(0));
    const neu = Buffer.alloc(laenge);
    alt.copy(neu, 0, 0, Math.min(alt.length, laenge));
    await this.opts.zugriff.schreibeDatei(ziel.ordner, ziel.segmente, neu);
    this.vergiss();
  }

  /** Inhalt einer Datei, oder der Ersatzwert, wenn es sie noch nicht gibt. */
  private async inhaltOder(ziel: Aufgeloest, ersatz: Buffer): Promise<Buffer> {
    try {
      const roh = await this.opts.zugriff.liesDatei(ziel.ordner, ziel.segmente);
      return Buffer.from(roh.buffer, roh.byteOffset, roh.byteLength);
    } catch {
      return ersatz;
    }
  }
}

/**
 * Das Dateisystem so zuschneiden, wie die Sitzung es sehen soll.
 *
 * Im Nur-Lesen-Betrieb fehlen die Schreibmethoden ganz. Die Sitzung prueft
 * ihre eigene Einstellung ohnehin, aber sie prueft auch, ob die Methode da
 * ist - und ein Objekt, das gar nicht schreiben *kann*, ist eine haertere
 * Zusage als eine Einstellung, die irgendwo falsch gelesen werden koennte.
 */
export function alsRdpdrDateisystem(
  dateisystem: ArbeitsbereichDateisystem,
  nurLesen: boolean,
): RdpdrDateisystem {
  const lesend: RdpdrDateisystem = {
    stat: (p) => dateisystem.stat(p),
    liste: (p) => dateisystem.liste(p),
    lies: (p, o, l) => dateisystem.lies(p, o, l),
  };
  if (nurLesen) return lesend;
  return {
    ...lesend,
    schreibe: (p, o, d) => dateisystem.schreibe(p, o, d),
    erzeuge: (p, v) => dateisystem.erzeuge(p, v),
    loesche: (p) => dateisystem.loesche(p),
    benenneUm: (v, n, e) => dateisystem.benenneUm(v, n, e),
    kuerze: (p, l) => dateisystem.kuerze(p, l),
  };
}

/**
 * Das eine Laufwerk bauen, das dem Server angekuendigt wird.
 *
 * `deviceId` ist frei waehlbar, muss aber je Sitzung eindeutig sein; 1 ist
 * genau richtig, weil wir nur ein Geraet anmelden.
 */
export function baueLaufwerk(opts: {
  zugriff: ArbeitsbereichZugriff;
  einstellungen: LaufwerkEinstellungen;
  deviceId?: number;
  log?(nachricht: string): void;
}): RdpdrLaufwerk {
  const dateisystem = new ArbeitsbereichDateisystem({
    zugriff: opts.zugriff,
    einstellungen: opts.einstellungen,
    log: opts.log,
  });
  return {
    deviceId: opts.deviceId ?? 1,
    name: opts.einstellungen.laufwerksname,
    dateisystem: alsRdpdrDateisystem(dateisystem, opts.einstellungen.nurLesen),
    volumen: { bezeichnung: opts.einstellungen.laufwerksname, nurLesen: opts.einstellungen.nurLesen },
  };
}
