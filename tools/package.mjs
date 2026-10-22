import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkPackage } from './check-package.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = join(root, 'packages/vscode-rdp');
const require = createRequire(join(extension, 'package.json'));
const pkg = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
const output = join(root, 'artifacts', `${pkg.name}-${pkg.version}.vsix`);
function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir(join(root, 'artifacts'), { recursive: true });
run(require.resolve('typescript/bin/tsc'), ['-p', join(root, 'packages/ts-rdp/tsconfig.json')], root);
run(join(extension, 'esbuild.mjs'), [], extension);
await import('./check-docs.mjs');
run(require.resolve('@vscode/vsce/vsce'), ['package', '--no-dependencies', '--out', output], extension);
await checkPackage(output);
