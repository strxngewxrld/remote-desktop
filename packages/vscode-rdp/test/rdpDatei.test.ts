// Muss als erstes stehen: der Import biegt `require('vscode')` auf die
// Attrappe um, bevor irgendein Modul aus src/ geladen wird.
import {
  ExtensionContext,
  Uri,
  antworten,
  dateien,
  einstellungen,
  notizen,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  berichtUeberRest,
  dekodiereRdpDatei,
  exportiereRdpDatei,
  importiereRdpDatei,
  parseRdpZeilen,
} from '../src/rdpDatei.js';
import { activate, deactivate } from '../src/extension.js';
import type { RdpConnection } from '../src/connections.js';

/** Eine Datei, wie mstsc sie schreibt - gekuerzt, aber nichts erfunden. */
const MSTSC_DATEI = [
  'screen mode id:i:1',
  'use multimon:i:0',
  'desktopwidth:i:1920',
  'desktopheight:i:1080',
  'session bpp:i:32',
  'winposstr:s:0,3,0,0,800,600',
  'compression:i:1',
  'keyboardhook:i:2',
  'audiocapturemode:i:0',
  'videoplaybackmode:i:1',
  'connection type:i:6',
  'networkautodetect:i:1',
  'bandwidthautodetect:i:1',
  'displayconnectionbar:i:1',
  'disable wallpaper:i:0',
  'allow font smoothing:i:1',
  'allow desktop composition:i:1',
  'disable full window drag:i:1',
  'disable menu anims:i:1',
  'disable themes:i:0',
  'bitmapcachepersistenable:i:1',
  'full address:s:server.example.com',
  'server port:i:3390',
  'username:s:DOMAENE\\benutzer',
  'audiomode:i:0',
  'redirectclipboard:i:1',
  'redirectprinters:i:1',
  'drivestoredirect:s:*',
  'authentication level:i:2',
  'prompt for credentials:i:0',
  'gatewayhostname:s:',
  'password 51:b:01000000d08c9ddf0115d1118c7a00c04fc297eb',
].join('\r\n');

beforeEach(() => zuruecksetzen());

describe('.rdp zerlegen', () => {
  test('Die drei Typen i, s und b werden erkannt', () => {
    const { zeilen, ungueltig } = parseRdpZeilen('session bpp:i:32\nfull address:s:host\npassword 51:b:0102');
    assert.deepEqual(ungueltig, []);
    assert.deepEqual(
      zeilen.map((z) => [z.schluessel, z.typ, z.wert]),
      [
        ['session bpp', 'i', '32'],
        ['full address', 's', 'host'],
        ['password 51', 'b', '0102'],
      ],
    );
  });

  test('Ein Wert darf selbst Doppelpunkte enthalten', () => {
    const { zeilen } = parseRdpZeilen('full address:s:server.example.com:3390');
    assert.equal(zeilen[0]!.wert, 'server.example.com:3390');
  });

  test('Leerzeilen und Zeilenenden aller Art stoeren nicht', () => {
    const { zeilen, ungueltig } = parseRdpZeilen('a:i:1\r\n\r\nb:s:zwei\n\n   \nc:i:3\r');
    assert.deepEqual(ungueltig, []);
    assert.equal(zeilen.length, 3);
  });

  test('Kaputte Zeilen werden gemeldet, nicht geworfen', () => {
    const { zeilen, ungueltig } = parseRdpZeilen(
      ['einfach nur Text', 'ohne:zweiten-doppelpunkt', 'gut:s:wert', ':s:ohne Schluessel', 'zahl:i:keineZahl', 'typ:x:egal'].join(
        '\n',
      ),
    );
    assert.deepEqual(zeilen.map((z) => z.schluessel), ['gut'], 'die gute Zeile kommt trotzdem durch');
    assert.deepEqual(
      ungueltig.map((u) => u.zeile),
      [1, 2, 4, 5, 6],
    );
  });

  test('Der Schluessel wird kleingeschrieben, der Wert nicht', () => {
    const { zeilen } = parseRdpZeilen('Full Address:S:Server.Example.COM');
    assert.equal(zeilen[0]!.schluessel, 'full address');
    assert.equal(zeilen[0]!.wert, 'Server.Example.COM');
  });
});

describe('.rdp abbilden', () => {
  test('Die gaengigen Schluessel landen in der Verbindung', () => {
    const { verbindung } = importiereRdpDatei(MSTSC_DATEI, 'Mein Server');
    assert.deepEqual(verbindung, {
      name: 'Mein Server',
      host: 'server.example.com',
      port: 3390,
      username: 'benutzer',
      domain: 'DOMAENE',
      width: 1920,
      height: 1080,
      colorDepth: 32,
      bandwidthProfile: 'lan',
    } satisfies RdpConnection);
  });

  test('Was nicht uebernommen wird, erfaehrt der Benutzer', () => {
    const ergebnis = importiereRdpDatei(MSTSC_DATEI, 'X');
    const gemeldet = ergebnis.nichtUebernommen.map((n) => n.schluessel);
    for (const schluessel of ['audiomode', 'redirectclipboard', 'gatewayhostname', 'password 51', 'use multimon']) {
      assert.ok(gemeldet.includes(schluessel), `${schluessel} wird gemeldet`);
    }
    assert.ok(
      ergebnis.nichtUebernommen.every((n) => n.grund.length > 0),
      'und zwar mit Begruendung',
    );
    assert.ok(berichtUeberRest(ergebnis).length > 0);
  });

  test('Unbekannte Schluessel werden gesammelt statt verschluckt', () => {
    const ergebnis = importiereRdpDatei('full address:s:host\nvoellig neuer schluessel:i:1', 'X');
    assert.deepEqual(ergebnis.unbekannt, ['voellig neuer schluessel']);
    assert.equal(ergebnis.verbindung.host, 'host');
  });

  test('Kaputte Zeilen verhindern den Import der Datei nicht', () => {
    const ergebnis = importiereRdpDatei('kaputt\nfull address:s:host\nauch kaputt:', 'X');
    assert.equal(ergebnis.verbindung.host, 'host');
    assert.deepEqual(ergebnis.ungueltig.map((u) => u.zeile), [1, 3]);
  });

  test('Der Port aus der Adresse gilt, wenn kein server port dasteht', () => {
    const { verbindung } = importiereRdpDatei('full address:s:host.example.com:3391', 'X');
    assert.equal(verbindung.host, 'host.example.com');
    assert.equal(verbindung.port, 3391);
  });

  test('server port schlaegt den Port aus der Adresse', () => {
    const { verbindung } = importiereRdpDatei('full address:s:host:3391\nserver port:i:3392', 'X');
    assert.equal(verbindung.port, 3392);
  });

  test('IPv6 in Klammern wird nicht am Doppelpunkt zerteilt', () => {
    const { verbindung } = importiereRdpDatei('full address:s:[fe80::1]:3390', 'X');
    assert.equal(verbindung.host, 'fe80::1');
    assert.equal(verbindung.port, 3390);
  });

  test('Vollbild bedeutet bei uns automatische Groesse', () => {
    const ergebnis = importiereRdpDatei(
      'full address:s:host\nscreen mode id:i:2\ndesktopwidth:i:1920\ndesktopheight:i:1080',
      'X',
    );
    assert.equal(ergebnis.verbindung.width, undefined);
    assert.equal(ergebnis.verbindung.height, undefined);
    assert.ok(
      ergebnis.nichtUebernommen.some((n) => n.schluessel === 'screen mode id'),
      'und der Benutzer erfaehrt, warum',
    );
  });

  test('Die Verbindungsart wird auf ein Bandbreitenprofil abgebildet', () => {
    const profil = (typ: number) => importiereRdpDatei(`full address:s:h\nconnection type:i:${typ}`, 'X').verbindung.bandwidthProfile;
    assert.equal(profil(1), 'mobile');
    assert.equal(profil(2), 'mobile');
    assert.equal(profil(4), 'broadband');
    assert.equal(profil(6), 'lan');
    assert.equal(profil(9), undefined, 'eine unbekannte Art wird nicht geraten');
  });

  test('Eine unsinnige Farbtiefe wird gemeldet statt uebernommen', () => {
    const ergebnis = importiereRdpDatei('full address:s:h\nsession bpp:i:7', 'X');
    assert.equal(ergebnis.verbindung.colorDepth, undefined);
    assert.ok(ergebnis.nichtUebernommen.some((n) => n.schluessel === 'session bpp'));
  });

  test('Ohne Namen dient der Host als Anzeigename', () => {
    assert.equal(importiereRdpDatei('full address:s:host.example.com').verbindung.name, 'host.example.com');
  });

  test('Ohne Serveradresse bleibt der Host leer - der Aufrufer lehnt dann ab', () => {
    assert.equal(importiereRdpDatei('session bpp:i:32', 'X').verbindung.host, '');
  });

  test('UTF-16LE mit BOM wird gelesen, so wie mstsc es schreibt', () => {
    const text = 'full address:s:server\r\nusername:s:ümläut\r\n';
    const daten = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const ergebnis = importiereRdpDatei(dekodiereRdpDatei(daten), 'X');
    assert.equal(ergebnis.verbindung.host, 'server');
    assert.equal(ergebnis.verbindung.username, 'ümläut');
  });

  test('UTF-8 mit und ohne BOM geht genauso', () => {
    const roh = Buffer.from('full address:s:server\n', 'utf8');
    assert.equal(dekodiereRdpDatei(roh), 'full address:s:server\n');
    const mitBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), roh]);
    assert.equal(importiereRdpDatei(dekodiereRdpDatei(mitBom)).verbindung.host, 'server');
  });
});

describe('.rdp herausschreiben', () => {
  test('Der Rundlauf importieren - exportieren - importieren ergibt dieselbe Verbindung', () => {
    const erste = importiereRdpDatei(MSTSC_DATEI, 'Mein Server').verbindung;
    const datei = exportiereRdpDatei(erste);
    const zweite = importiereRdpDatei(datei, 'Mein Server').verbindung;
    assert.deepEqual(zweite, erste);
  });

  test('Auch eine Verbindung ohne Extras ueberlebt den Rundlauf', () => {
    const schlicht: RdpConnection = { name: 'Schlicht', host: '10.0.0.1' };
    const zurueck = importiereRdpDatei(exportiereRdpDatei(schlicht), 'Schlicht').verbindung;
    assert.deepEqual(zurueck, schlicht);
  });

  test('Jedes Bandbreitenprofil kommt als dasselbe wieder an', () => {
    for (const profil of ['lan', 'broadband', 'mobile'] as const) {
      const verbindung: RdpConnection = { name: 'P', host: 'h', bandwidthProfile: profil };
      assert.deepEqual(importiereRdpDatei(exportiereRdpDatei(verbindung), 'P').verbindung, verbindung);
    }
  });

  test('Ohne eigene Aufloesung wird Vollbild geschrieben', () => {
    const datei = exportiereRdpDatei({ name: 'A', host: 'h' });
    assert.ok(datei.includes('screen mode id:i:2'));
    assert.ok(!datei.includes('desktopwidth'));
  });

  test('Mit Aufloesung wird der Fenstermodus geschrieben', () => {
    const datei = exportiereRdpDatei({ name: 'A', host: 'h', width: 1280, height: 800 });
    assert.ok(datei.includes('screen mode id:i:1'));
    assert.ok(datei.includes('desktopwidth:i:1280'));
    assert.ok(datei.includes('desktopheight:i:800'));
  });

  test('Kein Passwort in der Datei', () => {
    const datei = exportiereRdpDatei({ name: 'A', host: 'h', username: 'u', domain: 'd' });
    assert.ok(!/passw/i.test(datei), datei);
  });

  test('Jede Zeile haelt sich an schluessel:typ:wert', () => {
    const datei = exportiereRdpDatei({ name: 'A', host: 'h', username: 'u' });
    const { ungueltig } = parseRdpZeilen(datei);
    assert.deepEqual(ungueltig, []);
  });
});

describe('Import und Export als Befehl', () => {
  let kontext: ExtensionContext;

  beforeEach(() => {
    kontext = new ExtensionContext();
    activate(kontext);
  });

  afterEach(() => {
    deactivate();
    kontext.entsorgeAlles();
  });

  function gespeicherte(): unknown[] {
    return (einstellungen.get('rdp.connections') as unknown[] | undefined) ?? [];
  }

  test('Der Import legt die Verbindung aus der gewaehlten Datei an', async () => {
    dateien.set('/tmp/Mein Server.rdp', Buffer.from(MSTSC_DATEI, 'utf8'));
    antworten.dateiauswahlen.push([Uri.file('/tmp/Mein Server.rdp')]);
    antworten.meldungen.push(undefined);

    await notizen.befehle.get('rdp.importRdpFile')!();

    assert.deepEqual(gespeicherte(), [
      {
        name: 'Mein Server',
        host: 'server.example.com',
        port: 3390,
        username: 'benutzer',
        domain: 'DOMAENE',
        width: 1920,
        height: 1080,
        colorDepth: 32,
        bandwidthProfile: 'lan',
      },
    ]);
    assert.equal(notizen.oeffnenDialoge[0]!.canSelectMany, true, 'Mehrfachauswahl ist erlaubt');
  });

  test('Mehrere Dateien in einem Zug', async () => {
    dateien.set('/tmp/Eins.rdp', Buffer.from('full address:s:10.0.0.1', 'utf8'));
    dateien.set('/tmp/Zwei.rdp', Buffer.from('full address:s:10.0.0.2', 'utf8'));
    antworten.dateiauswahlen.push([Uri.file('/tmp/Eins.rdp'), Uri.file('/tmp/Zwei.rdp')]);
    antworten.meldungen.push(undefined);

    await notizen.befehle.get('rdp.importRdpFile')!();

    assert.deepEqual(gespeicherte().map((c: any) => c.name), ['Eins', 'Zwei']);
  });

  test('Eine Datei ohne Serveradresse wird uebersprungen und gemeldet', async () => {
    dateien.set('/tmp/Leer.rdp', Buffer.from('session bpp:i:32', 'utf8'));
    antworten.dateiauswahlen.push([Uri.file('/tmp/Leer.rdp')]);

    await notizen.befehle.get('rdp.importRdpFile')!();

    assert.deepEqual(gespeicherte(), []);
    assert.equal(notizen.fehlermeldungen.length, 1);
  });

  test('Ohne Dateiauswahl passiert nichts', async () => {
    await notizen.befehle.get('rdp.importRdpFile')!();
    assert.deepEqual(gespeicherte(), []);
    assert.deepEqual(notizen.fehlermeldungen, []);
  });

  test('Der Export schreibt die Datei mit den geerbten Werten', async () => {
    einstellungen.set('rdp.connections', [
      {
        type: 'folder',
        name: 'Kunde',
        settings: { domain: 'KUNDE', colorDepth: 16 },
        children: [{ name: 'Server', host: '10.0.0.9' }],
      },
    ]);
    antworten.auswahlen.push(0); // die einzige Verbindung
    antworten.speicherziele.push(Uri.file('/tmp/Server.rdp'));
    antworten.meldungen.push(undefined);

    await notizen.befehle.get('rdp.exportRdpFile')!();

    const geschrieben = notizen.geschriebeneDateien.at(-1)!;
    assert.equal(geschrieben.pfad, '/tmp/Server.rdp');
    const inhalt = Buffer.from(geschrieben.inhalt).toString('utf8');
    assert.ok(inhalt.includes('full address:s:10.0.0.9'));
    assert.ok(inhalt.includes('domain:s:KUNDE'), 'der geerbte Wert steht in der Datei');
    assert.ok(inhalt.includes('session bpp:i:16'));
  });

  test('Ohne Speicherziel wird nichts geschrieben', async () => {
    einstellungen.set('rdp.connections', [{ name: 'A', host: '10.0.0.1' }]);
    antworten.auswahlen.push(0);

    await notizen.befehle.get('rdp.exportRdpFile')!();
    assert.deepEqual(notizen.geschriebeneDateien, []);
  });
});
