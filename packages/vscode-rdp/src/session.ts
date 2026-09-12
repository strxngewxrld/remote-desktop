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
} from 'ts-rdp';
import { RdpConnection, secretKey } from './connections.js';
import { BandbreitenProfilName, berechnePerformanceFlags, istProfilName } from './bandbreite.js';
import { CertificateTrustStore, TrustPolicy } from './trust.js';
import { resolveKeyboardLayout } from './keyboardLayouts.js';
import { renderWebview } from './webview.js';

/** Ein Rastschritt des Mausrads, wie ihn Windows erwartet. */
const WHEEL_STEP = 120;

interface ReadyMessage {
  type: 'ready';
  width: number;
  height: number;
  devicePixelRatio: number;
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
  ) {}

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
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'rdp-icon.svg');

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'rdp.disconnect';

    const session = new RdpSession(panel, context, connection, output, trustStore, statusBar);
    session.disposables.push(statusBar);
    session.wirePanel();
    return session;
  }

  private wirePanel(): void {
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState(() => {
        vscode.commands.executeCommand('setContext', 'rdp.sessionFocused', this.panel.active);
        if (this.panel.active) this.updateStatusBar();
      }),
      this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)),
    );
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        await this.start(message as ReadyMessage);
        break;
      case 'reconnect':
        this.painted = false;
        this.verbindungSteht = false;
        this.clearWatchdog();
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
        enableGraphicsPipeline: config.get<boolean>('graphicsPipeline', true),
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
        await this.context.secrets.store(secretKey(this.connection), credentials.password);
      }
    } catch (error) {
      const err = error as Error;
      this.log(`Fehler: ${err.stack ?? err.message}`);
      this.setState('error', 'Verbindung fehlgeschlagen', humanizeError(err), 'Erneut verbinden');
      // Ein falsches Passwort soll nicht dauerhaft gespeichert bleiben.
      if (/CredSSP|Anmelde|Zugangsdaten/i.test(err.message)) {
        await this.context.secrets.delete(secretKey(this.connection));
      }
    }
  }

  private resolveResolution(ready: ReadyMessage, config: vscode.WorkspaceConfiguration): { width: number; height: number } {
    if (this.connection.width && this.connection.height) {
      return { width: this.connection.width, height: this.connection.height };
    }
    const ratio = config.get<boolean>('highDpi', false) ? Math.min(ready.devicePixelRatio || 1, 2) : 1;
    // RDP mag Breiten, die durch 4 teilbar sind; ausserdem sinnvolle Grenzen setzen.
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(max, Math.floor((value * ratio) / 4) * 4));
    return {
      width: clamp(ready.width, 640, 4096),
      height: clamp(ready.height, 480, 2160),
    };
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

  private async resolveCredentials(): Promise<{ username: string; password: string; shouldSave: boolean } | undefined> {
    let username = this.connection.username;
    if (!username) {
      username = await vscode.window.showInputBox({
        title: `Anmeldung an ${this.connection.host}`,
        prompt: 'Benutzername (optional mit Domäne: DOMAIN\\benutzer)',
        ignoreFocusOut: true,
      });
      if (username === undefined) return undefined;
    }

    let domain = this.connection.domain ?? '';
    if (username.includes('\\')) {
      const [d, u] = username.split('\\', 2);
      domain = d;
      username = u;
      this.connection.domain = domain;
    }

    const stored = await this.context.secrets.get(secretKey(this.connection));
    if (stored) return { username, password: stored, shouldSave: false };

    const password = await vscode.window.showInputBox({
      title: `Anmeldung an ${this.connection.host}`,
      prompt: `Passwort für ${domain ? domain + '\\' : ''}${username}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return undefined;

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
      this.post({
        type: 'init',
        width: client.width,
        height: client.height,
        scaling: config.get<string>('scaling', 'fit'),
        smooth: config.get<boolean>('smoothScaling', false),
      });
      // Die Verbindung steht, aber gezeichnet ist noch nichts. Bis zur ersten
      // Kachel bleibt die Einblendung stehen - eine schwarze Flaeche waere
      // nicht von einem Fehler zu unterscheiden.
      this.setState('waiting', 'Verbunden', 'Warte auf den Bildschirminhalt des Servers…');
      this.updateStatusBar();
      this.log(`Verbunden mit ${this.connection.host} (${client.width}x${client.height})`);
      this.startWatchdog(client);
    });

    client.on('bitmap', (tiles: DecodedBitmap[]) => this.sendTiles(tiles));

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
      this.setState('closed', 'Sitzung beendet', reason ?? 'Die Verbindung wurde geschlossen.', 'Erneut verbinden');
      this.updateStatusBar();
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

    this.post({ type: 'bitmap', rects, data: this.encode(Buffer.concat(buffers, offset)) });
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

  applyConfiguration(): void {
    const config = vscode.workspace.getConfiguration('rdp');
    this.post({
      type: 'config',
      scaling: config.get<string>('scaling', 'fit'),
      smooth: config.get<boolean>('smoothScaling', false),
    });
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
    if (this.isConnected) {
      this.statusBar.text = `$(vm-active) ${this.title}`;
      this.statusBar.tooltip = `RDP-Sitzung aktiv: ${this.connection.host}`;
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString('de-DE')}] ${this.connection.host}: ${message}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearWatchdog();
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
