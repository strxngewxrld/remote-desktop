/**
 * Einstiegspunkt der Extension: Befehle, Seitenleiste und Sitzungsverwaltung.
 */
import * as vscode from 'vscode';
import {
  ConnectionNode,
  ConnectionTreeProvider,
  RdpConnection,
  addConnection,
  getConnections,
  removeConnectionAt,
  saveConnections,
  secretKey,
  updateConnection,
} from './connections.js';
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
      const connection = node?.connection ?? (await pickConnection('Verbindung auswählen'));
      if (connection) await openSession(context, connection, output, trustStore);
    }),

    vscode.commands.registerCommand('rdp.addConnection', async () => {
      const connection = await promptForConnection(true);
      if (!connection) return;
      await addConnection(connection);
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
      await updateConnection(target.index, updated);
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
      await context.secrets.delete(secretKey(target.connection));
      await removeConnectionAt(target.index);
      tree.refresh();
    }),

    vscode.commands.registerCommand('rdp.refreshConnections', () => tree.refresh()),

    vscode.commands.registerCommand('rdp.clearCredentials', async (node?: ConnectionNode) => {
      const target = node ?? (await pickConnectionNode('Passwort löschen'));
      if (!target) return;
      await context.secrets.delete(secretKey(target.connection));
      vscode.window.showInformationMessage(`Gespeichertes Passwort für "${target.connection.name}" gelöscht.`);
    }),

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

async function pickConnection(title: string): Promise<RdpConnection | undefined> {
  return (await pickConnectionNode(title))?.connection;
}

async function pickConnectionNode(title: string): Promise<ConnectionNode | undefined> {
  const connections = getConnections();
  if (connections.length === 0) {
    vscode.window.showInformationMessage('Es sind keine Verbindungen gespeichert.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((c, index) => ({
      label: c.name || c.host,
      description: c.host,
      node: new ConnectionNode(c, index),
    })),
    { title },
  );
  return picked?.node;
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
