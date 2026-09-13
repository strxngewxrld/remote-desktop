import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  BaumKnoten, ConnectionNode, FolderNode, CredentialSettings, Credential,
  credentialSecretKey, schreibeEintragAn, loeseCredentialsAuf, parseUsername,
} from './connections.js';

/** Metadaten in Einstellungen, Passwörter ausschließlich in SecretStorage. */
export async function verwalteCredentials(context: vscode.ExtensionContext, node?: BaumKnoten): Promise<void> {
  const config = vscode.workspace.getConfiguration('rdp');
  const own: CredentialSettings = { ...(node instanceof FolderNode ? node.ordner.settings :
    node instanceof ConnectionNode ? node.connection : config.get<CredentialSettings>('authentication', {})) };
  own.credentials = loeseCredentialsAuf([own]).credentials ?? [];
  const parents = node ? [config.get<CredentialSettings>('authentication', {}), ...node.ordnerKette.map(o => o.settings ?? {})] : [];
  const title = `Zugangsdaten: ${node instanceof FolderNode ? node.ordner.name : node instanceof ConnectionNode ? node.connection.name : 'Oberste Ebene'}`;
  const save = async () => {
    if (node instanceof FolderNode) await schreibeEintragAn(node.pfad, { ...node.ordner, settings: { ...node.ordner.settings, ...own } });
    else if (node instanceof ConnectionNode) await schreibeEintragAn(node.pfad, { ...node.connection, ...own });
    else await config.update('authentication', own, vscode.ConfigurationTarget.Global);
  };
  while (true) {
    const effective = loeseCredentialsAuf([...parents, own]);
    const action = await vscode.window.showQuickPick([
      { label: 'Zugangsdaten hinzufügen', value: 'add' },
      { label: 'Standard auswählen', value: 'default' },
      { label: own.promptCredentials ? 'Vererbte Zugangsdaten verwenden' : 'Immer nach Zugangsdaten fragen', value: 'prompt' },
      ...effective.credentials!.map(c => ({ label: c.name, description: `${c.domain ? c.domain + '\\' : ''}${c.username}${effective.defaultCredential === c.id ? ' · Standard' : ''}${own.credentials!.some(o => o.id === c.id) ? '' : ' · geerbt'}`, value: c.id })),
    ], { title, ignoreFocusOut: true });
    if (!action) return;
    if (action.value === 'prompt') { own.promptCredentials = !own.promptCredentials; await save(); continue; }
    if (action.value === 'default') {
      const selected = await vscode.window.showQuickPick([
        { label: 'Bei jeder Verbindung auswählen', value: '' },
        ...effective.credentials!.map(c => ({ label: c.name, description: c.username, value: c.id })),
      ], { title: 'Standard-Zugangsdaten', ignoreFocusOut: true });
      if (selected) { own.defaultCredential = selected.value; await save(); }
      continue;
    }
    let existing: Credential | undefined;
    if (action.value !== 'add') {
      existing = effective.credentials!.find(c => c.id === action.value);
      if (!existing) continue;
      const local = own.credentials!.some(c => c.id === existing!.id);
      const edit = await vscode.window.showQuickPick((local ? ['Bearbeiten', 'Entfernen'] : ['Als eigenes Profil kopieren']).map(label => ({ label })), { title: existing.name });
      if (!edit) continue;
      if (edit.label === 'Entfernen') {
        own.credentials = own.credentials!.filter(c => c.id !== existing!.id);
        if (own.defaultCredential === existing.id) own.defaultCredential = '';
        await save();
        // Das Secret kann in anderen Teilbäumen noch referenziert sein.
        continue;
      }
      if (!local) existing = { ...existing, id: randomUUID() };
    }
    const name = await vscode.window.showInputBox({ title: 'Name der Zugangsdaten', value: existing?.name, ignoreFocusOut: true });
    if (!name?.trim()) continue;
    const user = await vscode.window.showInputBox({
      title: 'Benutzername (DOMAIN\\Benutzer möglich)',
      value: existing ? `${existing.domain ? existing.domain + '\\' : ''}${existing.username}` : '',
      validateInput: value => parseUsername(value) ? undefined : 'Benutzername oder DOMAIN\\Benutzer angeben.',
      ignoreFocusOut: true,
    });
    const login = user === undefined ? undefined : parseUsername(user);
    if (!login) continue;
    const password = await vscode.window.showInputBox({ title: 'Passwort (leer: bei Verbindung abfragen)', password: true, ignoreFocusOut: true });
    if (password === undefined) continue;
    const credential: Credential = { id: existing?.id ?? randomUUID(), name: name.trim(), ...login };
    if (password) await context.secrets.store(credentialSecretKey(credential.id), password);
    else await context.secrets.delete(credentialSecretKey(credential.id));
    own.credentials = [...own.credentials!.filter(c => c.id !== credential.id), credential];
    own.promptCredentials = false;
    await save();
  }
}
