import { defineConfig } from '@vscode/test-cli';

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
  launchArgs: ['--disable-extensions', '--disable-gpu'],
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
});
