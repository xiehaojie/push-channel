
export type PushChannelConfig = {
  enabled: boolean;
  middlewareUrl: string; // The URL of the middleware service (e.g., http://localhost:3001)
  listenPort: number;    // The port for this plugin to listen on (e.g., 3000)
  listenPath: string;    // The path for this plugin webhook (e.g., /webhook)
  /** Optional allowlist of senderIds allowed to trigger the agent. Omit to allow all. */
  allowedSenders?: string[];
  /** When true, send a "typing…" marker to the middleware while the AI is processing. Default true. */
  typingEnabled?: boolean;
  accounts?: Record<string, PushChannelAccountConfig>;
};

export type PushChannelAccountConfig = {
  enabled: boolean;
  name?: string;
  middlewareUrl?: string;
  listenPort?: number;
  listenPath?: string;
  /** Per-account sender allowlist. Falls back to root allowedSenders when omitted. */
  allowedSenders?: string[];
  /** Per-account typing indicator override. */
  typingEnabled?: boolean;
};

export type ResolvedPushChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config: PushChannelConfig; // Merged config
};
