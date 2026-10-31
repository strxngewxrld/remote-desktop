import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { cliprdr } from 'ts-rdp';

type Quelle = cliprdr.ClipboardFileSource;

export interface LokaleDateien {
  quellen: Quelle[];
  /** Symlinks, Sockets, Geraete u. Ae. - werden nie gefolgt und nicht uebertragen. */
  uebersprungen: string[];
  /** Summe der Dateigroessen in Byte. */
  gesamtBytes: number;
}
export interface SammelGrenzen { maxBytes: number; maxEintraege?: number }

/** Mehr Ebenen als Windows mit 259 Zeichen Pfad je zulaesst - schuetzt vor endloser Rekursion. */
const MAX_TIEFE = 64;

/** Liest `length` Byte ab `offset` frisch aus der Datei; Symlinks werden dabei nicht aufgeloest. */
function leser(pfad: string): Quelle['read'] {
  return async (offset, length) => {
    const handle = await open(pfad, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const puffer = Buffer.allocUnsafe(length);
      let gelesen = 0;
      while (gelesen < length) {
        const { bytesRead } = await handle.read(puffer, gelesen, length - gelesen, offset + gelesen);
        if (!bytesRead) break;
        gelesen += bytesRead;
      }
      return puffer.subarray(0, gelesen);
    } finally { await handle.close(); }
  };
}

/**
 * Dateien und Ordner der lokalen Pasteboard fuer das Anbieten sammeln:
 * rekursiv, Elternordner vor Kindern, Groesse und mtime aus `lstat`, Inhalt
 * erst beim Lesen. Symlinks werden uebersprungen, nie verfolgt.
 */
export async function sammleLokaleDateien(pfade: readonly string[], grenzen: SammelGrenzen): Promise<LokaleDateien> {
  const maxEintraege = grenzen.maxEintraege ?? 4096;
  const ergebnis: LokaleDateien = { quellen: [], uebersprungen: [], gesamtBytes: 0 };
  const namen = new Set<string>();

  const eintrag = (quelle: Quelle) => {
    const schluessel = quelle.name.toLowerCase();
    if (namen.has(schluessel)) throw new Error(`Doppelter Name in der Zwischenablage: ${quelle.name}`);
    namen.add(schluessel);
    if (ergebnis.quellen.length >= maxEintraege) throw new Error(`Mehr als ${maxEintraege} Dateien und Ordner - zu viele für die Zwischenablage.`);
    ergebnis.quellen.push(quelle);
  };

  const besuche = async (pfad: string, name: string, tiefe: number): Promise<void> => {
    const info = await lstat(pfad);
    if (info.isDirectory()) {
      if (tiefe >= MAX_TIEFE) throw new Error('Ordnerstruktur ist zu tief.');
      eintrag({ name, directory: true, size: 0, lastWriteTime: info.mtime, read: async () => Buffer.alloc(0) });
      // Sortiert, damit die Reihenfolge reproduzierbar ist.
      for (const kind of (await readdir(pfad)).sort()) await besuche(join(pfad, kind), `${name}/${kind.normalize('NFC')}`, tiefe + 1);
    } else if (info.isFile()) {
      ergebnis.gesamtBytes += info.size;
      if (ergebnis.gesamtBytes > grenzen.maxBytes) throw new Error('Die Dateien überschreiten die Clipboard-Größenbegrenzung (rdp.clipboard.maxFileSizeMb).');
      eintrag({ name, size: info.size, lastWriteTime: info.mtime, read: leser(pfad) });
    } else {
      ergebnis.uebersprungen.push(pfad);
    }
  };

  for (const pfad of pfade) await besuche(pfad, basename(pfad).normalize('NFC'), 0);
  return ergebnis;
}
