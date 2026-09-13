import { Uri } from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderWebview } from '../src/webview.js';

test('Verbindungsnamen bleiben Text und Nonces sind pro Webview verschieden', () => {
  const webview = { asWebviewUri: (uri: unknown) => uri, cspSource: 'vscode-resource:' };
  const render = () => renderWebview(webview as any, Uri.file('/extension'), '</title><img src=x>&');
  const a = render();
  assert.ok(a.includes('<title>&lt;/title&gt;&lt;img src=x&gt;&amp;</title>'));
  assert.ok(!a.includes('<img src=x>'));
  const nonce = (html: string) => html.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce(a));
  assert.notEqual(nonce(a), nonce(render()));
});
