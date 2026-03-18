const db = require('../config/database');

class SessionRepository {
    async create(session_id, user_id, expires_at, ip_address, user_agent) {
        await db.query(
            `INSERT INTO sessions (session_id, user_id, expires_at, ip_address, user_agent) 
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             expires_at = VALUES(expires_at),
             ip_address = VALUES(ip_address),
             user_agent = VALUES(user_agent)`,
            [session_id, user_id, expires_at, ip_address, user_agent]
        );
    }

    async findById(session_id) {
        const [rows] = await db.query('SELECT * FROM sessions WHERE session_id = ? AND expires_at > CURRENT_TIMESTAMP', [session_id]);
        return rows[0];
    }

    async delete(session_id) {
        await db.query('DELETE FROM sessions WHERE session_id = ?', [session_id]);
    }
}

module.exports = new SessionRepository();
