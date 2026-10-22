// Run after `npm test`: local TLS/NLA peer for manual Extension Host checks.
// This is a protocol fixture, not a Windows desktop or a compatibility test.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { MockRdpServer } = require('../packages/ts-rdp/dist-test/test/mockServer.js');
const { BinaryWriter } = require('../packages/ts-rdp/dist/core/binary.js');
const clip = require('../packages/ts-rdp/dist/protocol/cliprdr.js');
const root = fileURLToPath(new URL('../.vscode-test/windows-ui/', import.meta.url));
mkdirSync(root, { recursive: true });
const openssl = process.env.OPENSSL_PATH ??
  (process.platform === 'win32' ? 'C:/Program Files/Git/mingw64/bin/openssl.exe' : 'openssl');
const certPath = join(root, 'cert.pem');
const keyPath = join(root, 'key.pem');
if (!existsSync(certPath)) execFileSync(openssl, [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
  '-out', certPath, '-days', '2', '-subj', '/CN=Windows-E2E-local-fixture',
], { stdio: 'ignore' });

const server = new MockRdpServer({
  cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8'),
  width: 800, height: 600, credentials: { domain: '', user: 'tester', password: 'WindowsE2E!' },
  refreshRectSupport: true,
});
const log = (type, data) => console.log(JSON.stringify({ time: new Date().toISOString(), type, data }));
server.on('error', error => log('error', String(error)));
server.on('credssp', result => log('nla', { user: result.credentials?.user, micVerified: result.micVerified }));
server.on('input', input => log('input', input));
let active = false;
function tile(x, y, w, h, color) {
  const pixels = Buffer.alloc(w * h * 2);
  for (let i = 0; i < pixels.length; i += 2) pixels.writeUInt16LE(color, i);
  const data = new BinaryWriter().uint16le(1).uint16le(1).uint16le(x).uint16le(y)
    .uint16le(x + w - 1).uint16le(y + h - 1).uint16le(w).uint16le(h)
    .uint16le(16).uint16le(0).uint16le(pixels.length).bytes(pixels).toBuffer();
  server.sendFastpathUpdate(1, data);
}
server.on('activated', () => {
  active = true;
  log('activated', { width: 800, height: 600 });
  for (let y = 0; y < 600; y += 4) {
    tile(0, y, 800, 4, y < 200 ? 0x001f : y < 400 ? 0x07e0 : 0xf800);
  }
  server.sendStaticChannelData('cliprdr', clip.buildClipboardCapabilities(clip.CB_USE_LONG_FORMAT_NAMES));
  server.sendStaticChannelData('cliprdr', clip.buildMonitorReady());
});
server.on('staticChannelData', ({ name, data }) => {
  if (name !== 'cliprdr') return;
  const pdu = clip.parseCliprdrPdu(data);
  if (pdu.msgType === clip.CB_FORMAT_LIST) {
    server.sendStaticChannelData(name, clip.buildFormatListResponse(true));
    const formats = clip.parseFormatList(pdu.body, { longFormatNames: true });
    if (formats.some(f => f.formatId === clip.CF_UNICODETEXT))
      server.sendStaticChannelData(name, clip.buildFormatDataRequest(clip.CF_UNICODETEXT));
  } else if (pdu.msgType === clip.CB_FORMAT_DATA_RESPONSE) {
    log('clipboard-local-to-remote', clip.dekodiereUnicodeText(pdu.body));
  } else if (pdu.msgType === clip.CB_FORMAT_DATA_REQUEST) {
    server.sendStaticChannelData(name, clip.buildFormatDataResponse(clip.kodiereUnicodeText('Remote Windows E2E: äöü €')));
  }
});
// F8 copies a known remote value, F9 drops the transport for reconnect checks.
server.on('input', ({ events }) => {
  for (const event of events) {
    if (event.messageType !== 4 || event.flags & 0x8000) continue;
    if (event.param1 === 0x42) server.sendStaticChannelData('cliprdr', clip.buildFormatList(
      [{ formatId: clip.CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    if (event.param1 === 0x43) { active = false; server.close(); log('closed', 'F9'); }
  }
});
const port = await server.listen(Number(process.env.WINDOWS_E2E_PORT ?? 0));
const user = join(root, 'user-data', 'User');
mkdirSync(user, { recursive: true });
writeFileSync(join(user, 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom',
  'rdp.driveRedirection.enabled': false,
  'rdp.connections': [{ name: 'Windows E2E', host: '127.0.0.1', port, username: 'tester', color: 'blue' }],
}, null, 2));
writeFileSync(join(root, 'import-test.rdp'), `full address:s:127.0.0.1:${port}\r\nusername:s:tester\r\ndesktopwidth:i:800\r\ndesktopheight:i:600\r\n`);
writeFileSync(join(root, 'server.json'), JSON.stringify({ port, userData: join(root, 'user-data') }));
log('listening', { host: '127.0.0.1', port, user: 'tester', testPassword: 'WindowsE2E!' });
let tick = 0;
setInterval(() => { if (active) tile(20, 20, 120, 40, tick++ % 2 ? 0xffff : 0xffe0); }, 1000);
process.on('SIGINT', () => { server.close(); process.exit(); });
