
export type PushChannelConfig = {
  enabled: boolean;
  middlewareUrl: string; // The URL of the middleware service (e.g., http://localhost:3001)
  listenPort: number;    // The port for this plugin to listen on (e.g., 3000)
  listenPath: string;    // The path for this plugin webhook (e.g., /webhook)
  accounts?: Record<string, PushChannelAccountConfig>;
};

export type PushChannelAccountConfig = {
  enabled: boolean;
  name?: string;
  middlewareUrl?: string;
  listenPort?: number;
  listenPath?: string;
};

export type ResolvedPushChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config: PushChannelConfig; // Merged config
};
