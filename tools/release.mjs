#!/usr/bin/env node
/**
 * Ein GitHub Release der Extension anstossen.
 *
 * Releases sind der einzige Vertriebsweg: die Updatepruefung der Extension
 * liest `releases/latest` und erwartet dort `vscode-rdp-<version>.vsix`.
 * Gebaut und hochgeladen wird in GitHub Actions (.github/workflows/release.yml),
 * nicht hier - dieses Skript bereitet nur Version, Changelog und Tag vor.
 *
 * Aufruf (normalerweise ueber den VS-Code-Task "RDP: Release erstellen"):
 *
 *   node tools/release.mjs --bump patch|minor|major [--dry-run]
 *
 * Ablauf: auf main und sauber? -> Version anheben -> "Unveroeffentlicht" in
 * beiden Changelogs zur Versionssektion machen -> typecheck, Tests, VSIX
 * pruefen -> Commit und Tag v<version> -> pushen. Der Tag startet den
 * Release-Workflow; das Skript wartet auf ihn, wenn `gh` angemeldet ist.
 * Ein Probelauf aendert nichts am Repository und pusht nichts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionOrdner = join(wurzel, 'packages', 'vscode-rdp');
const CHANGELOGS = [
  ['CHANGELOG.md', '## [Unreleased]'],
  ['CHANGELOG.de.md', '## [Unveröffentlicht]'],
];

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

function fuehreAus(befehl, args) {
  execFileSync(befehl, args, { stdio: 'inherit', cwd: wurzel, shell: process.platform === 'win32' && /\.cmd$/i.test(befehl) });
}

function ausgabe(befehl, args) {
  return execFileSync(befehl, args, { cwd: wurzel, encoding: 'utf8' }).trim();
}

function ghVerfuegbar() {
  try { ausgabe('gh', ['auth', 'status']); return true; } catch { return false; }
}

/** Naechste Versionsnummer, ohne etwas zu schreiben (fuer den Probelauf). */
function naechsteVersion(aktuell, sprung) {
  const [major, minor, patch] = aktuell.split('.').map(Number);
  if (sprung === 'major') return `${major + 1}.0.0`;
  if (sprung === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** "Unveroeffentlicht" wird zur Versionssektion; darueber eine neue, leere. */
function changelogUmstellen(text, kopf, version) {
  const start = text.indexOf(`${kopf}\n`);
  if (start < 0) return { fehler: `Überschrift "${kopf}" fehlt` };
  const rumpfStart = start + kopf.length + 1;
  const naechste = text.indexOf('\n## [', rumpfStart);
  const rumpf = text.slice(rumpfStart, naechste < 0 ? undefined : naechste);
  if (!rumpf.trim()) return { fehler: `unter "${kopf}" steht nichts` };
  return { text: `${text.slice(0, start)}${kopf}\n\n## [${version}]\n${text.slice(rumpfStart)}` };
}

// ----------------------------------------------------------------- Eingaben

const bump = argument('bump') ?? 'patch';
const probelauf = process.argv.includes('--dry-run');
if (!['patch', 'minor', 'major'].includes(bump)) {
  abbruch(`--bump "${bump}" ist unbekannt (patch, minor oder major).`);
}

// ----------------------------------------------------------------- Ablauf

schritt('Repository prüfen');
const zweig = ausgabe('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const offen = ausgabe('git', ['status', '--porcelain']);
if (!probelauf) {
  if (zweig !== 'main') abbruch(`Releases entstehen nur auf main (aktuell: ${zweig}).`);
  if (offen) abbruch(`Es gibt nicht committete Änderungen:\n${offen}`);
  fuehreAus('git', ['fetch', 'origin', 'main', '--tags']);
  if (ausgabe('git', ['rev-list', '--count', 'HEAD..origin/main']) !== '0') {
    abbruch('origin/main enthält Commits, die lokal fehlen - erst pullen.');
  }
}

const manifestPfad = join(extensionOrdner, 'package.json');
const alteVersion = JSON.parse(readFileSync(manifestPfad, 'utf8')).version;
const version = naechsteVersion(alteVersion, bump);
const tag = `v${version}`;
if (ausgabe('git', ['tag', '--list', tag])) abbruch(`Tag ${tag} existiert bereits.`);

const changelogs = CHANGELOGS.map(([datei, kopf]) => {
  const pfad = join(extensionOrdner, datei);
  const ergebnis = changelogUmstellen(readFileSync(pfad, 'utf8'), kopf, version);
  if (ergebnis.fehler) abbruch(`${datei}: ${ergebnis.fehler}.`);
  return [pfad, ergebnis.text];
});

if (probelauf) {
  console.log(`Probelauf: ${alteVersion} -> ${version}, Changelogs sind vorbereitet.`);
} else {
  schritt(`Version anheben (${alteVersion} -> ${version})`);
  fuehreAus(npmBefehl('npm'), ['version', bump, '--no-git-tag-version', '-w', 'vscode-rdp']);
  for (const [pfad, text] of changelogs) writeFileSync(pfad, text);
}

schritt('Typecheck');
fuehreAus(npmBefehl('npm'), ['run', 'typecheck']);
schritt('Tests');
fuehreAus(npmBefehl('npm'), ['test']);
if (!probelauf) {
  // Im Probelauf fehlt die Versionssektion im Changelog; der Paketcheck
  // verlangt sie. Die Pruefung laeuft ohnehin noch einmal im Workflow.
  schritt('VSIX bauen und prüfen');
  fuehreAus(npmBefehl('npm'), ['run', 'package']);
}

if (probelauf) {
  console.log(`\nProbelauf fertig: ${tag} wäre bereit, nichts geändert oder gepusht.`);
  process.exit(0);
}

schritt(`Commit und Tag ${tag}`);
fuehreAus('git', ['add', 'package-lock.json', manifestPfad, ...changelogs.map(([pfad]) => pfad)]);
fuehreAus('git', ['commit', '-m', `chore(release): ${tag}`]);
fuehreAus('git', ['tag', '-a', tag, '-m', `Remote Desktop ${version}`]);

schritt('Pushen (startet den Release-Workflow)');
fuehreAus('git', ['push', '--atomic', 'origin', 'main', tag]);

if (!ghVerfuegbar()) {
  console.log(`\n${tag} ist gepusht. Den Workflow "Release" unter GitHub → Actions verfolgen.`);
  process.exit(0);
}

schritt('Auf den Release-Workflow warten');
let laufId = '';
for (let versuch = 0; versuch < 30 && !laufId; versuch++) {
  laufId = ausgabe('gh', ['run', 'list', '--workflow', 'release.yml', '--branch', tag, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""']);
  if (!laufId) await new Promise(r => setTimeout(r, 2000));
}
if (!laufId) abbruch(`Kein Release-Lauf für ${tag} gefunden - unter GitHub → Actions nachsehen.`);
try {
  fuehreAus('gh', ['run', 'watch', laufId, '--exit-status']);
} catch {
  abbruch(`Release-Workflow fehlgeschlagen: gh run view ${laufId} --log-failed`);
}
console.log(`\nFertig: ${ausgabe('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])}`);
