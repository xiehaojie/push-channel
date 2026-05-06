
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getCachedKnowledgeBaseConfig, pushChannelPlugin } from "./src/channel.js";
import { setPushChannelRuntime } from "./src/runtime.js";
import { getWriter, pushToolCallId, popToolCallId } from "./src/tool-store.js";
import { queryKnowledgeBase, shouldQueryKB, type KnowledgeBaseConfig } from "./src/knowledge.js";

const KNOWLEDGE_SEARCH_DESCRIPTION = [
    "Search the configured knowledge base for relevant internal or product documentation.",
    "Primary boundary: use this tool to retrieve knowledge-base content, not to answer directly.",
    "When executing a skill, call this only if the skill's own instructions/references are insufficient or cannot answer the needed detail.",
    "Outside a skill, call this when the user explicitly asks to search the knowledge base/internal docs, or when the answer would otherwise be uncertain/ambiguous and the knowledge base is likely to contain the authoritative answer.",
    "Do not call this for greetings, acknowledgements, small talk, simple commands, general reasoning, coding tasks, calculations, translation, or questions you can answer confidently from the conversation.",
    "Before calling, rewrite the user's need into a concise search query with key entities, product names, policy names, or error messages.",
].join(" ");

function textResult(text: string) {
    return { content: [{ type: "text", text }] };
}

function readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveKnowledgeBaseConfig(rawConfig: unknown): KnowledgeBaseConfig | null {
    const config = asRecord(rawConfig);
    const kbConfig = asRecord(config?.knowledgeBase);
    if (!kbConfig) return null;

    return {
        enabled: kbConfig.enabled !== false,
        apiEndpoint: readString(kbConfig.apiEndpoint),
        datasetId: readString(kbConfig.datasetId),
        token: readString(kbConfig.token),
        searchMethod: readString(kbConfig.searchMethod) || "hybrid_search",
        topK: readPositiveInteger(kbConfig.topK, 5),
        scoreThreshold: readNumber(kbConfig.scoreThreshold, 0.3),
    };
}

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

        // Knowledge search tool: constrained retrieval for authoritative KB-backed answers.
        api.registerTool(
          {
            name: "knowledge_search",
            label: "Knowledge Search",
            description: KNOWLEDGE_SEARCH_DESCRIPTION,
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                query: {
                  type: "string",
                  minLength: 2,
                  description: "Concise, focused search query rewritten from the user's need.",
                },
              },
              required: ["query"],
            },
            async execute(_toolCallId: string, params: Record<string, unknown>) {
              const query = readString(params.query);
              if (!query) {
                return textResult("Knowledge search was skipped because the query is empty.");
              }
              if (!shouldQueryKB(query)) {
                return textResult("Knowledge search was skipped because the query looks conversational or too small to retrieve reliable context.");
              }

              const kbConfig = resolveKnowledgeBaseConfig(api.pluginConfig);
              if (!kbConfig?.enabled) {
                return textResult("Knowledge base is disabled.");
              }
              if (!kbConfig.apiEndpoint || !kbConfig.datasetId || !kbConfig.token) {
                return textResult("Knowledge base is not fully configured. Missing apiEndpoint, datasetId, or token.");
              }

              const results = await queryKnowledgeBase(query, kbConfig);
              if (!results) {
                return textResult("No relevant knowledge base results found.");
              }
              return textResult(results);
            },
          },
          { name: "knowledge_search" },
        );
    },
};
