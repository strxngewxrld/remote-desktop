import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkForUpdates, downloadVsix, githubRepository, isNewerVersion, latestRelease, type UpdateCheckDeps } from '../src/updateCheck.js';

const REPO = 'git+https://github.com/example/report-builder.git';
const PAGE = 'https://github.com/example/report-builder/releases/tag/v1.1.0';
const DOWNLOAD = 'https://github.com/example/report-builder/releases/download/v1.1.0/';

/** A fetch that answers every request with `body` and records the requested URLs. */
function respond(body: unknown, ok = true) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => { urls.push(url); return { ok, json: async () => body } as Response; }) as unknown as typeof fetch;
  return Object.assign(fetchImpl, { urls });
}

/** Dependencies that record what the update check did. */
function deps(overrides: Partial<UpdateCheckDeps> = {}) {
  const calls = { notify: [] as unknown[], install: [] as unknown[], open: [] as string[], skip: [] as string[] };
  const d: UpdateCheckDeps = {
    current: '1.0.0', repositoryUrl: REPO,
    fetch: respond({ tag_name: 'v1.1.0', html_url: PAGE }),
    async notify(r) { calls.notify.push(r); return undefined; },
    async install(r) { calls.install.push(r); },
    open: url => { calls.open.push(url); },
    skip: v => { calls.skip.push(v); },
    ...overrides,
  };
  if (overrides.notify) d.notify = async r => { calls.notify.push(r); return overrides.notify!(r); };
  return { d, calls };
}

test('Update-Prüfung: GitHub-Repository aus repository.url', () => {
  assert.equal(githubRepository(REPO), 'example/report-builder');
  assert.equal(githubRepository('https://github.com/example/report-builder'), 'example/report-builder');
  assert.equal(githubRepository('git@github.com:example/report-builder.git'), 'example/report-builder');
  assert.equal(githubRepository('https://gitlab.com/example/report-builder'), undefined);
});

test('Update-Prüfung: Versionen numerisch vergleichen, Vorabversionen zählen nicht', () => {
  assert.equal(isNewerVersion('v0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.1.0-beta.1', '1.0.0'), false);
});

test('Update-Prüfung: fragt den neuesten Release ab, fremde Release-Seiten werden abgelehnt', async () => {
  const fetchImpl = respond({ tag_name: 'v1.1.0', html_url: PAGE });
  assert.deepEqual(await latestRelease('example/report-builder', fetchImpl), { version: '1.1.0', url: PAGE });
  assert.equal(fetchImpl.urls[0], 'https://api.github.com/repos/example/report-builder/releases/latest');
  assert.equal(await latestRelease('example/report-builder', respond({ tag_name: 'v1.1.0', html_url: 'https://evil.example/releases/x' })), undefined);
  assert.equal(await latestRelease('example/report-builder', respond({ message: 'Not Found' }, false)), undefined);
});

test('Update-Prüfung: genau eine VSIX aus diesem Repository wird angeboten', async () => {
  const asset = (name: string, url: string, digest?: string) => ({ name, browser_download_url: url, digest });
  const ok = `${DOWNLOAD}vscode-rdp-1.1.0.vsix`;
  const hash = 'a'.repeat(64);
  const vsixOf = async (assets: unknown[]) => (await latestRelease('example/report-builder', respond({ tag_name: 'v1.1.0', html_url: PAGE, assets })))?.vsix;
  assert.deepEqual(await vsixOf([asset('notes.md', `${DOWNLOAD}notes.md`), asset('vscode-rdp-1.1.0.vsix', ok, `sha256:${hash}`)]),
    { name: 'vscode-rdp-1.1.0.vsix', url: ok, sha256: hash });
  assert.equal(await vsixOf([asset('x.vsix', 'https://evil.example/x.vsix')]), undefined);
  assert.equal(await vsixOf([asset('a.vsix', ok), asset('b.vsix', ok)]), undefined);
});

test('Update-Prüfung: Release öffnen, Version überspringen, still bleiben', async () => {
  const open = deps({ notify: async () => 'open' });
  assert.equal((await checkForUpdates(open.d))?.version, '1.1.0');
  assert.deepEqual(open.calls.notify, [{ version: '1.1.0', url: PAGE }]);
  assert.deepEqual(open.calls.open, [PAGE]);
  assert.deepEqual(open.calls.skip, []);

  const skip = deps({ notify: async () => 'skip' });
  await checkForUpdates(skip.d);
  assert.deepEqual(skip.calls.skip, ['1.1.0']);
  const skipped = deps({ skipped: '1.1.0' });
  assert.equal(await checkForUpdates(skipped.d), undefined);
  assert.deepEqual(skipped.calls.notify, []);

  const current = deps({ current: '1.1.0' });
  const offline = deps({ fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
  const foreign = deps({ repositoryUrl: 'https://gitlab.com/example/report-builder' });
  for (const quiet of [current, offline, foreign]) {
    assert.equal(await checkForUpdates(quiet.d), undefined);
    assert.deepEqual(quiet.calls.notify, []);
  }
});

test('Update-Prüfung: Installieren übergibt die VSIX des Releases', async () => {
  const vsix = { name: 'vscode-rdp-1.1.0.vsix', url: `${DOWNLOAD}vscode-rdp-1.1.0.vsix` };
  const { d, calls } = deps({
    fetch: respond({ tag_name: 'v1.1.0', html_url: PAGE, assets: [{ name: vsix.name, browser_download_url: vsix.url }] }),
    notify: async () => 'install',
  });
  await checkForUpdates(d);
  assert.deepEqual(calls.install, [{ version: '1.1.0', url: PAGE, vsix }]);
  assert.deepEqual(calls.open, []);
});

test('Update-Prüfung: heruntergeladene VSIX mit falscher Prüfsumme wird abgelehnt', async () => {
  const bytes = new TextEncoder().encode('vsix');
  const fetchImpl = (async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }) as Response) as unknown as typeof fetch;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(await downloadVsix({ name: 'a.vsix', url: 'u', sha256 }, fetchImpl), bytes);
  await assert.rejects(downloadVsix({ name: 'a.vsix', url: 'u', sha256: '0'.repeat(64) }, fetchImpl), /SHA-256/);
  const missing = (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
  await assert.rejects(downloadVsix({ name: 'a.vsix', url: 'u' }, missing), /HTTP 404/);
});

test('Update-Prüfung: Entwuerfe, Vorabversionen und fremde VSIX-Dateien nicht anbieten', async () => {
  for (const flags of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.1.0-beta.1' }]) {
    assert.equal(await latestRelease('example/report-builder', respond({ tag_name: 'v1.1.0', html_url: PAGE, ...flags })), undefined);
  }
  const result = await latestRelease('example/report-builder', respond({
    tag_name: 'v1.1.0', html_url: PAGE,
    assets: [{ name: 'other-extension-1.1.0.vsix', browser_download_url: `${DOWNLOAD}other-extension-1.1.0.vsix` }],
  }));
  assert.equal(result?.vsix, undefined);
});

