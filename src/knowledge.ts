import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

export interface KnowledgeBaseConfig {
  enabled: boolean;
  apiEndpoint: string;
  datasetId: string;
  token?: string;
  searchMethod?: string;
  topK?: number;
  scoreThreshold?: number;
  timeoutMs?: number;
}

interface RetrievalRecord {
  content?: string;
  segment?: { content?: string };
  score?: number;
  title?: string;
  document?: { name?: string };
}

interface RetrievalResponse {
  records?: RetrievalRecord[];
}

const KB_QUERY_MAX_LENGTH = 250;

/**
 * Extract the actual user message from the full prompt.
 * The prompt may contain metadata blocks like:
 *   Conversation info (untrusted metadata):
 *   ```json ... ```
 *   Sender (untrusted metadata):
 *   ```json ... ```
 *   <actual user message>
 *
 * We strip those metadata blocks and return only the user's query,
 * truncated to the KB API's 250 character limit.
 */
function extractUserQuery(prompt: string): string {
  let query = prompt;

  // Strip all markdown fenced code blocks with their labels
  // e.g. "Conversation info (untrusted metadata):\n```json\n{...}\n```"
  query = query.replace(/[^\n]*\(untrusted metadata\):\s*```[\s\S]*?```/g, "");

  // Also strip any remaining fenced code blocks
  query = query.replace(/```[\s\S]*?```/g, "");

  query = query.trim();

  // Truncate to API limit
  if (query.length > KB_QUERY_MAX_LENGTH) {
    query = query.slice(0, KB_QUERY_MAX_LENGTH);
  }

  return query;
}

export { extractUserQuery as _extractUserQuery };

export async function queryKnowledgeBase(
  userMessage: string,
  config: KnowledgeBaseConfig,
): Promise<string | null> {
  if (!config.enabled || !config.apiEndpoint || !config.datasetId) {
    console.warn(`[PushChannel][KB] queryKnowledgeBase: config missing required fields, enabled=${config.enabled}, apiEndpoint=${config.apiEndpoint}, datasetId=${config.datasetId}`);
    return null;
  }

  const query = extractUserQuery(userMessage);
  if (!query) {
    console.warn(`[PushChannel][KB] queryKnowledgeBase: extracted query is empty from prompt (length=${userMessage?.length})`);
    return null;
  }

  try {
    console.info(`[PushChannel][KB] queryKnowledgeBase: extracted query="${query}" (from prompt length=${userMessage?.length}), config=${JSON.stringify({apiEndpoint: config.apiEndpoint, datasetId: config.datasetId, topK: config.topK, scoreThreshold: config.scoreThreshold, timeoutMs: config.timeoutMs, searchMethod: config.searchMethod})}`);
    const retrievalSetting: Record<string, string | number> = {
      top_k: config.topK ?? 5,
      score_threshold: config.scoreThreshold ?? 0.5,
    };

    if (config.searchMethod) {
      retrievalSetting.search_method = config.searchMethod;
    }

    const body = JSON.stringify({
      dataset_id: config.datasetId,
      query: userMessage,
      retrieval_setting: {
        search_method: config.searchMethod || "hybrid_search",
        top_k: config.topK || 5,
        score_threshold: config.scoreThreshold ?? 0.3,
      },
    });
    console.info(`[PushChannel][KB] queryKnowledgeBase: request body = ${body}`);

    const timeoutMs = config.timeoutMs ?? 10000;
    const text = await postJson(config.apiEndpoint, body, config.token, timeoutMs);
    if (!text) {
      console.warn(`[PushChannel][KB] queryKnowledgeBase: postJson returned null (timeout or network error)`);
      return null;
    }

    let parsed: RetrievalResponse;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn(`[PushChannel][KB] queryKnowledgeBase: failed to parse response as JSON, raw=`, text?.slice(0, 300));
      return null;
    }
    console.info(`[PushChannel][KB] queryKnowledgeBase: parsed response keys = ${parsed && typeof parsed === 'object' ? Object.keys(parsed) : 'not object'}, records count = ${parsed?.records?.length ?? 0}`);

    const formatted = formatRecords(parsed.records);

    if (!formatted && parsed.records && parsed.records.length > 0) {
      console.warn(`[PushChannel][KB] received ${parsed.records.length} record(s) but could not extract content`);
    } else if (formatted) {
      console.info(`[PushChannel][KB] queryKnowledgeBase: formatted result length=${formatted.length}`);
    }

    return formatted;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[PushChannel][KB] queryKnowledgeBase failed: ${reason}`);
    // fail-open: knowledge base unavailable should not block conversation
    return null;
  }
}

function postJson(
  urlStr: string,
  body: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;
    console.info(`[PushChannel][KB] postJson: url=${urlStr}, timeoutMs=${timeoutMs}`);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const timeout = setTimeout(() => {
      console.warn(`[PushChannel][KB] request timeout after ${timeoutMs}ms: ${urlStr}`);
      req.destroy();
      finish(null);
    }, timeoutMs);

    const authHeader =
      token && token.trim().length > 0
        ? token.startsWith("Bearer ")
          ? token
          : `Bearer ${token}`
        : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          console.info(`[PushChannel][KB] postJson: response status=${res.statusCode}, body preview=${data.slice(0, 200)}`);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            finish(data);
          } else {
            const status = res.statusCode ?? "unknown";
            console.warn(`[PushChannel][KB] non-2xx response: ${status}, body=${data.slice(0, 300)}`);
            finish(null);
          }
        });
      },
    );

    req.on("error", (err) => {
      console.warn(`[PushChannel][KB] postJson: request error: ${err && err.message ? err.message : err}`);
      finish(null);
    });

    try {
      req.end(body);
    } catch (e) {
      console.warn(`[PushChannel][KB] postJson: req.end threw: ${e && e.message ? e.message : e}`);
      finish(null);
    }
  });
}

export function shouldQueryKB(message: string): boolean {
  const trimmed = message
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,!?;:。！？；：~～…]+$/g, "");
  if (trimmed.length < 2) return false;

  const skipPatterns = [
    /^(您好|你好|谢谢|好的|是的?|确认|收到|ok|okay|thanks|thank you|hello|hi|hi there|嗯|对|不是|不行|可以|no|yes|👍|🙏|哈哈|嘿嘿|😊|okk|👌|拜拜|再见|晚安|早上好|下午好|辛苦了|了解|明白|知道了|没问题|行|好)$/i,
  ];

  if (skipPatterns.some((p) => p.test(trimmed))) return false;
  if (trimmed.length >= 4) return true;

  return /[A-Za-z0-9]/.test(trimmed) || /[\u4e00-\u9fff]{2,}/.test(trimmed);
}

function formatRecords(records: RetrievalRecord[] | undefined): string | null {
  if (!records || records.length === 0) {
    console.info(`[PushChannel][KB] formatRecords: no records to format`);
    return null;
  }

  const parts: string[] = [];
  for (const [i, record] of records.entries()) {
    const nestedContent = record.segment?.content?.trim();
    const flatContent = record.content?.trim();
    const content = nestedContent || flatContent;
    if (!content) {
      console.info(`[PushChannel][KB] formatRecords: record[${i}] missing content, record=`, JSON.stringify(record));
      continue;
    }

    const docName = record.document?.name ?? record.title;
    const score = record.score != null ? record.score.toFixed(3) : undefined;

    const meta = [docName, score != null ? `score: ${score}` : undefined]
      .filter(Boolean)
      .join(" | ");

    if (meta) {
      parts.push(`[${meta}]\n${content}`);
    } else {
      parts.push(content);
    }
  }

  if (parts.length === 0) {
    console.info(`[PushChannel][KB] formatRecords: all records missing content`);
    return null;
  }
  return parts.join("\n---\n");
}
