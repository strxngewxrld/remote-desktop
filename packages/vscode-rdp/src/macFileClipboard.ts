import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClipboardFileWriter, ClipboardSink, RemoteClipboardEntry } from 'ts-rdp';

// A fixed script, never source text built from remote filenames. Paths arrive as JSON on stdin.
const SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  const pasteboard = $.NSPasteboard.generalPasteboard;
  if (argv[0] === 'list') {
    // Lokale Datei-URLs der Pasteboard als JSON-Liste absoluter Pfade (nur lesen).
    const items = pasteboard.pasteboardItems;
    const paths = [];
    for (let i = 0; i < Number(items.count); i++) {
      const text = items.objectAtIndex(i).stringForType($('public.file-url'));
      if (!text || text.isNil()) continue;
      const url = $.NSURL.URLWithString(text);
      if (url && !url.isNil() && url.isFileURL) paths.push(ObjC.unwrap(url.path));
    }
    return JSON.stringify(paths);
  }
  if (argv[0] === 'snapshot') return String(pasteboard.changeCount);
  if (Number(argv[1]) !== Number(pasteboard.changeCount)) return 'changed';
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const paths = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding));
  const urls = $.NSMutableArray.alloc.init;
  const filenames = $.NSMutableArray.alloc.init;
  // Build native arrays explicitly; JS arrays turn ObjC proxies into dictionaries.
  // Eager string data survives the short-lived osascript pasteboard owner.
  JSON.parse(paths).forEach(path => {
    const item = $.NSPasteboardItem.alloc.init;
    item.setStringForType($.NSURL.fileURLWithPath($(path)).absoluteString, $('public.file-url'));
    urls.addObject(item);
    filenames.addObject($(path));
  });
  pasteboard.clearContents;
  if (Number(pasteboard.writeObjects(urls)) !== 1 || Number(pasteboard.pasteboardItems.count) !== Number(urls.count))
    throw new Error('Datei-Zwischenablage konnte nicht geschrieben werden.');
  if (Number(pasteboard.setPropertyListForType(filenames, $('NSFilenamesPboardType'))) !== 1)
    throw new Error('Finder-Dateiliste konnte nicht geschrieben werden.');
  return 'written';
}`;

export type NativeRunner = (args: string[]) => Promise<string>;
const native: NativeRunner = args => new Promise((resolve, reject) => {
  const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, args[0], args[1] ?? ''],
    { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  // stdin also handles thousands of top-level filenames without hitting ARG_MAX.
  child.stdin?.on('error', () => {});
  child.stdin?.end(args[2] ?? '');
});

/** Shared across sessions: the latest copy wins. Files survive closing the RDP tab. */
export class MacFileClipboard {
  private revision = 0;
  private current?: string;
  private publication: Promise<unknown> = Promise.resolve();
  constructor(private readonly run: NativeRunner = native, private readonly temporaryDirectory = tmpdir()) {}

  /** Pfade der Dateien/Ordner, die gerade in der macOS-Pasteboard liegen (leer: keine). */
  async localPaths(): Promise<string[]> {
    const raw = JSON.parse(await this.run(['list']) || '[]') as unknown;
    if (!Array.isArray(raw)) throw new Error('Unerwartete Antwort der macOS-Zwischenablage.');
    return raw.filter((p): p is string => typeof p === 'string' && p.startsWith('/') && !p.includes('\0'));
  }

  /** `load` schreibt streamend in die Senke; veroeffentlicht wird erst, wenn alles angekommen ist. */
  async receive(load: (sink: ClipboardSink) => Promise<void>, signal: AbortSignal): Promise<void> {
    const revision = ++this.revision;
    await this.publication.catch(() => {});
    signal.throwIfAborted();
    const stamp = await this.run(['snapshot']);
    if (!/^\d+$/.test(stamp)) throw new Error('macOS-Zwischenablage ist nicht verfügbar.');
    signal.throwIfAborted();
    const root = await mkdtemp(join(this.temporaryDirectory, 'vscode-rdp-clipboard-'));
    let published = false;
    try {
      const top = new Set<string>();
      const directories: { path: string; depth: number; time: Date }[] = [];
      const target = (entry: RemoteClipboardEntry) => {
        const segments = entry.name.split('/');
        // Defense in depth: this boundary must also be safe for library callers.
        if (segments.some(s => !s || s === '.' || s === '..' || /[\\\x00]/.test(s))) throw new Error('Ungültiger Clipboard-Dateipfad.');
        top.add(segments[0]);
        return { path: join(root, ...segments), depth: segments.length };
      };
      const sink: ClipboardSink = {
        directory: async entry => {
          signal.throwIfAborted();
          const { path, depth } = target(entry);
          await mkdir(path, { recursive: true, mode: 0o700 });
          // Der Zeitstempel kommt zum Schluss, sonst verschieben die Kinder ihn wieder.
          if (entry.lastWriteTime) directories.push({ path, depth, time: entry.lastWriteTime });
        },
        file: async (entry): Promise<ClipboardFileWriter> => {
          signal.throwIfAborted();
          const { path } = target(entry);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const handle = await open(path, 'wx', 0o600);
          return {
            write: async chunk => {
              signal.throwIfAborted();
              for (let done = 0; done < chunk.length;) done += (await handle.write(chunk, done, chunk.length - done)).bytesWritten;
            },
            close: async error => {
              try { if (!error && entry.lastWriteTime) await handle.utimes(entry.lastWriteTime, entry.lastWriteTime); }
              finally { await handle.close(); }
            },
          };
        },
      };
      await load(sink);
      signal.throwIfAborted();
      if (revision !== this.revision) throw new Error('Ein neuerer Kopiervorgang ist bereits aktiv.');
      if (!top.size) throw new Error('Keine Dateien in der Remote-Zwischenablage.');
      for (const dir of directories.sort((a, b) => b.depth - a.depth)) await utimes(dir.path, dir.time, dir.time);
      const publication = this.run(['publish', stamp, JSON.stringify([...top].map(name => join(root, name)))]);
      this.publication = publication;
      if (await publication !== 'written')
        throw new Error('Die lokale Zwischenablage wurde inzwischen geändert; die Remote-Dateien wurden nicht übernommen.');
      published = true;
      const previous = this.current;
      this.current = root;
      // Keep the old source available for Finder copies that are still running.
      if (previous) setTimeout(() => void rm(previous, { recursive: true, force: true }).catch(() => {}), 30 * 60 * 1000).unref();
    } finally {
      if (!published) await rm(root, { recursive: true, force: true });
    }
  }
}
export const macFileClipboard = new MacFileClipboard();
