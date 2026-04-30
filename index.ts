
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getCachedKnowledgeBaseConfig, pushChannelPlugin } from "./src/channel.js";
import { setPushChannelRuntime } from "./src/runtime.js";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";
import { queryKnowledgeBase } from "./src/knowledge.js";

type KnowledgeBaseLikeConfig = {
    enabled?: boolean;
    apiEndpoint?: string;
    datasetId?: string;
    token?: string;
    searchMethod?: string;
    topK?: number;
    scoreThreshold?: number;
    timeoutMs?: number;
};

function readKbFromObject(input: unknown): KnowledgeBaseLikeConfig | undefined {
    if (!input || typeof input !== "object") {
        return undefined;
    }

    const obj = input as {
        knowledgeBase?: KnowledgeBaseLikeConfig;
        channels?: {
            "push-channel"?: {
                knowledgeBase?: KnowledgeBaseLikeConfig;
            };
        };
        "push-channel"?: {
            knowledgeBase?: KnowledgeBaseLikeConfig;
        };
    };

    return (
        obj.channels?.["push-channel"]?.knowledgeBase ??
        obj["push-channel"]?.knowledgeBase ??
        obj.knowledgeBase
    );
}

function isUsableKnowledgeBaseConfig(config: KnowledgeBaseLikeConfig | undefined): boolean {
    if (!config) {
        return false;
    }

    if (config.enabled === false) {
        return true;
    }

    return Boolean(config.enabled && config.apiEndpoint && config.datasetId);
}

function resolveKnowledgeBaseConfig(
    api: OpenClawPluginApi,
    event: unknown,
): { source: string; config?: KnowledgeBaseLikeConfig } {
    const eventObj = event as { cfg?: unknown; config?: unknown } | undefined;
    const runtimeObj = api.runtime as { cfg?: unknown; config?: unknown } | undefined;

    const candidates: Array<{ source: string; value: unknown }> = [
        { source: "api.pluginConfig", value: api.pluginConfig },
        { source: "event", value: event },
        { source: "event.cfg", value: eventObj?.cfg },
        { source: "event.config", value: eventObj?.config },
        { source: "runtime.cfg", value: runtimeObj?.cfg },
        { source: "runtime.config", value: runtimeObj?.config },
        { source: "channel.cache", value: getCachedKnowledgeBaseConfig() },
    ];

    for (const candidate of candidates) {
        const config = readKbFromObject(candidate.value);
        if (isUsableKnowledgeBaseConfig(config)) {
            return { source: candidate.source, config };
        }
    }

    return { source: "none", config: undefined };
}

function keysOf(input: unknown): string {
    if (!input || typeof input !== "object") {
        return "<not-object>";
    }
    return Object.keys(input as Record<string, unknown>).join(",") || "<empty>";
}

export default {
    id: "push-channel",
    name: "Push Channel",
    register(api: OpenClawPluginApi) {
        const runtimeLogger = (api.runtime as { log?: (message: string) => void }).log;
        setPushChannelRuntime(api.runtime);
        api.registerChannel({ plugin: pushChannelPlugin });

        // Emit tool_call event when a tool is about to execute.
        api.on("before_tool_call", (event: { toolName: string; params?: Record<string, unknown> }, ctx: { sessionKey?: string }) => {
            const sk = ctx.sessionKey;
            if (!sk) return;
            const writer = getWriter(sk);
            if (!writer) return;
            const toolCallId = `tool-${randomUUID()}`;
            writer({
                type: "tool_call",
                toolCallId,
                toolName: event.toolName,
                args: event.params ?? {},
            });
            pushToolCallId(sk, toolCallId);
        });

        // Emit tool_result event when the tool result is persisted.
        api.on("tool_result_persist", (event: Record<string, unknown>, ctx: { sessionKey?: string }) => {
            const sk = ctx.sessionKey;
            if (!sk) return;
            const writer = getWriter(sk);
            const toolCallId = popToolCallId(sk);
            if (!writer || !toolCallId) return;
            writer({ type: "tool_result", toolCallId, message: event["message"] });
        });

        // Knowledge base retrieval: inject KB results into system context on every message.
        api.on("before_prompt_build", async (event) => {
                    const log = (message: string) => {
                        if (typeof runtimeLogger === "function") {
                            runtimeLogger(message);
                            return;
                        }
                        console.info(message);
                    };

                    log("[PushChannel][KB] before_prompt_build triggered");

          const resolved = resolveKnowledgeBaseConfig(api, event);
          const kbConfig = resolved.config;
          log(`[PushChannel][KB] config source=${resolved.source}`);
                    if (!kbConfig?.enabled || !kbConfig?.apiEndpoint || !kbConfig?.datasetId) {
                        log(`[PushChannel][KB] diagnostics pluginConfigKeys=${keysOf(api.pluginConfig)}`);
                        log(`[PushChannel][KB] diagnostics eventKeys=${keysOf(event)}`);
                        log("[PushChannel][KB] skipped: missing or disabled knowledgeBase config");
                        return {};
                    }

                    const strictKbConfig = {
                        enabled: true,
                        apiEndpoint: kbConfig.apiEndpoint,
                        datasetId: kbConfig.datasetId,
                        token: kbConfig.token,
                        searchMethod: kbConfig.searchMethod,
                        topK: kbConfig.topK,
                        scoreThreshold: kbConfig.scoreThreshold,
                        timeoutMs: kbConfig.timeoutMs,
                    };

                    const prompt = typeof event.prompt === "string" ? event.prompt : "";
                    log(`[PushChannel][KB] querying knowledge base (promptLength=${prompt.length})`);

                    let results: string | null = null;
                    try {
                        results = await queryKnowledgeBase(prompt, strictKbConfig);
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        log(`[PushChannel][KB] query failed: ${reason}`);
                        return {};
                    }

                    if (!results) {
                        log("[PushChannel][KB] no knowledge retrieved (empty result or upstream unavailable)");
                        return {};
                    }

                    log(`[PushChannel][KB] knowledge retrieved (chars=${results.length})`);
                    log(`[PushChannel][KB] knowledge content:\n${results}`);

          return {
            appendSystemContext:
              `<knowledge_base>\n${results}\n</knowledge_base>\n\n` +
              `以上是从知识库中检索到的参考资料。回答用户问题时，请优先基于上述知识库内容进行回答。` +
              `如果知识库内容与用户问题相关，请直接引用其中的信息。` +
              `如果知识库内容不相关，可以忽略。`,
          };
        });
    },
};
