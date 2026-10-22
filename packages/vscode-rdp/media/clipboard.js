/* global acquireVsCodeApi */
// Rueckfallebene fuer die Zwischenablage: ein einblendbares Textfeld.
//
// Warum das noetig ist: Der direkte Weg laeuft ueber `vscode.env.clipboard` im
// Extension-Host. Faellt der aus - manche Remote- und Web-Umgebungen liefern
// dort einen Fehler, und im Webview verliert die Async Clipboard API des
// Browsers die Benutzergeste -, ginge der Text sonst verloren. noVNC,
// Guacamole und Kasm haben unabhaengig voneinander dasselbe Feld gebaut.
//
// In beide Richtungen:
//  - vom Server: der Text steht im Feld; "Kopieren" legt ihn in die
//    Zwischenablage des Browsers, und zwar im Klick selbst, also mit gueltiger
//    Benutzergeste. Geht auch das nicht, wird der Text markiert und der
//    Anwender drueckt selbst Strg+C bzw. Cmd+C.
//  - zum Server: hineinschreiben oder einfuegen, dann "Senden".
//
// Dieses Skript wird *vor* media/main.js geladen und reicht die Bruecke zum
// Extension-Host weiter (siehe unten): `acquireVsCodeApi()` laesst sich nur
// einmal je Webview aufrufen.
(function () {
  const vscode = acquireVsCodeApi();
  // main.js ruft dieselbe Funktion auf. Ohne diesen Ersatz bekaeme es einen
  // Fehler ("An instance of the VS Code API has already been acquired") und
  // das ganze Webview bliebe schwarz.
  window.acquireVsCodeApi = function () {
    return vscode;
  };

  const panel = document.getElementById('clipboard-panel');
  const feld = document.getElementById('clipboard-text');
  const senden = document.getElementById('clipboard-send');
  const kopieren = document.getElementById('clipboard-copy');
  const schliessen = document.getElementById('clipboard-close');
  const status = document.getElementById('clipboard-status');
  // Ohne die Elemente (etwa in einer aelteren Webview-Vorlage) tut dieses
  // Skript nichts weiter, als die Bruecke bereitzustellen.
  if (!panel || !feld) return;

  /** Richtung aus den Einstellungen: 'both' | 'remoteToLocal' | 'localToRemote'. */
  let richtung = 'both';
  let aktiv = true;

  function melde(text, dauerhaft) {
    if (!status) return;
    status.textContent = text;
    // Die Zeile kuerzt mit Auslassungspunkten - der volle Text bleibt erreichbar.
    status.title = text;
    if (dauerhaft) return;
    setTimeout(() => {
      if (status.textContent === text) {
        status.textContent = '';
        status.title = '';
      }
    }, 4000);
  }

  function zeige(sichtbar) {
    panel.hidden = !sichtbar;
    if (sichtbar) {
      feld.focus();
      feld.select();
    }
    vscode.postMessage({ type: 'clipboardPanel', sichtbar: sichtbar });
  }

  function aktualisiereKnoepfe() {
    const darfSenden = aktiv && (richtung === 'both' || richtung === 'localToRemote');
    const darfLesen = aktiv && (richtung === 'both' || richtung === 'remoteToLocal');
    if (senden) {
      senden.disabled = !darfSenden;
      senden.title = darfSenden
        ? 'Den Feldinhalt in die Zwischenablage der Sitzung legen'
        : 'Von hier in die Sitzung zu schreiben ist in den Einstellungen abgeschaltet';
    }
    if (kopieren) {
      kopieren.disabled = !darfLesen;
    }
    feld.readOnly = !aktiv;
  }

  // ------------------------------------------------------- Bedienelemente

  if (senden) {
    senden.addEventListener('click', () => {
      const text = feld.value;
      if (!text) {
        melde('Das Feld ist leer.');
        return;
      }
      vscode.postMessage({ type: 'clipboardSend', text: text });
      melde('An die Sitzung gesendet.');
    });
  }

  if (kopieren) {
    kopieren.addEventListener('click', () => {
      const text = feld.value;
      // Der Aufruf steht bewusst direkt im Klick: nur dort gilt die
      // Benutzergeste, die der Browser fuer den Schreibzugriff verlangt.
      const versuch = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('Keine Clipboard-API'));
      versuch.then(
        () => melde('In die lokale Zwischenablage kopiert.'),
        () => {
          // Letzte Stufe: markieren und den Anwender selbst kopieren lassen.
          feld.focus();
          feld.select();
          melde('Kopieren war nicht erlaubt – der Text ist markiert, bitte Strg+C bzw. Cmd+C drücken.', true);
        },
      );
    });
  }

  if (schliessen) schliessen.addEventListener('click', () => zeige(false));

  feld.addEventListener('keydown', (event) => {
    // Escape schliesst; Strg/Cmd+Enter sendet - Tastaturereignisse im Feld
    // duerfen nicht als Eingabe an die Sitzung gehen.
    if (event.key === 'Escape') {
      event.stopPropagation();
      zeige(false);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.stopPropagation();
      event.preventDefault();
      if (senden && !senden.disabled) senden.click();
    }
    // Alles andere bleibt im Feld: main.js horcht auf dem Canvas, nicht hier.
  });

  // ---------------------------------------------------- Nachrichten vom Host

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    switch (message.type) {
      case 'clipboardText':
        feld.value = typeof message.text === 'string' ? message.text : '';
        if (message.fallback) {
          // Der direkte Weg ist gescheitert - ohne Einblendung waere der Text
          // weg, ohne dass es jemand merkt.
          zeige(true);
          melde('Der direkte Weg in die Zwischenablage hat nicht geklappt.', true);
        }
        break;

      case 'clipboardPanel':
        zeige(!!message.sichtbar);
        break;

      case 'clipboardConfig':
        aktiv = message.aktiv !== false;
        richtung = message.richtung || 'both';
        aktualisiereKnoepfe();
        if (!aktiv) zeige(false);
        break;
    }
  });

  aktualisiereKnoepfe();
})();
