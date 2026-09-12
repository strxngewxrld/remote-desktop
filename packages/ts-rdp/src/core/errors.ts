/** Fehler, die eindeutig dem Protokollablauf zuzuordnen sind. */
export class RdpError extends Error {
  constructor(message: string, public readonly code: string = 'RDP_ERROR') {
    super(message);
    this.name = 'RdpError';
  }
}

export class RdpProtocolError extends RdpError {
  constructor(message: string) {
    super(message, 'RDP_PROTOCOL');
    this.name = 'RdpProtocolError';
  }
}

export class RdpAuthError extends RdpError {
  constructor(message: string) {
    super(message, 'RDP_AUTH');
    this.name = 'RdpAuthError';
  }
}

/** Fehlercodes aus RDP_NEG_FAILURE (MS-RDPBCGR 2.2.1.2.2). */
export const NEG_FAILURE_CODES: Record<number, string> = {
  0x00000001: 'SSL_REQUIRED_BY_SERVER: Der Server verlangt TLS, der Client hat es nicht angeboten.',
  0x00000002: 'SSL_NOT_ALLOWED_BY_SERVER: Der Server ist auf Standard-RDP-Security konfiguriert.',
  0x00000003: 'SSL_CERT_NOT_ON_SERVER: Der Server hat kein gueltiges Zertifikat.',
  0x00000004: 'INCONSISTENT_FLAGS: Ungueltige Flag-Kombination im Negotiation-Request.',
  0x00000005: 'HYBRID_REQUIRED_BY_SERVER: Der Server verlangt NLA (CredSSP). Bitte Benutzername/Passwort angeben.',
  0x00000006: 'SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER: Der Server verlangt TLS mit Benutzerauthentifizierung.',
};

/**
 * Fehlercodes aus dem Set Error Info PDU (MS-RDPBCGR 2.2.5.1.1).
 *
 * Bewusst vollstaendig: ein unbekannter Code ist bei der Fehlersuche wertlos,
 * und gerade die Grafikcodes 0x112D bis 0x112F sagen sehr genau, woran ein
 * moderner Server scheitert.
 */
export const ERROR_INFO_CODES: Record<number, string> = {
  0x00000000: 'Kein Fehler.',
  0x00000001: 'RPC_INITIATED_DISCONNECT: Trennung durch ein Verwaltungswerkzeug in einer anderen Sitzung.',
  0x00000002: 'RPC_INITIATED_LOGOFF: Erzwungene Abmeldung durch ein Verwaltungswerkzeug.',
  0x00000003: 'IDLE_TIMEOUT: Leerlauf-Zeitlimit erreicht.',
  0x00000004: 'LOGON_TIMEOUT: Zeitlimit der aktiven Sitzung erreicht.',
  0x00000005: 'DISCONNECTED_BY_OTHERCONNECTION: Eine andere Verbindung hat die Sitzung uebernommen.',
  0x00000006: 'OUT_OF_MEMORY: Dem Server ist der Speicher ausgegangen.',
  0x00000007: 'SERVER_DENIED_CONNECTION: Der Server hat die Verbindung abgelehnt.',
  0x00000009: 'SERVER_INSUFFICIENT_PRIVILEGES: Unzureichende Berechtigungen.',
  0x0000000a: 'SERVER_FRESH_CREDENTIALS_REQUIRED: Gespeicherte Zugangsdaten werden nicht akzeptiert.',
  0x0000000b: 'RPC_INITIATED_DISCONNECT_BYUSER: Trennung durch ein Werkzeug in der Sitzung des Benutzers.',
  0x0000000c: 'LOGOFF_BY_USER: Der Benutzer hat sich abgemeldet.',
  0x0000000f: 'CLOSE_STACK_ON_DRIVER_NOT_READY: Der Anzeigetreiber der Sitzung hat sich nicht rechtzeitig gemeldet.',
  0x00000010: 'SERVER_DWM_CRASH: Der Fenstermanager der Sitzung ist abgestuerzt.',
  0x00000011: 'CLOSE_STACK_ON_DRIVER_FAILURE: Der Anzeigetreiber konnte den Start nicht abschliessen.',
  0x00000012: 'CLOSE_STACK_ON_DRIVER_IFACE_FAILURE: Der Anzeigetreiber ist gestartet, aber unbrauchbar.',
  0x00000017: 'SERVER_WINLOGON_CRASH: Der Anmeldedienst der Sitzung ist abgestuerzt.',
  0x00000018: 'SERVER_CSRSS_CRASH: Der CSRSS-Prozess der Sitzung ist abgestuerzt.',
  0x00000019: 'SERVER_SHUTDOWN: Der Server faehrt herunter.',
  0x0000001a: 'SERVER_REBOOT: Der Server startet neu.',

  0x00000100: 'LICENSE_INTERNAL: Interner Fehler der Lizenzkomponente.',
  0x00000101: 'LICENSE_NO_LICENSE_SERVER: Kein Lizenzserver erreichbar.',
  0x00000102: 'LICENSE_NO_LICENSE: Keine Clientzugriffslizenz verfuegbar.',
  0x00000103: 'LICENSE_BAD_CLIENT_MSG: Ungueltige Lizenznachricht vom Client.',
  0x00000104: 'LICENSE_HWID_DOESNT_MATCH_LICENSE: Die gespeicherte Lizenz wurde veraendert.',
  0x00000105: 'LICENSE_BAD_CLIENT_LICENSE: Die gespeicherte Lizenz hat ein ungueltiges Format.',
  0x00000106: 'LICENSE_CANT_FINISH_PROTOCOL: Netzwerkprobleme haben das Lizenzprotokoll beendet.',
  0x00000107: 'LICENSE_CLIENT_ENDED_PROTOCOL: Der Client hat das Lizenzprotokoll vorzeitig beendet.',
  0x00000108: 'LICENSE_BAD_CLIENT_ENCRYPTION: Eine Lizenznachricht war falsch verschluesselt.',
  0x00000109: 'LICENSE_CANT_UPGRADE_LICENSE: Die Lizenz konnte nicht erneuert werden.',
  0x0000010a: 'LICENSE_NO_REMOTE_CONNECTIONS: Der Server ist nicht fuer Remoteverbindungen lizenziert.',

  0x00000400: 'CB_DESTINATION_NOT_FOUND: Der Zielendpunkt wurde nicht gefunden.',
  0x00000402: 'CB_LOADING_DESTINATION: Der Zielendpunkt trennt sich gerade vom Verbindungsbroker.',
  0x00000404: 'CB_REDIRECTING_TO_DESTINATION: Fehler bei der Umleitung zum Zielendpunkt.',
  0x00000408: 'CB_DESTINATION_POOL_NOT_FREE: Keine freien Endpunkte im Pool.',
  0x00000409: 'CB_CONNECTION_CANCELLED: Die Verbindung wurde abgebrochen.',
  0x00000410: 'CB_CONNECTION_ERROR_INVALID_SETTINGS: Der Routing-Token konnte nicht geprueft werden.',

  0x000010c9: 'UNKNOWNPDUTYPE2: Unbekannter pduType2 im Share Data Header.',
  0x000010ca: 'UNKNOWNPDUTYPE: Unbekannter pduType im Share Control Header.',
  0x000010cb: 'DATAPDUSEQUENCE: Slowpath-Data-PDU ausser der Reihe empfangen.',
  0x000010cd: 'CONTROLPDUSEQUENCE: Aktivierungs-PDU ausser der Reihe empfangen.',
  0x000010ce: 'INVALIDCONTROLPDUACTION: Control PDU mit ungueltigem action-Feld.',
  0x000010cf: 'INVALIDINPUTPDUTYPE: Eingabeereignis mit ungueltigem Typ.',
  0x000010d0: 'INVALIDINPUTPDUMOUSE: Mausereignis mit ungueltigen pointerFlags.',
  0x000010d1: 'INVALIDREFRESHRECTPDU: Ungueltiges Refresh Rect PDU.',
  0x000010d2: 'CREATEUSERDATAFAILED: Der Server konnte die GCC-Antwortdaten nicht bilden.',
  0x000010d3: 'CONNECTFAILED: Die Kanalverbindungsphase ist fehlgeschlagen.',
  0x000010d4: 'CONFIRMACTIVEWRONGSHAREID: Confirm Active mit falscher Share-ID.',
  0x000010d5: 'CONFIRMACTIVEWRONGORIGINATOR: Confirm Active mit falscher originatorID.',
  0x000010de: 'INPUTPDUBADLENGTH: Eingabe-PDU zu kurz.',
  0x000010e0: 'SECURITYDATATOOSHORT: Signaturfeld eines Fastpath-Eingabe-PDUs zu kurz.',
  0x000010e1: 'VCHANNELDATATOOSHORT: Kanaldaten oder Channel PDU Header unvollstaendig.',
  0x000010e2: 'SHAREDATATOOSHORT: Share-Header oder Control-/Font-List-Daten zu kurz.',
  0x000010e3: 'BADSUPRESSOUTPUTPDU: Suppress Output PDU ungueltig.',
  0x000010e5: 'CONFIRMACTIVEPDUTOOSHORT: Confirm Active PDU zu kurz.',
  0x000010e7: 'CAPABILITYSETTOOSMALL: Capability Set zu kurz.',
  0x000010e8: 'CAPABILITYSETTOOLARGE: Capability Set gibt eine zu grosse Laenge an.',
  0x000010e9: 'NOCURSORCACHE: Zeiger-Capability ohne nutzbaren Cache.',
  0x000010ea: 'BADCAPABILITIES: Der Server hat die Capabilities des Clients nicht akzeptiert.',
  0x000010ec: 'VIRTUALCHANNELDECOMPRESSIONERR: Fehler beim Entpacken eines Virtual Channel PDU.',
  0x000010ed: 'INVALIDVCCOMPRESSIONTYPE: Ungueltiges Kompressionspaket im Channel PDU Header.',
  0x000010ef: 'INVALIDCHANNELID: Ungueltige MCS-Kanal-ID in einem Virtual Channel PDU.',
  0x000010f0: 'VCHANNELSTOOMANY: Mehr als 31 statische virtuelle Kanaele angefordert.',
  0x000010f3: 'REMOTEAPPSNOTENABLED: Die Sitzung kann nur RemoteApp-Anwendungen bereitstellen.',
  0x000010f4: 'CACHECAPNOTSET: Persistent Key List ohne die noetige Bitmap-Cache-Capability.',

  0x00001111: 'SECURITYDATATOOSHORT2: Basic Security Header unvollstaendig.',
  0x00001112: 'SECURITYDATATOOSHORT3: Security Header unvollstaendig.',
  0x00001114: 'SECURITYDATATOOSHORT5: Info Packet unvollstaendig.',
  0x00001116: 'SECURITYDATATOOSHORT7: Extended Info Packet: Adressfelder unvollstaendig.',
  0x0000111a: 'SECURITYDATATOOSHORT11: Extended Info Packet: Zeitzonenfeld unvollstaendig.',
  0x0000111c: 'SECURITYDATATOOSHORT13: Extended Info Packet: performanceFlags unvollstaendig.',
  0x00001126: 'SECURITYDATATOOSHORT23: Client Info PDU unvollstaendig.',
  0x00001129: 'BADMONITORDATA: Monitorliste passt nicht zur angegebenen Anzahl.',
  0x0000112a: 'VCDECOMPRESSEDREASSEMBLEFAILED: Entpackte Kanaldaten sprengen die Chunk-Groesse.',
  0x0000112b: 'VCDATATOOLONG: Virtual Channel PDU ueberschreitet die vereinbarte Chunk-Groesse.',
  0x0000112c: 'BAD_FRAME_ACK_DATA: Frame-Acknowledge-PDU zu kurz.',
  0x0000112d: 'GRAPHICSMODENOTSUPPORTED: Der vom Client angeforderte Grafikmodus wird nicht unterstuetzt.',
  0x0000112e: 'GRAPHICSSUBSYSTEMRESETFAILED: Das Grafik-Subsystem des Servers liess sich nicht zuruecksetzen.',
  0x0000112f:
    'GRAPHICSSUBSYSTEMFAILED: Das Grafik-Subsystem des Servers ist in einem Fehlerzustand und kann nicht weiter kodieren. ' +
    'Haeufigste Ursache: eine angebotene Capability-Kombination, die der Server nicht bedienen kann.',
  0x00001133: 'VCDECODINGERROR: Fehler bei der Verarbeitung dynamischer Kanaldaten.',
  0x00001134: 'VIRTUALDESKTOPTOOLARGE: Der virtuelle Desktop ist groesser als 32766 Pixel.',
  0x00001135: 'MONITORGEOMETRYVALIDATIONFAILED: Ungueltige Monitorgeometrie.',
  0x00001136: 'INVALIDMONITORCOUNT: monitorCount ist zu gross.',

  0x00001191: 'UPDATESESSIONKEYFAILED: Sitzungsschluessel konnten nicht erneuert werden.',
  0x00001192: 'DECRYPTFAILED: Entschluesselung fehlgeschlagen.',
  0x00001193: 'ENCRYPTFAILED: Verschluesselung fehlgeschlagen.',
  0x00001194: 'ENCPKGMISMATCH: Keine nutzbare Verschluesselungsmethode gefunden.',
  0x00001195: 'DECRYPTFAILED2: Unverschluesselte Daten in einem verschluesselten Strom.',
};
