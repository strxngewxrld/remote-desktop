#!/usr/bin/env node
/**
 * Findet heraus, welcher Capability-Satz einen bestimmten Server dazu bringt,
 * Bildschirminhalte zu senden.
 *
 *   node examples/diagnose.mjs --host 192.168.188.34 --user tom --password geheim
 *
 * Das Skript verbindet sich mehrfach hintereinander, jedes Mal mit einer
 * anderen Einstellung, und meldet fuer jede, wie viele Rahmen und Bildkacheln
 * ankamen. Das Passwort bleibt auf diesem Rechner - ausgegeben wird nur die
 * Ergebnistabelle.
 */
import { RdpClient } from '../dist/index.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

const args = parseArgs(process.argv);
if (!args.host || !args.user) {
  console.error('Aufruf: node examples/diagnose.mjs --host <server> --user <name> --password <pw>');
  console.error('        [--domain <domain>] [--port 3389] [--width 1024] [--height 768] [--wait 8]');
  process.exit(1);
}

const width = Number(args.width ?? 1024);
const height = Number(args.height ?? 768);
const wartezeit = Number(args.wait ?? 8) * 1000;

/** Die zu vergleichenden Einstellungen. */
const V8 = 0x00080004;
const V81 = 0x00080105;
const V10 = 0x000a0002;
const V10_1 = 0x000a0100;
const V10_2 = 0x000a0200;
const V10_3 = 0x000a0301;
const V10_4 = 0x000a0400;
const V10_5 = 0x000a0502;
const V10_6 = 0x000a0600;
const V10_7 = 0x000a0701;
const AVC420_ENABLED = 0x00000010;
const AVC_DISABLED = 0x00000020;

/**
 * Der Server steigt bei manchen Kombinationen mit
 * ERRINFO_GRAPHICSSUBSYSTEMFAILED (0x112F) aus. Statt zu raten, welche er
 * vertraegt, werden sie hier durchprobiert.
 */
const ALLE_KANAELE = [
  'Microsoft::Windows::RDS::Graphics',
  'Microsoft::Windows::RDS::MouseCursor',
  'Microsoft::Windows::RDS::CoreInput',
];

const profile = [
  // Der echte Windows-Client meldet die volle Leiter an und laesst dem Server
  // die Wahl. Sein Log zeigt, was der Server dann waehlt: "Server and client
  // both are AVC capable" - dieser Server kodiert H.264.
  {
    name: 'AVC erlaubt: volle Leiter V8 bis V10.7 (wie der echte Client)',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [
      { version: V8, flags: 0 },
      { version: V81, flags: AVC420_ENABLED },
      { version: V10, flags: 0 },
      { version: V10_1 },
      { version: V10_2, flags: 0 },
      { version: V10_3, flags: 0 },
      { version: V10_4, flags: 0 },
      { version: V10_5, flags: 0 },
      { version: V10_6, flags: 0 },
      { version: V10_7, flags: 0 },
    ],
  },
  {
    name: 'AVC erlaubt: nur V10.7',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [{ version: V10_7, flags: 0 }],
  },
  {
    name: 'AVC erlaubt: nur V10.2',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [{ version: V10_2, flags: 0 }],
  },
  {
    name: 'AVC erlaubt: nur V10',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [{ version: V10, flags: 0 }],
  },
  {
    name: 'AVC erlaubt: nur V8.1 mit AVC420_ENABLED',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [{ version: V81, flags: AVC420_ENABLED }],
  },
  // Gegenproben. Scheitern diese weiterhin mit 0x112F, waehrend oben etwas
  // ankommt, ist die Ursache bewiesen und nicht nur wahrscheinlich.
  {
    name: 'GEGENPROBE: V10.7 mit AVC_DISABLED',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [{ version: V10_7, flags: AVC_DISABLED }],
  },
  {
    name: 'GEGENPROBE: nur V8 (kennt kein AVC)',
    enableGraphicsPipeline: true,
    graphicsCapsSets: [{ version: V8, flags: 0 }],
  },
];

/** Die aelteren Messpunkte ohne Pipeline - nur noch zur Gegenprobe. */
const altProfile = [
  // Der entscheidende Messpunkt: meldet der Server Grafik nur noch ueber die
  // Graphics Pipeline, kommen hier Daten auf dem Kanal drdynvc an - und auf
  // dem klassischen Weg weiterhin nichts.
  {
    name: 'MESSPUNKT: Graphics Pipeline aktiv',
    colorDepth: 32,
    capabilityProfile: {},
    enableGraphicsPipeline: true,
  },
  {
    name: 'MESSPUNKT: drdynvc angemeldet, alle Kanaele annehmen',
    colorDepth: 32,
    capabilityProfile: {},
    announceDynamicChannels: true,
    acceptDynamicChannels: true,
  },
  { name: '32 bpp, Surface Commands (Standard)', colorDepth: 32, capabilityProfile: {} },
  { name: '32 bpp, ohne Surface Commands', colorDepth: 32, capabilityProfile: { surfaceCommands: false } },
  { name: '32 bpp, mit Frame Acknowledge', colorDepth: 32, capabilityProfile: { frameAcknowledge: true } },
  { name: '32 bpp, mit Zeichenbefehlen', colorDepth: 32, capabilityProfile: { orders: true } },
  { name: '32 bpp, ohne Bitmap-Cache', colorDepth: 32, capabilityProfile: { bitmapCache: false } },
  { name: '16 bpp, ohne Surface Commands', colorDepth: 16, capabilityProfile: { surfaceCommands: false } },
  { name: '16 bpp, mit Zeichenbefehlen', colorDepth: 16, capabilityProfile: { orders: true } },
  {
    name: '32 bpp, alles an',
    colorDepth: 32,
    capabilityProfile: { orders: true, frameAcknowledge: true, surfaceCommands: true },
  },
];

async function messen(eintrag) {
  const client = new RdpClient({
    host: args.host,
    port: Number(args.port ?? 3389),
    domain: args.domain ?? '',
    username: args.user,
    password: args.password ?? process.env.RDP_PASSWORD ?? '',
    width,
    height,
    colorDepth: eintrag.colorDepth ?? 32,
    capabilityProfile: eintrag.capabilityProfile ?? {},
    announceDynamicChannels: eintrag.announceDynamicChannels === true,
    enableGraphicsPipeline: eintrag.enableGraphicsPipeline === true,
    graphicsCapsSets: eintrag.graphicsCapsSets,
    acceptDynamicChannels: eintrag.acceptNames
      ? (name) => eintrag.acceptNames.includes(name)
      : eintrag.acceptDynamicChannels
        ? () => true
        : undefined,
    connectTimeout: 15000,
  });

  let fehler;
  const meldungen = [];
  client.on('error', (err) => (fehler = err.message));
  client.on('close', (grund) => grund && meldungen.push(grund));

  try {
    await client.connect();
  } catch (err) {
    return { fehler: err.message };
  }

  // Anstossen wie die Extension es tut, dann abwarten.
  client.refresh();
  client.sendMouseMove(Math.floor(width / 2), Math.floor(height / 2));
  await new Promise((resolve) => setTimeout(resolve, wartezeit));

  const d = client.getDiagnostics();
  client.disconnect();
  return { ...d, fehler, meldungen };
}

console.log(`Server ${args.host}, ${width}x${height}, je ${wartezeit / 1000} s Wartezeit\n`);
void altProfile;

const ergebnisse = [];
for (const eintrag of profile) {
  process.stdout.write(`→ ${eintrag.name} … `);
  const ergebnis = await messen(eintrag);
  ergebnisse.push({ name: eintrag.name, ...ergebnis });
  if (ergebnis.fehler) {
    console.log(`Fehler: ${ergebnis.fehler}`);
  } else {
    const rahmen = ergebnis.frames.fastpath + ergebnis.frames.slowpath;
    const kanaele = Object.entries(ergebnis.virtualChannelBytes ?? {});
    console.log(
      `${ergebnis.bitmaps} Kacheln, ${rahmen} Rahmen ` +
        `(${ergebnis.frames.fastpath} fastpath) · Updates: ${JSON.stringify(ergebnis.updateCodes)}` +
        (kanaele.length ? ` · virtuelle Kanaele: ${JSON.stringify(ergebnis.virtualChannelBytes)}` : '') +
        (ergebnis.dynamicChannels?.length ? `\n    Dynamische Kanaele: ${ergebnis.dynamicChannels.join(', ')}` : '') +
        (ergebnis.graphicsBytes ? `\n    Graphics Pipeline: ${ergebnis.graphicsBytes} Byte entpackt` : '') +
        (Object.keys(ergebnis.graphicsCodecs ?? {}).length
          ? `\n    Kacheln je Codec: ${JSON.stringify(ergebnis.graphicsCodecs)}`
          : '') +
        (ergebnis.graphicsAvc?.bytes
          ? `\n    H.264 zerlegt: ${ergebnis.graphicsAvc.regionen} Regionen, ${ergebnis.graphicsAvc.bytes} Byte Bitstream`
          : '') +
        (ergebnis.meldungen?.length ? `\n    Server meldet: ${ergebnis.meldungen.join('; ')}` : ''),
    );
  }
}

console.log('\n================ Ergebnis ================');

const mitGrafik = ergebnisse.filter((e) => e.graphicsBytes > 0);
if (!mitGrafik.length) {
  console.log('Kein Profil hat den Server dazu gebracht, auf dem Grafikkanal zu senden.');
  console.log('Die AVC-These ist damit widerlegt - die Ursache liegt woanders.');
} else {
  console.log('Der Server sendet bei diesen Profilen auf dem Grafikkanal:');
  for (const e of mitGrafik) {
    console.log(`  → ${e.name}: ${e.graphicsBytes} Byte, Codecs ${JSON.stringify(e.graphicsCodecs ?? {})}`);
  }

  const gegenprobe = ergebnisse.filter((e) => e.name.startsWith('GEGENPROBE') && e.graphicsBytes > 0);
  if (gegenprobe.length) {
    console.log('\nAchtung: auch eine Gegenprobe ohne AVC hat Daten bekommen.');
    console.log('Dann ist nicht AVC der Ausloeser, sondern etwas anderes an diesen Profilen.');
  } else {
    console.log('\nBewiesen: dieser Server liefert Grafik nur, wenn der Client H.264 zusagt.');
    console.log('Die Gegenproben ohne AVC bleiben stumm.');
  }

  const codecs = new Set();
  for (const e of mitGrafik) for (const c of Object.keys(e.graphicsCodecs ?? {})) codecs.add(c);
  if (codecs.size) console.log(`\nBenoetigte Decoder: ${[...codecs].join(', ')}`);
}

const bild = ergebnisse.filter((e) => e.bitmaps > 0);
if (bild.length) {
  console.log('\nEin Bild kam zustande bei:');
  for (const e of bild) console.log(`  \u2713 ${e.name} (${e.bitmaps} Kacheln)`);
}
