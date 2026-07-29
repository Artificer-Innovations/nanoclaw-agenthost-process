declare module "@onecli-sh/sdk" {
  export class OneCLI {
    constructor(opts?: { url?: string; apiKey?: string });
    ensureAgent(opts: { name: string; identifier: string }): Promise<void>;
    getContainerConfig(opts?: { agent?: string }): Promise<{
      env: Record<string, string>;
      caCertificate?: string;
      caCertificateContainerPath?: string;
      combinedCaCertificate?: string;
      combinedCaCertificateContainerPath?: string;
    } | null>;
  }
}
