
import * as http from "http";
import type { RuntimeEnv, ClawdbotConfig } from "openclaw/plugin-sdk";
import { getPushChannelRuntime } from "./runtime.js";
import { createPushChannelReplyDispatcher } from "./reply-dispatcher.js";
import type { ResolvedPushChannelAccount } from "./types.js";

// Helper to resolve account
function resolveAccount(config: ClawdbotConfig, accountId: string): ResolvedPushChannelAccount {
    const c = (config.channels?.["push-channel"] as any) || {};
    return {
        accountId: "default",
        enabled: c.enabled ?? false,
        configured: !!c.middlewareUrl,
        config: c,
    };
}

export async function monitorPushChannel(opts: { config: ClawdbotConfig, runtime: RuntimeEnv, accountId: string, abortSignal: AbortSignal }) {
    const { config, runtime, accountId, abortSignal } = opts;
    const log = runtime.log || console.log;
    const account = resolveAccount(config, accountId);
    
    const port = account.config.listenPort || 3002;
    const path = account.config.listenPath || "/webhook";
    
    log(`Starting Push Channel Monitor on port ${port}, path ${path}`);

    const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === path) {
             let body = "";
             req.on("data", chunk => body += chunk);
             req.on("end", async () => {
                 try {
                     const data = JSON.parse(body);
                     // data: { sessionId, content }
                     const { sessionId, content } = data;
                     
                     if (!sessionId || !content) {
                         res.writeHead(400);
                         res.end("Missing sessionId or content");
                         return;
                     }

                     // Dispatch logic
                     await handleIncomingMessage(config, runtime, account, sessionId, content).catch(err => {
                        log(`Error handling message: ${err}`);
                     });
                     
                     res.writeHead(200);
                     res.end("OK");
                 } catch (e) {
                     log(`Error processing webhook: ${e}`);
                     res.writeHead(400);
                     res.end("Bad Request");
                 }
             });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        log(`Push channel listening on port ${port}`);
    });

    abortSignal.addEventListener("abort", () => {
        log("Stopping Push Channel Monitor");
        server.close();
    });
    
    return new Promise<void>(() => {}); // Keep alive
}

async function handleIncomingMessage(cfg: ClawdbotConfig, runtime: RuntimeEnv, account: ResolvedPushChannelAccount, sessionId: string, content: string) {
    const core = getPushChannelRuntime(); 
    if (!core) {
        throw new Error("PushChannel runtime not available");
    }
    // Check if runtime.channel is available
    if (!core.channel) {
        throw new Error("Channel module not available in runtime");
    }
    const replyModule = core.channel.reply;
    if (!replyModule) {
        throw new Error("Reply module not available in runtime.channel");
    }

    const agentId = "default";
    const channelId = "push-channel";
    const peerKind = "direct";
    const peerId = sessionId;
    
    const sessionKey = `agent:${agentId}:channel:${channelId}:${peerKind}:${peerId}`;
    
    const dispatcher = createPushChannelReplyDispatcher({
        middlewareUrl: account.config.middlewareUrl,
        sessionId: sessionId
    });
    const ctxPayload = replyModule.finalizeInboundContext({
        Body: content,
        BodyForAgent: content, 
        InboundHistory: undefined,
        ReplyToId: undefined,
        RootMessageId: undefined,
        RawBody: content,
        CommandBody: content,
        From: sessionId,
        To: "bot",
        SessionKey: sessionKey,
        AgentId: agentId,
        AccountId: account.accountId,
        ChatType: "direct",
        GroupSubject: undefined,
        SenderName: sessionId,
        SenderId: sessionId,
        Provider: "push-channel",
        Surface: "push-channel",
        MessageSid: Date.now().toString(),
        ReplyToBody: undefined,
        Timestamp: Date.now(),
        WasMentioned: false,
        CommandAuthorized: undefined,
        OriginatingChannel: "push-channel",
        OriginatingTo: "bot",
   });

   await replyModule.withReplyDispatcher({
       dispatcher,
       onSettled: () => {},
       run: () => replyModule.dispatchReplyFromConfig({
           ctx: ctxPayload,
           cfg,
           dispatcher,
           replyOptions: {
               onModelSelected: () => {},
               disableBlockStreaming: true,
           }
       })
   });
}
