/* global acquireVsCodeApi */
// Darstellungs- und Eingabeschicht der RDP-Sitzung.
// Laeuft isoliert im Webview; die eigentliche Protokollarbeit macht der
// Extension-Host und schickt fertige RGBA-Kacheln herueber.
(function () {
  const vscode = acquireVsCodeApi();

  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d', { alpha: false });
  const stage = document.getElementById('stage');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayMessage = document.getElementById('overlay-message');
  const overlayAction = document.getElementById('overlay-action');
  const spinner = document.getElementById('spinner');
  const hint = document.getElementById('hint');

  let desktopWidth = canvas.width;
  let desktopHeight = canvas.height;
  let scaling = 'fit';
  let connected = false;
  let focused = false;
  /** Gedrueckte Tasten, um beim Fokusverlust alles sauber loszulassen. */
  const pressedKeys = new Set();
  let binaryWorks = true;
  /** Ab dieser Nutzlast lohnt der Umweg ueber Objekteigenschaften nicht mehr. */
  const OBJEKTWEG_GRENZE = 256 * 1024;

  // ---------------------------------------------------------------- Hilfen

  /**
   * VS Code serialisiert Webview-Nachrichten je nach Version unterschiedlich.
   * Diese Funktion akzeptiert alle Varianten, in denen Binaerdaten ankommen
   * koennen - und meldet nach oben, falls nur Base64 funktioniert.
   *
   * `erwartet` ist die Zahl der Bytes, die der Aufrufer aus den Kachelangaben
   * ohnehin kennt. Sie ist wichtig fuer den Fall, dass die Binaerdaten als
   * einfaches Objekt mit numerischen Schluesseln ankommen: Frueher wurde dessen
   * Laenge ueber Object.keys ermittelt, was bei einer Vollbildnachricht ueber
   * zwei Millionen Zeichenketten erzeugt und je eine Regex darauf laufen laesst.
   * Das hat den Renderer-Prozess sekundenlang blockiert und bei genuegend
   * grossen Nachrichten das ganze Fenster mitgerissen. Mit der bekannten Laenge
   * ist kein einziger Schluessel noetig.
   */
  function toBytes(data, erwartet) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data === 'string') return base64ToBytes(data);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return new Uint8Array(data.data);
    if (data && typeof data === 'object') {
      // Eigene Laengenangabe bevorzugen, sonst die des Aufrufers.
      const laenge = typeof data.length === 'number' ? data.length : erwartet;
      if (!laenge || typeof data[0] !== 'number') return null;
      // Jeder Wert steckt hier in einer eigenen Objekteigenschaft; das
      // auszulesen kostet bei einer Vollbildnachricht ueber eine halbe Sekunde,
      // in der der Renderer nichts anderes tut. Ueber dieser Grenze wird der
      // Rahmen lieber verworfen: der Host stellt auf Base64 um und fordert
      // sofort ein neues Vollbild an, das dann in Millisekunden ankommt.
      if (laenge > OBJEKTWEG_GRENZE) {
        meldeBinaerUmweg();
        return null;
      }
      const out = new Uint8Array(laenge);
      for (let i = 0; i < laenge; i++) out[i] = data[i];
      meldeBinaerUmweg();
      return out;
    }
    return null;
  }

  /** Bittet den Host einmalig, kuenftig Base64 zu schicken. */
  function meldeBinaerUmweg() {
    if (!binaryWorks) return;
    binaryWorks = false;
    vscode.postMessage({ type: 'binaryUnsupported' });
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function layout() {
    if (scaling === 'fit') {
      stage.classList.remove('scroll');
      const available = stage.getBoundingClientRect();
      const scale = Math.min(available.width / desktopWidth, available.height / desktopHeight, 1);
      canvas.style.width = Math.floor(desktopWidth * scale) + 'px';
      canvas.style.height = Math.floor(desktopHeight * scale) + 'px';
    } else {
      stage.classList.add('scroll');
      canvas.style.width = desktopWidth + 'px';
      canvas.style.height = desktopHeight + 'px';
    }
  }

  /** Bildschirmkoordinaten des Remote-Desktops aus einem Mausereignis. */
  function remotePoint(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * desktopWidth;
    const y = ((event.clientY - rect.top) / rect.height) * desktopHeight;
    return {
      x: Math.max(0, Math.min(desktopWidth - 1, Math.round(x))),
      y: Math.max(0, Math.min(desktopHeight - 1, Math.round(y))),
    };
  }

  function showOverlay(title, message, actionLabel) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message || '';
    overlay.classList.add('visible');
    spinner.hidden = !!actionLabel;
    overlayAction.hidden = !actionLabel;
    if (actionLabel) overlayAction.textContent = actionLabel;
  }

  function hideOverlay() {
    overlay.classList.remove('visible');
  }

  function flashHint() {
    hint.hidden = false;
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 2200);
  }

  // ----------------------------------------------------------- Darstellung

  let tilesDrawn = 0;

  function drawTiles(message) {
    // Die Gesamtlaenge steht in den Kachelangaben - der letzte Eintrag endet am
    // Ende der Nutzdaten.
    let erwartetGesamt = 0;
    for (const tile of message.rects) erwartetGesamt = Math.max(erwartetGesamt, tile.offset + tile.length);

    const bytes = toBytes(message.data, erwartetGesamt);
    if (!bytes) {
      meldeBinaerUmweg();
      return;
    }
    for (const tile of message.rects) {
      const slice = bytes.subarray(tile.offset, tile.offset + tile.length);
      const erwartet = tile.w * tile.h * 4;
      if (slice.length !== erwartet) {
        // Lieber diese eine Kachel auslassen als die ganze Schleife abbrechen.
        vscode.postMessage({
          type: 'drawError',
          message: `Kachel ${tile.w}x${tile.h} hat ${slice.length} statt ${erwartet} Byte`,
        });
        continue;
      }
      try {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(slice), tile.w, tile.h), tile.x, tile.y);
        tilesDrawn++;
      } catch (err) {
        vscode.postMessage({ type: 'drawError', message: String(err) });
      }
    }
    if (tilesDrawn > 0) vscode.postMessage({ type: 'painted', tiles: tilesDrawn });
  }

  function applyPointer(message) {
    const bytes = toBytes(message.data, message.width * message.height * 4);
    if (!bytes) return;
    const buffer = document.createElement('canvas');
    buffer.width = message.width;
    buffer.height = message.height;
    buffer
      .getContext('2d')
      .putImageData(new ImageData(new Uint8ClampedArray(bytes), message.width, message.height), 0, 0);
    // CSS-Cursor akzeptiert nur URLs, also den Zeiger als PNG einbetten.
    canvas.style.cursor = `url(${buffer.toDataURL('image/png')}) ${message.hotspotX} ${message.hotspotY}, default`;
  }

  // -------------------------------------------------------------- Eingaben

  const BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right', 3: 'back', 4: 'forward' };

  canvas.addEventListener('mousemove', (event) => {
    if (!connected) return;
    const p = remotePoint(event);
    vscode.postMessage({ type: 'mouse', kind: 'move', x: p.x, y: p.y });
  });

  canvas.addEventListener('mousedown', (event) => {
    event.preventDefault();
    canvas.focus();
    if (!connected) return;
    const p = remotePoint(event);
    vscode.postMessage({ type: 'mouse', kind: 'button', button: BUTTON_MAP[event.button], down: true, x: p.x, y: p.y });
  });

  window.addEventListener('mouseup', (event) => {
    if (!connected) return;
    const p = remotePoint(event);
    vscode.postMessage({ type: 'mouse', kind: 'button', button: BUTTON_MAP[event.button], down: false, x: p.x, y: p.y });
  });

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!connected) return;
      event.preventDefault();
      const p = remotePoint(event);
      // RDP erwartet Vielfache von 120 ("ein Rastschritt").
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = horizontal ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      vscode.postMessage({
        type: 'mouse',
        kind: 'wheel',
        x: p.x,
        y: p.y,
        horizontal,
        // Nach unten scrollen ist im Protokoll negativ.
        delta: delta > 0 ? -120 : 120,
      });
    },
    { passive: false },
  );

  canvas.addEventListener('focus', () => {
    focused = true;
    canvas.classList.add('focused');
    vscode.postMessage({ type: 'focus', focused: true });
    if (connected) flashHint();
  });

  canvas.addEventListener('blur', () => {
    focused = false;
    canvas.classList.remove('focused');
    releaseAllKeys();
    vscode.postMessage({ type: 'focus', focused: false });
  });

  function releaseAllKeys() {
    for (const code of pressedKeys) {
      vscode.postMessage({ type: 'key', code, down: false });
    }
    pressedKeys.clear();
  }

  /** Tasten, die VS Code selbst braucht und die wir nicht abfangen. */
  function passThroughToVsCode(event) {
    // Strg+Umschalt+P und F1 bleiben der Befehlspalette vorbehalten.
    if (event.key === 'F1') return true;
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyP') return true;
    return false;
  }

  window.addEventListener('keydown', (event) => {
    if (!focused || !connected) return;
    if (passThroughToVsCode(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pressedKeys.add(event.code);
    vscode.postMessage({
      type: 'key',
      code: event.code,
      key: event.key,
      down: true,
      repeat: event.repeat,
      modifiers: {
        capsLock: event.getModifierState('CapsLock'),
        numLock: event.getModifierState('NumLock'),
        scrollLock: event.getModifierState('ScrollLock'),
      },
    });
  });

  window.addEventListener('keyup', (event) => {
    if (!focused || !connected) return;
    if (passThroughToVsCode(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pressedKeys.delete(event.code);
    vscode.postMessage({ type: 'key', code: event.code, key: event.key, down: false });
  });

  window.addEventListener('blur', releaseAllKeys);

  overlayAction.addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));

  window.addEventListener('resize', layout);

  // -------------------------------------------------- Nachrichten vom Host

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        desktopWidth = message.width;
        desktopHeight = message.height;
        // Eine Zuweisung an canvas.width loescht den Inhalt - auch bei
        // gleichem Wert. Deshalb nur anfassen, wenn sich die Groesse
        // tatsaechlich aendert, sonst wischt ein wiederholtes 'init' das
        // bereits gezeichnete Bild weg.
        if (canvas.width !== message.width || canvas.height !== message.height) {
          canvas.width = message.width;
          canvas.height = message.height;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        scaling = message.scaling || 'fit';
        canvas.classList.toggle('smooth', !!message.smooth);
        layout();
        break;

      case 'config':
        if (message.scaling) scaling = message.scaling;
        if (typeof message.smooth === 'boolean') canvas.classList.toggle('smooth', message.smooth);
        layout();
        break;

      case 'state':
        // Im Zustand 'waiting' steht die Verbindung bereits - Eingaben sind
        // erlaubt (eine Mausbewegung kann das erste Bild ausloesen), die
        // Einblendung bleibt aber sichtbar, bis wirklich etwas gezeichnet wurde.
        connected = message.state === 'connected' || message.state === 'waiting';
        if (message.state === 'connected') {
          hideOverlay();
          canvas.focus();
        } else {
          showOverlay(message.title, message.message, message.action);
          if (message.state === 'waiting') canvas.focus();
          else releaseAllKeys();
        }
        break;

      case 'bitmap':
        drawTiles(message);
        break;

      case 'pointer':
        applyPointer(message);
        break;

      case 'pointerHidden':
        canvas.style.cursor = 'none';
        break;

      case 'pointerDefault':
        canvas.style.cursor = 'default';
        break;
    }
  });

  // Groesse melden, damit der Host die Sitzung passend aufloest.
  const rect = stage.getBoundingClientRect();
  vscode.postMessage({
    type: 'ready',
    width: Math.floor(rect.width),
    height: Math.floor(rect.height),
    devicePixelRatio: window.devicePixelRatio || 1,
  });
})();
