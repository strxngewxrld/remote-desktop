<#
.SYNOPSIS
    Sammelt auf einem Windows-RDP-Server alles, was erklaert, warum das
    Grafik-Subsystem beim Oeffnen der Graphics Pipeline aussteigt
    (ERRINFO_GRAPHICSSUBSYSTEMFAILED, 0x112F).

.DESCRIPTION
    Das Skript merkt sich einen Startzeitpunkt, wartet auf den Verbindungs-
    versuch und liest danach alle Ereignisse dieses Zeitfensters aus den
    RDS-Protokollen. Zusaetzlich werden die Richtlinien- und Registry-Werte
    ausgegeben, die ueber den Grafikweg entscheiden (WDDM-Treiber, RemoteFX,
    Hardware-Encoder), sowie die vorhandenen Grafikadapter.

    Es wird nichts geaendert - nur gelesen.

.PARAMETER Minuten
    Statt interaktiv zu warten, einfach die letzten N Minuten auswerten.

.PARAMETER Ausgabe
    Zieldatei. Standard: rdp-diagnose.txt auf dem Desktop.

.EXAMPLE
    .\Sammle-RdpDiagnose.ps1
    Wartet auf den Verbindungsversuch und sammelt danach.

.EXAMPLE
    .\Sammle-RdpDiagnose.ps1 -Minuten 5
    Wertet die letzten fuenf Minuten aus, ohne zu warten.
#>
[CmdletBinding()]
param(
    [int]$Minuten = 0,
    [string]$Ausgabe = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'rdp-diagnose.txt')
)

$ErrorActionPreference = 'Continue'

# --- Rechte pruefen ---------------------------------------------------------
# Die RDS-Protokolle sind ohne erhoehte Rechte nicht lesbar. Lieber gleich
# sagen als spaeter eine leere Datei liefern.
$istAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $istAdmin) {
    Write-Warning 'Ohne Administratorrechte bleiben die RDS-Protokolle verschlossen.'
    Write-Warning 'Bitte PowerShell als Administrator starten und erneut ausfuehren.'
    return
}

# --- Zeitfenster festlegen --------------------------------------------------
if ($Minuten -gt 0) {
    $start = (Get-Date).AddMinutes(-$Minuten)
    Write-Host "Werte die letzten $Minuten Minuten aus (ab $start)." -ForegroundColor Cyan
}
else {
    $start = Get-Date
    Write-Host ''
    Write-Host '  Startzeit gesetzt auf ' -NoNewline
    Write-Host $start -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Stelle JETZT die Verbindung mit der VS-Code-Extension her.' -ForegroundColor Cyan
    Write-Host '  Warte, bis sie abbricht, und druecke dann hier die Eingabetaste.' -ForegroundColor Cyan
    Write-Host ''
    [void](Read-Host '  Bereit? Eingabetaste druecken')
    # Ein paar Sekunden Luft, damit spaet geschriebene Eintraege noch mitkommen.
    Start-Sleep -Seconds 3
}

$protokolle = @(
    'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational',
    'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Admin',
    'Microsoft-Windows-RemoteDesktopServices-SessionServices/Operational',
    'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational',
    'Microsoft-Windows-TerminalServices-LocalSessionManager/Admin',
    'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational',
    'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Admin',
    'Microsoft-Windows-TerminalServices-RDPClient/Operational',
    'System',
    'Application'
)

$zeilen = New-Object System.Collections.Generic.List[string]
function Schreibe([string]$text) {
    $zeilen.Add($text) | Out-Null
    Write-Host $text
}

Schreibe '================================================================'
Schreibe "RDP-Diagnose  -  $(Get-Date)"
Schreibe "Rechner: $env:COMPUTERNAME"
Schreibe "Zeitfenster ab: $start"
Schreibe '================================================================'

# --- Ereignisse -------------------------------------------------------------
$gesamt = 0
foreach ($protokoll in $protokolle) {
    $eintraege = $null
    try {
        $eintraege = Get-WinEvent -FilterHashtable @{
            LogName   = $protokoll
            StartTime = $start
        } -ErrorAction Stop
    }
    catch {
        # Get-WinEvent wirft einen Fehler, wenn das Protokoll leer ist oder
        # gar nicht existiert - beides ist hier kein Problem, nur eine Notiz.
        $grund = $_.Exception.Message
        if ($grund -match 'No events were found') {
            continue
        }
        Schreibe ''
        Schreibe "--- $protokoll : nicht lesbar ($grund)"
        continue
    }

    if (-not $eintraege) { continue }

    # System und Application sind riesig - dort nur Grafik- und RDS-Relevantes.
    if ($protokoll -in @('System', 'Application')) {
        $eintraege = $eintraege | Where-Object {
            $_.LevelDisplayName -in @('Fehler', 'Error', 'Warnung', 'Warning', 'Kritisch', 'Critical') -or
            $_.ProviderName -match 'TermService|RemoteDesktop|RdpCoreTS|Display|Dwm|Graphics|nvlddmkm|amdkmdag|igfx'
        }
        if (-not $eintraege) { continue }
    }

    Schreibe ''
    Schreibe '----------------------------------------------------------------'
    Schreibe "PROTOKOLL: $protokoll   ($($eintraege.Count) Eintraege)"
    Schreibe '----------------------------------------------------------------'

    foreach ($e in ($eintraege | Sort-Object TimeCreated)) {
        $gesamt++
        $stufe = $e.LevelDisplayName
        Schreibe ''
        Schreibe ("[{0:HH:mm:ss.fff}] {1} | ID {2} | {3}" -f $e.TimeCreated, $stufe, $e.Id, $e.ProviderName)
        $text = $e.Message
        if ([string]::IsNullOrWhiteSpace($text)) { $text = '(keine Meldung hinterlegt)' }
        foreach ($zeile in ($text -split "`r?`n")) {
            if ($zeile.Trim()) { Schreibe ("    " + $zeile.Trim()) }
        }
    }
}

Schreibe ''
Schreibe "Ereignisse insgesamt: $gesamt"

# --- Richtlinien und Registry ----------------------------------------------
# Diese Werte entscheiden, welchen Grafikweg der Server ueberhaupt aufsetzt.
Schreibe ''
Schreibe '================================================================'
Schreibe 'RICHTLINIEN UND REGISTRY (Grafikweg)'
Schreibe '================================================================'

$pfade = @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services',
    'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp',
    'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
)
$interessant = @(
    'fEnableWddmDriver', 'bEnumerateHWBeforeSW', 'AVC444ModePreferred',
    'AVCHardwareEncodePreferred', 'fEnableVirtualizedGraphics', 'MaxCompressionLevel',
    'ColorDepth', 'fEnableRemoteFXAdvancedRemoteApp', 'VGOptimization_CaptureFrameRate',
    'VGOptimization_CompressionRatio', 'DWMFRAMEINTERVAL', 'fSingleSessionPerUser'
)

foreach ($pfad in $pfade) {
    Schreibe ''
    Schreibe "--- $pfad"
    if (-not (Test-Path $pfad)) {
        Schreibe '    (Schluessel nicht vorhanden - dann gilt die Voreinstellung)'
        continue
    }
    $werte = Get-ItemProperty -Path $pfad -ErrorAction SilentlyContinue
    $gefunden = $false
    foreach ($name in $interessant) {
        if ($null -ne $werte.$name) {
            Schreibe ("    {0} = {1}" -f $name, $werte.$name)
            $gefunden = $true
        }
    }
    if (-not $gefunden) { Schreibe '    (keiner der grafikrelevanten Werte gesetzt)' }
}

# --- Grafikadapter ----------------------------------------------------------
Schreibe ''
Schreibe '================================================================'
Schreibe 'GRAFIKADAPTER'
Schreibe '================================================================'
try {
    $adapter = Get-CimInstance Win32_VideoController -ErrorAction Stop
    foreach ($a in $adapter) {
        Schreibe ''
        Schreibe "    Name          : $($a.Name)"
        Schreibe "    Treiber       : $($a.DriverVersion)  vom $($a.DriverDate)"
        Schreibe "    Status        : $($a.Status)  (Verfuegbarkeit $($a.Availability))"
        Schreibe "    Aufloesung    : $($a.CurrentHorizontalResolution)x$($a.CurrentVerticalResolution)"
    }
}
catch {
    Schreibe "    (nicht ermittelbar: $($_.Exception.Message))"
}

# --- Sitzungen --------------------------------------------------------------
Schreibe ''
Schreibe '================================================================'
Schreibe 'SITZUNGEN'
Schreibe '================================================================'
try {
    $ausgabe = & query session 2>&1
    foreach ($zeile in $ausgabe) { Schreibe ("    " + $zeile) }
}
catch {
    Schreibe "    (query session nicht verfuegbar)"
}

# --- Betriebssystem ---------------------------------------------------------
Schreibe ''
Schreibe '================================================================'
Schreibe 'SYSTEM'
Schreibe '================================================================'
try {
    $os = Get-CimInstance Win32_OperatingSystem
    Schreibe "    $($os.Caption)  Build $($os.BuildNumber)  Version $($os.Version)"
} catch { }

# --- Speichern --------------------------------------------------------------
try {
    $zeilen | Set-Content -Path $Ausgabe -Encoding UTF8
    Write-Host ''
    Write-Host "Fertig. Datei geschrieben: $Ausgabe" -ForegroundColor Green
    Write-Host 'Diese Datei bitte zurueckgeben.' -ForegroundColor Green
}
catch {
    Write-Warning "Konnte die Datei nicht schreiben: $($_.Exception.Message)"
    Write-Warning 'Die Ausgabe steht oben vollstaendig im Fenster.'
}
