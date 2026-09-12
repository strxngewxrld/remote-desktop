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
  const diagnose = document.getElementById('diagnose');
  const diagnoseTitel = document.getElementById('diagnose-titel');
  const diagnoseWerte = document.getElementById('diagnose-werte');

  let desktopWidth = canvas.width;
  let desktopHeight = canvas.height;
  let scaling = 'fit';
  let connected = false;
  let focused = false;
  /** Gedrueckte Tasten, um beim Fokusverlust alles sauber loszulassen. */
  const pressedKeys = new Set();
  let binaryWorks = true;
  /**
   * Soll die Desktopaufloesung der Panelgroesse folgen? Der Host entscheidet
   * das (Einstellung rdp.dynamicResolution) und sagt es im 'init'.
   */
  let dynamischeAufloesung = false;
  /** Ruhezeit in Millisekunden, bevor eine neue Groesse gemeldet wird. */
  let aufloesungsVerzug = 400;
  /** Laufender Entprell-Zeitgeber, oder null. */
  let aufloesungsTimer = null;
  /** Zuletzt gemeldete Buehnengroesse - dieselbe wird nicht zweimal geschickt. */
  let gemeldeteGroesse = null;
  /** Ab dieser Nutzlast lohnt der Umweg ueber Objekteigenschaften nicht mehr. */
  const OBJEKTWEG_GRENZE = 256 * 1024;

  /**
   * Zaehler des Diagnose-Overlays.
   *
   * Sie laufen nur, solange `diagAn` gesetzt ist. Im Zeichenpfad steht deshalb
   * nur eine Abfrage - was gemessen wird, wird erst beim Anzeigen gerechnet.
   */
  let diagAn = false;
  let diagUpdates = 0;
  let diagKacheln = 0;
  let diagBytes = 0;
  let diagLetztesBild = 0;
  /** Stand beim letzten Anzeigen - daraus ergeben sich die Raten. */
  let diagVorher = null;

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

  /** Die derzeitige Groesse der Buehne, auf ganze Pixel abgerundet. */
  function buehnenGroesse() {
    const rect = stage.getBoundingClientRect();
    return { width: Math.floor(rect.width), height: Math.floor(rect.height) };
  }

  /**
   * Eine neue Panelgroesse an den Host melden - entprellt.
   *
   * Beim Ziehen an der Fensterkante feuert 'resize' dutzende Male je Sekunde.
   * Jede davon zu melden hiesse, dem Server dutzende Aufloesungswechsel
   * zuzumuten; jeder einzelne verwirft serverseitig den Bildschirminhalt und
   * zieht ein volles neues Bild nach sich. Deshalb wird erst gemeldet, wenn es
   * `aufloesungsVerzug` Millisekunden lang ruhig geblieben ist.
   *
   * Das Skalieren der Anzeige laeuft davon unabhaengig weiter - layout() wird
   * sofort bei jedem Ereignis gerufen, damit das Bild waehrend des Ziehens
   * mitwaechst (unscharf) und erst danach scharf nachgezogen wird.
   */
  function meldeGroesse() {
    aufloesungsTimer = null;
    if (!dynamischeAufloesung) return;
    const groesse = buehnenGroesse();
    if (groesse.width < 1 || groesse.height < 1) return;
    if (gemeldeteGroesse && gemeldeteGroesse.width === groesse.width && gemeldeteGroesse.height === groesse.height) {
      return;
    }
    gemeldeteGroesse = groesse;
    vscode.postMessage({
      type: 'resizeRequest',
      width: groesse.width,
      height: groesse.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  function planeGroessenmeldung() {
    if (!dynamischeAufloesung) return;
    if (aufloesungsTimer !== null) clearTimeout(aufloesungsTimer);
    aufloesungsTimer = setTimeout(meldeGroesse, aufloesungsVerzug);
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

  // -------------------------------------------------------------- Diagnose

  /** Byteangabe in der Einheit, in der man sie noch lesen kann. */
  function mengeText(bytes) {
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function diagnoseZaehlerZuruecksetzen() {
    diagUpdates = 0;
    diagKacheln = 0;
    diagBytes = 0;
    diagLetztesBild = 0;
    diagVorher = null;
  }

  /**
   * Was nur hier messbar ist: was wirklich auf der Zeichenflaeche ankam.
   *
   * Der Host weiss, was er abgeschickt hat - ob es gezeichnet wurde, weiss nur
   * der Renderer. Weichen beide Zahlen auseinander, liegt der Verlust zwischen
   * Host und Zeichenflaeche und nicht im Protokoll.
   */
  function eigeneZeilen(jetzt) {
    const abstand = diagVorher ? jetzt - diagVorher.zeit : 0;
    const proSekunde = (zuwachs) => (abstand > 0 ? Math.round((zuwachs * 1000) / abstand) : 0);
    const zeilen = [];
    if (diagVorher && abstand > 0) {
      zeilen.push({
        name: 'Bildrate',
        wert:
          proSekunde(diagUpdates - diagVorher.updates) +
          ' Updates/s · ' +
          proSekunde(diagKacheln - diagVorher.kacheln) +
          ' Kacheln/s',
      });
      zeilen.push({
        name: 'Gezeichnet',
        wert:
          mengeText(diagBytes) +
          ' · ' +
          mengeText(((diagBytes - diagVorher.bytes) * 1000) / abstand) +
          '/s · ' +
          diagKacheln +
          ' Kacheln',
      });
    } else {
      zeilen.push({ name: 'Bildrate', wert: 'wird gemessen…' });
      zeilen.push({ name: 'Gezeichnet', wert: mengeText(diagBytes) + ' · ' + diagKacheln + ' Kacheln' });
    }
    zeilen.push({
      name: 'Zuletzt',
      wert: diagLetztesBild ? 'vor ' + (jetzt - diagLetztesBild) + ' ms' : 'nichts gezeichnet',
    });
    zeilen.push({
      name: 'Fläche',
      wert:
        canvas.width +
        '×' +
        canvas.height +
        ' → ' +
        (canvas.style.width || 'auto') +
        '×' +
        (canvas.style.height || 'auto') +
        ' · ' +
        (scaling === 'fit' ? 'eingepasst' : '1:1'),
    });
    return zeilen;
  }

  /**
   * Zeichnet das Overlay neu. Getaktet wird es vom Host (einmal je Sekunde) -
   * ein eigener Zeitgeber im Renderer waere eine zweite Uhr fuer dieselbe Sache.
   */
  function zeigeDiagnose(nachricht) {
    const jetzt = Date.now();
    const zeilen = (nachricht.zeilen || []).concat(eigeneZeilen(jetzt));
    let breite = 0;
    for (const zeile of zeilen) breite = Math.max(breite, zeile.name.length);
    let text = '';
    for (const zeile of zeilen) {
      text += (zeile.name + ':').padEnd(breite + 2) + zeile.wert + '\n';
    }
    diagnoseTitel.textContent = nachricht.titel || 'Diagnose';
    diagnoseWerte.textContent = text;
    diagVorher = { zeit: jetzt, updates: diagUpdates, kacheln: diagKacheln, bytes: diagBytes };
  }

  function setzeDiagnose(nachricht) {
    if (!nachricht.sichtbar) {
      diagAn = false;
      diagnose.hidden = true;
      diagnoseWerte.textContent = '';
      diagnoseZaehlerZuruecksetzen();
      return;
    }
    if (!diagAn) {
      // Frisch eingeschaltet: mit leeren Zaehlern anfangen, damit die erste
      // Rate nicht aus einem Zeitraum ohne Messung stammt.
      diagnoseZaehlerZuruecksetzen();
      diagAn = true;
    }
    diagnose.hidden = false;
    if (nachricht.zeilen) zeigeDiagnose(nachricht);
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
    if (diagAn) {
      diagUpdates++;
      diagKacheln += message.rects.length;
      diagBytes += bytes.length;
      diagLetztesBild = Date.now();
    }
    if (tilesDrawn > 0) vscode.postMessage({ type: 'painted', tiles: tilesDrawn });
  }


  // ------------------------------------------- H.264 ueber die WebCodecs-API

  /**
   * Der zweite Zeichenweg neben drawTiles - und ausdruecklich nur *neben*.
   *
   * RDP laeuft im Mischbetrieb: Text und Bedienoberflaeche kommen weiterhin
   * ueber ClearCodec, RemoteFX Progressive und Planar als fertige RGBA-Kacheln
   * herueber, nur bewegte Flaechen als H.264. Beide Wege malen auf dieselbe
   * Zeichenflaeche. Hier steht deshalb nichts, was den Kachelweg ersetzt; er
   * bleibt unveraendert und laeuft weiter, auch wenn hier alles scheitert.
   *
   * Solange keine einzige 'video'-Nachricht angekommen ist, ruehrt dieser
   * Abschnitt den Kachelweg nicht einmal an: `avcAktiv` bleibt falsch, und
   * 'bitmap' geht wie bisher unmittelbar und ohne Umweg in drawTiles.
   */

  /** Erst ab der ersten 'video'-Nachricht laeuft ueberhaupt etwas davon. */
  let avcAktiv = false;
  /** Der laufende Decoder, oder null solange keiner konfiguriert ist. */
  let avcDecoder = null;
  /** Aufgegeben? Dann bleibt es beim Kachelweg allein - wie vor diesem Feature. */
  let avcRueckfall = false;
  /** Vor dem ersten Schluesselbild darf nichts in den Decoder. */
  let avcHatteSchluesselbild = false;
  /** Fortlaufender Zeitstempel; H.264 braucht hier nur eine Reihenfolge. */
  let avcZeitstempel = 0;
  /** Gezeichnete Videobilder - fuer das Diagnose-Overlay. */
  let avcBilder = 0;
  /**
   * Die noch nicht ausgegebenen Bilder, in Dekodierreihenfolge. Jeder Eintrag
   * kennt seine Zeichenbereiche und den Haken, an dem die Warteschlange haengt.
   */
  const avcOffen = [];
  /**
   * Wie lange auf ein einzelnes Bild gewartet wird, bevor es uebergangen wird.
   * Ohne diese Schranke koennte ein haengender Decoder das *ganze* Bild
   * anhalten, auch die Kacheln der uebrigen Codecs.
   */
  const AVC_WARTE_MS = 1000;

  /**
   * Reihenfolgetreue Abarbeitung.
   *
   * Kacheln kommen fertig an und werden sofort gezeichnet, Videobilder muessen
   * erst durch einen asynchronen Decoder. Ohne diese Kette wuerde eine spaeter
   * eingetroffene Kachel ein frueheres Videobild ueberholen und aelteren Inhalt
   * ueber neueren malen. Die Kette gilt erst ab dem ersten Videobild.
   */
  let avcKette = Promise.resolve();
  function avcReihen(fn) {
    avcKette = avcKette.then(fn).catch((err) => {
      vscode.postMessage({ type: 'drawError', message: 'AVC: ' + String(err) });
    });
  }

  /** Gibt H.264 auf und meldet es einmal an den Host. */
  function avcGibAuf(grund) {
    if (avcRueckfall) return;
    avcRueckfall = true;
    try {
      if (avcDecoder && avcDecoder.state !== 'closed') avcDecoder.close();
    } catch (err) {
      // Ein Decoder, den man nicht mehr schliessen kann, ist ohnehin hin.
    }
    avcDecoder = null;
    // Alles, was noch wartet, freigeben - sonst haengt die Kette fuer immer.
    while (avcOffen.length) avcOffen.shift().aufloesen();
    vscode.postMessage({ type: 'avcRueckfall', message: grund });
  }

  /** Ist WebCodecs ueberhaupt da? Grobpruefung, ohne Codecnamen. */
  function avcWebCodecsDa() {
    return (
      typeof window.VideoDecoder === 'function' &&
      typeof window.VideoDecoder.isConfigSupported === 'function' &&
      typeof window.EncodedVideoChunk === 'function'
    );
  }

  /** Nimmt ein fertiges Bild entgegen und malt seine Bereiche. */
  function avcAusgabe(bild) {
    const eintrag = avcOffen.shift();
    try {
      if (eintrag && !eintrag.verfallen) {
        for (const b of eintrag.bereiche) {
          // Quelle in Bildkoordinaten, Ziel in Bildschirmkoordinaten. Das
          // dekodierte Bild liegt am Surface-Ursprung, nicht am destRect.
          ctx.drawImage(bild, b.sx, b.sy, b.breite, b.hoehe, b.zx, b.zy, b.breite, b.hoehe);
        }
        if (eintrag.bereiche.length > 0) avcBilder++;
      }
    } catch (err) {
      vscode.postMessage({ type: 'drawError', message: 'AVC-Zeichnen: ' + String(err) });
    } finally {
      // Ein VideoFrame haelt Speicher der Grafikkarte fest. Wer ihn nicht
      // schliesst, bringt den Decoder nach wenigen Sekunden zum Stillstand.
      try {
        bild.close();
      } catch (err) {
        /* schon geschlossen */
      }
      if (eintrag) eintrag.aufloesen();
    }
  }

  /**
   * Sorgt fuer einen konfigurierten Decoder.
   *
   * Die drei Stellen, an denen so etwas erfahrungsgemaess scheitert, sind hier
   * bewusst alle benannt:
   *
   * 1. Kein `description` in der Konfiguration. Der Server schickt laut
   *    MS-RDPEGFX 2.2.4.4 Annex-B-Daten, also NAL-Einheiten mit Startcodes.
   *    `description` gehoert zum AVCC-Format mit Laengenpraefixen; wer es bei
   *    Annex B setzt, bekommt einen Decoder, der stumm nichts ausgibt.
   * 2. SPS und PPS muessen vor dem ersten Bild da sein. Deshalb wird gar nicht
   *    erst konfiguriert, solange der Host meldet, dass in diesem Happen keine
   *    Parametersaetze stecken - der Codecname kaeme sonst auch nicht zustande.
   * 3. Der Codecname muss zum Strom passen. `isConfigSupported` beantwortet
   *    das, und zwar bevor irgendetwas dekodiert wird.
   */
  async function avcDecoderBereit(nachricht) {
    if (avcRueckfall) return false;
    if (avcDecoder) return true;

    if (!avcWebCodecsDa()) {
      avcGibAuf('WebCodecs (VideoDecoder) steht in diesem Webview nicht zur Verfügung.');
      return false;
    }
    if (!nachricht.hatParametersaetze || !nachricht.codecString) {
      // Noch kein SPS/PPS gesehen. Nicht aufgeben - der Server schickt in
      // Kuerze ein Schluesselbild, das beides mitbringt.
      return false;
    }

    const konfiguration = { codec: nachricht.codecString, optimizeForLatency: true };
    let antwort;
    try {
      antwort = await window.VideoDecoder.isConfigSupported(konfiguration);
    } catch (err) {
      avcGibAuf('WebCodecs lehnt die Konfiguration ab: ' + String(err));
      return false;
    }
    if (!antwort || !antwort.supported) {
      avcGibAuf('Der Codec ' + nachricht.codecString + ' wird von diesem Webview nicht unterstützt.');
      return false;
    }

    try {
      avcDecoder = new window.VideoDecoder({
        output: avcAusgabe,
        error: (err) => avcGibAuf('Decoderfehler: ' + String(err && err.message ? err.message : err)),
      });
      avcDecoder.configure(konfiguration);
    } catch (err) {
      avcDecoder = null;
      avcGibAuf('Der Decoder liess sich nicht einrichten: ' + String(err));
      return false;
    }
    return true;
  }

  /** Eine 'video'-Nachricht: dekodieren und die Bereiche zeichnen. */
  async function verarbeiteVideo(nachricht) {
    if (avcRueckfall) return;

    const bytes = toBytes(nachricht.data, nachricht.laenge);
    if (!bytes) {
      meldeBinaerUmweg();
      return;
    }
    if (!(await avcDecoderBereit(nachricht))) return;

    // Ein Folgebild ohne vorangegangenes Schluesselbild hat kein Bezugsbild.
    // Es hineinzugeben liefert je nach Decoder Muell oder einen Fehler.
    if (!avcHatteSchluesselbild) {
      if (!nachricht.schluesselbild) return;
      avcHatteSchluesselbild = true;
    }

    const eintrag = { bereiche: nachricht.bereiche || [], verfallen: false, aufloesen: () => {} };
    const fertig = new Promise((res) => {
      eintrag.aufloesen = res;
    });
    avcOffen.push(eintrag);

    try {
      avcDecoder.decode(
        new window.EncodedVideoChunk({
          // 'key' und 'delta' muessen stimmen: der Host hat dafuer den
          // Bitstream nach einer IDR-Scheibe abgesucht, ein SPS allein zaehlt
          // dort ausdruecklich nicht.
          type: nachricht.schluesselbild ? 'key' : 'delta',
          timestamp: avcZeitstempel++,
          data: bytes,
        }),
      );
    } catch (err) {
      avcOffen.shift();
      eintrag.aufloesen();
      avcGibAuf('Der Bitstrom liess sich nicht übergeben: ' + String(err));
      return;
    }

    // Auf das Bild warten, damit nachfolgende Kacheln es nicht ueberholen -
    // aber nicht unbegrenzt. Bleibt es aus, wird der Eintrag entwertet und der
    // Kachelweg laeuft weiter; das Videobild fehlt dann, das Bild friert nicht.
    let wecker;
    await Promise.race([
      fertig,
      new Promise((res) => {
        wecker = setTimeout(() => {
          eintrag.verfallen = true;
          vscode.postMessage({ type: 'drawError', message: 'AVC: Bild blieb über ' + AVC_WARTE_MS + ' ms aus' });
          res();
        }, AVC_WARTE_MS);
      }),
    ]);
    clearTimeout(wecker);
    if (diagAn) {
      diagUpdates++;
      diagBytes += bytes.length;
      diagLetztesBild = Date.now();
    }
    vscode.postMessage({ type: 'painted', tiles: avcBilder });
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

  window.addEventListener('resize', () => {
    // Sofort neu skalieren, damit das Bild waehrend des Ziehens mitgeht ...
    layout();
    // ... und erst nach der Ruhephase eine scharfe Aufloesung anfragen.
    planeGroessenmeldung();
  });

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
        if (typeof message.dynamicResolution === 'boolean') dynamischeAufloesung = message.dynamicResolution;
        if (typeof message.resizeDelay === 'number' && message.resizeDelay >= 0) {
          aufloesungsVerzug = message.resizeDelay;
        }
        // Der Server hat gerade eine Groesse bestaetigt. Sie gilt jetzt als
        // gemeldet, sonst schickt die naechste Ruhephase dieselbe Bitte erneut.
        //
        // Nur, wenn gerade keine Meldung ansteht: sonst verschluckt eine
        // Bestaetigung, die waehrend des Ziehens eintrifft, genau die
        // Groessenaenderung, auf die der Nutzer noch wartet.
        if (aufloesungsTimer === null) gemeldeteGroesse = buehnenGroesse();
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
        // Der unveraenderte Weg: solange keine einzige 'video'-Nachricht kam,
        // wird unmittelbar gezeichnet, ohne Warteschlange und ohne Promise.
        if (avcAktiv) avcReihen(() => drawTiles(message));
        else drawTiles(message);
        break;

      case 'video':
        // Ab hier laufen beide Wege durch dieselbe Reihe, damit eine Kachel
        // kein aelteres Videobild ueberholt.
        avcAktiv = true;
        avcReihen(() => verarbeiteVideo(message));
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

      case 'diagnose':
        setzeDiagnose(message);
        break;

      case 'diagnosePing':
        // Sofort und ohne Umweg antworten: gemessen werden soll der Weg
        // Host -> Renderer -> Host, nicht die eigene Rechenzeit.
        vscode.postMessage({ type: 'diagnosePong', seq: message.seq });
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
    // Grobpruefung, noch ohne Codecnamen: gibt es die WebCodecs-API ueberhaupt?
    // Der Host entscheidet damit, ob er H.264 beim Server anmeldet - lieber gar
    // nicht erst anmelden als spaeter leere Bildbereiche erklaeren muessen.
    // Ob auch der konkrete Codec geht, sagt erst isConfigSupported beim ersten
    // Teilbild.
    webCodecs: avcWebCodecsDa(),
  });
})();
