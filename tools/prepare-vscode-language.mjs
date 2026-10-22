// VS Code resolves its UI language before scanning extensions on first start.
// Register the genuine installed language pack before launching a cold test profile.
import { runVSCodeCommand } from '@vscode/test-electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareGermanTestProfile() {
  const cache = fileURLToPath(new URL('../packages/vscode-rdp/.vscode-test/', import.meta.url));
  const extensions = join(cache, 'extensions'), userData = join(cache, 'user-data');
  await runVSCodeCommand([
    '--install-extension', 'ms-ceintl.vscode-language-pack-de',
    `--extensions-dir=${extensions}`, `--user-data-dir=${userData}`,
  ], {
    version: process.env.VSCODE_TESTVERSION ?? 'stable',
    spawn: { env: { ...process.env, VSCODE_NLS_CONFIG: '' } },
  });
  const candidates = (await readdir(extensions)).filter(name => name.startsWith('ms-ceintl.vscode-language-pack-de-'))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  if (!candidates.length) throw new Error('German test language pack was not installed');
  const directory = join(extensions, candidates[0]);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const localization = pkg.contributes?.localizations?.find(entry => entry.languageId === 'de');
  if (!localization) throw new Error('German language pack has no German translations');
  const translations = {};
  for (const entry of localization.translations) {
    const path = join(directory, entry.path);
    await access(path);
    translations[entry.id] = path;
  }
  if (!translations.vscode) throw new Error('German core translation is missing');
  // Native languagepacks.json schema consumed by VS Code's resolveNLSConfiguration:
  // https://github.com/microsoft/vscode/blob/main/src/vs/base/node/nls.ts
  // Use a content hash so no translation cache can survive changes to the pack.
  const hash = createHash('md5').update(await readFile(translations.vscode)).digest('hex');
  let registry = {};
  try { registry = JSON.parse(await readFile(join(userData, 'languagepacks.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  registry.de = {
    hash, label: localization.localizedLanguageName,
    extensions: [{ extensionIdentifier: { id: `${pkg.publisher}.${pkg.name}` }, version: pkg.version }],
    translations,
  };
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, 'languagepacks.json'), JSON.stringify(registry));
  console.log(`German test profile prepared: ${pkg.name} ${pkg.version}`);
}
