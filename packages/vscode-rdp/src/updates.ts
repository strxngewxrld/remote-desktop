import * as vscode from 'vscode';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdates, downloadVsix } from './updateCheck.js';

const SKIPPED = 'rdp.skippedUpdateVersion';

/** Background checks never interrupt activation; installation requires an explicit action. */
export function registerUpdates(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('rdp.checkForUpdates', () => runUpdateCheck(context, true)));
  if (context.extensionMode === vscode.ExtensionMode.Production &&
      vscode.workspace.getConfiguration('rdp').get<boolean>('checkForUpdates', true)) {
    void runUpdateCheck(context, false).catch(() => undefined);
  }
}

export async function runUpdateCheck(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const manifest = context.extension.packageJSON as { version: string; repository?: { url?: string } };
  let reachedServer = false;
  const open = (url: string) => { void vscode.env.openExternal(vscode.Uri.parse(url)); };
  const release = await checkForUpdates({
    current: manifest.version,
    repositoryUrl: manifest.repository?.url ?? '',
    fetch: async (...args) => { const response = await fetch(...args); reachedServer = response.ok; return response; },
    skipped: manual ? undefined : context.globalState.get<string>(SKIPPED),
    async notify(release) {
      // A downloaded file on an SSH/WSL host cannot be passed as a local file URI to the UI installer.
      const canInstall = release.vsix && !vscode.env.remoteName;
      const choice = await vscode.window.showInformationMessage(
        `Remote Desktop ${release.version} ist verfügbar (installiert: ${manifest.version}).`,
        ...(canInstall ? ['Installieren'] : []), 'Release öffnen', 'Diese Version überspringen');
      return choice === 'Installieren' ? 'install' : choice === 'Release öffnen' ? 'open' : choice === 'Diese Version überspringen' ? 'skip' : undefined;
    },
    async install(release) {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Remote Desktop ${release.version} installieren…` }, async () => {
          const bytes = await downloadVsix(release.vsix, fetch);
          const directory = await mkdtemp(join(tmpdir(), 'vscode-rdp-update-'));
          try {
            const file = join(directory, 'update.vsix');
            await writeFile(file, bytes);
            await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const choice = await vscode.window.showErrorMessage(`Update konnte nicht installiert werden: ${reason}`, 'Release öffnen');
        if (choice) open(release.url);
      }
    },
    open,
    skip: version => { void context.globalState.update(SKIPPED, version); },
  });
  if (manual && !release) {
    await vscode.window.showInformationMessage(reachedServer
      ? 'Kein neueres stabiles GitHub-Release verfügbar.'
      : 'GitHub-Updateprüfung derzeit nicht verfügbar. Internetzugriff und veröffentlichte Releases prüfen.');
  }
}
