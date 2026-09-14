/**
 * Farbkennung einer Verbindung oder eines Ordners.
 *
 * Der Zweck ist nicht Schmuck, sondern Irrtumsvermeidung: wer gleichzeitig auf
 * einem Produktions- und einem Testserver arbeitet, soll am Rahmen sehen, in
 * welchem Fenster er gerade tippt. Deshalb sind es benannte Farben und kein
 * freies Hexfeld - eine Handvoll klar unterscheidbarer Kennungen nuetzt mehr
 * als 16 Millionen Abstufungen, von denen zwei nebeneinander gleich aussehen.
 *
 * ## Wo die Farbe ueberhaupt ankommt
 *
 * Die Erweiterungs-API von VS Code laesst einen *einzelnen Editor-Tab* nicht
 * einfaerben: `vscode.Tab` (window.tabGroups) ist vollstaendig schreibgeschuetzt
 * und kennt kein Farbfeld, und `workbench.colorCustomizations` wirkt auf alle
 * Tabs zugleich. Was geht, ist:
 *
 *  - ein farbiger Emoji-Kreis direkt im **Titel** des Webview-Panels,
 *    unabhängig von der Sichtbarkeit der Tab-Symbole,
 *  - ein farbiger **Rahmen** um die Sitzungsflaeche im Webview,
 *  - die **Vordergrundfarbe** des Statusleisteneintrags
 *    (`StatusBarItem.color` nimmt `string | ThemeColor`; `backgroundColor`
 *    dagegen nur `statusBarItem.errorBackground`/`warningBackground`),
 *  - das **Symbol in der Baumansicht** (`TreeItem.iconPath` als `ThemeIcon`
 *    mit `ThemeColor` - laut API-Dokumentation wird `ThemeIcon.color`
 *    ausschliesslich dort ausgewertet).
 *
 * Daraus ergeben sich die beiden Farbwerte je Eintrag: `themeFarbe` fuer
 * alles, was VS Code selbst zeichnet (und was ein Theme uebersteuern darf),
 * `hex` fuer alles, was wir selbst malen - Rahmen im Webview und Panelsymbol.
 */

export type FarbName = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';

/** Im Titel sichtbar, auch wenn VS Code Tab-Symbole ausblendet. Graue Kennung: neutraler Kreis. */
export function farbigerTabTitel(titel: string, name: FarbName | undefined): string {
  const punkte: Record<FarbName, string> = { red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢', blue: '🔵', purple: '🟣', gray: '⚪' };
  return name && istFarbName(name) ? `${punkte[name]} ${titel}` : titel;
}

export interface Farbe {
  /** Klarname in der Auswahlliste. */
  titel: string;
  /** Vorschlag, wofuer man sie nimmt - steht als Detailzeile in der Auswahl. */
  beschreibung: string;
  /**
   * Von der Extension beigetragener Theme-Farbschluessel (`contributes.colors`
   * im Manifest). Nur so darf ein Theme die Farbe anpassen, und nur
   * registrierte Schluessel zeichnet VS Code ueberhaupt.
   */
  themeFarbe: string;
  /** Fester Farbwert fuer Rahmen und Panelsymbol, die wir selbst zeichnen. */
  hex: string;
}

export const FARBEN: Record<FarbName, Farbe> = {
  red: {
    titel: 'Rot',
    beschreibung: 'Für Produktivsysteme: hier tut ein Fehlgriff weh.',
    themeFarbe: 'rdp.color.red',
    hex: '#e51400',
  },
  orange: {
    titel: 'Orange',
    beschreibung: 'Für Abnahme- und Vorproduktionssysteme.',
    themeFarbe: 'rdp.color.orange',
    hex: '#f07d00',
  },
  yellow: {
    titel: 'Gelb',
    beschreibung: 'Für Systeme, an denen gerade gearbeitet wird.',
    themeFarbe: 'rdp.color.yellow',
    hex: '#d9b400',
  },
  green: {
    titel: 'Grün',
    beschreibung: 'Für Test- und Entwicklungssysteme.',
    themeFarbe: 'rdp.color.green',
    hex: '#2d9d3a',
  },
  blue: {
    titel: 'Blau',
    beschreibung: 'Für interne Dienste und Verwaltungssysteme.',
    themeFarbe: 'rdp.color.blue',
    hex: '#0a84d8',
  },
  purple: {
    titel: 'Violett',
    beschreibung: 'Für Kundenumgebungen und Fremdnetze.',
    themeFarbe: 'rdp.color.purple',
    hex: '#9a4dd4',
  },
  gray: {
    titel: 'Grau',
    beschreibung: 'Unauffällig - für alles ohne besondere Bedeutung.',
    themeFarbe: 'rdp.color.gray',
    hex: '#8a8a8a',
  },
};

/** Die Farbnamen in der Reihenfolge "gefährlich zuerst". */
export const FARB_NAMEN: FarbName[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

/** Ist der Wert einer der bekannten Farbnamen? */
export function istFarbName(wert: unknown): wert is FarbName {
  return typeof wert === 'string' && (FARB_NAMEN as string[]).includes(wert);
}

/** Die Farbe zu einem Namen, oder `undefined` bei unbekanntem Namen. */
export function farbe(name: FarbName | undefined): Farbe | undefined {
  return name && FARBEN[name] ? FARBEN[name] : undefined;
}

/**
 * Das Panelsymbol in der gewuenschten Farbe.
 *
 * Warum ueberhaupt selbst gezeichnet: `WebviewPanel.iconPath` nimmt zwar auch
 * einen `ThemeIcon`, aber dessen `color` wertet VS Code nach eigener Angabe
 * nur im `TreeItem` aus. Ein Panelsymbol laesst sich also nur einfaerben,
 * indem man ihm eine SVG-Datei gibt, in der die Farbe schon drinsteht.
 *
 * Ein gefüllter Punkt bleibt auch bei schmalen Tabs gut erkennbar.
 */
export function symbolSvg(hex: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"',
    ` stroke="${hex}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`,
    `<circle cx="12" cy="12" r="7" fill="${hex}"/>`,
    '</svg>',
  ].join('');
}

/** Dateiname des erzeugten Symbols - je Farbe genau einer. */
export function symbolDateiname(name: FarbName): string {
  return `rdp-${name}.svg`;
}
