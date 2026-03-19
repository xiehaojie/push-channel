const http = require('http');

const server = http.createServer((req, res) => {
    if (req.url === '/webhook' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            console.log('Webhook received:', body);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            
            let counter = 0;
            const contentId = Math.random().toString(36).substr(2, 5);
            
            const interval = setInterval(() => {
                counter++;
                const event = {
                    type: 'content',
                    delta: `[${contentId}: chunk ${counter}] `
                };
                res.write(`data: ${JSON.stringify(event)}\n\n`);
                
                if (counter >= 5) {
                    clearInterval(interval);
                    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                    res.end();
                }
            }, 500);
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(3003, () => console.log('Mock webhook on 3003'));
