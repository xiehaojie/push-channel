
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
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

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

function getRootConfig(cfg: unknown): Record<string, any> {
  return (cfg as any)?.channels?.["push-channel"] ?? {};
}

function listAccountIds(cfg: unknown): string[] {
  const root = getRootConfig(cfg);
  const extra = Object.keys(root.accounts ?? {});
  return ["default", ...extra];
}

function resolveAccountFromCfg(
  cfg: unknown,
  accountId: string,
): ResolvedPushChannelAccount {
  const root = getRootConfig(cfg);
  const accountOverride =
    accountId !== "default" ? (root.accounts?.[accountId] ?? {}) : {};
  const merged = { ...root, ...accountOverride, accounts: root.accounts };
  return {
    accountId,
    enabled: merged.enabled ?? false,
    configured: !!merged.middlewareUrl,
    name: merged.name ?? (accountId !== "default" ? accountId : "Push Channel"),
    config: merged,
  };
}

// ---------------------------------------------------------------------------
// Probe: actually test middleware connectivity
// ---------------------------------------------------------------------------

async function probeMiddleware(middlewareUrl: string): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: "Middleware probe timed out (5s)" });
    }, 5_000);

    try {
      const url = new URL(`${middlewareUrl.replace(/\/$/, "")}/health`);
      const mod = url.protocol === "https:" ? https : http;
      // Try GET /health; fall back to accepting any 2xx or 404 (middleware is reachable)
      const req = mod.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET" },
        (res) => {
          clearTimeout(timeout);
          res.on("data", () => {});
          res.on("end", () => {
            const ok = res.statusCode !== undefined && (res.statusCode < 500);
            resolve({ ok, error: ok ? null : `Middleware returned ${res.statusCode}` });
          });
        },
      );
      req.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: err.message });
      });
      req.end();
    } catch (err: any) {
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message ?? String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

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
        allowedSenders: { type: "array", items: { type: "string" } },
        typingEnabled: { type: "boolean" },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              middlewareUrl: { type: "string" },
              listenPort: { type: "integer" },
              listenPath: { type: "string" },
              allowedSenders: { type: "array", items: { type: "string" } },
              typingEnabled: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAccountFromCfg(cfg, accountId),
    defaultAccountId: () => "default",
    setAccountEnabled: () => {
      throw new Error("Not implemented");
    },
    deleteAccount: () => {
      throw new Error("Not implemented");
    },
    isConfigured: (acc) => acc.configured,
    describeAccount: (acc) => ({
      accountId: acc.accountId,
      enabled: acc.enabled,
      configured: acc.configured,
    }),
  },
  outbound: pushChannelOutbound,
  gateway: {
    startAccount: async (ctx) => {
      return monitorPushChannel({
        config: ctx.cfg,
        runtime: ctx.runtime,
        accountId: ctx.accountId,
        abortSignal: ctx.abortSignal,
      });
    },
  },
  status: {
    defaultRuntime: { port: null },
    buildChannelSummary: () => ({ status: "ok" }),
    probeAccount: async (ctx) => {
      const acc = ctx.account;
      if (!acc.configured) {
        return { status: "error", error: "middlewareUrl not configured" };
      }
      const result = await probeMiddleware(acc.config.middlewareUrl);
      return result.ok
        ? { status: "ok", error: null }
        : { status: "error", error: result.error };
    },
    buildAccountSnapshot: (ctx) => ({
      accountId: ctx.account.accountId,
      enabled: ctx.account.enabled,
      configured: ctx.account.configured,
      status: "ok",
      port: ctx.runtime?.port ?? null,
    }),
  },
};

