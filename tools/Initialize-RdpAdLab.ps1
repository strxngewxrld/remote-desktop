[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'Promote', 'Verify')][string]$Mode = 'Prepare',
    [string]$DomainName = 'rdp.test',
    [string]$NetbiosName = 'RDPTEST'
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$labDirectory = Join-Path $repository '.vscode-test/ad-lab'
$configPath = Join-Path $labDirectory 'configuration.json'
New-Item -ItemType Directory -Path $labDirectory -Force | Out-Null

if ($Mode -eq 'Verify') {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Import-Module ActiveDirectory
    $domain = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try { $domain = Get-ADDomain -Identity $configuration.DomainName; break }
        catch { Start-Sleep -Seconds 5 }
    }
    if (-not $domain) { throw 'The AD domain did not become available after reboot.' }
    Import-Module DnsServer
    if ($configuration.Forwarders.Count) {
        Set-DnsServerForwarder -IPAddress @($configuration.Forwarders) | Out-Null
    }
    $fqdn = "$($configuration.ComputerName).$($configuration.DomainName)".ToLowerInvariant()
    $computerAccount = Get-ADComputer -Identity $configuration.ComputerName -Properties ServicePrincipalName
    foreach ($spn in @("TERMSRV/$($configuration.ComputerName)", "TERMSRV/$fqdn")) {
        $owners = @(Get-ADObject -LDAPFilter "(servicePrincipalName=$spn)")
        if ($owners.Count -gt 1 -or ($owners.Count -eq 1 -and $owners[0].DistinguishedName -ne $computerAccount.DistinguishedName)) {
            throw "SPN is not unique: $spn"
        }
        if ($spn -notin $computerAccount.ServicePrincipalName) {
            Set-ADComputer -Identity $computerAccount -ServicePrincipalNames @{ Add = $spn }
        }
    }
    $status = [ordered]@{
        CheckedAt = (Get-Date).ToString('o')
        Domain = $domain.DNSRoot
        DomainSid = $domain.DomainSID.Value
        DomainController = (Get-ADDomainController -Discover).HostName
        Services = @(Get-Service NTDS,Kdc,DNS,Netlogon,'MicrosoftDynamicsNavServer$BC290' -ErrorAction SilentlyContinue |
            Select-Object Name,@{Name='Status';Expression={$_.Status.ToString()}})
        Accounts = @(Get-ADUser -Filter * | Select-Object SamAccountName,Enabled,@{Name='SID';Expression={$_.SID.Value}})
    }
    $status | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $labDirectory 'after-reboot.json')
    # Create a dedicated non-administrator for the actual Kerberos RDP test.
    $testUserName = 'rdp-e2e-test'
    $passwordText = 'Rdp!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
    $testUser = Get-ADUser -Filter "SamAccountName -eq '$testUserName'"
    if ($testUser) {
        Set-ADAccountPassword -Identity $testUser -Reset -NewPassword $password
        Enable-ADAccount -Identity $testUser
    } else {
        New-ADUser -Name $testUserName -SamAccountName $testUserName -UserPrincipalName "$testUserName@$($configuration.DomainName)" -AccountPassword $password -Enabled $true
        $testUser = Get-ADUser -Identity $testUserName
    }
    Set-ADUser -Identity $testUser -AccountExpirationDate (Get-Date).AddHours(4)
    Add-ADGroupMember -Identity 'S-1-5-32-555' -Members $testUser
    # DC policy normally grants RDP only to administrators. Grant only this test SID.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class RdpLabLogonRight {
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr Root, Name; public uint Flags; public IntPtr Descriptor, Qos; }
  [StructLayout(LayoutKind.Sequential)] struct Text { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attrs, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, Text[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  public static void Grant(string sidText) { Grant(sidText, "SeRemoteInteractiveLogonRight"); }
  public static void Grant(string sidText, string name) {
    var attributes = new Attributes { Length = Marshal.SizeOf<Attributes>() };
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x810, out var handle);
    if (status != 0) throw new InvalidOperationException("LsaOpenPolicy: " + status);
    var right = new Text { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)((name.Length + 1) * 2), Buffer = Marshal.StringToHGlobalUni(name) };
    try {
      var sid = new SecurityIdentifier(sidText); var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
      status = LsaAddAccountRights(handle, bytes, new[] { right }, 1);
      if (status != 0) throw new InvalidOperationException("LsaAddAccountRights: " + status);
    } finally { Marshal.FreeHGlobal(right.Buffer); LsaClose(handle); }
  }
}
'@
    [RdpLabLogonRight]::Grant($testUser.SID.Value)
    Add-Type -AssemblyName System.Security
    $credentialJson = @{ host=$fqdn; domain=$configuration.NetbiosName; username=$testUserName; password=$passwordText; nlaMechanism='kerberos' } | ConvertTo-Json -Compress
    $credentialBytes = [Text.Encoding]::UTF8.GetBytes($credentialJson)
    [IO.File]::WriteAllBytes((Join-Path $labDirectory 'test-credential.dpapi'),
        [Security.Cryptography.ProtectedData]::Protect($credentialBytes,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))
    [Array]::Clear($credentialBytes,0,$credentialBytes.Length)
    & auditpol.exe /backup "/file:$(Join-Path $labDirectory 'audit-before.csv')" | Out-Null
    & auditpol.exe /set '/subcategory:{0CCE9240-69AE-11D9-BED3-505054503030}' /success:enable /failure:enable | Out-Null
    & auditpol.exe /set '/subcategory:{0CCE9215-69AE-11D9-BED3-505054503030}' /success:enable /failure:enable | Out-Null
    $started = Get-Date
    Push-Location $repository
    try {
        $credentialJson | & 'C:\Program Files\nodejs\node.exe' tools/real-rdp-smoke.mjs *> logs/kerberos-real-windows-rdp.log
        $status['KerberosRdpExitCode'] = $LASTEXITCODE
    } finally { Pop-Location; $credentialJson = $null; $passwordText = $null }
    $events = @(Get-WinEvent -FilterHashtable @{LogName='Security';Id=4624,4769;StartTime=$started} -ErrorAction SilentlyContinue | ForEach-Object {
        $xml = [xml]$_.ToXml(); $data = @{}
        foreach ($item in $xml.Event.EventData.Data) { $data[$item.Name] = $item.'#text' }
        if ($data.TargetUserName -like "$testUserName*") {
            [PSCustomObject]@{ Id=$_.Id; Time=$_.TimeCreated; User=$data.TargetUserName; AuthenticationPackage=$data.AuthenticationPackageName; ServiceName=$data.ServiceName; LogonType=$data.LogonType; Status=$data.Status }
        }
    })
    $events | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $labDirectory 'kerberos-security-events.json')
    $status['KerberosSecurityEvents'] = $events
    $status | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $labDirectory 'after-reboot.json')
    Unregister-ScheduledTask -TaskName 'RdpAdLab-VerifyAfterReboot' -Confirm:$false -ErrorAction SilentlyContinue
    $status | ConvertTo-Json -Depth 7
    return
}

$computer = Get-CimInstance Win32_ComputerSystem
if ($computer.PartOfDomain) { throw 'This script only creates a forest on a standalone server.' }
$network = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' })
if ($network.Count -ne 1 -or $network[0].PrefixOrigin -ne 'Manual') {
    throw 'Expected exactly one manually configured IPv4 address; review the network first.'
}
$configuration = [ordered]@{
    DomainName = $DomainName
    NetbiosName = $NetbiosName
    ComputerName = $computer.Name
    Address = $network[0].IPAddress
    Forwarders = @((Get-DnsClientServerAddress -InterfaceIndex $network[0].InterfaceIndex -AddressFamily IPv4).ServerAddresses)
    OriginalAccounts = @(Get-LocalUser | Select-Object Name,@{Name='SID';Expression={$_.SID.Value}},Enabled)
    OriginalServices = @(Get-CimInstance Win32_Service | Where-Object { $_.StartName -like '.\*' } | Select-Object Name,StartName,State)
}
$configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath
# Recovery secrets and test credentials are readable only by Administrators and SYSTEM.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $labDirectory -AclObject $acl

Add-Type -AssemblyName System.Security
$secretBytes = [System.Text.Encoding]::UTF8.GetBytes('Rdp!' + [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
$safeModePassword = ConvertTo-SecureString ([System.Text.Encoding]::UTF8.GetString($secretBytes)) -AsPlainText -Force
$protected = [System.Security.Cryptography.ProtectedData]::Protect($secretBytes, $null,
    [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
[System.IO.File]::WriteAllBytes((Join-Path $labDirectory 'dsrm.dpapi'), $protected)
[Array]::Clear($secretBytes, 0, $secretBytes.Length)
Import-Module ADDSDeployment
$parameters = @{
    DomainName = $DomainName; DomainNetbiosName = $NetbiosName
    InstallDns = $true; CreateDnsDelegation = $false
    SafeModeAdministratorPassword = $safeModePassword
    NoRebootOnCompletion = $true; Force = $true
}
$result = Test-ADDSForestInstallation @parameters
$result | Format-List Status,Message,RebootRequired
if ($result.Status -ne 'Success') { throw 'AD forest prerequisites did not pass.' }
if ($Mode -eq 'Prepare') { return }

# Restrict new AD/DNS inbound rules to this machine: the host has a public IP.
# Existing RDP and application firewall rules are left in place.
$baselinePath = Join-Path $repository 'logs/ad-firewall-before.xml'
if (-not (Test-Path -LiteralPath $baselinePath)) { throw 'Firewall baseline is missing.' }
$beforeRules = @(Import-Clixml -LiteralPath $baselinePath | ForEach-Object Name)
Install-WindowsFeature DNS -IncludeManagementTools -Restart:$false | Out-Null
$newInbound = @(Get-NetFirewallRule | Where-Object {
    $_.Name -notin $beforeRules -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow'
})
$newInbound | Set-NetFirewallRule -RemoteAddress $configuration.Address -ErrorAction Stop
$newInbound | Select-Object Name,Enabled | Export-Clixml -LiteralPath (Join-Path $labDirectory 'restricted-firewall.xml')

$executable = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Run this script in PowerShell 7.' }
$action = New-ScheduledTaskAction -Execute $executable -Argument "-NoLogo -NoProfile -NonInteractive -File `"$PSCommandPath`" -Mode Verify"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName 'RdpAdLab-VerifyAfterReboot' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
$result = Install-ADDSForest @parameters
$result | Format-List Status,Message,RebootRequired
if ($result.Status -ne 'Success') { throw 'AD promotion did not complete successfully; no reboot requested by this script.' }
Write-Output 'Forest promotion complete. Restarting in 30 seconds. Reconnect as RDPTEST\Administrator.'
& shutdown.exe /r /t 30 /d p:2:4 /c 'Approved AD test forest rdp.test installation'
if ($LASTEXITCODE -ne 0) { throw 'Could not schedule the required restart.' }
