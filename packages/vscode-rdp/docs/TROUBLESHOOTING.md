# Hilfe bei Verbindungsproblemen

## Verbindung erreicht den Server nicht

1. **RDP: Laufzeitumgebung anzeigen (lokal oder entfernt)** aufrufen.
   Bei Remote-SSH, WSL und Containern öffnet der entfernte Extension-Host den
   RDP-Socket. DNS, VPN und Port 3389 müssen von dort aus erreichbar sein.
2. Servername und optionalen Port prüfen, zum Beispiel `server.example:3389`.
3. **RDP: Protokoll anzeigen** öffnen. Zeitpunkt und Fehlermeldung festhalten.
   Protokolle vor dem Teilen auf Servernamen, Benutzernamen und andere private Daten prüfen.

## Anmeldung oder Zertifikat wird abgelehnt

Den Zertifikatsfingerabdruck beim Serverbetreiber überprüfen. Ein geänderter
Fingerabdruck muss geklärt werden; die Zertifikatsprüfung nicht zur Fehlersuche abschalten.
Über **Verbinden als …** die verwendeten Zugangsdaten prüfen.

Kerberos benötigt einen Server-FQDN und Zugriff auf den KDC. Windows nutzt
PowerShell 7/SSPI; auf macOS/Linux den Benutzer als UPN angeben oder
`rdp.kerberosRealm` setzen. Bei fehlender AD-DNS-Auflösung kann
`rdp.kerberosKdc` den KDC vorgeben. `rdp.nlaMechanism: "auto"` kann bei fehlender
Kerberos-Verfügbarkeit vor dem Tokenaustausch NTLMv2 verwenden, aber nicht nach
einem Anmelde- oder Sicherheitsfehler. Mehr dazu im [Handbuch](ANWENDERHANDBUCH.md).

## Angemeldet, aber schwarzes Bild

`rdp.graphicsPipeline` aktivieren (Vorgabe), danach neu verbinden.
**RDP: Bildschirm neu anfordern** und das Diagnose-Overlay helfen beim Eingrenzen.
H.264 benötigt WebCodecs; AVC444 wird nicht unterstützt.

## Zwischenablage oder Dateien fehlen

`rdp.clipboard.enabled`, Richtung und Größenlimits prüfen. Text kann in beide
Richtungen übertragen werden; Dateien nur vom Arbeitsplatz zum Server.
Für Datei-Paste das Sitzungsfenster fokussieren. Ordner-Paste wird nicht unterstützt.

## Workspace-Laufwerk fehlt oder ist schreibgeschützt

Die Ordner im gleichen VS-Code-Fenster öffnen, Laufwerksumleitung aktivieren
und die Freigabe bestätigen. Nach Änderungen neu verbinden.
Unter Windows `\\tsclient\VS_Code` öffnen. Die Vorgabe ist `readOnly`;
Schreiben erfordert `readWrite` und eine gesonderte Bestätigung.
**RDP: Laufwerksfreigaben vergessen** erlaubt eine neue Entscheidung.
Ausgeschlossene Dateien und Symlinks bleiben unsichtbar.

## Bekannte Grenzen

Kein Audio, RD Gateway, RemoteApp, AVC444 oder Per-Device-CAL-Ausstellung.
Zusätzliche Monitore werden rechts angeordnet. Details und Bedienung stehen
im [Anwenderhandbuch](ANWENDERHANDBUCH.md).
