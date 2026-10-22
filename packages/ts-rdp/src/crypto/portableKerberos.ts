import { isIP } from 'node:net';
import { RdpAuthError } from '../core/errors.js';
import { KDC_ERR } from '../kerberos/asn1.js';
import { KerberosFehler, type KdcAdresse } from '../kerberos/kdc.js';
import { KerberosKontext } from '../kerberos/kontext.js';
import { kerberosZiel } from '../kerberos/ziel.js';
import type { NtlmOptions } from './ntlm.js';
import type { SecurityContext } from './securityContext.js';
import { KerberosUnavailableError } from './windowsKerberos.js';

/** Optional overrides when AD DNS discovery or a UPN is unavailable. */
export interface KerberosOptions {
  realm?: string;
  kdc?: KdcAdresse[];
}

export type KerberosCredentials = NtlmOptions & {
  host: string;
  kerberos?: KerberosOptions;
  connectTimeout?: number;
};

/** Password-based Kerberos without a native module, keytab or PowerShell. */
export class PortableKerberosContext implements SecurityContext {
  private context?: KerberosKontext;
  private state: 'new' | 'starting' | 'negotiating' | 'complete' | 'disposed' | 'failed' = 'new';
  private readonly abort = new AbortController();

  constructor(
    private options: KerberosCredentials | undefined,
    private readonly create = KerberosKontext.erstellen,
  ) {}

  async step(token?: Buffer): Promise<{ token: Buffer; complete: boolean }> {
    if (this.state === 'new') {
      if (token !== undefined) throw new RdpAuthError('Kerberos: unerwartetes erstes Servertoken.');
      this.state = 'starting';
      const options = this.options!;
      try {
        if (isIP(options.host) || !options.host.includes('.') || /[\\/:@\s]/.test(options.host))
          throw new KerberosUnavailableError('Kerberos benötigt den DNS-Namen des Servers (FQDN), keine IP-Adresse.');
        if (options.connectTimeout !== undefined && (!Number.isFinite(options.connectTimeout) || options.connectTimeout <= 0))
          throw new Error('Kerberos: ungueltiges Verbindungszeitlimit.');
        for (const kdc of options.kerberos?.kdc ?? []) {
          if (!kdc || typeof kdc.host !== 'string' || !kdc.host.trim() || !Number.isInteger(kdc.port) || kdc.port < 1 || kdc.port > 65535)
            throw new Error('Kerberos: ungueltige KDC-Adresse.');
        }
        const separator = options.user.indexOf('\\');
        const domain = separator >= 0 ? options.user.slice(0, separator) : options.domain;
        const user = separator >= 0 ? options.user.slice(separator + 1) : options.user;
        if (domain && ['.', options.host.toLowerCase(), options.host.split('.')[0].toLowerCase()].includes(domain.toLowerCase()))
          throw new KerberosUnavailableError('Kerberos ist für ein lokales Serverkonto nicht verfügbar.');
        const target = kerberosZiel({ host: options.host, benutzer: user, domain, realm: options.kerberos?.realm });
        if (!target.ok) throw new KerberosUnavailableError(`Kerberos nicht verfügbar: ${target.grund}`);
        const context = await this.create({
          realm: target.realm, benutzer: target.benutzer, passwort: options.password,
          kdc: options.kerberos?.kdc, zeitlimitMs: options.connectTimeout,
          signal: this.abort.signal,
        }, target.dienst);
        this.abort.signal.throwIfAborted();
        this.context = context;
        this.state = 'negotiating';
        return { token: context.start(), complete: false };
      } catch (error) {
        this.abort.signal.throwIfAborted();
        this.state = 'failed';
        if (error instanceof KerberosFehler) {
          if (error.code === KDC_ERR.S_PRINCIPAL_UNKNOWN)
            throw new KerberosUnavailableError('Kerberos: der Dienstname ist dem KDC unbekannt.');
          if (error.code === KDC_ERR.PREAUTH_FAILED || error.code === KDC_ERR.C_PRINCIPAL_UNKNOWN)
            throw new RdpAuthError('Kerberos: Anmeldedaten abgelehnt.');
        }
        throw error;
      } finally {
        this.options = undefined;
      }
    }
    if (this.state !== 'negotiating' || !this.context || !token?.length)
      throw new RdpAuthError('Kerberos: unerwarteter Zustand oder fehlendes Servertoken.');
    try {
      const response = this.context.schritt(token);
      if (this.context.fertig) this.state = 'complete';
      return { token: response ?? Buffer.alloc(0), complete: this.context.fertig };
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  private established(): KerberosKontext {
    if (this.state !== 'complete' || !this.context)
      throw new RdpAuthError('Kerberos: Sicherheitskontext ist nicht aufgebaut.');
    return this.context;
  }

  async seal(data: Buffer): Promise<Buffer> { return this.established().seal(data); }
  async unseal(data: Buffer): Promise<Buffer> { return this.established().unseal(data); }

  dispose(): void {
    this.state = 'disposed';
    this.abort.abort();
    this.context = undefined;
    this.options = undefined;
  }
}
