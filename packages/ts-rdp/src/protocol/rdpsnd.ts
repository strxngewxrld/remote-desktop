import { CHANNEL_OPTION_INITIALIZED, CHANNEL_OPTION_ENCRYPT_RDP, type ChannelDef } from './gcc.js';

/** Windows kann RDPDR erst initialisieren, wenn auch RDPSND angemeldet ist. */
export const RDPSND_CHANNEL_DEF: ChannelDef = {
  name: 'rdpsnd',
  options: (CHANNEL_OPTION_INITIALIZED | CHANNEL_OPTION_ENCRYPT_RDP) >>> 0,
};

/** MS-RDPEA: reine Kompatibilitätsaushandlung, keine Codecs oder Audiowiedergabe. */
export function silentAudioReplies(data: Buffer): Buffer[] {
  if (data.length < 4 || data.readUInt16LE(2) !== data.length - 4) throw new Error('RDPSND: ungültige PDU-Länge');
  if (data[0] === 7) { // SNDC_FORMATS
    if (data.length < 24) throw new Error('RDPSND: abgeschnittene Formataushandlung');
    const count = data.readUInt16LE(18);
    let offset = 24;
    for (let i = 0; i < count; i++) {
      if (offset + 18 > data.length) throw new Error('RDPSND: abgeschnittenes Audioformat');
      offset += 18 + data.readUInt16LE(offset + 16);
      if (offset > data.length) throw new Error('RDPSND: abgeschnittene Formatdaten');
    }
    if (offset !== data.length) throw new Error('RDPSND: unerwartete Formatdaten');
    const reply = Buffer.alloc(24);
    reply[0] = 7;
    reply.writeUInt16LE(20, 2);
    reply.writeUInt32LE(1, 4); // TSSNDCAPS_ALIVE; wie Guacamole ohne Audio: keine Formate
    reply.writeUInt16LE(6, 21);
    // UDP-Port und Formatanzahl bleiben null. Es kann kein Audioformat gewählt werden.
    const replies = [reply];
    if (data.readUInt16LE(21) >= 6) {
      const quality = Buffer.alloc(8);
      quality[0] = 12; // SNDC_QUALITYMODE, bei beidseitiger Version >= 6 erforderlich
      quality.writeUInt16LE(4, 2);
      quality.writeUInt16LE(2, 4); // HIGH_QUALITY; ohne Formate ohne Auswirkung
      replies.push(quality);
    }
    return replies;
  }
  if (data[0] === 6) { // SNDC_TRAINING: nur Zeitstempel und Paketgröße zurückgeben
    if (data.length < 8) throw new Error('RDPSND: abgeschnittenes Training');
    const reply = Buffer.alloc(8);
    reply[0] = 6;
    reply.writeUInt16LE(4, 2);
    data.copy(reply, 4, 4, 8);
    return [reply];
  }
  return []; // Insbesondere keine Wave-Nutzdaten dekodieren oder weiterreichen.
}
