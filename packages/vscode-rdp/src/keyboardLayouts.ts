/**
 * Windows-Tastaturlayout-IDs. Der Server benutzt die ID, um Scancodes auf
 * Zeichen abzubilden - sie muss also zur physischen Tastatur des Nutzers passen.
 */
export const KEYBOARD_LAYOUTS: Record<string, number> = {
  'de-DE': 0x00000407,
  'de-CH': 0x00000807,
  'de-AT': 0x00000c07,
  'en-US': 0x00000409,
  'en-GB': 0x00000809,
  'fr-FR': 0x0000040c,
  'fr-CH': 0x0000100c,
  'es-ES': 0x0000040a,
  'it-IT': 0x00000410,
  'pt-BR': 0x00000416,
  'nl-NL': 0x00000413,
  'sv-SE': 0x0000041d,
  'da-DK': 0x00000406,
  'nb-NO': 0x00000414,
  'fi-FI': 0x0000040b,
  'pl-PL': 0x00000415,
  'cs-CZ': 0x00000405,
  'hu-HU': 0x0000040e,
  'ru-RU': 0x00000419,
  'tr-TR': 0x0000041f,
  'ja-JP': 0x00000411,
  'ko-KR': 0x00000412,
  'zh-CN': 0x00000804,
};

/** Akzeptiert sowohl "de-DE" als auch "0x407" oder "1031". */
export function resolveKeyboardLayout(value: string | undefined, fallback = 'de-DE'): number {
  const candidate = value?.trim() || fallback;
  const known = KEYBOARD_LAYOUTS[candidate];
  if (known !== undefined) return known;
  const numeric = candidate.startsWith('0x') ? parseInt(candidate, 16) : Number(candidate);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return KEYBOARD_LAYOUTS[fallback] ?? 0x00000409;
}
