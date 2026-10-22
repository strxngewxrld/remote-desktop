import { CredSspClient, SecurityCredSspClient } from './credssp.js';
import type { NtlmOptions } from './ntlm.js';
import type { SecurityContext } from './securityContext.js';
import { KerberosUnavailableError, WindowsKerberosContext } from './windowsKerberos.js';

export type NlaMechanism = 'auto' | 'ntlm' | 'kerberos';

/** Prepare the first token before writing anything to the RDP server.
 * Only local Kerberos availability failures permit automatic NTLM fallback.
 * Errors after a token was sent (including binding/auth failures) never do.
 */
export async function prepareNla(
  mechanism: NlaMechanism,
  credentials: NtlmOptions & { host: string },
  publicKey: Buffer,
  fallback: () => void,
  createKerberos: (options: typeof credentials) => SecurityContext = options => new WindowsKerberosContext(options),
) {
  let security: SecurityContext | undefined;
  if (mechanism !== 'ntlm') {
    try {
      security = createKerberos(credentials);
      const client = new SecurityCredSspClient(credentials, publicKey, security);
      const initial = await client.start();
      const context = security;
      return { client, initial, mechanism: 'kerberos' as const, dispose: () => context.dispose() };
    } catch (error) {
      security?.dispose();
      if (mechanism !== 'auto' || !(error instanceof KerberosUnavailableError)) throw error;
      fallback();
    }
  }
  const client = new CredSspClient(credentials, publicKey);
  return { client, initial: client.start(), mechanism: 'ntlm' as const, dispose() {} };
}
