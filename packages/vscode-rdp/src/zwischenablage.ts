/**
 * Zwischenablage zwischen VS Code und der RDP-Sitzung.
 *
 * Die Protokollarbeit steckt in `ts-rdp` (MS-RDPECLIP, Kanal `cliprdr`); hier
 * haengt sie an der Zwischenablage von VS Code und an dem Textfeld im Webview,
 * das einspringt, wenn der direkte Weg nicht funktioniert.
 *
 * Diese Datei kommt bewusst ohne `vscode` aus: sie arbeitet gegen die schmale
 * Schnittstelle `ZwischenablageSpeicher`, die `session.ts` mit
 * `vscode.env.clipboard` fuellt. So laesst sich das Verhalten ohne laufendes
 * VS Code pruefen.
 *
 * Warum ueberhaupt ein Textfeld? Der direkte Weg kann aus mehreren Gruenden
 * ausfallen: `vscode.env.clipboard` wirft in manchen Remote- und Web-Umgebungen,
 * und im Webview selbst verliert die Async Clipboard API des Browsers die
 * Benutzergeste. noVNC, Guacamole und Kasm haben unabhaengig voneinander
 * dieselbe Loesung gebaut - ein Feld, durch das der Text von Hand geht.
 */
import {
  CliprdrSession,
  STANDARD_MAX_BYTES,
  type CliprdrLogStufe,
  type ZwischenablageRichtung,
} from 'ts-rdp';

/** Schluessel der Einstellungen unterhalb von `rdp.`. */
export const ZWISCHENABLAGE_EINSTELLUNGEN = {
  aktiv: 'clipboard.enabled',
  richtung: 'clipboard.direction',
  maxKilobyte: 'clipboard.maxSizeKb',
  abfrageIntervall: 'clipboard.pollIntervalMs',
} as const;

/** Standardwerte - identisch mit den Vorgaben in package.json. */
export const ZWISCHENABLAGE_VORGABEN = {
  aktiv: true,
  richtung: 'both' as EinstellungRichtung,
  maxKilobyte: 1024,
  abfrageIntervallMs: 750,
};

/** Werte der Einstellung `rdp.clipboard.direction`. */
export type EinstellungRichtung = 'both' | 'remoteToLocal' | 'localToRemote';

/**
 * Einstellungswert in die Richtung der Protokollschicht uebersetzen.
 *
 * "Lesen" ist aus Sicht des Anwenders das, was vom entfernten Rechner kommt;
 * "Schreiben" das, was dorthin geht.
 */
export function richtungAusEinstellung(wert: string | undefined, aktiv: boolean): ZwischenablageRichtung {
  if (!aktiv) return 'aus';
  switch (wert) {
    case 'remoteToLocal':
      return 'nurLesen';
    case 'localToRemote':
      return 'nurSchreiben';
    case 'both':
      return 'beide';
    default:
      // Ein unbekannter Wert (von Hand in die settings.json geschrieben) darf
      // nicht stillschweigend mehr erlauben als die Vorgabe.
      return 'beide';
  }
}

export interface ZwischenablageEinstellungen {
  aktiv: boolean;
  richtung: ZwischenablageRichtung;
  /** Obergrenze in Byte, aus `maxSizeKb` gerechnet. */
  maxBytes: number;
  /** 0 schaltet die regelmaessige Abfrage ab; dann hilft nur das Textfeld. */
  abfrageIntervallMs: number;
}

/** Die vier Einstellungen aus einer beliebigen Konfigurationsquelle lesen. */
export function leseEinstellungen(
  hole: <T>(schluessel: string, vorgabe: T) => T,
): ZwischenablageEinstellungen {
  const aktiv = hole(ZWISCHENABLAGE_EINSTELLUNGEN.aktiv, ZWISCHENABLAGE_VORGABEN.aktiv) !== false;
  const kilobyte = hole(ZWISCHENABLAGE_EINSTELLUNGEN.maxKilobyte, ZWISCHENABLAGE_VORGABEN.maxKilobyte);
  const intervall = hole(
    ZWISCHENABLAGE_EINSTELLUNGEN.abfrageIntervall,
    ZWISCHENABLAGE_VORGABEN.abfrageIntervallMs,
  );
  return {
    aktiv,
    richtung: richtungAusEinstellung(
      hole(ZWISCHENABLAGE_EINSTELLUNGEN.richtung, ZWISCHENABLAGE_VORGABEN.richtung),
      aktiv,
    ),
    maxBytes: begrenzeGroesse(kilobyte),
    // Zu haeufiges Abfragen kostet spuerbar; unter 100 ms geht es nicht.
    abfrageIntervallMs:
      typeof intervall === 'number' && Number.isFinite(intervall) && intervall > 0
        ? Math.max(100, Math.floor(intervall))
        : 0,
  };
}

/**
 * Kilobyte in Byte, mit Vernunftgrenzen.
 *
 * Nach unten 1 KiB: darunter passt kein sinnvoller Text mehr. Nach oben
 * 64 MiB, weil die Zusammensetzung der Kanalbloecke in `ts-rdp` bei 16 MiB
 * ohnehin abriegelt - die Einstellung soll die Grenze senken duerfen, aber
 * nicht ins Unermessliche heben.
 */
export function begrenzeGroesse(kilobyte: unknown): number {
  if (typeof kilobyte !== 'number' || !Number.isFinite(kilobyte) || kilobyte <= 0) {
    return STANDARD_MAX_BYTES;
  }
  const bytes = Math.floor(kilobyte) * 1024;
  return Math.min(Math.max(bytes, 1024), 64 * 1024 * 1024);
}

/** Was die Bruecke braucht, um an eine Zwischenablage zu kommen. */
export interface ZwischenablageSpeicher {
  lesen(): Promise<string>;
  schreiben(text: string): Promise<void>;
}

/** Nachricht an das Webview: Text fuers Rueckfallfeld. */
export interface ZwischenablageWebviewNachricht {
  type: 'clipboardText';
  text: string;
  /**
   * `true`, wenn der direkte Weg gescheitert ist. Dann blendet das Webview das
   * Feld von sich aus ein - der Text ginge sonst verloren.
   */
  fallback: boolean;
}

export interface BrueckeOptions {
  einstellungen: ZwischenablageEinstellungen;
  /** Fertige CLIPRDR-Nachricht auf den Kanal geben. */
  send(daten: Buffer): void;
  /** Zugriff auf die Zwischenablage des Editors. */
  speicher: ZwischenablageSpeicher;
  /** Nachricht an das Webview (Rueckfallfeld). */
  anWebview(nachricht: ZwischenablageWebviewNachricht): void;
  /** Stufe fehlt = `info`, damit bestehende Aufrufer unveraendert bleiben. */
  log(nachricht: string, stufe?: CliprdrLogStufe): void;
  /**
   * Wartezeit, nach der eine unbeantwortete Formatliste gemeldet wird.
   * Nur fuer die Tests da; ohne Angabe gilt `STILLE_WARNZEIT_MS`.
   */
  warnzeitMs?: number;
}

/**
 * Wie lange auf CB_FORMAT_LIST_RESPONSE gewartet wird, bevor es im Protokoll
 * steht.
 *
 * Fuenf Sekunden sind grosszuegig: Windows antwortet im selben Atemzug. Wer
 * laenger braucht, antwortet gar nicht mehr - und genau das ist die Auskunft,
 * die im Fehlerfall fehlt.
 */
export const STILLE_WARNZEIT_MS = 5000;

/**
 * Bindeglied zwischen der CLIPRDR-Zustandsmaschine und der Umgebung.
 *
 * Zwei Wege fuehren hinein:
 *  - `verarbeite()` fuer alles, was vom Kanal kommt,
 *  - `pruefeLokal()` bzw. `starteAbfrage()` fuer Aenderungen an der lokalen
 *    Zwischenablage. VS Code meldet solche Aenderungen nicht von sich aus, es
 *    bleibt nur regelmaessiges Nachsehen.
 *
 * Und zwei hinaus: `speicher.schreiben()` fuer den Normalfall und
 * `anWebview()` fuer die Rueckfallebene.
 */
export class Zwischenablagebruecke {
  private readonly sitzung: CliprdrSession;
  /** Zuletzt gesehener Inhalt der lokalen Zwischenablage. */
  private lokalerText: string | undefined;
  private abfrage: ReturnType<typeof setInterval> | undefined;
  private laeuftAbfrage = false;
  private beendet = false;
  /** Laeuft, solange eine gesendete Formatliste unbeantwortet ist. */
  private stilleUhr: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: BrueckeOptions) {
    this.sitzung = new CliprdrSession({
      send: (daten) => {
        if (this.beendet) return;
        this.opts.send(daten);
        this.stelleStilleUhr();
      },
      richtung: opts.einstellungen.richtung,
      maxBytes: opts.einstellungen.maxBytes,
      leseLokalenText: () => this.lokalerText,
      onServerText: (text) => void this.uebernimmVomServer(text),
      log: (n, stufe) => this.opts.log(n, stufe),
    });
  }

  private get warnzeitMs(): number {
    return this.opts.warnzeitMs ?? STILLE_WARNZEIT_MS;
  }

  /**
   * Uhr fuer eine unbeantwortete Formatliste stellen bzw. wieder abstellen.
   *
   * Die Zustandsmaschine selbst kennt keine Zeit - sie kann nur sagen, ob sie
   * noch wartet. Gewartet wird hier, weil hier ohnehin schon Zeitgeber laufen.
   */
  private stelleStilleUhr(): void {
    if (this.sitzung.wartetAufFormatlistenAntwort) {
      if (this.stilleUhr || this.beendet) return;
      this.stilleUhr = setTimeout(() => {
        this.stilleUhr = undefined;
        this.sitzung.meldeAusbleibendeAntwort(this.warnzeitMs);
      }, this.warnzeitMs);
      this.stilleUhr.unref?.();
      return;
    }
    if (!this.stilleUhr) return;
    clearTimeout(this.stilleUhr);
    this.stilleUhr = undefined;
  }

  get istBereit(): boolean {
    return this.sitzung.istBereit;
  }

  get richtung(): ZwischenablageRichtung {
    return this.opts.einstellungen.richtung;
  }

  /** Eine zusammengesetzte Nachricht des Kanals `cliprdr` hineinreichen. */
  verarbeite(daten: Buffer): void {
    if (this.beendet) return;
    this.sitzung.verarbeite(daten);
    this.stelleStilleUhr();
  }

  /**
   * Regelmaessig nachsehen, ob sich die lokale Zwischenablage geaendert hat.
   *
   * Aufzurufen, wenn das Sitzungsfenster sichtbar wird - im Hintergrund waere
   * es unnoetiges Mitlesen fremder Zwischenablagen.
   */
  starteAbfrage(): void {
    if (this.beendet || this.abfrage) return;
    const intervall = this.opts.einstellungen.abfrageIntervallMs;
    if (intervall <= 0 || !this.sitzung.darfSchreiben) {
      // Ohne Abfrage merkt niemand, dass lokal kopiert wurde. Das ist eine
      // zulaessige Einstellung, aber die haeufigste Ursache fuer "die
      // Zwischenablage tut nichts" - also steht sie im Protokoll.
      this.opts.log(
        `Zwischenablage: keine regelmaessige Abfrage der lokalen Zwischenablage ` +
          `(Intervall ${intervall} ms, Richtung ${this.richtung})`,
        'debug',
      );
      return;
    }
    this.opts.log(`Zwischenablage: lese die lokale Zwischenablage alle ${intervall} ms mit`, 'debug');
    this.abfrage = setInterval(() => void this.pruefeLokal(), intervall);
    // Node haelt den Prozess sonst am Leben; in VS Code faellt das nicht auf,
    // im Test schon.
    this.abfrage.unref?.();
  }

  stoppeAbfrage(): void {
    if (!this.abfrage) return;
    clearInterval(this.abfrage);
    this.abfrage = undefined;
  }

  /** Nur fuer Tests und Diagnose: gezaehlte PDUs beider Richtungen. */
  get zaehler(): { gesendet: number; empfangen: number } {
    return this.sitzung.zaehler;
  }

  /** Steht eine gesendete Formatliste noch ohne Antwort des Servers da? */
  get wartetAufFormatlistenAntwort(): boolean {
    return this.sitzung.wartetAufFormatlistenAntwort;
  }

  /**
   * Einmal nachsehen und eine Aenderung melden.
   *
   * Liefert `true`, wenn tatsaechlich etwas gemeldet wurde. Ueberlappende
   * Aufrufe werden verworfen: das Lesen ist asynchron, und zwei gleichzeitige
   * Leser wuerden denselben Text zweimal melden.
   */
  async pruefeLokal(): Promise<boolean> {
    if (this.beendet || this.laeuftAbfrage || !this.sitzung.darfSchreiben) return false;
    this.laeuftAbfrage = true;
    try {
      const text = await this.opts.speicher.lesen();
      if (typeof text !== 'string' || text === this.lokalerText) return false;
      this.lokalerText = text;
      this.opts.log(
        `Zwischenablage: die lokale Zwischenablage hat sich geaendert (${text.length} Zeichen)`,
        'debug',
      );
      const gemeldet = this.sitzung.melde(text);
      if (!gemeldet) {
        this.opts.log(
          `Zwischenablage: die Aenderung wurde nicht gemeldet ` +
            `(bereit: ${this.sitzung.istBereit}, Richtung: ${this.richtung})`,
          'debug',
        );
      }
      return gemeldet;
    } catch (err) {
      // Ein Lesefehler darf die Sitzung nicht stoeren. Ab jetzt hilft nur noch
      // das Textfeld - deshalb wird er einmal protokolliert.
      this.opts.log(`Zwischenablage: Lesen fehlgeschlagen - ${(err as Error).message}`);
      this.stoppeAbfrage();
      return false;
    } finally {
      this.laeuftAbfrage = false;
    }
  }

  /**
   * Text, den der Anwender ins Rueckfallfeld getippt oder eingefuegt hat.
   *
   * Er geht auf demselben Weg an den Server wie eine erkannte Aenderung der
   * lokalen Zwischenablage - und zusaetzlich, soweit moeglich, in die
   * Zwischenablage von VS Code, damit beide Seiten dasselbe halten.
   */
  async ausRueckfallfeld(text: string): Promise<boolean> {
    if (this.beendet || !this.sitzung.darfSchreiben) {
      this.opts.log('Zwischenablage: Senden abgelehnt - Schreiben ist abgeschaltet');
      return false;
    }
    this.lokalerText = text;
    try {
      await this.opts.speicher.schreiben(text);
    } catch {
      // Egal: der Text geht auch ohne lokale Zwischenablage an den Server.
    }
    const gemeldet = this.sitzung.melde(text);
    this.opts.log(
      gemeldet
        ? `Zwischenablage: ${text.length} Zeichen aus dem Textfeld an die Sitzung gemeldet`
        : 'Zwischenablage: Text aus dem Feld war unveraendert oder zu groß',
    );
    return gemeldet;
  }

  /**
   * Text vom Server ablegen.
   *
   * Zuerst der direkte Weg ueber die Zwischenablage von VS Code. Scheitert er,
   * geht der Text ins Rueckfallfeld, das sich dann von selbst einblendet -
   * besser ein zusaetzlicher Handgriff als ein verlorener Text.
   */
  private async uebernimmVomServer(text: string): Promise<void> {
    if (this.beendet) return;
    try {
      await this.opts.speicher.schreiben(text);
      this.opts.log(`Zwischenablage: ${text.length} Zeichen vom Server übernommen`);
      // Der Text geht trotzdem ins Feld - nur ohne es einzublenden. Wer es
      // spaeter oeffnet, findet dort, was zuletzt kam.
      this.opts.anWebview({ type: 'clipboardText', text, fallback: false });
    } catch (err) {
      this.opts.log(
        `Zwischenablage: Schreiben fehlgeschlagen (${(err as Error).message}) – Text steht im Rückfallfeld`,
      );
      this.opts.anWebview({ type: 'clipboardText', text, fallback: true });
    }
  }

  /** Nach einem Verbindungsverlust: Handshake vergessen, Abfrage anhalten. */
  zuruecksetzen(): void {
    this.sitzung.zuruecksetzen();
    this.lokalerText = undefined;
    this.stoppeAbfrage();
    this.stelleStilleUhr();
  }

  dispose(): void {
    this.beendet = true;
    this.stoppeAbfrage();
    if (this.stilleUhr) {
      clearTimeout(this.stilleUhr);
      this.stilleUhr = undefined;
    }
  }
}
