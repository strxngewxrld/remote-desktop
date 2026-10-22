// Befunde aus der interaktiven Windows-Pruefung (Windows MCP, Extension
// Development Host). Jeder Test haelt einen Ablauf fest, der beim Durchklicken
// schiefging.
import {
  ExtensionContext,
  antworten,
  einstellungen,
  notizen,
  workspace,
  zuruecksetzen,
} from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { activate, deactivate } from '../src/extension.js';
import { humanizeError } from '../src/session.js';
import type { RdpConnection } from '../src/connections.js';

let kontext: ExtensionContext;

beforeEach(() => {
  zuruecksetzen();
  kontext = new ExtensionContext();
});

afterEach(() => {
  deactivate();
  kontext.entsorgeAlles();
});

function sitzungsPanels() {
  return notizen.panels.filter((p) => p.viewType === 'rdpSession');
}

describe('Gespeicherte Verbindung öffnen', () => {
  beforeEach(() => {
    einstellungen.set('rdp.connections', [
      { name: 'Server', host: 'server.example.com', username: 'anna', color: 'red' },
    ] satisfies RdpConnection[]);
    activate(kontext);
  });

  async function verbinde(befehl = 'rdp.connectSaved'): Promise<void> {
    antworten.auswahlen.push(0);
    await notizen.befehle.get(befehl)!();
  }

  test('Ein zweiter Klick holt die offene Sitzung nach vorn statt eine zweite zu öffnen', async () => {
    await verbinde();
    const [panel] = sitzungsPanels();
    panel!.visible = false;

    await verbinde();
    assert.equal(sitzungsPanels().length, 1);
    assert.equal(panel!.visible, true, 'reveal() wurde aufgerufen');
  });

  test('Ein Doppelklick während des Öffnens ergibt ebenfalls nur eine Sitzung', async () => {
    antworten.auswahlen.push(0, 0);
    const befehl = notizen.befehle.get('rdp.connectSaved')!;
    await Promise.all([befehl(), befehl()]);
    assert.equal(sitzungsPanels().length, 1);
  });

  test('Nach dem Schließen öffnet derselbe Eintrag wieder eine neue Sitzung', async () => {
    await verbinde();
    sitzungsPanels()[0]!.dispose();
    await verbinde();
    assert.equal(sitzungsPanels().length, 2);
  });

  test('"Verbinden als …" öffnet bewusst eine weitere Sitzung', async () => {
    await verbinde();
    antworten.auswahlen.push(0, 0); // Verbindung, dann "Andere Zugangsdaten …"
    await notizen.befehle.get('rdp.connectAs')!();
    assert.equal(sitzungsPanels().length, 2);
  });

  test('Die Rahmenbreite wirkt sofort auf offene Sitzungen', async () => {
    await verbinde();
    const webview = sitzungsPanels()[0]!.webview;
    webview.gesendet.length = 0;

    einstellungen.set('rdp.colorFrameWidth', 12);
    workspace.meldeKonfigurationsAenderung(['rdp.colorFrameWidth']);

    assert.deepEqual(
      webview.gesendet.filter((n: any) => n.type === 'farbe'),
      [{ type: 'farbe', hex: '#e51400', titel: 'Rot', breite: 12 }],
    );
  });

  test('Auch die Zwischenablage-Richtung wird ohne Neuverbinden nachgezogen', async () => {
    await verbinde();
    const webview = sitzungsPanels()[0]!.webview;
    webview.gesendet.length = 0;

    einstellungen.set('rdp.clipboard.direction', 'localToRemote');
    workspace.meldeKonfigurationsAenderung(['rdp.clipboard.direction']);

    assert.deepEqual(
      webview.gesendet.filter((n: any) => n.type === 'clipboardConfig'),
      [{ type: 'clipboardConfig', aktiv: true, richtung: 'localToRemote' }],
    );
  });
});

describe('Verbindungsdialog', () => {
  beforeEach(() => activate(kontext));

  test('Ein ungültiger Port wird schon beim Tippen abgelehnt', async () => {
    await notizen.befehle.get('rdp.addConnection')!(); // sofort abgebrochen
    const pruefe = notizen.eingabefelder[0]!.validateInput!;

    for (const falsch of ['server:99999', 'server:0', 'server:1.5', 'server:abc', '[fe80::1]:70000']) {
      assert.match(String(pruefe(falsch)), /Ungültiger Port/, falsch);
    }
    for (const richtig of ['server', 'server:3390', 'server:', '[fe80::1]:3390', 'fe80::1']) {
      assert.equal(pruefe(richtig), undefined, richtig);
    }
  });

  test('Bearbeiten behält das Tastaturlayout, wenn man nur durchklickt', async () => {
    einstellungen.set('rdp.connections', [
      { name: 'Schweiz', host: 'ch.example.com', keyboardLayout: 'de-CH' },
    ] satisfies RdpConnection[]);
    antworten.auswahlen.push(0); // Verbindung auswählen
    antworten.eingaben.push('ch.example.com', '', 'Schweiz');
    antworten.auswahlen.push(0); // Tastaturlayout: vorausgewählter erster Eintrag

    await notizen.befehle.get('rdp.editConnection')!();

    const liste = notizen.auswahllisten.at(-1)!;
    assert.equal((liste.eintraege[0] as any).label, 'de-CH');
    assert.equal((liste.eintraege[0] as any).description, '(aktuell)');
    assert.equal(liste.eintraege.filter((e: any) => e.label === 'de-CH').length, 1, 'nicht doppelt');
    const [gespeichert] = einstellungen.get('rdp.connections') as RdpConnection[];
    assert.equal(gespeichert!.keyboardLayout, 'de-CH');
  });

  test('Ohne gesetztes Layout ist "Standard verwenden" als aktuell markiert', async () => {
    einstellungen.set('rdp.connections', [{ name: 'Ohne', host: 'h' }] satisfies RdpConnection[]);
    antworten.auswahlen.push(0);
    antworten.eingaben.push('h', '', 'Ohne');
    antworten.auswahlen.push(0);

    await notizen.befehle.get('rdp.editConnection')!();

    const erster = notizen.auswahllisten.at(-1)!.eintraege[0] as any;
    assert.equal(erster.label, 'Standard verwenden');
    assert.equal(erster.description, '(aktuell)');
  });
});

describe('Fehlermeldungen', () => {
  test('Abgewiesene Verbindung nennt den tatsächlichen Port', () => {
    const text = humanizeError(new Error('connect ECONNREFUSED 127.0.0.1:33890'), 33890);
    assert.match(text, /Port 33890/);
    assert.doesNotMatch(text, /3389\b/);
  });

  test('Abgelehnte Kerberos-Anmeldedaten bekommen den Passwort-Hinweis', () => {
    const text = humanizeError(new Error('Kerberos/SSPI: Anmeldedaten abgelehnt (UnknownCredentials).'));
    assert.match(text, /falscher Benutzername oder falsches Passwort/);
  });

  test('Ein Stillstand nach der Anmeldung verweist nicht auf Firewall oder VPN', () => {
    const text = humanizeError(new Error('Zeitueberschreitung beim Warten auf die Serverantwort'));
    assert.doesNotMatch(text, /Firewall|VPN/);
    assert.match(text, /alte Sitzung/);
  });

  test('Ein TCP-Zeitlimit verweist weiterhin auf das Netzwerk', () => {
    const text = humanizeError(new Error('Zeitueberschreitung beim TCP-Verbindungsaufbau'));
    assert.match(text, /Firewall/);
  });
});
