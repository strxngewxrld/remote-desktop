/**
 * Verwaltung der gespeicherten Verbindungen: Einstellungen, Passwortspeicher
 * und die Baumansicht in der Seitenleiste.
 */
import * as vscode from 'vscode';

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
}

const SECTION = 'rdp';

export function getConnections(): RdpConnection[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<RdpConnection[]>('connections') ?? [];
  return raw.filter((c) => c && typeof c.host === 'string' && c.host.length > 0);
}

export async function saveConnections(connections: RdpConnection[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  // In den globalen Einstellungen ablegen, damit Verbindungen projektuebergreifend gelten.
  await config.update('connections', connections, vscode.ConfigurationTarget.Global);
}

export async function addConnection(connection: RdpConnection): Promise<void> {
  await saveConnections([...getConnections(), connection]);
}

export async function updateConnection(index: number, connection: RdpConnection): Promise<void> {
  const all = getConnections();
  all[index] = connection;
  await saveConnections(all);
}

/**
 * Entfernt genau den Eintrag an dieser Stelle.
 *
 * Ueber den Namen zu vergleichen waere falsch: die Objekte aus
 * `getConnections()` sind frisch deserialisiert, die Identitaetspruefung
 * greift also nie, und der Namensvergleich allein loescht bei zwei gleich
 * benannten Verbindungen beide. Die Baumknoten fuehren ohnehin einen genauen
 * Index mit, den `updateConnection` bereits benutzt.
 */
export async function removeConnectionAt(index: number): Promise<void> {
  const alle = getConnections();
  if (index < 0 || index >= alle.length) return;
  alle.splice(index, 1);
  await saveConnections(alle);
}

/** Schluessel im sicheren Speicher - Passwoerter gehoeren nie in settings.json. */
export function secretKey(connection: RdpConnection): string {
  const user = connection.domain ? `${connection.domain}\\${connection.username ?? ''}` : connection.username ?? '';
  return `rdp:${user}@${connection.host}:${connection.port ?? 3389}`;
}

export class ConnectionNode extends vscode.TreeItem {
  constructor(
    public readonly connection: RdpConnection,
    public readonly index: number,
  ) {
    super(connection.name || connection.host, vscode.TreeItemCollapsibleState.None);
    const user = connection.domain
      ? `${connection.domain}\\${connection.username ?? ''}`
      : connection.username ?? '';
    this.description = user ? `${user} · ${connection.host}` : connection.host;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${connection.name || connection.host}**`,
        '',
        `- Host: \`${connection.host}:${connection.port ?? 3389}\``,
        user ? `- Anmeldung: \`${user}\`` : '- Anmeldung: wird beim Verbinden abgefragt',
        connection.width && connection.height
          ? `- Auflösung: ${connection.width}×${connection.height}`
          : '- Auflösung: an Panelgröße angepasst',
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
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: ConnectionNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ConnectionNode[] {
    return getConnections().map((c, i) => new ConnectionNode(c, i));
  }
}
