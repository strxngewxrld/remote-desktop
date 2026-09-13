import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Zufaelliger Nonce, damit die Content Security Policy nur unser Skript erlaubt. */
function nonce(): string {
  return randomBytes(24).toString('base64');
}

export function renderWebview(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const n = nonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const clipboardScript = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'clipboard.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
</head>
<body>
  <div id="stage">
    <canvas id="screen" width="1280" height="800" tabindex="0"></canvas>
  </div>

  <div id="overlay" class="visible">
    <div class="overlay-card">
      <div class="spinner" id="spinner"></div>
      <h2 id="overlay-title">Verbindung wird aufgebaut…</h2>
      <p id="overlay-message"></p>
      <button id="overlay-action" hidden>Erneut verbinden</button>
    </div>
  </div>

  <!-- Kennfarbe der Verbindung: ein Rand ueber der ganzen Flaeche, nicht um
       die Zeichenflaeche herum. Der Unterschied ist wichtig - dieses Element
       liegt ausserhalb der Buehne und aendert deren Groesse nicht, und genau
       die Buehnengroesse bestimmt die angefragte Aufloesung (MS-RDPEDISP).
       Ein Rand *an* der Buehne oder an der Zeichenflaeche wuerde die Sitzung
       bei jedem Einfaerben um ein paar Pixel schrumpfen lassen. -->
  <div id="rahmen" hidden aria-hidden="true"></div>

  <div id="hint" hidden>
    Tastatur aktiv · Strg+Alt+Ende sendet Strg+Alt+Entf
  </div>

  <!-- Diagnose-Overlay: liegt ueber der Zeichenflaeche, faengt aber nichts ab
       (pointer-events: none) und bleibt fuer Vorlesewerkzeuge unsichtbar. -->
  <div id="diagnose" hidden aria-hidden="true">
    <div id="diagnose-titel"></div>
    <div id="diagnose-werte"></div>
  </div>

  <!-- Rueckfallebene der Zwischenablage: ein Feld, durch das Text von Hand in
       beide Richtungen geht, wenn der direkte Weg scheitert. Eingeblendet ueber
       den Befehl "RDP: Zwischenablage-Feld" oder von selbst, wenn das Schreiben
       in die Zwischenablage von VS Code fehlschlaegt. -->
  <div id="clipboard-panel" hidden>
    <div class="clipboard-head">
      <strong>Zwischenablage</strong>
      <button id="clipboard-close" title="Feld schließen (Esc)">Schließen</button>
    </div>
    <textarea id="clipboard-text" spellcheck="false"
              aria-label="Text für die Zwischenablage der Sitzung"
              placeholder="Text hier einfügen und senden – oder Text vom Server hier abholen."></textarea>
    <div class="clipboard-actions">
      <button id="clipboard-send">An die Sitzung senden</button>
      <button id="clipboard-copy">Lokal kopieren</button>
      <span id="clipboard-status" role="status" aria-live="polite"></span>
    </div>
  </div>

  <!-- Rueckfallebene der Zwischenablage. Muss VOR main.js geladen werden:
       acquireVsCodeApi() laesst sich nur einmal je Webview aufrufen, und
       clipboard.js reicht die Bruecke an main.js weiter. -->
  <script nonce="${n}" src="${clipboardScript}"></script>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
