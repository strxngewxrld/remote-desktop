/**
 * RDP-Client: fuehrt die Verbindungssequenz durch und uebersetzt danach
 * Server-Updates in Events bzw. Benutzereingaben in Input-PDUs.
 *
 * Ablauf (MS-RDPBCGR 1.3.1.1):
 *   X.224-Aushandlung -> TLS -> CredSSP -> MCS -> Client Info -> Lizenz ->
 *   Capability Exchange -> aktive Sitzung
 */
import { EventEmitter } from 'node:events';
import * as tls from 'node:tls';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { BinaryReader } from './core/binary.js';
import { backoffWartezeit, BackoffOptions, STANDARD_BACKOFF } from './core/backoff.js';
import { createLogger, Logger, LogLevel, LogSink, nullLogger } from './core/log.js';
import { ERROR_INFO_CODES, RdpError, RdpProtocolError } from './core/errors.js';
import { CredSspClient } from './crypto/credssp.js';
import { parseFrame, RdpFrame, RdpTransport, tpkt, tpktRaw } from './protocol/transport.js';
import {
  buildChannelChunks,
  ChannelReassembler,
  parseChannelChunk,
} from './protocol/virtualChannel.js';
import * as dvc from './protocol/dvc.js';
import { ZgfxDecompressor } from './codec/zgfx.js';
import { EgfxSession } from './protocol/egfxSession.js';
import type { EgfxCapsSet } from './protocol/egfx.js';
import {
  LEGACY_TLS_EXPLANATION,
  LEGACY_TLS_PROFILE,
  MODERN_TLS_PROFILE,
  TlsProfile,
  isTlsCompatibilityError,
} from './protocol/tlsProfiles.js';
import { buildConnectionRequest, parseConnectionConfirm } from './protocol/x224.js';
import * as mcs from './protocol/mcs.js';
import * as gcc from './protocol/gcc.js';
import * as pdu from './protocol/pdu.js';
import { buildClientCapabilities, CapabilityProfile, ServerCapabilities } from './protocol/caps.js';
import { buildClientInfo, evaluateLicense, parseLicensePdu } from './protocol/sec.js';
import {
  buildAutoReconnectCookie,
  parseSaveSessionInfo,
  ServerAutoReconnectPacket,
  SITZUNG_ENDGUELTIG_BEENDET,
} from './protocol/autoReconnect.js';
import {
  BitmapRectangle,
  DecodedBitmap,
  decodeBitmap,
  parseBitmapUpdate,
  parsePaletteUpdate,
  parsePointerImage,
  parseSurfaceCommands,
  decodeSurfaceBits,
  PointerImage,
} from './protocol/updates.js';
import {
  FASTPATH_FRAGMENT_LAST,
  FASTPATH_FRAGMENT_NEXT,
  FASTPATH_FRAGMENT_SINGLE,
  FASTPATH_OUTPUT_COMPRESSION_USED,
  FASTPATH_UPDATETYPE_BITMAP,
  FASTPATH_UPDATETYPE_CACHED,
  FASTPATH_UPDATETYPE_COLOR,
  FASTPATH_UPDATETYPE_PALETTE,
  FASTPATH_UPDATETYPE_POINTER,
  FASTPATH_UPDATETYPE_PTR_DEFAULT,
  FASTPATH_UPDATETYPE_PTR_NULL,
  FASTPATH_UPDATETYPE_PTR_POSITION,
  FASTPATH_UPDATETYPE_SURFCMDS,
  KBDFLAGS_DOWN,
  KBDFLAGS_EXTENDED,
  KBDFLAGS_RELEASE,
  MCS_GLOBAL_CHANNEL,
  PDUTYPE_DATAPDU,
  PDUTYPE_DEACTIVATEALLPDU,
  PDUTYPE_DEMANDACTIVEPDU,
  PDUTYPE2_CONTROL,
  PDUTYPE2_FONTLIST,
  PDUTYPE2_FONTMAP,
  PDUTYPE2_INPUT,
  PDUTYPE2_PLAY_SOUND,
  PDUTYPE2_POINTER,
  PDUTYPE2_REFRESH_RECT,
  PDUTYPE2_SAVE_SESSION_INFO,
  PDUTYPE2_SHUTDOWN_DENIED,
  PDUTYPE2_SHUTDOWN_REQUEST,
  PDUTYPE2_SUPPRESS_OUTPUT,
  PDUTYPE2_SYNCHRONIZE,
  PDUTYPE2_SET_ERROR_INFO_PDU,
  PDUTYPE2_UPDATE,
  PROTOCOL_HYBRID,
  PROTOCOL_RDP,
  PROTOCOL_SSL,
  PTRFLAGS_DOWN,
  PTRFLAGS_MOVE,
  PTRMSGTYPE_CACHED,
  PTRMSGTYPE_COLOR,
  PTRMSGTYPE_POINTER,
  PTRMSGTYPE_POSITION,
  PTRMSGTYPE_SYSTEM,
  SEC_INFO_PKT,
  SEC_LICENSE_PKT,
  UPDATETYPE_BITMAP,
  UPDATETYPE_PALETTE,
} from './protocol/constants.js';

export interface RdpClientOptions {
  host: string;
  port?: number;
  domain?: string;
  username?: string;
  password?: string;
  /** Breite in Pixeln (Vielfaches von 4 ist guenstig). */
  width?: number;
  height?: number;
  /**
   * 15, 16, 24 oder 32. Standard ist 16.
   *
   * Auf dem klassischen Ausgabeweg komprimiert der Server Bitmaps bis 24 bpp
   * mit Interleaved RLE - das beherrscht dieser Client. Bei 32 bpp nimmt er
   * stattdessen den planaren Codec (RDP 6.0), der noch fehlt. Sobald der
   * implementiert ist, wird 32 der sinnvollere Standard.
   *
   * Die Angabe ist ohnehin nur ein Wunsch: der Server gibt die Farbtiefe im
   * Demand Active PDU vor, und diese Vorgabe wird uebernommen.
   */
  colorDepth?: number;
  /** Windows-Tastaturlayout-ID, z.B. 0x407 fuer Deutsch. */
  keyboardLayout?: number;
  clientName?: string;
  /** NLA (CredSSP) verwenden. Ohne Zugangsdaten nicht moeglich. */
  useNla?: boolean;
  /** Nur TLS ohne NLA zulassen (aeltere Server, xrdp mit Standardkonfiguration). */
  allowTlsOnly?: boolean;
  /**
   * Hoechste DVC-Version, die bestaetigt wird (MS-RDPEDYC 2.2.1.2). Der Server
   * bietet eine an, bestaetigt wird das Minimum aus beidem.
   */
  dvcVersion?: number;
  /** RDP-Version in der Client Core Data (MS-RDPBCGR 2.2.1.3.2). */
  clientVersion?: number;
  /** Buildnummer in der Client Core Data. */
  clientBuild?: number;
  /** Optionsfeld fuer den Kanal drdynvc in der Client Network Data (2.2.1.3.4). */
  dynvcChannelOptions?: number;
  /** Client Monitor Data mitschicken (MS-RDPBCGR 2.2.1.3.6). */
  monitorLayout?: boolean;
  /**
   * Die Annahme des Grafikkanals um so viele Millisekunden verzoegern. Nur zur
   * Fehlersuche: ein echter Client braucht dafuer rund 10 ms, wir antworten
   * sonst in unter einer.
   */
  graphicsAcceptDelayMs?: number;
  /**
   * Wartezeit zwischen der Annahme des Grafikkanals und der CAPS_ADVERTISE.
   * Der Windows-Client laesst hier rund 36 ms verstreichen.
   */
  graphicsCapsDelayMs?: number;
  /** Jede Kachel samt Lage und Rohdaten melden - zur Fehlersuche an Bildfehlern. */
  onRohkachel?: (info: {
    codecId: number;
    surfaceId: number;
    rect: { left: number; top: number; right: number; bottom: number };
    data: Buffer;
  }) => void;
  /** Nicht dekodierbare Kacheln melden - zum Sichern echter Testdaten. */
  onUnbekannteKachel?: (info: { codecId: number; width: number; height: number; data: Buffer }) => void;
  /** earlyCapabilityFlags der Client Core Data vollstaendig selbst bestimmen. */
  earlyCapabilityFlags?: number;
  /** Weitere statische Kanaele anmelden (z.B. rdpdr, rdpsnd, cliprdr). */
  extraStaticChannels?: string[];
  logLevel?: LogLevel;
  logSink?: LogSink;
  connectTimeout?: number;
  rejectUnauthorized?: boolean;
  verifyCertificate?: (cert: tls.PeerCertificate, socket: tls.TLSSocket) => void;
  performanceFlags?: number;
  /** Programm statt vollstaendigem Desktop starten. */
  alternateShell?: string;
  /**
   * Feineinstellung des Capability-Satzes. Nur noetig, wenn ein Server sich
   * ungewoehnlich verhaelt - siehe `examples/diagnose.mjs`.
   */
  capabilityProfile?: CapabilityProfile;
  /**
   * Den dynamischen virtuellen Kanal `drdynvc` anmelden und die Graphics
   * Pipeline signalisieren.
   *
   * Der Client kann die Pipeline noch *nicht* sprechen. Der Schalter dient der
   * Messung: aktuelle Windows-Server liefern Grafik nur noch auf diesem Weg,
   * und ob das so ist, zeigt sich daran, ob ueberhaupt Daten auf dem Kanal
   * eintreffen.
   */
  announceDynamicChannels?: boolean;
  /**
   * Entscheidet, welche dynamischen Kanaele angenommen werden. Ohne Angabe
   * werden alle abgelehnt - der Server erfaehrt so sauber, dass niemand
   * zuhoert, statt auf eine Antwort zu warten.
   */
  acceptDynamicChannels?: (name: string) => boolean;
  /**
   * Die Graphics Pipeline anfordern: meldet `drdynvc` an, signalisiert die
   * Pipeline im Client Core Data und nimmt den Grafikkanal an. Aktuelle
   * Windows-Server liefern Bildschirminhalte ausschliesslich auf diesem Weg.
   */
  enableGraphicsPipeline?: boolean;
  /**
   * Capability-Sets fuer die Graphics Pipeline. Ohne Angabe gilt
   * `DEFAULT_EGFX_CAPS`; abweichende Saetze dienen der Fehlersuche
   * (siehe `examples/diagnose.mjs`).
   */
  graphicsCapsSets?: EgfxCapsSet[];
  /**
   * Automatischer Wiederverbindungsaufbau nach einem Verbindungsverlust.
   *
   * Ohne Angabe bleibt er aus, und der Client verhaelt sich bis aufs Byte wie
   * bisher: kein AUTORECONNECT_SUPPORTED im Capability-Satz, kein Cookie im
   * Info-PDU, ein Verbindungsverlust endet unmittelbar in 'close'.
   */
  autoReconnect?: AutoReconnectOptions;
}

/**
 * Stellschrauben des automatischen Wiederverbindungsaufbaus.
 *
 * Die Vorgaben ueberbruecken eine kurze Netzstoerung - fuenf Versuche binnen
 * gut einer halben Minute - und geben danach auf, statt einen dauerhaft toten
 * Server endlos anzurufen.
 */
export interface AutoReconnectOptions {
  /** Standard: an, sobald dieses Objekt ueberhaupt angegeben wird. */
  enabled?: boolean;
  /** Hoechstzahl der Versuche je Verbindungsverlust (Standard 5). */
  maxAttempts?: number;
  /** Wartezeit vor dem ersten Versuch in Millisekunden (Standard 1000). */
  initialDelayMs?: number;
  /** Obergrenze der Wartezeit in Millisekunden (Standard 30000). */
  maxDelayMs?: number;
  /** Wachstumsfaktor der Wartezeit je Versuch (Standard 2). */
  factor?: number;
  /** Streuung als Anteil der Wartezeit, 0..1 (Standard 0.25). */
  jitter?: number;
  /** Zufallsquelle fuer die Streuung - nur zum Nachrechnen in Tests. */
  random?: () => number;
}

export interface RdpClientEvents {
  connect: () => void;
  bitmap: (updates: DecodedBitmap[]) => void;
  /** Neue Zeigerform, oder null fuer den Standardzeiger des Systems. */
  pointer: (pointer: PointerImage | null) => void;
  /** Der Server blendet den Zeiger aus (z.B. bei Volltextbearbeitung). */
  pointerHidden: () => void;
  /** Nutzdaten eines dynamischen virtuellen Kanals. */
  dynamicChannelData: (payload: { channelId: number; name: string; data: Buffer }) => void;
  /** Entpackte Nachricht der Graphics Pipeline (ZGFX bereits entfernt). */
  graphicsData: (data: Buffer) => void;
  pointerPosition: (pos: { x: number; y: number }) => void;
  resize: (size: { width: number; height: number }) => void;
  error: (err: Error) => void;
  close: (reason?: string) => void;
  /**
   * Die Verbindung ist weg und ein neuer Versuch ist eingeplant. Kommt vor
   * jedem Versuch einmal, mit der Wartezeit bis dahin.
   */
  reconnecting: (info: {
    /** Laufende Nummer des Versuchs, ab 1. */
    attempt: number;
    maxAttempts: number;
    /** Wartezeit bis zu diesem Versuch in Millisekunden. */
    delayMs: number;
    /** Was den Verlust ausgeloest hat, soweit bekannt. */
    reason?: string;
  }) => void;
  /**
   * Die Sitzung steht wieder. Direkt davor kam wie beim Erstaufbau ein
   * 'connect'-Ereignis - die Zeichenflaeche ist also neu einzurichten.
   */
  reconnected: (info: {
    /** Der wievielte Versuch geklappt hat. */
    attempt: number;
    /**
     * Ob ein Auto-Reconnect-Cookie mitgeschickt wurde. Nur dann konnte der
     * Server den Benutzer in seine alte Sitzung zurueckholen; sonst steht eine
     * frische Anmeldung auf der Gegenseite.
     */
    resumedSession: boolean;
  }) => void;
  /** Alle Versuche sind verbraucht. Danach folgt noch genau ein 'close'. */
  gaveUp: (info: { attempts: number; lastError?: Error; reason?: string }) => void;
  /**
   * Der Server hat einen Auto-Reconnect-Cookie hinterlegt: ab jetzt ist eine
   * Rueckkehr in dieselbe Sitzung ohne erneute Anmeldung moeglich.
   *
   * Das Schluesselmaterial selbst bleibt absichtlich drin - MS-RDPBCGR 5.5
   * verlangt, dass der Client den Cookie nicht herausgibt.
   */
  autoReconnectCookie: (info: { logonId: number; version: number }) => void;
}

export declare interface RdpClient {
  on<E extends keyof RdpClientEvents>(event: E, listener: RdpClientEvents[E]): this;
  once<E extends keyof RdpClientEvents>(event: E, listener: RdpClientEvents[E]): this;
  emit<E extends keyof RdpClientEvents>(event: E, ...args: Parameters<RdpClientEvents[E]>): boolean;
}

/** Momentaufnahme fuer die Fehlersuche - was kam an, was wurde daraus? */
export interface RdpDiagnostics {
  /** Anzahl dekodierter Bitmap-Kacheln. */
  bitmaps: number;
  /** Fastpath-Update-Arten mit Zaehler, z.B. { '0x1': 12 }. */
  updateCodes: Record<string, number>;
  supportsRefreshRect: boolean;
  /** Wie oft die Sitzung aktiviert wurde; der Erstaufbau zaehlt als 1. */
  activations: number;
  /** Kanal, auf dem gesendet wird - vom Server vorgegeben. */
  ioChannelId: number;
  frames: { fastpath: number; slowpath: number; verworfen: number };
  sharePduTypes: Record<string, number>;
  dataPduTypes: Record<string, number>;
  /** Bytes, die auf virtuellen Kanaelen ankamen - je Kanal-ID. */
  virtualChannelBytes: Record<number, number>;
  /** Namen der dynamischen Kanaele, die der Server oeffnen wollte. */
  dynamicChannels: string[];
  /** Entpackte Bytes aus der Graphics Pipeline. */
  graphicsBytes: number;
  /** Kacheln je Codec der Graphics Pipeline - zeigt, welcher Decoder fehlt. */
  graphicsCodecs: Record<string, number>;
  /** Zerlegte H.264-Teilbilder: Regionen und Bitstream-Bytes. */
  graphicsAvc: { regionen: number; bytes: number };
}

/** Name des dynamischen Kanals, auf dem die Graphics Pipeline laeuft. */
export const GRAPHICS_CHANNEL_NAME = 'Microsoft::Windows::RDS::Graphics';
/** Kanal fuer die Zeigerform - gehoert zum selben Stapel wie die Grafik. */
export const MOUSE_CURSOR_CHANNEL_NAME = 'Microsoft::Windows::RDS::MouseCursor';
/** Eingabekanal des modernen Stapels. */
export const CORE_INPUT_CHANNEL_NAME = 'Microsoft::Windows::RDS::CoreInput';

/**
 * Windows oeffnet diese drei Kanaele als Einheit. Nimmt ein Client nur einen
 * davon an, kann das serverseitige Grafik-Subsystem beim Start scheitern
 * (ERRINFO_GRAPHICSSUBSYSTEMFAILED). Echte Clients nehmen alle drei an, auch
 * wenn sie nicht jeden bedienen - eingehende Daten auf den unbedienten
 * Kanaelen werden schlicht protokolliert.
 */
export const PIPELINE_CHANNEL_NAMES = [
  GRAPHICS_CHANNEL_NAME,
  MOUSE_CURSOR_CHANNEL_NAME,
  CORE_INPUT_CHANNEL_NAME,
];

/**
 * 'reconnecting' ist die Wartezeit zwischen zwei Versuchen. Waehrend eines
 * Versuchs selbst gilt wieder 'connecting' - dort traegt die Zusage des
 * Handshakes den Fehler, genau wie beim Erstaufbau.
 */
type Phase = 'idle' | 'connecting' | 'reconnecting' | 'active' | 'closed';

export class RdpClient extends EventEmitter {
  private readonly log: Logger;
  private transport: RdpTransport;
  private readonly opts: Required<
    Pick<RdpClientOptions, 'host' | 'port' | 'width' | 'height' | 'colorDepth' | 'keyboardLayout' | 'clientName'>
  > &
    RdpClientOptions;

  private phase: Phase = 'idle';
  private userId = 0;
  private shareId = 0;
  private channelIds = new Map<string, number>();
  /**
   * Der vom Server benannte I/O-Kanal (MS-RDPBCGR 2.2.1.4.4). Meist 1003, aber
   * der Server darf einen anderen waehlen - dann muessen alle PDUs dorthin.
   */
  private ioChannelId = MCS_GLOBAL_CHANNEL;
  private selectedProtocol = PROTOCOL_RDP;
  private palette?: Buffer;
  private serverCapabilities?: ServerCapabilities;
  /** Zaehlt empfangene Fastpath-Update-Arten - hilft bei der Fehlersuche. */
  private readonly updateCodeCounts = new Map<number, number>();
  /** Zaehlt Share-Control- und Data-PDU-Arten aus dem Slowpath. */
  private readonly sharePduCounts = new Map<number, number>();
  private readonly dataPduCounts = new Map<number, number>();
  private frameCounts = { fastpath: 0, slowpath: 0, verworfen: 0 };
  /** Empfangene Bytes je virtuellem Kanal. */
  private readonly virtualChannelBytes = new Map<number, number>();
  /** MCS-Kanal-ID von drdynvc, sofern angemeldet. */
  private dynvcChannelId?: number;
  private readonly dynvcReassembler = new ChannelReassembler();
  /** Offene dynamische Kanaele: DVC-Kanal-ID -> Name. */
  private readonly dynamicChannels = new Map<number, string>();
  /** Alle Kanaele, die der Server oeffnen wollte - auch die abgelehnten. */
  private readonly angeboteneKanaele: string[] = [];
  /** Zusammensetzen von DATA_FIRST/DATA je dynamischem Kanal. */
  private readonly dynamicFragments = new Map<number, { erwartet: number; teile: Buffer[] }>();
  /**
   * Ein ZGFX-Dekompressor je dynamischem Kanal. Der Verlaufspuffer gehoert zum
   * Kanal, nicht zur einzelnen Nachricht - ein Rueckverweis darf auf eine
   * frueher empfangene Nachricht desselben Kanals zeigen.
   */
  private readonly zgfxByChannel = new Map<number, ZgfxDecompressor>();
  /** Surface- und Frameverwaltung der Graphics Pipeline. */
  private egfx?: EgfxSession;
  private bitmapCount = 0;
  /** Entpackte Bytes, die ueber die Graphics Pipeline ankamen. */
  private graphicsBytes = 0;
  /** Wie oft die Sitzung aktiviert wurde - der Erstaufbau zaehlt als 1. */
  private activations = 0;
  private pointerCache = new Map<number, PointerImage>();

  /** Fastpath-Frames, die waehrend des Handshakes eintreffen, werden zwischengespeichert. */
  private queuedFrames: RdpFrame[] = [];
  /** Reassemblierung fragmentierter Fastpath-Updates. */
  private fragments: Buffer[] = [];
  /** Wurde der Handshake bereits mit der TLS-Rueckfallebene wiederholt? */
  private triedLegacyTls = false;
  /** TLS-Profil des aktuellen Transports - beim Wiederverbinden wiederverwendet. */
  private tlsProfile: TlsProfile = MODERN_TLS_PROFILE;

  // ------------------------------------------- Automatischer Wiederaufbau

  /** Ausgewertete Einstellungen; steht auch dann, wenn nichts angegeben wurde. */
  private readonly arc: {
    aktiv: boolean;
    maxVersuche: number;
    backoff: BackoffOptions;
    zufall: () => number;
  };
  /** Zuletzt vom Server hinterlegter Cookie (MS-RDPBCGR 5.5, Schritt 2). */
  private arcCookie?: ServerAutoReconnectPacket;
  /** Nummer des laufenden Wiederverbindungsversuchs; 0 heisst: keiner. */
  private arcVersuch = 0;
  private arcTimer?: NodeJS.Timeout;
  /** Grund des Verlusts, der die laufende Wiederholung ausgeloest hat. */
  private arcGrund?: string;
  private arcLetzterFehler?: Error;
  /** Ob im letzten Info-PDU ein ARC_CS_PRIVATE_PACKET mitfuhr. */
  private arcCookieGesendet = false;
  /**
   * Hat der Benutzer disconnect() gerufen? Dann ist der Abbau gewollt: keine
   * Wiederholung, kein Fehler, kein Ereignis.
   */
  private benutzerTrennung = false;

  constructor(options: RdpClientOptions) {
    super();
    this.opts = {
      port: 3389,
      width: 1280,
      height: 800,
      colorDepth: 16,
      keyboardLayout: 0x409,
      clientName: 'vscode-rdp',
      ...options,
    };
    this.log = options.logLevel || options.logSink ? createLogger(options.logLevel ?? 'info', options.logSink) : nullLogger;

    const ar = options.autoReconnect;
    this.arc = {
      aktiv: ar ? ar.enabled !== false : false,
      maxVersuche: ar?.maxAttempts ?? 5,
      backoff: {
        initialDelayMs: ar?.initialDelayMs ?? STANDARD_BACKOFF.initialDelayMs,
        maxDelayMs: ar?.maxDelayMs ?? STANDARD_BACKOFF.maxDelayMs,
        factor: ar?.factor ?? STANDARD_BACKOFF.factor,
        jitter: ar?.jitter ?? STANDARD_BACKOFF.jitter,
      },
      zufall: ar?.random ?? Math.random,
    };
    // Die Capability gehoert zur Funktion, nicht zum Geschmack: sie ist die
    // Zusage an den Server, mit einem Cookie zurueckzukommen. Wer sie dennoch
    // von Hand abschaltet, behaelt das letzte Wort.
    if (this.arc.aktiv) {
      this.opts.capabilityProfile = {
        ...this.opts.capabilityProfile,
        autoReconnect: this.opts.capabilityProfile?.autoReconnect ?? true,
      };
    }

    this.transport = this.createTransport(MODERN_TLS_PROFILE);
  }

  private createTransport(tlsProfile: TlsProfile): RdpTransport {
    this.tlsProfile = tlsProfile;
    const transport = new RdpTransport({
      host: this.opts.host,
      port: this.opts.port,
      logger: this.log,
      connectTimeout: this.opts.connectTimeout,
      rejectUnauthorized: this.opts.rejectUnauthorized,
      verifyCertificate: this.opts.verifyCertificate,
      tlsProfile,
    });
    transport.on('error', (err) => this.fail(err));
    transport.on('close', () => this.handleClose());
    transport.on('frame', (frame: RdpFrame) => this.handleFrame(frame));
    return transport;
  }

  get width(): number {
    return this.opts.width;
  }

  get height(): number {
    return this.opts.height;
  }

  get isConnected(): boolean {
    return this.phase === 'active';
  }

  /** Laeuft gerade ein automatischer Wiederverbindungsaufbau? */
  get isReconnecting(): boolean {
    return this.phase === 'reconnecting' || (this.arcVersuch > 0 && this.phase === 'connecting');
  }

  /** Nummer des laufenden Wiederverbindungsversuchs; 0 heisst: keiner. */
  get reconnectAttempt(): number {
    return this.arcVersuch;
  }

  /**
   * Liegt ein Auto-Reconnect-Cookie des Servers vor? Nur dann fuehrt ein
   * Wiederaufbau zurueck in dieselbe Sitzung. Der Cookie selbst wird nicht
   * herausgegeben (MS-RDPBCGR 5.5).
   */
  get canResumeSession(): boolean {
    return this.arcCookie !== undefined;
  }

  async connect(): Promise<void> {
    if (this.phase !== 'idle') throw new RdpError('connect() kann nur einmal aufgerufen werden');
    this.phase = 'connecting';
    try {
      await this.runHandshake();
    } catch (err) {
      // Scheitert TLS an einer Unvertraeglichkeit - allen voran an einem
      // Zertifikat ohne digitalSignature -, einmal mit der Rueckfallebene neu
      // aufsetzen. Ein neuer TCP-Verbindungsaufbau ist noetig, weil ein
      // fehlgeschlagener Handshake den Socket unbrauchbar macht.
      if (this.triedLegacyTls || !isTlsCompatibilityError(err)) {
        this.phase = 'closed';
        this.transport.close();
        throw err;
      }
      this.log.warn(LEGACY_TLS_EXPLANATION);
      this.triedLegacyTls = true;
      this.resetForRetry(LEGACY_TLS_PROFILE);
      try {
        await this.runHandshake();
      } catch (retryError) {
        this.phase = 'closed';
        this.transport.close();
        throw retryError;
      }
    }
  }

  private async runHandshake(): Promise<void> {
    await this.transport.connect();
    await this.negotiateSecurity();
    await this.mcsConnect();
    await this.sendClientInfo();
    await this.licensePhase();
    await this.capabilityExchange();
    this.phase = 'active';
    // Reihenfolge ist hier entscheidend: 'connect' muss vor den ersten
    // Bilddaten kommen. Der Server schickt direkt nach der Aktivierung den
    // gesamten Desktop - wer die Zeichenflaeche erst im 'connect'-Ereignis
    // einrichtet, wuerde dieses eine Vollbild sonst verwerfen und bei einem
    // statischen Desktop nie wieder eines bekommen.
    this.emit('connect');
    // Zuerst die waehrend des Handshakes eingetroffenen Frames, danach der laufende Strom.
    for (const frame of this.queuedFrames.splice(0)) this.handleFrame(frame);
    this.transport.startFlowing();
  }

  /** Setzt den gesamten Sitzungszustand zurueck und baut den Transport neu auf. */
  private resetForRetry(tlsProfile: TlsProfile): void {
    this.transport.removeAllListeners();
    this.transport.close();
    this.userId = 0;
    this.shareId = 0;
    this.channelIds.clear();
    this.selectedProtocol = PROTOCOL_RDP;
    this.palette = undefined;
    this.pointerCache.clear();
    this.queuedFrames = [];
    this.fragments = [];
    this.pendingSharePayload = undefined;
    this.phase = 'connecting';
    this.transport = this.createTransport(tlsProfile);
  }

  /**
   * Alles zuruecksetzen, was an die *alte Sitzung* gebunden war.
   *
   * Beim TLS-Rueckfall ist das unnoetig - dort kam nie eine Sitzung zustande.
   * Beim Wiederverbinden dagegen zwingend: eine halb empfangene Kanalnachricht
   * oder ein ZGFX-Verlaufspuffer der alten Verbindung wuerde die erste
   * Nachricht der neuen verderben.
   */
  private setzeSitzungszustandZurueck(): void {
    this.dynvcChannelId = undefined;
    this.dynamicChannels.clear();
    this.dynamicFragments.clear();
    this.zgfxByChannel.clear();
    this.dynvcReassembler.reset();
    this.egfx = undefined;
    this.serverCapabilities = undefined;
    this.lastErrorInfo = undefined;
    this.lastErrorInfoCode = undefined;
  }

  disconnect(): void {
    // Gewolltes Trennen beendet jede laufende Wiederholung auf der Stelle und
    // gilt nicht als Fehler - weder 'error' noch 'gaveUp' folgen daraus.
    this.benutzerTrennung = true;
    this.brichWiederverbindungAb();
    if (this.phase === 'active') {
      try {
        this.sendPdu(pdu.buildShutdownRequest(this.shareId, this.userId));
      } catch {
        // Beim Trennen sind Schreibfehler unerheblich.
      }
    }
    this.phase = 'closed';
    this.transport.close();
  }

  // --------------------------------------------------------------- Handshake

  private async negotiateSecurity(): Promise<void> {
    const wantNla = this.opts.useNla !== false && !!this.opts.username && !!this.opts.password;
    let requested = PROTOCOL_SSL;
    if (wantNla) requested |= PROTOCOL_HYBRID;

    this.transport.write(
      tpktRaw(
        buildConnectionRequest({
          requestedProtocols: requested,
          cookie: this.opts.username ? this.opts.username.substring(0, 20) : undefined,
        }),
      ),
    );

    const confirm = await this.transport.nextFrame('tpkt');
    const result = parseConnectionConfirm(parseFrame(confirm).payload);
    this.selectedProtocol = result.selectedProtocol;
    this.log.info(`Sicherheitsprotokoll ausgehandelt: 0x${result.selectedProtocol.toString(16)}`);

    if (result.selectedProtocol === PROTOCOL_RDP) {
      throw new RdpError(
        'Der Server bietet nur die alte RDP-Standardverschluesselung an. ' +
          'Dieser Client unterstuetzt ausschliesslich TLS und NLA.',
        'RDP_UNSUPPORTED_SECURITY',
      );
    }

    const socket = await this.transport.upgradeTls();

    if (result.selectedProtocol & PROTOCOL_HYBRID) {
      await this.runCredSsp(socket);
    } else if (wantNla && this.opts.allowTlsOnly === false) {
      throw new RdpError('Der Server hat NLA abgelehnt, obwohl es verlangt wurde.', 'RDP_NLA_REJECTED');
    }
  }

  private async runCredSsp(socket: tls.TLSSocket): Promise<void> {
    const publicKey = serverPublicKeyDer(socket);
    const credssp = new CredSspClient(
      {
        domain: this.opts.domain ?? '',
        user: this.opts.username ?? '',
        password: this.opts.password ?? '',
        workstation: this.opts.clientName,
        servicePrincipalName: `TERMSRV/${this.opts.host}`,
      },
      publicKey,
    );

    this.transport.write(credssp.start());
    for (;;) {
      const response = await this.transport.nextFrame('der');
      const result = credssp.step(response);
      if (result.send) this.transport.write(result.send);
      if (result.done) break;
    }
    this.log.info('NLA/CredSSP erfolgreich abgeschlossen');
  }

  private async mcsConnect(): Promise<void> {
    const channels: gcc.ChannelDef[] = [];
    // Zusaetzliche statische Kanaele werden nur angemeldet, nicht bedient - ein
    // echter Client meldet vier Stueck an, und ob der Server daraus etwas
    // ableitet, laesst sich nur messen.
    for (const name of this.opts.extraStaticChannels ?? []) {
      channels.push({
        name,
        options: gcc.CHANNEL_OPTION_INITIALIZED | gcc.CHANNEL_OPTION_COMPRESS_RDP,
      });
    }
    if (this.opts.announceDynamicChannels || this.opts.enableGraphicsPipeline) {
      channels.push({
        name: 'drdynvc',
        // Ohne SHOW_PROTOCOL: der Kanalkopf gehoert uns, nicht dem Endpunkt.
        options:
          this.opts.dynvcChannelOptions ??
          gcc.CHANNEL_OPTION_INITIALIZED | gcc.CHANNEL_OPTION_COMPRESS_RDP,
      });
    }
    const clientData = gcc.buildClientData(
      {
        width: this.opts.width,
        height: this.opts.height,
        colorDepth: this.opts.colorDepth,
        keyboardLayout: this.opts.keyboardLayout,
        clientName: this.opts.clientName,
        selectedProtocol: this.selectedProtocol,
        earlyCapabilityFlags:
          this.opts.earlyCapabilityFlags ??
          (this.opts.announceDynamicChannels || this.opts.enableGraphicsPipeline
            ? gcc.RNS_UD_CS_SUPPORT_ERRINFO_PDU | gcc.RNS_UD_CS_SUPPORT_DYNVC_GFX_PROTOCOL
            : undefined),
        clientVersion: this.opts.clientVersion,
        clientBuild: this.opts.clientBuild,
        monitorLayout: this.opts.monitorLayout,
      },
      channels,
    );

    this.transport.write(tpkt(mcs.buildConnectInitial(gcc.buildConferenceCreateRequest(clientData))));

    const responseFrame = await this.transport.nextFrame('tpkt');
    const serverUserData = mcs.parseConnectResponse(mcsPayload(responseFrame));
    const serverData = gcc.parseConferenceCreateResponse(serverUserData);
    this.log.info(
      `Serverdaten: I/O-Kanal ${serverData.network?.mcsChannelId ?? '(keiner genannt)'}, ` +
        `virtuelle Kanaele [${(serverData.network?.channelIds ?? []).join(', ')}], ` +
        `Version 0x${(serverData.core?.version ?? 0).toString(16)}`,
    );

    this.transport.write(tpkt(mcs.buildErectDomainRequest()));
    this.transport.write(tpkt(mcs.buildAttachUserRequest()));

    const attach = await this.transport.nextFrame('tpkt');
    this.userId = mcs.parseAttachUserConfirm(mcsPayload(attach));
    this.log.debug(`MCS-Benutzerkanal: ${this.userId}`);

    // Den I/O-Kanal gibt der Server vor; ein fest verdrahtetes 1003 waere ein
    // Ratespiel. Sendet man auf den falschen Kanal, verwirft der Server alles
    // stillschweigend - die Verbindung steht dann, aber es kommt nie ein Bild.
    this.ioChannelId = serverData.network?.mcsChannelId || MCS_GLOBAL_CHANNEL;
    if (this.ioChannelId !== MCS_GLOBAL_CHANNEL) {
      this.log.info(`Server nutzt den I/O-Kanal ${this.ioChannelId} statt des ueblichen ${MCS_GLOBAL_CHANNEL}`);
    }

    // Reihenfolge zaehlt: erst der eigene Benutzerkanal, dann der I/O-Kanal.
    const joinList = [this.userId, this.ioChannelId, ...(serverData.network?.channelIds ?? [])];
    for (const channelId of joinList) {
      this.transport.write(tpkt(mcs.buildChannelJoinRequest(this.userId, channelId)));
      const confirm = await this.transport.nextFrame('tpkt');
      const joined = mcs.parseChannelJoinConfirm(mcsPayload(confirm));
      this.log.debug(`Kanal ${joined.channelId} beigetreten`);
    }
    this.channelIds.set('io', this.ioChannelId);
    // Der Server vergibt die IDs der virtuellen Kanaele in der Reihenfolge,
    // in der wir sie im Client Network Data angemeldet haben.
    if (channels.length > 0 && serverData.network?.channelIds.length) {
      channels.forEach((def, index) => {
        const id = serverData.network!.channelIds[index];
        if (id === undefined) return;
        this.channelIds.set(def.name, id);
        if (def.name === 'drdynvc') this.dynvcChannelId = id;
      });
      this.log.info(
        `Virtuelle Kanaele: ${[...this.channelIds].map(([n, id]) => `${n}=${id}`).join(', ')}`,
      );
    }
  }

  private async sendClientInfo(): Promise<void> {
    // Der Cookie faehrt nur beim Wiederverbinden mit: beim Erstaufbau gibt es
    // keine Sitzung, in die zurueckzukehren waere (MS-RDPBCGR 5.5, Schritt 4).
    const cookie =
      this.arcVersuch > 0 && this.arcCookie ? buildAutoReconnectCookie(this.arcCookie) : undefined;
    this.arcCookieGesendet = cookie !== undefined;
    if (cookie) {
      this.log.info(
        `Info-PDU mit Auto-Reconnect-Cookie fuer Sitzung ${this.arcCookie!.logonId}`,
      );
    }
    const info = buildClientInfo({
      domain: this.opts.domain ?? '',
      username: this.opts.username ?? '',
      password: this.opts.password ?? '',
      alternateShell: this.opts.alternateShell,
      performanceFlags: this.opts.performanceFlags,
      autoReconnectCookie: cookie,
    });
    // Security Header mit SEC_INFO_PKT ist hier auch unter TLS vorgeschrieben.
    const payload = Buffer.concat([Buffer.from([SEC_INFO_PKT & 0xff, SEC_INFO_PKT >> 8, 0, 0]), info]);
    this.sendMcs(this.ioChannelId, payload);
  }

  private async licensePhase(): Promise<void> {
    for (;;) {
      const frame = await this.nextMcsPayload();
      if (!frame) continue;
      if (pdu.looksLikeShareControl(frame)) {
        // Lizenzphase ist vorbei, das ist bereits das Demand Active PDU.
        this.pendingSharePayload = frame;
        return;
      }
      const r = new BinaryReader(frame);
      const flags = r.uint16le();
      r.uint16le(); // flagsHi
      if (!(flags & SEC_LICENSE_PKT)) {
        this.pendingSharePayload = frame.subarray(4);
        return;
      }
      const license = parseLicensePdu(r);
      this.log.debug(`Lizenz-PDU empfangen: Typ 0x${license.messageType.toString(16)}`);
      evaluateLicense(license);
      if (license.messageType !== 0x01) return;
    }
  }

  private pendingSharePayload?: Buffer;

  /**
   * Wartet auf das Demand Active PDU und schliesst die Aktivierung ab.
   * Nur fuer den Erstaufbau - dort laeuft der Transport noch im Pull-Modus.
   */
  private async capabilityExchange(): Promise<void> {
    let payload = this.pendingSharePayload ?? (await this.nextMcsPayload());
    this.pendingSharePayload = undefined;

    // Auf das Demand Active PDU warten - davor koennen noch andere PDUs kommen.
    for (;;) {
      if (payload && pdu.looksLikeShareControl(payload)) {
        const r = new BinaryReader(payload);
        const header = pdu.readShareControlHeader(r);
        if (header.pduType === PDUTYPE_DEMANDACTIVEPDU) {
          this.applyDemandActive(r);
          break;
        }
      }
      payload = await this.nextMcsPayload();
    }

    this.completeActivation();
  }

  /**
   * Antwort auf ein Demand Active PDU: Capabilities bestaetigen und die
   * Sitzung starten.
   *
   * Bewusst ohne jedes `await`: Waehrend der laufenden Sitzung kommt ein
   * Demand Active aus dem Ereignisstrom. Wuerde hier auf weitere PDUs gewartet,
   * blieben Confirm Active und Font List aus - und der Server beendet die
   * Sitzung, weil der Client die Aktivierung nie abschliesst. Genau diese Folge
   * schickt Windows beim Wechsel vom Anmeldebildschirm auf den Benutzerdesktop.
   */
  private completeActivation(): void {
    this.sendPdu(
      pdu.buildConfirmActive(
        this.shareId,
        this.userId,
        buildClientCapabilities(
          {
            width: this.opts.width,
            height: this.opts.height,
            colorDepth: this.opts.colorDepth,
            keyboardLayout: this.opts.keyboardLayout,
          },
          this.opts.capabilityProfile,
        ),
      ),
    );
    this.sendPdu(pdu.buildSynchronize(this.shareId, this.userId, 0x03ea));
    this.sendPdu(pdu.buildControlCooperate(this.shareId, this.userId));
    this.sendPdu(pdu.buildControlRequest(this.shareId, this.userId));
    this.sendPdu(pdu.buildFontList(this.shareId, this.userId));
    // Echte Clients melden direkt nach der Aktivierung den Zustand der
    // Feststelltasten. Manche Server behandeln dieses erste Eingabeereignis
    // als Startsignal und beginnen erst danach zu zeichnen.
    this.sendPdu(pdu.buildInputPdu(this.shareId, this.userId, [pdu.syncEvent(0)]));
    this.activations++;
    this.log.info(`Aktivierung abgeschlossen (Nr. ${this.activations}), Sitzung laeuft`);
  }

  private applyDemandActive(r: BinaryReader): void {
    const demand = pdu.parseDemandActive(r);
    this.shareId = demand.shareId;
    this.serverCapabilities = demand.capabilities;
    // Welche Capability Sets der Server anbietet, entscheidet darueber, auf
    // welchem Weg er Grafik schickt - fuer die Fehlersuche unverzichtbar.
    this.log.debug(
      `Server-Capabilities: ${[...demand.capabilities.raw.keys()]
        .map((t) => `0x${t.toString(16)}`)
        .join(', ')}`,
    );
    // Die Farbtiefe gibt der Server vor. Wer sie ignoriert und eine andere
    // bestaetigt, bekommt von aktuellen Windows-Versionen ueberhaupt kein Bild:
    // deren Encoder arbeitet mit 32 bpp und hat fuer 16 bpp keinen Weg mehr.
    const serverBpp = demand.capabilities.preferredBitsPerPixel;
    if (serverBpp && serverBpp !== this.opts.colorDepth) {
      this.log.info(`Server gibt ${serverBpp} bpp vor (angefragt waren ${this.opts.colorDepth}) - wird uebernommen`);
      this.opts.colorDepth = serverBpp;
    }

    const { desktopWidth, desktopHeight } = demand.capabilities;
    if (desktopWidth && desktopHeight && (desktopWidth !== this.opts.width || desktopHeight !== this.opts.height)) {
      this.log.info(`Server verwendet ${desktopWidth}x${desktopHeight} statt ${this.opts.width}x${this.opts.height}`);
      this.opts.width = desktopWidth;
      this.opts.height = desktopHeight;
      this.emit('resize', { width: desktopWidth, height: desktopHeight });
    }
  }

  /** Naechste MCS-Nutzlast waehrend des Handshakes; Fastpath-Frames werden gepuffert. */
  private async nextMcsPayload(): Promise<Buffer> {
    for (;;) {
      const raw = await this.transport.nextFrame('tpkt');
      const frame = parseFrame(raw);
      if (frame.fastpath) {
        this.queuedFrames.push(frame);
        continue;
      }
      // X.224-Data-Header (3 Byte) ueberspringen.
      const indication = mcs.parseSendDataIndication(frame.payload.subarray(3));
      if (!indication) throw new RdpError('Der Server hat die MCS-Verbindung getrennt', 'RDP_DISCONNECTED');
      if (indication.payload.length > 0) return indication.payload;
    }
  }

  // ------------------------------------------------------------ Datenfluss

  private handleFrame(frame: RdpFrame): void {
    try {
      if (frame.fastpath) {
        this.frameCounts.fastpath++;
        this.traceFrame('fastpath', frame.payload.length);
        this.handleFastpath(frame);
      } else {
        this.frameCounts.slowpath++;
        this.traceFrame('slowpath', frame.payload.length);
        this.handleSlowpath(frame.payload);
      }
    } catch (err) {
      this.fail(err as Error);
    }
  }

  /** Protokolliert die ersten Rahmen einer Sitzung - der Rest waere nur Rauschen. */
  private traceFrame(art: string, length: number): void {
    const gesamt = this.frameCounts.fastpath + this.frameCounts.slowpath;
    if (gesamt <= 20) this.log.debug(`Rahmen #${gesamt}: ${art}, ${length} Byte`);
  }

  private handleSlowpath(payload: Buffer): void {
    const indication = mcs.parseSendDataIndication(payload.subarray(3));
    if (!indication) {
      this.handleClose('Der Server hat die Sitzung beendet');
      return;
    }
    let data = indication.payload;
    if (data.length === 0) return;

    // Alles ausserhalb des I/O-Kanals gehoert zu einem virtuellen Kanal.
    if (indication.channelId !== this.ioChannelId) {
      const bisher = this.virtualChannelBytes.get(indication.channelId) ?? 0;
      this.virtualChannelBytes.set(indication.channelId, bisher + data.length);
      if (indication.channelId === this.dynvcChannelId) this.handleDynvc(data);
      else {
        this.log.debug(
          `Daten auf virtuellem Kanal ${indication.channelId}: ${data.length} Byte ` +
            `(${data.subarray(0, 16).toString('hex')})`,
        );
      }
      return;
    }
    if (!pdu.looksLikeShareControl(data)) {
      // Security Header (nur noch bei Lizenz-/Sonder-PDUs vorhanden) abschneiden.
      if (data.length < 4 || !pdu.looksLikeShareControl(data.subarray(4))) {
        this.frameCounts.verworfen++;
        this.log.debug(
          `Unbekannte Nutzlast auf Kanal ${indication.channelId} verworfen ` +
            `(${data.length} Byte): ${data.subarray(0, 16).toString('hex')}`,
        );
        return;
      }
      data = data.subarray(4);
    }

    const r = new BinaryReader(data);
    const header = pdu.readShareControlHeader(r);
    this.sharePduCounts.set(header.pduType, (this.sharePduCounts.get(header.pduType) ?? 0) + 1);
    switch (header.pduType) {
      case PDUTYPE_DATAPDU:
        this.handleDataPdu(r);
        break;
      case PDUTYPE_DEMANDACTIVEPDU:
        // Neuaktivierung, etwa beim Wechsel vom Anmeldebildschirm auf den Desktop.
        this.log.info('Server aktiviert die Sitzung neu');
        this.applyDemandActive(r);
        this.completeActivation();
        break;
      case PDUTYPE_DEACTIVATEALLPDU:
        // Danach folgt ein neues Demand Active PDU; die Sitzung laeuft weiter.
        this.log.info('Server hat die Sitzung deaktiviert, warte auf Neuaktivierung');
        break;
      default:
        this.log.debug(`Unbehandelter Share-Control-PDU-Typ ${header.pduType}`);
    }
  }

  /** Bloecke des Kanals drdynvc zu DVC-Nachrichten zusammensetzen. */
  private handleDynvc(payload: Buffer): void {
    const vollstaendig = this.dynvcReassembler.push(parseChannelChunk(payload));
    if (!vollstaendig) return;

    this.log.trace(`DVC empfangen: ${vollstaendig.length} Byte (${vollstaendig.toString('hex')})`);
    const nachricht = dvc.parseDvcPdu(vollstaendig);
    switch (nachricht.cmd) {
      case dvc.DVC_CMD_CAPABILITY: {
        const version = Math.min(nachricht.version ?? 1, this.opts.dvcVersion ?? 1);
        this.log.info(`DVC: Server bietet Version ${nachricht.version}, bestaetige ${version}`);
        this.sendDynvc(dvc.buildCapabilitiesResponse(version));
        break;
      }

      case dvc.DVC_CMD_CREATE: {
        const name = nachricht.name ?? '';
        const id = nachricht.channelId!;
        const angenommen = this.wantsDynamicChannel(name);
        if (!this.angeboteneKanaele.includes(name)) this.angeboteneKanaele.push(name);
        this.log.info(`DVC: Server oeffnet Kanal "${name}" (ID ${id}) - ${angenommen ? 'angenommen' : 'abgelehnt'}`);
        if (angenommen) this.dynamicChannels.set(id, name);
        // Erst bestaetigen, dann senden: bis die Antwort draussen ist, gilt der
        // Kanal serverseitig als nicht angenommen und Nutzdaten werden verworfen.
        const antworten = () => {
          this.sendDynvc(
            dvc.buildCreateResponse(id, angenommen ? dvc.DVC_CREATION_STATUS_OK : dvc.DVC_CREATION_STATUS_NO_LISTENER),
          );
          // Nur starten, wenn die Pipeline auch angefordert wurde. Wer den Kanal
          // ueber acceptDynamicChannels annimmt, ohne sie zu wollen, bekommt
          // sonst ungefragt eine EGFX-Sitzung - und die Messung "Kanal annehmen
          // und schweigen" ist gar nicht durchfuehrbar.
          if (angenommen && name === GRAPHICS_CHANNEL_NAME && this.opts.enableGraphicsPipeline) {
            this.startGraphicsPipeline(id);
          }
        };
        const verzug = name === GRAPHICS_CHANNEL_NAME ? (this.opts.graphicsAcceptDelayMs ?? 0) : 0;
        if (verzug > 0) setTimeout(antworten, verzug).unref();
        else antworten();
        break;
      }

      case dvc.DVC_CMD_DATA_FIRST: {
        this.dynamicFragments.set(nachricht.channelId!, {
          erwartet: nachricht.totalLength ?? 0,
          teile: [nachricht.data ?? Buffer.alloc(0)],
        });
        this.pruefeDynamicFragment(nachricht.channelId!);
        break;
      }

      case dvc.DVC_CMD_DATA: {
        const offen = this.dynamicFragments.get(nachricht.channelId!);
        if (offen) {
          offen.teile.push(nachricht.data ?? Buffer.alloc(0));
          this.pruefeDynamicFragment(nachricht.channelId!);
        } else {
          this.emitDynamicData(nachricht.channelId!, nachricht.data ?? Buffer.alloc(0));
        }
        break;
      }

      case dvc.DVC_CMD_CLOSE: {
        const name = this.dynamicChannels.get(nachricht.channelId!);
        this.log.info(`DVC: Kanal "${name ?? nachricht.channelId}" geschlossen`);
        // Erst den Namen holen, dann loeschen.
        if (name === GRAPHICS_CHANNEL_NAME) this.egfx = undefined;
        this.dynamicChannels.delete(nachricht.channelId!);
        this.dynamicFragments.delete(nachricht.channelId!);
        // Der Verlaufspuffer haengt am Kanal und ist 2,5 MB gross - beim
        // Schliessen mit freigeben, sonst waechst das bei jedem Neuaufbau.
        this.zgfxByChannel.delete(nachricht.channelId!);
        break;
      }

      default:
        this.log.debug(`DVC: unbehandelter Befehl 0x${nachricht.cmd.toString(16)}`);
    }
  }

  private pruefeDynamicFragment(channelId: number): void {
    const offen = this.dynamicFragments.get(channelId);
    if (!offen) return;
    const laenge = offen.teile.reduce((summe, teil) => summe + teil.length, 0);
    if (laenge < offen.erwartet) return;
    this.dynamicFragments.delete(channelId);
    this.emitDynamicData(channelId, Buffer.concat(offen.teile));
  }

  private emitDynamicData(channelId: number, data: Buffer): void {
    const name = this.dynamicChannels.get(channelId) ?? String(channelId);
    this.log.debug(`DVC: ${data.length} Byte auf "${name}"`);
    this.emit('dynamicChannelData', { channelId, name, data });

    // Die Graphics Pipeline steckt jede Nachricht in ZGFX-Kompression.
    if (name === GRAPHICS_CHANNEL_NAME) this.handleGraphicsData(channelId, data);
  }

  /** Eroeffnet die Pipeline, sobald der Server den Grafikkanal aufmacht. */
  private startGraphicsPipeline(channelId: number): void {
    this.egfx = new EgfxSession({
      log: this.log,
      capsSets: this.opts.graphicsCapsSets,
      onUnbekannteKachel: this.opts.onUnbekannteKachel,
      onRohkachel: this.opts.onRohkachel,
      // Ungepackt, und das ist kein Versehen: die ZGFX-Huelle ist einseitig.
      // MS-RDPEGFX 3.2.5.1 sagt ausdruecklich, dass Nachrichten vom Client zum
      // Server "not encapsulated within any external structure" sind, waehrend
      // der Server seine in RDP_SEGMENTED_DATA verpackt. Wer hier symmetrisch
      // denkt, schickt dem Server zwei Bytes (0xE0 0x04), die er als Anfang des
      // RDPGFX_HEADER liest - die Laenge stimmt dann nicht mehr, sein
      // Grafik-Subsystem laeuft mit ERROR_BUFFER_OVERFLOW auf und reisst die
      // ganze Sitzung mit (beim Client kommt ERRINFO_GRAPHICSSUBSYSTEMFAILED an).
      send: (pdu) => this.sendDynvc(dvc.buildData(channelId, pdu)),
      onBitmap: (tiles) => {
        if (this.bitmapCount === 0) {
          this.log.info(`Erste Bilddaten empfangen (Graphics Pipeline, ${tiles.length} Kacheln)`);
        }
        this.bitmapCount += tiles.length;
        this.emit('bitmap', tiles);
      },
      onResize: ({ width, height }) => {
        if (width === this.opts.width && height === this.opts.height) return;
        this.opts.width = width;
        this.opts.height = height;
        this.emit('resize', { width, height });
      },
    });
    // Die Capability-Aushandlung muss vom Client ausgehen.
    //
    // Der Abstand zur CREATE_RESPONSE ist nicht beliebig: ein echter Client
    // laesst hier rund 36 ms, weil er erst seine Grafikschicht hochfaehrt. Wer
    // die Capabilities in derselben Millisekunde hinterherschickt, trifft den
    // Server moeglicherweise, bevor er den Kanal an seine Grafik-Pipe gebunden
    // hat.
    const verzug = this.opts.graphicsCapsDelayMs ?? 0;
    if (verzug > 0) setTimeout(() => this.egfx?.start(), verzug).unref();
    else this.egfx.start();
  }

  private handleGraphicsData(channelId: number, data: Buffer): void {
    let dekomprimiert: Buffer;
    try {
      let zgfx = this.zgfxByChannel.get(channelId);
      if (!zgfx) {
        zgfx = new ZgfxDecompressor();
        this.zgfxByChannel.set(channelId, zgfx);
      }
      dekomprimiert = zgfx.decompress(data);
    } catch (err) {
      // Der Verlaufspuffer ist nach einem Fehler nicht mehr vertrauenswuerdig,
      // deshalb hier nicht weitermachen, sondern sauber melden.
      this.log.error(`Graphics Pipeline: ZGFX-Fehler - ${(err as Error).message}`);
      this.log.debug(`Rohdaten: ${data.subarray(0, 32).toString('hex')}`);
      return;
    }

    // Der EGFX-Kopf ist cmdId (2), flags (2), pduLength (4).
    if (dekomprimiert.length >= 8) {
      this.log.debug(
        `Graphics Pipeline: cmdId 0x${dekomprimiert.readUInt16LE(0).toString(16)}, ` +
          `${dekomprimiert.length} Byte entpackt`,
      );
    }
    this.graphicsBytes += dekomprimiert.length;
    this.emit('graphicsData', dekomprimiert);

    try {
      this.egfx?.handle(dekomprimiert);
    } catch (err) {
      this.log.warn(`Graphics Pipeline: Nachricht nicht verarbeitbar - ${(err as Error).message}`);
    }
  }

  /** Welche dynamischen Kanaele der Client annehmen soll. */
  private wantsDynamicChannel(name: string): boolean {
    if (this.opts.acceptDynamicChannels) return this.opts.acceptDynamicChannels(name);
    return this.opts.enableGraphicsPipeline === true && PIPELINE_CHANNEL_NAMES.includes(name);
  }

  private sendDynvc(data: Buffer): void {
    if (this.dynvcChannelId === undefined) return;
    this.log.debug(`DVC gesendet: ${data.length} Byte (${data.subarray(0, 24).toString('hex')})`);
    for (const chunk of buildChannelChunks(data)) this.sendMcs(this.dynvcChannelId, chunk);
  }

  private handleDataPdu(r: BinaryReader): void {
    const header = pdu.readShareDataHeader(r);
    this.dataPduCounts.set(header.pduType2, (this.dataPduCounts.get(header.pduType2) ?? 0) + 1);
    switch (header.pduType2) {
      case PDUTYPE2_UPDATE: {
        const updateType = r.uint16le();
        if (updateType === UPDATETYPE_BITMAP) this.emitBitmaps(parseBitmapUpdate(r));
        else if (updateType === UPDATETYPE_PALETTE) this.palette = parsePaletteUpdate(r).entries;
        break;
      }
      case PDUTYPE2_POINTER:
        this.handlePointerUpdate(r);
        break;
      case PDUTYPE2_SET_ERROR_INFO_PDU: {
        const code = r.uint32le();
        this.log.debug(`Error Info PDU: 0x${code.toString(16)}`);
        if (code !== 0) {
          const text = ERROR_INFO_CODES[code] ?? `Unbekannter Fehlercode 0x${code.toString(16)}`;
          this.log.warn(`Server meldet: ${text}`);
          this.lastErrorInfo = text;
          // Der nackte Code entscheidet spaeter darueber, ob ein
          // Wiederverbinden ueberhaupt Sinn ergibt.
          this.lastErrorInfoCode = code;
        }
        break;
      }
      case PDUTYPE2_SAVE_SESSION_INFO:
        this.handleSaveSessionInfo(r);
        break;
      default:
        this.log.debug(`Data-PDU ${benenneDataPdu(header.pduType2)} - keine Behandlung noetig`);
    }
  }

  private lastErrorInfo?: string;
  /** Derselbe Wert als Zahl - noetig fuer die Entscheidung ueber Wiederholungen. */
  private lastErrorInfoCode?: number;

  /**
   * Save Session Info PDU (MS-RDPBCGR 2.2.10.1). Von allem, was darin stehen
   * kann, braucht dieser Client genau eines: den Server-Auto-Reconnect-Cookie.
   * Er kommt, sobald der Benutzer angemeldet ist, und wird stuendlich sowie bei
   * jedem Verbinden erneuert - es gilt stets der zuletzt empfangene.
   */
  private handleSaveSessionInfo(r: BinaryReader): void {
    const info = parseSaveSessionInfo(r);
    if (!info.autoReconnectCookie) {
      this.log.debug(`Save Session Info: infoType ${info.infoType}, kein Cookie enthalten`);
      return;
    }
    this.arcCookie = info.autoReconnectCookie;
    this.log.info(
      `Auto-Reconnect-Cookie erhalten (Sitzung ${info.autoReconnectCookie.logonId}, ` +
        `Version ${info.autoReconnectCookie.version})`,
    );
    this.emit('autoReconnectCookie', {
      logonId: info.autoReconnectCookie.logonId,
      version: info.autoReconnectCookie.version,
    });
  }

  private handlePointerUpdate(r: BinaryReader): void {
    const messageType = r.uint16le();
    r.uint16le(); // pad
    switch (messageType) {
      case PTRMSGTYPE_SYSTEM: {
        // SYSPTR_NULL (0) blendet den Zeiger aus, SYSPTR_DEFAULT (0x7F00) zeigt den Standardzeiger.
        const type = r.uint32le();
        if (type === 0) this.emit('pointerHidden');
        else this.emit('pointer', null);
        break;
      }
      case PTRMSGTYPE_POSITION:
        this.emit('pointerPosition', { x: r.uint16le(), y: r.uint16le() });
        break;
      case PTRMSGTYPE_COLOR:
        this.cacheAndEmitPointer(parsePointerImage(r, 24));
        break;
      case PTRMSGTYPE_POINTER: {
        const xorBpp = r.uint16le();
        this.cacheAndEmitPointer(parsePointerImage(r, xorBpp));
        break;
      }
      case PTRMSGTYPE_CACHED: {
        const index = r.uint16le();
        const cached = this.pointerCache.get(index);
        if (cached) this.emit('pointer', cached);
        break;
      }
    }
  }

  private cacheAndEmitPointer(image: PointerImage): void {
    this.pointerCache.set(image.cacheIndex, image);
    this.emit('pointer', image);
  }

  private handleFastpath(frame: RdpFrame): void {
    if (frame.flags & 0x02 /* FASTPATH_OUTPUT_ENCRYPTED */) {
      throw new RdpProtocolError('Verschluesselte Fastpath-Updates werden nicht unterstuetzt (nur TLS/NLA)');
    }
    const r = new BinaryReader(frame.payload);
    while (r.remaining >= 3) {
      const header = r.uint8();
      const updateCode = header & 0x0f;
      const fragmentation = (header >> 4) & 0x03;
      const compression = (header >> 6) & 0x03;
      if (compression & FASTPATH_OUTPUT_COMPRESSION_USED) {
        const compressionFlags = r.uint8();
        if (compressionFlags & 0x02 /* PACKET_COMPRESSED */) {
          throw new RdpProtocolError(
            'Der Server komprimiert die Updates (MPPC). Komprimierung wird in den Capabilities nicht angeboten - ' +
              'bitte Serverkonfiguration pruefen.',
          );
        }
      }
      const size = r.uint16le();
      const data = r.bytes(Math.min(size, r.remaining));

      let payload = data;
      if (fragmentation !== FASTPATH_FRAGMENT_SINGLE) {
        this.fragments.push(data);
        if (fragmentation === FASTPATH_FRAGMENT_NEXT) continue;
        if (fragmentation !== FASTPATH_FRAGMENT_LAST) continue;
        payload = Buffer.concat(this.fragments);
        this.fragments = [];
      }

      this.handleFastpathUpdate(updateCode, new BinaryReader(payload));
    }
  }

  private handleFastpathUpdate(updateCode: number, r: BinaryReader): void {
    this.updateCodeCounts.set(updateCode, (this.updateCodeCounts.get(updateCode) ?? 0) + 1);
    switch (updateCode) {
      case FASTPATH_UPDATETYPE_BITMAP:
        r.uint16le(); // updateType, redundant zum Fastpath-Code
        this.emitBitmaps(parseBitmapUpdate(r));
        break;
      case FASTPATH_UPDATETYPE_PALETTE:
        r.uint16le();
        this.palette = parsePaletteUpdate(r).entries;
        break;
      case FASTPATH_UPDATETYPE_SURFCMDS:
        this.handleSurfaceCommands(r);
        break;
      case FASTPATH_UPDATETYPE_PTR_POSITION:
        this.emit('pointerPosition', { x: r.uint16le(), y: r.uint16le() });
        break;
      case FASTPATH_UPDATETYPE_PTR_NULL:
        this.emit('pointerHidden');
        break;
      case FASTPATH_UPDATETYPE_PTR_DEFAULT:
        this.emit('pointer', null);
        break;
      case FASTPATH_UPDATETYPE_COLOR:
        this.cacheAndEmitPointer(parsePointerImage(r, 24));
        break;
      case FASTPATH_UPDATETYPE_POINTER: {
        const xorBpp = r.uint16le();
        this.cacheAndEmitPointer(parsePointerImage(r, xorBpp));
        break;
      }
      case FASTPATH_UPDATETYPE_CACHED: {
        const cached = this.pointerCache.get(r.uint16le());
        if (cached) this.emit('pointer', cached);
        break;
      }
      default:
        this.log.debug(`Unbehandeltes Fastpath-Update 0x${updateCode.toString(16)}`);
    }
  }

  /**
   * Surface Bits sind der Weg, auf dem aktuelle Windows-Versionen Grafik
   * liefern. Sie landen im selben 'bitmap'-Ereignis wie klassische Updates -
   * fuer die Anzeige macht es keinen Unterschied.
   */
  private handleSurfaceCommands(r: BinaryReader): void {
    const decoded: DecodedBitmap[] = [];
    for (const bits of parseSurfaceCommands(r)) {
      try {
        decoded.push(decodeSurfaceBits(bits));
      } catch (err) {
        this.log.warn(`Surface Bits konnten nicht dekodiert werden: ${(err as Error).message}`);
      }
    }
    if (decoded.length) {
      if (this.bitmapCount === 0) {
        this.log.info(`Erste Bilddaten empfangen (Surface Bits, ${decoded.length} Kacheln)`);
      }
      this.bitmapCount += decoded.length;
      this.emit('bitmap', decoded);
    }
  }

  private emitBitmaps(rects: BitmapRectangle[]): void {
    const decoded: DecodedBitmap[] = [];
    for (const rect of rects) {
      try {
        decoded.push(decodeBitmap(rect, this.palette));
      } catch (err) {
        // Ein defektes Rechteck darf nicht die ganze Sitzung beenden.
        this.log.warn(`Bitmap konnte nicht dekodiert werden: ${(err as Error).message}`);
      }
    }
    if (decoded.length) {
      if (this.bitmapCount === 0) {
        this.log.info(`Erste Bilddaten empfangen (${decoded.length} Kacheln)`);
      }
      this.bitmapCount += decoded.length;
      this.emit('bitmap', decoded);
    }
  }

  // -------------------------------------------------------------- Eingaben

  /** Mausbewegung/-klick. Koordinaten sind Desktop-Pixel. */
  sendPointerEvent(x: number, y: number, flags: number): void {
    if (this.phase !== 'active') return;
    this.sendPdu(
      pdu.buildInputPdu(this.shareId, this.userId, [pdu.mouseEvent(flags, Math.round(x), Math.round(y))]),
    );
  }

  sendMouseMove(x: number, y: number): void {
    this.sendPointerEvent(x, y, PTRFLAGS_MOVE);
  }

  sendMouseButton(x: number, y: number, buttonFlag: number, down: boolean): void {
    this.sendPointerEvent(x, y, buttonFlag | (down ? PTRFLAGS_DOWN : 0));
  }

  /** Erweiterte Maustasten (Zurueck/Vorwaerts). */
  sendMouseExtendedButton(x: number, y: number, buttonFlag: number, down: boolean): void {
    if (this.phase !== 'active') return;
    this.sendPdu(
      pdu.buildInputPdu(this.shareId, this.userId, [
        pdu.mouseExEvent(buttonFlag | (down ? PTRFLAGS_DOWN : 0), Math.round(x), Math.round(y)),
      ]),
    );
  }

  /** Tastendruck als PC/AT-Scancode (Set 1). */
  sendKeyScancode(scancode: number, down: boolean, extended = false): void {
    if (this.phase !== 'active') return;
    const flags = (down ? KBDFLAGS_DOWN : KBDFLAGS_RELEASE) | (extended ? KBDFLAGS_EXTENDED : 0);
    this.sendPdu(pdu.buildInputPdu(this.shareId, this.userId, [pdu.scancodeEvent(flags, scancode)]));
  }

  /** Zeichen direkt als Unicode senden - unabhaengig vom Serverlayout. */
  sendUnicode(codePoint: number, down: boolean): void {
    if (this.phase !== 'active') return;
    const flags = down ? 0 : KBDFLAGS_RELEASE;
    this.sendPdu(pdu.buildInputPdu(this.shareId, this.userId, [pdu.unicodeEvent(flags, codePoint)]));
  }

  /** Zustand von Num-/Caps-/Scroll-Lock mit dem Server abgleichen. */
  sendSyncEvent(toggleFlags: number): void {
    if (this.phase !== 'active') return;
    this.sendPdu(pdu.buildInputPdu(this.shareId, this.userId, [pdu.syncEvent(toggleFlags)]));
  }

  /**
   * Fordert den Server auf, einen Bereich komplett neu zu senden.
   * @returns false, wenn der Server das Refresh Rect PDU nicht unterstuetzt.
   */
  refresh(rect?: pdu.Rect): boolean {
    if (this.phase !== 'active') return false;
    if (this.serverCapabilities && this.serverCapabilities.refreshRectSupport === false) {
      this.log.debug('Server unterstuetzt kein Refresh Rect PDU - Anforderung wird nicht gesendet');
      return false;
    }
    const area = rect ?? { left: 0, top: 0, right: this.opts.width - 1, bottom: this.opts.height - 1 };
    this.sendPdu(pdu.buildRefreshRect(this.shareId, this.userId, [area]));
    return true;
  }

  /**
   * Zaehlt die empfangenen Update-Arten. Bleibt das Bild schwarz, zeigt sich
   * hier, ob der Server ueberhaupt etwas schickt und in welcher Form.
   */
  getDiagnostics(): RdpDiagnostics {
    const hex = (map: Map<number, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [code, count] of map) out[`0x${code.toString(16)}`] = count;
      return out;
    };
    return {
      bitmaps: this.bitmapCount,
      updateCodes: hex(this.updateCodeCounts),
      supportsRefreshRect: this.serverCapabilities?.refreshRectSupport !== false,
      activations: this.activations,
      ioChannelId: this.ioChannelId,
      frames: { ...this.frameCounts },
      sharePduTypes: hex(this.sharePduCounts),
      dataPduTypes: hex(this.dataPduCounts),
      virtualChannelBytes: Object.fromEntries(this.virtualChannelBytes),
      dynamicChannels: [...this.angeboteneKanaele],
      graphicsBytes: this.graphicsBytes,
      graphicsCodecs: this.egfx?.getCodecCounts() ?? {},
      graphicsAvc: this.egfx?.getAvcStats() ?? { regionen: 0, bytes: 0 },
    };
  }

  /** Bildaktualisierung anhalten bzw. fortsetzen (spart Bandbreite bei verdecktem Fenster). */
  setOutputSuppressed(suppressed: boolean): void {
    if (this.phase !== 'active') return;
    this.sendPdu(
      pdu.buildSuppressOutput(this.shareId, this.userId, !suppressed, {
        left: 0,
        top: 0,
        right: this.opts.width - 1,
        bottom: this.opts.height - 1,
      }),
    );
  }

  // ---------------------------------------------------------------- Intern

  private sendPdu(payload: Buffer): void {
    this.sendMcs(this.ioChannelId, payload);
  }

  private sendMcs(channelId: number, payload: Buffer): void {
    this.transport.write(tpkt(mcs.buildSendDataRequest(this.userId, channelId, payload)));
  }

  /** Fehlercodes, die beim Abbau der Verbindung normal sind und kein Problem darstellen. */
  private static readonly TEARDOWN_CODES = new Set([
    'EPIPE',
    'ECONNRESET',
    'ERR_STREAM_DESTROYED',
    'ERR_STREAM_WRITE_AFTER_END',
  ]);

  private fail(err: Error): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'reconnecting') {
      // Nachzuegler des alten Transports waehrend der Wartezeit.
      this.log.debug(`Fehler waehrend der Wartezeit auf den naechsten Versuch: ${err.message}`);
      return;
    }
    if (this.phase === 'connecting') {
      // Waehrend des Verbindungsaufbaus traegt die Zusage von connect() den
      // Fehler. Ein zusaetzliches Ereignis wuerde einen Wiederholversuch
      // faelschlich als endgueltigen Fehler erscheinen lassen.
      this.log.debug(`Fehler waehrend des Verbindungsaufbaus: ${err.message}`);
      return;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code && RdpClient.TEARDOWN_CODES.has(code)) {
      // Der Server hat die Verbindung getrennt - das ist ein Ende, kein Fehler.
      this.log.debug(`Verbindung beim Abbau unterbrochen (${code})`);
      this.handleClose('Die Verbindung wurde vom Server getrennt.');
      return;
    }
    this.emit('error', err);
  }

  private handleClose(reason?: string): void {
    if (this.phase === 'closed') return;
    if (this.phase === 'reconnecting') return;
    if (this.phase === 'connecting') {
      // Gleiche Begruendung wie in fail(): der Abbruch kommt ueber connect() zurueck.
      this.log.debug('Verbindung waehrend des Aufbaus geschlossen');
      return;
    }
    const grund = reason ?? this.lastErrorInfo;
    if (this.starteWiederverbindung(grund)) return;
    this.phase = 'closed';
    this.emit('close', grund);
  }

  // ------------------------------------------- Automatischer Wiederaufbau

  /**
   * Entscheidet, ob aus einem Verbindungsverlust eine Wiederholung wird, und
   * startet sie gegebenenfalls. Liefert true, wenn 'close' zu unterbleiben hat.
   */
  private starteWiederverbindung(grund?: string): boolean {
    if (!this.arc.aktiv) return false;
    // Ein gewolltes Trennen ist kein Verlust. Das ist der eine Unterschied,
    // an dem die ganze Unterscheidung haengt.
    if (this.benutzerTrennung) return false;
    if (this.phase !== 'active') return false;
    if (this.lastErrorInfoCode !== undefined && SITZUNG_ENDGUELTIG_BEENDET.has(this.lastErrorInfoCode)) {
      this.log.info(`Kein Wiederaufbau: die Sitzung ist endgueltig beendet (${this.lastErrorInfo})`);
      return false;
    }
    if (this.arc.maxVersuche < 1) return false;

    this.arcGrund = grund;
    this.arcLetzterFehler = undefined;
    this.arcVersuch = 0;
    this.phase = 'reconnecting';
    this.planeNaechstenVersuch();
    return true;
  }

  private planeNaechstenVersuch(): void {
    this.arcVersuch += 1;
    const wartezeit = backoffWartezeit(this.arcVersuch, this.arc.backoff, this.arc.zufall);
    this.log.info(
      `Verbindung verloren - Versuch ${this.arcVersuch}/${this.arc.maxVersuche} in ${wartezeit} ms`,
    );
    this.emit('reconnecting', {
      attempt: this.arcVersuch,
      maxAttempts: this.arc.maxVersuche,
      delayMs: wartezeit,
      reason: this.arcGrund,
    });
    this.arcTimer = setTimeout(() => {
      void this.fuehreVersuchAus();
    }, wartezeit);
  }

  private async fuehreVersuchAus(): Promise<void> {
    this.arcTimer = undefined;
    // Zwischenzeitlich getrennt? Dann ist hier nichts mehr zu tun. Die Phase
    // liegt bewusst in einer Variablen: sonst schreibt der Compiler sie fuer
    // den Rest der Methode fest und uebersieht, dass der abgewartete
    // Handshake sie veraendert.
    const phaseVorher: Phase = this.phase;
    if (phaseVorher !== 'reconnecting' || this.benutzerTrennung) return;

    this.setzeSitzungszustandZurueck();
    // Dasselbe TLS-Profil wie zuletzt: welches der Server vertraegt, wurde
    // beim Erstaufbau bereits ermittelt.
    this.resetForRetry(this.tlsProfile);

    try {
      await this.runHandshake();
    } catch (err) {
      this.arcLetzterFehler = err as Error;
      this.log.warn(`Versuch ${this.arcVersuch} gescheitert: ${(err as Error).message}`);
      this.transport.removeAllListeners();
      this.transport.close();
      if (this.benutzerTrennung || this.phase === 'closed') return;
      this.phase = 'reconnecting';
      if (this.arcVersuch >= this.arc.maxVersuche) this.gibAuf();
      else this.planeNaechstenVersuch();
      return;
    }

    if (this.benutzerTrennung) {
      // Der Benutzer hat waehrend des Handshakes abgebrochen.
      this.phase = 'closed';
      this.transport.close();
      return;
    }

    const versuch = this.arcVersuch;
    const fortgesetzt = this.arcCookieGesendet;
    this.arcVersuch = 0;
    this.arcLetzterFehler = undefined;
    this.arcGrund = undefined;
    this.log.info(
      `Wiederverbunden im Versuch ${versuch}` +
        (fortgesetzt ? ' - mit Cookie, also zurueck in dieselbe Sitzung' : ' - ohne Cookie'),
    );
    this.emit('reconnected', { attempt: versuch, resumedSession: fortgesetzt });
  }

  private gibAuf(): void {
    const versuche = this.arcVersuch;
    const grund = this.arcGrund;
    const letzterFehler = this.arcLetzterFehler;
    this.arcVersuch = 0;
    this.arcGrund = undefined;
    this.phase = 'closed';
    this.log.warn(`Wiederverbindung nach ${versuche} Versuchen aufgegeben`);
    this.emit('gaveUp', { attempts: versuche, lastError: letzterFehler, reason: grund });
    // Die alte Zusage bleibt bestehen: auf ein Sitzungsende folgt genau ein
    // 'close'. Es kommt jetzt nur spaeter als frueher.
    this.emit('close', grund);
  }

  /** Bricht eine laufende Wiederholung ab, ohne ein Ereignis auszuloesen. */
  private brichWiederverbindungAb(): void {
    if (this.arcTimer) {
      clearTimeout(this.arcTimer);
      this.arcTimer = undefined;
    }
    this.arcVersuch = 0;
    this.arcGrund = undefined;
  }
}

/** MCS-Nutzlast eines Slowpath-Frames: TPKT-Header und X.224-Datenheader entfernen. */
function mcsPayload(frame: Buffer): Buffer {
  return parseFrame(frame).payload.subarray(3);
}

/**
 * Oeffentlicher Schluessel des Serverzertifikats im DER-Format, wie CredSSP ihn
 * zur Kanalbindung erwartet (bei RSA die reine PKCS#1-Struktur).
 */
export function serverPublicKeyDer(socket: tls.TLSSocket): Buffer {
  const cert: X509Certificate | undefined = socket.getPeerX509Certificate?.();
  if (cert) {
    const key = cert.publicKey;
    if (key.asymmetricKeyType === 'rsa') {
      return key.export({ type: 'pkcs1', format: 'der' });
    }
    return key.export({ type: 'spki', format: 'der' });
  }
  const legacy = socket.getPeerCertificate();
  if (!legacy?.pubkey) throw new RdpError('Serverzertifikat konnte nicht gelesen werden', 'RDP_TLS');
  // Aeltere Node-Versionen liefern SubjectPublicKeyInfo - in PKCS#1 umwandeln.
  const key = createPublicKey({ key: legacy.pubkey, format: 'der', type: 'spki' });
  return key.asymmetricKeyType === 'rsa'
    ? key.export({ type: 'pkcs1', format: 'der' })
    : key.export({ type: 'spki', format: 'der' });
}

/**
 * Nennt einen Data-PDU-Typ beim Namen (MS-RDPBCGR 2.2.8.1.1.1.2).
 *
 * Eine nackte Zahl unter "unbehandelt" liest sich in einem Protokoll wie ein
 * Mangel. Tatsaechlich sind Synchronize, Control und Font Map die normale
 * Aktivierungsfolge und Save Session Info die Anmeldebestaetigung - wir
 * brauchen aus keinem davon etwas. Wer ein Protokoll durchsieht, soll das auf
 * einen Blick unterscheiden koennen von etwas, das uns wirklich entgeht.
 */
function benenneDataPdu(typ: number): string {
  const namen: Record<number, string> = {
    [PDUTYPE2_UPDATE]: 'Update',
    [PDUTYPE2_CONTROL]: 'Control',
    [PDUTYPE2_POINTER]: 'Pointer',
    [PDUTYPE2_INPUT]: 'Input',
    [PDUTYPE2_SYNCHRONIZE]: 'Synchronize',
    [PDUTYPE2_REFRESH_RECT]: 'Refresh Rect',
    [PDUTYPE2_PLAY_SOUND]: 'Play Sound',
    [PDUTYPE2_SUPPRESS_OUTPUT]: 'Suppress Output',
    [PDUTYPE2_SHUTDOWN_REQUEST]: 'Shutdown Request',
    [PDUTYPE2_SHUTDOWN_DENIED]: 'Shutdown Denied',
    [PDUTYPE2_SAVE_SESSION_INFO]: 'Save Session Info',
    [PDUTYPE2_FONTLIST]: 'Font List',
    [PDUTYPE2_FONTMAP]: 'Font Map',
  };
  const name = namen[typ];
  return name ? `${name} (0x${typ.toString(16)})` : `unbekannt 0x${typ.toString(16)}`;
}
