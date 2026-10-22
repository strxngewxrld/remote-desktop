[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'Install', 'Status')][string]$Mode = 'Status',
    [string]$PackageDirectory = "$env:ProgramData\RdpKerberosLab\Updates\KB5129235"
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Microsoft catalog update 797fec39-6d79-43b7-8585-8d95c6017cc3.
# This targeted repair is for the observed lab build 26100.33438. It does
# not install an update or restart the server in Prepare/Status mode.
$uri = 'https://catalog.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/f1a4c3fd-2179-4b06-86b5-95ba39b91a1f/public/windows11.0-kb5129235-x64_3e0946284249f1976424b6fe01b3520d267a4dc9.msu'
$expectedSha1 = '3E0946284249F1976424B6FE01B3520D267A4DC9'
$expectedSha256 = 'C42CB3A8C7641B07077BE38023685FF5FD27B48416BF065D5883BD98C88CEC6E'
$package = Join-Path $PackageDirectory 'windows11.0-kb5129235-x64.msu'
$statusPath = Join-Path $PackageDirectory 'status.json'
$version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
if ($version.CurrentBuild -ne '26100' -or $version.ProductName -notlike '*Server 2025*') {
    throw 'This repair is only for the inspected Windows Server 2025 build 26100.'
}
if ($Mode -eq 'Status') {
    [ordered]@{
        Build = "$($version.CurrentBuild).$($version.UBR)"
        Preparation = $(if (Test-Path $statusPath) { Get-Content $statusPath -Raw | ConvertFrom-Json } else { $null })
        Services = @(Get-Service NTDS,Kdc,DNS,sshd,TermService,'MSSQL$SQLEXPRESS','MicrosoftDynamicsNavServer$BC290' -ErrorAction SilentlyContinue |
            Select-Object Name,@{Name='Status';Expression={$_.Status.ToString()}})
    } | ConvertTo-Json -Depth 6
    return
}
if ([int]$version.UBR -ge 33451) {
    Write-Output 'This build already includes the RDS fix; no update was installed.'
    return
}
if ([int]$version.UBR -ne 33438) { throw 'Unexpected source build; review the update prerequisites first.' }
New-Item -ItemType Directory -Path $PackageDirectory -Force | Out-Null
if ($Mode -eq 'Prepare') {
    try {
        $drive = New-Object System.IO.DriveInfo ([IO.Path]::GetPathRoot($PackageDirectory))
        if ($drive.AvailableFreeSpace -lt 10GB) { throw 'At least 10 GB of free disk space is required for preparation.' }
        @{ State='Downloading'; StartedAt=(Get-Date).ToUniversalTime().ToString('o'); Source=$uri } |
            ConvertTo-Json | Set-Content $statusPath
        if (-not (Test-Path $package) -or (Get-FileHash $package -Algorithm SHA256).Hash -ne $expectedSha256) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $client = New-Object Net.WebClient
            try { $client.DownloadFile($uri, "$package.partial") } finally { $client.Dispose() }
            if ((Get-FileHash "$package.partial" -Algorithm SHA1).Hash -ne $expectedSha1 -or
                (Get-FileHash "$package.partial" -Algorithm SHA256).Hash -ne $expectedSha256) {
                throw 'Package digest does not match the Microsoft Update Catalog.'
            }
            Move-Item "$package.partial" $package -Force
        }
        $signature = Get-AuthenticodeSignature $package
        [ordered]@{
            State='Ready'; Package=$package; Bytes=(Get-Item $package).Length
            SHA1=(Get-FileHash $package -Algorithm SHA1).Hash
            SHA256=(Get-FileHash $package -Algorithm SHA256).Hash
            AuthenticodeStatus=$signature.Status.ToString()
            Signer=$(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
            Source=$uri; PreparedAt=(Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json | Set-Content $statusPath
        Get-Content $statusPath -Raw
    } catch {
        @{State='Failed';Message=$_.Exception.Message} | ConvertTo-Json | Set-Content $statusPath
        throw
    }
    return
}
# Install is a separate, explicit operation after review of the prepared
# package. DISM validates the update's signed servicing catalogs. /NoRestart
# prevents an unexpected restart; the required reboot is a separate action.
if (-not (Test-Path $package) -or (Get-FileHash $package -Algorithm SHA256).Hash -ne $expectedSha256) {
    throw 'A verified package is missing. Run Prepare first.'
}
$process = Start-Process -FilePath "$env:SystemRoot\System32\dism.exe" -ArgumentList @(
    '/Online', '/Add-Package', "/PackagePath:`"$package`"", '/NoRestart', '/Quiet',
    "/LogPath:`"$(Join-Path $PackageDirectory 'install.log')`""
) -Wait -PassThru
if ($process.ExitCode -notin @(0,3010)) { throw "DISM failed with exit code $($process.ExitCode); inspect install.log." }
@{State='Installed';ExitCode=$process.ExitCode;RestartRequired=$true;InstalledAt=(Get-Date).ToUniversalTime().ToString('o')} |
    ConvertTo-Json | Set-Content $statusPath
Get-Content $statusPath -Raw
