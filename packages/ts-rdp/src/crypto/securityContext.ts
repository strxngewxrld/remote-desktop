/** Stateful GSS/SSPI context used inside the verified TLS channel. */
export interface SecurityContext {
  step(token?: Buffer): Promise<{ token: Buffer; complete: boolean }>;
  seal(data: Buffer): Promise<Buffer>;
  unseal(data: Buffer): Promise<Buffer>;
  dispose(): void;
}
