// Checks GitHub Releases for a newer version of the extension and downloads its VSIX. Free of the VS Code API, so
// the unit tests can run it with a fake fetch; extension.ts wires it to notifications and the extension install.
import { createHash } from 'node:crypto';

export interface ReleaseAsset {
  name: string;
  url: string;
  /** Hex SHA-256 reported by GitHub, if available. */
  sha256?: string;
}

export interface LatestRelease {
  version: string;
  url: string;
  /** The VSIX attached to the release, if there is exactly one. */
  vsix?: ReleaseAsset;
}

export interface UpdateCheckDeps {
  /** Installed version, e.g. "1.0.0". */
  current: string;
  /** repository.url from package.json. */
  repositoryUrl: string;
  fetch: typeof fetch;
  /** Version the user chose to skip, if any. */
  skipped?: string;
  /** Shows the notification and resolves with the chosen action. */
  notify(release: LatestRelease): Promise<'install' | 'open' | 'skip' | undefined>;
  install(release: LatestRelease & { vsix: ReleaseAsset }): Promise<void>;
  open(url: string): void;
  skip(version: string): void;
}

/** "owner/repo" of a GitHub repository URL, or undefined for other hosts. */
export function githubRepository(url: string): string | undefined {
  const match = /^(?:git\+)?(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function parseVersion(text: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

/** True when `candidate` is a higher x.y.z version than `current` (pre-releases never count). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Latest published (non-draft, non-prerelease) release of a GitHub repository. */
export async function latestRelease(repository: string, fetchImpl: typeof fetch): Promise<LatestRelease | undefined> {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const data = await response.json() as { tag_name?: unknown; html_url?: unknown; assets?: unknown; draft?: boolean; prerelease?: boolean };
  if (data.draft || data.prerelease) return undefined;
  if (typeof data.tag_name !== 'string' || typeof data.html_url !== 'string') return undefined;
  // only ever open release pages and download assets of this repository
  const base = `https://github.com/${repository.toLowerCase()}/releases/`;
  if (!data.html_url.toLowerCase().startsWith(base)) return undefined;
  if (!parseVersion(data.tag_name)) return undefined;
  const vsix = releaseVsix(data.assets, `${base}download/${data.tag_name}/`, `vscode-rdp-${data.tag_name.replace(/^v/, '')}.vsix`);
  return { version: data.tag_name.replace(/^v/, ''), url: data.html_url, ...(vsix && { vsix }) };
}

/** The single .vsix asset downloaded from this repository's releases, if any. */
function releaseVsix(assets: unknown, downloadBase: string, expectedName: string): ReleaseAsset | undefined {
  if (!Array.isArray(assets)) return undefined;
  const found = assets.filter((a): a is { name: string; browser_download_url: string; digest?: unknown } =>
    a?.name === expectedName &&
    typeof a.browser_download_url === 'string' && a.browser_download_url.toLowerCase() === `${downloadBase}${expectedName}`.toLowerCase());
  if (found.length !== 1) return undefined;
  const { name, browser_download_url: url, digest } = found[0];
  const sha256 = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest)?.[1]?.toLowerCase() : undefined;
  return { name, url, ...(sha256 && { sha256 }) };
}

/** Downloads a release VSIX and verifies the checksum GitHub reports for it. */
export async function downloadVsix(asset: ReleaseAsset, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (asset.sha256 && createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('SHA-256 mismatch');
  return bytes;
}

/** Notifies about a newer release; network and API errors are ignored. Returns the release that was offered. */
export async function checkForUpdates(deps: UpdateCheckDeps): Promise<LatestRelease | undefined> {
  const repository = githubRepository(deps.repositoryUrl);
  if (!repository) return undefined;
  const release = await latestRelease(repository, deps.fetch).catch(() => undefined);
  if (!release || !isNewerVersion(release.version, deps.current) || release.version === deps.skipped) return undefined;
  const choice = await deps.notify(release);
  if (choice === 'install' && release.vsix) await deps.install({ ...release, vsix: release.vsix });
  else if (choice === 'open') deps.open(release.url);
  else if (choice === 'skip') deps.skip(release.version);
  return release;
}
