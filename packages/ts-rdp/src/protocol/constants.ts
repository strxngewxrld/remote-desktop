/** Konstanten aus MS-RDPBCGR, gebuendelt damit der Protokollcode lesbar bleibt. */

/** Angeforderte/ausgehandelte Sicherheitsprotokolle (2.2.1.1.1). */
export const PROTOCOL_RDP = 0x00000000;
export const PROTOCOL_SSL = 0x00000001;
export const PROTOCOL_HYBRID = 0x00000002;
export const PROTOCOL_RDSTLS = 0x00000004;
export const PROTOCOL_HYBRID_EX = 0x00000008;

/** X.224-Nachrichtentypen. */
export const TYPE_RDP_NEG_REQ = 0x01;
export const TYPE_RDP_NEG_RSP = 0x02;
export const TYPE_RDP_NEG_FAILURE = 0x03;

/** Security-Header-Flags (2.2.8.1.1.2.1). */
export const SEC_EXCHANGE_PKT = 0x0001;
export const SEC_TRANSPORT_REQ = 0x0002;
export const SEC_ENCRYPT = 0x0008;
export const SEC_RESET_SEQNO = 0x0010;
export const SEC_IGNORE_SEQNO = 0x0020;
export const SEC_INFO_PKT = 0x0040;
export const SEC_LICENSE_PKT = 0x0080;
export const SEC_LICENSE_ENCRYPT_CS = 0x0200;
export const SEC_REDIRECTION_PKT = 0x0400;
export const SEC_SECURE_CHECKSUM = 0x0800;
export const SEC_AUTODETECT_REQ = 0x1000;
export const SEC_AUTODETECT_RSP = 0x2000;
export const SEC_HEARTBEAT = 0x4000;
export const SEC_FLAGSHI_VALID = 0x8000;

/** Flags im Client-Info-PDU (2.2.1.11.1.1). */
export const INFO_MOUSE = 0x00000001;
export const INFO_DISABLECTRLALTDEL = 0x00000002;
export const INFO_AUTOLOGON = 0x00000008;
export const INFO_UNICODE = 0x00000010;
export const INFO_MAXIMIZESHELL = 0x00000020;
export const INFO_LOGONNOTIFY = 0x00000040;
export const INFO_COMPRESSION = 0x00000080;
export const INFO_ENABLEWINDOWSKEY = 0x00000100;
export const INFO_MOUSE_HAS_WHEEL = 0x00020000;
export const INFO_NOAUDIOPLAYBACK = 0x00080000;

/** PDU-Typen im Share Control Header (2.2.8.1.1.1.1). */
export const PDUTYPE_DEMANDACTIVEPDU = 0x1;
export const PDUTYPE_CONFIRMACTIVEPDU = 0x3;
export const PDUTYPE_DEACTIVATEALLPDU = 0x6;
export const PDUTYPE_DATAPDU = 0x7;
export const PDUTYPE_SERVER_REDIR_PKT = 0xa;
export const PDU_PROTOCOL_VERSION = 0x10;

/** PDU-Typen im Share Data Header (2.2.8.1.1.1.2). */
export const PDUTYPE2_UPDATE = 0x02;
export const PDUTYPE2_CONTROL = 0x14;
export const PDUTYPE2_POINTER = 0x1b;
export const PDUTYPE2_INPUT = 0x1c;
export const PDUTYPE2_SYNCHRONIZE = 0x1f;
export const PDUTYPE2_REFRESH_RECT = 0x21;
export const PDUTYPE2_PLAY_SOUND = 0x22;
export const PDUTYPE2_SUPPRESS_OUTPUT = 0x23;
export const PDUTYPE2_SHUTDOWN_REQUEST = 0x24;
export const PDUTYPE2_SHUTDOWN_DENIED = 0x25;
export const PDUTYPE2_SAVE_SESSION_INFO = 0x26;
export const PDUTYPE2_FONTLIST = 0x27;
export const PDUTYPE2_FONTMAP = 0x28;
export const PDUTYPE2_SET_ERROR_INFO_PDU = 0x2f;

/** Aktionen im Control PDU (2.2.1.15.1). */
export const CTRLACTION_REQUEST_CONTROL = 0x0001;
export const CTRLACTION_GRANTED_CONTROL = 0x0002;
export const CTRLACTION_DETACH = 0x0003;
export const CTRLACTION_COOPERATE = 0x0004;

/** Update-Typen im Slowpath (2.2.9.1.1.3). */
export const UPDATETYPE_ORDERS = 0x0000;
export const UPDATETYPE_BITMAP = 0x0001;
export const UPDATETYPE_PALETTE = 0x0002;
export const UPDATETYPE_SYNCHRONIZE = 0x0003;

/** Update-Codes im Fastpath (2.2.9.1.2.1). */
export const FASTPATH_UPDATETYPE_ORDERS = 0x0;
export const FASTPATH_UPDATETYPE_BITMAP = 0x1;
export const FASTPATH_UPDATETYPE_PALETTE = 0x2;
export const FASTPATH_UPDATETYPE_SYNCHRONIZE = 0x3;
export const FASTPATH_UPDATETYPE_SURFCMDS = 0x4;
export const FASTPATH_UPDATETYPE_PTR_NULL = 0x5;
export const FASTPATH_UPDATETYPE_PTR_DEFAULT = 0x6;
export const FASTPATH_UPDATETYPE_PTR_POSITION = 0x8;
export const FASTPATH_UPDATETYPE_COLOR = 0x9;
export const FASTPATH_UPDATETYPE_CACHED = 0xa;
export const FASTPATH_UPDATETYPE_POINTER = 0xb;

export const FASTPATH_FRAGMENT_SINGLE = 0x0;
export const FASTPATH_FRAGMENT_LAST = 0x1;
export const FASTPATH_FRAGMENT_FIRST = 0x2;
export const FASTPATH_FRAGMENT_NEXT = 0x3;

export const FASTPATH_OUTPUT_COMPRESSION_USED = 0x2;

/** Pointer-Update-Typen im Slowpath (2.2.9.1.1.4). */
export const PTRMSGTYPE_SYSTEM = 0x0001;
export const PTRMSGTYPE_POSITION = 0x0003;
export const PTRMSGTYPE_COLOR = 0x0006;
export const PTRMSGTYPE_CACHED = 0x0007;
export const PTRMSGTYPE_POINTER = 0x0008;

/** Eingabe-Ereignistypen (2.2.8.1.1.3.1.1). */
export const INPUT_EVENT_SYNC = 0x0000;
export const INPUT_EVENT_UNUSED = 0x0002;
export const INPUT_EVENT_SCANCODE = 0x0004;
export const INPUT_EVENT_UNICODE = 0x0005;
export const INPUT_EVENT_MOUSE = 0x8001;
export const INPUT_EVENT_MOUSEX = 0x8002;

export const KBDFLAGS_EXTENDED = 0x0100;
export const KBDFLAGS_DOWN = 0x4000;
export const KBDFLAGS_RELEASE = 0x8000;

export const PTRFLAGS_HWHEEL = 0x0400;
export const PTRFLAGS_WHEEL = 0x0200;
export const PTRFLAGS_WHEEL_NEGATIVE = 0x0100;
export const PTRFLAGS_MOVE = 0x0800;
export const PTRFLAGS_DOWN = 0x8000;
export const PTRFLAGS_BUTTON1 = 0x1000;
export const PTRFLAGS_BUTTON2 = 0x2000;
export const PTRFLAGS_BUTTON3 = 0x4000;
export const PTRXFLAGS_BUTTON1 = 0x0001;
export const PTRXFLAGS_BUTTON2 = 0x0002;

/** Bitmap-Flags in TS_BITMAP_DATA (2.2.9.1.1.3.1.2.2). */
export const BITMAP_COMPRESSION = 0x0001;
export const NO_BITMAP_COMPRESSION_HDR = 0x0400;

/** Feste Kanal-IDs. */
export const MCS_GLOBAL_CHANNEL = 1003;
export const MCS_USERCHANNEL_BASE = 1001;
