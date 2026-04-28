import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

export interface KnowledgeBaseConfig {
  enabled: boolean;
  apiEndpoint: string;
  datasetId: string;
  token: string;
  searchMethod: string;
  topK: number;
  scoreThreshold: number;
}

interface RetrievalRecord {
  segment?: { content?: string };
  score?: number;
  document?: { name?: string };
}

interface RetrievalResponse {
  records?: RetrievalRecord[];
}

export async function queryKnowledgeBase(
  userMessage: string,
  config: KnowledgeBaseConfig,
): Promise<string | null> {
  if (!config.enabled || !config.apiEndpoint || !config.datasetId) return null;

  try {
    const body = JSON.stringify({
      knowledge_id: config.datasetId, //临时替换成这个
      query: userMessage,
      retrieval_setting: {
        search_method: config.searchMethod || "hybrid_search",
        top_k: config.topK || 5,
        score_threshold: config.scoreThreshold ?? 0.3,
      },
    });

    const text = await postJson(config.apiEndpoint, body, config.token, 3000);
    if (!text) return null;

    const parsed: RetrievalResponse = JSON.parse(text);
    return formatRecords(parsed.records);
  } catch {
    // fail-open: knowledge base unavailable should not block conversation
    return null;
  }
}

function postJson(
  urlStr: string,
  body: string,
  token: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;

    const timeout = setTimeout(() => resolve(null), timeoutMs);

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          clearTimeout(timeout);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            resolve(null);
          }
        });
      },
    );

    req.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });

    req.end(body);
  });
}

function formatRecords(records: RetrievalRecord[] | undefined): string | null {
  if (!records || records.length === 0) return null;

  const parts: string[] = [];
  for (const record of records) {
    const content = record.segment?.content?.trim();
    if (!content) continue;

    const docName = record.document?.name;
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

  return parts.length > 0 ? parts.join("\n---\n") : null;
}
