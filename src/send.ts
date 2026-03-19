
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export async function sendPushMessage(middlewareUrl: string, sessionId: string, content: string, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await new Promise<void>((resolve, reject) => {
                const url = new URL(`${middlewareUrl}/send`);
                const requestModule = url.protocol === 'https:' ? https : http;
                const postData = JSON.stringify({ sessionId, content });

                const options = {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'Connection': 'close'
                    }
                };

                const req = requestModule.request(options, (res) => {
                    // Consume response data to free up memory
                    res.on('data', () => {});
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Failed to send push message: ${res.statusCode} ${res.statusMessage}`));
                        }
                    });
                });

                req.on('error', (e) => {
                    reject(e);
                });

                // Write data to request body
                req.write(postData);
                req.end();
            });
            return; // Success, exit the retry loop
        } catch (error: any) {
            if (attempt === retries) {
                console.error("Error sending push message:", error);
                throw error;
            }
            console.warn(`Attempt ${attempt} failed, retrying in 1s... (${error.message})`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
