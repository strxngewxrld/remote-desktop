import './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RdpSession } from '../src/session.js';

test('Geschlossene Sitzungen und doppelte ready-Nachrichten starten keine Verbindung', async () => {
  const session = Object.create(RdpSession.prototype) as any;
  session.disposed = true;
  await session.start({ type: 'ready' });
  await session.handleWebviewMessage({ type: 'reconnect' });
  session.disposed = false;
  session.lastReady = { type: 'ready' };
  session.start = () => { throw new Error('Doppelter Start'); };
  // Ein zweites 'ready' (Webview neu geladen) startet nichts, sondern sendet den Zustand erneut.
  session.panel = { webview: { postMessage: () => Promise.resolve(true) } };
  session.zusatzMonitore = [];
  session.connection = { name: 'x', host: 'h' };
  session.diagnoseSichtbar = false;
  await session.handleWebviewMessage({ type: 'ready', width: 800, height: 600, devicePixelRatio: 1 });
  assert.deepEqual([session.lastReady.width, session.lastReady.height], [800, 600], 'die neue Groesse ist gemerkt');
});
