/**
 * Client Info PDU und Lizenz-PDUs (MS-RDPBCGR 2.2.1.11 / MS-RDPELE).
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpError } from '../core/errors.js';
import {
  INFO_AUTOLOGON,
  INFO_DISABLECTRLALTDEL,
  INFO_ENABLEWINDOWSKEY,
  INFO_LOGONNOTIFY,
  INFO_MAXIMIZESHELL,
  INFO_MOUSE,
  INFO_MOUSE_HAS_WHEEL,
  INFO_UNICODE,
} from './constants.js';

export const PERF_DISABLE_WALLPAPER = 0x00000001;
export const PERF_DISABLE_FULLWINDOWDRAG = 0x00000002;
export const PERF_DISABLE_MENUANIMATIONS = 0x00000004;
export const PERF_DISABLE_THEMING = 0x00000008;
export const PERF_DISABLE_CURSOR_SHADOW = 0x00000020;
export const PERF_DISABLE_CURSORSETTINGS = 0x00000040;
export const PERF_ENABLE_FONT_SMOOTHING = 0x00000080;
export const PERF_ENABLE_DESKTOP_COMPOSITION = 0x00000100;

export interface ClientInfoOptions {
  domain: string;
  username: string;
  password: string;
  /** Programm statt Desktop starten (leer = normale Sitzung). */
  alternateShell?: string;
  workingDir?: string;
  clientAddress?: string;
  performanceFlags?: number;
  /** Zugangsdaten direkt mitschicken (bei NLA hat der Server sie ohnehin schon). */
  autoLogon?: boolean;
}

export function buildClientInfo(o: ClientInfoOptions): Buffer {
  const flags =
    INFO_MOUSE |
    INFO_MOUSE_HAS_WHEEL |
    INFO_UNICODE |
    INFO_DISABLECTRLALTDEL |
    INFO_LOGONNOTIFY |
    INFO_MAXIMIZESHELL |
    INFO_ENABLEWINDOWSKEY |
    (o.autoLogon === false ? 0 : INFO_AUTOLOGON);

  const domain = o.domain ?? '';
  const user = o.username ?? '';
  const password = o.password ?? '';
  const shell = o.alternateShell ?? '';
  const workingDir = o.workingDir ?? '';
  const clientAddress = o.clientAddress ?? '';

  const byteLen = (s: string) => Buffer.byteLength(s, 'ucs2');

  const w = writer();
  w.uint32le(0) // codePage
    .uint32le(flags)
    .uint16le(byteLen(domain))
    .uint16le(byteLen(user))
    .uint16le(byteLen(password))
    .uint16le(byteLen(shell))
    .uint16le(byteLen(workingDir))
    .utf16leNul(domain)
    .utf16leNul(user)
    .utf16leNul(password)
    .utf16leNul(shell)
    .utf16leNul(workingDir);

  // Extended Info (ab RDP 5): Adresse, Verzeichnis, Zeitzone, Leistungsflags.
  w.uint16le(2) // clientAddressFamily: AF_INET
    .uint16le(byteLen(clientAddress) + 2)
    .utf16leNul(clientAddress)
    .uint16le(2)
    .utf16leNul('')
    .zeros(172) // TIME_ZONE_INFORMATION - der Server faellt auf seine Zeitzone zurueck
    .uint32le(0) // clientSessionId
    .uint32le(o.performanceFlags ?? PERF_DISABLE_WALLPAPER | PERF_DISABLE_MENUANIMATIONS | PERF_DISABLE_THEMING);

  return w.toBuffer();
}

export const LICENSE_REQUEST = 0x01;
export const PLATFORM_CHALLENGE = 0x02;
export const NEW_LICENSE = 0x03;
export const UPGRADE_LICENSE = 0x04;
export const ERROR_ALERT = 0xff;

export const STATUS_VALID_CLIENT = 0x00000007;

export interface LicensePdu {
  messageType: number;
  /** Nur bei ERROR_ALERT gesetzt. */
  errorCode?: number;
  stateTransition?: number;
}

export function parseLicensePdu(r: BinaryReader): LicensePdu {
  const messageType = r.uint8();
  r.uint8(); // flags
  r.uint16le(); // wMsgSize
  if (messageType === ERROR_ALERT) {
    return { messageType, errorCode: r.uint32le(), stateTransition: r.uint32le() };
  }
  return { messageType };
}

/**
 * Prueft, ob die Lizenzphase erfolgreich beendet ist.
 * Echte Lizenzausstellung (Per-Device-CALs) wird nicht unterstuetzt.
 */
export function evaluateLicense(pdu: LicensePdu): void {
  if (pdu.messageType === ERROR_ALERT) {
    if (pdu.errorCode === STATUS_VALID_CLIENT || pdu.stateTransition === 2) return;
    throw new RdpError(
      `Lizenzfehler des Servers (Code 0x${(pdu.errorCode ?? 0).toString(16)})`,
      'RDP_LICENSE',
    );
  }
  if (pdu.messageType === LICENSE_REQUEST) {
    throw new RdpError(
      'Der Server verlangt eine echte Terminalserver-Lizenz (Per-Device-CAL). ' +
        'Dieses Lizenzprotokoll wird noch nicht unterstuetzt.',
      'RDP_LICENSE_REQUIRED',
    );
  }
  // NEW_LICENSE/UPGRADE_LICENSE: der Server stellt eine Lizenz aus, die wir
  // nicht speichern. Die Sitzung laeuft trotzdem weiter.
}
