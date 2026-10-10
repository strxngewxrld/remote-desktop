#!/usr/bin/env node
/**
 * Die Extension als VSIX bauen und in die GitHub Package Registry stellen.
 *
 * GitHub Packages kennt kein VSIX-Format. Veroeffentlicht wird deshalb ein
 * npm-Paket `@<owner>/vscode-rdp`, das genau eine Datei enthaelt: das VSIX.
 * Das Manifest der Extension bleibt dabei unangetastet - ein Paketname mit
 * Scope wuerde die Extension-ID aendern, und `vsce` lehnt ihn ohnehin ab.
 *
 * Aufruf (normalerweise ueber den VS-Code-Task "RDP: Veröffentlichen"):
 *
 *   NODE_AUTH_TOKEN=<PAT mit write:packages> \
 *     node tools/publish-github.mjs --owner <user-oder-org> [--bump patch|minor|major|none] [--dry-run]
 *
 * Ablauf: Arbeitsverzeichnis sauber? -> Version anheben -> bauen -> testen
 * -> VSIX packen -> npm-Huelle schreiben -> veroeffentlichen. Geht ein
 * Schritt schief, bricht das Skript ab; eine bereits angehobene Version
 * bleibt stehen und wird beim naechsten Versuch mit `--bump none` genommen.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionOrdner = join(wurzel, 'packages', 'vscode-rdp');
const huelle = join(wurzel, 'dist-publish');
const REGISTRY = 'https://npm.pkg.github.com';

function argument(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function abbruch(meldung) {
  console.error(`\nAbbruch: ${meldung}`);
  process.exit(1);
}

function schritt(titel) {
  console.log(`\n=== ${titel}`);
}

/** npm und npx laufen unter Windows nur als .cmd. */
function npmBefehl(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function fuehreAus(befehl, args, opts = {}) {
  execFileSync(befehl, args, { stdio: 'inherit', cwd: wurzel, shell: process.platform === 'win32', ...opts });
}

function ausgabe(befehl, args) {
  return execFileSync(befehl, args, { cwd: wurzel, encoding: 'utf8' }).trim();
}

// ----------------------------------------------------------------- Eingaben

const owner = (argument('owner') ?? process.env.GITHUB_OWNER ?? '').trim().toLowerCase();
const bump = argument('bump') ?? 'patch';
const probelauf = process.argv.includes('--dry-run');
const token = process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(owner)) {
  abbruch('--owner fehlt oder ist kein gültiger GitHub-Benutzer- bzw. Organisationsname.');
}
if (!['patch', 'minor', 'major', 'none'].includes(bump)) {
  abbruch(`--bump "${bump}" ist unbekannt (patch, minor, major oder none).`);
}
if (!token && !probelauf) {
  abbruch('Kein Token. NODE_AUTH_TOKEN oder GITHUB_TOKEN setzen (Personal Access Token mit write:packages).');
}

// ----------------------------------------------------------------- Ablauf

schritt('Arbeitsverzeichnis prüfen');
const offen = ausgabe('git', ['status', '--porcelain']);
if (offen && !probelauf) {
  abbruch(`Es gibt nicht committete Änderungen - veröffentlicht wird nur, was im Repository steht:\n${offen}`);
}

// Ein Probelauf hebt nichts an: er soll das Repository so lassen, wie er es fand.
if (bump !== 'none' && !probelauf) {
  schritt(`Version anheben (${bump})`);
  fuehreAus(npmBefehl('npm'), ['version', bump, '--no-git-tag-version', '-w', 'vscode-rdp']);
}
const manifest = JSON.parse(readFileSync(join(extensionOrdner, 'package.json'), 'utf8'));
const version = manifest.version;
const vsixName = `vscode-rdp-${version}.vsix`;

schritt('Bauen');
fuehreAus(npmBefehl('npm'), ['run', 'build']);

schritt('Testen');
fuehreAus(npmBefehl('npm'), ['test']);

schritt(`VSIX packen (${vsixName})`);
rmSync(huelle, { recursive: true, force: true });
mkdirSync(huelle, { recursive: true });
fuehreAus(npmBefehl('npx'), ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '-o', join(huelle, vsixName)], {
  cwd: extensionOrdner,
});

schritt('npm-Hülle schreiben');
const paketname = `@${owner}/vscode-rdp`;
writeFileSync(
  join(huelle, 'package.json'),
  JSON.stringify(
    {
      name: paketname,
      version,
      description: `${manifest.displayName} - VS-Code-Extension als VSIX (${vsixName})`,
      license: manifest.license,
      files: [vsixName, 'README.md'],
      publishConfig: { registry: REGISTRY },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(huelle, 'README.md'),
  `# ${manifest.displayName} ${version}\n\n` +
    'Dieses Paket enthält nur die VS-Code-Extension als VSIX. Installieren:\n\n' +
    '```sh\n' +
    `npm pack ${paketname}@${version} --registry ${REGISTRY}\n` +
    `tar -xzf ${owner}-vscode-rdp-${version}.tgz package/${vsixName}\n` +
    `code --install-extension package/${vsixName}\n` +
    '```\n',
);
// Das Token kommt aus der Umgebung und landet nie in einer Datei.
writeFileSync(
  join(huelle, '.npmrc'),
  `@${owner}:registry=${REGISTRY}\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`,
);

schritt(probelauf ? 'Probelauf: npm publish --dry-run' : `Veröffentlichen als ${paketname}@${version}`);
fuehreAus(npmBefehl('npm'), ['publish', ...(probelauf ? ['--dry-run'] : [])], {
  cwd: huelle,
  env: { ...process.env, NODE_AUTH_TOKEN: token || 'probelauf' },
});

console.log(`\nFertig: ${paketname}@${version}${probelauf ? ' (Probelauf, nichts hochgeladen)' : ''}`);
if (bump !== 'none' && !probelauf) {
  console.log(
    `Die Versionsnummer in packages/vscode-rdp/package.json ist jetzt ${version}. Committen und taggen:\n` +
      `  git commit -am "Release ${version}" && git tag v${version}`,
  );
}
