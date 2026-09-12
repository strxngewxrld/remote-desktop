/**
 * Exponentieller Rueckzug mit Streuung.
 *
 * Nach einem Verbindungsverlust sofort und im Takt neu zu verbinden ist gleich
 * doppelt schaedlich: der Server bekommt die Last einer Schleife, und viele
 * Clients, die dieselbe Stoerung erlebt haben, klopfen im Gleichschritt an.
 * Die Wartezeit waechst deshalb mit jedem Versuch und bekommt obendrein eine
 * Streuung, die den Gleichschritt bricht.
 */

export interface BackoffOptions {
  /** Wartezeit vor dem ersten Versuch. */
  initialDelayMs: number;
  /** Obergrenze; hoeher geht die Wartezeit nie, auch mit Streuung nicht. */
  maxDelayMs: number;
  /** Wachstumsfaktor je Versuch. */
  factor: number;
  /** Streuung als Anteil der Wartezeit, 0..1. 0 schaltet sie ab. */
  jitter: number;
}

/**
 * Voreinstellung: 1 s, 2 s, 4 s, 8 s, 16 s, dann 30 s - jeweils plus/minus
 * ein Viertel. Damit sind fuenf Versuche in gut einer halben Minute erledigt,
 * was eine kurze Netzstoerung ueberbrueckt, ohne einen dauerhaft toten Server
 * endlos anzurufen.
 */
export const STANDARD_BACKOFF: BackoffOptions = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitter: 0.25,
};

/**
 * Wartezeit vor dem `versuch`-ten Anlauf; `versuch` zaehlt ab 1.
 *
 * Die Zufallsquelle ist einsetzbar, damit die Folge im Test nachrechenbar
 * bleibt - `Math.random` liefert Werte in [0,1), und 0.5 bedeutet hier "keine
 * Abweichung".
 */
export function backoffWartezeit(
  versuch: number,
  o: BackoffOptions = STANDARD_BACKOFF,
  zufall: () => number = Math.random,
): number {
  if (versuch < 1) throw new RangeError(`Versuchsnummer zaehlt ab 1, nicht ${versuch}`);
  const gewachsen = o.initialDelayMs * Math.pow(o.factor, versuch - 1);
  // Zuerst deckeln, dann streuen: sonst laege die Streuung um einen Wert
  // herum, den die Obergrenze laengst verboten hat.
  const basis = Math.min(gewachsen, o.maxDelayMs);
  if (o.jitter <= 0) return Math.round(basis);
  const abweichung = basis * o.jitter * (2 * zufall() - 1);
  return Math.round(Math.min(Math.max(basis + abweichung, 0), o.maxDelayMs));
}
