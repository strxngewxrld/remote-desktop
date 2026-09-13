/**
 * Der Arbeitsbereich als umgeleitetes Laufwerk.
 *
 * `arbeitsbereich.ts` importiert `vscode` nicht, deshalb braucht dieser Test
 * keine Attrappe des Editors - nur eine des schmalen Zugriffs, den
 * `session.ts` sonst fuellt. Die Attrappe merkt sich jeden Zugriff; so faellt
 * auf, wenn ein ausgeschlossener oder ausgebrochener Pfad doch durchkommt.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  ArbeitsbereichDateisystem,
  AUSSCHLUSS_VORGABEN,
  LAUFWERK_EINSTELLUNGEN,
  LAUFWERK_VORGABEN,
  alsRdpdrDateisystem,
  baueAusschluss,
  baueLaufwerk,
  eindeutigeOrdnernamen,
  leseEinstellungen,
  type ArbeitsbereichZugriff,
  type DateiAngabe,
  type EintragsArt,
  type LaufwerkEinstellungen,
} from '../src/arbeitsbereich.js';

// ------------------------------------------------------------- Attrappe

/**
 * Ein Arbeitsbereich im Arbeitsspeicher.
 *
 * Der Inhalt steht als flache Abbildung "ordner|a/b/c" -> Text drin;
 * `null` heisst Verzeichnis.
 */
class Attrappe implements ArbeitsbereichZugriff {
  readonly zugriffe: string[] = [];
  readonly geschrieben = new Map<string, Uint8Array>();

  constructor(
    private readonly namen: string[],
    private readonly inhalt: Record<string, string | null>,
  ) {}

  ordnernamen(): readonly string[] {
    return this.namen;
  }

  private schluessel(ordner: number, segmente: readonly string[]): string {
    return `${ordner}|${segmente.join('/')}`;
  }

  private merke(ordner: number, segmente: readonly string[]): void {
    this.zugriffe.push(this.schluessel(ordner, segmente));
  }

  async stat(ordner: number, segmente: readonly string[]): Promise<DateiAngabe | undefined> {
    this.merke(ordner, segmente);
    const s = this.schluessel(ordner, segmente);
    if (segmente.length === 0) return { art: 'verzeichnis', groesse: 0, erstellt: 5000, geaendert: 5000 };
    if (!(s in this.inhalt)) throw new Error(`FileNotFound: ${s}`);
    const wert = this.inhalt[s];
    return {
      art: wert === null ? 'verzeichnis' : 'datei',
      groesse: wert === null ? 0 : Buffer.byteLength(wert),
      erstellt: 1000,
      geaendert: 2000,
    };
  }

  async liste(ordner: number, segmente: readonly string[]): Promise<Array<{ name: string; art: EintragsArt }>> {
    this.merke(ordner, segmente);
    const praefix = `${ordner}|${segmente.length ? segmente.join('/') + '/' : ''}`;
    const kinder: Array<{ name: string; art: EintragsArt }> = [];
    for (const [s, wert] of Object.entries(this.inhalt)) {
      if (!s.startsWith(praefix)) continue;
      const rest = s.substring(praefix.length);
      if (rest === '' || rest.includes('/')) continue;
      kinder.push({ name: rest, art: wert === null ? 'verzeichnis' : 'datei' });
    }
    return kinder;
  }

  async liesDatei(ordner: number, segmente: readonly string[]): Promise<Uint8Array> {
    this.merke(ordner, segmente);
    const wert = this.inhalt[this.schluessel(ordner, segmente)];
    if (typeof wert !== 'string') throw new Error('keine Datei');
    return Buffer.from(wert, 'utf8');
  }

  async schreibeDatei(ordner: number, segmente: readonly string[], daten: Uint8Array): Promise<void> {
    const s = this.schluessel(ordner, segmente);
    this.geschrieben.set(s, daten);
    this.inhalt[s] = Buffer.from(daten).toString('utf8');
  }

  async erzeugeVerzeichnis(ordner: number, segmente: readonly string[]): Promise<void> {
    this.inhalt[this.schluessel(ordner, segmente)] = null;
  }

  async loesche(ordner: number, segmente: readonly string[]): Promise<void> {
    delete this.inhalt[this.schluessel(ordner, segmente)];
  }

  async benenneUm(
    ordner: number,
    von: readonly string[],
    nachOrdner: number,
    nach: readonly string[],
  ): Promise<void> {
    const a = this.schluessel(ordner, von);
    const b = this.schluessel(nachOrdner, nach);
    this.inhalt[b] = this.inhalt[a];
    delete this.inhalt[a];
  }
}

function einstellungen(teil: Partial<LaufwerkEinstellungen> = {}): LaufwerkEinstellungen {
  return {
    aktiv: true,
    zugriff: 'readOnly',
    nurLesen: true,
    ausschluss: AUSSCHLUSS_VORGABEN,
    laufwerksname: 'VS Code',
    maxDateigroesse: 64 * 1024 * 1024,
    ...teil,
  };
}

function baue(teil: Partial<LaufwerkEinstellungen> = {}): {
  fs: ArbeitsbereichDateisystem;
  attrappe: Attrappe;
  protokoll: string[];
} {
  const attrappe = new Attrappe(['frontend', 'backend'], {
    '0|src': null,
    '0|src/index.ts': 'export const a = 1;\n',
    '0|README.md': '# Frontend\n',
    '0|.git': null,
    '0|.git/config': '[core]\n',
    '0|.env': 'GEHEIM=1\n',
    '0|node_modules': null,
    '0|schluessel.pem': '-----BEGIN\n',
    '1|main.py': 'print(1)\n',
  });
  const protokoll: string[] = [];
  const fs = new ArbeitsbereichDateisystem({
    zugriff: attrappe,
    einstellungen: einstellungen(teil),
    log: (n) => protokoll.push(n),
  });
  return { fs, attrappe, protokoll };
}

const namenVon = (eintraege: { name: string }[]): string[] => eintraege.map((e) => e.name).sort();

// ---------------------------------------------------------------- Tests

describe('Arbeitsbereich - Einstellungen', () => {
  test('Ohne Angaben gilt Nur-Lesen', () => {
    const e = leseEinstellungen((_s, vorgabe) => vorgabe);
    assert.equal(e.aktiv, true);
    assert.equal(e.zugriff, 'readOnly');
    assert.equal(e.nurLesen, true);
    assert.deepEqual([...e.ausschluss], [...AUSSCHLUSS_VORGABEN]);
  });

  test('Ein unbekannter Zugriffswert faellt auf Nur-Lesen zurueck, nicht auf Schreiben', () => {
    const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.zugriff]: 'alles' };
    const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
    assert.equal(e.nurLesen, true);
  });

  test('"readWrite" schaltet das Schreiben frei', () => {
    const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.zugriff]: 'readWrite' };
    const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
    assert.equal(e.nurLesen, false);
  });

  test('Eine kaputte Ausschlussliste faellt auf die Vorgaben zurueck', () => {
    const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.ausschluss]: 'nicht-array' };
    const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
    assert.deepEqual([...e.ausschluss], [...AUSSCHLUSS_VORGABEN]);
  });

  test('Eine leere Ausschlussliste ist erlaubt - wer will, gibt alles frei', () => {
    const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.ausschluss]: [] };
    const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
    assert.deepEqual([...e.ausschluss], []);
  });

  test('Ein leerer Laufwerksname faellt auf die Vorgabe zurueck', () => {
    const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.laufwerksname]: '   ' };
    const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
    assert.equal(e.laufwerksname, LAUFWERK_VORGABEN.laufwerksname);
  });

  test('Die Groessengrenze wird in Byte gerechnet', () => {
    const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.maxDateigroesseMb]: 8 };
    const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
    assert.equal(e.maxDateigroesse, 8 * 1024 * 1024);
  });

  test('Eine unsinnige Groessengrenze faellt auf die Vorgabe zurueck', () => {
    for (const unsinn of [0, -5, Number.NaN, 'viel']) {
      const werte: Record<string, unknown> = { [LAUFWERK_EINSTELLUNGEN.maxDateigroesseMb]: unsinn };
      const e = leseEinstellungen((s, vorgabe) => (s in werte ? (werte[s] as never) : vorgabe));
      assert.equal(e.maxDateigroesse, LAUFWERK_VORGABEN.maxDateigroesseMb * 1024 * 1024);
    }
  });
});

describe('Arbeitsbereich - Ausschlussmuster', () => {
  const passt = baueAusschluss(AUSSCHLUSS_VORGABEN);

  test('Die Vorgaben treffen .git, node_modules und .env', () => {
    assert.equal(passt(['.git']), true);
    assert.equal(passt(['.git', 'config']), true);
    assert.equal(passt(['node_modules']), true);
    assert.equal(passt(['node_modules', 'paket', 'index.js']), true);
    assert.equal(passt(['.env']), true);
    assert.equal(passt(['.env.local']), true);
    assert.equal(passt(['.env.production']), true);
  });

  test('Ein Muster ohne Schraegstrich trifft jedes Segment, nicht nur das oberste', () => {
    assert.equal(passt(['src', 'fremdes', '.git']), true);
    assert.equal(passt(['a', 'b', 'node_modules', 'c']), true);
  });

  test('Schluesseldateien sind ausgeschlossen', () => {
    assert.equal(passt(['zertifikat.pem']), true);
    assert.equal(passt(['server.key']), true);
    assert.equal(passt(['bundle.pfx']), true);
    assert.equal(passt(['.ssh', 'id_rsa']), true);
    assert.equal(passt(['.npmrc']), true);
  });

  test('Gewoehnlicher Quelltext geht durch', () => {
    assert.equal(passt(['src', 'index.ts']), false);
    assert.equal(passt(['README.md']), false);
    assert.equal(passt(['package.json']), false);
    // ".environment" ist kein ".env" und auch kein ".env.*"
    assert.equal(passt(['.environment']), false);
  });

  test('Gross- und Kleinschreibung schuetzt nicht vor dem Ausschluss', () => {
    assert.equal(passt(['.GIT']), true);
    assert.equal(passt(['Node_Modules']), true);
    assert.equal(passt(['SERVER.KEY']), true);
  });

  test('Ein Muster mit Schraegstrich trifft den ganzen Pfad', () => {
    const eigen = baueAusschluss(['doku/geheim', 'src/*.snap']);
    assert.equal(eigen(['doku', 'geheim']), true);
    assert.equal(eigen(['src', 'a.snap']), true);
    assert.equal(eigen(['anders', 'geheim']), false);
    assert.equal(eigen(['src', 'a.ts']), false);
  });

  test('Rueckstriche im Muster werden wie Schraegstriche gelesen', () => {
    const eigen = baueAusschluss(['doku\\geheim']);
    assert.equal(eigen(['doku', 'geheim']), true);
  });

  test('Eine leere Liste schliesst nichts aus', () => {
    const keiner = baueAusschluss([]);
    assert.equal(keiner(['.git']), false);
  });
});

describe('Arbeitsbereich - Ordnernamen', () => {
  test('Gleiche Namen werden durchnummeriert', () => {
    assert.deepEqual(eindeutigeOrdnernamen(['app', 'app', 'app']), ['app', 'app (2)', 'app (3)']);
  });

  test('Gross- und Kleinschreibung zaehlt dabei als gleich - Windows sieht das so', () => {
    assert.deepEqual(eindeutigeOrdnernamen(['App', 'app']), ['App', 'app (2)']);
  });

  test('Unter Windows verbotene Zeichen werden ersetzt', () => {
    assert.deepEqual(eindeutigeOrdnernamen(['a:b', 'c/d', 'e*f', 'g?h', 'i"j', 'k<l', 'm>n', 'o|p']), [
      'a_b',
      'c_d',
      'e_f',
      'g_h',
      'i_j',
      'k_l',
      'm_n',
      'o_p',
    ]);
  });

  test('Ein Punkt am Ende faellt weg - Windows kann ihn nicht', () => {
    assert.deepEqual(eindeutigeOrdnernamen(['repo.']), ['repo']);
  });

  test('Ein Name, der nur aus verbotenen Zeichen besteht, bekommt einen Ersatz', () => {
    assert.deepEqual(eindeutigeOrdnernamen(['.', '  ']), ['Ordner', 'Ordner (2)']);
  });

  test('Ein leerer Arbeitsbereich ergibt eine leere Liste', () => {
    assert.deepEqual(eindeutigeOrdnernamen([]), []);
  });
});

describe('Arbeitsbereich - Wurzel und Auflistung', () => {
  test('Die Wurzel zeigt je Arbeitsbereichsordner ein Verzeichnis', async () => {
    const { fs } = baue();
    const eintraege = await fs.liste('');
    assert.deepEqual(namenVon(eintraege), ['backend', 'frontend']);
    assert.equal(
      eintraege.every((e) => e.istVerzeichnis),
      true,
    );
  });

  test('Die Wurzel selbst ist ein Verzeichnis', async () => {
    const { fs } = baue();
    const wurzel = await fs.stat('');
    assert.equal(wurzel?.istVerzeichnis, true);
  });

  test('Unter einem Ordner steht sein Inhalt', async () => {
    const { fs } = baue();
    assert.deepEqual(namenVon(await fs.liste('frontend')), ['README.md', 'src']);
    assert.deepEqual(namenVon(await fs.liste('backend')), ['main.py']);
  });

  test('Ausgeschlossene Eintraege fehlen in der Auflistung', async () => {
    const { fs } = baue();
    const namen = namenVon(await fs.liste('frontend'));
    for (const verboten of ['.git', '.env', 'node_modules', 'schluessel.pem']) {
      assert.equal(namen.includes(verboten), false, `${verboten} haette fehlen muessen`);
    }
  });

  test('Ein ausgeschlossener Pfad existiert aus Sicht des Servers gar nicht', async () => {
    const { fs, attrappe } = baue();
    assert.equal(await fs.stat('frontend/.git'), undefined);
    assert.equal(await fs.stat('frontend/.git/config'), undefined);
    assert.equal(await fs.stat('frontend/.env'), undefined);
    // Und das Dateisystem wurde dafuer nicht einmal gefragt.
    assert.equal(
      attrappe.zugriffe.some((z) => z.includes('.git') || z.includes('.env')),
      false,
    );
  });

  test('Ein ausgeschlossener Pfad laesst sich auch nicht lesen', async () => {
    const { fs } = baue();
    assert.deepEqual(await fs.lies('frontend/.env', 0, 100), Buffer.alloc(0));
  });

  test('Ein eigener Ausschluss wirkt statt der Vorgaben', async () => {
    const { fs } = baue({ ausschluss: ['README.md'] });
    const namen = namenVon(await fs.liste('frontend'));
    assert.equal(namen.includes('README.md'), false);
    // Die Vorgaben gelten dann nicht mehr - das ist gewollt und muss auffallen.
    assert.equal(namen.includes('.git'), true);
  });

  test('Ein unbekannter Ordnername ergibt nichts', async () => {
    const { fs } = baue();
    assert.equal(await fs.stat('gibtsnicht'), undefined);
    assert.deepEqual(await fs.liste('gibtsnicht'), []);
  });

  test('Der Ordnername wird ohne Ruecksicht auf Gross- und Kleinschreibung gesucht', async () => {
    const { fs } = baue();
    assert.deepEqual(namenVon(await fs.liste('FRONTEND')), ['README.md', 'src']);
  });

  test('Dateien mit fuehrendem Punkt gelten als versteckt, verschwinden aber nicht', async () => {
    const attrappe = new Attrappe(['repo'], { '0|.gitignore': 'dist\n' });
    const fs = new ArbeitsbereichDateisystem({
      zugriff: attrappe,
      einstellungen: einstellungen({ ausschluss: [] }),
    });
    const eintraege = await fs.liste('repo');
    assert.equal(eintraege.length, 1);
    assert.equal(eintraege[0].name, '.gitignore');
    assert.equal(eintraege[0].versteckt, true);
  });
});

describe('Arbeitsbereich - Pfad-Fluchtversuche werden auch hier abgewiesen', () => {
  for (const boese of ['../geheim', 'frontend/../../etc/passwd', 'frontend/..', '..', 'frontend/./x']) {
    test(`"${boese}" erreicht das Dateisystem nicht`, async () => {
      const { fs, attrappe } = baue();
      attrappe.zugriffe.length = 0;
      assert.equal(await fs.stat(boese), undefined);
      assert.deepEqual(await fs.liste(boese), []);
      assert.deepEqual(await fs.lies(boese, 0, 10), Buffer.alloc(0));
      assert.deepEqual(attrappe.zugriffe, []);
    });
  }

  test('Ein Rueckstrich im Pfad wird abgewiesen, nicht als Trenner gelesen', async () => {
    // Die Protokollschicht liefert nur Schraegstriche. Kommt hier trotzdem ein
    // Rueckstrich an, ist das ein Zeichen dafuer, dass jemand an ihr vorbei
    // gearbeitet hat - dann ist Ablehnen richtig.
    const { fs, attrappe } = baue();
    attrappe.zugriffe.length = 0;
    assert.equal(await fs.stat('frontend\\..\\..\\etc'), undefined);
    assert.deepEqual(attrappe.zugriffe, []);
  });

  test('Ein Nullzeichen im Pfad wird abgewiesen', async () => {
    const { fs, attrappe } = baue();
    attrappe.zugriffe.length = 0;
    assert.equal(await fs.stat('frontend/datei\0.ts'), undefined);
    assert.deepEqual(attrappe.zugriffe, []);
  });

  test('Auch beim Schreiben und Umbenennen wird geprueft', async () => {
    const { fs } = baue({ nurLesen: false, zugriff: 'readWrite' });
    await assert.rejects(() => fs.schreibe('../entfuehrt.txt', 0, Buffer.from('x')));
    await assert.rejects(() => fs.benenneUm('frontend/README.md', '../entfuehrt.md', true));
    await assert.rejects(() => fs.loesche('../wichtig'));
  });

  test('Umbenennen in einen ausgeschlossenen Pfad scheitert', async () => {
    const { fs } = baue({ nurLesen: false, zugriff: 'readWrite' });
    await assert.rejects(() => fs.benenneUm('frontend/README.md', 'frontend/.git/README.md', true));
  });
});

describe('Arbeitsbereich - Lesen', () => {
  test('Eine Datei laesst sich lesen', async () => {
    const { fs } = baue();
    const daten = await fs.lies('frontend/README.md', 0, 4096);
    assert.equal(daten.toString('utf8'), '# Frontend\n');
  });

  test('Ein Ausschnitt wird richtig geschnitten', async () => {
    const { fs } = baue();
    assert.equal((await fs.lies('frontend/README.md', 2, 4)).toString('utf8'), 'Fron');
  });

  test('Aufeinanderfolgende Bloecke lesen die Datei nur einmal', async () => {
    // Sonst wuerde eine 10-MiB-Datei bei 64-KiB-Bloecken 160-mal vollstaendig
    // uebertragen - unter Remote-SSH ueber das Netz.
    const { fs, attrappe } = baue();
    await fs.lies('frontend/src/index.ts', 0, 4);
    const nachErstem = attrappe.zugriffe.filter((z) => z === '0|src/index.ts').length;
    await fs.lies('frontend/src/index.ts', 4, 4);
    await fs.lies('frontend/src/index.ts', 8, 4);
    assert.equal(attrappe.zugriffe.filter((z) => z === '0|src/index.ts').length, nachErstem);
  });

  test('Eine zu grosse Datei wird nicht gelesen', async () => {
    const attrappe = new Attrappe(['repo'], { '0|riesig.bin': 'x'.repeat(2000) });
    const protokoll: string[] = [];
    const fs = new ArbeitsbereichDateisystem({
      zugriff: attrappe,
      einstellungen: einstellungen({ maxDateigroesse: 1000, ausschluss: [] }),
      log: (n) => protokoll.push(n),
    });
    await assert.rejects(() => fs.lies('repo/riesig.bin', 0, 100));
    assert.equal(
      protokoll.some((n) => n.includes('ueberschreitet die Grenze')),
      true,
    );
  });

  test('Ein Verzeichnis liefert beim Lesen nichts', async () => {
    const { fs } = baue();
    assert.deepEqual(await fs.lies('', 0, 10), Buffer.alloc(0));
  });
});

describe('Arbeitsbereich - Nur-Lesen', () => {
  test('Im Nur-Lesen-Betrieb fehlen die Schreibmethoden ganz', () => {
    const { fs } = baue();
    const sicht = alsRdpdrDateisystem(fs, true);
    assert.equal(sicht.schreibe, undefined);
    assert.equal(sicht.erzeuge, undefined);
    assert.equal(sicht.loesche, undefined);
    assert.equal(sicht.benenneUm, undefined);
    assert.equal(sicht.kuerze, undefined);
  });

  test('Mit Schreibrecht sind sie da', () => {
    const { fs } = baue({ nurLesen: false, zugriff: 'readWrite' });
    const sicht = alsRdpdrDateisystem(fs, false);
    assert.equal(typeof sicht.schreibe, 'function');
    assert.equal(typeof sicht.loesche, 'function');
  });

  test('Eintraege melden sich im Nur-Lesen-Betrieb als schreibgeschuetzt', async () => {
    const { fs } = baue();
    const eintrag = await fs.stat('frontend/README.md');
    assert.equal(eintrag?.nurLesen, true);
  });

  test('baueLaufwerk liefert im Standard ein nur lesbares Laufwerk', () => {
    const attrappe = new Attrappe(['repo'], {});
    const laufwerk = baueLaufwerk({ zugriff: attrappe, einstellungen: einstellungen() });
    assert.equal(laufwerk.deviceId, 1);
    assert.equal(laufwerk.name, 'VS Code');
    assert.equal(laufwerk.dateisystem.schreibe, undefined);
    assert.equal(laufwerk.volumen?.nurLesen, true);
  });
});

describe('Arbeitsbereich - Schreiben, wenn es erlaubt ist', () => {
  const schreibbar = (): ReturnType<typeof baue> => baue({ nurLesen: false, zugriff: 'readWrite' });

  test('Schreiben ab Offset 0 ueberschreibt nur so viel, wie geschrieben wird', async () => {
    // Ausdruecklich kein Kuerzen: ein Teilschreiben laesst den Rest der Datei
    // stehen. Windows kuerzt ueber FILE_OVERWRITE oder
    // FileEndOfFileInformation, und beides landet bei kuerze().
    const { fs, attrappe } = schreibbar();
    const anzahl = await fs.schreibe('frontend/README.md', 0, Buffer.from('# Neu\n'));
    assert.equal(anzahl, 6);
    assert.equal(Buffer.from(attrappe.geschrieben.get('0|README.md')!).toString('utf8'), '# Neu\ntend\n');
  });

  test('Schreiben ab einem Offset behaelt den Anfang', async () => {
    const { fs, attrappe } = schreibbar();
    await fs.schreibe('frontend/README.md', 2, Buffer.from('XXXX'));
    assert.equal(Buffer.from(attrappe.geschrieben.get('0|README.md')!).toString('utf8'), '# XXXXtend\n');
  });

  test('Nach dem Schreiben liest der naechste Lesevorgang neu', async () => {
    const { fs } = schreibbar();
    await fs.lies('frontend/README.md', 0, 100);
    await fs.schreibe('frontend/README.md', 0, Buffer.from('# Neu\n'));
    assert.equal((await fs.lies('frontend/README.md', 0, 100)).toString('utf8'), '# Neu\ntend\n');
  });

  test('Eine neue Datei wird angelegt', async () => {
    const { fs, attrappe } = schreibbar();
    await fs.erzeuge('frontend/neu.txt', false);
    // Angelegt heisst hier: eine leere Datei geschrieben - workspace.fs kennt
    // kein blosses "anlegen".
    assert.equal(attrappe.geschrieben.get('0|neu.txt')?.length, 0);
    assert.notEqual(await fs.stat('frontend/neu.txt'), undefined);
  });

  test('Ein neues Verzeichnis wird angelegt', async () => {
    const { fs } = schreibbar();
    await fs.erzeuge('frontend/neuerOrdner', true);
    assert.equal((await fs.stat('frontend/neuerOrdner'))?.istVerzeichnis, true);
  });

  test('In der Wurzel laesst sich nichts anlegen - das waere ein Arbeitsbereichsordner', async () => {
    const { fs } = schreibbar();
    await assert.rejects(() => fs.erzeuge('neuesRepo', true));
  });

  test('Ein Arbeitsbereichsordner laesst sich nicht loeschen oder umbenennen', async () => {
    const { fs } = schreibbar();
    await assert.rejects(() => fs.loesche('frontend'));
    await assert.rejects(() => fs.benenneUm('frontend', 'backend', true));
  });

  test('Kuerzen schneidet ab', async () => {
    const { fs, attrappe } = schreibbar();
    await fs.kuerze('frontend/README.md', 3);
    assert.equal(Buffer.from(attrappe.geschrieben.get('0|README.md')!).toString('utf8'), '# F');
  });

  test('Kuerzen auf null leert die Datei', async () => {
    const { fs, attrappe } = schreibbar();
    await fs.kuerze('frontend/README.md', 0);
    assert.equal(attrappe.geschrieben.get('0|README.md')!.length, 0);
  });

  test('Umbenennen verschiebt auch ueber Ordnergrenzen hinweg', async () => {
    const { fs } = schreibbar();
    await fs.benenneUm('frontend/README.md', 'backend/README.md', true);
    assert.equal(await fs.stat('frontend/README.md'), undefined);
    assert.notEqual(await fs.stat('backend/README.md'), undefined);
  });

  test('Ueber die Groessengrenze hinaus wird nicht geschrieben', async () => {
    const { fs } = baue({ nurLesen: false, zugriff: 'readWrite', maxDateigroesse: 10 });
    await assert.rejects(() => fs.schreibe('frontend/README.md', 0, Buffer.alloc(100)));
    await assert.rejects(() => fs.kuerze('frontend/README.md', 100));
  });
});
