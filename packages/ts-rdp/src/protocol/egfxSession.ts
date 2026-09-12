/**
 * Sitzungsschicht der Graphics Pipeline.
 *
 * Sie haelt das, was MS-RDPEGFX den Graphics Output Buffer nennt: eine Menge
 * von Surfaces, von denen einige auf den Bildschirm abgebildet sind. Der Server
 * schreibt Bildinhalte in Surfaces, verschiebt zwischen ihnen und legt Teile im
 * Cache ab; erst die Abbildung auf den Ausgabebereich macht daraus ein Bild.
 *
 * Nach aussen faellt dabei dasselbe heraus wie beim klassischen Weg: RGBA-
 * Kacheln mit Bildschirmkoordinaten. Die Anzeige merkt nicht, welcher Weg
 * benutzt wurde.
 */
import { Logger } from '../core/log.js';
import { DecodedBitmap } from './updates.js';
import { planarDecompress } from '../codec/planar.js';
import { ClearCodecDecoder } from '../codec/clear.js';
import { ProgressiveDecoder } from '../codec/progressive.js';
import * as avc from '../codec/avcMeta.js';
import { analysiereBitstrom, AvcBitstromAnalyse, AvcSurfaceLage } from '../codec/avcFrame.js';
import * as egfx from './egfx.js';

/** Eine Surface: Zeichenflaeche des Servers, RGBA von oben nach unten. */
interface Surface {
  width: number;
  height: number;
  pixelFormat: number;
  rgba: Uint8ClampedArray;
  /** Position auf dem Bildschirm, falls abgebildet. */
  output?: { x: number; y: number };
  /**
   * Wurde in diese Surface schon etwas geschrieben? Eine frisch angelegte
   * Surface ist komplett schwarz - die beim Abbilden auszugeben hiesse, beim
   * Sitzungsstart garantiert eine schwarze Vollflaeche zu zeichnen, bevor der
   * erste echte Inhalt kommt.
   */
  beschrieben: boolean;
  /**
   * Hat H.264 in diese Surface hineingemalt?
   *
   * Die AVC-Pixel entstehen im Webview und landen deshalb *nicht* in `rgba` -
   * dieser Puffer ist an diesen Stellen schwarz. Wer ihn danach noch einmal
   * vollstaendig ausgibt, loescht das Videobild vom Bildschirm. Dieses Merkmal
   * verhindert genau das.
   */
  avcBeschrieben: boolean;
}

/**
 * Ein H.264-Teilbild, so wie es vom Draht kommt.
 *
 * Bewusst *nicht* dekodiert: H.264 gehoert nicht in diese Bibliothek. Die
 * VS-Code-Webview laeuft in Chromium und hat mit WebCodecs einen fertigen,
 * hardwarebeschleunigten Decoder; unter reinem Node (etwa im Messskript) gibt
 * es keinen, und dort bleibt es bei der Statistik. Die Bibliothek reicht darum
 * den Bitstream durch, statt einen Decoder zu versprechen, den sie nicht hat.
 */
export interface EgfxVideoFrame {
  surfaceId: number;
  /** RDPGFX_CODECID_AVC420, _AVC444 oder _AVC444V2. */
  codecId: number;
  /** Zielbereich auf der Surface. */
  destRect: { left: number; top: number; right: number; bottom: number };
  /** YUV420-Teilrahmen. Fehlt nur bei AVC444 mit LC = 0x2. */
  yuv420?: avc.Avc420Stream;
  /** Chroma420-Teilrahmen; nur bei AVC444 und nur, wenn LC ihn ankuendigt. */
  chroma420?: avc.Avc420Stream;
  /** Rohwert des LC-Felds; bei AVC420 nicht belegt. */
  lc?: number;
  /**
   * Lage und Groesse der Ziel-Surface.
   *
   * Der Decoder steht im Webview und kennt die Surfaces nicht. Er braucht sie
   * aber, denn die regionRects sind surface-relativ und das dekodierte Bild
   * liegt am Surface-Ursprung - ohne diese Angabe koennte er das Bild nicht
   * auf dem Bildschirm platzieren.
   */
  surface: AvcSurfaceLage;
  /**
   * Ist die Surface ueberhaupt auf den Ausgabebereich abgebildet? Wenn nicht,
   * gehoert nichts davon auf den Bildschirm; `outputX`/`outputY` sind dann
   * bedeutungslos.
   */
  abgebildet: boolean;
  /**
   * Was im Bitstream des YUV420-Teilrahmens steht: Codecname, Schluesselbild,
   * Parametersaetze. Fehlt genau dann, wenn auch `yuv420` fehlt.
   */
  analyse?: AvcBitstromAnalyse;
}

export interface EgfxSessionOptions {
  log: Logger;
  /** Verschickt eine fertige EGFX-Nachricht (ZGFX-Verpackung macht der Aufrufer). */
  send: (pdu: Buffer) => void;
  /** Fertige Kacheln fuer die Anzeige. */
  onBitmap: (tiles: DecodedBitmap[]) => void;
  /** Der Server gibt eine neue Desktopgroesse vor. */
  onResize: (size: { width: number; height: number }) => void;
  /**
   * Welche Capability-Sets angeboten werden. Ohne Angabe wird der
   * konservativste Satz benutzt, der noch etwas dekodierbares liefern kann.
   */
  capsSets?: egfx.EgfxCapsSet[];
  /**
   * Nimmt H.264-Teilbilder entgegen. Fehlt der Rueckruf, werden sie nur
   * gezaehlt - die Sitzung laeuft weiter, das Bild bleibt an diesen Stellen leer.
   */
  onVideo?: (frame: EgfxVideoFrame) => void;
  /**
   * Wird fuer jede Kachel aufgerufen, deren Codec wir nicht dekodieren koennen.
   * Dient dazu, echte Nutzlast eines Servers als Testmaterial zu sichern.
   */
  onUnbekannteKachel?: (info: { codecId: number; width: number; height: number; data: Buffer }) => void;
  /**
   * Wird fuer *jede* Kachel aufgerufen, samt Lage und Rohdaten. Dient der
   * Fehlersuche an Bildfehlern: damit laesst sich die Kachel, die ein Artefakt
   * enthaelt, herausgreifen und einzeln untersuchen.
   */
  onRohkachel?: (info: {
    codecId: number;
    surfaceId: number;
    rect: { left: number; top: number; right: number; bottom: number };
    data: Buffer;
  }) => void;
}

/**
 * Voreinstellung: V8 und V8.1 ohne jedes Flag.
 *
 * Kein THINCLIENT: das Flag weist den Server an, RemoteFX statt RemoteFX
 * Progressive zu verwenden - und RemoteFX ist in neueren Windows-Versionen
 * entfernt worden, woraufhin dessen Grafik-Subsystem mit
 * ERRINFO_GRAPHICSSUBSYSTEMFAILED (0x112F) aussteigt.
 *
 * Kein AVC-Flag und keine Version ab 10: dort bedeutet ein *nicht* gesetztes
 * AVC_DISABLED die Zusage, H.264 in YUV444 zu beherrschen.
 */
export const DEFAULT_EGFX_CAPS: egfx.EgfxCapsSet[] = [
  { version: egfx.RDPGFX_CAPVERSION_8, flags: 0 },
  { version: egfx.RDPGFX_CAPVERSION_81, flags: 0 },
];

/**
 * Derselbe Satz, nur mit angemeldetem H.264 in YUV420p.
 *
 * Warum genau diese beiden Flags: MS-RDPEGFX 2.2.3.2 zaehlt fuer das
 * flags-Feld von RDPGFX_CAPSET_VERSION81 die erlaubten Kombinationen auf, und
 * AVC420_ENABLED kommt dort ausschliesslich zusammen mit SMALL_CACHE vor
 * ("SMALL_CACHE | AVC420_ENABLED" bzw. dasselbe noch mit THINCLIENT).
 * AVC420_ENABLED allein steht nicht in der Liste.
 *
 * THINCLIENT bleibt weg - es weist den Server auf RemoteFX statt RemoteFX
 * Progressive, und RemoteFX ist in neueren Windows-Versionen entfernt; deren
 * Grafik-Subsystem steigt dann mit ERRINFO_GRAPHICSSUBSYSTEMFAILED aus.
 *
 * Ebenso bewusst *keine* Version ab 10: dort bedeutet ein nicht gesetztes
 * AVC_DISABLED die Zusage, H.264 auch in YUV444 zu koennen. Solange nur 420
 * gebaut ist, waere das eine Luege, die der Server beim Wort nimmt.
 *
 * V8 ohne Flags bleibt als Rueckfall im Satz: waehlt der Server es aus, laeuft
 * alles wie bisher ueber ClearCodec, Progressive und Planar weiter.
 */
export const AVC420_EGFX_CAPS: egfx.EgfxCapsSet[] = [
  { version: egfx.RDPGFX_CAPVERSION_8, flags: 0 },
  {
    version: egfx.RDPGFX_CAPVERSION_81,
    flags: egfx.RDPGFX_CAPS_FLAG_SMALL_CACHE | egfx.RDPGFX_CAPS_FLAG_AVC420_ENABLED,
  },
];

export class EgfxSession {
  private readonly surfaces = new Map<number, Surface>();
  /** Cacheeintraege: Slot -> ausgeschnittener Bildbereich. */
  private readonly cache = new Map<number, { width: number; height: number; rgba: Uint8ClampedArray }>();
  /** Kacheln des laufenden Frames, gebuendelt bis zum ENDFRAME. */
  private pending: DecodedBitmap[] = [];
  private framesDecoded = 0;
  /** Laeuft gerade ein STARTFRAME/ENDFRAME-Paar? */
  private imFrame = false;
  /** Codecs, vor denen schon gewarnt wurde - nicht bei jeder Kachel wiederholen. */
  private readonly gemeldeteCodecs = new Set<number>();
  /** Wie viele Kacheln je Codec kamen - zeigt, welcher Decoder als Naechstes noetig ist. */
  private readonly codecCounts = new Map<number, number>();
  /**
   * ClearCodec fuehrt Glyphen-, V-Bar- und Short-V-Bar-Speicher ueber Kacheln
   * hinweg; eine Kachel kann sich allein auf einen frueher abgelegten Glyphen
   * beziehen. Deshalb genau eine Instanz je Sitzung.
   */
  private readonly clear = new ClearCodecDecoder();
  /**
   * RemoteFX Progressive schreibt seinen Kodierkontext je Flaeche fort: eine
   * Aufwertungskachel (WBT_TILE_PROGRESSIVE_UPGRADE) verfeinert, was eine
   * fruehere Nachricht abgelegt hat. Deshalb ebenfalls eine Instanz je Sitzung,
   * die den Zustand selbst nach surfaceId trennt.
   */
  private readonly progressive: ProgressiveDecoder;
  /** Summen ueber die AVC-Teilbilder - belegt, dass die Nutzlast zerlegbar war. */
  private avcRegionen = 0;
  private avcBytes = 0;

  /**
   * Auffaelligkeiten, vor denen schon gewarnt wurde.
   *
   * Eine Warnung je Vorkommnis waere bei Bildfehlern nutzlos: sie treten
   * tausendfach auf und verdraengen alles andere aus dem Mitschnitt. Einmal
   * warnen genuegt, die Zahlen stehen ohnehin in den debug-Zeilen.
   */
  private readonly gemeldeteAuffaelligkeiten = new Set<string>();

  constructor(private readonly opts: EgfxSessionOptions) {
    this.progressive = new ProgressiveDecoder(opts.log);
  }

  /** Warnt genau einmal je Schluessel. */
  private meldeEinmal(schluessel: string, text: string): void {
    if (this.gemeldeteAuffaelligkeiten.has(schluessel)) return;
    this.gemeldeteAuffaelligkeiten.add(schluessel);
    this.opts.log.warn(text);
  }

  /** Ein Rechteck kurz und lesbar: BreitexHoehe+Links+Oben. */
  private static rechteck(r: egfx.EgfxRect): string {
    return `${r.right - r.left}x${r.bottom - r.top}+${r.left}+${r.top}`;
  }

  /** Eroeffnet die Pipeline mit dem konfigurierten Capability-Satz. */
  start(): void {
    const caps = this.opts.capsSets ?? DEFAULT_EGFX_CAPS;
    this.opts.log.info(
      `Graphics Pipeline: melde Capabilities an - ${caps
        .map((c) => `0x${c.version.toString(16)}/flags 0x${(c.flags ?? 0).toString(16)}`)
        .join(', ')}`,
    );
    this.opts.send(egfx.buildCapsAdvertise(caps));
  }

  /** Verarbeitet eine bereits entpackte EGFX-Nachricht. */
  handle(data: Buffer): void {
    for (const pdu of egfx.parseEgfxPdus(data)) this.handlePdu(pdu);
  }

  private handlePdu(pdu: egfx.EgfxPdu): void {
    // Unbekannte Nachrichten tragen kein typisiertes Feld und lassen sich
    // deshalb nicht ueber cmdId ausschliessen - erst aussortieren, dann werten.
    if ('raw' in pdu) {
      this.opts.log.debug(
        `Graphics Pipeline: unbekannte Nachricht 0x${pdu.cmdId.toString(16)}, ${pdu.raw.length} Byte`,
      );
      return;
    }

    // Jeder Befehl eines entpackten Puffers wird protokolliert, nicht nur der
    // erste. Ein Puffer traegt fast immer mehrere (STARTFRAME, Bildinhalte,
    // ENDFRAME); wer nur den ersten meldet, sieht ENDFRAME und
    // MAPSURFACETOOUTPUT nie und haelt sie faelschlich fuer fehlend.
    this.protokolliere(pdu);

    switch (pdu.cmdId) {
      case egfx.RDPGFX_CMDID_CAPSCONFIRM:
        this.opts.log.info(
          `Graphics Pipeline: Server bestaetigt Version 0x${pdu.capsSet.version.toString(16)}`,
        );
        break;

      case egfx.RDPGFX_CMDID_RESETGRAPHICS:
        this.opts.log.info(`Graphics Pipeline: Desktop ${pdu.width}x${pdu.height}`);
        this.opts.onResize({ width: pdu.width, height: pdu.height });
        break;

      case egfx.RDPGFX_CMDID_CREATESURFACE:
        this.surfaces.set(pdu.surfaceId, {
          width: pdu.width,
          height: pdu.height,
          pixelFormat: pdu.pixelFormat,
          rgba: new Uint8ClampedArray(pdu.width * pdu.height * 4),
          beschrieben: false,
          avcBeschrieben: false,
        });
        break;

      case egfx.RDPGFX_CMDID_DELETESURFACE:
        this.surfaces.delete(pdu.surfaceId);
        this.progressive.reset(pdu.surfaceId);
        break;

      case egfx.RDPGFX_CMDID_MAPSURFACETOOUTPUT: {
        const surface = this.surfaces.get(pdu.surfaceId);
        if (!surface) break;
        surface.output = { x: pdu.outputOriginX, y: pdu.outputOriginY };
        // Nur ausgeben, wenn schon Inhalt da ist - und nicht, wenn H.264 in
        // diese Surface gemalt hat: der Puffer hier kennt jene Pixel nicht.
        if (surface.beschrieben && !this.avcVerdecktSurface(surface)) {
          this.emitRegion(surface, { left: 0, top: 0, right: surface.width, bottom: surface.height });
        }
        break;
      }

      case egfx.RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT: {
        const surface = this.surfaces.get(pdu.surfaceId);
        if (!surface) break;
        // Skalierung wird nicht gerechnet; 1:1 ist der Normalfall.
        if (pdu.targetWidth !== surface.width || pdu.targetHeight !== surface.height) {
          this.opts.log.warn(
            `Graphics Pipeline: skalierte Ausgabe ${surface.width}x${surface.height} -> ` +
              `${pdu.targetWidth}x${pdu.targetHeight} wird unskaliert dargestellt`,
          );
        }
        surface.output = { x: pdu.outputOriginX, y: pdu.outputOriginY };
        if (surface.beschrieben && !this.avcVerdecktSurface(surface)) {
          this.emitRegion(surface, { left: 0, top: 0, right: surface.width, bottom: surface.height });
        }
        break;
      }

      case egfx.RDPGFX_CMDID_WIRETOSURFACE_1:
        this.wireToSurface(pdu);
        break;

      case egfx.RDPGFX_CMDID_SOLIDFILL:
        this.solidFill(pdu);
        break;

      case egfx.RDPGFX_CMDID_SURFACETOSURFACE:
        this.surfaceToSurface(pdu);
        break;

      case egfx.RDPGFX_CMDID_SURFACETOCACHE:
        this.surfaceToCache(pdu);
        break;

      case egfx.RDPGFX_CMDID_CACHETOSURFACE:
        this.cacheToSurface(pdu);
        break;

      case egfx.RDPGFX_CMDID_STARTFRAME:
        // Alles bis zum ENDFRAME gehoert zusammen und wird gebuendelt gezeigt,
        // damit kein halb gezeichnetes Bild aufblitzt.
        this.imFrame = true;
        this.pending = [];
        break;

      case egfx.RDPGFX_CMDID_ENDFRAME:
        this.imFrame = false;
        this.flush();
        this.framesDecoded++;
        // Ohne Bestaetigung drosselt der Server nach wenigen Frames.
        this.opts.send(egfx.buildFrameAcknowledge(pdu.frameId, 0, this.framesDecoded));
        break;

      case egfx.RDPGFX_CMDID_WIRETOSURFACE_2:
        this.wireToSurfaceProgressiv(pdu);
        break;

      case egfx.RDPGFX_CMDID_DELETEENCODINGCONTEXT:
        // 3.3.1.1: Der Kodierkontext ist danach ungueltig. Wuerden wir die
        // Kachelzustaende behalten, wuerde eine spaetere Aufwertungskachel auf
        // Werten aufbauen, die der Server bereits verworfen hat.
        this.progressive.reset(pdu.surfaceId);
        break;

      default:
        this.opts.log.debug(`Graphics Pipeline: unbehandelte Nachricht 0x${pdu.cmdId.toString(16)}`);
    }
  }

  /**
   * Eine Zeile je Befehl - die Grundlage jeder Fehlersuche an Bildfehlern.
   *
   * Stufenwahl: alles Seltene und Aussagekraeftige steht auf `debug`, der
   * Lebenslauf einer Surface sogar auf `info` (er umfasst im Normalfall eine
   * Handvoll Zeilen je Sitzung und beantwortet die haeufigste Frage sofort).
   * Auf `trace` bleiben nur STARTFRAME und ENDFRAME: sie kommen je Bildaufbau
   * und wuerden alles andere zudecken, ohne selbst etwas zu erklaeren.
   */
  private protokolliere(pdu: egfx.EgfxPdu): void {
    if ('raw' in pdu) return;
    const name = egfx.cmdName(pdu.cmdId);
    const R = EgfxSession.rechteck;

    switch (pdu.cmdId) {
      case egfx.RDPGFX_CMDID_STARTFRAME:
        this.opts.log.trace(`EGFX: ${name} frameId ${pdu.frameId}`);
        return;
      case egfx.RDPGFX_CMDID_ENDFRAME:
        this.opts.log.trace(`EGFX: ${name} frameId ${pdu.frameId}, ${this.pending.length} Kachel(n) gebuendelt`);
        return;

      case egfx.RDPGFX_CMDID_CREATESURFACE:
        this.opts.log.info(
          `EGFX: ${name} ${pdu.surfaceId}, ${pdu.width}x${pdu.height}, ` +
            `Pixelformat ${egfx.pixelFormatName(pdu.pixelFormat)}`,
        );
        return;
      case egfx.RDPGFX_CMDID_DELETESURFACE:
        this.opts.log.info(`EGFX: ${name} ${pdu.surfaceId}`);
        return;
      case egfx.RDPGFX_CMDID_MAPSURFACETOOUTPUT: {
        const s = this.surfaces.get(pdu.surfaceId);
        this.opts.log.info(
          `EGFX: ${name} ${pdu.surfaceId} nach (${pdu.outputOriginX}, ${pdu.outputOriginY}); ` +
            `Surface ${s ? `${s.width}x${s.height}, ${s.beschrieben ? 'bemalt' : 'noch unbemalt'}` : 'unbekannt'}`,
        );
        return;
      }
      case egfx.RDPGFX_CMDID_MAPSURFACETOSCALEDOUTPUT: {
        const s = this.surfaces.get(pdu.surfaceId);
        this.opts.log.info(
          `EGFX: ${name} ${pdu.surfaceId} nach (${pdu.outputOriginX}, ${pdu.outputOriginY}), ` +
            `Zielgroesse ${pdu.targetWidth}x${pdu.targetHeight}; ` +
            `Surface ${s ? `${s.width}x${s.height}` : 'unbekannt'}`,
        );
        return;
      }

      case egfx.RDPGFX_CMDID_WIRETOSURFACE_1:
        this.opts.log.debug(
          `EGFX: ${name} Surface ${pdu.surfaceId}, Codec ${egfx.codecName(pdu.codecId)}, ` +
            `Pixelformat ${egfx.pixelFormatName(pdu.pixelFormat)}, Ziel ${R(pdu.destRect)}, ` +
            `${pdu.bitmapData.length} Byte`,
        );
        return;
      case egfx.RDPGFX_CMDID_WIRETOSURFACE_2:
        // Die Auswertung folgt in wireToSurfaceProgressiv, wo die Kachelzahlen
        // feststehen. Hier nur der Kopf, damit die Reihenfolge stimmt.
        this.opts.log.debug(
          `EGFX: ${name} Surface ${pdu.surfaceId}, Codec ${egfx.codecName(pdu.codecId)}, ` +
            `Kodierkontext ${pdu.codecContextId}, ${pdu.bitmapData.length} Byte`,
        );
        return;
      case egfx.RDPGFX_CMDID_DELETEENCODINGCONTEXT:
        // Wirft den progressiven Kachelzustand weg. Kommt der Befehl, waehrend
        // der Server noch Aufwertungen fuer dieselbe Flaeche schickt, malt der
        // Decoder danach grau - deshalb steht er auf info.
        this.opts.log.info(
          `EGFX: ${name} Surface ${pdu.surfaceId}, Kodierkontext ${pdu.codecContextId} - ` +
            'progressiver Kachelzustand wird verworfen',
        );
        return;

      case egfx.RDPGFX_CMDID_SOLIDFILL:
        this.opts.log.debug(
          `EGFX: ${name} Surface ${pdu.surfaceId}, Farbe ` +
            `rgba(${pdu.fillPixel.r}, ${pdu.fillPixel.g}, ${pdu.fillPixel.b}, ${pdu.fillPixel.a}), ` +
            `${pdu.fillRects.length} Rechteck(e) ${pdu.fillRects.map(R).join(' ')}`,
        );
        return;
      case egfx.RDPGFX_CMDID_SURFACETOSURFACE:
        this.opts.log.debug(
          `EGFX: ${name} von Surface ${pdu.surfaceIdSrc} ${R(pdu.rectSrc)} ` +
            `nach Surface ${pdu.surfaceIdDest}, Zielpunkte ` +
            `${pdu.destPts.map((q) => `(${q.x}, ${q.y})`).join(' ')}`,
        );
        return;
      case egfx.RDPGFX_CMDID_SURFACETOCACHE:
        this.opts.log.debug(
          `EGFX: ${name} Surface ${pdu.surfaceId} ${R(pdu.rectSrc)} -> Slot ${pdu.cacheSlot}, ` +
            `Schluessel 0x${pdu.cacheKey.toString(16)}`,
        );
        return;
      case egfx.RDPGFX_CMDID_CACHETOSURFACE:
        this.opts.log.debug(
          `EGFX: ${name} Slot ${pdu.cacheSlot} -> Surface ${pdu.surfaceId}, Zielpunkte ` +
            `${pdu.destPts.map((q) => `(${q.x}, ${q.y})`).join(' ')}`,
        );
        return;
      case egfx.RDPGFX_CMDID_EVICTCACHEENTRY:
        this.opts.log.debug(`EGFX: ${name} Slot ${pdu.cacheSlot}`);
        return;

      default:
        this.opts.log.debug(`EGFX: ${name}`);
    }
  }

  // ------------------------------------------------------------- Bildinhalte

  private wireToSurface(pdu: egfx.EgfxWireToSurface1): void {
    const surface = this.surfaces.get(pdu.surfaceId);
    if (!surface) {
      this.meldeEinmal(
        `w2s1-unbekannt-${pdu.surfaceId}`,
        `Graphics Pipeline: Bildinhalt fuer unbekannte Surface ${pdu.surfaceId} - er geht verloren.`,
      );
      return;
    }

    const width = pdu.destRect.right - pdu.destRect.left;
    const height = pdu.destRect.bottom - pdu.destRect.top;
    if (width <= 0 || height <= 0) return;

    // H.264 geht einen eigenen Weg: es entsteht hier keine RGBA-Kachel, weil
    // dekodiert wird, wo ein Decoder steht.
    if (istAvc(pdu.codecId)) {
      this.wireToSurfaceAvc(pdu, surface);
      return;
    }

    let rgba: Uint8ClampedArray;
    try {
      rgba = this.decodeTile(pdu, width, height);
    } catch (err) {
      this.opts.log.warn(`Graphics Pipeline: Kachel nicht dekodierbar - ${(err as Error).message}`);
      return;
    }

    this.blit(surface, rgba, width, height, pdu.destRect.left, pdu.destRect.top);
    this.emitRegion(surface, pdu.destRect);
  }

  /**
   * RDPGFX_WIRE_TO_SURFACE_PDU_2 (2.2.2.2) mit RemoteFX Progressive.
   *
   * Anders als bei WIRE_TO_SURFACE_1 steht das Zielrechteck nicht in der
   * Nachricht: die Kacheln tragen ihre Lage selbst, und der Decoder hat sie
   * bereits an den Rechtecken der Region beschnitten.
   */
  private wireToSurfaceProgressiv(pdu: egfx.EgfxWireToSurface2): void {
    const surface = this.surfaces.get(pdu.surfaceId);
    if (!surface) {
      this.meldeEinmal(
        `w2s2-unbekannt-${pdu.surfaceId}`,
        `Graphics Pipeline: Progressive fuer unbekannte Surface ${pdu.surfaceId} - der Inhalt geht verloren.`,
      );
      return;
    }
    this.codecCounts.set(pdu.codecId, (this.codecCounts.get(pdu.codecId) ?? 0) + 1);

    let kacheln;
    try {
      kacheln = this.progressive.decode(pdu.bitmapData, pdu.surfaceId);
    } catch (err) {
      // Ein verlorener Rahmen ist besser als eine abgebrochene Sitzung; der
      // Server schickt den Bereich beim naechsten Bildaufbau erneut.
      this.opts.log.warn(`Graphics Pipeline: Progressive nicht dekodierbar - ${(err as Error).message}`);
      return;
    }

    const d = this.progressive.letzteDiagnose();
    this.opts.log.debug(
      `EGFX: WIRETOSURFACE_2 Surface ${pdu.surfaceId} ergab ${d.regionen} Region(en) mit ` +
        `${d.rechtecke} Rechteck(en): ${d.einfach} einfach, ${d.erstdurchgang} Erstdurchgang, ` +
        `${d.aufwertung} Aufwertung; ${d.stuecke} Kachelstueck(e), davon ${d.grau} ohne Inhalt ` +
        `(mittelgrau). Fehlender Vorzustand: ${d.aufwertungOhneErstdurchgang} Aufwertung(en), ` +
        `${d.differenzOhneVorzustand} Differenzkachel(n).`,
    );
    if (d.aufwertungOhneErstdurchgang > 0) {
      this.meldeEinmal(
        `prog-aufwertung-${pdu.surfaceId}`,
        `Graphics Pipeline: Surface ${pdu.surfaceId} bekommt progressive Aufwertungen fuer Kacheln ` +
          'ohne Erstdurchgang. Diese Kacheln werden mittelgrau gezeichnet - der Vorzustand fehlt.',
      );
    }
    if (d.differenzOhneVorzustand > 0) {
      this.meldeEinmal(
        `prog-differenz-${pdu.surfaceId}`,
        `Graphics Pipeline: Surface ${pdu.surfaceId} bekommt Differenzkacheln ohne Vorzustand. ` +
          'Der Kachelzustand wurde verworfen oder ging verloren; das Ergebnis ist nicht der Bildinhalt.',
      );
    }

    for (const kachel of kacheln) {
      this.blit(surface, kachel.rgba, kachel.width, kachel.height, kachel.x, kachel.y);
      this.emitRegion(surface, {
        left: kachel.x,
        top: kachel.y,
        right: kachel.x + kachel.width,
        bottom: kachel.y + kachel.height,
      });
    }
  }

  /**
   * Zerlegt eine AVC-Nutzlast und reicht die Bitstreams weiter.
   *
   * Ein Fehler beim Zerlegen darf die Sitzung nicht beenden: der Server sendet
   * gleich den naechsten Rahmen, und ein verlorenes Teilbild ist allemal besser
   * als eine abgebrochene Verbindung.
   */
  private wireToSurfaceAvc(pdu: egfx.EgfxWireToSurface1, surface: Surface): void {
    this.codecCounts.set(pdu.codecId, (this.codecCounts.get(pdu.codecId) ?? 0) + 1);

    const lage: AvcSurfaceLage = {
      width: surface.width,
      height: surface.height,
      outputX: surface.output?.x ?? 0,
      outputY: surface.output?.y ?? 0,
    };
    const rumpf = {
      surfaceId: pdu.surfaceId,
      codecId: pdu.codecId,
      destRect: pdu.destRect,
      surface: lage,
      abgebildet: surface.output !== undefined,
    };

    let frame: EgfxVideoFrame;
    try {
      if (pdu.codecId === egfx.RDPGFX_CODECID_AVC420) {
        frame = { ...rumpf, yuv420: avc.parseAvc420(pdu.bitmapData) };
      } else {
        const strom = avc.parseAvc444(pdu.bitmapData);
        frame = { ...rumpf, yuv420: strom.luma, chroma420: strom.chroma, lc: strom.lc };
      }
    } catch (err) {
      this.opts.log.warn(`Graphics Pipeline: AVC-Nutzlast unlesbar - ${(err as Error).message}`);
      return;
    }
    if (frame.yuv420) frame.analyse = analysiereBitstrom(frame.yuv420.bitstream);

    this.avcRegionen += (frame.yuv420?.regions.length ?? 0) + (frame.chroma420?.regions.length ?? 0);
    this.avcBytes += (frame.yuv420?.bitstream.length ?? 0) + (frame.chroma420?.bitstream.length ?? 0);

    if (!this.opts.onVideo) {
      if (!this.gemeldeteCodecs.has(pdu.codecId)) {
        this.gemeldeteCodecs.add(pdu.codecId);
        this.opts.log.warn(
          `Graphics Pipeline: Codec 0x${pdu.codecId.toString(16)} (H.264) kommt an, aber hier ` +
            'steht kein Decoder - diese Bildbereiche bleiben leer.',
        );
      }
      return;
    }

    // Die Reihenfolge entscheidet ueber das Bild: AVC ergaenzt die uebrigen
    // Codecpfade, es ersetzt sie nicht, und beide schreiben auf dieselbe
    // Flaeche. Was vor diesem Teilbild dekodiert wurde, muss also auch vorher
    // beim Empfaenger ankommen - sonst uebermalt eine gebuendelte ClearCodec-
    // Kachel hinterher ein Videobild, das eigentlich juenger ist.
    //
    // Deshalb hier die Buendelung bis zum ENDFRAME aufbrechen. Das kostet ein
    // paar Nachrichten mehr, aber nur in Sitzungen, in denen ueberhaupt AVC
    // ankommt; ohne AVC wird diese Zeile nie erreicht.
    this.flush();
    surface.avcBeschrieben = true;
    this.opts.onVideo(frame);
  }

  /**
   * Darf diese Surface noch als Ganzes ausgegeben werden?
   *
   * Nein, sobald H.264 hineingemalt hat. Die Pixel dafuer entstehen im
   * Webview, nicht hier; `surface.rgba` ist an diesen Stellen schwarz
   * geblieben. Eine Vollausgabe wuerde das Videobild ueberdecken.
   *
   * Dieselbe Luecke bleibt bei SURFACE_TO_SURFACE und SURFACE_TO_CACHE
   * bestehen: was von einer AVC-Flaeche kopiert wird, ist hier schwarz. Das
   * liesse sich nur schliessen, indem das Webview jedes dekodierte Bild
   * zurueckschickt - dafuer waere der Weg zweimal zu gehen, und der Gewinn
   * stuende in keinem Verhaeltnis. Der Server zeichnet betroffene Bereiche
   * beim naechsten Bildaufbau ohnehin neu.
   */
  private avcVerdecktSurface(surface: Surface): boolean {
    if (!surface.avcBeschrieben) return false;
    this.opts.log.debug(
      'Graphics Pipeline: Vollausgabe der Surface uebersprungen - H.264-Inhalt liegt nur im Renderer.',
    );
    return true;
  }

  /** Wie viele AVC-Regionen und Bitstream-Bytes ankamen. Nur zur Fehlersuche. */
  getAvcStats(): { regionen: number; bytes: number } {
    return { regionen: this.avcRegionen, bytes: this.avcBytes };
  }

  /** Kachelzahl je Codec, Schluessel als Hexname. */
  getCodecCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [codec, anzahl] of this.codecCounts) out[`0x${codec.toString(16)}`] = anzahl;
    return out;
  }

  private decodeTile(pdu: egfx.EgfxWireToSurface1, width: number, height: number): Uint8ClampedArray {
    this.codecCounts.set(pdu.codecId, (this.codecCounts.get(pdu.codecId) ?? 0) + 1);
    this.opts.onRohkachel?.({
      codecId: pdu.codecId,
      surfaceId: pdu.surfaceId,
      rect: pdu.destRect,
      data: pdu.bitmapData,
    });
    switch (pdu.codecId) {
      case egfx.RDPGFX_CODECID_UNCOMPRESSED:
        return this.fromRawPixels(pdu.bitmapData, width, height, pdu.pixelFormat);

      case egfx.RDPGFX_CODECID_PLANAR:
        return planarDecompress(pdu.bitmapData, { width, height });

      case egfx.RDPGFX_CODECID_CLEARCODEC:
        return this.clear.decode(pdu.bitmapData, { width, height });

      default: {
        if (!this.gemeldeteCodecs.has(pdu.codecId)) {
          this.gemeldeteCodecs.add(pdu.codecId);
          this.opts.log.warn(
            `Graphics Pipeline: Codec 0x${pdu.codecId.toString(16)} wird nicht unterstuetzt - ` +
              'diese Bildbereiche bleiben leer.',
          );
        }
        this.opts.onUnbekannteKachel?.({ codecId: pdu.codecId, width, height, data: pdu.bitmapData });
        throw new Error(`Codec 0x${pdu.codecId.toString(16)}`);
      }
    }
  }

  /** Unkomprimierte Pixel liegen als BGRA vor (XRGB ohne gueltiges Alpha). */
  private fromRawPixels(
    data: Buffer,
    width: number,
    height: number,
    pixelFormat: number,
  ): Uint8ClampedArray {
    const benoetigt = width * height * 4;
    if (data.length < benoetigt) {
      throw new Error(`unkomprimierte Kachel zu kurz: ${data.length} statt ${benoetigt} Byte`);
    }
    const out = new Uint8ClampedArray(benoetigt);
    const mitAlpha = pixelFormat === egfx.PIXEL_FORMAT_ARGB_8888;
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = data[i * 4 + 2];
      out[i * 4 + 1] = data[i * 4 + 1];
      out[i * 4 + 2] = data[i * 4];
      out[i * 4 + 3] = mitAlpha ? data[i * 4 + 3] : 255;
    }
    return out;
  }

  private solidFill(pdu: egfx.EgfxSolidFill): void {
    const surface = this.surfaces.get(pdu.surfaceId);
    if (!surface) {
      this.meldeEinmal(
        `fill-unbekannt-${pdu.surfaceId}`,
        `Graphics Pipeline: SOLIDFILL auf unbekannte Surface ${pdu.surfaceId} - der Bereich bleibt stehen.`,
      );
      return;
    }
    surface.beschrieben = true;
    for (const rect of pdu.fillRects) {
      for (let y = rect.top; y < Math.min(rect.bottom, surface.height); y++) {
        for (let x = rect.left; x < Math.min(rect.right, surface.width); x++) {
          const o = (y * surface.width + x) * 4;
          surface.rgba[o] = pdu.fillPixel.r;
          surface.rgba[o + 1] = pdu.fillPixel.g;
          surface.rgba[o + 2] = pdu.fillPixel.b;
          surface.rgba[o + 3] = 255;
        }
      }
      this.emitRegion(surface, rect);
    }
  }

  private surfaceToSurface(pdu: egfx.EgfxSurfaceToSurface): void {
    const quelle = this.surfaces.get(pdu.surfaceIdSrc);
    const ziel = this.surfaces.get(pdu.surfaceIdDest);
    if (!quelle || !ziel) {
      this.meldeEinmal(
        `s2s-unbekannt-${pdu.surfaceIdSrc}-${pdu.surfaceIdDest}`,
        `Graphics Pipeline: SURFACETOSURFACE ${pdu.surfaceIdSrc} -> ${pdu.surfaceIdDest}, aber ` +
          `${!quelle ? 'die Quelle' : 'das Ziel'} ist unbekannt - der Zielbereich bleibt stehen.`,
      );
      return;
    }
    if (!quelle.beschrieben) {
      this.meldeEinmal(
        `s2s-leer-${pdu.surfaceIdSrc}`,
        `Graphics Pipeline: SURFACETOSURFACE kopiert aus Surface ${pdu.surfaceIdSrc}, in die noch nie ` +
          'etwas gemalt wurde - das Ziel bekommt eine schwarze Flaeche.',
      );
    }
    if (quelle.avcBeschrieben) {
      this.meldeEinmal(
        `s2s-avc-${pdu.surfaceIdSrc}`,
        `Graphics Pipeline: SURFACETOSURFACE kopiert aus Surface ${pdu.surfaceIdSrc}, in die H.264 ` +
          'gemalt hat. Diese Pixel liegen nur im Renderer; die Kopie wird schwarz.',
      );
    }
    if (
      pdu.rectSrc.right > quelle.width ||
      pdu.rectSrc.bottom > quelle.height ||
      pdu.rectSrc.left >= pdu.rectSrc.right ||
      pdu.rectSrc.top >= pdu.rectSrc.bottom
    ) {
      this.meldeEinmal(
        `s2s-rect-${pdu.surfaceIdSrc}`,
        `Graphics Pipeline: SURFACETOSURFACE liest ${EgfxSession.rechteck(pdu.rectSrc)} aus Surface ` +
          `${pdu.surfaceIdSrc}, die nur ${quelle.width}x${quelle.height} gross ist - was ausserhalb ` +
          'liegt, wird als Schwarz kopiert.',
      );
    }

    const width = pdu.rectSrc.right - pdu.rectSrc.left;
    const height = pdu.rectSrc.bottom - pdu.rectSrc.top;
    for (const punkt of pdu.destPts) {
      const ausschnitt = this.extract(quelle, pdu.rectSrc.left, pdu.rectSrc.top, width, height);
      this.blit(ziel, ausschnitt, width, height, punkt.x, punkt.y);
      this.emitRegion(ziel, {
        left: punkt.x,
        top: punkt.y,
        right: punkt.x + width,
        bottom: punkt.y + height,
      });
    }
  }

  private surfaceToCache(pdu: egfx.EgfxSurfaceToCache): void {
    const surface = this.surfaces.get(pdu.surfaceId);
    if (!surface) {
      this.meldeEinmal(
        `s2c-unbekannt-${pdu.surfaceId}`,
        `Graphics Pipeline: SURFACETOCACHE aus unbekannter Surface ${pdu.surfaceId} - Slot ` +
          `${pdu.cacheSlot} bleibt leer, und jedes spaetere CACHETOSURFACE darauf zeichnet nichts.`,
      );
      return;
    }
    if (!surface.beschrieben || surface.avcBeschrieben) {
      this.meldeEinmal(
        `s2c-leer-${pdu.surfaceId}`,
        `Graphics Pipeline: SURFACETOCACHE legt Slot ${pdu.cacheSlot} aus Surface ${pdu.surfaceId} an, ` +
          `deren Puffer hier ${surface.avcBeschrieben ? 'H.264-Inhalt nicht kennt' : 'noch unbemalt ist'} - ` +
          'der Cacheeintrag wird schwarz.',
      );
    }
    const width = pdu.rectSrc.right - pdu.rectSrc.left;
    const height = pdu.rectSrc.bottom - pdu.rectSrc.top;
    this.cache.set(pdu.cacheSlot, {
      width,
      height,
      rgba: this.extract(surface, pdu.rectSrc.left, pdu.rectSrc.top, width, height),
    });
  }

  private cacheToSurface(pdu: egfx.EgfxCacheToSurface): void {
    const eintrag = this.cache.get(pdu.cacheSlot);
    const ziel = this.surfaces.get(pdu.surfaceId);
    if (!eintrag) {
      // Der Zielbereich bleibt unveraendert stehen - genau so entstehen
      // Flaechen, die nie uebermalt werden. Ohne diese Zeile ist der Fall
      // unsichtbar, weil hier nur stillschweigend zurueckgekehrt wird.
      this.meldeEinmal(
        'c2s-slot',
        `Graphics Pipeline: CACHETOSURFACE zeigt auf Slot ${pdu.cacheSlot}, den diese Sitzung nie ` +
          `gefuellt hat. Der Zielbereich auf Surface ${pdu.surfaceId} bleibt unveraendert stehen.`,
      );
      return;
    }
    if (!ziel) {
      this.meldeEinmal(
        `c2s-surface-${pdu.surfaceId}`,
        `Graphics Pipeline: CACHETOSURFACE auf unbekannte Surface ${pdu.surfaceId}.`,
      );
      return;
    }
    for (const punkt of pdu.destPts) {
      this.blit(ziel, eintrag.rgba, eintrag.width, eintrag.height, punkt.x, punkt.y);
      this.emitRegion(ziel, {
        left: punkt.x,
        top: punkt.y,
        right: punkt.x + eintrag.width,
        bottom: punkt.y + eintrag.height,
      });
    }
  }

  // -------------------------------------------------------------- Hilfsmittel

  private blit(
    surface: Surface,
    quelle: Uint8ClampedArray,
    width: number,
    height: number,
    zielX: number,
    zielY: number,
  ): void {
    surface.beschrieben = true;
    for (let y = 0; y < height; y++) {
      const zy = zielY + y;
      if (zy < 0 || zy >= surface.height) continue;
      for (let x = 0; x < width; x++) {
        const zx = zielX + x;
        if (zx < 0 || zx >= surface.width) continue;
        const von = (y * width + x) * 4;
        const nach = (zy * surface.width + zx) * 4;
        surface.rgba[nach] = quelle[von];
        surface.rgba[nach + 1] = quelle[von + 1];
        surface.rgba[nach + 2] = quelle[von + 2];
        surface.rgba[nach + 3] = 255;
      }
    }
  }

  private extract(
    surface: Surface,
    x0: number,
    y0: number,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const qy = y0 + y;
        const qx = x0 + x;
        if (qy < 0 || qy >= surface.height || qx < 0 || qx >= surface.width) continue;
        const von = (qy * surface.width + qx) * 4;
        const nach = (y * width + x) * 4;
        out[nach] = surface.rgba[von];
        out[nach + 1] = surface.rgba[von + 1];
        out[nach + 2] = surface.rgba[von + 2];
        out[nach + 3] = surface.rgba[von + 3];
      }
    }
    return out;
  }

  /** Schneidet einen Surface-Bereich aus und legt ihn als Bildschirmkachel ab. */
  private emitRegion(surface: Surface, rect: egfx.EgfxRect): void {
    if (!surface.output) return;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(surface.width, rect.right);
    const bottom = Math.min(surface.height, rect.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return;

    this.pending.push({
      x: surface.output.x + left,
      y: surface.output.y + top,
      width,
      height,
      rgba: this.extract(surface, left, top, width, height),
    });

    // Inhalte ausserhalb eines Frames sofort zeigen - auf ein ENDFRAME,
    // das nie kommt, darf man nicht warten.
    if (!this.imFrame) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.opts.onBitmap(this.pending);
    this.pending = [];
  }
}

/** AVC420, AVC444 und AVC444V2 tragen alle H.264 und werden gleich behandelt. */
function istAvc(codecId: number): boolean {
  return (
    codecId === egfx.RDPGFX_CODECID_AVC420 ||
    codecId === egfx.RDPGFX_CODECID_AVC444 ||
    codecId === egfx.RDPGFX_CODECID_AVC444V2
  );
}
