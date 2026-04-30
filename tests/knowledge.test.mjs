import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { queryKnowledgeBase, _extractUserQuery } from '../src/knowledge.ts';

async function withTestServer(handler, run) {
  const server = http.createServer(handler);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to resolve test server address');
  }

  try {
    return await run(`http://127.0.0.1:${address.port}/retrieval`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function createConfig(apiEndpoint) {
  return {
    enabled: true,
    apiEndpoint,
    datasetId: 'dataset-123',
    token: 'token-123',
  };
}

test('queryKnowledgeBase omits search_method and formats flat records', async () => {
  let requestBody;

  await withTestServer(async (req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        records: [
          {
            content: 'flat content',
            score: 0.91,
            title: 'flat-doc.docx',
          },
        ],
      }));
    });
  }, async (apiEndpoint) => {
    const result = await queryKnowledgeBase('query text', createConfig(apiEndpoint));

    assert.ok(result);
    assert.match(result, /flat-doc\.docx/);
    assert.match(result, /flat content/);
  });

  assert.equal(requestBody.knowledge_id, 'dataset-123');
  assert.equal(requestBody.query, 'query text');
  assert.equal(requestBody.retrieval_setting.top_k, 5);
  assert.equal(requestBody.retrieval_setting.score_threshold, 0.5);
  assert.equal('search_method' in requestBody.retrieval_setting, false);
});

test('queryKnowledgeBase still formats legacy nested records', async () => {
  await withTestServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      records: [
        {
          segment: { content: 'nested content' },
          score: 0.87,
          document: { name: 'nested-doc.docx' },
        },
      ],
    }));
  }, async (apiEndpoint) => {
    const result = await queryKnowledgeBase('query text', createConfig(apiEndpoint));

    assert.ok(result);
    assert.match(result, /nested-doc\.docx/);
    assert.match(result, /nested content/);
  });
});

test('extractUserQuery strips metadata blocks and keeps user message', () => {
  const prompt = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "1777458466795",
  "sender_id": "22c02618-770e-4635-882c-0b492341cf64",
  "sender": "22c02618-770e-4635-882c-0b492341cf64",
  "timestamp": "Wed 2026-04-29 18:27 GMT+8",
  "was_mentioned": true
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "label": "22c02618-770e-4635-882c-0b492341cf64",
  "id": "22c02618-770e-4635-882c-0b492341cf64",
  "name": "22c02618-770e-4635-882c-0b492341cf64"
}
\`\`\`

中华人民共和国个人所得税纳税记录`;

  const result = _extractUserQuery(prompt);
  assert.equal(result, '中华人民共和国个人所得税纳税记录');
});

test('extractUserQuery truncates to 250 chars', () => {
  const longText = 'A'.repeat(300);
  const result = _extractUserQuery(longText);
  assert.equal(result.length, 250);
});

test('extractUserQuery returns plain text as-is if no metadata', () => {
  const result = _extractUserQuery('hello world');
  assert.equal(result, 'hello world');
});