import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export async function sendPushMessage(params: {
  middlewareUrl: string;
  agentId: string;
  content: string;
  sessionId?: string;
  retries?: number;
}) {
  const { middlewareUrl, agentId, content, sessionId, retries = 3 } = params;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const baseUrl = middlewareUrl.endsWith("/") ? middlewareUrl : `${middlewareUrl}/`;
        const url = new URL("send", baseUrl);
        const requestModule = url.protocol === "https:" ? https : http;
        const payload: Record<string, string> = { agentId, content };
        if (sessionId) {
          payload.sessionId = sessionId;
        }
        const postData = JSON.stringify(payload);

        const options = {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            Connection: "close",
          },
        };

        const req = requestModule.request(options, (res) => {
          res.on("data", () => {});
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(
                new Error(`Failed to send push message: ${res.statusCode} ${res.statusMessage}`),
              );
            }
          });
        });

        req.on("error", reject);

        req.write(postData);
        req.end();
      });
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
