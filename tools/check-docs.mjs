import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const documents = ['README.md', 'docs/RELEASING.md', 'docs/TESTING.md', 'docs/report-builder-parity.md',
  ...['README.md', 'README.de.md', 'CHANGELOG.md', 'CHANGELOG.de.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.de.md',
    'docs/ANWENDERHANDBUCH.md', 'docs/TROUBLESHOOTING.md',
    'docs/walkthrough/connect.md', 'docs/walkthrough/security.md', 'docs/walkthrough/help.md', 'docs/walkthrough/updates.md']
    .map(p => `packages/vscode-rdp/${p}`)];
for (const document of documents) {
  const path = resolve(root, document);
  const body = await readFile(path, 'utf8');
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
    assert((await stat(resolve(dirname(path), decodeURIComponent(target.split('#')[0])))).isFile(), `${document}: ${target}`);
  }
}
console.log(`Documentation verified: ${documents.length} documents`);
