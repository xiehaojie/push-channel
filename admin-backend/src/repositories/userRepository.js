const db = require('../config/database');

class UserRepository {
    async findByUsername(username) {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        return rows[0];
    }

    async findById(id) {
        const [rows] = await db.query(
            `SELECT u.*, r.name as role_name, r.level as role_level 
             FROM users u 
             LEFT JOIN roles r ON u.role_id = r.id 
             WHERE u.id = ?`, 
            [id]
        );
        return rows[0];
    }

    async create(user) {
        const { username, email, password_hash, name, phone, department, title, role_id, session_id } = user;
        const [result] = await db.query(
            `INSERT INTO users (username, email, password_hash, name, phone, department, title, role_id, session_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, email, password_hash, name, phone, department, title, role_id, session_id]
        );
        return result.insertId;
    }

    async updateSessionId(id, sessionId) {
        const [result] = await db.query('UPDATE users SET session_id = ? WHERE id = ?', [sessionId, id]);
        return result.affectedRows > 0;
    }

    async updateStatus(id, status) {
        const [result] = await db.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
        return result.affectedRows > 0;
    }

    async updateUser(id, { name, email, department, title }) {
        const [result] = await db.query(
            'UPDATE users SET name = ?, email = ?, department = ?, title = ? WHERE id = ?',
            [name, email, department, title, id]
        );
        return result.affectedRows > 0;
    }

    async findAll({ page = 1, pageSize = 10, search = '', status = '', role = '' }) {
        const offset = (page - 1) * pageSize;
        let query = `
            SELECT u.id, u.username, u.email, u.name, u.phone, u.department, u.title, u.status, u.created_at, u.last_login_at, r.name as role_name, r.level as role_level
            FROM users u
            LEFT JOIN roles r ON u.role_id = r.id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (u.username LIKE ? OR u.name LIKE ? OR u.email LIKE ?)`;
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam);
        }

        if (status) {
            query += ` AND u.status = ?`;
            params.push(status);
        }

        if (role) {
            query += ` AND r.level = ?`;
            params.push(role);
        }

        const countQuery = `SELECT COUNT(*) as total FROM (${query}) as t`;
        const [countResult] = await db.query(countQuery, params);
        const total = countResult[0].total;

        query += ` ORDER BY u.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(pageSize), parseInt(offset));

        const [rows] = await db.query(query, params);

        return { list: rows, total };
    }

    async updateLastLogin(id) {
        await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    }
}

module.exports = new UserRepository();
