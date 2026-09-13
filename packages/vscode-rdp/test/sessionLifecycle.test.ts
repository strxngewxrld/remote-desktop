import './vscodeStub.js';
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
  await session.handleWebviewMessage({ type: 'ready' });
});
