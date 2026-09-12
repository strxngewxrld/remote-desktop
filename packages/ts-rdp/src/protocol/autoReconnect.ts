/**
 * Automatischer Wiederverbindungsaufbau auf Protokollebene (MS-RDPBCGR 5.5).
 *
 * Der Ablauf laut Spezifikation:
 *
 *  1. Sobald der Benutzer angemeldet ist, schickt der Server ein
 *     ARC_SC_PRIVATE_PACKET (2.2.4.2) im Save Session Info PDU (2.2.10.1).
 *     Darin stehen die Sitzungsnummer und eine 16 Byte lange Zufallszahl.
 *  2. Der Client haelt den Cookie im Speicher vor - und gibt ihn *nicht*
 *     nach aussen. Deshalb liefert dieses Modul zwar `logonId` und `version`
 *     als Zahlen, den Zufallsanteil aber nur als Puffer fuer die Rechnung.
 *  3. Nach einem Abbruch baut der Client neu auf und legt ein
 *     ARC_CS_PRIVATE_PACKET (2.2.4.3) in die erweiterten Angaben des
 *     Info-PDU (2.2.1.11.1.1.1). Statt der Zufallszahl steht darin ein
 *     Pruefwert: HMAC-MD5 ueber die Client-Zufallszahl, geschluesselt mit der
 *     Zufallszahl des Servers.
 *  4. Stimmt der Pruefwert, landet der Client ohne erneute Anmeldung in
 *     derselben Sitzung.
 *
 * Der Cookie wird vom Server stuendlich erneuert und bei jedem Verbinden neu
 * vergeben - es gilt immer der zuletzt empfangene.
 */
import { createHmac } from 'node:crypto';
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';

/** Einzige bisher vergebene Verfahrensversion (2.2.4.2 / 2.2.4.3). */
export const AUTO_RECONNECT_VERSION_1 = 0x00000001;

/** Beide ARC-Pakete sind genau 28 Byte lang; cbLen MUSS 0x0000001c sein. */
export const ARC_PACKET_LENGTH = 0x0000001c;

/** infoType im Save Session Info PDU (2.2.10.1.1). */
export const INFOTYPE_LOGON = 0x00000000;
export const INFOTYPE_LOGON_LONG = 0x00000001;
export const INFOTYPE_LOGON_PLAINNOTIFY = 0x00000002;
export const INFOTYPE_LOGON_EXTENDED_INFO = 0x00000003;

/** FieldsPresent im Logon Info Extended (2.2.10.1.1.4). */
export const LOGON_EX_AUTORECONNECTCOOKIE = 0x00000001;
export const LOGON_EX_LOGONERRORS = 0x00000002;

/**
 * Unter Enhanced RDP Security - also TLS oder NLA - erzeugt der Client gar
 * keine Zufallszahl (5.3.2). Fuer die Berechnung des Pruefwerts gilt sie laut
 * 5.5 als Feld aus 32 Nullbytes. Dieser Client spricht ausschliesslich TLS und
 * NLA, also ist das hier der Normalfall und nicht die Ausnahme.
 */
export const ENHANCED_SECURITY_CLIENT_RANDOM: Buffer = Buffer.alloc(32);

/**
 * Fehlercodes aus dem Set Error Info PDU (2.2.5.1.1), nach denen eine
 * Wiederverbindung sinnlos ist: die Sitzung wurde absichtlich beendet oder von
 * jemand anderem uebernommen. Ein Cookie, den der Server laengst verworfen hat,
 * fuehrt nur zu einer erneuten Anmeldeaufforderung.
 */
export const SITZUNG_ENDGUELTIG_BEENDET: ReadonlySet<number> = new Set([
  0x00000001, // RPC_INITIATED_DISCONNECT
  0x00000002, // RPC_INITIATED_LOGOFF
  0x00000003, // IDLE_TIMEOUT
  0x00000004, // LOGON_TIMEOUT
  0x00000005, // DISCONNECTED_BY_OTHERCONNECTION
  0x0000000b, // RPC_INITIATED_DISCONNECT_BYUSER
  0x0000000c, // LOGOFF_BY_USER
]);

/** ARC_SC_PRIVATE_PACKET (2.2.4.2) - was der Server schickt. */
export interface ServerAutoReconnectPacket {
  /** Version des Verfahrens; bisher stets AUTO_RECONNECT_VERSION_1. */
  version: number;
  /** Nummer der Sitzung, in die zurueckgekehrt werden soll. */
  logonId: number;
  /** ArcRandomBits: 16 Byte Schluesselmaterial. Bleibt im Client. */
  arcRandom: Buffer;
}

/** ARC_CS_PRIVATE_PACKET (2.2.4.3) - was der Client zurueckschickt. */
export interface ClientAutoReconnectPacket {
  version: number;
  logonId: number;
  /** SecurityVerifier: 16 Byte, abgeleitet nach 5.5. */
  securityVerifier: Buffer;
}

/**
 * Baut ein ARC_SC_PRIVATE_PACKET (2.2.4.2).
 *
 * Auf dem Draht braucht ein Client das nicht - er empfaengt es nur. Die
 * Gegenrichtung steht hier fuer Tests und den Mock-Server bereit.
 */
export function buildServerAutoReconnectPacket(p: ServerAutoReconnectPacket): Buffer {
  pruefeLaenge(p.arcRandom, 'ArcRandomBits');
  return writer()
    .uint32le(ARC_PACKET_LENGTH)
    .uint32le(p.version)
    .uint32le(p.logonId)
    .bytes(p.arcRandom)
    .toBuffer();
}

/** Liest ein ARC_SC_PRIVATE_PACKET (2.2.4.2). */
export function parseServerAutoReconnectPacket(data: Buffer): ServerAutoReconnectPacket {
  if (data.length < ARC_PACKET_LENGTH) {
    throw new RdpProtocolError(
      `ARC_SC_PRIVATE_PACKET ist ${data.length} Byte lang, erwartet sind ${ARC_PACKET_LENGTH}`,
    );
  }
  const r = new BinaryReader(data);
  const cbLen = r.uint32le();
  if (cbLen !== ARC_PACKET_LENGTH) {
    throw new RdpProtocolError(`ARC_SC_PRIVATE_PACKET: cbLen ist 0x${cbLen.toString(16)}, erwartet 0x1c`);
  }
  return { version: r.uint32le(), logonId: r.uint32le(), arcRandom: Buffer.from(r.bytes(16)) };
}

/** Baut ein ARC_CS_PRIVATE_PACKET (2.2.4.3). */
export function buildClientAutoReconnectPacket(p: ClientAutoReconnectPacket): Buffer {
  pruefeLaenge(p.securityVerifier, 'SecurityVerifier');
  return writer()
    .uint32le(ARC_PACKET_LENGTH)
    .uint32le(p.version)
    .uint32le(p.logonId)
    .bytes(p.securityVerifier)
    .toBuffer();
}

/** Liest ein ARC_CS_PRIVATE_PACKET (2.2.4.3) - fuer Tests und Gegenproben. */
export function parseClientAutoReconnectPacket(data: Buffer): ClientAutoReconnectPacket {
  if (data.length < ARC_PACKET_LENGTH) {
    throw new RdpProtocolError(
      `ARC_CS_PRIVATE_PACKET ist ${data.length} Byte lang, erwartet sind ${ARC_PACKET_LENGTH}`,
    );
  }
  const r = new BinaryReader(data);
  const cbLen = r.uint32le();
  if (cbLen !== ARC_PACKET_LENGTH) {
    throw new RdpProtocolError(`ARC_CS_PRIVATE_PACKET: cbLen ist 0x${cbLen.toString(16)}, erwartet 0x1c`);
  }
  return { version: r.uint32le(), logonId: r.uint32le(), securityVerifier: Buffer.from(r.bytes(16)) };
}

/**
 * SecurityVerifier = HMAC(AutoReconnectRandom, ClientRandom) mit MD5 als
 * Hashfunktion (MS-RDPBCGR 5.5, Schritt 4; [RFC2104]).
 *
 * Geschluesselt wird also mit der Zahl des Servers, gehasht wird die
 * Client-Zufallszahl - nicht umgekehrt. Unter TLS/NLA ist letztere ein Feld
 * aus 32 Nullbytes, weshalb der Pruefwert zu einem gegebenen Cookie dort
 * immer gleich ausfaellt.
 */
export function computeSecurityVerifier(
  arcRandom: Buffer,
  clientRandom: Buffer = ENHANCED_SECURITY_CLIENT_RANDOM,
): Buffer {
  pruefeLaenge(arcRandom, 'ArcRandomBits');
  return createHmac('md5', arcRandom).update(clientRandom).digest();
}

/**
 * Fertiges ARC_CS_PRIVATE_PACKET aus einem empfangenen Server-Cookie - das,
 * was in das Feld `autoReconnectCookie` des Info-PDU gehoert.
 */
export function buildAutoReconnectCookie(
  cookie: ServerAutoReconnectPacket,
  clientRandom: Buffer = ENHANCED_SECURITY_CLIENT_RANDOM,
): Buffer {
  return buildClientAutoReconnectPacket({
    version: cookie.version,
    logonId: cookie.logonId,
    securityVerifier: computeSecurityVerifier(cookie.arcRandom, clientRandom),
  });
}

/** Ergebnis der Auswertung eines Save Session Info PDU (2.2.10.1.1). */
export interface SaveSessionInfo {
  infoType: number;
  /** FieldsPresent, sofern infoType INFOTYPE_LOGON_EXTENDED_INFO war. */
  fieldsPresent?: number;
  /** Nur gesetzt, wenn LOGON_EX_AUTORECONNECTCOOKIE gemeldet und lesbar war. */
  autoReconnectCookie?: ServerAutoReconnectPacket;
}

/**
 * Liest ein Save Session Info PDU (2.2.10.1.1) ab dem Feld `infoType`; der
 * Share Data Header ist zu diesem Zeitpunkt bereits verbraucht.
 *
 * Bewusst nachsichtig: alles ausser dem Cookie ist fuer diesen Client ohne
 * Belang, und ein Server, der hinter dem Cookie etwas Unerwartetes anhaengt,
 * darf keine laufende Sitzung kosten. Unlesbares fuehrt daher zu einem
 * Ergebnis ohne Cookie, nicht zu einem Fehler.
 */
export function parseSaveSessionInfo(r: BinaryReader): SaveSessionInfo {
  const infoType = r.uint32le();
  if (infoType !== INFOTYPE_LOGON_EXTENDED_INFO) return { infoType };

  try {
    // Logon Info Extended (2.2.10.1.1.4): Length, FieldsPresent, LogonFields,
    // dann 570 Byte Fuellmaterial, das laut Spezifikation zu ignorieren ist.
    r.uint16le(); // Length
    const fieldsPresent = r.uint32le();
    if (!(fieldsPresent & LOGON_EX_AUTORECONNECTCOOKIE)) return { infoType, fieldsPresent };

    // Logon Info Field (2.2.10.1.1.4.1): cbFieldData, dann die Nutzdaten.
    // Der Cookie steht laut Spezifikation stets an erster Stelle.
    const cbFieldData = r.uint32le();
    const feld = r.bytes(cbFieldData);
    return { infoType, fieldsPresent, autoReconnectCookie: parseServerAutoReconnectPacket(feld) };
  } catch {
    return { infoType };
  }
}

/**
 * Baut ein vollstaendiges Save Session Info PDU mit Cookie - alles ab
 * `infoType`. Fuer den Mock-Server und die Gegenprobe beim Parsen.
 */
export function buildSaveSessionInfoWithCookie(cookie: ServerAutoReconnectPacket): Buffer {
  const feld = buildServerAutoReconnectPacket(cookie);
  // Length zaehlt die gesamte Struktur ab dem eigenen Feld: 2 (Length) +
  // 4 (FieldsPresent) + 4 (cbFieldData) + Nutzdaten.
  const length = 2 + 4 + 4 + feld.length;
  return writer()
    .uint32le(INFOTYPE_LOGON_EXTENDED_INFO)
    .uint16le(length)
    .uint32le(LOGON_EX_AUTORECONNECTCOOKIE)
    .uint32le(feld.length)
    .bytes(feld)
    .zeros(570) // Pad
    .toBuffer();
}

function pruefeLaenge(buf: Buffer, feld: string): void {
  if (buf.length !== 16) {
    throw new RdpProtocolError(`${feld} muss 16 Byte lang sein, ist aber ${buf.length}`);
  }
}
