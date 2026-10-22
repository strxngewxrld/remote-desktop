import * as esbuild from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { writeNotices } from '../../tools/notices.mjs';

const watch = process.argv.includes('--watch');

/** Die Extension laeuft im Node-Host von VS Code; `vscode` wird zur Laufzeit bereitgestellt. */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  metafile: true,
  define: { __RDP_BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const result = await esbuild.build(options);
  await writeFile('out/meta.json', JSON.stringify(result.metafile, null, 2) + '\n');
  await writeNotices(result.metafile);
}
