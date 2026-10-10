/**
 * Mehrere Monitore: welches Panel zeigt welchen Teil des Desktops?
 *
 * Der Server kennt nur einen Desktop. Mit mehreren Monitoren ist der so breit
 * wie alle nebeneinander, und jedes Panel zeigt seinen Ausschnitt davon. Hier
 * steht die reine Rechnung dazu - ohne `vscode`, damit sie sich ohne Editor
 * pruefen laesst.
 */

/** Ein Rechteck in Desktopkoordinaten. */
export interface Bereich {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** TS_MONITOR_DEF, rechte und untere Kante inklusive. */
export interface ServerMonitor {
  left: number;
  top: number;
  right: number;
  bottom: number;
  flags: number;
}

/** TS_MONITOR_PRIMARY (MS-RDPBCGR 2.2.1.3.6.1). */
const MONITOR_PRIMAER = 0x00000001;

/**
 * Die Bereiche, die der Server tatsaechlich eingerichtet hat - der primaere
 * zuerst, die uebrigen von links nach rechts.
 *
 * Nennt der Server seine Monitore (RESETGRAPHICS der Graphics Pipeline), gilt
 * diese Liste. Ihre Koordinaten sind relativ zum primaeren Monitor und duerfen
 * negativ sein; der Desktop beginnt an der linken oberen Ecke aller Monitore.
 *
 * Ohne Liste (klassischer Weg) bleibt nur die eigene Anfrage. Ihr wird nur
 * geglaubt, wenn die Gesamtbreite passt - sonst hat der Server die Anordnung
 * nicht uebernommen, und der ganze Desktop gehoert dem primaeren Panel.
 */
export function bereicheAusServer(
  width: number,
  height: number,
  monitore: readonly ServerMonitor[] | undefined,
  angefragt: ReadonlyArray<{ width: number; height: number }>,
): Bereich[] {
  if (monitore && monitore.length > 0) {
    const minX = Math.min(...monitore.map((m) => m.left));
    const minY = Math.min(...monitore.map((m) => m.top));
    const bereiche = monitore.map((m) => ({
      primaer: (m.flags & MONITOR_PRIMAER) !== 0,
      bereich: { x: m.left - minX, y: m.top - minY, width: m.right - m.left + 1, height: m.bottom - m.top + 1 },
    }));
    const primaerIndex = Math.max(0, bereiche.findIndex((b) => b.primaer));
    const primaer = bereiche[primaerIndex]!.bereich;
    const uebrige = bereiche
      .filter((_, i) => i !== primaerIndex)
      .map((b) => b.bereich)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    return [primaer, ...uebrige];
  }

  if (angefragt.length > 1) {
    let x = 0;
    const bereiche = angefragt.map((g) => {
      // Dieselbe Begradigung wie beim Senden: die Breite ist gerade.
      const breite = g.width - (g.width % 2);
      const b = { x, y: 0, width: breite, height: g.height };
      x += breite;
      return b;
    });
    const hoehe = Math.max(...bereiche.map((b) => b.height));
    if (x === width && hoehe === height) return bereiche;
  }
  return [{ x: 0, y: 0, width, height }];
}

/** Ueberschneiden sich Kachel und Bereich? */
export function schneidet(kachel: { x: number; y: number; w: number; h: number }, bereich: Bereich): boolean {
  return (
    kachel.x < bereich.x + bereich.width &&
    kachel.x + kachel.w > bereich.x &&
    kachel.y < bereich.y + bereich.height &&
    kachel.y + kachel.h > bereich.y
  );
}
