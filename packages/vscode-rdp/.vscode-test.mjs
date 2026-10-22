import { defineConfig } from '@vscode/test-cli';
import { prepareGermanTestProfile } from '../../tools/prepare-vscode-language.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('./.vscode-test/', import.meta.url));
// macOS Unix-domain socket paths must fit within 103 bytes. The checkout
// path on GitHub runners already exceeds this before VS Code adds its socket.
const userData = process.platform === 'darwin'
  ? join(mkdtempSync('/tmp/rdp-vsc-'), 'user')
  : join(cache, 'user-data');
const extensions = join(cache, 'extensions');

// A parent VS Code terminal may export its own resolved English locale.
// Let the isolated test window resolve the requested language itself.
delete process.env.VSCODE_NLS_CONFIG;
if (process.env.VSCODE_TEST_LANGUAGE === 'de') await prepareGermanTestProfile({ userData, extensions });

/**
 * Startet ein echtes VS Code, laedt diese Extension hinein und fuehrt die
 * Tests im Extension-Host aus.
 *
 * Der Unterschied zu den schnellen Tests unter test/ ist entscheidend: Dort
 * laeuft der Code gegen eine Attrappe der VS-Code-API. Ein Fehler, der erst
 * beim Aktivieren im echten Host auftritt - ein fehlendes Manifestfeld, ein
 * Modul, das im Host nicht aufloest, ein Absturz des Fensters - faellt nur
 * hier auf.
 */
export default defineConfig({
  // test-cli can load this config in a worker: also clear it in the actual
  // Electron child environment, not just in the config loader above.
  env: { VSCODE_NLS_CONFIG: '' },
  label: 'Integration im echten VS Code',
  files: 'dist-integration/test/integration/**/*.test.js',
  // Standard ist 'stable'; ueber VSCODE_TESTVERSION laesst sich eine bestimmte
  // Fassung pruefen - Abstuerze sind manchmal versionsgebunden.
  version: process.env.VSCODE_TESTVERSION ?? 'stable',
  ...(process.env.VSCODE_TEST_PATH
    ? { useInstallation: { fromPath: process.env.VSCODE_TEST_PATH } }
    : {}),
  // Ohne dieses Verzeichnis sucht VS Code im Arbeitsverzeichnis des Aufrufers.
  workspaceFolder: './test/integration/arbeitsordner',
  // The German language pack must stay enabled in the isolated test profile.
  launchArgs: [
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    ...(process.env.VSCODE_TEST_LANGUAGE === 'de' ? [] : ['--disable-extensions']),
    '--disable-gpu',
    ...(process.env.VSCODE_TEST_LANGUAGE ? [`--locale=${process.env.VSCODE_TEST_LANGUAGE}`] : []),
  ],
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
});
