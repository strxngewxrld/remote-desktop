/**
 * Abbildung von DOM-`KeyboardEvent.code` auf PC/AT-Scancodes (Set 1).
 *
 * RDP uebertraegt Scancodes, keine Zeichen: die Umsetzung auf Zeichen macht der
 * Server anhand seines eigenen Tastaturlayouts. `code` ist dafuer genau richtig,
 * weil es die physische Taste bezeichnet und nicht das erzeugte Zeichen.
 *
 * Tasten mit `extended: true` werden auf dem Draht mit dem E0-Praefix markiert.
 */

export interface ScancodeMapping {
  code: number;
  extended?: boolean;
}

export const SCANCODES: Record<string, ScancodeMapping> = {
  Escape: { code: 0x01 },
  Digit1: { code: 0x02 },
  Digit2: { code: 0x03 },
  Digit3: { code: 0x04 },
  Digit4: { code: 0x05 },
  Digit5: { code: 0x06 },
  Digit6: { code: 0x07 },
  Digit7: { code: 0x08 },
  Digit8: { code: 0x09 },
  Digit9: { code: 0x0a },
  Digit0: { code: 0x0b },
  Minus: { code: 0x0c },
  Equal: { code: 0x0d },
  Backspace: { code: 0x0e },
  Tab: { code: 0x0f },
  KeyQ: { code: 0x10 },
  KeyW: { code: 0x11 },
  KeyE: { code: 0x12 },
  KeyR: { code: 0x13 },
  KeyT: { code: 0x14 },
  KeyY: { code: 0x15 },
  KeyU: { code: 0x16 },
  KeyI: { code: 0x17 },
  KeyO: { code: 0x18 },
  KeyP: { code: 0x19 },
  BracketLeft: { code: 0x1a },
  BracketRight: { code: 0x1b },
  Enter: { code: 0x1c },
  ControlLeft: { code: 0x1d },
  KeyA: { code: 0x1e },
  KeyS: { code: 0x1f },
  KeyD: { code: 0x20 },
  KeyF: { code: 0x21 },
  KeyG: { code: 0x22 },
  KeyH: { code: 0x23 },
  KeyJ: { code: 0x24 },
  KeyK: { code: 0x25 },
  KeyL: { code: 0x26 },
  Semicolon: { code: 0x27 },
  Quote: { code: 0x28 },
  Backquote: { code: 0x29 },
  ShiftLeft: { code: 0x2a },
  Backslash: { code: 0x2b },
  KeyZ: { code: 0x2c },
  KeyX: { code: 0x2d },
  KeyC: { code: 0x2e },
  KeyV: { code: 0x2f },
  KeyB: { code: 0x30 },
  KeyN: { code: 0x31 },
  KeyM: { code: 0x32 },
  Comma: { code: 0x33 },
  Period: { code: 0x34 },
  Slash: { code: 0x35 },
  ShiftRight: { code: 0x36 },
  NumpadMultiply: { code: 0x37 },
  AltLeft: { code: 0x38 },
  Space: { code: 0x39 },
  CapsLock: { code: 0x3a },
  F1: { code: 0x3b },
  F2: { code: 0x3c },
  F3: { code: 0x3d },
  F4: { code: 0x3e },
  F5: { code: 0x3f },
  F6: { code: 0x40 },
  F7: { code: 0x41 },
  F8: { code: 0x42 },
  F9: { code: 0x43 },
  F10: { code: 0x44 },
  NumLock: { code: 0x45 },
  ScrollLock: { code: 0x46 },
  Numpad7: { code: 0x47 },
  Numpad8: { code: 0x48 },
  Numpad9: { code: 0x49 },
  NumpadSubtract: { code: 0x4a },
  Numpad4: { code: 0x4b },
  Numpad5: { code: 0x4c },
  Numpad6: { code: 0x4d },
  NumpadAdd: { code: 0x4e },
  Numpad1: { code: 0x4f },
  Numpad2: { code: 0x50 },
  Numpad3: { code: 0x51 },
  Numpad0: { code: 0x52 },
  NumpadDecimal: { code: 0x53 },
  // Die Taste links neben Y auf deutschen Tastaturen (ISO-Sondertaste).
  IntlBackslash: { code: 0x56 },
  F11: { code: 0x57 },
  F12: { code: 0x58 },
  // Japanische/ISO-Zusatztasten
  IntlRo: { code: 0x73 },
  IntlYen: { code: 0x7d },

  // Erweiterte Tasten (E0-Praefix)
  NumpadEnter: { code: 0x1c, extended: true },
  ControlRight: { code: 0x1d, extended: true },
  NumpadDivide: { code: 0x35, extended: true },
  PrintScreen: { code: 0x37, extended: true },
  AltRight: { code: 0x38, extended: true },
  Home: { code: 0x47, extended: true },
  ArrowUp: { code: 0x48, extended: true },
  PageUp: { code: 0x49, extended: true },
  ArrowLeft: { code: 0x4b, extended: true },
  ArrowRight: { code: 0x4d, extended: true },
  End: { code: 0x4f, extended: true },
  ArrowDown: { code: 0x50, extended: true },
  PageDown: { code: 0x51, extended: true },
  Insert: { code: 0x52, extended: true },
  Delete: { code: 0x53, extended: true },
  MetaLeft: { code: 0x5b, extended: true },
  OSLeft: { code: 0x5b, extended: true },
  MetaRight: { code: 0x5c, extended: true },
  OSRight: { code: 0x5c, extended: true },
  ContextMenu: { code: 0x5d, extended: true },
  Pause: { code: 0x45 },
};

export function lookupScancode(domCode: string): ScancodeMapping | undefined {
  return SCANCODES[domCode];
}

/** Flags fuer das Sync-Ereignis (Feststelltasten). */
export const SYNC_SCROLL_LOCK = 0x00000001;
export const SYNC_NUM_LOCK = 0x00000002;
export const SYNC_CAPS_LOCK = 0x00000004;
export const SYNC_KANA_LOCK = 0x00000008;
