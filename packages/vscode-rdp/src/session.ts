/**
 * Eine RDP-Sitzung: verbindet den Protokollclient aus `ts-rdp` mit einem
 * Webview-Panel. Der Extension-Host dekodiert die Bitmaps und schickt fertige
 * RGBA-Kacheln an das Webview; von dort kommen Maus- und Tastaturereignisse
 * zurueck.
 */
import * as vscode from 'vscode';
import {
  DecodedBitmap,
  KBDFLAGS_EXTENDED,
  PointerImage,
  PTRFLAGS_BUTTON1,
  PTRFLAGS_BUTTON2,
  PTRFLAGS_BUTTON3,
  PTRFLAGS_HWHEEL,
  PTRFLAGS_WHEEL,
  PTRFLAGS_WHEEL_NEGATIVE,
  PTRXFLAGS_BUTTON1,
  PTRXFLAGS_BUTTON2,
  RdpClient,
  SYNC_CAPS_LOCK,
  isTlsCompatibilityError,
  SYNC_NUM_LOCK,
  SYNC_SCROLL_LOCK,
  lookupScancode,
  probeServerCertificate,
  AVC420_EGFX_CAPS,
  avcZeichenbereiche,
  CLIPRDR_CHANNEL_DEF,
  CLIPRDR_CHANNEL_NAME,
  RDPDR_CHANNEL_DEF,
  RDPDR_CHANNEL_NAME,
  RdpdrSession,
  createLogger,
} from 'ts-rdp';
import type { RdpDiagnostics, EgfxVideoFrame, LogLevel } from 'ts-rdp';
import { RdpConnection, secretKey, credentialSecretKey } from './connections.js';
import { BandbreitenProfilName, berechnePerformanceFlags, istProfilName } from './bandbreite.js';
import { FarbName, farbe as farbeZu, symbolDateiname, symbolSvg } from './farben.js';
import { CertificateTrustStore, TrustPolicy } from './trust.js';
import {
  MacTastenabbildung,
  cmdAbbildungAktiv,
  resolveKeyboardLayout,
  type CmdAbbildungEinstellung,
} from './keyboardLayouts.js';
import { ermittleLaufzeit, tastaturPlattform } from './extension.js';
import { renderWebview } from './webview.js';
import {
  Zwischenablagebruecke,
  leseEinstellungen as leseZwischenablageEinstellungen,
  type ZwischenablageEinstellungen,
  type ZwischenablageSpeicher,
} from './zwischenablage.js';
import {
  baueLaufwerk,
  eindeutigeOrdnernamen,
  leseEinstellungen as leseLaufwerkEinstellungen,
} from './arbeitsbereich.js';
import { frageFreigabe, vergissFreigaben, vscodeArbeitsbereichZugriff } from './arbeitsbereichZugriff.js';

/** Ein Rastschritt des Mausrads, wie ihn Windows erwartet. */
const WHEEL_STEP = 120;

/** Befehl, der das Diagnose-Overlay ein- und ausblendet. */
export const DIAGNOSE_BEFEHL = 'rdp.toggleDiagnostics';
/** Befehl, der die gemerkten Antworten auf die Laufwerks-Rueckfrage vergisst. */
export const LAUFWERK_FREIGABE_BEFEHL = 'rdp.forgetDriveApprovals';

/** Befehl, der das Rueckfallfeld der Zwischenablage ein- und ausblendet. */
export const ZWISCHENABLAGE_BEFEHL = 'rdp.toggleClipboardPanel';
/** Schluessel im globalen Speicher - der Zustand soll die Sitzung ueberdauern. */
export const DIAGNOSE_ZUSTAND_SCHLUESSEL = 'rdp.diagnose.sichtbar';
/** Taktrate des Overlays. Bewusst nicht pro Bild: einmal je Sekunde genuegt. */
const DIAGNOSE_TAKT_MS = 1000;

interface ReadyMessage {
  type: 'ready';
  width: number;
  height: number;
  devicePixelRatio: number;
  /**
   * Meldet das Webview die WebCodecs-API? Aeltere VS-Code-Fassungen und
   * Umgebungen ohne Chromium-Videostack haben sie nicht.
   *
   * Fehlt das Feld ganz (etwa beim Ersatzobjekt fuer den Wiederverbindungsweg),
   * gilt das als "nein" - lieber H.264 nicht anmelden als leere Bildbereiche.
   */
  webCodecs?: boolean;
}

/**
 * Die Webview meldet eine neue Panelgroesse. Sie ist dort bereits entprellt -
 * hier kommt nur an, was nach der Ruhephase uebrig bleibt.
 */
interface ResizeRequestMessage {
  type: 'resizeRequest';
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** Vorgabe fuer die Ruhezeit der Entprellung in Millisekunden. */
export const AUFLOESUNG_VERZUG_MS = 400;

/** Vorgabe fuer die Breite des farbigen Rahmens in Pixeln. */
export const RAHMEN_BREITE_PX = 3;

// ------------------------------------------------------------- Screenshot

/**
 * Der Vorschlagsname fuer einen Screenshot.
 *
 * Er soll zwei Fragen beantworten, ohne dass man die Datei oeffnet: *welche*
 * Sitzung und *wann*. Deshalb Verbindungsname plus Ortszeit - nicht UTC: wer
 * die Datei spaeter sucht, sucht nach der Uhrzeit, die auf seiner Uhr stand.
 *
 * Die verbotenen Zeichen sind dieselben wie beim .rdp-Export; Windows nimmt
 * keines davon in einem Dateinamen an.
 */
export function screenshotDateiname(name: string, zeit: Date): string {
  const sauber = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'RDP-Sitzung';
  const zwei = (n: number): string => String(n).padStart(2, '0');
  const stempel =
    `${zeit.getFullYear()}-${zwei(zeit.getMonth() + 1)}-${zwei(zeit.getDate())}` +
    `_${zwei(zeit.getHours())}-${zwei(zeit.getMinutes())}-${zwei(zeit.getSeconds())}`;
  return `${sauber}_${stempel}.png`;
}

/** Die acht Bytes, mit denen jede PNG-Datei anfaengt. */
const PNG_SIGNATUR = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Macht aus der data:-URL des Webviews die Bytes der PNG-Datei.
 *
 * Warum die Pruefung: die Zeichenkette kommt aus dem Renderer-Prozess und
 * landet ungefiltert in einer Datei, die der Benutzer selbst benannt hat. Ein
 * leerer oder abgeschnittener Wert - etwa weil `toDataURL` fehlgeschlagen ist -
 * wuerde sonst als .png gespeichert, die kein Betrachter oeffnen kann. Lieber
 * gar nichts schreiben und es sagen.
 */
export function bildAusDatenUrl(datenUrl: unknown): Buffer | undefined {
  if (typeof datenUrl !== 'string') return undefined;
  const treffer = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(datenUrl.trim());
  if (!treffer) return undefined;
  const bytes = Buffer.from(treffer[1]!, 'base64');
  if (bytes.length < PNG_SIGNATUR.length) return undefined;
  if (PNG_SIGNATUR.some((b, i) => bytes[i] !== b)) return undefined;
  return bytes;
}

/**
 * Schreibt das eingefaerbte Panelsymbol und liefert dessen Ort.
 *
 * `WebviewPanel.iconPath` nimmt zwar auch einen `ThemeIcon`, aber dessen Farbe
 * wertet VS Code laut eigener API-Dokumentation nur im `TreeItem` aus. Ein
 * farbiges Tabsymbol geht deshalb nur ueber eine Datei, in der die Farbe schon
 * steht - sie wird im Ablageort der Extension erzeugt, der auch unter
 * Remote-SSH auf der richtigen Seite liegt.
 *
 * Schlaegt das Schreiben fehl, gibt es `undefined` und die Sitzung behaelt das
 * gewoehnliche Symbol. Ein fehlendes Tabsymbol ist kein Grund, die Verbindung
 * nicht aufzubauen.
 */
export async function farbSymbolUri(
  context: vscode.ExtensionContext,
  name: FarbName | undefined,
): Promise<vscode.Uri | undefined> {
  const kennung = farbeZu(name);
  if (!kennung || !name) return undefined;
  const ordner = vscode.Uri.joinPath(context.globalStorageUri, 'farbsymbole');
  const ziel = vscode.Uri.joinPath(ordner, symbolDateiname(name));
  try {
    await vscode.workspace.fs.createDirectory(ordner);
    await vscode.workspace.fs.writeFile(ziel, Buffer.from(symbolSvg(kennung.hex), 'utf8'));
    return ziel;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ Diagnosewerte

/**
 * Eine Momentaufnahme. Zwei davon im Abstand einer Sekunde ergeben die Raten,
 * die im Overlay stehen - deshalb wird hier nichts gerechnet, nur festgehalten.
 */
export interface DiagnoseProbe {
  /** Date.now() zum Zeitpunkt der Messung. */
  zeit: number;
  /** Rohwerte der Library; fehlt, solange keine Verbindung steht. */
  diagnostics?: RdpDiagnostics;
  /** RGBA-Bytes, die der Host bisher an die Webview gereicht hat. */
  anWebviewBytes: number;
  /** Kacheln, die der Host bisher an die Webview gereicht hat. */
  anWebviewKacheln: number;
  /** Date.now() des letzten Bitmap-Ereignisses; 0, wenn noch keines kam. */
  letztesBild: number;
}

/** Umstaende, die sich nicht aus zwei Proben ergeben. */
export interface DiagnoseUmfeld {
  breite: number;
  hoehe: number;
  /** Date.now() des Verbindungsaufbaus; 0, solange nichts steht. */
  verbundenSeit: number;
  /** Roundtrip Extension-Host <-> Webview in Millisekunden. */
  rttMs?: number;
  /** Laeuft die Uebertragung ins Webview ueber Base64 statt Binaerdaten? */
  base64: boolean;
}

/** Eine Zeile des Overlays: links der Name, rechts der Wert. */
export interface DiagnoseZeile {
  name: string;
  wert: string;
}

/**
 * Klarnamen der Codecs der Graphics Pipeline (MS-RDPEGFX, RDPGFX_CODECID_*).
 * `getDiagnostics()` liefert nur Hexschluessel - die Zahl allein sagt beim
 * Draufschauen nicht, ob gerade unser ClearCodec oder unser Progressive
 * arbeitet, und genau darum geht es bei diesem Overlay.
 */
const CODEC_NAMEN: Record<string, string> = {
  '0x0': 'Roh',
  '0x3': 'RemoteFX',
  '0x8': 'ClearCodec',
  '0x9': 'Progressive',
  '0xa': 'Planar',
  '0xb': 'AVC420',
  '0xc': 'Alpha',
  '0xe': 'AVC444',
  '0xf': 'AVC444v2',
};

/** Byteangabe in der Einheit, in der man sie noch lesen kann. */
export function mengeText(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Zuwachs je Sekunde aus einem Zuwachs je Messabstand. */
function proSekunde(zuwachs: number, abstandMs: number): number {
  if (abstandMs <= 0) return 0;
  return (zuwachs * 1000) / abstandMs;
}

/** mm:ss, ab einer Stunde h:mm:ss. */
export function dauerText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const zwei = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${zwei(Math.floor(s / 60))}:${zwei(s % 60)}`;
  return `${Math.floor(s / 3600)}:${zwei(Math.floor((s % 3600) / 60))}:${zwei(s % 60)}`;
}

/** Summe aller Bytes ueber die virtuellen Kanaele. */
function kanalBytes(d: RdpDiagnostics | undefined): number {
  if (!d) return 0;
  let summe = 0;
  for (const wert of Object.values(d.virtualChannelBytes)) summe += wert;
  return summe;
}

/**
 * Baut die Zeilen des Overlays aus zwei Momentaufnahmen.
 *
 * Absichtlich eine reine Funktion: so laesst sich die Aufbereitung pruefen,
 * ohne eine Sitzung, einen Server oder ein Webview zu brauchen.
 */
export function diagnoseZeilen(
  jetzt: DiagnoseProbe,
  vorher: DiagnoseProbe | undefined,
  umfeld: DiagnoseUmfeld,
): DiagnoseZeile[] {
  const abstand = vorher ? jetzt.zeit - vorher.zeit : 0;
  const rate = (aktuell: number, frueher: number | undefined): string =>
    frueher === undefined || abstand <= 0 ? '' : ` · ${Math.round(proSekunde(aktuell - frueher, abstand))}/s`;
  const datenrate = (aktuell: number, frueher: number | undefined): string =>
    frueher === undefined || abstand <= 0 ? '' : ` · ${mengeText(proSekunde(aktuell - frueher, abstand))}/s`;

  const zeilen: DiagnoseZeile[] = [];
  const groesse = `${umfeld.breite}×${umfeld.hoehe}`;
  zeilen.push({
    name: 'Sitzung',
    wert:
      (umfeld.verbundenSeit ? `${groesse} · ${dauerText(jetzt.zeit - umfeld.verbundenSeit)}` : `${groesse} · –`) +
      (umfeld.base64 ? ' · Base64' : ''),
  });

  const d = jetzt.diagnostics;
  if (!d) {
    zeilen.push({ name: 'Verbindung', wert: 'steht nicht' });
    return zeilen;
  }
  const v = vorher?.diagnostics;

  const rahmen = d.frames.fastpath + d.frames.slowpath;
  zeilen.push({
    name: 'Rahmen',
    wert:
      `${rahmen}${rate(rahmen, v ? v.frames.fastpath + v.frames.slowpath : undefined)}` +
      ` (${d.frames.fastpath} fast / ${d.frames.slowpath} slow` +
      (d.frames.verworfen ? ` / ${d.frames.verworfen} verw.` : '') +
      ')',
  });

  zeilen.push({ name: 'Kacheln', wert: `${d.bitmaps}${rate(d.bitmaps, v?.bitmaps)}` });

  // Codecs absteigend nach Haeufigkeit: der wichtigste steht vorn und bleibt
  // dort, solange er fuehrt - ein Wert, der die Spalte wechselt, ist im
  // Augenwinkel nicht ablesbar.
  const codecs = Object.entries(d.graphicsCodecs).sort((a, b) => b[1] - a[1]);
  zeilen.push({
    name: 'Codecs',
    wert: codecs.length
      ? codecs.map(([id, n]) => `${CODEC_NAMEN[id] ?? id} ${n}${rate(n, v?.graphicsCodecs[id] ?? (v ? 0 : undefined))}`).join(', ')
      : 'keine',
  });

  zeilen.push({
    name: 'eGFX entpackt',
    wert: `${mengeText(d.graphicsBytes)}${datenrate(d.graphicsBytes, v?.graphicsBytes)}`,
  });

  if (d.graphicsAvc.regionen > 0) {
    zeilen.push({
      name: 'H.264',
      wert: `${d.graphicsAvc.regionen} Regionen · ${mengeText(d.graphicsAvc.bytes)}`,
    });
  }

  const kanaele = kanalBytes(d);
  zeilen.push({ name: 'Kanäle', wert: `${mengeText(kanaele)}${datenrate(kanaele, v ? kanalBytes(v) : undefined)}` });

  zeilen.push({
    name: 'An Webview',
    wert:
      `${mengeText(jetzt.anWebviewBytes)}${datenrate(jetzt.anWebviewBytes, vorher?.anWebviewBytes)}` +
      ` · ${jetzt.anWebviewKacheln} Kacheln`,
  });

  zeilen.push({
    name: 'Letztes Bild',
    wert: jetzt.letztesBild ? `vor ${jetzt.zeit - jetzt.letztesBild} ms` : 'noch keines',
  });

  if (umfeld.rttMs !== undefined) {
    zeilen.push({ name: 'Webview-RTT', wert: `${Math.round(umfeld.rttMs)} ms` });
  }

  if (d.activations > 1) zeilen.push({ name: 'Aktivierungen', wert: String(d.activations) });

  return zeilen;
}

export class RdpSession {
  private client?: RdpClient;
  private disposed = false;
  private modifiersSynced = false;
  /** Wenn das Webview keine Binaerdaten empfangen kann, wird auf Base64 umgestellt. */
  private useBase64 = false;
  readonly disposables: vscode.Disposable[] = [];
  /** Wurde bereits eine Kachel im Webview gezeichnet? */
  private painted = false;
  /**
   * Hat der Client den Aufbau abgeschlossen? Erst danach ist eine
   * Groessenmeldung des Servers wirklich eine *Aenderung*.
   */
  private verbindungSteht = false;
  private watchdogTimers: NodeJS.Timeout[] = [];

  // --- Zwischenablage (MS-RDPECLIP). Fehlt der Kanal, bleibt alles undefined
  //     und die Sitzung verhaelt sich wie vor dieser Erweiterung.
  private zwischenablage?: Zwischenablagebruecke;

  // --- Laufwerksumleitung (MS-RDPEFS). Fehlt der Kanal, bleibt alles
  // undefined und die Sitzung verhaelt sich wie ohne diese Erweiterung.
  private laufwerk?: RdpdrSession;
  /** Horcher auf Aenderungen am Arbeitsbereich; nur waehrend der Sitzung. */
  private arbeitsbereichHorcher?: vscode.Disposable;
  private zwischenablageFeldSichtbar = false;

  /**
   * Alle offenen Sitzungen. Der Diagnose-Befehl wirkt auf alle zugleich: sein
   * Zustand ist global gespeichert, und zwei Sitzungen mit verschiedener
   * Overlay-Sichtbarkeit waeren weder erklaerbar noch nuetzlich.
   */
  private static readonly offeneSitzungen = new Set<RdpSession>();
  /** Lebt genau so lange, wie mindestens eine Sitzung offen ist. */
  private static diagnoseBefehl?: vscode.Disposable;
  /** Ebenso fuer das Rueckfallfeld der Zwischenablage. */
  private static zwischenablageBefehl?: vscode.Disposable;

  /** Und fuer den Befehl, der die gemerkten Laufwerksfreigaben vergisst. */
  private static laufwerkBefehl?: vscode.Disposable;

  // --- Diagnose. Alle Zaehler bleiben stehen, solange das Overlay aus ist.
  private diagnoseSichtbar = false;
  private diagnoseTimer?: NodeJS.Timeout;
  private letzteProbe?: DiagnoseProbe;
  private anWebviewBytes = 0;
  private anWebviewKacheln = 0;
  private letztesBild = 0;
  /** Vor H.264 in YUV444 wird nur einmal gewarnt, nicht bei jedem Teilbild. */
  private avc444Gemeldet = false;
  private verbundenSeit = 0;
  private rttMs?: number;
  private rttSeq = 0;
  private rttGesendet = 0;
  /** Laufende Nummer der Screenshot-Bitte; nur die neueste wird beantwortet. */
  private screenshotLauf = 0;
  private readonly basisDomain: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly connection: RdpConnection,
    private readonly output: vscode.OutputChannel,
    private readonly trustStore: CertificateTrustStore,
    /**
     * Eigener Eintrag je Sitzung. Ein geteilter waere falsch: bei zwei offenen
     * Sitzungen ueberschriebe die zuletzt aktive den Text der anderen, und das
     * Schliessen *einer* Sitzung wuerde die Anzeige ausblenden, obwohl die
     * andere noch verbunden ist.
     */
    private readonly statusBar: vscode.StatusBarItem,
  ) {
    this.basisDomain = connection.domain;
  }

  static async open(
    context: vscode.ExtensionContext,
    connection: RdpConnection,
    output: vscode.OutputChannel,
    trustStore: CertificateTrustStore,
  ): Promise<RdpSession> {
    const panel = vscode.window.createWebviewPanel(
      'rdpSession',
      connection.name || connection.host,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    panel.webview.html = renderWebview(panel.webview, context.extensionUri, connection.name || connection.host);
    // Das farbige Symbol ist das Einzige am Tab selbst, was sich einfaerben
    // laesst - `vscode.Tab` kennt keine Farbe. Faellt es aus, bleibt es beim
    // gewoehnlichen Symbol.
    panel.iconPath =
      (await farbSymbolUri(context, connection.color)) ??
      vscode.Uri.joinPath(context.extensionUri, 'media', 'rdp-icon.svg');

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'rdp.disconnect';

    const session = new RdpSession(panel, context, connection, output, trustStore, statusBar);
    session.disposables.push(statusBar);
    session.wirePanel();
    session.diagnoseSichtbar = RdpSession.diagnoseStartzustand(context);
    RdpSession.merkeSitzung(session);
    return session;
  }

  /**
   * Soll das Overlay beim Start sichtbar sein? Der zuletzt umgeschaltete
   * Zustand hat Vorrang vor der Einstellung - wer es in einer Sitzung
   * eingeschaltet hat, will es in der naechsten wiedersehen.
   */
  private static diagnoseStartzustand(context: vscode.ExtensionContext): boolean {
    const gespeichert = context.globalState.get<boolean>(DIAGNOSE_ZUSTAND_SCHLUESSEL);
    if (typeof gespeichert === 'boolean') return gespeichert;
    return vscode.workspace.getConfiguration('rdp').get<boolean>('diagnostics.showOnStart', false);
  }

  /**
   * Traegt die Sitzung ein und haelt den Diagnose-Befehl am Leben.
   *
   * Der Befehl gehoert der Klasse, nicht der einzelnen Sitzung: VS Code laesst
   * denselben Befehlsnamen kein zweites Mal registrieren, eine zweite Sitzung
   * wuerde sonst beim Oeffnen scheitern.
   */
  private static merkeSitzung(session: RdpSession): void {
    if (RdpSession.offeneSitzungen.size === 0 && !RdpSession.diagnoseBefehl) {
      RdpSession.diagnoseBefehl = vscode.commands.registerCommand(DIAGNOSE_BEFEHL, () =>
        RdpSession.schalteDiagnoseUm(session.context),
      );
    }
    if (RdpSession.offeneSitzungen.size === 0 && !RdpSession.zwischenablageBefehl) {
      // Anders als das Diagnose-Overlay wirkt dieser Befehl nur auf die
      // sichtbare Sitzung: das Feld gehoert zu genau einer Verbindung.
      RdpSession.zwischenablageBefehl = vscode.commands.registerCommand(ZWISCHENABLAGE_BEFEHL, () =>
        RdpSession.gemeinteSitzung()?.schalteZwischenablagefeldUm(),
      );
    }
    if (RdpSession.offeneSitzungen.size === 0 && !RdpSession.laufwerkBefehl) {
      // Die Antwort auf die Freigabefrage wird gemerkt, auch ein Nein. Ohne
      // einen Weg zurueck waere eine versehentlich verweigerte Freigabe
      // endgueltig - und ein "Nie wieder fragen", das man nicht zuruecknehmen
      // kann, ist kein Einverstaendnis, sondern eine Falle.
      RdpSession.laufwerkBefehl = vscode.commands.registerCommand(LAUFWERK_FREIGABE_BEFEHL, async () => {
        await vergissFreigaben(session.context);
        vscode.window.showInformationMessage(
          'Die gemerkten Laufwerksfreigaben sind vergessen. Beim nächsten Verbinden wird wieder gefragt.',
        );
      });
    }
    RdpSession.offeneSitzungen.add(session);
  }

  /**
   * Die Sitzung, die ein Sitzungsbefehl meint.
   *
   * Waehrend die Befehlspalette offen ist, ist kein Webview `active` - dann
   * muss `visible` genuegen. Bleibt auch das offen, gewinnt die zuletzt
   * geoeffnete: irgendeine Sitzung ist besser als gar keine Reaktion.
   */
  private static gemeinteSitzung(): RdpSession | undefined {
    const alle = [...RdpSession.offeneSitzungen];
    return alle.find((s) => s.panel.active) ?? alle.find((s) => s.panel.visible) ?? alle.at(-1);
  }

  private static vergissSitzung(session: RdpSession): void {
    RdpSession.offeneSitzungen.delete(session);
    if (RdpSession.offeneSitzungen.size === 0) {
      RdpSession.diagnoseBefehl?.dispose();
      RdpSession.diagnoseBefehl = undefined;
      RdpSession.zwischenablageBefehl?.dispose();
      RdpSession.zwischenablageBefehl = undefined;
      RdpSession.laufwerkBefehl?.dispose();
      RdpSession.laufwerkBefehl = undefined;
    }
  }

  /** Schaltet das Overlay in allen offenen Sitzungen um und merkt sich das. */
  private static schalteDiagnoseUm(context: vscode.ExtensionContext): void {
    const naechster = !RdpSession.diagnoseStartzustand(context);
    void context.globalState.update(DIAGNOSE_ZUSTAND_SCHLUESSEL, naechster);
    for (const sitzung of RdpSession.offeneSitzungen) sitzung.setzeDiagnose(naechster);
  }

  private wirePanel(): void {
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState(() => {
        vscode.commands.executeCommand('setContext', 'rdp.sessionFocused', this.panel.active);
        if (this.panel.active) this.updateStatusBar();
        // Die lokale Zwischenablage wird nur mitgelesen, solange die Sitzung
        // sichtbar ist. Im Hintergrund waere es unnoetiges Mitlesen fremder
        // Inhalte - und der Server bekaeme Text, den niemand fuer ihn kopiert hat.
        if (this.panel.visible) {
          void this.zwischenablage?.pruefeLokal();
          this.zwischenablage?.starteAbfrage();
        } else {
          this.zwischenablage?.stoppeAbfrage();
        }
      }),
      this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)),
    );
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        // Der Zustand des Overlays geht vor dem Verbindungsaufbau hinueber:
        // die Webview soll ihn nicht erst nach dem ersten Bild erfahren.
        this.setzeDiagnose(this.diagnoseSichtbar);
        // Ebenso der Rahmen: die Kennfarbe soll schon waehrend des Aufbaus
        // stehen, nicht erst mit dem ersten Bild.
        this.sendeFarbe();
        await this.start(message as ReadyMessage);
        break;
      case 'resizeRequest':
        this.aufloesungMitziehen(message as ResizeRequestMessage);
        break;
      case 'diagnosePong':
        // Nur die Antwort auf den zuletzt gestellten Ping zaehlt.
        if (message.seq === this.rttSeq && this.rttGesendet) this.rttMs = Date.now() - this.rttGesendet;
        break;
      case 'reconnect':
        this.painted = false;
        this.verbindungSteht = false;
        this.clearWatchdog();
        // Die neue Verbindung faengt bei null an - sonst stuende im Overlay
        // eine Rate, die aus zwei verschiedenen Sitzungen stammt.
        this.diagnoseZaehlerZuruecksetzen();
        // Die alte Verbindung erst trennen, dann vergessen. Andersherum bleibt
        // sie offen, ohne dass noch jemand sie kennt: der Server haelt die
        // Sitzung, und ihre Horcher speisen weiter Kacheln und Fehler in
        // dieses Webview. Bei jedem Klick auf "Erneut verbinden" kaeme eine
        // weitere solche Geistersitzung dazu.
        this.client?.disconnect();
        this.client = undefined;
        await this.start(this.lastReady ?? { type: 'ready', width: 1280, height: 800, devicePixelRatio: 1 });
        break;
      case 'painted':
        if (!this.painted) {
          this.painted = true;
          this.clearWatchdog();
          this.setState('connected');
          this.log(`Erste Kacheln gezeichnet (${message.tiles})`);
        }
        break;
      case 'drawError':
        this.log(`Zeichenfehler im Webview: ${message.message}`);
        break;
      case 'avcRueckfall':
        // Der Decoder im Webview hat aufgegeben. Die uebrigen Codecpfade
        // laufen weiter; die H.264-Bereiche bleiben leer, bis der Server sie
        // ueber einen anderen Codec neu schickt. Mitten in der Sitzung laesst
        // sich der Capabilityssatz nicht mehr aendern - deshalb hier nur die
        // Ansage, was zu tun ist.
        this.log(
          `H.264 im Webview abgebrochen: ${message.message} ` +
            'Für diesen Rechner besser "rdp.graphics.avc420" ausschalten.',
        );
        break;
      case 'binaryUnsupported':
        // Einmalige Umstellung: dieses VS Code reicht Uint8Array nicht durch.
        this.useBase64 = true;
        this.log('Webview kann keine Binaerdaten empfangen, stelle auf Base64 um');
        this.client?.refresh();
        break;
      case 'mouse':
        this.handleMouse(message);
        break;
      case 'key':
        this.handleKey(message);
        break;
      case 'focus':
        vscode.commands.executeCommand('setContext', 'rdp.sessionFocused', !!message.focused);
        // Beim Fokusverlust weiss niemand mehr, was noch gedrueckt ist.
        if (!message.focused) this.macAbbildung.zuruecksetzen();
        break;
      case 'plattform':
        // Die Plattform des Nutzers, gemeldet vom Webview. Nur die zaehlt:
        // unter Remote-SSH ist process.platform die des Sprungbretts.
        this.setzeTastaturPlattform(
          typeof message.plattform === 'string' ? message.plattform : undefined,
        );
        break;
      case 'clipboardSend':
        // Rueckfallebene: der Anwender hat Text ins Feld gelegt.
        await this.zwischenablage?.ausRueckfallfeld(String(message.text ?? ''));
        break;
      case 'clipboardFiles': {
        const limit = Math.min(256, Math.max(1, vscode.workspace.getConfiguration('rdp').get<number>('clipboard.maxFileSizeMb', 64))) * 1024 * 1024;
        const raw = message.files;
        if (!Array.isArray(raw) || !raw.length || raw.length > 256) break;
        let encodedSize = 0;
        const valid = raw.every((f: any) => f && typeof f.name === 'string' && typeof f.base64 === 'string' && (encodedSize += f.base64.length) <= Math.ceil(limit / 3) * 4 + raw.length * 4);
        if (!valid) { vscode.window.showWarningMessage('Die Dateien überschreiten die Clipboard-Größenbegrenzung.'); break; }
        const files = raw.map((f: any) => ({ name: f.name, data: Buffer.from(f.base64, 'base64') }));
        const ok = await this.zwischenablage?.ausDateien(files, limit);
        if (ok && this.client) {
          this.client.sendKeyScancode(0x1d, true);
          this.client.sendKeyScancode(0x2f, true);
          this.client.sendKeyScancode(0x2f, false);
          this.client.sendKeyScancode(0x1d, false);
        } else vscode.window.showWarningMessage('Dateien konnten nicht bereitgestellt werden. Bitte erneut einfügen; Clipboard muss zum Server freigegeben sein.');
        break;
      }
      case 'clipboardPaste': {
        const ok = this.zwischenablage ? await this.zwischenablage.ausEinfuegen(typeof message.text === 'string' ? message.text : undefined) : true;
        if (ok && this.client) {
          this.client.sendKeyScancode(0x1d, true);
          this.client.sendKeyScancode(0x2f, true);
          this.client.sendKeyScancode(0x2f, false);
          this.client.sendKeyScancode(0x1d, false);
        }
        break;
      }
      case 'screenshot':
        // Nur die Antwort auf die zuletzt gestellte Bitte zaehlt - eine alte
        // wuerde sonst einen zweiten Speicherdialog aufmachen.
        if (message.id === this.screenshotLauf) await this.speichereScreenshot(message);
        break;
      case 'clipboardPanel':
        // Das Webview meldet zurueck, ob das Feld offen ist - damit der Befehl
        // beim naechsten Mal in die richtige Richtung schaltet.
        this.zwischenablageFeldSichtbar = !!message.sichtbar;
        break;
    }
  }

  private lastReady?: ReadyMessage;

  // ------------------------------------------------------------ Verbindung

  private async start(ready: ReadyMessage): Promise<void> {
    this.lastReady = ready;
    const config = vscode.workspace.getConfiguration('rdp');
    const host = this.connection.host;
    const port = this.connection.port ?? 3389;

    this.setState('connecting', 'Verbindung wird aufgebaut…', `${host}:${port}`);

    try {
      const size = this.resolveResolution(ready, config);
      const zwischenablageEinstellungen = leseZwischenablageEinstellungen((schluessel, vorgabe) =>
        config.get(schluessel, vorgabe),
      );
      // Die Kanalanmeldung muss vor der Aushandlung feststehen: was hier nicht
      // im Client Network Data steht, eroeffnet der Server spaeter nicht.
      const laufwerkEinstellungen = leseLaufwerkEinstellungen((schluessel, vorgabe) =>
        config.get(schluessel, vorgabe),
      );

      // Zertifikat vor der Anmeldung pruefen - bei NLA gehen die Zugangsdaten
      // sonst an einen moeglicherweise untergeschobenen Server.
      const policy = config.get<TrustPolicy>('certificateTrust', 'trust-on-first-use');
      const certificate = await probeServerCertificate({
        host,
        port,
        connectTimeout: config.get<number>('connectTimeout', 15000),
      });
      this.log(`Zertifikat von ${host}: ${certificate.subject} (${certificate.fingerprint256})`);

      const approved = await this.trustStore.confirm(`${host}:${port}`, certificate, policy);
      if (approved === false) {
        this.setState('error', 'Verbindung abgebrochen', 'Dem Serverzertifikat wurde nicht vertraut.', 'Erneut versuchen');
        return;
      }
      const expectedFingerprint = certificate.fingerprint256;

      const credentials = await this.resolveCredentials();
      if (!credentials) {
        this.setState('error', 'Verbindung abgebrochen', 'Es wurden keine Zugangsdaten eingegeben.', 'Erneut versuchen');
        return;
      }

      // Zwei Bedingungen, und beide muessen vor der Capability-Aushandlung
      // feststehen: die Einstellung *und* ein Webview, das WebCodecs hat.
      // Anders herum waere der Rueckfall zu spaet - der Server haette dann
      // schon auf H.264 umgestellt, und wir haetten keinen Decoder dafuer.
      const avc420Gewuenscht = config.get<boolean>('graphics.avc420', false);
      const avc420An = avc420Gewuenscht && ready.webCodecs === true;
      if (avc420Gewuenscht && !avc420An) {
        this.log(
          'H.264/AVC420 ist eingeschaltet, aber dieses Webview meldet keine WebCodecs-Unterstützung. ' +
            'Die Sitzung läuft wie bisher über ClearCodec, RemoteFX Progressive und Planar.',
        );
      } else if (avc420An) {
        this.log('H.264/AVC420 ist eingeschaltet - der Capabilityssatz meldet AVC420_ENABLED an.');
      }

      const client = new RdpClient({
        host,
        port,
        domain: this.connection.domain ?? '',
        username: credentials.username,
        password: credentials.password,
        width: size.width,
        height: size.height,
        colorDepth: this.connection.colorDepth ?? config.get<number>('defaultColorDepth', 32),
        keyboardLayout: resolveKeyboardLayout(
          this.connection.keyboardLayout ?? config.get<string>('defaultKeyboardLayout'),
        ),
        clientName: 'VS Code',
        // Der Kanal wird nur angemeldet, wenn die Zwischenablage ueberhaupt
        // erlaubt ist. Ein Server, der ihn nicht eroeffnet, aendert nichts:
        // dann bleibt getStaticChannelId('cliprdr') undefined.
        extraStaticChannels: [
          ...(zwischenablageEinstellungen.aktiv ? [CLIPRDR_CHANNEL_DEF] : []),
          // Ebenso fuer die Laufwerksumleitung: ohne die Einstellung wird der
          // Kanal gar nicht erst angemeldet, und getStaticChannelId('rdpdr')
          // bleibt undefined.
          ...(laufwerkEinstellungen.aktiv ? [RDPDR_CHANNEL_DEF] : []),
        ],
        enableGraphicsPipeline: config.get<boolean>('graphicsPipeline', true),
        // Der Display Control Channel wird angefragt, sobald das Mitziehen
        // erlaubt ist. Oeffnet der Server ihn nicht, aendert das nichts.
        enableDisplayControl: config.get<boolean>('dynamicResolution', true),
        // H.264 nur auf ausdrueckliche Ansage. Ohne die Einstellung wird der
        // Capabilityssatz gar nicht erst uebergeben, der Server bekommt also
        // dasselbe Angebot wie bisher und schickt weiterhin ClearCodec,
        // RemoteFX Progressive und Planar.
        ...(avc420An ? { graphicsCapsSets: AVC420_EGFX_CAPS, avcFrames: true } : {}),
        connectTimeout: config.get<number>('connectTimeout', 15000),
        performanceFlags: this.performanceFlags(config),
        logLevel: config.get<any>('logLevel', 'info'),
        logSink: (level, msg) => this.log(`[${level}] ${msg}`),
        // Das Zertifikat wurde oben bestaetigt; hier wird nur noch geprueft,
        // dass es sich zwischen Pruefung und Verbindung nicht geaendert hat.
        verifyCertificate: (cert) => {
          const fingerprint = formatFingerprint(cert.fingerprint256);
          if (policy !== 'ignore' && fingerprint && fingerprint !== expectedFingerprint) {
            throw new Error('Das Serverzertifikat hat sich zwischen Prüfung und Verbindung geändert.');
          }
        },
      });

      this.client = client;
      this.wireClient(client);
      await client.connect();

      if (credentials.shouldSave) {
        await this.context.secrets.store(this.anmeldeSecretKey ?? secretKey(this.connection), credentials.password);
      }
    } catch (error) {
      const err = error as Error;
      this.log(`Fehler: ${err.stack ?? err.message}`);
      this.setState('error', 'Verbindung fehlgeschlagen', humanizeError(err), 'Erneut verbinden');
      // Ein falsches Passwort soll nicht dauerhaft gespeichert bleiben.
      if (/CredSSP|Anmelde|Zugangsdaten/i.test(err.message) && this.anmeldeSecretKey) {
        await this.context.secrets.delete(this.anmeldeSecretKey);
      }
    }
  }

  private resolveResolution(ready: ReadyMessage, config: vscode.WorkspaceConfiguration): { width: number; height: number } {
    if (this.connection.width && this.connection.height) {
      return { width: this.connection.width, height: this.connection.height };
    }
    return RdpSession.aufloesungAusPanel(ready.width, ready.height, this.pixelFaktor(ready.devicePixelRatio, config));
  }

  /**
   * Wie viele Desktop-Pixel auf einen CSS-Pixel des Panels kommen.
   *
   * `rdp.highDpi` ist bewusst standardmaessig aus - und das ist keine
   * Zaghaftigkeit: Microsofts eigener Webclient haelt es genauso und weist
   * ausdruecklich auf die zusaetzliche Prozessorlast hin. Bei einem Faktor 2
   * vervierfacht sich die Pixelzahl, und jede davon muss kodiert, uebertragen
   * und dekodiert werden. Mehr als 2 wird deshalb auch eingeschaltet nicht
   * angefordert.
   */
  private pixelFaktor(devicePixelRatio: number, config: vscode.WorkspaceConfiguration): number {
    if (!config.get<boolean>('highDpi', false)) return 1;
    return Math.min(devicePixelRatio || 1, 2);
  }

  /**
   * Aus der Panelgroesse eine Desktopaufloesung rechnen.
   *
   * Dieselbe Rechnung gilt beim Verbindungsaufbau und bei jeder spaeteren
   * Groessenaenderung. Das ist wichtig: waeren es zwei Rechnungen, ergaebe ein
   * Zurueckziehen auf die Ausgangsgroesse eine andere Aufloesung als die beim
   * Verbinden ausgehandelte, und das Bild spraenge ohne Anlass.
   *
   * Das Abrunden auf Vielfache von vier ist strenger als MS-RDPEDISP 2.2.2.2.1
   * verlangt (dort muss nur die Breite gerade sein) und stammt aus dem
   * Verbindungsaufbau. Es bleibt, weil beide Wege dasselbe liefern muessen.
   */
  static aufloesungAusPanel(breite: number, hoehe: number, faktor: number): { width: number; height: number } {
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(max, Math.floor((value * faktor) / 4) * 4));
    return {
      width: clamp(breite, 640, 4096),
      height: clamp(hoehe, 480, 2160),
    };
  }

  /**
   * Die Desktopaufloesung der neuen Panelgroesse nachfuehren (MS-RDPEDISP).
   *
   * Rueckfallebene: `requestResolution` wirft nie und meldet `false`, wenn der
   * Server den Display Control Channel nicht anbietet. Dann bleibt es beim
   * unscharfen Skalieren wie bisher - sichtbar wird das nur im Protokoll.
   */
  /**
   * Was die Webview ueber das Mitziehen wissen muss.
   *
   * Eine fest eingetragene Aufloesung schaltet es ganz ab - dann braucht die
   * Webview gar nicht erst einen Zeitgeber zu starten.
   */
  private aufloesungsEinstellungen(config: vscode.WorkspaceConfiguration): {
    dynamicResolution: boolean;
    resizeDelay: number;
  } {
    const fest = !!(this.connection.width && this.connection.height);
    return {
      dynamicResolution: !fest && config.get<boolean>('dynamicResolution', true),
      resizeDelay: Math.max(0, config.get<number>('dynamicResolutionDelay', AUFLOESUNG_VERZUG_MS)),
    };
  }

  private aufloesungMitziehen(nachricht: ResizeRequestMessage): void {
    const client = this.client;
    if (!client || !this.verbindungSteht) return;

    const config = vscode.workspace.getConfiguration('rdp');
    if (!config.get<boolean>('dynamicResolution', true)) return;

    // Eine fest eingetragene Aufloesung ist eine Ansage des Nutzers und wird
    // nicht ueberstimmt - auch nicht, wenn das Panel eine andere Form hat.
    if (this.connection.width && this.connection.height) {
      this.log('Auflösung ist für diese Verbindung fest eingestellt - das Panel zieht nicht mit.');
      return;
    }

    const faktor = this.pixelFaktor(nachricht.devicePixelRatio, config);
    const groesse = RdpSession.aufloesungAusPanel(nachricht.width, nachricht.height, faktor);
    if (groesse.width === client.width && groesse.height === client.height) return;

    // Bei eingeschaltetem HiDPI weiss der Server ueber die Skalierungsfelder,
    // dass der Desktop dichter ist als er misst - sonst wird die Schrift winzig.
    const gesendet = client.requestResolution(groesse.width, groesse.height, {
      desktopScaleFactor: Math.round(faktor * 100),
      deviceScaleFactor: Math.round(faktor * 100),
    });
    if (gesendet) {
      this.log(`Neue Auflösung angefragt: ${groesse.width}×${groesse.height}`);
    } else {
      // Kein Fehlerzustand, keine Einblendung: ein Server ohne RDPEDISP ist
      // voellig in Ordnung, das Bild wird dann eben weiter skaliert.
      this.log(
        `Auflösung ${groesse.width}×${groesse.height} wurde nicht angefragt - ` +
          'der Server unterstützt keinen Auflösungswechsel im laufenden Betrieb.',
      );
    }
  }

  /**
   * Die TS_PERF_*-Flags des Client Info PDU.
   *
   * Das Bandbreitenprofil der Verbindung (bereits mit der Ordnervererbung
   * aufgeloest) gewinnt; ohne Profil greift `rdp.defaultBandwidthProfile`, und
   * ohne beides bleibt es bei den einzelnen `rdp.performance.*`-Schaltern.
   */
  private performanceFlags(config: vscode.WorkspaceConfiguration): number {
    const global = config.get<string>('defaultBandwidthProfile', '');
    const profil: BandbreitenProfilName | undefined =
      this.connection.bandwidthProfile ?? (istProfilName(global) ? global : undefined);
    return berechnePerformanceFlags(profil, (schluessel, standard) => config.get(schluessel, standard));
  }

  private anmeldeSecretKey?: string;

  private async resolveCredentials(): Promise<{ username: string; password: string; shouldSave: boolean } | undefined> {
    this.anmeldeSecretKey = undefined;
    const profiles = this.connection.promptCredentials ? [] : this.connection.credentials ?? [];
    let profile = profiles.find(c => c.id === this.connection.defaultCredential);
    if (!profile && profiles.length === 1) profile = profiles[0];
    if (!profile && profiles.length > 1) {
      const selected = await vscode.window.showQuickPick(profiles.map(c => ({ label: c.name, description: `${c.domain ? c.domain + '\\' : ''}${c.username}`, profile: c })), { title: `Zugangsdaten für ${this.connection.host}`, ignoreFocusOut: true });
      if (!selected) return undefined;
      profile = selected.profile;
    }
    const prompt = this.connection.promptCredentials || (!profile && !this.connection.username);
    if (profile) {
      this.connection.username = profile.username;
      this.connection.domain = profile.domain;
      this.anmeldeSecretKey = credentialSecretKey(profile.id);
    }
    let username = this.connection.username;
    if (prompt || !username) {
      username = await vscode.window.showInputBox({
        title: `Anmeldung an ${this.connection.host}`,
        prompt: 'Benutzername (optional mit Domäne: DOMAIN\\benutzer)',
        ignoreFocusOut: true,
      });
      if (username === undefined) return undefined;
    }

    if (!username.trim()) return undefined;
    let domain = (prompt ? this.basisDomain : this.connection.domain) ?? '';
    if (username.includes('\\')) {
      const [d, u] = username.split('\\', 2);
      domain = d;
      username = u;
    }
    this.connection.domain = domain;

    // Den tatsächlich verwendeten Benutzernamen auch dem Passwortschlüssel zugrunde legen.
    if (!prompt) this.connection.username = username;
    if (!prompt) this.anmeldeSecretKey ??= secretKey(this.connection);
    const stored = prompt ? undefined : await this.context.secrets.get(this.anmeldeSecretKey ?? secretKey(this.connection));
    if (stored) return { username, password: stored, shouldSave: false };

    const password = await vscode.window.showInputBox({
      title: `Anmeldung an ${this.connection.host}`,
      prompt: `Passwort für ${domain ? domain + '\\' : ''}${username}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return undefined;

    if (prompt) return { username, password, shouldSave: false };

    const save = await vscode.window.showQuickPick(
      [
        { label: 'Passwort merken', description: 'Im sicheren Speicher von VS Code ablegen', value: true },
        { label: 'Nicht merken', description: 'Nur für diese Sitzung verwenden', value: false },
      ],
      { title: 'Passwort speichern?', ignoreFocusOut: true },
    );

    return { username, password, shouldSave: save?.value === true };
  }

  private wireClient(client: RdpClient): void {
    const config = vscode.workspace.getConfiguration('rdp');

    client.on('connect', () => {
      this.verbindungSteht = true;
      this.verbundenSeit = Date.now();
      this.post({
        type: 'init',
        width: client.width,
        height: client.height,
        scaling: config.get<string>('scaling', 'fit'),
        smooth: config.get<boolean>('smoothScaling', false),
        ...this.aufloesungsEinstellungen(config),
      });
      // Die Verbindung steht, aber gezeichnet ist noch nichts. Bis zur ersten
      // Kachel bleibt die Einblendung stehen - eine schwarze Flaeche waere
      // nicht von einem Fehler zu unterscheiden.
      this.setState('waiting', 'Verbunden', 'Warte auf den Bildschirminhalt des Servers…');
      this.updateStatusBar();
      this.log(`Verbunden mit ${this.connection.host} (${client.width}x${client.height})`);
      this.starteZwischenablage(client);
      this.starteLaufwerk(client);
      this.startWatchdog(client);
    });

    // Genau einmal je Verbindung anmelden, nicht bei jedem 'connect': nach
    // einem automatischen Wiederverbinden kaeme sonst je Versuch ein weiterer
    // Horcher dazu, bis Node vor zu vielen warnt. Welche Bruecke gerade lebt,
    // entscheidet die Weiterleitung selbst.
    client.on('staticChannelData', (e: { name: string; data: Buffer }) => {
      if (e.name === CLIPRDR_CHANNEL_NAME) this.zwischenablage?.verarbeite(e.data);
      else if (e.name === RDPDR_CHANNEL_NAME) this.laufwerk?.verarbeite(e.data);
    });

    client.on('bitmap', (tiles: DecodedBitmap[]) => this.sendTiles(tiles));

    client.on('avcFrame', (frame: EgfxVideoFrame) => this.sendVideo(frame));

    client.on('pointer', (pointer: PointerImage | null) => {
      if (!pointer) {
        this.post({ type: 'pointerDefault' });
        return;
      }
      this.post({
        type: 'pointer',
        width: pointer.width,
        height: pointer.height,
        hotspotX: pointer.hotspotX,
        hotspotY: pointer.hotspotY,
        data: this.encode(Buffer.from(pointer.rgba.buffer, pointer.rgba.byteOffset, pointer.rgba.byteLength)),
      });
    });

    client.on('resize', ({ width, height }) => {
      this.log(`Sitzungsgröße geändert: ${width}×${height}`);
      this.post({
        type: 'init',
        width,
        height,
        scaling: config.get<string>('scaling', 'fit'),
        smooth: config.get<boolean>('smoothScaling', false),
        ...this.aufloesungsEinstellungen(config),
      });
      // Waehrend des Aufbaus ist das keine Aenderung, sondern die Antwort des
      // Servers auf unsere Anfrage - Windows gibt regelmaessig eine andere
      // Groesse vor. Wer hier unbesehen "Auflösung geändert" einblendet, zeigt
      // das beim allerersten Verbinden an, bevor ueberhaupt etwas zu aendern war.
      if (!this.verbindungSteht) return;

      // Eine echte Groessenaenderung leert die Zeichenflaeche - also zurueck in
      // den Wartezustand, bis der Server das neue Bild geschickt hat.
      this.painted = false;
      this.setState('waiting', 'Auflösung geändert', 'Warte auf das neue Bild…');
      this.startWatchdog(client);
    });

    client.on('pointerHidden', () => this.post({ type: 'pointerHidden' }));

    client.on('error', (err: Error) => {
      this.log(`Sitzungsfehler: ${err.stack ?? err.message}`);
      this.setState('error', 'Verbindung unterbrochen', humanizeError(err), 'Erneut verbinden');
    });

    client.on('close', (reason?: string) => {
      this.log(`Verbindung geschlossen${reason ? ': ' + reason : ''}`);
      // Der naechste Verbindungsaufbau faengt mit einem neuen CLIPRDR-Handshake
      // an; Reste des alten wuerden ihn durcheinanderbringen.
      this.zwischenablage?.zuruecksetzen();
      // Beim RDPDR-Kanal gilt dasselbe, und dazu kommt: offene Datei-Handles
      // zeigen auf eine Verbindung, die es nicht mehr gibt.
      this.laufwerk?.zuruecksetzen();
      this.setState('closed', 'Sitzung beendet', reason ?? 'Die Verbindung wurde geschlossen.', 'Erneut verbinden');
      this.updateStatusBar();
    });

  }

  // ---------------------------------------------------- Laufwerksumleitung

  /**
   * Den Arbeitsbereich als Laufwerk an die stehende Verbindung haengen.
   *
   * Rueckfallebene, dreifach: Ist die Einstellung aus, hat der Server den
   * Kanal `rdpdr` nicht eroeffnet, oder ist gar kein Ordner geoeffnet, bleibt
   * es bei einem Protokolleintrag. Keine Meldung, kein Fehler - die Sitzung
   * verhaelt sich dann genau wie ohne diese Erweiterung.
   *
   * Die Rueckfrage beim Benutzer sitzt im Rueckruf `laufwerke`. Das ist kein
   * Zufall: die Sitzung ruft ihn erst auf, wenn der Handshake so weit ist,
   * dass die Geraeteankuendigung ueberhaupt hinausgehen darf. So steht der
   * modale Dialog nicht schon waehrend des Verbindungsaufbaus im Weg, und
   * eine verneinte Antwort kostet nur die Ankuendigung, nicht die Sitzung.
   */
  private starteLaufwerk(client: RdpClient): void {
    this.laufwerk?.dispose();
    this.laufwerk = undefined;
    this.arbeitsbereichHorcher?.dispose();
    this.arbeitsbereichHorcher = undefined;

    const config = vscode.workspace.getConfiguration('rdp');
    const einstellungen = leseLaufwerkEinstellungen((schluessel, vorgabe) => config.get(schluessel, vorgabe));
    if (!einstellungen.aktiv) {
      this.log('Laufwerk: in den Einstellungen abgeschaltet');
      return;
    }
    if (client.getStaticChannelId(RDPDR_CHANNEL_NAME) === undefined) {
      this.log('Laufwerk: der Server hat den Kanal rdpdr nicht eröffnet – die Umleitung bleibt aus');
      return;
    }

    const ziel = `${this.connection.host}:${this.connection.port ?? 3389}`;
    const zugriff = vscodeArbeitsbereichZugriff();

    const sitzung = new RdpdrSession({
      send: (daten) => {
        try {
          client.sendVirtualChannel(RDPDR_CHANNEL_NAME, daten);
        } catch (err) {
          // Etwa, wenn die Verbindung genau jetzt weggebrochen ist.
          this.log(`Laufwerk: Senden fehlgeschlagen – ${(err as Error).message}`);
        }
      },
      // Der Rechnername taucht im Explorer neben dem Laufwerk auf
      // ("VS Code auf VSCODE"), deshalb kein technischer Bezeichner.
      computerName: 'VSCODE',
      nurLesen: einstellungen.nurLesen,
      log: (nachricht) => this.log(nachricht),
      laufwerke: async () => {
        const namen = zugriff.ordnernamen();
        if (namen.length === 0) {
          // Ein Fenster ohne geöffneten Ordner ist der Normalfall beim
          // schnellen Nachschlagen - kein Grund für eine Rückfrage.
          this.log('Laufwerk: kein Ordner im Arbeitsbereich geöffnet – nichts freizugeben');
          return [];
        }
        const angezeigt = eindeutigeOrdnernamen([...namen]);
        const erlaubt = await frageFreigabe(this.context, ziel, angezeigt, einstellungen.nurLesen);
        if (!erlaubt) {
          this.log(`Laufwerk: Freigabe für ${ziel} nicht erteilt – die Ordner bleiben hier`);
          return [];
        }
        this.log(
          `Laufwerk: gebe ${angezeigt.length} Ordner frei (${angezeigt.join(', ')}), ` +
            `${einstellungen.nurLesen ? 'nur lesen' : 'lesen und schreiben'}`,
        );
        return [
          baueLaufwerk({
            zugriff,
            einstellungen,
            log: (nachricht) => this.log(nachricht),
          }),
        ];
      },
    });
    this.laufwerk = sitzung;

    // Änderungen am Arbeitsbereich wirken sich unterschiedlich aus, und das
    // gehört ins Protokoll, damit niemand vergeblich im Explorer sucht:
    // ein neuer oder entfernter Ordner erscheint beim nächsten Blättern von
    // selbst, weil die Ordnerliste bei jedem Zugriff frisch geholt wird. Die
    // Freigabe selbst wird dagegen nur einmal je Sitzung erteilt - wer ganz
    // ohne Ordner verbunden hat, braucht eine neue Sitzung.
    this.arbeitsbereichHorcher = vscode.workspace.onDidChangeWorkspaceFolders((ereignis) => {
      const dazu = ereignis.added.map((o) => o.name).join(', ');
      const weg = ereignis.removed.map((o) => o.name).join(', ');
      const teile: string[] = [];
      if (dazu) teile.push(`+ ${dazu}`);
      if (weg) teile.push(`− ${weg}`);
      if (teile.length === 0) return;
      if (sitzung.istBereit) {
        this.log(
          `Laufwerk: Arbeitsbereich geändert (${teile.join(', ')}) – ` +
            'im Explorer sichtbar, sobald der Ordner neu eingelesen wird (F5)',
        );
      } else {
        this.log(`Laufwerk: Arbeitsbereich geändert (${teile.join(', ')})`);
      }
    });

    this.log(
      `Laufwerk: Kanal rdpdr bereit (${einstellungen.nurLesen ? 'nur lesen' : 'lesen und schreiben'}, ` +
        `${einstellungen.ausschluss.length} Ausschlussmuster)`,
    );
  }

  // ------------------------------------------------------- Zwischenablage

  /**
   * Die Zwischenablage an die stehende Verbindung haengen.
   *
   * Rueckfallebene: Hat der Server den Kanal `cliprdr` nicht eroeffnet, bleibt
   * es bei einem Protokolleintrag. Keine Meldung, kein Fehler - die Sitzung
   * verhaelt sich dann genau wie ohne diese Erweiterung.
   */
  private starteZwischenablage(client: RdpClient): void {
    this.zwischenablage?.dispose();
    this.zwischenablage = undefined;

    const config = vscode.workspace.getConfiguration('rdp');
    const einstellungen = leseZwischenablageEinstellungen((schluessel, vorgabe) => config.get(schluessel, vorgabe));
    this.sendeZwischenablageKonfiguration(einstellungen);
    if (!einstellungen.aktiv) {
      this.log('Zwischenablage: in den Einstellungen abgeschaltet');
      return;
    }
    if (client.getStaticChannelId(CLIPRDR_CHANNEL_NAME) === undefined) {
      this.log('Zwischenablage: der Server hat den Kanal cliprdr nicht eröffnet – sie bleibt aus');
      return;
    }

    // Eigener Protokollstrom mit Stufen: der Handshake soll im Normalbetrieb
    // knapp bleiben, sich auf `debug` aber PDU fuer PDU nachlesen lassen.
    const stufe = config.get<LogLevel>('logLevel', 'info');
    const protokoll = createLogger(stufe, (l, msg) => this.log(l === 'info' ? msg : `[${l}] ${msg}`));

    const bruecke = new Zwischenablagebruecke({
      einstellungen,
      send: (daten) => {
        try {
          client.sendVirtualChannel(CLIPRDR_CHANNEL_NAME, daten);
        } catch (err) {
          // Etwa, wenn die Verbindung genau jetzt weggebrochen ist.
          this.log(`Zwischenablage: Senden fehlgeschlagen – ${(err as Error).message}`);
        }
      },
      speicher: vsCodeZwischenablage,
      anWebview: (nachricht) => this.post(nachricht),
      log: (nachricht, s) => protokoll[s ?? 'info'](nachricht),
    });
    this.zwischenablage = bruecke;

    this.log(
      `Zwischenablage: Kanal cliprdr bereit (Richtung ${einstellungen.richtung}, ` +
        `Grenze ${Math.round(einstellungen.maxBytes / 1024)} KiB)`,
    );
    if (this.panel.visible) {
      void bruecke.pruefeLokal();
      bruecke.starteAbfrage();
    }
  }

  /** Das Rueckfallfeld im Webview ein- oder ausblenden. */
  private schalteZwischenablagefeldUm(): void {
    this.zwischenablageFeldSichtbar = !this.zwischenablageFeldSichtbar;
    this.post({ type: 'clipboardPanel', sichtbar: this.zwischenablageFeldSichtbar });
  }

  /** Richtung und Schalterzustand ans Webview geben, damit es die Knöpfe sperrt. */
  private sendeZwischenablageKonfiguration(einstellungen: ZwischenablageEinstellungen): void {
    const config = vscode.workspace.getConfiguration('rdp');
    this.post({
      type: 'clipboardConfig',
      aktiv: einstellungen.aktiv,
      richtung: config.get<string>('clipboard.direction', 'both'),
    });
  }

  /**
   * Sicherheitsnetz gegen einen leeren Bildschirm.
   *
   * Der Server schickt den Desktop von sich aus nur einmal direkt nach der
   * Aktivierung. Kommt dabei nichts an, hilft nur eine ausdrueckliche
   * Vollbildanforderung. Die wird bewusst erst gestellt, wenn wirklich noch
   * nichts gezeichnet wurde - im Normalfall waere sie ein unnoetiges Vollbild
   * ueber die Leitung.
   */
  private startWatchdog(client: RdpClient): void {
    this.clearWatchdog();

    this.watchdogTimers.push(
      setTimeout(() => {
        if (this.painted || this.disposed) return;
        this.log('Nach 1,2 s noch kein Bild – fordere ein Vollbild an und stoße die Sitzung an');
        // Ausgabe ausdrücklich erlauben und eine Mausbewegung schicken: manche
        // Server beginnen erst mit dem Zeichnen, wenn der Client Aktivität zeigt.
        client.setOutputSuppressed(false);
        client.sendMouseMove(Math.floor(client.width / 2), Math.floor(client.height / 2));
        if (!client.refresh()) {
          this.log('Server unterstützt keine Vollbildanforderung – warte weiter auf Updates');
        }
      }, 1200),
    );

    this.watchdogTimers.push(
      setTimeout(() => {
        if (this.painted || this.disposed) return;
        const d = client.getDiagnostics();
        const liste = (m: Record<string, number>) =>
          Object.keys(m).length
            ? Object.entries(m)
                .map(([code, n]) => `${code}×${n}`)
                .join(', ')
            : 'keine';
        this.log(
          [
            'Nach 6 s kein Bild gezeichnet:',
            `  Rahmen empfangen: ${d.frames.fastpath} Fastpath, ${d.frames.slowpath} Slowpath, ${d.frames.verworfen} verworfen`,
            `  Fastpath-Updates: ${liste(d.updateCodes)}`,
            `  Share-PDUs:       ${liste(d.sharePduTypes)}`,
            `  Daten-PDUs:       ${liste(d.dataPduTypes)}`,
            `  Kacheln dekodiert: ${d.bitmaps} · I/O-Kanal: ${d.ioChannelId} · Aktivierungen: ${d.activations}`,
            `  Graphics Pipeline: ${d.graphicsBytes} Byte entpackt · Codecs: ${liste(d.graphicsCodecs)}`,
            `  Dynamische Kanäle: ${d.dynamicChannels.join(', ') || 'keine'}`,
            `  Vollbildanforderung möglich: ${d.supportsRefreshRect}`,
          ].join('\n'),
        );
        // Die Unterscheidung ist wichtig: kommt gar nichts an, liegt es am
        // Protokoll; kommt etwas an und wird nichts gezeichnet, an der Anzeige.
        const nichtsEmpfangen = d.frames.fastpath + d.frames.slowpath === 0;
        const hinweis = nichtsEmpfangen
          ? 'Der Server sendet überhaupt keine Daten. Ein Klick ins Fenster kann die Sitzung anstoßen; sonst hilft „RDP: Protokoll anzeigen“.'
          : d.bitmaps > 0
            ? 'Der Server sendet Bilddaten, sie erreichen aber die Zeichenfläche nicht. Bitte „RDP: Protokoll anzeigen“ öffnen.'
            : 'Der Server sendet Daten, aber keine Bilddaten. Einzelheiten unter „RDP: Protokoll anzeigen“.';
        this.setState('waiting', 'Verbunden, aber kein Bild', hinweis, 'Erneut verbinden');
        client.refresh();
      }, 6000),
    );
  }

  private clearWatchdog(): void {
    for (const timer of this.watchdogTimers) clearTimeout(timer);
    this.watchdogTimers = [];
  }

  // -------------------------------------------------------------- Diagnose

  /**
   * Blendet das Overlay ein oder aus.
   *
   * Ist es aus, laeuft kein Zeitgeber, es wird nichts abgefragt und im
   * Zeichenpfad bleibt nur eine Abfrage eines Wahrheitswerts uebrig.
   */
  setzeDiagnose(sichtbar: boolean): void {
    this.diagnoseSichtbar = sichtbar;
    this.post({ type: 'diagnose', sichtbar });
    if (this.diagnoseTimer) {
      clearInterval(this.diagnoseTimer);
      this.diagnoseTimer = undefined;
    }
    if (!sichtbar || this.disposed) {
      // Die Zaehler zuruecksetzen: beim naechsten Einschalten sollen die Raten
      // nicht aus einem Zeitraum stammen, in dem gar nicht gemessen wurde.
      this.letzteProbe = undefined;
      this.rttMs = undefined;
      return;
    }
    this.sendeDiagnose();
    this.diagnoseTimer = setInterval(() => this.sendeDiagnose(), DIAGNOSE_TAKT_MS);
  }

  /** Nur fuer Tests und die Statusanzeige: ist das Overlay eingeblendet? */
  get diagnoseAktiv(): boolean {
    return this.diagnoseSichtbar;
  }

  private diagnoseZaehlerZuruecksetzen(): void {
    this.anWebviewBytes = 0;
    this.anWebviewKacheln = 0;
    this.letztesBild = 0;
    this.verbundenSeit = 0;
    this.letzteProbe = undefined;
    this.rttMs = undefined;
  }

  /** Eine Messung nehmen, mit der vorigen vergleichen und hinueberschicken. */
  private sendeDiagnose(): void {
    if (this.disposed || !this.diagnoseSichtbar) return;
    const jetzt: DiagnoseProbe = {
      zeit: Date.now(),
      diagnostics: this.client?.getDiagnostics(),
      anWebviewBytes: this.anWebviewBytes,
      anWebviewKacheln: this.anWebviewKacheln,
      letztesBild: this.letztesBild,
    };
    const zeilen = diagnoseZeilen(jetzt, this.letzteProbe, {
      breite: this.client?.width ?? this.lastReady?.width ?? 0,
      hoehe: this.client?.height ?? this.lastReady?.height ?? 0,
      verbundenSeit: this.verbundenSeit,
      rttMs: this.rttMs,
      base64: this.useBase64,
    });
    this.letzteProbe = jetzt;
    this.post({ type: 'diagnose', sichtbar: true, titel: this.title, zeilen });

    // Den Roundtrip erst nach dem Senden messen: die Antwort traegt zur
    // naechsten Runde bei und haelt diese hier kurz.
    this.rttSeq++;
    this.rttGesendet = Date.now();
    this.post({ type: 'diagnosePing', seq: this.rttSeq });
  }

  /** Fasst alle Kacheln eines Updates zu genau einer Nachricht zusammen. */
  private sendTiles(tiles: DecodedBitmap[]): void {
    const rects: Array<{ x: number; y: number; w: number; h: number; offset: number; length: number }> = [];
    const buffers: Buffer[] = [];
    let offset = 0;

    for (const tile of tiles) {
      const bytes = Buffer.from(tile.rgba.buffer, tile.rgba.byteOffset, tile.rgba.byteLength);
      rects.push({ x: tile.x, y: tile.y, w: tile.width, h: tile.height, offset, length: bytes.length });
      buffers.push(bytes);
      offset += bytes.length;
    }

    // Der einzige Messpunkt im Zeichenpfad: zwei Additionen, und auch die nur,
    // wenn das Overlay wirklich zusieht.
    if (this.diagnoseSichtbar) {
      this.anWebviewBytes += offset;
      this.anWebviewKacheln += rects.length;
      this.letztesBild = Date.now();
    }

    this.post({ type: 'bitmap', rects, data: this.encode(Buffer.concat(buffers, offset)) });
  }

  /**
   * Reicht ein H.264-Teilbild an das Webview weiter.
   *
   * Dekodiert wird drueben: der Renderer laeuft in Chromium und hat mit
   * WebCodecs einen hardwarebeschleunigten Decoder, der Extension-Host hat
   * keinen. Hier entsteht nur die Nachricht - Bitstream, die schon
   * ausgerechneten Zeichenbereiche und die beiden Angaben, die der Decoder
   * zum Konfigurieren braucht.
   */
  private sendVideo(frame: EgfxVideoFrame): void {
    // AVC444 kommt hier nicht an, solange der Capabilityssatz unter Version 10
    // bleibt. Sollte ein Server es trotzdem schicken, ist Wegwerfen ehrlicher
    // als ein halb zusammengesetztes Bild: die Ebenenzuordnung ist nicht
    // gebaut.
    if (frame.codecId !== 0x000b) {
      if (!this.avc444Gemeldet) {
        this.avc444Gemeldet = true;
        this.log(
          `H.264 in YUV444 (Codec 0x${frame.codecId.toString(16)}) wird nicht dekodiert - ` +
            'diese Bildbereiche bleiben leer.',
        );
      }
      return;
    }
    if (!frame.yuv420 || !frame.analyse) return;

    // Nicht abgebildete Surfaces liefern nichts auf den Bildschirm - der
    // Bitstream muss aber trotzdem durch den Decoder, sonst fehlt spaeteren
    // Folgebildern ihr Bezugsbild. Deshalb leere Bereichsliste statt Abbruch.
    const bereiche = frame.abgebildet ? avcZeichenbereiche(frame.yuv420.regions, frame.surface) : [];

    const bytes = Buffer.from(
      frame.yuv420.bitstream.buffer,
      frame.yuv420.bitstream.byteOffset,
      frame.yuv420.bitstream.byteLength,
    );
    if (this.diagnoseSichtbar) {
      this.anWebviewBytes += bytes.length;
      this.letztesBild = Date.now();
    }

    this.post({
      type: 'video',
      codecString: frame.analyse.codecString,
      schluesselbild: frame.analyse.schluesselbild,
      hatParametersaetze: frame.analyse.hatParametersaetze,
      bereiche,
      data: this.encode(bytes),
      laenge: bytes.length,
    });
  }

  private encode(buffer: Buffer): Uint8Array | string {
    return this.useBase64 ? buffer.toString('base64') : new Uint8Array(buffer);
  }

  // -------------------------------------------------------------- Eingaben

  private handleMouse(message: any): void {
    const client = this.client;
    if (!client?.isConnected) return;

    switch (message.kind) {
      case 'move':
        client.sendMouseMove(message.x, message.y);
        break;

      case 'button': {
        const { x, y, down } = message;
        switch (message.button) {
          case 'left':
            client.sendMouseButton(x, y, PTRFLAGS_BUTTON1, down);
            break;
          case 'right':
            client.sendMouseButton(x, y, PTRFLAGS_BUTTON2, down);
            break;
          case 'middle':
            client.sendMouseButton(x, y, PTRFLAGS_BUTTON3, down);
            break;
          case 'back':
            client.sendMouseExtendedButton(x, y, PTRXFLAGS_BUTTON1, down);
            break;
          case 'forward':
            client.sendMouseExtendedButton(x, y, PTRXFLAGS_BUTTON2, down);
            break;
        }
        break;
      }

      case 'wheel': {
        const base = message.horizontal ? PTRFLAGS_HWHEEL : PTRFLAGS_WHEEL;
        // Die Drehung steht als vorzeichenbehafteter 9-Bit-Wert in den unteren Bits.
        const flags =
          message.delta > 0
            ? base | WHEEL_STEP
            : base | PTRFLAGS_WHEEL_NEGATIVE | ((0x100 - WHEEL_STEP) & 0xff);
        client.sendPointerEvent(message.x, message.y, flags);
        break;
      }
    }
  }

  /** Zustand der Cmd-Taste; nur in Gebrauch, solange `cmdAufStrg` gilt. */
  private readonly macAbbildung = new MacTastenabbildung();
  /** Bildet Cmd auf Strg ab (Einstellung `rdp.macCommandKey`). */
  private cmdAufStrg = false;
  /** Rohe Plattformauskunft des Webviews, sobald sie da ist. */
  private webviewPlattform: string | undefined;

  /**
   * Die Meldung des Webviews auswerten und die Abbildung neu entscheiden.
   *
   * Aufgerufen, sobald das Webview seine Plattform nennt, und erneut, wenn
   * sich die Einstellung aendert.
   */
  private setzeTastaturPlattform(roh: string | undefined): void {
    if (roh !== undefined) this.webviewPlattform = roh;
    const gewaehlt = tastaturPlattform(ermittleLaufzeit(), this.webviewPlattform);
    const einstellung = vscode.workspace
      .getConfiguration('rdp')
      .get<CmdAbbildungEinstellung>('macCommandKey', 'auto');
    const vorher = this.cmdAufStrg;
    this.cmdAufStrg = cmdAbbildungAktiv(einstellung, gewaehlt.plattform, gewaehlt.verlaesslich);
    if (!this.cmdAufStrg) this.macAbbildung.zuruecksetzen();
    if (this.cmdAufStrg === vorher && roh === undefined) return;
    this.log(
      `Tastatur: Plattform ${gewaehlt.plattform} (${gewaehlt.quelle}` +
        `${gewaehlt.verlaesslich ? '' : ', unzuverlässig'}), Einstellung "${einstellung}" – ` +
        `Cmd-Kürzel werden ${this.cmdAufStrg ? 'auf Strg abgebildet' : 'nicht abgebildet'}`,
    );
  }

  private handleKey(message: any): void {
    const client = this.client;
    if (!client?.isConnected) return;

    // Beim ersten Tastendruck den Zustand der Feststelltasten angleichen.
    if (!this.modifiersSynced && message.modifiers) {
      let flags = 0;
      if (message.modifiers.capsLock) flags |= SYNC_CAPS_LOCK;
      if (message.modifiers.numLock) flags |= SYNC_NUM_LOCK;
      if (message.modifiers.scrollLock) flags |= SYNC_SCROLL_LOCK;
      client.sendSyncEvent(flags);
      this.modifiersSynced = true;
    }

    if (this.cmdAufStrg) {
      const ergebnis = this.macAbbildung.taste(String(message.code ?? ''), !!message.down);
      for (const t of ergebnis.ereignisse) client.sendKeyScancode(t.scancode, t.down, t.extended);
      if (!ergebnis.normalWeiter) return;
    }

    const mapping = lookupScancode(message.code);
    if (mapping) {
      client.sendKeyScancode(mapping.code, message.down, mapping.extended === true);
      return;
    }

    // Nicht zugeordnete Taste: als Unicode-Zeichen senden, sofern es eines ist.
    if (typeof message.key === 'string' && [...message.key].length === 1) {
      client.sendUnicode(message.key.codePointAt(0)!, message.down);
    }
  }

  /** Strg+Alt+Entf - vom Browser nicht abfangbar, daher als Befehl. */
  sendCtrlAltDelete(): void {
    const client = this.client;
    if (!client?.isConnected) return;
    client.sendKeyScancode(0x1d, true); // Strg
    client.sendKeyScancode(0x38, true); // Alt
    client.sendKeyScancode(0x53, true, true); // Entf (erweitert)
    client.sendKeyScancode(0x53, false, true);
    client.sendKeyScancode(0x38, false);
    client.sendKeyScancode(0x1d, false);
  }

  refreshScreen(): void {
    this.client?.refresh();
  }

  // ------------------------------------------------------------ Screenshot

  /**
   * Bittet das Webview um den derzeitigen Bildschirminhalt.
   *
   * Der Extension-Host kommt an die Zeichenflaeche nicht heran - sie lebt im
   * Renderer-Prozess. Er kennt zwar alle Kacheln, die er selbst dorthin
   * geschickt hat, haette sie aber alle mitschreiben muessen, und der
   * H.264-Weg wird ueberhaupt erst im Webview dekodiert. Also fragt er dort
   * nach; die Antwort kommt als `screenshot`-Nachricht zurueck.
   */
  screenshot(): void {
    if (!this.painted) {
      vscode.window.showInformationMessage('Es ist noch kein Bildschirminhalt da, den man sichern könnte.');
      return;
    }
    this.screenshotLauf++;
    this.post({ type: 'screenshotAnfrage', id: this.screenshotLauf });
  }

  /**
   * Die Bilddaten aus dem Webview in eine Datei.
   *
   * Warum der Umweg ueber den Extension-Host: ein `<a download>` im Webview
   * funktioniert dort nicht verlaesslich - der Sandkasten unterbindet den
   * Download stillschweigend. `vscode.workspace.fs` schreibt dagegen auch
   * unter Remote-SSH auf die richtige Seite der Verbindung.
   */
  private async speichereScreenshot(nachricht: { dataUrl?: unknown; fehler?: unknown }): Promise<void> {
    const bild = bildAusDatenUrl(nachricht.dataUrl);
    if (!bild) {
      const grund = typeof nachricht.fehler === 'string' ? nachricht.fehler : 'keine verwertbaren Bilddaten';
      this.log(`Screenshot fehlgeschlagen: ${grund}`);
      vscode.window.showErrorMessage(`Der Bildschirminhalt ließ sich nicht sichern: ${grund}`);
      return;
    }

    const vorschlag = screenshotDateiname(this.title, new Date());
    const ordner = vscode.workspace.getConfiguration('rdp').get<string>('screenshotFolder', '').trim();
    const ziel = await vscode.window.showSaveDialog({
      title: 'Screenshot der RDP-Sitzung speichern',
      saveLabel: 'Speichern',
      defaultUri: ordner
        ? vscode.Uri.joinPath(vscode.Uri.file(ordner), vorschlag)
        : vscode.Uri.file(vorschlag),
      filters: { 'PNG-Bilder': ['png'] },
    });
    if (!ziel) return;

    await vscode.workspace.fs.writeFile(ziel, bild);
    this.log(`Screenshot gesichert: ${ziel.fsPath} (${mengeText(bild.length)})`);
    // Das Bild selbst laesst sich nicht anbieten: `vscode.env.clipboard` kann
    // ausschliesslich Text. Der Pfad ist das Naechstbeste.
    const antwort = await vscode.window.showInformationMessage(
      `Screenshot gespeichert: ${ziel.fsPath}`,
      'Pfad kopieren',
    );
    if (antwort === 'Pfad kopieren') await vscode.env.clipboard.writeText(ziel.fsPath);
  }

  // ----------------------------------------------------------- Kennfarbe

  /**
   * Rahmenfarbe und -breite ans Webview.
   *
   * Die Farbe steckt schon in `this.connection`: geoeffnet wird immer die
   * aufgeloeste Fassung, die Ordnervererbung ist also bereits angewandt,
   * bevor die Sitzung ueberhaupt entsteht.
   */
  private sendeFarbe(): void {
    const kennung = farbeZu(this.connection.color);
    const breite = Math.max(
      0,
      Math.round(vscode.workspace.getConfiguration('rdp').get<number>('colorFrameWidth', RAHMEN_BREITE_PX)),
    );
    this.post({
      type: 'farbe',
      hex: kennung?.hex,
      titel: kennung?.titel,
      // Ohne Kennfarbe kein Rahmen - und ohne Rahmen keine Breite.
      breite: kennung ? breite : 0,
    });
  }

  applyConfiguration(): void {
    const config = vscode.workspace.getConfiguration('rdp');
    this.post({
      type: 'config',
      scaling: config.get<string>('scaling', 'fit'),
      smooth: config.get<boolean>('smoothScaling', false),
    });
    // Die Rahmenbreite steht in den Einstellungen und darf sich sofort
    // auswirken - die Kennfarbe selbst haengt an der Verbindung.
    this.sendeFarbe();
    // Die Cmd-Abbildung greift ohne Neuverbinden; die Plattform ist bekannt.
    this.setzeTastaturPlattform(undefined);
    // Richtung und Groessengrenze stecken in der Bruecke; sie greifen erst bei
    // der naechsten Verbindung. Die Knopfsperre im Webview laesst sich dagegen
    // sofort nachziehen.
    this.sendeZwischenablageKonfiguration(
      leseZwischenablageEinstellungen((schluessel, vorgabe) => config.get(schluessel, vorgabe)),
    );
  }

  toggleScaling(): void {
    const config = vscode.workspace.getConfiguration('rdp');
    const next = config.get<string>('scaling', 'fit') === 'fit' ? 'none' : 'fit';
    config.update('scaling', next, vscode.ConfigurationTarget.Global);
  }

  reveal(): void {
    this.panel.reveal();
  }

  get title(): string {
    return this.connection.name || this.connection.host;
  }

  get isConnected(): boolean {
    return this.client?.isConnected === true;
  }

  // ----------------------------------------------------------------- Intern

  private post(message: unknown): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  private setState(
    state: 'connecting' | 'waiting' | 'connected' | 'error' | 'closed',
    title?: string,
    message?: string,
    action?: string,
  ): void {
    this.post({ type: 'state', state, title, message, action });
  }

  private updateStatusBar(): void {
    if (!this.isConnected) {
      this.statusBar.hide();
      return;
    }
    const kennung = farbeZu(this.connection.color);
    this.statusBar.text = `$(vm-active) ${this.title}`;
    this.statusBar.tooltip = kennung
      ? `RDP-Sitzung aktiv: ${this.connection.host} · ${kennung.titel}`
      : `RDP-Sitzung aktiv: ${this.connection.host}`;
    // Bewusst nur die Vordergrundfarbe: `backgroundColor` nimmt laut API
    // ausschliesslich statusBarItem.errorBackground und
    // statusBarItem.warningBackground an - jede andere ThemeColor bliebe
    // wirkungslos.
    this.statusBar.color = kennung ? new vscode.ThemeColor(kennung.themeFarbe) : undefined;
    this.statusBar.show();
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString('de-DE')}] ${this.connection.host}: ${message}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearWatchdog();
    if (this.diagnoseTimer) {
      clearInterval(this.diagnoseTimer);
      this.diagnoseTimer = undefined;
    }
    RdpSession.vergissSitzung(this);
    this.zwischenablage?.dispose();
    this.zwischenablage = undefined;
    // Ohne dispose() liefen asynchrone Dateioperationen weiter und schickten
    // ihre Antworten in eine Verbindung, die es nicht mehr gibt.
    this.laufwerk?.dispose();
    this.laufwerk = undefined;
    this.arbeitsbereichHorcher?.dispose();
    this.arbeitsbereichHorcher = undefined;
    this.client?.disconnect();
    this.client = undefined;
    this.statusBar.hide();
    vscode.commands.executeCommand('setContext', 'rdp.sessionFocused', false);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
    this.onDispose?.();
  }

  onDispose?: () => void;
}

/**
 * Die Zwischenablage von VS Code als `ZwischenablageSpeicher`.
 *
 * Der grosse Vorteil gegenueber dem Weg ueber das Webview: der Extension-Host
 * braucht keine Benutzergeste. Sie ist deshalb der Normalweg, und das Textfeld
 * springt nur ein, wenn hier etwas schiefgeht.
 */
const vsCodeZwischenablage: ZwischenablageSpeicher = {
  lesen: () => Promise.resolve(vscode.env.clipboard.readText()),
  schreiben: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
};

/** Node liefert Fingerabdruecke ohne Doppelpunkte - Darstellung angleichen. */
function formatFingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/:/g, '').toUpperCase();
  return clean.match(/.{2}/g)?.join(':');
}

/** Uebersetzt technische Fehler in eine Erklaerung mit Handlungshinweis. */
function humanizeError(err: Error): string {
  const message = err.message;
  if (isTlsCompatibilityError(err)) {
    return (
      'Der TLS-Handshake ist an einer Unverträglichkeit gescheitert – auch der Versuch mit ' +
      'älteren Verfahren (statischer RSA-Schlüsselaustausch, TLS 1.2) hat nicht geholfen.\n\n' +
      'Mögliche Ursachen: Der Server erlaubt nur Suiten mit Forward Secrecy, sein Zertifikat ' +
      'taugt aber nicht zum Signieren, oder RSA-Schlüsselaustausch ist per Richtlinie abgeschaltet. ' +
      'Abhilfe: dem Remotedesktopdienst ein Zertifikat mit der Schlüsselverwendung ' +
      '"Digitale Signatur" zuweisen.\n\n' +
      `Ursprüngliche Meldung: ${message}`
    );
  }
  if (/ECONNREFUSED/.test(message)) {
    return 'Der Server nimmt keine Verbindung an. Läuft der Remotedesktopdienst und ist Port 3389 freigegeben?';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return 'Der Hostname konnte nicht aufgelöst werden.';
  }
  if (/ETIMEDOUT|Zeitueberschreitung|Zeitüberschreitung/.test(message)) {
    return 'Zeitüberschreitung. Firewall, VPN oder Erreichbarkeit des Hosts prüfen.';
  }
  if (/CredSSP|Kanalbindung/.test(message)) {
    return `${message}\n\nHäufigste Ursache: falscher Benutzername oder falsches Passwort.`;
  }
  if (/Lizenz/.test(message)) {
    return message;
  }
  return message;
}
