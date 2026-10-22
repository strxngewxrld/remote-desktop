// Generate notices from esbuild inputs, rather than all development dependencies.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('../packages/vscode-rdp/', import.meta.url));

async function licenseText(directory) {
  const file = (await readdir(directory)).find(name => /^(?:licen[cs]e(?:[.-](?:md|txt|mit))?|copying)$/i.test(name));
  if (!file) throw new Error(`No license text found in bundled package: ${directory}`);
  return (await readFile(join(directory, file), 'utf8')).replace(/\r\n?/g, '\n').trim();
}

export async function renderNotices(meta, language = 'en') {
  const german = language.toLowerCase().startsWith('de');
  const packages = new Map();
  const firstParty = fileURLToPath(new URL('../packages/ts-rdp/', import.meta.url));
  for (const input of Object.keys(meta.inputs)) {
    if (!/(^|\/)node_modules\//.test(input.replaceAll('\\', '/'))) continue;
    const absolute = resolve(extension, input).replaceAll('\\', '/');
    const marker = absolute.lastIndexOf('/node_modules/');
    const relative = absolute.slice(marker + '/node_modules/'.length);
    const name = relative.split('/').slice(0, relative.startsWith('@') ? 2 : 1).join('/');
    const directory = `${absolute.slice(0, marker)}/node_modules/${name}`;
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.version) throw new Error(`Cannot identify bundled package: ${input}`);
    packages.set(directory, pkg);
  }
  const own = JSON.parse(await readFile(join(firstParty, 'package.json'), 'utf8'));
  let text = german
    ? '# Lizenzhinweise zu enthaltenen Paketen\n\nAutomatisch aus den tatsächlich gebündelten Paketen erzeugt. Build- und Testwerkzeuge werden nicht mitgeliefert. Die vollständigen Lizenztexte bleiben im Original erhalten.\n'
    : '# Third-party notices\n\nGenerated from the actual esbuild bundle inputs. Build and test tools are not distributed.\n';
  text += `\n## ${german ? 'Eigene Bibliothek' : 'First-party'}: ${own.name} ${own.version} (${own.license})\n\n${await licenseText(firstParty)}\n`;
  if (!packages.size) text += german
    ? '\nEs werden keine npm-Laufzeitpakete von Drittanbietern gebündelt. Die APIs von VS Code und Node.js werden von der Laufzeitumgebung bereitgestellt.\n'
    : '\nNo third-party npm runtime packages are bundled. VS Code and Node.js APIs are provided by the host.\n';
  for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    text += `\n## ${pkg.name} ${pkg.version} (${pkg.license ?? (german ? 'siehe Lizenztext' : 'see license text')})\n\n${await licenseText(directory)}\n`;
  }
  return text;
}

export async function writeNotices(meta) {
  await writeFile(join(extension, 'THIRD_PARTY_NOTICES.md'), await renderNotices(meta));
  await writeFile(join(extension, 'THIRD_PARTY_NOTICES.de.md'), await renderNotices(meta, 'de'));
}
