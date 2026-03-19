
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { sendPushMessage } from "./send.js";

export const pushChannelOutbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text }) => {
        const middlewareUrl = (cfg as any).channels?.["push-channel"]?.middlewareUrl;
        if (!middlewareUrl) throw new Error("[PushChannel] middlewareUrl not configured");
        console.log(`[PushChannel] outbound.sendText: to=${to}, middlewareUrl=${middlewareUrl}, text length=${text.length}`);
        await sendPushMessage(middlewareUrl, to, text);
        console.log(`[PushChannel] outbound.sendText success: to=${to}`);
        return {
            sent: new Date(),
            messageId: Date.now().toString(),
        };
    }
};
