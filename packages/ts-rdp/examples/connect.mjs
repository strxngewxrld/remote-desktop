#!/usr/bin/env node
/**
 * Rauchtest gegen einen echten RDP-Server - ohne VS Code.
 *
 *   node examples/connect.mjs --host 10.0.0.5 --user admin --password geheim
 *
 * Das Programm verbindet sich, sammelt die Bildschirmaktualisierungen in einem
 * Framebuffer und schreibt nach `--seconds` Sekunden ein PPM-Bild. So laesst
 * sich unabhaengig von der Extension pruefen, ob Protokoll und Dekodierung
 * gegen den eigenen Server funktionieren.
 */
import { writeFileSync } from 'node:fs';
import { RdpClient, probeServerCertificate } from '../dist/index.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.host) {
  console.error('Aufruf: node examples/connect.mjs --host <server> [--user <name>] [--password <pw>]');
  console.error('        [--domain <domain>] [--port 3389] [--width 1280] [--height 800] [--seconds 5]');
  process.exit(1);
}

const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 800);
const seconds = Number(args.seconds ?? 5);

const certificate = await probeServerCertificate({ host: args.host, port: Number(args.port ?? 3389) });
console.log('Zertifikat:', certificate.subject);
console.log('  Aussteller:    ', certificate.issuer, certificate.selfSigned ? '(selbstsigniert)' : '');
console.log('  Fingerabdruck: ', certificate.fingerprint256);
console.log('  Protokoll:     ', '0x' + certificate.selectedProtocol.toString(16), '(2 = NLA)');

const framebuffer = Buffer.alloc(width * height * 3, 0);
let tiles = 0;
let bytes = 0;

const client = new RdpClient({
  host: args.host,
  port: Number(args.port ?? 3389),
  domain: args.domain ?? '',
  username: args.user,
  password: args.password,
  width,
  height,
  logLevel: args.verbose ? 'debug' : 'info',
  logSink: (level, message) => console.log(`  [${level}] ${message}`),
});

client.on('connect', () => {
  console.log(`\nVerbunden. Sitzungsgroesse ${client.width}x${client.height}.`);
  console.log(`Sammle ${seconds} Sekunden lang Bildschirmaktualisierungen…`);
  // Etwas Mausbewegung provoziert Updates, falls der Bildschirm statisch ist.
  client.sendMouseMove(client.width / 2, client.height / 2);
  setTimeout(finish, seconds * 1000);
});

client.on('bitmap', (updates) => {
  for (const tile of updates) {
    tiles++;
    bytes += tile.rgba.length;
    for (let y = 0; y < tile.height; y++) {
      const targetY = tile.y + y;
      if (targetY >= height) break;
      for (let x = 0; x < tile.width; x++) {
        const targetX = tile.x + x;
        if (targetX >= width) break;
        const src = (y * tile.width + x) * 4;
        const dst = (targetY * width + targetX) * 3;
        framebuffer[dst] = tile.rgba[src];
        framebuffer[dst + 1] = tile.rgba[src + 1];
        framebuffer[dst + 2] = tile.rgba[src + 2];
      }
    }
  }
});

client.on('pointer', (pointer) => {
  if (pointer) console.log(`  Zeiger empfangen: ${pointer.width}x${pointer.height}`);
});

client.on('error', (err) => {
  console.error('\nFehler:', err.message);
  process.exit(1);
});

client.on('close', (reason) => {
  console.log('\nVerbindung geschlossen.', reason ?? '');
});

function finish() {
  const out = args.out ?? 'screenshot.ppm';
  writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), framebuffer]));
  console.log(`\n${tiles} Kacheln empfangen (${(bytes / 1024 / 1024).toFixed(1)} MB dekodiert).`);
  console.log(`Bild geschrieben: ${out}`);
  client.disconnect();
  process.exit(0);
}

await client.connect();
