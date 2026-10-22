import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Diese Tests laufen in einem echten VS Code mit geladener Extension.
 *
 * Sie decken das ab, was die schnellen Tests unter test/ grundsaetzlich nicht
 * koennen: ob die Extension im Extension-Host ueberhaupt hochkommt, ob das
 * Manifest zum Code passt und ob der Renderer die Nutzlast vertraegt, die wir
 * ihm schicken.
 */

const ERWEITERUNG = 'Tom-Knueppel.vscode-rdp';

suite('Aktivierung im echten Extension-Host', () => {
  test('die Beschreibung ist lokalisiert und beide Dokumentfassungen sind vorhanden', () => {
    if (process.env.VSCODE_TEST_LANGUAGE) assert.equal(vscode.env.language, process.env.VSCODE_TEST_LANGUAGE, 'Requested VS Code language is active');
    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.ok(ext);
    assert.match(ext.packageJSON.description, vscode.env.language.toLowerCase().startsWith('de')
      ? /Remote-Desktop-Sitzungen/ : /Remote Desktop sessions/);
    for (const name of ['README', 'CHANGELOG', 'THIRD_PARTY_NOTICES']) {
      for (const suffix of ['', '.de']) assert.ok(readFileSync(join(ext.extensionPath, `${name}${suffix}.md`), 'utf8').length);
    }
  });

  test('der VSIX-Installer ist im echten Host erreichbar und Walkthrough-Medien sind mitgeliefert', async () => {
    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.ok(ext);
    await ext.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes('workbench.extensions.installExtension'));
    for (const walkthrough of ext.packageJSON.contributes.walkthroughs) {
      for (const step of walkthrough.steps) {
        assert.ok(readFileSync(join(ext.extensionPath, step.media.markdown), 'utf8').length > 0);
      }
    }
  });

  test('die Erweiterung ist installiert und laesst sich aktivieren', async () => {
    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.ok(ext, `Erweiterung ${ERWEITERUNG} nicht gefunden`);
    await ext.activate();
    assert.equal(ext.isActive, true, 'Aktivierung ist durchgelaufen');
  });

  test('jedes Kommando aus dem Manifest ist auch wirklich registriert', async () => {
    // Faengt das Auseinanderlaufen von package.json und Code: ein im Manifest
    // angebotenes Kommando, das niemand registriert, scheitert erst beim
    // Anwender mit "command not found".
    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.ok(ext);
    await ext.activate();

    const manifest = JSON.parse(
      readFileSync(join(ext.extensionPath, 'package.json'), 'utf8'),
    ) as { contributes?: { commands?: { command: string }[] } };
    const angeboten = (manifest.contributes?.commands ?? []).map((c) => c.command);
    assert.ok(angeboten.length > 0, 'das Manifest bietet Kommandos an');

    const registriert = new Set(await vscode.commands.getCommands(true));
    const fehlend = angeboten.filter((c) => !registriert.has(c));
    assert.deepEqual(fehlend, [], `nicht registrierte Kommandos: ${fehlend.join(', ')}`);
  });
});

suite('Webview im echten Renderer', () => {
  /**
   * Baut das Webview der Extension auf und schickt ihm eine Vollbildnachricht.
   *
   * Genau hier wuerde sich ein Absturz des Fensters zeigen: stirbt der
   * Renderer-Prozess, kommt nie eine Antwort und der Test laeuft in die
   * Zeitgrenze. Mit einer Attrappe ist das nicht pruefbar, weil eine Attrappe
   * keinen eigenen Prozess hat, den man umbringen koennte.
   */
  async function baueWebview(): Promise<{
    panel: vscode.WebviewPanel;
    warteAuf: (typ: string, ms?: number) => Promise<any>;
  }> {
    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.ok(ext);
    await ext.activate();

    const panel = vscode.window.createWebviewPanel('rdpTest', 'RDP-Test', vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(ext.extensionPath)],
      retainContextWhenHidden: true,
    });

    const eingegangen: any[] = [];
    const wartende: { typ: string; loesen: (v: any) => void }[] = [];
    panel.webview.onDidReceiveMessage((m) => {
      const index = wartende.findIndex((w) => w.typ === m?.type);
      if (index >= 0) wartende.splice(index, 1)[0].loesen(m);
      else eingegangen.push(m);
    });

    // Das HTML wird hier schlank nachgebaut, aber mit *den ausgelieferten*
    // media-Dateien - geprueft werden soll das Skript, nicht die Huelle.
    const skript = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(ext.extensionPath), 'media', 'main.js'),
    );
    const stil = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(ext.extensionPath), 'media', 'main.css'),
    );
    panel.webview.html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<link href="${stil}" rel="stylesheet"></head><body>
<div id="stage"><canvas id="screen" width="1280" height="800" tabindex="0"></canvas></div>
<div id="overlay" class="visible"><div class="overlay-card"><div class="spinner" id="spinner"></div>
<h2 id="overlay-title"></h2><p id="overlay-message"></p><button id="overlay-action" hidden></button></div></div>
<div id="hint" hidden></div>
<script src="${skript}"></script></body></html>`;

    const warteAuf = (typ: string, ms = 20000) =>
      new Promise<any>((loesen, ablehnen) => {
        const index = eingegangen.findIndex((m) => m?.type === typ);
        if (index >= 0) return loesen(eingegangen.splice(index, 1)[0]);
        const wartend = {
          typ,
          loesen: (v: any) => { clearTimeout(zeit); loesen(v); },
        };
        const zeit = setTimeout(
          () => {
            const index = wartende.indexOf(wartend);
            if (index >= 0) wartende.splice(index, 1);
            ablehnen(new Error(`keine Nachricht "${typ}" innerhalb von ${ms} ms`));
          },
          ms,
        );
        wartende.push(wartend);
      });

    return { panel, warteAuf };
  }

  /** Eine Bitmap-Nachricht im Format, das session.ts erzeugt. */
  function bitmap(breite: number, hoehe: number): unknown {
    const laenge = breite * hoehe * 4;
    const daten = Buffer.alloc(laenge, 0x80);
    return {
      type: 'bitmap',
      rects: [{ x: 0, y: 0, w: breite, h: hoehe, offset: 0, length: laenge }],
      data: new Uint8Array(daten),
    };
  }

  test('das Skript meldet sich beim Host', async () => {
    const { panel, warteAuf } = await baueWebview();
    try {
      const bereit = await warteAuf('ready');
      assert.equal(typeof bereit.width, 'number');
      assert.equal(typeof bereit.height, 'number');
    } finally {
      panel.dispose();
    }
  });

  test('eine Vollbildkachel wird gezeichnet, ohne den Renderer zu verlieren', async () => {
    const { panel, warteAuf } = await baueWebview();
    try {
      await warteAuf('ready');
      panel.webview.postMessage({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
      panel.webview.postMessage(bitmap(1076, 536));
      const gemalt = await warteAuf('painted');
      assert.ok(gemalt.tiles >= 1, 'mindestens eine Kachel gezeichnet');
    } finally {
      panel.dispose();
    }
  });

  test('VS Code reicht Uint8Array unveraendert an den Renderer durch', async () => {
    // Diese Frage entscheidet, welcher Weg in toBytes genommen wird. Kommen die
    // Daten als einfaches Objekt an, muss die Webview den Host auf Base64
    // umstellen lassen - tut sie das nicht, mahlt sie pro Vollbildnachricht
    // ueber eine Sekunde durch Objekteigenschaften.
    const { panel, warteAuf } = await baueWebview();
    try {
      await warteAuf('ready');
      panel.webview.postMessage({ type: 'init', width: 320, height: 200, scaling: 'fit', smooth: false });
      panel.webview.postMessage(bitmap(320, 200));
      await warteAuf('painted');
      // Kurz nachlaufen lassen, damit eine etwaige Umstellung noch eintrifft.
      await new Promise((r) => setTimeout(r, 500));
      const umgestellt = await warteAuf('binaryUnsupported', 1).catch(() => undefined);
      assert.equal(
        umgestellt,
        undefined,
        'diese VS-Code-Fassung reicht Binaerdaten durch; muesste sie es nicht, waere der Objektweg der Normalfall',
      );
    } finally {
      panel.dispose();
    }
  });

  test('zwanzig Vollbildnachrichten hintereinander ueberlebt der Renderer', async () => {
    // Ein einzelnes Vollbild sagt wenig - der Absturz trat im Betrieb auf,
    // also unter fortlaufender Last.
    const { panel, warteAuf } = await baueWebview();
    try {
      await warteAuf('ready');
      panel.webview.postMessage({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
      for (let i = 0; i < 20; i++) {
        await panel.webview.postMessage(bitmap(1076, 536));
        const gemalt = await warteAuf('painted');
        assert.ok(gemalt.tiles >= 1, `Vollbild ${i + 1} wurde gezeichnet`);
      }
      // Nach der Last muss das Skript weiterhin antworten.
      panel.webview.postMessage({ type: 'state', state: 'connected' });
      panel.webview.postMessage(bitmap(64, 64));
      const nachher = await warteAuf('painted', 20000);
      assert.ok(nachher.tiles >= 1, 'das Skript lebt nach der Last noch');
      await panel.webview.postMessage({ type: 'diagnosePing', seq: 21 });
      assert.equal((await warteAuf('diagnosePong')).seq, 21, 'neue Antwort nach allen Bildern');
    } finally {
      panel.dispose();
    }
  });

  test('auch ein Burst aus zwanzig Vollbildern laesst den Renderer weiter antworten', async () => {
    const { panel, warteAuf } = await baueWebview();
    try {
      await warteAuf('ready');
      await panel.webview.postMessage({ type: 'init', width: 1076, height: 536, scaling: 'fit', smooth: false });
      await Promise.all(Array.from({ length: 20 }, () => panel.webview.postMessage(bitmap(1076, 536))));
      await warteAuf('painted');
      await panel.webview.postMessage({ type: 'diagnosePing', seq: 42 });
      assert.equal((await warteAuf('diagnosePong')).seq, 42);
      await panel.webview.postMessage({ type: 'screenshotAnfrage', id: 'nach-burst' });
      const bild = await warteAuf('screenshot');
      assert.equal(bild.id, 'nach-burst');
      assert.equal(bild.width, 1076);
      assert.equal(bild.height, 536);
      assert.match(bild.dataUrl, /^data:image\/png;base64,/);
    } finally {
      panel.dispose();
    }
  });
});

suite('Seitenleiste', () => {
  /**
   * Die Ansicht wirklich oeffnen, nicht nur die Extension aktivieren.
   *
   * Der Unterschied ist nicht akademisch: Ein Baumanbieter wird erst befragt,
   * wenn seine Ansicht sichtbar wird. Ein Fehler in getChildren oder im Aufbau
   * eines Knotens faellt deshalb bei blosser Aktivierung nicht auf - wohl aber
   * beim Anwender, der VS Code startet und die Seitenleiste sieht.
   */
  const EINSTELLUNG = 'rdp.connections';
  let vorher: unknown;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration();
    vorher = config.get(EINSTELLUNG);
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration()
      .update(EINSTELLUNG, vorher, vscode.ConfigurationTarget.Global);
  });

  test('die Ansicht laesst sich oeffnen, wenn keine Verbindung gespeichert ist', async () => {
    await vscode.workspace
      .getConfiguration()
      .update(EINSTELLUNG, [], vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.view.extension.rdp-explorer');
    // Kurz laufen lassen, damit der Baum tatsaechlich befragt wird.
    await new Promise((r) => setTimeout(r, 1500));
    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.equal(ext?.isActive, true, 'die Ansicht hat die Erweiterung aktiviert');
  });

  test('die Ansicht laesst sich mit gespeicherten Verbindungen oeffnen', async () => {
    // Absichtlich auch unvollstaendige Eintraege: die Baumknoten muessen mit
    // fehlendem Benutzer, fehlender Aufloesung und fehlendem Namen zurechtkommen.
    await vscode.workspace.getConfiguration().update(
      EINSTELLUNG,
      [
        { name: 'Voll', host: '10.0.0.1', port: 3390, username: 'tom', domain: 'WS', width: 1280, height: 800 },
        { name: 'Knapp', host: '10.0.0.2' },
        { name: '', host: '10.0.0.3', username: 'nur-benutzer' },
      ],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand('workbench.view.extension.rdp-explorer');
    await new Promise((r) => setTimeout(r, 1500));

    await vscode.commands.executeCommand('rdp.refreshConnections');
    await new Promise((r) => setTimeout(r, 500));

    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.equal(ext?.isActive, true, 'die Erweiterung lebt nach dem Aufbau des Baums noch');
  });

  test('fehlerhafte Eintraege in den Einstellungen legen die Ansicht nicht lahm', async () => {
    // Was in settings.json steht, kommt vom Anwender und kann alles sein.
    await vscode.workspace.getConfiguration().update(
      EINSTELLUNG,
      [
        null,
        {},
        { host: '' },
        { name: 'ok', host: '10.0.0.9' },
        { name: 'seltsam', host: '10.0.0.10', port: 'dreitausend' },
      ] as never,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand('workbench.view.extension.rdp-explorer');
    await vscode.commands.executeCommand('rdp.refreshConnections');
    await new Promise((r) => setTimeout(r, 1500));

    const ext = vscode.extensions.getExtension(ERWEITERUNG);
    assert.equal(ext?.isActive, true, 'die Erweiterung lebt noch');
  });
});
