const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
    console.log('Connected');
    ws.send(JSON.stringify({ type: 'register', sessionId: 'test-session-1' }));
    
    setTimeout(() => {
        console.log('Sending msg 1');
        ws.send(JSON.stringify({ type: 'message', content: 'Hello' }));
        
        setTimeout(() => {
            console.log('Sending msg 2 (overlapping)');
            ws.send(JSON.stringify({ type: 'message', content: 'World' }));
        }, 500); // Send second message before first finishes
    }, 1000);
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
});

ws.on('close', () => {
    console.log('Disconnected');
});
