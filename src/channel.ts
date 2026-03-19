
import type { ChannelPlugin, ChannelMeta } from "openclaw/plugin-sdk";
import type { ResolvedPushChannelAccount } from "./types.js";
import { pushChannelOutbound } from "./outbound.js";
import { monitorPushChannel } from "./monitor.js";

const meta: ChannelMeta = {
  id: "push-channel",
  label: "Push Channel",
  selectionLabel: "Push Channel (Custom)",
  docsPath: "/channels/push-channel",
  docsLabel: "push-channel",
  blurb: "Custom push channel with middleware.",
  order: 99,
};

export const pushChannelPlugin: ChannelPlugin<ResolvedPushChannelAccount> = {
  id: "push-channel",
  meta,
  capabilities: {
    chatTypes: ["direct"], 
    media: false,
    threads: false,
    polls: false,
    reactions: false,
    edit: false,
    reply: false,
  },
  configSchema: {
      schema: {
          type: "object",
          additionalProperties: false,
          properties: {
              enabled: { type: "boolean" },
              middlewareUrl: { type: "string" },
              listenPort: { type: "integer" },
              listenPath: { type: "string" },
          }
      }
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (cfg, accountId) => {
        const c = (cfg.channels?.["push-channel"] as any) || {};
        const account = {
            accountId: "default",
            enabled: c.enabled ?? false,
            configured: !!c.middlewareUrl,
            name: "Push Channel",
            config: c,
        };
        return account;
    },
    defaultAccountId: () => "default",
    setAccountEnabled: () => { throw new Error("Not implemented"); },
    deleteAccount: () => { throw new Error("Not implemented"); },
    isConfigured: (acc) => acc.configured,
    describeAccount: (acc) => ({ accountId: acc.accountId, enabled: acc.enabled, configured: acc.configured }),
  },
  outbound: pushChannelOutbound,
  gateway: {
      startAccount: async (ctx) => {
          return monitorPushChannel({
              config: ctx.cfg,
              runtime: ctx.runtime,
              accountId: ctx.accountId,
              abortSignal: ctx.abortSignal
          });
      }
  },
  status: {
      defaultRuntime: { port: null }, 
      buildChannelSummary: () => ({ status: "ok" }),
      probeAccount: async () => ({ status: "ok", error: null }),
      buildAccountSnapshot: (ctx) => ({ 
          accountId: ctx.account.accountId, 
          enabled: ctx.account.enabled, 
          configured: ctx.account.configured,
          status: "ok",
          port: ctx.runtime?.port ?? null
      }),
  }
};
