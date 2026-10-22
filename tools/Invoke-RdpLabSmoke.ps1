[CmdletBinding()]
param([ValidateSet('auto','kerberos','ntlm')][string]$Mechanism = 'kerberos', [string]$TargetHost)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$credentialPath = Join-Path $repository '.vscode-test/ad-lab/test-credential.dpapi'
Add-Type -AssemblyName System.Security
$bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($credentialPath),
    $null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
try {
    $options = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    $options.nlaMechanism = $Mechanism
    if ($TargetHost) { $options.host = $TargetHost }
    Push-Location $repository
    try {
        $options | ConvertTo-Json -Compress | & 'C:\Program Files\nodejs\node.exe' tools/real-rdp-smoke.mjs
        $testExit = $LASTEXITCODE
    } finally { Pop-Location; $options.password = $null }
} finally { [Array]::Clear($bytes,0,$bytes.Length) }
exit $testExit
