// The ZIP reader is adapted from Report Builder's package verification.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { renderNotices } from './notices.mjs';

const hostRequire = createRequire(import.meta.url);

function standIn() {
  const api = new Proxy(function () {}, {
    get: (_, key) => key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : key === Symbol.iterator ? [][Symbol.iterator] : api,
    apply: () => api,
    construct: () => api,
    set: () => true,
  });
  return api;
}

export function unzip(zip) {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0 && zip.readUInt32LE(end) === 0x06054b50, 'Invalid ZIP archive');
  const files = new Map();
  for (let i = 0, at = zip.readUInt32LE(end + 16); i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const length = zip.readUInt16LE(at + 28), local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + length).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    assert(!files.has(name), `Duplicate ZIP entry: ${name}`);
    assert(method === 0 || method === 8, `Unsupported compression: ${method}`);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

export async function checkPackage(path) {
  const files = unzip(await readFile(path));
  const text = name => {
    assert(files.has(`extension/${name}`), `Missing packaged file: ${name}`);
    return files.get(`extension/${name}`).toString('utf8');
  };
  const pkg = JSON.parse(text('package.json'));
  const source = JSON.parse(await readFile(new URL('../packages/vscode-rdp/package.json', import.meta.url), 'utf8'));
  for (const key of ['name', 'publisher', 'version', 'main']) assert.equal(pkg[key], source[key], key);
  assert.equal(pkg.publisher, 'Tom-Knueppel');
  assert.equal(pkg.main, './out/extension.js');
  assert(files.has('extension.vsixmanifest'));
  assert(files.has('[Content_Types].xml'));
  const required = ['package.nls.json', 'package.nls.de.json', 'readme.md', 'README.de.md', 'changelog.md', 'CHANGELOG.de.md', 'LICENSE.txt',
    'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.de.md', 'docs/ANWENDERHANDBUCH.md', 'docs/TROUBLESHOOTING.md',
    'docs/walkthrough/connect.md', 'docs/walkthrough/security.md', 'docs/walkthrough/help.md', 'docs/walkthrough/updates.md',
    'out/extension.js', 'media/icon.png', 'media/rdp-icon.svg', 'media/main.js',
    'media/clipboard.js', 'media/main.css', ...['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'].map(n => `media/tab-icons/rdp-${n}.svg`)];
  // Exactly these runtime assets: catches accidentally shipped logs, credentials or tests.
  const names = [...files.keys()].filter(n => n.startsWith('extension/')).map(n => n.slice(10));
  assert.deepEqual(names.sort(), ['package.json', ...required].sort(), 'Unexpected VSIX contents');
  for (const name of required) text(name);
  assert.match(text('changelog.md'), new RegExp(`^## \\[${pkg.version.replaceAll('.', '\\.')}\\]`, 'm'));
  const commands = new Set(pkg.contributes.commands.map(c => c.command));
  for (const walkthrough of pkg.contributes.walkthroughs ?? []) {
    for (const step of walkthrough.steps) {
      text(step.media.markdown);
      for (const match of step.description.matchAll(/command:([\w.]+)/g)) assert(commands.has(match[1]), match[1]);
    }
  }
  const icon = files.get(`extension/${pkg.icon}`);
  assert(icon?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG icon required');
  assert(icon.readUInt32BE(16) >= 128 && icon.readUInt32BE(20) >= 128, 'Icon too small');
  // esbuild records every input and remaining external import, including lazy code paths.
  const meta = JSON.parse(await readFile(new URL('../packages/vscode-rdp/out/meta.json', import.meta.url), 'utf8'));
  const allowed = new Set(['vscode', ...builtinModules, ...builtinModules.map(n => `node:${n}`)]);
  assert.equal(text('THIRD_PARTY_NOTICES.md'), await renderNotices(meta), 'Notices do not match bundled dependencies and licenses');
  assert.equal(text('THIRD_PARTY_NOTICES.de.md'), await renderNotices(meta, 'de'), 'German notices differ from bundled licenses');
  for (const language of ['package.nls.json', 'package.nls.de.json']) {
    const translations = JSON.parse(text(language));
    for (const match of JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)) assert(translations[match[1]], `Missing ${language}: ${match[1]}`);
  }
  for (const output of Object.values(meta.outputs)) {
    for (const entry of output.imports) assert(allowed.has(entry.path), `Unbundled runtime import: ${entry.path}`);
  }
  assert.match(text('THIRD_PARTY_NOTICES.md'), /ts-rdp/);
  // Load the actual archived bundle with no access to installed npm modules.
  const api = standIn(), registered = new Set();
  const vscode = Object.fromEntries(['ConfigurationTarget', 'DataTransfer', 'DataTransferItem',
    'Disposable', 'EventEmitter', 'ExtensionKind', 'ExtensionMode', 'FileType', 'MarkdownString', 'StatusBarAlignment',
    'ThemeColor', 'ThemeIcon', 'TreeItem', 'TreeItemCollapsibleState', 'UIKind', 'Uri', 'ViewColumn',
    'window', 'workspace', 'extensions'].map(key => [key, api]));
  vscode.env = { remoteName: undefined, uiKind: 1 };
  vscode.commands = { registerCommand: id => { registered.add(id); return api; }, executeCommand: () => Promise.resolve() };
  const module = { exports: {} };
  runInNewContext(text('out/extension.js'), {
    module, exports: module.exports, process, console, Buffer, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, AbortSignal,
    require(name) {
      assert(allowed.has(name), `Unbundled dependency: ${name}`);
      return name === 'vscode' ? vscode : hostRequire(name);
    },
  }, { filename: 'extension/out/extension.js', timeout: 10000 });
  const context = { subscriptions: [], extensionMode: 3, extensionUri: api, globalState: api, workspaceState: api, secrets: api };
  module.exports.activate(context);
  assert.deepEqual([...registered].sort(), [...commands].sort(), 'Packaged command registration differs from manifest');
  module.exports.deactivate();
  for (const disposable of context.subscriptions) disposable.dispose();
  console.log(`VSIX verified: ${pkg.publisher}.${pkg.name} ${pkg.version}, ${names.length} files, ${commands.size} commands; packaged bundle activates`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(await readFile(new URL('../packages/vscode-rdp/package.json', import.meta.url), 'utf8'));
  await checkPackage(process.argv[2] ?? fileURLToPath(new URL(`../artifacts/${pkg.name}-${pkg.version}.vsix`, import.meta.url)));
}
