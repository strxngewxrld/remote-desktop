/**
 * Die Bruecke von `arbeitsbereich.ts` zu VS Code.
 *
 * Hier - und nur hier - wird aus einem Ordnerindex und geprueften
 * Pfadsegmenten eine `vscode.Uri`. Das Zusammensetzen laeuft ueber
 * `vscode.Uri.joinPath`, die einzige API, die dabei auch entfernte Schemata
 * (`vscode-remote://ssh-remote+host/...`) richtig behandelt.
 *
 * `node:fs` kommt hier nicht vor und darf es nicht: unter Remote-SSH laeuft
 * die Extension auf dem entfernten Rechner, und die Ordner des
 * Arbeitsbereichs sind dort keine gewoehnlichen lokalen Pfade. `workspace.fs`
 * geht ueber den Dateisystemanbieter von VS Code und trifft in beiden Faellen
 * das Richtige.
 */
import * as vscode from 'vscode';
import type { ArbeitsbereichZugriff, DateiAngabe, EintragsArt } from './arbeitsbereich.js';

/** `vscode.FileType` in unsere drei Arten uebersetzen. */
function art(typ: vscode.FileType): EintragsArt {
  if ((typ & vscode.FileType.SymbolicLink) !== 0) return 'anderes';
  if ((typ & vscode.FileType.Directory) !== 0) return 'verzeichnis';
  if ((typ & vscode.FileType.File) !== 0) return 'datei';
  return 'anderes';
}

/**
 * Der Zugriff auf den laufenden Arbeitsbereich.
 *
 * Die Ordnerliste wird bei jedem Aufruf frisch geholt, nicht beim Bauen
 * eingefroren. Das ist der Grund, warum ein Ordner, der waehrend der Sitzung
 * zum Arbeitsbereich dazukommt, bei der naechsten Verzeichnisabfrage von
 * selbst im Explorer auftaucht.
 */
export function vscodeArbeitsbereichZugriff(): ArbeitsbereichZugriff {
  const ordnerListe = (): readonly vscode.WorkspaceFolder[] => vscode.workspace.workspaceFolders ?? [];

  const uri = (ordner: number, segmente: readonly string[]): vscode.Uri => {
    const basis = ordnerListe()[ordner];
    if (!basis) throw new Error(`Arbeitsbereichsordner ${ordner} gibt es nicht mehr`);
    // Ein leeres Segmentfeld ergibt die Basis selbst; joinPath kommt damit
    // zurecht.
    return segmente.length === 0 ? basis.uri : vscode.Uri.joinPath(basis.uri, ...segmente);
  };

  const gepruefteUri = async (ordner: number, segmente: readonly string[], darfFehlen = false): Promise<vscode.Uri> => {
    const basis = uri(ordner, []);
    for (let i = 0; i < segmente.length; i++) {
      const segment = segmente[i]!;
      if (!segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)) throw new Error('Ungültiger Pfad');
      try {
        const info = await vscode.workspace.fs.stat(vscode.Uri.joinPath(basis, ...segmente.slice(0, i + 1)));
        if ((info.type & vscode.FileType.SymbolicLink) !== 0) throw new Error('Laufwerk: symbolische Links werden nicht freigegeben');
      } catch (error) {
        if (!darfFehlen || (error as { code?: string }).code !== 'FileNotFound') throw error;
        // Auch die noch fehlenden Segmente müssen syntaktisch geprüft werden.
      }
    }
    if (uri(ordner, []).toString() !== basis.toString()) throw new Error('Arbeitsbereich wurde während des Zugriffs geändert');
    return segmente.length ? vscode.Uri.joinPath(basis, ...segmente) : basis;
  };

  return {
    ordnernamen: () => ordnerListe().map((o) => o.name),
    ordnerkennung: ordner => uri(ordner, []).toString(),

    async stat(ordner, segmente): Promise<DateiAngabe | undefined> {
      const angabe = await vscode.workspace.fs.stat(await gepruefteUri(ordner, segmente));
      return {
        art: art(angabe.type),
        groesse: angabe.size,
        // ctime und mtime sind in VS Code Millisekunden seit der Unix-Epoche -
        // genau das, was DateiEintrag erwartet.
        erstellt: angabe.ctime,
        geaendert: angabe.mtime,
      };
    },

    async liste(ordner, segmente) {
      const eintraege = await vscode.workspace.fs.readDirectory(await gepruefteUri(ordner, segmente));
      return eintraege.filter(([, typ]) => (typ & vscode.FileType.SymbolicLink) === 0).map(([name, typ]) => ({ name, art: art(typ) }));
    },

    liesDatei: async (ordner, segmente) => vscode.workspace.fs.readFile(await gepruefteUri(ordner, segmente)),

    schreibeDatei: async (ordner, segmente, daten) =>
      vscode.workspace.fs.writeFile(await gepruefteUri(ordner, segmente, true), daten),

    erzeugeVerzeichnis: async (ordner, segmente) =>
      vscode.workspace.fs.createDirectory(await gepruefteUri(ordner, segmente, true)),

    loesche: async (ordner, segmente, rekursiv) =>
      Promise.resolve(
        // useTrash: der Papierkorb ist hier richtig. Wer im Explorer der
        // RDP-Sitzung aus Versehen etwas loescht, loescht Quelltext auf dem
        // eigenen Rechner - ein Weg zurueck gehoert dazu.
        vscode.workspace.fs.delete(await gepruefteUri(ordner, segmente), { recursive: rekursiv, useTrash: true }),
      ),

    benenneUm: async (ordner, von, nachOrdner, nach, ueberschreiben) =>
      Promise.resolve(
        vscode.workspace.fs.rename(await gepruefteUri(ordner, von), await gepruefteUri(nachOrdner, nach, true), { overwrite: ueberschreiben }),
      ),
  };
}

// ------------------------------------------------------------- Rueckfrage

/** Schluessel im globalState, unter dem die Antworten liegen. */
export const FREIGABE_SCHLUESSEL = 'rdp.driveRedirection.freigaben';

/** Gemerkte Antwort je Ziel. */
export type FreigabeAntwort = 'erlaubt' | 'erlaubt-schreiben' | 'verweigert';

/** Die gemerkten Antworten lesen. */
export function gemerkteFreigaben(context: vscode.ExtensionContext): Record<string, FreigabeAntwort> {
  return context.globalState.get<Record<string, FreigabeAntwort>>(FREIGABE_SCHLUESSEL) ?? {};
}

/**
 * Beim ersten Mal je Verbindung nachfragen, ob die Ordner freigegeben werden.
 *
 * Die Antwort wird gemerkt - in beide Richtungen. Wer einmal "Nicht
 * freigeben" gesagt hat, soll nicht bei jedem Verbinden erneut gefragt
 * werden; das ist der sicherste Weg, dass jemand irgendwann aus Gewohnheit
 * auf "Freigeben" klickt.
 *
 * `ziel` ist "host:port". Absichtlich nicht der Anzeigename der Verbindung:
 * den kann man umbenennen, und dann waere die Zustimmung stillschweigend auf
 * einen anderen Server uebergegangen.
 */
export async function frageFreigabe(
  context: vscode.ExtensionContext,
  ziel: string,
  ordnernamen: readonly string[],
  nurLesen: boolean,
): Promise<boolean> {
  const gemerkt = gemerkteFreigaben(context);
  const bekannt = gemerkt[ziel];
  // Historische Zustimmungen enthalten keine Rechte: niemals stillschweigend erweitern.
  if (bekannt === 'erlaubt-schreiben' || (bekannt === 'erlaubt' && nurLesen)) return true;
  if (bekannt === 'verweigert') return false;

  const liste =
    ordnernamen.length <= 3
      ? ordnernamen.join(', ')
      : `${ordnernamen.slice(0, 3).join(', ')} und ${ordnernamen.length - 3} weitere`;
  const rechte = nurLesen ? 'nur lesen' : 'lesen und schreiben';

  const antwort = await vscode.window.showWarningMessage(
    `Sollen die Ordner des Arbeitsbereichs (${liste}) auf ${ziel} im Explorer eingeblendet werden? ` +
      `Der Server kann sie dann ${rechte}.`,
    { modal: true },
    'Freigeben',
    'Nur dieses Mal',
    'Nicht freigeben',
  );

  if (antwort === 'Freigeben') {
    await context.globalState.update(FREIGABE_SCHLUESSEL, { ...gemerkteFreigaben(context), [ziel]: nurLesen ? 'erlaubt' : 'erlaubt-schreiben' });
    return true;
  }
  if (antwort === 'Nur dieses Mal') return true;
  if (antwort === 'Nicht freigeben') {
    await context.globalState.update(FREIGABE_SCHLUESSEL, { ...gemerkteFreigaben(context), [ziel]: 'verweigert' });
    return false;
  }
  // Escape oder Abbruch: diesmal nichts freigeben, aber auch nichts merken.
  return false;
}

/** Alle gemerkten Antworten vergessen - fuer den Befehl in der Befehlspalette. */
export async function vergissFreigaben(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(FREIGABE_SCHLUESSEL, undefined);
}
