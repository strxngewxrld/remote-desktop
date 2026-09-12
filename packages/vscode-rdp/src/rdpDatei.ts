/**
 * Lesen von `.rdp`-Dateien, wie mstsc sie schreibt.
 *
 * Das Format ist zeilenweise `schluessel:typ:wert` mit drei Typen:
 *   `i` ganze Zahl, `s` Zeichenkette, `b` Binaerblob (Hex, etwa das
 *   verschluesselte Passwort).
 * Der Wert darf selbst Doppelpunkte enthalten (`full address:s:host:3390`),
 * deshalb wird nur an den ersten beiden Doppelpunkten getrennt.
 *
 * Uebernommen wird, was unsere Verbindungseinstellungen kennen. Alles andere
 * wird nicht stillschweigend verschluckt, sondern im Ergebnis aufgefuehrt -
 * der Benutzer soll erfahren, was aus seiner Datei nicht mitgekommen ist.
 */
import { RdpConnection } from './connections.js';
import { profilAusVerbindungsTyp } from './bandbreite.js';

export interface RdpZeile {
  schluessel: string;
  typ: 'i' | 's' | 'b';
  wert: string;
  /** Zeilennummer, 1-basiert - fuer Meldungen. */
  zeile: number;
}

export interface RdpDateiErgebnis {
  /** Die fertige Verbindung. */
  verbindung: RdpConnection;
  /** Was uebernommen wurde, als lesbarer Text. */
  uebernommen: string[];
  /** Bekannte Schluessel, die diese Extension (noch) nicht umsetzt. */
  nichtUebernommen: { schluessel: string; grund: string }[];
  /** Schluessel, die wir ueberhaupt nicht kennen. */
  unbekannt: string[];
  /** Zeilen, die nicht dem Format entsprechen. */
  ungueltig: { zeile: number; text: string }[];
}

/**
 * Schluessel, die mstsc kennt, die wir aber bewusst nicht abbilden - jeweils
 * mit dem Grund, der dem Benutzer angezeigt wird.
 */
const BEKANNT_OHNE_ABBILDUNG: Record<string, string> = {
  'audiomode': 'Audioumleitung wird nicht unterstützt',
  'audiocapturemode': 'Mikrofonumleitung wird nicht unterstützt',
  'audioqualitymode': 'Audioumleitung wird nicht unterstützt',
  'redirectclipboard': 'Zwischenablage-Umleitung wird nicht unterstützt',
  'redirectprinters': 'Druckerumleitung wird nicht unterstützt',
  'redirectcomports': 'COM-Port-Umleitung wird nicht unterstützt',
  'redirectsmartcards': 'Smartcard-Umleitung wird nicht unterstützt',
  'redirectlocation': 'Standortumleitung wird nicht unterstützt',
  'redirectwebauthn': 'WebAuthn-Umleitung wird nicht unterstützt',
  'redirectdirectx': 'DirectX-Umleitung wird nicht unterstützt',
  'drivestoredirect': 'Laufwerksumleitung wird nicht unterstützt',
  'devicestoredirect': 'Geräteumleitung wird nicht unterstützt',
  'usbdevicestoredirect': 'USB-Umleitung wird nicht unterstützt',
  'camerastoredirect': 'Kameraumleitung wird nicht unterstützt',
  'gatewayhostname': 'RD-Gateway wird nicht unterstützt',
  'gatewayusagemethod': 'RD-Gateway wird nicht unterstützt',
  'gatewaycredentialssource': 'RD-Gateway wird nicht unterstützt',
  'gatewayprofileusagemethod': 'RD-Gateway wird nicht unterstützt',
  'gatewaybrokeringtype': 'RD-Gateway wird nicht unterstützt',
  'use multimon': 'Mehrschirmbetrieb wird nicht unterstützt',
  'selectedmonitors': 'Mehrschirmbetrieb wird nicht unterstützt',
  'span monitors': 'Mehrschirmbetrieb wird nicht unterstützt',
  'maximizetocurrentdisplays': 'Mehrschirmbetrieb wird nicht unterstützt',
  'singlemoninwindowedmode': 'Mehrschirmbetrieb wird nicht unterstützt',
  'remoteapplicationmode': 'RemoteApp wird nicht unterstützt',
  'remoteapplicationname': 'RemoteApp wird nicht unterstützt',
  'remoteapplicationprogram': 'RemoteApp wird nicht unterstützt',
  'remoteapplicationcmdline': 'RemoteApp wird nicht unterstützt',
  'alternate shell': 'Startprogramm wird nicht unterstützt',
  'shell working directory': 'Startprogramm wird nicht unterstützt',
  'loadbalanceinfo': 'Sitzungsbroker wird nicht unterstützt',
  'password 51': 'Passwörter gehören in den sicheren Speicher von VS Code',
  'authentication level': 'die Zertifikatsprüfung steuert rdp.certificateTrust',
  'prompt for credentials': 'Zugangsdaten werden bei Bedarf immer abgefragt',
  'promptcredentialonce': 'Zugangsdaten werden bei Bedarf immer abgefragt',
  'enablecredsspsupport': 'CredSSP/NLA wird immer verwendet',
  'negotiate security layer': 'die Sicherheitsschicht wird immer ausgehandelt',
  'disable wallpaper': 'wird über das Bandbreitenprofil gesetzt',
  'disable menu anims': 'wird über das Bandbreitenprofil gesetzt',
  'disable themes': 'wird über das Bandbreitenprofil gesetzt',
  'disable full window drag': 'wird über das Bandbreitenprofil gesetzt',
  'disable cursor setting': 'wird über das Bandbreitenprofil gesetzt',
  'allow desktop composition': 'wird über das Bandbreitenprofil gesetzt',
  'allow font smoothing': 'wird über das Bandbreitenprofil gesetzt',
  'bitmapcachepersistenable': 'der Bitmap-Cache wird nicht dauerhaft abgelegt',
  'compression': 'die Komprimierung handelt der Client selbst aus',
  'networkautodetect': 'die Bandbreite wird nicht gemessen, es gilt das Profil',
  'bandwidthautodetect': 'die Bandbreite wird nicht gemessen, es gilt das Profil',
  'videoplaybackmode': 'Multimedia-Umleitung wird nicht unterstützt',
  'smart sizing': 'entspricht rdp.scaling',
  'dynamic resolution': 'die Auflösung folgt immer der Panelgröße',
  'autoreconnection enabled': 'die Wiederverbindung stößt der Benutzer an',
  'keyboardhook': 'Tastenkombinationen fängt der Browser-Host ab',
  'desktopscalefactor': 'die Skalierung steuert rdp.highDpi',
  'devicescalefactor': 'die Skalierung steuert rdp.highDpi',
  'winposstr': 'Fensterposition von mstsc',
  'full address (alternate)': 'nur die Hauptadresse wird verwendet',
};

/**
 * Zerlegt den Text einer .rdp-Datei in Zeilen.
 *
 * Kaputte Zeilen werden gemeldet statt geworfen: eine einzelne unverstaendliche
 * Zeile darf den Import der restlichen Datei nicht verhindern.
 */
export function parseRdpZeilen(text: string): { zeilen: RdpZeile[]; ungueltig: { zeile: number; text: string }[] } {
  const zeilen: RdpZeile[] = [];
  const ungueltig: { zeile: number; text: string }[] = [];
  // Auch das BOM einer UTF-8-Datei fliegt hier raus.
  const roh = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  roh.forEach((original, i) => {
    const nummer = i + 1;
    const zeile = original.trim();
    if (zeile.length === 0) return;
    const ersterDoppelpunkt = zeile.indexOf(':');
    const zweiterDoppelpunkt = ersterDoppelpunkt >= 0 ? zeile.indexOf(':', ersterDoppelpunkt + 1) : -1;
    if (ersterDoppelpunkt <= 0 || zweiterDoppelpunkt < 0) {
      ungueltig.push({ zeile: nummer, text: zeile });
      return;
    }
    const schluessel = zeile.slice(0, ersterDoppelpunkt).trim().toLowerCase();
    const typ = zeile.slice(ersterDoppelpunkt + 1, zweiterDoppelpunkt).trim().toLowerCase();
    const wert = zeile.slice(zweiterDoppelpunkt + 1);
    if (schluessel.length === 0 || (typ !== 'i' && typ !== 's' && typ !== 'b')) {
      ungueltig.push({ zeile: nummer, text: zeile });
      return;
    }
    if (typ === 'i' && !/^-?\d+$/.test(wert.trim())) {
      ungueltig.push({ zeile: nummer, text: zeile });
      return;
    }
    zeilen.push({ schluessel, typ: typ as 'i' | 's' | 'b', wert: typ === 'i' ? wert.trim() : wert, zeile: nummer });
  });
  return { zeilen, ungueltig };
}

/** Trennt "host:port" und beruecksichtigt IPv6-Adressen in Klammern. */
function trenneHostPort(wert: string): { host: string; port?: number } {
  const text = wert.trim();
  if (text.startsWith('[')) {
    const ende = text.indexOf(']');
    if (ende > 0) {
      const rest = text.slice(ende + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : undefined;
      return { host: text.slice(1, ende), port: gueltigerPort(port) };
    }
  }
  const index = text.lastIndexOf(':');
  if (index > 0 && !text.slice(index + 1).includes(':')) {
    return { host: text.slice(0, index), port: gueltigerPort(Number(text.slice(index + 1))) };
  }
  return { host: text };
}

function gueltigerPort(wert: number | undefined): number | undefined {
  return typeof wert === 'number' && Number.isInteger(wert) && wert > 0 && wert <= 65535 ? wert : undefined;
}

/**
 * Baut aus dem Inhalt einer .rdp-Datei eine Verbindung.
 *
 * `standardName` ist der Rueckfallname, ueblicherweise der Dateiname ohne
 * Endung - genau so beschriftet mstsc seine Verknuepfungen.
 */
export function importiereRdpDatei(text: string, standardName = ''): RdpDateiErgebnis {
  const { zeilen, ungueltig } = parseRdpZeilen(text);
  const verbindung: RdpConnection = { name: standardName.trim(), host: '' };
  const uebernommen: string[] = [];
  const nichtUebernommen: { schluessel: string; grund: string }[] = [];
  const unbekannt: string[] = [];

  let bildschirmModus: number | undefined;
  let breite: number | undefined;
  let hoehe: number | undefined;
  let portAusAdresse: number | undefined;
  let portAusFeld: number | undefined;

  const merke = (text_: string) => uebernommen.push(text_);

  for (const { schluessel, wert } of zeilen) {
    const zahl = Number(wert);
    switch (schluessel) {
      case 'full address': {
        const { host, port } = trenneHostPort(wert);
        if (!host) break;
        verbindung.host = host;
        if (port) portAusAdresse = port;
        merke(`Host: ${host}${port ? ':' + port : ''}`);
        break;
      }
      case 'alternate full address':
        // mstsc schreibt dieselbe Adresse noch einmal; nur nutzen, wenn die
        // Hauptadresse fehlt.
        if (!verbindung.host) {
          const { host, port } = trenneHostPort(wert);
          if (host) {
            verbindung.host = host;
            if (port) portAusAdresse = port;
            merke(`Host (alternate full address): ${host}`);
          }
        }
        break;
      case 'server port':
        if (gueltigerPort(zahl)) {
          portAusFeld = zahl;
          merke(`Port: ${zahl}`);
        }
        break;
      case 'username': {
        const roh = wert.trim();
        if (!roh) break;
        if (roh.includes('\\')) {
          const [d, u] = roh.split('\\', 2);
          if (d) verbindung.domain = d;
          verbindung.username = u;
        } else {
          verbindung.username = roh;
        }
        merke(`Benutzer: ${roh}`);
        break;
      }
      case 'domain':
        if (wert.trim()) {
          verbindung.domain = wert.trim();
          merke(`Domäne: ${wert.trim()}`);
        }
        break;
      case 'desktopwidth':
        if (zahl > 0) breite = zahl;
        break;
      case 'desktopheight':
        if (zahl > 0) hoehe = zahl;
        break;
      case 'screen mode id':
        bildschirmModus = zahl;
        break;
      case 'session bpp':
        if ([8, 15, 16, 24, 32].includes(zahl)) {
          verbindung.colorDepth = zahl;
          merke(`Farbtiefe: ${zahl} Bit`);
        } else {
          nichtUebernommen.push({ schluessel, grund: `Farbtiefe ${wert} wird nicht unterstützt` });
        }
        break;
      case 'connection type': {
        const profil = profilAusVerbindungsTyp(zahl);
        if (profil) {
          verbindung.bandwidthProfile = profil;
          merke(`Bandbreitenprofil: ${profil}`);
        } else {
          nichtUebernommen.push({ schluessel, grund: `unbekannte Verbindungsart ${wert}` });
        }
        break;
      }
      default: {
        const grund = BEKANNT_OHNE_ABBILDUNG[schluessel];
        if (grund) {
          if (!nichtUebernommen.some((n) => n.schluessel === schluessel)) nichtUebernommen.push({ schluessel, grund });
        } else if (!unbekannt.includes(schluessel)) {
          unbekannt.push(schluessel);
        }
        break;
      }
    }
  }

  // Der Vollbildmodus (2) hat in einer Datei zwar Werte fuer Breite und Hoehe,
  // gemeint ist aber "so gross wie der Bildschirm". Bei uns entspricht das der
  // automatischen Groesse, also der Panelgroesse.
  if (bildschirmModus === 2) {
    if (breite && hoehe) {
      nichtUebernommen.push({
        schluessel: 'screen mode id',
        grund: `Vollbild: die Auflösung folgt der Panelgröße statt ${breite}×${hoehe}`,
      });
    }
  } else if (breite && hoehe) {
    verbindung.width = breite;
    verbindung.height = hoehe;
    merke(`Auflösung: ${breite}×${hoehe}`);
  }

  const port = portAusFeld ?? portAusAdresse;
  if (port && port !== 3389) verbindung.port = port;
  if (!verbindung.name) verbindung.name = verbindung.host;

  return { verbindung, uebernommen, nichtUebernommen, unbekannt, ungueltig };
}

/**
 * Macht aus dem Dateiinhalt Text. mstsc schreibt .rdp-Dateien in UTF-16LE mit
 * BOM; von Hand angelegte Dateien sind meist UTF-8.
 */
export function dekodiereRdpDatei(daten: Uint8Array): string {
  if (daten.length >= 2 && daten[0] === 0xff && daten[1] === 0xfe) {
    return Buffer.from(daten.slice(2)).toString('utf16le');
  }
  if (daten.length >= 2 && daten[0] === 0xfe && daten[1] === 0xff) {
    // UTF-16BE: byteweise drehen, Node kann das nicht direkt.
    const gedreht = Buffer.from(daten.slice(2));
    gedreht.swap16();
    return gedreht.toString('utf16le');
  }
  return Buffer.from(daten).toString('utf8').replace(/^﻿/, '');
}

/**
 * Schreibt eine Verbindung als .rdp-Datei heraus - der Notausgang in einen
 * nativen Client (mstsc, Microsoft Remote Desktop), wenn diese Extension
 * einmal etwas nicht kann.
 *
 * Die Abbildung ist die Umkehrung von `importiereRdpDatei`, sodass der
 * Rundlauf importieren -> exportieren -> importieren dieselbe Verbindung
 * ergibt. Zwei Dinge kennt das Format nicht und bleiben deshalb aussen vor:
 * der Anzeigename (mstsc benutzt dafuer den Dateinamen) und unsere Tags.
 */
export function exportiereRdpDatei(verbindung: RdpConnection): string {
  const zeilen: string[] = [];
  const i = (schluessel: string, wert: number) => zeilen.push(`${schluessel}:i:${wert}`);
  const s = (schluessel: string, wert: string) => zeilen.push(`${schluessel}:s:${wert}`);

  // Ohne eigene Aufloesung ist Vollbild die ehrlichste Entsprechung unserer
  // "an die Panelgroesse angepasst"-Einstellung.
  const vollbild = !(verbindung.width && verbindung.height);
  i('screen mode id', vollbild ? 2 : 1);
  if (!vollbild) {
    i('desktopwidth', verbindung.width!);
    i('desktopheight', verbindung.height!);
  }
  // Nur schreiben, was wirklich eingestellt ist: sonst brächte der Rundlauf
  // eine Farbtiefe zurück, die der Benutzer nie gesetzt hat.
  if (verbindung.colorDepth) i('session bpp', verbindung.colorDepth);
  s('full address', verbindung.host);
  // Der Port steht immer da - so wie mstsc es schreibt. Beim Zurueckimportieren
  // gilt 3389 als "nicht gesetzt", damit der Rundlauf nichts erfindet.
  i('server port', verbindung.port ?? 3389);
  if (verbindung.username) s('username', verbindung.username);
  if (verbindung.domain) s('domain', verbindung.domain);
  const typ = verbindungsTypAusProfil(verbindung.bandwidthProfile);
  if (typ !== undefined) i('connection type', typ);
  // Fester Bodensatz, damit mstsc die Datei ohne Nachfragen oeffnet.
  i('networkautodetect', typ === undefined ? 1 : 0);
  i('bandwidthautodetect', typ === undefined ? 1 : 0);
  i('authentication level', 2);
  i('prompt for credentials', 0);
  i('negotiate security layer', 1);
  i('enablecredsspsupport', 1);
  return zeilen.join('\r\n') + '\r\n';
}

/** Die Umkehrung von `profilAusVerbindungsTyp`. */
function verbindungsTypAusProfil(profil: RdpConnection['bandwidthProfile']): number | undefined {
  switch (profil) {
    case 'lan':
      return 6;
    case 'broadband':
      return 4;
    case 'mobile':
      return 2;
    default:
      return undefined;
  }
}

/** Fasst zusammen, was beim Import nicht mitgekommen ist. */
export function berichtUeberRest(ergebnis: RdpDateiErgebnis): string[] {
  const zeilen: string[] = [];
  for (const { schluessel, grund } of ergebnis.nichtUebernommen) zeilen.push(`${schluessel}: ${grund}`);
  if (ergebnis.unbekannt.length > 0) zeilen.push(`unbekannte Schlüssel: ${ergebnis.unbekannt.join(', ')}`);
  for (const { zeile, text } of ergebnis.ungueltig) zeilen.push(`Zeile ${zeile} ist unlesbar: ${text}`);
  return zeilen;
}
