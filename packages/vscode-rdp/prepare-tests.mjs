import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Git checkouts on Windows commonly disable symlinks. Stage the shared mock
// server and its relative imports inside rootDir instead of relying on one.
const target = new URL('./test/ts-rdp-quelle/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const directory of ['src', 'test']) {
  cpSync(
    fileURLToPath(new URL(`../ts-rdp/${directory}/`, import.meta.url)),
    fileURLToPath(new URL(`${directory}/`, target)),
    { recursive: true },
  );
}
