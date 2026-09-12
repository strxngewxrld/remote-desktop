/**
 * ts-rdp - Remote Desktop Protocol Client in reinem TypeScript.
 *
 * Unterstuetzt TLS und NLA (CredSSP/NTLMv2), Bitmap-Updates mit Interleaved-RLE
 * sowie Tastatur- und Mauseingaben.
 *
 * ```ts
 * const client = new RdpClient({ host: '10.0.0.5', username: 'admin', password: 'geheim' });
 * client.on('bitmap', (rects) => render(rects));
 * await client.connect();
 * ```
 */
export { RdpClient, serverPublicKeyDer } from './client.js';
export { probeServerCertificate } from './probe.js';
export {
  isTlsCompatibilityError,
  LEGACY_TLS_PROFILE,
  MODERN_TLS_PROFILE,
  LEGACY_TLS_EXPLANATION,
} from './protocol/tlsProfiles.js';
export type { TlsProfile } from './protocol/tlsProfiles.js';
export type { CertificateInfo, ProbeOptions } from './probe.js';
export type {
  RdpClientOptions,
  RdpClientEvents,
  RdpDiagnostics,
  AutoReconnectOptions,
} from './client.js';
export { buildClientCapabilities } from './protocol/caps.js';
export type { CapabilityProfile } from './protocol/caps.js';

// Virtuelle Kanaele: Anmeldung, Chunking und der dynamische Aufsatz darauf.
export {
  buildChannelChunks,
  parseChannelChunk,
  ChannelReassembler,
  CHANNEL_CHUNK_LENGTH,
  CHANNEL_FLAG_FIRST,
  CHANNEL_FLAG_LAST,
  CHANNEL_FLAG_SHOW_PROTOCOL,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  begrenzeChunkGroesse,
  parseVirtualChannelCapability,
} from './protocol/virtualChannel.js';
export type { ChannelChunk } from './protocol/virtualChannel.js';
export {
  CHANNEL_OPTION_INITIALIZED,
  CHANNEL_OPTION_ENCRYPT_RDP,
  CHANNEL_OPTION_COMPRESS_RDP,
  CHANNEL_OPTION_SHOW_PROTOCOL,
} from './protocol/gcc.js';
export type { ChannelDef } from './protocol/gcc.js';
export * as dvc from './protocol/dvc.js';

// Zwischenablage (MS-RDPECLIP) auf dem statischen Kanal `cliprdr`.
export * as cliprdr from './protocol/cliprdr.js';
export {
  CliprdrSession,
  CLIPRDR_CHANNEL_NAME,
  CLIPRDR_CHANNEL_DEF,
  CLIPRDR_CHANNEL_OPTIONS,
  CF_TEXT,
  CF_UNICODETEXT,
  STANDARD_MAX_BYTES,
  zeilenendenNachLokal,
  zeilenendenNachWindows,
} from './protocol/cliprdr.js';
export type {
  CliprdrSessionOptions,
  CliprdrFormat,
  CliprdrCapabilities,
  CliprdrPdu,
  ZwischenablageRichtung,
} from './protocol/cliprdr.js';

export { RdpError, RdpProtocolError, RdpAuthError, ERROR_INFO_CODES, NEG_FAILURE_CODES } from './core/errors.js';
export { createLogger, nullLogger } from './core/log.js';
export type { Logger, LogLevel, LogSink } from './core/log.js';
export { BinaryReader, BinaryWriter } from './core/binary.js';
export { backoffWartezeit, STANDARD_BACKOFF } from './core/backoff.js';
export type { BackoffOptions } from './core/backoff.js';

export {
  AUTO_RECONNECT_VERSION_1,
  ARC_PACKET_LENGTH,
  ENHANCED_SECURITY_CLIENT_RANDOM,
  INFOTYPE_LOGON,
  INFOTYPE_LOGON_LONG,
  INFOTYPE_LOGON_PLAINNOTIFY,
  INFOTYPE_LOGON_EXTENDED_INFO,
  LOGON_EX_AUTORECONNECTCOOKIE,
  LOGON_EX_LOGONERRORS,
  SITZUNG_ENDGUELTIG_BEENDET,
  buildServerAutoReconnectPacket,
  parseServerAutoReconnectPacket,
  buildClientAutoReconnectPacket,
  parseClientAutoReconnectPacket,
  computeSecurityVerifier,
  buildAutoReconnectCookie,
  parseSaveSessionInfo,
  buildSaveSessionInfoWithCookie,
} from './protocol/autoReconnect.js';
export type {
  ServerAutoReconnectPacket,
  ClientAutoReconnectPacket,
  SaveSessionInfo,
} from './protocol/autoReconnect.js';

export type { DecodedBitmap, BitmapRectangle, PointerImage } from './protocol/updates.js';
export {
  decodeBitmap,
  parseBitmapUpdate,
  parsePointerImage,
  parseSurfaceCommands,
  decodeSurfaceBits,
} from './protocol/updates.js';
export type { SurfaceBits } from './protocol/updates.js';
export { interleavedDecompress, RleError } from './codec/rle.js';
export { planarDecompress, PlanarError } from './codec/planar.js';
export type { PlanarOptions } from './codec/planar.js';
export { ZgfxDecompressor, ZgfxError, zgfxWrapUncompressed } from './codec/zgfx.js';
export * as egfx from './protocol/egfx.js';
export { EgfxSession, DEFAULT_EGFX_CAPS } from './protocol/egfxSession.js';
export type { EgfxVideoFrame } from './protocol/egfxSession.js';
export { parseAvc420, parseAvc444, parseAvc444V2 } from './codec/avcMeta.js';
export { ClearCodecDecoder } from './codec/clear.js';
export { ProgressiveDecoder } from './codec/progressive.js';
export type { ProgressiveTile } from './codec/progressive.js';
export type { Avc420Stream, Avc444Stream, AvcRegion, AvcRect } from './codec/avcMeta.js';
export type { EgfxSessionOptions } from './protocol/egfxSession.js';
export {
  GRAPHICS_CHANNEL_NAME,
  MOUSE_CURSOR_CHANNEL_NAME,
  CORE_INPUT_CHANNEL_NAME,
  PIPELINE_CHANNEL_NAMES,
} from './client.js';
export { toRgba, bytesPerPixel, flipVertical } from './codec/pixel.js';

export { SCANCODES, lookupScancode, SYNC_CAPS_LOCK, SYNC_NUM_LOCK, SYNC_SCROLL_LOCK } from './protocol/keymap.js';
export type { ScancodeMapping } from './protocol/keymap.js';

export {
  PTRFLAGS_BUTTON1,
  PTRFLAGS_BUTTON2,
  PTRFLAGS_BUTTON3,
  PTRFLAGS_DOWN,
  PTRFLAGS_MOVE,
  PTRFLAGS_WHEEL,
  PTRFLAGS_WHEEL_NEGATIVE,
  PTRFLAGS_HWHEEL,
  PTRXFLAGS_BUTTON1,
  PTRXFLAGS_BUTTON2,
  KBDFLAGS_EXTENDED,
  KBDFLAGS_DOWN,
  KBDFLAGS_RELEASE,
  PROTOCOL_RDP,
  PROTOCOL_SSL,
  PROTOCOL_HYBRID,
} from './protocol/constants.js';

export { NtlmClient, ntowfv1, ntowfv2, tlsChannelBindings, computeNtlmV2Response, filetime, parseAvPairs, buildAvPairs } from './crypto/ntlm.js';
export { CredSspClient, encodeTsRequest, decodeTsRequest, encodeTsCredentials } from './crypto/credssp.js';
export { md4 } from './crypto/md4.js';
export { Rc4, rc4 } from './crypto/rc4.js';
