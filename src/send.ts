
export async function sendPushMessage(middlewareUrl: string, sessionId: string, content: string) {
    // Basic fetch implementation
    // Assuming fetch is available in the environment (Node 18+)
    try {
        const response = await fetch(`${middlewareUrl}/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sessionId, content })
        });
        
        if (!response.ok) {
            console.error(`Failed to send push message: ${response.status} ${response.statusText}`);
            throw new Error(`Failed to send push message: ${response.statusText}`);
        }
    } catch (error) {
        console.error("Error sending push message:", error);
        throw error;
    }
}
