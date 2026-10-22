import { ExtensionContext, ExtensionMode, antworten, einstellungen, notizen, umgebung, zuruecksetzen } from './vscodeStub.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerUpdates, runUpdateCheck } from '../src/updates.js';

const originalFetch = globalThis.fetch;
const page = 'https://github.com/strxngewxrld/remote-desktop/releases/tag/v1.1.0';
const download = 'https://github.com/strxngewxrld/remote-desktop/releases/download/v1.1.0/vscode-rdp-1.1.0.vsix';
let context: ExtensionContext;
let requests: string[];

beforeEach(() => {
  zuruecksetzen(); context = new ExtensionContext(); requests = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ tag_name: 'v1.1.0', html_url: page, assets: [{ name: 'vscode-rdp-1.1.0.vsix', browser_download_url: download }] }));
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; context.entsorgeAlles(); });

test('Testaktivierung und deaktivierte Startpruefung senden keine Anfrage', () => {
  registerUpdates(context);
  assert.equal(requests.length, 0);
  context.entsorgeAlles();
  context.extensionMode = ExtensionMode.Production;
  einstellungen.set('rdp.checkForUpdates', false);
  registerUpdates(context);
  assert.equal(requests.length, 0);
});

test('Manuelle Pruefung ignoriert eine uebersprungene Version; Abbruch installiert nichts', async () => {
  await context.globalState.update('rdp.skippedUpdateVersion', '1.1.0');
  await runUpdateCheck(context, false);
  assert.equal(notizen.hinweise.length, 0);
  await runUpdateCheck(context, true);
  assert.match(notizen.hinweise[0]!, /1.1.0/);
  assert.equal(notizen.ausgefuehrt.length, 0);
});

test('Ueberspringen bleibt gespeichert; Release-Seite wird nur auf Auswahl geoeffnet', async () => {
  antworten.meldungen.push('Diese Version überspringen');
  await runUpdateCheck(context, true);
  assert.equal(context.globalState.get('rdp.skippedUpdateVersion'), '1.1.0');
  umgebung.fernart = 'ssh-remote';
  antworten.meldungen.push('Release öffnen');
  await runUpdateCheck(context, true);
  assert.equal(notizen.ausgefuehrt[0]?.befehl, 'openExternal');
  assert.equal(requests.filter(u => u === download).length, 0);
});

test('Installation nur nach Auswahl; temporaere VSIX wird nach Installer-Aufruf entfernt', async () => {
  globalThis.fetch = (async (url: string) => String(url) === download
    ? new Response(new Uint8Array([80, 75, 3, 4]))
    : new Response(JSON.stringify({ tag_name: 'v1.1.0', html_url: page, assets: [{ name: 'vscode-rdp-1.1.0.vsix', browser_download_url: download }] }))) as typeof fetch;
  antworten.meldungen.push('Installieren');
  await runUpdateCheck(context, true);
  const install = notizen.ausgefuehrt.find(a => a.befehl === 'workbench.extensions.installExtension');
  assert.ok(install);
  const file = (install.argumente[0] as { fsPath: string }).fsPath;
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('Manuelle Offline-Pruefung erklaert das Problem, Startpruefung bleibt still', async () => {
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  await runUpdateCheck(context, false);
  assert.equal(notizen.hinweise.length, 0);
  await runUpdateCheck(context, true);
  assert.match(notizen.hinweise[0]!, /nicht verfügbar/);
});
