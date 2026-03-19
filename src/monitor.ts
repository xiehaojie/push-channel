
import * as http from "node:http";
import type { RuntimeEnv, ClawdbotConfig } from "openclaw/plugin-sdk";
import { getPushChannelRuntime } from "./runtime.js";
import { createPushChannelReplyDispatcher, createStreamingReplyDispatcher } from "./reply-dispatcher.js";
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
    
    console.log(`[PushChannel] Attempting to start monitor on port ${port}, path ${path}`);
    if (runtime.log) runtime.log(`[PushChannel] Attempting to start monitor on port ${port}, path ${path}`);

    const server = http.createServer((req, res) => {
        // Force log to console to ensure visibility
        console.log(`[PushChannel] Incoming HTTP request: ${req.method} ${req.url}`);
        if (runtime.log) runtime.log(`[PushChannel] Incoming HTTP request: ${req.method} ${req.url}`);

        if (req.method === "POST" && req.url === path) {
             let body = "";
             req.on("data", chunk => body += chunk);
             req.on("end", async () => {
                 console.log(`[PushChannel] Request body received, length: ${body.length}`);
                 try {
                     const data = JSON.parse(body);
                     // data: { sessionId, content, agentId? }
                     const { sessionId, content, agentId } = data;
                     
                     log(`[PushChannel] Webhook received message for sessionId: ${sessionId}, agentId: ${agentId || 'default (not provided)'}`);

                     if (!sessionId || !content) {
                        res.writeHead(400);
                        res.end("Missing sessionId or content");
                        return;
                    }

                    // Dispatch logic
                    try {
                        // Mark headers sent explicitly if we're streaming to prevent Premature close
                        // Since node-fetch listens for response completion, if we never close properly or send headers,
                        // it causes ERR_STREAM_PREMATURE_CLOSE
                        await handleIncomingMessage(config, runtime, account, sessionId, content, agentId, res);
                        if (!res.writableEnded) {
                             if (!res.headersSent) {
                                 res.writeHead(200);
                                 res.end("OK");
                             } else {
                                 res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
                                 res.end();
                             }
                        }
                    } catch (err: any) {
                        log(`[PushChannel] Error handling message: ${err.message || err}`);
                        if (err.stack) log(err.stack);
                        if (!res.headersSent) {
                            res.writeHead(500);
                            res.end("Internal Server Error");
                        } else if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
                            res.end();
                        }
                    }
                } catch (e) {
                    log(`[PushChannel] Error processing webhook body: ${e}`);
                    res.writeHead(400);
                    res.end("Bad Request");
                }
             });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.on('error', (e: any) => {
        const errorMsg = `[PushChannel] Server error: ${e.code || e.message}`;
        console.error(errorMsg);
        if (runtime.log) runtime.log(errorMsg);
        if (e.code === 'EADDRINUSE') {
            console.error(`[PushChannel] Port ${port} is already in use!`);
        }
    });

    server.listen(port, () => {
        const msg = `Push channel listening on port ${port}, path ${path}`;
        console.log(msg);
        log(msg);
    });

    abortSignal.addEventListener("abort", () => {
        log("Stopping Push Channel Monitor");
        server.close();
    });
    
    return new Promise<void>(() => {}); // Keep alive
}

async function retryOperation<T>(operation: () => Promise<T>, maxRetries: number = 3, delay: number = 1000): Promise<T> {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            console.warn(`[PushChannel] Attempt ${i + 1} failed: ${error.message || error}. Retrying in ${delay}ms...`);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            }
        }
    }
    throw lastError;
}

async function handleIncomingMessage(cfg: ClawdbotConfig, runtime: RuntimeEnv, account: ResolvedPushChannelAccount, sessionId: string, content: string, agentId: string = "default", res?: http.ServerResponse) {
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

    const channelId = "push-channel";
    const peerKind = "direct";
    const peerId = sessionId;
    
    const sessionKey = `agent:${agentId}:channel:${channelId}:${peerKind}:${peerId}`;
    
    const streaming = res ? createStreamingReplyDispatcher(res) : null;
    const dispatcher = streaming
        ? streaming.dispatcher
        : createPushChannelReplyDispatcher({
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
        OriginatingTo: peerId,
    });

   // Record the inbound session and update the agent's lastChannel so that
   // spawned sessions (e.g. reminders) route back to push-channel instead of
   // falling back to the OpenClaw UI.
   if (core.channel.session) {
       try {
           const storePath = core.channel.session.resolveStorePath(undefined, { agentId });
           await core.channel.session.recordInboundSession({
               storePath,
               sessionKey,
               ctx: ctxPayload as any,
               createIfMissing: true,
               updateLastRoute: {
                   sessionKey: `agent:${agentId}:main`,
                   channel: "push-channel",
                   to: peerId,
                   accountId: account.accountId,
               },
               onRecordError: (err) => log(`[PushChannel] Failed to record inbound session: ${err}`),
           });
       } catch (err) {
           log(`[PushChannel] Error recording inbound session: ${err}`);
       }
   }

   await replyModule.withReplyDispatcher({
       dispatcher,
       onSettled: () => {},
       run: () => replyModule.dispatchReplyFromConfig({
           ctx: ctxPayload,
           cfg,
           dispatcher,
           replyOptions: {
               onModelSelected: () => {},
               disableBlockStreaming: !res,
               ...(streaming ? { onPartialReply: streaming.onPartialReply } : {}),
           }
       })
   });
}
