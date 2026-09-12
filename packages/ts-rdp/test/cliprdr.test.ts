/**
 * Zwischenablage (MS-RDPECLIP) - Bytes, Text und Zustandsmaschine.
 *
 * Die erwarteten Bytes sind von Hand aus der Spezifikation gerechnet und
 * stehen als Hexfolge im Test. Das ist Absicht: ein Test, der die Bytes mit
 * derselben Funktion erzeugt, die er pruefen soll, faellt bei einem falschen
 * Feldlayout nicht auf.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  CB_ASCII_NAMES,
  CB_CAPS_VERSION_2,
  CB_CLIP_CAPS,
  CB_FORMAT_DATA_RESPONSE,
  CB_FORMAT_LIST,
  CB_MONITOR_READY,
  CB_RESPONSE_FAIL,
  CB_RESPONSE_OK,
  CB_USE_LONG_FORMAT_NAMES,
  CF_TEXT,
  CF_UNICODETEXT,
  CLIPRDR_CHANNEL_DEF,
  CLIPRDR_CHANNEL_NAME,
  CliprdrSession,
  STANDARD_MAX_BYTES,
  TEMP_DIRECTORY_SIZE,
  buildClipboardCapabilities,
  buildCliprdrPdu,
  buildFormatDataRequest,
  buildFormatDataResponse,
  buildFormatDataResponseFehler,
  buildFormatList,
  buildFormatListResponse,
  buildMonitorReady,
  buildTempDirectory,
  dekodiereAnsiText,
  dekodiereUnicodeText,
  kodiereAnsiText,
  kodiereUnicodeText,
  parseClipboardCapabilities,
  parseCliprdrPdu,
  parseFormatDataRequest,
  parseFormatList,
  parseTempDirectory,
  waehleTextformat,
  zeilenendenNachLokal,
  zeilenendenNachWindows,
} from '../src/protocol/cliprdr.js';
import {
  CHANNEL_OPTION_COMPRESS_RDP,
  CHANNEL_OPTION_ENCRYPT_RDP,
  CHANNEL_OPTION_INITIALIZED,
  CHANNEL_OPTION_SHOW_PROTOCOL,
} from '../src/protocol/gcc.js';

/** Hexfolge mit Leerzeichen zu Bytes - macht die Erwartung im Test lesbar. */
function hex(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'hex');
}

function alsHex(b: Buffer): string {
  return b.toString('hex');
}

describe('CLIPRDR - Kanal und Optionen', () => {
  test('Der Kanal heisst cliprdr und traegt die Optionen von mstsc', () => {
    assert.equal(CLIPRDR_CHANNEL_NAME, 'cliprdr');
    assert.equal(CLIPRDR_CHANNEL_DEF.name, 'cliprdr');
    // INITIALIZED | ENCRYPT_RDP | COMPRESS_RDP | SHOW_PROTOCOL
    assert.equal(CLIPRDR_CHANNEL_DEF.options >>> 0, 0xc0a00000);
    assert.equal(
      CLIPRDR_CHANNEL_DEF.options >>> 0,
      (CHANNEL_OPTION_INITIALIZED |
        CHANNEL_OPTION_ENCRYPT_RDP |
        CHANNEL_OPTION_COMPRESS_RDP |
        CHANNEL_OPTION_SHOW_PROTOCOL) >>>
        0,
    );
  });

  test('Der Kanalname passt in die acht Byte des Client Network Data', () => {
    // MS-RDPBCGR 2.2.1.3.4.1: acht Byte, davon sieben ANSI-Zeichen plus NUL.
    assert.ok(CLIPRDR_CHANNEL_NAME.length <= 7);
  });
});

describe('CLIPRDR - Kopf (2.2.1)', () => {
  test('Der Kopf ist msgType, msgFlags, dataLen - alles Little Endian', () => {
    const pdu = buildCliprdrPdu(0x0005, 0x0001, hex('de ad be ef'));
    // 05 00 | 01 00 | 04 00 00 00 | de ad be ef
    assert.equal(alsHex(pdu), '05000100' + '04000000' + 'deadbeef');
  });

  test('Monitor Ready ist nur der Kopf mit dataLen 0', () => {
    assert.equal(alsHex(buildMonitorReady()), '0100' + '0000' + '00000000');
  });

  test('Format List Response traegt OK bzw. FAIL im msgFlags', () => {
    assert.equal(alsHex(buildFormatListResponse(true)), '0300' + '0100' + '00000000');
    assert.equal(alsHex(buildFormatListResponse(false)), '0300' + '0200' + '00000000');
  });

  test('Gelesen wird, was der Kopf ankuendigt', () => {
    const pdu = parseCliprdrPdu(hex('0500 0100 04000000 de ad be ef'));
    assert.equal(pdu.msgType, CB_FORMAT_DATA_RESPONSE);
    assert.equal(pdu.msgFlags, CB_RESPONSE_OK);
    assert.equal(pdu.dataLen, 4);
    assert.equal(alsHex(pdu.body), 'deadbeef');
  });

  test('Die vier Zusatzbytes aelterer Windows-Server werden abgeschnitten', () => {
    // Anhang A, Fussnote 1: Windows 2003 bis 2012 R2 haengen vier Byte an,
    // die nicht in dataLen stecken. Wer sie als Nutzdaten liest, bekommt
    // Muell hinter dem Text.
    const pdu = parseCliprdrPdu(hex('0500 0100 04000000 de ad be ef 00 00 00 00'));
    assert.equal(pdu.body.length, 4);
    assert.equal(alsHex(pdu.body), 'deadbeef');
  });

  test('Ein zu kurzer Rumpf wird genommen, wie er ist, statt die Sitzung zu beenden', () => {
    const pdu = parseCliprdrPdu(hex('0500 0100 ff000000 de ad'));
    assert.equal(pdu.dataLen, 255);
    assert.equal(alsHex(pdu.body), 'dead');
  });

  test('Eine Nachricht unterhalb der Kopfgroesse wird abgelehnt', () => {
    assert.throws(() => parseCliprdrPdu(hex('0500 0100 0400')), /kuerzer als der Kopf/);
  });
});

describe('CLIPRDR - Capabilities (2.2.2.1)', () => {
  test('CLIPRDR_CAPS mit einem General Capability Set, Byte fuer Byte', () => {
    const pdu = buildClipboardCapabilities(CB_USE_LONG_FORMAT_NAMES, CB_CAPS_VERSION_2);
    assert.equal(
      alsHex(pdu),
      // Kopf: CB_CLIP_CAPS, Flags 0, dataLen 16 (4 Byte Rumpfkopf + 12 Byte Satz)
      '0700' +
        '0000' +
        '10000000' +
        // cCapabilitiesSets = 1, pad1 = 0
        '0100' +
        '0000' +
        // CB_CAPSTYPE_GENERAL, lengthCapability = 12
        '0100' +
        '0c00' +
        // version = 2, generalFlags = CB_USE_LONG_FORMAT_NAMES
        '02000000' +
        '02000000',
    );
    assert.equal(pdu.length, 24);
  });

  test('Der Kopf kuendigt genau die Rumpflaenge an', () => {
    const pdu = buildClipboardCapabilities(CB_USE_LONG_FORMAT_NAMES);
    const gelesen = parseCliprdrPdu(pdu);
    assert.equal(gelesen.msgType, CB_CLIP_CAPS);
    assert.equal(gelesen.dataLen, gelesen.body.length);
  });

  test('Der General Capability Set wird wieder herausgelesen', () => {
    const caps = parseClipboardCapabilities(
      parseCliprdrPdu(buildClipboardCapabilities(0x0016, CB_CAPS_VERSION_2)).body,
    );
    assert.equal(caps.version, 2);
    assert.equal(caps.generalFlags, 0x0016);
  });

  test('Unbekannte Satztypen werden ueber lengthCapability uebersprungen', () => {
    // Zwei Saetze: ein erfundener Typ 0x0009 mit 8 Byte, dann der allgemeine.
    const rumpf = hex(
      '0200 0000' + // cCapabilitiesSets = 2, pad1
        '0900 0800 aabbccdd' + // Typ 9, Laenge 8 (inkl. eigener Kopf), 4 Byte Inhalt
        '0100 0c00 01000000 02000000',
    );
    const caps = parseClipboardCapabilities(rumpf);
    assert.equal(caps.version, 1);
    assert.equal(caps.generalFlags, 2);
  });

  test('Ohne General Capability Set gelten die Vorgaben (Flags 0)', () => {
    assert.deepEqual(parseClipboardCapabilities(hex('0000 0000')), { version: 0, generalFlags: 0 });
    assert.deepEqual(parseClipboardCapabilities(Buffer.alloc(0)), { version: 0, generalFlags: 0 });
  });
});

describe('CLIPRDR - Temp Directory (2.2.2.3)', () => {
  test('wszTempDir ist 520 Byte lang und nullterminiert', () => {
    const pdu = buildTempDirectory('C:\\temp');
    assert.equal(pdu.length, 8 + TEMP_DIRECTORY_SIZE);
    const gelesen = parseCliprdrPdu(pdu);
    assert.equal(gelesen.dataLen, 520);
    // "C:\temp" in UTF-16LE (14 Byte), dann das Nullzeichen, dann nur Nullen.
    assert.equal(alsHex(gelesen.body.subarray(0, 16)), '43003a005c00740065006d0070' + '00' + '0000');
    assert.ok(gelesen.body.subarray(14).every((b) => b === 0));
    assert.equal(parseTempDirectory(gelesen.body), 'C:\\temp');
  });

  test('Ein zu langer Pfad wird gekuerzt, das Nullzeichen bleibt', () => {
    const pdu = buildTempDirectory('x'.repeat(400));
    const body = parseCliprdrPdu(pdu).body;
    assert.equal(body.length, TEMP_DIRECTORY_SIZE);
    assert.equal(parseTempDirectory(body).length, 259);
    assert.equal(body.readUInt16LE(TEMP_DIRECTORY_SIZE - 2), 0);
  });
});

describe('CLIPRDR - Format List (2.2.3.1)', () => {
  test('Lange Formatnamen: formatId und ein einzelnes Nullzeichen je Format', () => {
    const pdu = buildFormatList(
      [
        { formatId: CF_UNICODETEXT, name: '' },
        { formatId: CF_TEXT, name: '' },
      ],
      { longFormatNames: true },
    );
    assert.equal(
      alsHex(pdu),
      // Kopf: CB_FORMAT_LIST, Flags 0, dataLen 12
      '0200' +
        '0000' +
        '0c000000' +
        // 13, NUL
        '0d000000' +
        '0000' +
        // 1, NUL
        '01000000' +
        '0000',
    );
  });

  test('Ein langer Formatname steht als nullterminiertes UTF-16LE dahinter', () => {
    const pdu = buildFormatList([{ formatId: 49267, name: 'HTML Format' }], { longFormatNames: true });
    const body = parseCliprdrPdu(pdu).body;
    assert.equal(body.readUInt32LE(0), 49267);
    assert.equal(body.subarray(4, 4 + 22).toString('ucs2'), 'HTML Format');
    assert.equal(body.readUInt16LE(26), 0, 'Nullzeichen am Ende des Namens');
    assert.equal(body.length, 28);
  });

  test('Kurze Formatnamen belegen je 36 Byte: 4 fuer die ID, 32 fuer den Namen', () => {
    const pdu = buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: false });
    const body = parseCliprdrPdu(pdu).body;
    assert.equal(body.length, 36);
    assert.equal(body.readUInt32LE(0), CF_UNICODETEXT);
    assert.ok(body.subarray(4).every((b) => b === 0), 'namenlose Formate tragen nur Nullen');
  });

  test('Kurze Namen in ASCII setzen CB_ASCII_NAMES im Kopf', () => {
    const pdu = buildFormatList([{ formatId: 49161, name: 'Rich Text' }], {
      longFormatNames: false,
      asciiNames: true,
    });
    const gelesen = parseCliprdrPdu(pdu);
    assert.equal(gelesen.msgType, CB_FORMAT_LIST);
    assert.equal(gelesen.msgFlags, CB_ASCII_NAMES);
    assert.equal(gelesen.body.subarray(4, 13).toString('ascii'), 'Rich Text');
  });

  test('Lange Namen setzen CB_ASCII_NAMES nie - dort sind Unicode-Namen vorgeschrieben', () => {
    const pdu = buildFormatList([{ formatId: 1, name: 'x' }], { longFormatNames: true, asciiNames: true });
    assert.equal(parseCliprdrPdu(pdu).msgFlags, 0);
  });

  for (const lang of [true, false]) {
    test(`Gebaute und gelesene Liste stimmen ueberein (${lang ? 'lange' : 'kurze'} Namen)`, () => {
      const formate = [
        { formatId: CF_UNICODETEXT, name: '' },
        { formatId: CF_TEXT, name: '' },
        { formatId: 49267, name: 'HTML Format' },
      ];
      const pdu = buildFormatList(formate, { longFormatNames: lang });
      const gelesen = parseFormatList(parseCliprdrPdu(pdu).body, { longFormatNames: lang });
      assert.deepEqual(gelesen, formate);
    });
  }

  test('Eine leere Formatliste ist zulaessig und heisst "nichts da"', () => {
    const pdu = buildFormatList([], { longFormatNames: true });
    assert.equal(alsHex(pdu), '0200' + '0000' + '00000000');
    assert.deepEqual(parseFormatList(Buffer.alloc(0), { longFormatNames: true }), []);
  });

  test('waehleTextformat bevorzugt CF_UNICODETEXT vor CF_TEXT', () => {
    assert.equal(
      waehleTextformat([
        { formatId: CF_TEXT, name: '' },
        { formatId: CF_UNICODETEXT, name: '' },
      ]),
      CF_UNICODETEXT,
    );
    assert.equal(waehleTextformat([{ formatId: CF_TEXT, name: '' }]), CF_TEXT);
    assert.equal(waehleTextformat([{ formatId: 49267, name: 'HTML Format' }]), undefined);
    assert.equal(waehleTextformat([]), undefined);
  });
});

describe('CLIPRDR - Datenanfrage und -antwort (2.2.5)', () => {
  test('Format Data Request traegt die vierbyteige Format-ID', () => {
    assert.equal(alsHex(buildFormatDataRequest(CF_UNICODETEXT)), '0400' + '0000' + '04000000' + '0d000000');
    assert.equal(parseFormatDataRequest(hex('0d000000')), CF_UNICODETEXT);
  });

  test('Ein Request ohne Format-ID wird abgelehnt', () => {
    assert.throws(() => parseFormatDataRequest(hex('0d00')), /requestedFormatId/);
  });

  test('Die erfolgreiche Antwort traegt CB_RESPONSE_OK, die abschlaegige CB_RESPONSE_FAIL', () => {
    // "Hi" als CF_UNICODETEXT: 48 00 69 00, dann das Nullzeichen 00 00.
    assert.equal(
      alsHex(buildFormatDataResponse(kodiereUnicodeText('Hi'))),
      '0500' + '0100' + '06000000' + '48006900' + '0000',
    );
    assert.equal(alsHex(buildFormatDataResponseFehler()), '0500' + '0200' + '00000000');
    assert.equal(parseCliprdrPdu(buildFormatDataResponseFehler()).msgFlags, CB_RESPONSE_FAIL);
  });
});

describe('CLIPRDR - Text, Zeilenenden und Nullzeichen', () => {
  test('LF wird zu CR-LF, vorhandenes CR-LF bleibt', () => {
    assert.equal(zeilenendenNachWindows('a\nb'), 'a\r\nb');
    assert.equal(zeilenendenNachWindows('a\r\nb'), 'a\r\nb');
    assert.equal(zeilenendenNachWindows('a\rb'), 'a\r\nb', 'einzelnes CR ebenfalls');
    assert.equal(zeilenendenNachWindows('a\n\nb'), 'a\r\n\r\nb');
  });

  test('Zweimal umwandeln aendert nichts mehr', () => {
    const einmal = zeilenendenNachWindows('eins\nzwei\r\ndrei\rvier');
    assert.equal(zeilenendenNachWindows(einmal), einmal);
  });

  test('CR-LF wird zu LF, einzelnes CR ebenfalls', () => {
    assert.equal(zeilenendenNachLokal('a\r\nb'), 'a\nb');
    assert.equal(zeilenendenNachLokal('a\rb'), 'a\nb');
    assert.equal(zeilenendenNachLokal('a\nb'), 'a\nb');
  });

  test('CF_UNICODETEXT ist UTF-16LE mit CR-LF und abschliessendem Nullzeichen', () => {
    // "a\nb" -> "a\r\nb\0" -> 61 00 0d 00 0a 00 62 00 00 00
    assert.equal(alsHex(kodiereUnicodeText('a\nb')), '61000d000a0062000000');
    assert.equal(kodiereUnicodeText('').length, 2, 'auch leerer Text traegt das Nullzeichen');
    assert.equal(alsHex(kodiereUnicodeText('')), '0000');
  });

  test('Umlaute und Zeichen ausserhalb der BMP ueberstehen CF_UNICODETEXT', () => {
    for (const text of ['Grüße', 'Straße\nWeg', '日本語', 'Emoji 😀 dahinter']) {
      assert.equal(dekodiereUnicodeText(kodiereUnicodeText(text)), text);
    }
  });

  test('Beim Lesen endet der Text am ersten Nullzeichen', () => {
    // Windows liefert oft einen groesseren Puffer, als der Text braucht.
    const mitMuell = Buffer.concat([kodiereUnicodeText('Hallo'), hex('ff ff ff ff')]);
    assert.equal(dekodiereUnicodeText(mitMuell), 'Hallo');
  });

  test('Ein fehlendes Nullzeichen macht den Text nicht kaputt', () => {
    assert.equal(dekodiereUnicodeText(Buffer.from('Hallo', 'ucs2')), 'Hallo');
  });

  test('Eine ungerade Byte-Zahl wird abgerundet statt halbe Zeichen zu erzeugen', () => {
    const schief = Buffer.concat([Buffer.from('Hi', 'ucs2'), hex('41')]);
    assert.equal(dekodiereUnicodeText(schief), 'Hi');
  });

  test('CF_TEXT ist ANSI mit CR-LF und Nullbyte', () => {
    // "a\nb" -> 61 0d 0a 62 00
    assert.equal(alsHex(kodiereAnsiText('a\nb')), '610d0a6200');
    assert.equal(dekodiereAnsiText(hex('610d0a6200')), 'a\nb');
  });

  test('CF_TEXT ersetzt Zeichen ausserhalb von latin1 durch ein Fragezeichen', () => {
    // Der Zeichensatz von CF_TEXT haengt an der Codepage der Serversitzung;
    // ein Ersatzzeichen ist besser als ein verschobener Puffer.
    assert.equal(alsHex(kodiereAnsiText('ä')), 'e400');
    assert.equal(dekodiereAnsiText(kodiereAnsiText('日本')), '??');
    assert.equal(kodiereAnsiText('日本').length, 3, 'zwei Fragezeichen plus Nullbyte');
  });

  test('Ein Text mit eingebettetem Nullzeichen endet dort - wie unter Windows', () => {
    assert.equal(dekodiereAnsiText(hex('4100' + '42')), 'A');
  });
});

// ------------------------------------------------------------- Zustandsmaschine

/** Sammelt die gesendeten PDUs einer Sitzung, damit Tests sie nachlesen. */
function neueSitzung(opts: Partial<ConstructorParameters<typeof CliprdrSession>[0]> = {}) {
  const gesendet: Buffer[] = [];
  const protokoll: string[] = [];
  const sitzung = new CliprdrSession({
    send: (d) => gesendet.push(d),
    log: (m) => protokoll.push(m),
    ...opts,
  });
  const typen = () => gesendet.map((d) => parseCliprdrPdu(d).msgType);
  const letztes = (typ: number) => {
    for (let i = gesendet.length - 1; i >= 0; i--) {
      const pdu = parseCliprdrPdu(gesendet[i]);
      if (pdu.msgType === typ) return pdu;
    }
    return undefined;
  };
  return { sitzung, gesendet, protokoll, typen, letztes };
}

/** Der uebliche Serverauftakt: Faehigkeiten, dann Monitor Ready. */
function serverAuftakt(sitzung: CliprdrSession, flags = CB_USE_LONG_FORMAT_NAMES): void {
  sitzung.verarbeite(buildClipboardCapabilities(flags, CB_CAPS_VERSION_2));
  sitzung.verarbeite(buildMonitorReady());
}

describe('CLIPRDR - Handshake', () => {
  test('Auf Monitor Ready folgen Faehigkeiten und eine Formatliste', () => {
    const { sitzung, typen } = neueSitzung();
    serverAuftakt(sitzung);
    assert.deepEqual(typen(), [CB_CLIP_CAPS, CB_FORMAT_LIST]);
    assert.equal(sitzung.istBereit, true);
  });

  test('Ohne lokalen Text ist die erste Formatliste leer', () => {
    const { sitzung, letztes } = neueSitzung();
    serverAuftakt(sitzung);
    assert.equal(letztes(CB_FORMAT_LIST)!.dataLen, 0);
  });

  test('Mit lokalem Text nennt die erste Formatliste beide Textformate', () => {
    const { sitzung, letztes } = neueSitzung({ leseLokalenText: () => 'schon was drin' });
    serverAuftakt(sitzung);
    const liste = parseFormatList(letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true });
    assert.deepEqual(liste.map((f) => f.formatId), [CF_UNICODETEXT, CF_TEXT]);
  });

  test('Das Temp-Verzeichnis wird nur auf Wunsch gesendet', () => {
    const ohne = neueSitzung();
    serverAuftakt(ohne.sitzung);
    assert.ok(!ohne.typen().includes(0x0006));

    const mit = neueSitzung({ tempDirectory: 'C:\\temp\\clip' });
    serverAuftakt(mit.sitzung);
    assert.deepEqual(mit.typen(), [CB_CLIP_CAPS, 0x0006, CB_FORMAT_LIST]);
  });

  test('Ohne Server-Faehigkeiten gelten kurze Formatnamen', () => {
    const { sitzung, letztes, protokoll } = neueSitzung();
    sitzung.verarbeite(buildMonitorReady());
    assert.equal(sitzung.langeFormatnamen, false);
    assert.ok(protokoll.some((z) => /ohne vorherige Server-Faehigkeiten/.test(z)));
    // Die Formatliste des Handshakes ist leer, also ist an ihr nichts zu sehen;
    // gepruefte wird die Kodierung an einer gemeldeten Liste.
    sitzung.melde('x');
    const body = letztes(CB_FORMAT_LIST)!.body;
    assert.equal(body.length, 2 * 36, 'zwei Formate zu je 36 Byte');
  });

  test('Meldet der Server keine langen Namen, benutzen wir sie auch nicht', () => {
    const { sitzung, letztes } = neueSitzung();
    serverAuftakt(sitzung, 0);
    assert.equal(sitzung.langeFormatnamen, false);
    sitzung.melde('x');
    assert.equal(letztes(CB_FORMAT_LIST)!.body.length, 2 * 36);
  });
});

describe('CLIPRDR - Server kopiert, wir lesen', () => {
  test('Eine Formatliste wird bestaetigt und die Textdaten werden angefragt', () => {
    const { sitzung, gesendet, typen } = neueSitzung();
    serverAuftakt(sitzung);
    gesendet.length = 0;

    sitzung.verarbeite(
      buildFormatList(
        [
          { formatId: CF_TEXT, name: '' },
          { formatId: CF_UNICODETEXT, name: '' },
        ],
        { longFormatNames: true },
      ),
    );
    assert.deepEqual(typen(), [0x0003, 0x0004]);
    assert.equal(parseCliprdrPdu(gesendet[0]).msgFlags, CB_RESPONSE_OK);
    assert.equal(parseFormatDataRequest(parseCliprdrPdu(gesendet[1]).body), CF_UNICODETEXT);
  });

  test('Die Antwort landet mit lokalen Zeilenenden im Rueckruf', () => {
    const empfangen: string[] = [];
    const { sitzung } = neueSitzung({ onServerText: (t) => empfangen.push(t) });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    sitzung.verarbeite(buildFormatDataResponse(kodiereUnicodeText('Zeile eins\nZeile zwei')));
    assert.deepEqual(empfangen, ['Zeile eins\nZeile zwei']);
  });

  test('CF_TEXT wird gelesen, wenn der Server nichts Besseres anbietet', () => {
    const empfangen: string[] = [];
    const { sitzung, gesendet } = neueSitzung({ onServerText: (t) => empfangen.push(t) });
    serverAuftakt(sitzung);
    gesendet.length = 0;
    sitzung.verarbeite(buildFormatList([{ formatId: CF_TEXT, name: '' }], { longFormatNames: true }));
    assert.equal(parseFormatDataRequest(parseCliprdrPdu(gesendet[1]).body), CF_TEXT);
    sitzung.verarbeite(buildFormatDataResponse(kodiereAnsiText('Grüße\nvom Server')));
    assert.deepEqual(empfangen, ['Grüße\nvom Server']);
  });

  test('Eine Liste ohne Textformat wird bestaetigt, aber nicht angefragt', () => {
    const { sitzung, gesendet, typen } = neueSitzung();
    serverAuftakt(sitzung);
    gesendet.length = 0;
    sitzung.verarbeite(buildFormatList([{ formatId: 49267, name: 'HTML Format' }], { longFormatNames: true }));
    assert.deepEqual(typen(), [0x0003]);
  });

  test('Eine abschlaegige Datenantwort wird protokolliert, nicht gemeldet', () => {
    const empfangen: string[] = [];
    const { sitzung, protokoll } = neueSitzung({ onServerText: (t) => empfangen.push(t) });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    sitzung.verarbeite(buildFormatDataResponseFehler());
    assert.deepEqual(empfangen, []);
    assert.ok(protokoll.some((z) => /nicht liefern/.test(z)));
  });

  test('Eine Datenantwort ohne offene Anfrage wird verworfen', () => {
    const empfangen: string[] = [];
    const { sitzung, protokoll } = neueSitzung({ onServerText: (t) => empfangen.push(t) });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatDataResponse(kodiereUnicodeText('unerwartet')));
    assert.deepEqual(empfangen, []);
    assert.ok(protokoll.some((z) => /unerwartete Datenantwort/.test(z)));
  });
});

describe('CLIPRDR - wir kopieren, der Server liest', () => {
  test('melde() schickt eine Formatliste mit beiden Textformaten', () => {
    const { sitzung, gesendet, letztes } = neueSitzung();
    serverAuftakt(sitzung);
    gesendet.length = 0;
    assert.equal(sitzung.melde('etwas Neues'), true);
    const liste = parseFormatList(letztes(CB_FORMAT_LIST)!.body, { longFormatNames: true });
    assert.deepEqual(liste.map((f) => f.formatId), [CF_UNICODETEXT, CF_TEXT]);
  });

  test('Derselbe Text wird nicht zweimal gemeldet', () => {
    const { sitzung, gesendet } = neueSitzung();
    serverAuftakt(sitzung);
    gesendet.length = 0;
    assert.equal(sitzung.melde('gleich'), true);
    assert.equal(sitzung.melde('gleich'), false);
    assert.equal(gesendet.length, 1);
  });

  test('Vor dem Handshake wird nichts gemeldet', () => {
    const { sitzung, gesendet } = neueSitzung();
    assert.equal(sitzung.melde('zu frueh'), false);
    assert.equal(gesendet.length, 0);
  });

  test('Die Datenanfrage des Servers wird aus dem lokalen Text beantwortet', () => {
    const { sitzung, gesendet, letztes } = neueSitzung({ leseLokalenText: () => 'Antwort\nmit Zeilen' });
    serverAuftakt(sitzung);
    gesendet.length = 0;
    sitzung.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    const antwort = letztes(CB_FORMAT_DATA_RESPONSE)!;
    assert.equal(antwort.msgFlags, CB_RESPONSE_OK);
    assert.equal(alsHex(antwort.body), alsHex(kodiereUnicodeText('Antwort\nmit Zeilen')));
    assert.ok(antwort.body.includes(Buffer.from('\r\n', 'ucs2')), 'CR-LF muss drinstehen');
  });

  test('Fragt der Server nach CF_TEXT, bekommt er ANSI', () => {
    const { sitzung, letztes } = neueSitzung({ leseLokalenText: () => 'a\nb' });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatDataRequest(CF_TEXT));
    assert.equal(alsHex(letztes(CB_FORMAT_DATA_RESPONSE)!.body), '610d0a6200');
  });

  test('Ohne lokalen Text kommt CB_RESPONSE_FAIL statt gar nichts', () => {
    const { sitzung, letztes } = neueSitzung({ leseLokalenText: () => undefined });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    assert.equal(letztes(CB_FORMAT_DATA_RESPONSE)!.msgFlags, CB_RESPONSE_FAIL);
  });

  test('Ein Format, das wir nicht anbieten, wird abschlaegig beantwortet', () => {
    const { sitzung, letztes } = neueSitzung({ leseLokalenText: () => 'Text' });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatDataRequest(49267));
    assert.equal(letztes(CB_FORMAT_DATA_RESPONSE)!.msgFlags, CB_RESPONSE_FAIL);
  });

  test('Uebernommener Servertext wird nicht sofort zurueckgemeldet', () => {
    // Sonst schaukeln sich beide Seiten hoch: der Server kopiert, wir uebernehmen,
    // die Aenderungspruefung meldet es zurueck, der Server fragt an - endlos.
    const { sitzung, gesendet } = neueSitzung();
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    sitzung.verarbeite(buildFormatDataResponse(kodiereUnicodeText('vom Server')));
    gesendet.length = 0;
    assert.equal(sitzung.melde('vom Server'), false);
    assert.equal(gesendet.length, 0);
  });
});

describe('CLIPRDR - Richtung', () => {
  test('nurSchreiben: eine Formatliste des Servers wird bestaetigt, aber nicht angefragt', () => {
    const { sitzung, gesendet, typen, protokoll } = neueSitzung({ richtung: 'nurSchreiben' });
    serverAuftakt(sitzung);
    gesendet.length = 0;
    sitzung.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    assert.deepEqual(typen(), [0x0003], 'nur die Bestaetigung, keine Datenanfrage');
    assert.ok(protokoll.some((z) => /Lesen ist abgeschaltet/.test(z)));
  });

  test('nurLesen: die Datenanfrage des Servers wird abgelehnt', () => {
    const { sitzung, letztes } = neueSitzung({ richtung: 'nurLesen', leseLokalenText: () => 'geheim' });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    assert.equal(letztes(CB_FORMAT_DATA_RESPONSE)!.msgFlags, CB_RESPONSE_FAIL);
  });

  test('nurLesen: melde() sendet nichts', () => {
    const { sitzung, gesendet } = neueSitzung({ richtung: 'nurLesen' });
    serverAuftakt(sitzung);
    gesendet.length = 0;
    assert.equal(sitzung.melde('nach draussen'), false);
    assert.equal(gesendet.length, 0);
  });

  test('nurLesen: der Handshake meldet auch vorhandenen lokalen Text nicht', () => {
    const { sitzung, letztes } = neueSitzung({ richtung: 'nurLesen', leseLokalenText: () => 'geheim' });
    serverAuftakt(sitzung);
    assert.equal(letztes(CB_FORMAT_LIST)!.dataLen, 0);
  });
});

describe('CLIPRDR - Groessengrenze', () => {
  test('Ohne Angabe gilt 1 MiB', () => {
    const { sitzung } = neueSitzung();
    assert.equal(sitzung.maxBytes, STANDARD_MAX_BYTES);
    assert.equal(STANDARD_MAX_BYTES, 1024 * 1024);
  });

  test('Unsinnige Werte fallen auf die Vorgabe zurueck', () => {
    for (const wert of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(neueSitzung({ maxBytes: wert }).sitzung.maxBytes, STANDARD_MAX_BYTES);
    }
    assert.equal(neueSitzung({ maxBytes: 64.7 }).sitzung.maxBytes, 64);
  });

  test('Zu grosser Servertext wird verworfen, nicht gemeldet', () => {
    const empfangen: string[] = [];
    const { sitzung, protokoll } = neueSitzung({ maxBytes: 100, onServerText: (t) => empfangen.push(t) });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    // 60 Zeichen ergeben 122 Byte in UTF-16LE samt Nullzeichen.
    sitzung.verarbeite(buildFormatDataResponse(kodiereUnicodeText('x'.repeat(60))));
    assert.deepEqual(empfangen, []);
    assert.ok(protokoll.some((z) => /ueberschreiten die Grenze/.test(z)));
  });

  test('Knapp unterhalb der Grenze geht durch', () => {
    const empfangen: string[] = [];
    const { sitzung } = neueSitzung({ maxBytes: 100, onServerText: (t) => empfangen.push(t) });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatList([{ formatId: CF_UNICODETEXT, name: '' }], { longFormatNames: true }));
    // 49 Zeichen -> 100 Byte, genau die Grenze.
    sitzung.verarbeite(buildFormatDataResponse(kodiereUnicodeText('y'.repeat(49))));
    assert.deepEqual(empfangen, ['y'.repeat(49)]);
  });

  test('Zu grosser lokaler Text wird gar nicht erst gemeldet', () => {
    const { sitzung, gesendet, protokoll } = neueSitzung({ maxBytes: 100 });
    serverAuftakt(sitzung);
    gesendet.length = 0;
    assert.equal(sitzung.melde('z'.repeat(60)), false);
    assert.equal(gesendet.length, 0);
    assert.ok(protokoll.some((z) => /nicht gemeldet/.test(z)));
  });

  test('Eine Datenanfrage nach zu grossem Text wird abschlaegig beantwortet', () => {
    const { sitzung, letztes } = neueSitzung({ maxBytes: 100, leseLokalenText: () => 'z'.repeat(60) });
    serverAuftakt(sitzung);
    sitzung.verarbeite(buildFormatDataRequest(CF_UNICODETEXT));
    assert.equal(letztes(CB_FORMAT_DATA_RESPONSE)!.msgFlags, CB_RESPONSE_FAIL);
  });
});

describe('CLIPRDR - Robustheit', () => {
  test('Eine unverstaendliche Nachricht beendet die Sitzung nicht', () => {
    const { sitzung, protokoll } = neueSitzung();
    sitzung.verarbeite(hex('0102'));
    assert.ok(protokoll.some((z) => /verworfen/.test(z)));
  });

  test('Ein unbekannter PDU-Typ wird protokolliert und uebergangen', () => {
    const { sitzung, gesendet, protokoll } = neueSitzung();
    sitzung.verarbeite(buildCliprdrPdu(0x00ff, 0, Buffer.alloc(0)));
    assert.equal(gesendet.length, 0);
    assert.ok(protokoll.some((z) => /0xff/.test(z)));
  });

  test('Eine Dateianfrage wird abgelehnt, statt den Server warten zu lassen', () => {
    const { sitzung, gesendet, protokoll } = neueSitzung();
    serverAuftakt(sitzung);
    gesendet.length = 0;
    sitzung.verarbeite(buildCliprdrPdu(0x0008, 0, Buffer.alloc(24)));
    assert.equal(parseCliprdrPdu(gesendet[0]).msgType, 0x0009);
    assert.equal(parseCliprdrPdu(gesendet[0]).msgFlags, CB_RESPONSE_FAIL);
    assert.ok(protokoll.some((z) => /Dateiuebertragung ist nicht umgesetzt/.test(z)));
  });

  test('zuruecksetzen() vergisst den Handshake', () => {
    const { sitzung } = neueSitzung();
    serverAuftakt(sitzung);
    assert.equal(sitzung.istBereit, true);
    sitzung.zuruecksetzen();
    assert.equal(sitzung.istBereit, false);
    assert.equal(sitzung.langeFormatnamen, false);
    assert.equal(sitzung.melde('nach dem Reset'), false);
  });

  test('Nach dem Zuruecksetzen gilt derselbe Text wieder als neu', () => {
    const { sitzung, gesendet } = neueSitzung();
    serverAuftakt(sitzung);
    sitzung.melde('Text');
    sitzung.zuruecksetzen();
    serverAuftakt(sitzung);
    gesendet.length = 0;
    assert.equal(sitzung.melde('Text'), true);
  });
});
