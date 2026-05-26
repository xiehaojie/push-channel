export type PushChannelConfig = {
  enabled: boolean;
  middlewareUrl?: string;
  listenPort: number;
  listenPath: string;
};

export type ResolvedPushChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config: PushChannelConfig;
};
