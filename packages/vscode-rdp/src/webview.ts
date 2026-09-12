import * as vscode from 'vscode';

/** Zufaelliger Nonce, damit die Content Security Policy nur unser Skript erlaubt. */
function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function renderWebview(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const n = nonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>${title}</title>
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

  <div id="hint" hidden>
    Tastatur aktiv · Strg+Alt+Ende sendet Strg+Alt+Entf
  </div>

  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
