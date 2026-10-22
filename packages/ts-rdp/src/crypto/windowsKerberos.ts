import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import type { SecurityContext } from './securityContext.js';
import { RdpAuthError } from '../core/errors.js';

// PowerShell 7 supplies .NET's SSPI bridge. No password is put on the command
// line, in an environment variable, in a script file, or in an error message.
const BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Buffers;
using System.Net;
using System.Net.Security;
public sealed class RdpKerberosContext : IDisposable {
  private readonly NegotiateAuthentication auth;
  public RdpKerberosContext(string user, string password, string domain, string target) {
    auth = new NegotiateAuthentication(new NegotiateAuthenticationClientOptions {
      Package = "Kerberos", TargetName = target,
      Credential = new NetworkCredential(user, password, domain),
      RequiredProtectionLevel = ProtectionLevel.EncryptAndSign,
      RequireMutualAuthentication = true
    });
  }
  public object Step(string token) {
    var output = auth.GetOutgoingBlob(token, out var status);
    if (status != NegotiateAuthenticationStatusCode.Completed &&
        status != NegotiateAuthenticationStatusCode.ContinueNeeded)
      return new { error = "Kerberos/SSPI: " + status, status = status.ToString() };
    if (auth.IsAuthenticated) Verify();
    return new { token = output ?? "", complete = auth.IsAuthenticated };
  }
  private void Verify() {
    if (!auth.IsAuthenticated || auth.Package != "Kerberos" ||
        !auth.IsEncrypted || !auth.IsMutuallyAuthenticated)
      throw new InvalidOperationException("Kerberos mutual authentication and encryption required");
  }
  public string Protect(string data, bool encrypt) {
    Verify();
    var writer = new ArrayBufferWriter<byte>();
    bool encrypted;
    var status = encrypt ? auth.Wrap(Convert.FromBase64String(data), writer, true, out encrypted)
      : auth.Unwrap(Convert.FromBase64String(data), writer, out encrypted);
    if (status != NegotiateAuthenticationStatusCode.Completed || !encrypted)
      throw new InvalidOperationException("Kerberos message protection failed: " + status);
    return Convert.ToBase64String(writer.WrittenSpan);
  }
  public void Dispose() { auth.Dispose(); }
}
'@
$context = $null
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      switch ($request.op) {
        'init' { $context = [RdpKerberosContext]::new($request.user, $request.password, $request.domain, $request.target); $reply = @{ ok = $true } }
        'step' { $reply = $context.Step($request.token) }
        'seal' { $reply = @{ data = $context.Protect($request.data, $true) } }
        'unseal' { $reply = @{ data = $context.Protect($request.data, $false) } }
        default { throw 'Unknown Kerberos operation' }
      }
      [Console]::WriteLine(($reply | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      $request = $null
      $line = $null
    } catch {
      $message = $_.Exception.GetBaseException().Message
      if (-not $message.StartsWith('Kerberos')) { $message = 'Kerberos/SSPI operation failed; check domain, DNS, SPN, credentials and PowerShell 7' }
      [Console]::WriteLine((@{error=$message} | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      break
    }
  }
} finally { if ($null -ne $context) { $context.Dispose() } }
`;

/** Absence of Kerberos support/tickets, distinct from invalid credentials or integrity errors. */
export class KerberosUnavailableError extends Error {}

export function kerberosStatusError(status: string): Error {
  if (status === 'Unsupported' || status === 'TargetUnknown')
    return new KerberosUnavailableError('Kerberos ist für dieses System oder Ziel nicht verfügbar.');
  // Windows SSPI also returns UnknownCredentials for an incorrect password.
  // It must never be interpreted as permission to retry with NTLM.
  if (['InvalidCredentials', 'UnknownCredentials', 'CredentialsExpired'].includes(status))
    return new RdpAuthError(`Kerberos/SSPI: Anmeldedaten abgelehnt (${status}).`);
  return new Error(`Kerberos/SSPI: ${status}`);
}

export class WindowsKerberosContext implements SecurityContext {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private buffer = '';
  private closed = false;
  private readonly ready: Promise<unknown>;

  constructor(options: { host: string; user: string; password: string; domain: string }) {
    if (process.platform !== 'win32') throw new KerberosUnavailableError('Kerberos benötigt einen Windows Extension-Host mit PowerShell 7.');
    if (isIP(options.host) || !/^[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+$/i.test(options.host))
      throw new KerberosUnavailableError('Kerberos benötigt den DNS-Namen des Servers (FQDN), keine IP-Adresse.');
    const accountDomain = options.user.includes('\\') ? options.user.split('\\')[0] : options.domain;
    if (accountDomain && ['.', options.host.toLowerCase(), options.host.split('.')[0].toLowerCase()].includes(accountDomain.toLowerCase()))
      throw new KerberosUnavailableError('Lokale Serverkonten benötigen NTLMv2 statt Kerberos.');
    const executable = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    if (!existsSync(executable)) throw new KerberosUnavailableError('Kerberos benötigt PowerShell 7 unter Program Files.');
    this.child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(BRIDGE, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr.on('data', () => {}); // Never echo process output containing credentials.
    this.child.on('error', () => this.fail(new Error('Kerberos: PowerShell 7 konnte nicht gestartet werden.')));
    this.child.on('exit', () => this.fail(new Error('Kerberos: SSPI-Hilfsprozess wurde beendet.')));
    this.child.stdin.on('error', () => this.fail(new Error('Kerberos: SSPI-Eingabekanal wurde beendet.')));
    this.ready = this.request({ op: 'init', user: options.user, password: options.password,
      domain: options.domain, target: `TERMSRV/${options.host}` });
    // A child can fail before start() is called by the handshake.
    void this.ready.catch(() => {});
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) { this.fail(new Error('Kerberos: SSPI-Antwort ist zu groß.')); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let reply: any;
      try { reply = JSON.parse(line); } catch { this.fail(new Error('Kerberos: Ungültige SSPI-Antwort.')); return; }
      if (reply.error) {
        this.fail(typeof reply.status === 'string' ? kerberosStatusError(reply.status) : new Error(String(reply.error)));
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (pending) { clearTimeout(pending.timer); pending.resolve(reply); }
    }
  }

  private request(request: object): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Kerberos: SSPI-Kontext ist geschlossen.'));
    if (this.pending) return Promise.reject(new Error('Kerberos: Gleichzeitige SSPI-Anfragen sind nicht zulässig.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Kerberos: Zeitlimit für SSPI überschritten.')), 15000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.dispose();
  }

  async step(token?: Buffer): Promise<{ token: Buffer; complete: boolean }> {
    await this.ready;
    const reply = await this.request({ op: 'step', token: token?.toString('base64') ?? null });
    return { token: Buffer.from(reply.token, 'base64'), complete: reply.complete === true };
  }
  async seal(data: Buffer): Promise<Buffer> {
    await this.ready;
    return Buffer.from((await this.request({ op: 'seal', data: data.toString('base64') })).data, 'base64');
  }
  async unseal(data: Buffer): Promise<Buffer> {
    await this.ready;
    return Buffer.from((await this.request({ op: 'unseal', data: data.toString('base64') })).data, 'base64');
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Kerberos: SSPI-Kontext wurde geschlossen.')); }
    this.child.stdin.end();
    this.child.kill();
  }
}
