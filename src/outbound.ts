
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import type { ResolvedPushChannelAccount } from "./types.js";
import { sendPushMessage } from "./send.js";

export const pushChannelOutbound: ChannelOutboundAdapter<ResolvedPushChannelAccount> = {
    send: async (ctx) => {
        const { target, message, account } = ctx;
        await sendPushMessage(account.config.middlewareUrl, target.id, message.content.text || "");
        return {
            sent: new Date(),
            messageId: Date.now().toString(),
        };
    }
};
