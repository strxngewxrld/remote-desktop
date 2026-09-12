/**
 * Vertrauensstellung fuer Serverzertifikate (Trust on first use).
 *
 * RDP-Server verwenden fast immer selbstsignierte Zertifikate - eine
 * Standard-CA-Pruefung wuerde also immer fehlschlagen. Stattdessen wird der
 * Fingerabdruck beim ersten Verbinden bestaetigt und danach gespeichert; eine
 * spaetere Aenderung faellt dadurch sofort auf.
 */
import * as vscode from 'vscode';
import type { CertificateInfo } from 'ts-rdp';

const STORE_KEY = 'rdp.trustedCertificates';

type TrustStore = Record<string, string>;

export type TrustPolicy = 'trust-on-first-use' | 'always-ask' | 'ignore';

export class CertificateTrustStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get store(): TrustStore {
    return this.context.globalState.get<TrustStore>(STORE_KEY) ?? {};
  }

  getTrusted(hostKey: string): string | undefined {
    return this.store[hostKey];
  }

  async trust(hostKey: string, fingerprint: string): Promise<void> {
    await this.context.globalState.update(STORE_KEY, { ...this.store, [hostKey]: fingerprint });
  }

  async forget(hostKey: string): Promise<void> {
    const next = { ...this.store };
    delete next[hostKey];
    await this.context.globalState.update(STORE_KEY, next);
  }

  /**
   * Prueft das Zertifikat gemaess der eingestellten Richtlinie.
   * @returns true, wenn die Verbindung fortgesetzt werden darf.
   */
  async confirm(hostKey: string, cert: CertificateInfo, policy: TrustPolicy): Promise<boolean> {
    if (policy === 'ignore') return true;

    const known = this.getTrusted(hostKey);
    if (policy === 'trust-on-first-use' && known === cert.fingerprint256) return true;

    const changed = known !== undefined && known !== cert.fingerprint256;
    const detail = [
      `Server:        ${hostKey}`,
      `Ausgestellt für: ${cert.subject}`,
      `Aussteller:     ${cert.issuer}${cert.selfSigned ? ' (selbstsigniert)' : ''}`,
      `Gültig bis:     ${cert.validTo}`,
      '',
      `SHA-256-Fingerabdruck:`,
      cert.fingerprint256,
    ].join('\n');

    const message = changed
      ? 'Das Zertifikat dieses Servers hat sich geändert. Das kann auf einen Angriff hindeuten.'
      : 'Unbekanntes Serverzertifikat. Fingerabdruck prüfen und bestätigen.';

    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      'Vertrauen und merken',
      'Nur dieses Mal',
    );

    if (choice === 'Vertrauen und merken') {
      await this.trust(hostKey, cert.fingerprint256);
      return true;
    }
    return choice === 'Nur dieses Mal';
  }
}
