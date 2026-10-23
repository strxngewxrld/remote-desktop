import { RdpProtocolError } from '../core/errors.js';

export interface RemoteClipboardEntry {
  /** Relative path, using / between directory segments. */
  name: string;
  directory: boolean;
  size?: number;
}
export interface DownloadedClipboardEntry extends RemoteClipboardEntry { data: Buffer }
const MAX_ENTRIES = 4096;
const DESCRIPTOR_SIZE = 592;

/** MS-RDPECLIP 2.2.5.2.3: FILEGROUPDESCRIPTORW, including relative folder paths. */
export function parseRemoteFileList(body: Buffer): RemoteClipboardEntry[] {
  if (body.length < 4) throw new RdpProtocolError('Clipboard-Dateiliste ist unvollständig.');
  const count = body.readUInt32LE(0);
  if (!count || count > MAX_ENTRIES || body.length !== 4 + count * DESCRIPTOR_SIZE)
    throw new RdpProtocolError('Ungültige Größe der Clipboard-Dateiliste.');
  const entries: RemoteClipboardEntry[] = [];
  const paths = new Map<string, boolean>();
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * DESCRIPTOR_SIZE;
    const flags = body.readUInt32LE(offset);
    const attributes = flags & 4 ? body.readUInt32LE(offset + 36) : 0;
    if (attributes & 0x400) throw new RdpProtocolError('Clipboard-Verknüpfungen werden nicht übernommen.');
    const bytes = body.subarray(offset + 72, offset + 592);
    let end = 0;
    while (end < bytes.length && bytes.readUInt16LE(end) !== 0) end += 2;
    if (end === bytes.length) throw new RdpProtocolError('Clipboard-Dateiname ist nicht terminiert.');
    const segments = bytes.subarray(0, end).toString('utf16le').replace(/\\/g, '/').split('/');
    if (segments.some(s => !s || s === '.' || s === '..' || /[\x00-\x1f\x7f:*?"<>|]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
      throw new RdpProtocolError('Unsicherer Pfad in der Clipboard-Dateiliste.');
    const name = segments.join('/').normalize('NFC');
    const key = name.toLowerCase();
    if (paths.has(key)) throw new RdpProtocolError('Doppelter Pfad in der Clipboard-Dateiliste.');
    const directory = !!(attributes & 0x10);
    paths.set(key, directory);
    const size64 = flags & 0x40 ? (BigInt(body.readUInt32LE(offset + 64)) << 32n) | BigInt(body.readUInt32LE(offset + 68)) : undefined;
    if (size64 !== undefined && size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new RdpProtocolError('Clipboard-Datei ist zu groß.');
    entries.push({ name, directory, size: directory ? 0 : size64 === undefined ? undefined : Number(size64) });
  }
  const spelling = new Map<string, string>();
  for (const entry of entries) {
    const original = entry.name.split('/');
    for (let i = 1; i <= original.length; i++) {
      const path = original.slice(0, i).join('/');
      const previous = spelling.get(path.toLowerCase());
      if (previous !== undefined && previous !== path) throw new RdpProtocolError('Mehrdeutige Großschreibung in Clipboard-Pfaden.');
      spelling.set(path.toLowerCase(), path);
    }
    const segments = entry.name.toLowerCase().split('/');
    for (let i = 1; i < segments.length; i++) {
      if (paths.get(segments.slice(0, i).join('/')) === false)
        throw new RdpProtocolError('Eine Clipboard-Datei wird gleichzeitig als Ordner verwendet.');
    }
  }
  return entries;
}

type Pending = { id?: number; max: number; resolve: (body: Buffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One bounded download. A clipboard change cancels it rather than mixing revisions. */
export class ClipboardDownload {
  private pending?: Pending;
  private error?: Error;
  private readonly onAbort = () => this.cancel(new Error('Clipboard-Dateiübertragung abgebrochen.'));
  constructor(
    private readonly send: (body: Buffer) => void,
    private readonly nextStream: () => number,
    private readonly maxBytes: number,
    private readonly signal?: AbortSignal,
    private readonly timeoutMs = 15000,
  ) { signal?.addEventListener('abort', this.onAbort, { once: true }); }

  cancel(error = new Error('Die Remote-Zwischenablage wurde während der Übertragung geändert.')): void {
    this.error ??= error;
    this.pending?.reject(this.error);
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  receive(body: Buffer, ok: boolean, declaredLength: number, stream?: number): void {
    const pending = this.pending;
    if (!pending || pending.id !== stream) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (!ok || body.length !== declaredLength || body.length > pending.max) {
      const error = new RdpProtocolError('Ungültige oder abgelehnte Clipboard-Dateiantwort.');
      this.error = error;
      pending.reject(error);
    } else pending.resolve(body);
  }

  private wait(max: number, send: () => void, id?: number): Promise<Buffer> {
    if (this.signal?.aborted) this.onAbort();
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new Error('Zeitüberschreitung beim Empfang von Clipboard-Dateien.')), this.timeoutMs);
      this.pending = { id, max, resolve, reject, timer };
      try { send(); } catch (error) { this.cancel(error as Error); }
    });
  }

  private request(index: number, size: boolean, offset = 0, count = 8): Promise<Buffer> {
    const id = this.nextStream();
    const body = Buffer.alloc(24);
    body.writeUInt32LE(id, 0); body.writeInt32LE(index, 4);
    body.writeUInt32LE(size ? 1 : 2, 8);
    body.writeUInt32LE(offset >>> 0, 12); body.writeUInt32LE(Math.floor(offset / 0x100000000), 16);
    body.writeUInt32LE(count, 20);
    return this.wait(count, () => this.send(body), id);
  }

  async run(requestList: () => void): Promise<DownloadedClipboardEntry[]> {
    try {
      if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 256 * 1024 * 1024)
        throw new Error('Ungültige Clipboard-Dateigrößenbegrenzung.');
      const list = await this.wait(4 + MAX_ENTRIES * DESCRIPTOR_SIZE, requestList);
      const entries = parseRemoteFileList(list);
      let total = 0;
      // Check all known sizes before requesting any file contents.
      for (const [index, entry] of entries.entries()) {
        if (entry.directory) continue;
        if (entry.size === undefined) {
          const size = await this.request(index, true);
          if (size.length !== 8 || size.readBigUInt64LE() > BigInt(this.maxBytes)) throw new Error('Clipboard-Datei ist zu groß oder die Größenantwort ungültig.');
          entry.size = Number(size.readBigUInt64LE());
        }
        total += entry.size;
        if (total > this.maxBytes) throw new Error('Clipboard-Dateien überschreiten die Größenbegrenzung.');
      }
      const result: DownloadedClipboardEntry[] = [];
      for (const [index, entry] of entries.entries()) {
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < (entry.size ?? 0)) {
          const data = await this.request(index, false, offset, Math.min(64 * 1024, entry.size! - offset));
          if (!data.length) throw new RdpProtocolError('Clipboard-Datei wurde vorzeitig beendet.');
          chunks.push(data); offset += data.length;
        }
        if (this.error) throw this.error;
        result.push({ ...entry, data: Buffer.concat(chunks, offset) });
      }
      return result;
    } finally {
      this.signal?.removeEventListener('abort', this.onAbort);
      if (this.pending) clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
  }
}
