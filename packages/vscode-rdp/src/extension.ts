/**
 * Einstiegspunkt der Extension: Befehle, Seitenleiste und Sitzungsverwaltung.
 */
import * as vscode from 'vscode';
import {
  BaumKnoten,
  ConnectionNode,
  ConnectionTreeProvider,
  FolderNode,
  RdpConnection,
  RdpFolder,
  VERERBBARE_SCHLUESSEL,
  VerbindungsEintrag,
  VererbbareEinstellungen,
  addConnection,
  addFolder,
  alleVerbindungen,
  effektiveTags,
  entferneEintragAn,
  getBaum,
  istOrdner,
  pfadText,
  saveConnections,
  schreibeEintragAn,
  secretKey,
  verschiebeEintrag,
} from './connections.js';
import { BANDBREITEN_PROFILE, BandbreitenProfilName, PROFIL_NAMEN } from './bandbreite.js';
import { berichtUeberRest, dekodiereRdpDatei, exportiereRdpDatei, importiereRdpDatei } from './rdpDatei.js';
import { RdpSession } from './session.js';
import { CertificateTrustStore } from './trust.js';
import { KEYBOARD_LAYOUTS } from './keyboardLayouts.js';

/** Alle offenen Sitzungen, damit Befehle die aktive Sitzung finden. */
const sessions = new Set<RdpSession>();

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Remote Desktop (RDP)');
  const trustStore = new CertificateTrustStore(context);
  const tree = new ConnectionTreeProvider();
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider('rdpConnections', tree),

    vscode.commands.registerCommand('rdp.connect', async () => {
      const connection = await promptForConnection();
      if (connection) await openSession(context, connection, output, trustStore);
    }),

    vscode.commands.registerCommand('rdp.connectSaved', async (node?: ConnectionNode) => {
      // Immer die aufgeloeste Fassung verbinden: erst darin stecken die
      // Werte, die der Eintrag von seinen Ordnern erbt.
      const connection = node?.aufgeloest ?? (await pickConnectionNode('Verbindung auswählen'))?.aufgeloest;
      if (connection) await openSession(context, connection, output, trustStore);
    }),

    vscode.commands.registerCommand('rdp.addConnection', async (node?: BaumKnoten) => {
      const connection = await promptForConnection(true);
      if (!connection) return;
      await addConnection(connection, zielOrdnerPfad(node));
      tree.refresh();
      const open = await vscode.window.showInformationMessage(
        `Verbindung "${connection.name}" gespeichert.`,
        'Jetzt verbinden',
      );
      if (open) await openSession(context, connection, output, trustStore);
    }),

    vscode.commands.registerCommand('rdp.editConnection', async (node?: ConnectionNode) => {
      const target = node ?? (await pickConnectionNode('Verbindung bearbeiten'));
      if (!target) return;
      const updated = await promptForConnection(true, target.connection);
      if (!updated) return;
      await schreibeEintragAn(target.pfad, updated);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.deleteConnection', async (node?: ConnectionNode) => {
      const target = node ?? (await pickConnectionNode('Verbindung löschen'));
      if (!target) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Verbindung "${target.connection.name}" löschen?`,
        { modal: true },
        'Löschen',
      );
      if (confirmed !== 'Löschen') return;
      await context.secrets.delete(secretKey(target.aufgeloest));
      await entferneEintragAn(target.pfad);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.refreshConnections', () => tree.refresh()),

    vscode.commands.registerCommand('rdp.clearCredentials', async (node?: ConnectionNode) => {
      const target = node ?? (await pickConnectionNode('Passwort löschen'));
      if (!target) return;
      await context.secrets.delete(secretKey(target.aufgeloest));
      vscode.window.showInformationMessage(`Gespeichertes Passwort für "${target.connection.name}" gelöscht.`);
    }),

    // ------------------------------------------------------------- Ordner

    vscode.commands.registerCommand('rdp.addFolder', async (node?: BaumKnoten) => {
      const name = await vscode.window.showInputBox({
        title: 'Neuer Ordner',
        prompt: 'Ordner vererben ihre Einstellungen an die enthaltenen Verbindungen.',
        ignoreFocusOut: true,
      });
      if (!name?.trim()) return;
      await addFolder(name.trim(), zielOrdnerPfad(node));
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.renameFolder', async (node?: FolderNode) => {
      const target = node ?? (await pickFolderNode('Ordner umbenennen'));
      if (!target) return;
      const name = await vscode.window.showInputBox({
        title: 'Ordner umbenennen',
        value: target.ordner.name,
        ignoreFocusOut: true,
      });
      if (!name?.trim()) return;
      await schreibeEintragAn(target.pfad, { ...target.ordner, name: name.trim() });
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.deleteFolder', async (node?: FolderNode) => {
      const target = node ?? (await pickFolderNode('Ordner löschen'));
      if (!target) return;
      const anzahl = zaehleVerbindungen(target.ordner);
      const confirmed = await vscode.window.showWarningMessage(
        anzahl > 0
          ? `Ordner "${target.ordner.name}" mit ${anzahl} Verbindung(en) löschen?`
          : `Ordner "${target.ordner.name}" löschen?`,
        { modal: true },
        'Löschen',
      );
      if (confirmed !== 'Löschen') return;
      await entferneEintragAn(target.pfad);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.editFolderSettings', async (node?: FolderNode) => {
      const target = node ?? (await pickFolderNode('Vererbte Einstellungen'));
      if (!target) return;
      const geaendert = await bearbeiteVererbteEinstellungen(target.ordner);
      if (!geaendert) return;
      await schreibeEintragAn(target.pfad, geaendert);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.moveToFolder', async (node?: BaumKnoten) => {
      const target = node ?? (await pickConnectionNode('Verbindung verschieben'));
      if (!target) return;
      const ziel = await pickOrdnerZiel('Zielordner', target.pfad);
      if (!ziel) return;
      const erfolg = await verschiebeEintrag(target.pfad, ziel.pfad);
      if (!erfolg) {
        vscode.window.showErrorMessage('Der Eintrag ließ sich nicht verschieben.');
        return;
      }
      tree.refresh();
    }),

    // ------------------------------------------------------- Tags & Suche

    vscode.commands.registerCommand('rdp.editTags', async (node?: ConnectionNode) => {
      const target = node ?? (await pickConnectionNode('Tags bearbeiten'));
      if (!target) return;
      const eingabe = await vscode.window.showInputBox({
        title: `Tags für "${target.connection.name || target.connection.host}"`,
        prompt: 'Mehrere Tags mit Komma trennen. Leer lassen, um alle zu entfernen.',
        value: (target.connection.tags ?? []).join(', '),
        ignoreFocusOut: true,
      });
      if (eingabe === undefined) return;
      const tags = eingabe
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const neu: RdpConnection = { ...target.connection };
      if (tags.length > 0) neu.tags = tags;
      else delete neu.tags;
      await schreibeEintragAn(target.pfad, neu);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.searchConnections', async () => {
      const target = await pickConnectionNode('Verbindung suchen (Name, Host, Tag)');
      if (target) await openSession(context, target.aufgeloest, output, trustStore);
    }),

    vscode.commands.registerCommand('rdp.filterConnections', async () => {
      const eingabe = await vscode.window.showInputBox({
        title: 'Verbindungen filtern',
        prompt: 'Filtert die Baumansicht nach Name, Host oder Tag. Leer lassen hebt den Filter auf.',
        value: tree.suchfilter,
        ignoreFocusOut: true,
      });
      if (eingabe === undefined) return;
      tree.setzeFilter(eingabe);
      await vscode.commands.executeCommand('setContext', 'rdp.filterAktiv', tree.suchfilter.length > 0);
    }),

    vscode.commands.registerCommand('rdp.clearConnectionFilter', async () => {
      tree.setzeFilter('');
      await vscode.commands.executeCommand('setContext', 'rdp.filterAktiv', false);
    }),

    // ------------------------------------------------------- Bandbreite

    vscode.commands.registerCommand('rdp.setBandwidthProfile', async (node?: BaumKnoten) => {
      const target = node ?? (await pickConnectionNode('Bandbreitenprofil setzen'));
      if (!target) return;
      const profil = await pickBandbreitenProfil(
        target instanceof FolderNode ? target.ordner.settings?.bandwidthProfile : target.connection.bandwidthProfile,
      );
      if (profil === undefined) return;
      if (target instanceof FolderNode) {
        const settings: VererbbareEinstellungen = { ...target.ordner.settings };
        if (profil === null) delete settings.bandwidthProfile;
        else settings.bandwidthProfile = profil;
        await schreibeEintragAn(target.pfad, ordnerMitEinstellungen(target.ordner, settings));
      } else {
        const neu: RdpConnection = { ...target.connection };
        if (profil === null) delete neu.bandwidthProfile;
        else neu.bandwidthProfile = profil;
        await schreibeEintragAn(target.pfad, neu);
      }
      tree.refresh();
    }),

    // ---------------------------------------------------- Import / Export

    vscode.commands.registerCommand('rdp.importRdpFile', async (node?: BaumKnoten) => {
      await importiereDateien(zielOrdnerPfad(node), output);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.exportRdpFile', async (node?: ConnectionNode) => {
      const target = node ?? (await pickConnectionNode('Verbindung exportieren'));
      if (!target) return;
      const vorschlag = (target.connection.name || target.connection.host).replace(/[\\/:*?"<>|]/g, '_');
      const ziel = await vscode.window.showSaveDialog({
        title: 'Als .rdp-Datei speichern',
        saveLabel: 'Exportieren',
        defaultUri: vscode.Uri.file(`${vorschlag}.rdp`),
        filters: { 'RDP-Dateien': ['rdp'] },
      });
      if (!ziel) return;
      // Die aufgeloeste Fassung schreiben: in der Datei sollen die vom Ordner
      // geerbten Werte auch wirklich stehen.
      const inhalt = exportiereRdpDatei(target.aufgeloest);
      await vscode.workspace.fs.writeFile(ziel, Buffer.from(inhalt, 'utf8'));
      vscode.window.showInformationMessage(
        `"${target.connection.name || target.connection.host}" als ${dateiName(ziel)} gespeichert. Tags und Anzeigename kennt das .rdp-Format nicht.`,
      );
    }),

    // --------------------------------------------------------- Sitzungen

    vscode.commands.registerCommand('rdp.disconnect', async () => {
      const session = await pickSession();
      session?.dispose();
    }),

    vscode.commands.registerCommand('rdp.sendCtrlAltDel', async () => {
      const session = await pickSession();
      session?.sendCtrlAltDelete();
    }),

    vscode.commands.registerCommand('rdp.refreshScreen', async () => {
      const session = await pickSession();
      session?.refreshScreen();
    }),

    vscode.commands.registerCommand('rdp.toggleScaling', async () => {
      const session = await pickSession();
      session?.toggleScaling();
    }),

    vscode.commands.registerCommand('rdp.showLog', () => output.show()),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('rdp.connections')) tree.refresh();
      if (event.affectsConfiguration('rdp.scaling') || event.affectsConfiguration('rdp.smoothScaling')) {
        for (const session of sessions) session.applyConfiguration();
      }
    }),
  );
}

export function deactivate(): void {
  for (const session of [...sessions]) session.dispose();
  sessions.clear();
}

async function openSession(
  context: vscode.ExtensionContext,
  connection: RdpConnection,
  output: vscode.OutputChannel,
  trustStore: CertificateTrustStore,
): Promise<void> {
  const session = await RdpSession.open(context, connection, output, trustStore);
  session.onDispose = () => sessions.delete(session);
  sessions.add(session);
}

async function pickSession(): Promise<RdpSession | undefined> {
  if (sessions.size === 0) {
    vscode.window.showInformationMessage('Es ist keine RDP-Sitzung geöffnet.');
    return undefined;
  }
  if (sessions.size === 1) return [...sessions][0];
  const picked = await vscode.window.showQuickPick(
    [...sessions].map((s) => ({ label: s.title, session: s })),
    { title: 'Sitzung auswählen' },
  );
  return picked?.session;
}

/** In welchen Ordner soll etwas Neues? Ein Ordnerknoten gibt das Ziel vor. */
function zielOrdnerPfad(node?: BaumKnoten): number[] {
  if (node instanceof FolderNode) return node.pfad;
  // Auf einer Verbindung stehend landet das Neue im selben Ordner wie sie.
  if (node instanceof ConnectionNode) return node.pfad.slice(0, -1);
  return [];
}

function zaehleVerbindungen(ordner: RdpFolder): number {
  let anzahl = 0;
  for (const eintrag of ordner.children) anzahl += istOrdner(eintrag) ? zaehleVerbindungen(eintrag) : 1;
  return anzahl;
}

function ordnerMitEinstellungen(ordner: RdpFolder, settings: VererbbareEinstellungen): RdpFolder {
  const neu: RdpFolder = { ...ordner };
  if (Object.keys(settings).length > 0) neu.settings = settings;
  else delete neu.settings;
  return neu;
}

async function pickConnectionNode(title: string): Promise<ConnectionNode | undefined> {
  const eintraege = alleVerbindungen();
  if (eintraege.length === 0) {
    vscode.window.showInformationMessage('Es sind keine Verbindungen gespeichert.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    eintraege.map((eintrag) => ({
      label: eintrag.verbindung.name || eintrag.verbindung.host,
      description: eintrag.verbindung.host,
      // Ordnerpfad und Tags stehen im Detail, damit die Suche des QuickPick
      // (matchOnDetail) auch darauf anspringt.
      detail: detailZeile(eintrag),
      node: new ConnectionNode(eintrag),
    })),
    { title, matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.node;
}

function detailZeile(eintrag: VerbindungsEintrag): string {
  const tags = effektiveTags(eintrag.verbindung, eintrag.ordnerKette).map((t) => '#' + t);
  return [pfadText(eintrag), ...tags].join('  ');
}

/** Alle Ordner als flache Liste, fuer Auswahldialoge. */
function alleOrdner(
  eintraege = getBaum(),
  pfad: number[] = [],
  namen: string[] = [],
): { ordner: RdpFolder; pfad: number[]; text: string }[] {
  const ergebnis: { ordner: RdpFolder; pfad: number[]; text: string }[] = [];
  eintraege.forEach((eintrag, index) => {
    if (!istOrdner(eintrag)) return;
    const eigenerPfad = [...pfad, index];
    const text = [...namen, eintrag.name].join(' / ');
    ergebnis.push({ ordner: eintrag, pfad: eigenerPfad, text });
    ergebnis.push(...alleOrdner(eintrag.children, eigenerPfad, [...namen, eintrag.name]));
  });
  return ergebnis;
}

async function pickFolderNode(title: string): Promise<FolderNode | undefined> {
  const ordner = alleOrdner();
  if (ordner.length === 0) {
    vscode.window.showInformationMessage('Es sind keine Ordner angelegt.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    ordner.map((o) => ({ label: o.text, node: new FolderNode(o.ordner, o.pfad, []) })),
    { title },
  );
  return picked?.node;
}

/** Zielordner zum Verschieben - die Wurzel steht als erster Eintrag drin. */
async function pickOrdnerZiel(title: string, quelle: number[]): Promise<{ pfad: number[] } | undefined> {
  const eintraege = [
    { label: '$(home) Oberste Ebene', pfad: [] as number[] },
    ...alleOrdner()
      // Ein Ordner darf nicht in sich selbst oder in sein eigenes Kind wandern.
      .filter((o) => !(o.pfad.length >= quelle.length && quelle.every((wert, i) => o.pfad[i] === wert)))
      .map((o) => ({ label: '$(folder) ' + o.text, pfad: o.pfad })),
  ];
  const picked = await vscode.window.showQuickPick(eintraege, { title });
  return picked ? { pfad: picked.pfad } : undefined;
}

/**
 * Auswahl eines Bandbreitenprofils.
 * `null` bedeutet "kein Profil", `undefined` bedeutet "abgebrochen".
 */
async function pickBandbreitenProfil(
  aktuell?: BandbreitenProfilName,
): Promise<BandbreitenProfilName | null | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Kein Profil',
        description: aktuell === undefined ? '(aktuell)' : undefined,
        detail: 'Es gelten die einzelnen Schalter unter rdp.performance.*',
        wert: null as BandbreitenProfilName | null,
      },
      ...PROFIL_NAMEN.map((name) => ({
        label: BANDBREITEN_PROFILE[name].titel,
        description: aktuell === name ? '(aktuell)' : name,
        detail: BANDBREITEN_PROFILE[name].beschreibung,
        wert: name as BandbreitenProfilName | null,
      })),
    ],
    { title: 'Bandbreitenprofil', ignoreFocusOut: true },
  );
  return picked ? picked.wert : undefined;
}

/** Bearbeitet ein Feld der vererbten Ordnereinstellungen. */
async function bearbeiteVererbteEinstellungen(ordner: RdpFolder): Promise<RdpFolder | undefined> {
  const settings: VererbbareEinstellungen = { ...ordner.settings };
  const feld = await vscode.window.showQuickPick(
    VERERBBARE_SCHLUESSEL.map((schluessel) => ({
      label: schluessel,
      description: settings[schluessel] === undefined ? 'nicht gesetzt' : String(settings[schluessel]),
      schluessel,
    })),
    { title: `Vererbte Einstellungen von "${ordner.name}"`, ignoreFocusOut: true },
  );
  if (!feld) return undefined;

  if (feld.schluessel === 'bandwidthProfile') {
    const profil = await pickBandbreitenProfil(settings.bandwidthProfile);
    if (profil === undefined) return undefined;
    if (profil === null) delete settings.bandwidthProfile;
    else settings.bandwidthProfile = profil;
    return ordnerMitEinstellungen(ordner, settings);
  }

  const zahlenfeld = ['port', 'width', 'height', 'colorDepth'].includes(feld.schluessel);
  const eingabe = await vscode.window.showInputBox({
    title: `${ordner.name}: ${feld.schluessel}`,
    prompt: 'Leer lassen, um den Wert zu entfernen. Verbindungen dürfen ihn überschreiben.',
    value: settings[feld.schluessel] === undefined ? '' : String(settings[feld.schluessel]),
    ignoreFocusOut: true,
    validateInput: (wert) =>
      zahlenfeld && wert.trim() && !/^\d+$/.test(wert.trim()) ? 'Bitte eine Zahl angeben.' : undefined,
  });
  if (eingabe === undefined) return undefined;
  const text = eingabe.trim();
  if (!text) delete settings[feld.schluessel];
  else if (zahlenfeld) (settings as Record<string, unknown>)[feld.schluessel] = Number(text);
  else (settings as Record<string, unknown>)[feld.schluessel] = text;
  return ordnerMitEinstellungen(ordner, settings);
}

// ------------------------------------------------------------ .rdp-Import

function dateiName(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.path;
}

/** Liest die ausgewaehlten .rdp-Dateien ein und legt sie im Zielordner ab. */
async function importiereDateien(zielPfad: number[], output: vscode.OutputChannel): Promise<void> {
  const dateien = await vscode.window.showOpenDialog({
    title: 'RDP-Dateien importieren',
    openLabel: 'Importieren',
    canSelectMany: true,
    filters: { 'RDP-Dateien': ['rdp'] },
  });
  if (!dateien || dateien.length === 0) return;

  const angelegt: string[] = [];
  const uebersprungen: string[] = [];
  let anmerkungen = 0;

  for (const uri of dateien) {
    const name = dateiName(uri);
    try {
      const daten = await vscode.workspace.fs.readFile(uri);
      const ergebnis = importiereRdpDatei(dekodiereRdpDatei(daten), name.replace(/\.rdp$/i, ''));
      if (!ergebnis.verbindung.host) {
        uebersprungen.push(`${name}: keine Serveradresse gefunden`);
        continue;
      }
      await addConnection(ergebnis.verbindung, zielPfad);
      angelegt.push(ergebnis.verbindung.name);
      const rest = berichtUeberRest(ergebnis);
      output.appendLine(`Import ${name}: ${ergebnis.uebernommen.join(', ')}`);
      for (const zeile of rest) output.appendLine(`  nicht übernommen - ${zeile}`);
      anmerkungen += rest.length;
    } catch (fehler) {
      uebersprungen.push(`${name}: ${(fehler as Error).message}`);
    }
  }

  if (angelegt.length === 0) {
    vscode.window.showErrorMessage(`Kein Import möglich. ${uebersprungen.join('; ')}`);
    return;
  }
  const text =
    `${angelegt.length} Verbindung(en) importiert: ${angelegt.join(', ')}.` +
    (anmerkungen > 0 ? ` ${anmerkungen} Einstellung(en) wurden nicht übernommen.` : '') +
    (uebersprungen.length > 0 ? ` Übersprungen: ${uebersprungen.join('; ')}.` : '');
  const antwort = await vscode.window.showInformationMessage(text, 'Protokoll anzeigen');
  if (antwort) output.show();
}

/**
 * Fragt die Verbindungsdaten ab. `withName` unterscheidet zwischen einer
 * einmaligen Verbindung und einem gespeicherten Eintrag.
 */
async function promptForConnection(withName = false, existing?: RdpConnection): Promise<RdpConnection | undefined> {
  const target = await vscode.window.showInputBox({
    title: existing ? 'Verbindung bearbeiten' : 'Neue RDP-Verbindung',
    prompt: 'Server als host oder host:port',
    placeHolder: 'server.example.com:3389',
    value: existing ? `${existing.host}${existing.port && existing.port !== 3389 ? ':' + existing.port : ''}` : '',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Bitte einen Hostnamen angeben.' : undefined),
  });
  if (!target) return undefined;

  const [host, portText] = splitHostPort(target.trim());
  const port = portText ? Number(portText) : 3389;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    vscode.window.showErrorMessage(`Ungültiger Port: ${portText}`);
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title: 'Benutzername',
    prompt: 'Optional mit Domäne: DOMAIN\\benutzer. Leer lassen, um beim Verbinden zu fragen.',
    value: existing ? (existing.domain ? `${existing.domain}\\${existing.username ?? ''}` : existing.username ?? '') : '',
    ignoreFocusOut: true,
  });
  if (user === undefined) return undefined;

  let domain = '';
  let username = user.trim();
  if (username.includes('\\')) {
    const [d, u] = username.split('\\', 2);
    domain = d;
    username = u;
  } else if (username.includes('@')) {
    // UPN-Schreibweise beibehalten, die versteht der Server selbst.
    domain = '';
  }

  let name = existing?.name ?? host;
  if (withName) {
    const input = await vscode.window.showInputBox({
      title: 'Anzeigename',
      value: existing?.name ?? host,
      ignoreFocusOut: true,
    });
    if (input === undefined) return undefined;
    name = input.trim() || host;
  }

  const layout = withName
    ? await vscode.window.showQuickPick(
        [
          { label: 'Standard verwenden', value: undefined as string | undefined },
          ...Object.keys(KEYBOARD_LAYOUTS).map((k) => ({ label: k, value: k })),
        ],
        { title: 'Tastaturlayout', ignoreFocusOut: true },
      )
    : undefined;

  return {
    ...existing,
    name,
    host,
    port,
    username: username || undefined,
    domain: domain || undefined,
    keyboardLayout: layout ? layout.value : existing?.keyboardLayout,
  };
}

/** Trennt "host:port", beruecksichtigt dabei IPv6-Adressen in Klammern. */
function splitHostPort(value: string): [string, string | undefined] {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end > 0) {
      const host = value.slice(1, end);
      const rest = value.slice(end + 1);
      return [host, rest.startsWith(':') ? rest.slice(1) : undefined];
    }
  }
  const index = value.lastIndexOf(':');
  if (index > 0 && !value.slice(index + 1).includes(':')) {
    return [value.slice(0, index), value.slice(index + 1)];
  }
  return [value, undefined];
}

export { saveConnections };
