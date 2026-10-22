// Credentials arrive over stdin, never in command-line arguments or logs.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { RdpClient, probeServerCertificate } from '../packages/ts-rdp/dist/index.js';

const options = JSON.parse(readFileSync(0, 'utf8'));
const mechanism = options.nlaMechanism ?? 'auto';
const certificate = await probeServerCertificate({ host: options.host, port: options.port ?? 3389 });
console.log(JSON.stringify({ certificate: certificate.subject, fingerprint: certificate.fingerprint256 }));
const client = new RdpClient({
  ...options, width: 1024, height: 768, colorDepth: 32,
  allowTlsOnly: false, enableGraphicsPipeline: true, enableDisplayControl: true,
  verifyCertificate: cert => {
    if (cert.fingerprint256?.toUpperCase() !== certificate.fingerprint256.toUpperCase())
      throw new Error('Server certificate changed after the probe');
  },
  logLevel: 'info', logSink: (level, message) => console.log(`[${level}] ${message}`),
});
delete options.password;
let width = 1024, height = 768, pixels = Buffer.alloc(width * height * 4), tiles = 0;
client.on('resize', size => {
  width = size.width; height = size.height;
  pixels = Buffer.alloc(width * height * 4);
});
client.on('bitmap', updates => {
  for (const tile of updates) {
    tiles++;
    for (let y = 0; y < tile.height; y++) {
      const targetY = tile.y + y;
      if (targetY < 0 || targetY >= height) continue;
      const startX = Math.max(0, tile.x), endX = Math.min(width, tile.x + tile.width);
      if (endX <= startX) continue;
      Buffer.from(tile.rgba.buffer, tile.rgba.byteOffset + (y * tile.width + startX - tile.x) * 4,
        (endX - startX) * 4).copy(pixels, (targetY * width + startX) * 4);
    }
  }
});
let failure;
client.on('error', error => { failure = error; console.error(error.message); });
const deadline = setTimeout(() => { failure = new Error('RDP smoke test timed out'); client.disconnect(); }, 45000);
try {
  await client.connect();
  console.log(JSON.stringify({ connected: true, width: client.width, height: client.height,
    requestedAuthentication: mechanism, authentication: client.authenticationMechanism }));
  client.sendMouseMove(400, 300);
  await new Promise(resolve => setTimeout(resolve, 10000));
  console.log(JSON.stringify({ tiles, diagnostics: client.getDiagnostics(), displayControl: client.canChangeResolution }));
  if (failure) throw failure;
  if (!tiles) throw new Error('Connected, but no decoded image tiles received');
  writeFileSync(new URL(`../logs/${mechanism}-windows-rdp.png`, import.meta.url), png(width, height, pixels));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  client.disconnect();
}

function png(w, h, rgba) {
  const crc = data => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const header = Buffer.alloc(4), tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body));
    return Buffer.concat([header, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
