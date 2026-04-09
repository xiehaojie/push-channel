
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { sendPushMessage } from "./send.js";

/** Maximum character count for a single outbound push message. */
const MAX_CHUNK_LENGTH = 4_000;

/**
 * Split long text into chunks so the middleware HTTP call stays within a
 * reasonable payload size. Splits at paragraph or newline boundaries where
 * possible to avoid breaking mid-sentence.
 */
function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK_LENGTH) {
    // Prefer splitting at a paragraph or line boundary within the window
    const window = remaining.slice(0, MAX_CHUNK_LENGTH);
    const lastPara = window.lastIndexOf("\n\n");
    const lastLine = window.lastIndexOf("\n");
    const cutAt = lastPara > MAX_CHUNK_LENGTH / 2 ? lastPara + 2
      : lastLine > MAX_CHUNK_LENGTH / 2 ? lastLine + 1
      : MAX_CHUNK_LENGTH;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function resolveMiddlewareUrl(cfg: unknown, accountId?: string): string | undefined {
  const channelCfg = (cfg as any)?.channels?.["push-channel"];
  if (!channelCfg) return undefined;
  // Account-specific override wins
  const accountCfg = accountId && accountId !== "default"
    ? channelCfg.accounts?.[accountId]
    : undefined;
  return accountCfg?.middlewareUrl ?? channelCfg.middlewareUrl;
}

export const pushChannelOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId }) => {
    const middlewareUrl = resolveMiddlewareUrl(cfg, accountId as string | undefined);
    if (!middlewareUrl) throw new Error("[PushChannel] middlewareUrl not configured");

    // Split by account separator if `to` encodes "accountId:peerId"
    const peerId = to.includes(":") ? to.split(":").slice(1).join(":") : to;
    const resolvedAgentId = peerId || to;

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      console.log(
        `[PushChannel] outbound.sendText: to=${resolvedAgentId}, middlewareUrl=${middlewareUrl}, chunk=${chunk.length}ch`,
      );
      await sendPushMessage({
        middlewareUrl,
        agentId: resolvedAgentId,
        content: chunk,
      });
    }
    console.log(`[PushChannel] outbound.sendText success: to=${resolvedAgentId}`);
    return {
      sent: new Date(),
      messageId: Date.now().toString(),
    };
  },
};
