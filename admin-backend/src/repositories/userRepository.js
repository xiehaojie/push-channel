const { getPool } = require('../config/database');

class UserRepository {
    async findByUsername(username) {
        const db = getPool();
        const [rows] = await db.query(
            'SELECT id, username, password as password_hash, nickname as name, email, phone, orguid as department, post_name as title, status, oidc_user_id as agent_id, createTime as created_at FROM sys_user WHERE username = ?', 
            [username]
        );
        if (rows[0]) {
            // Map status for compatibility: 0 -> active, 1 -> inactive
            rows[0].status = rows[0].status === '0' ? 'active' : 'inactive';
        }
        return rows[0];
    }

    async findByAgentId(agentId) {
        const db = getPool();
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.password as password_hash, u.nickname as name, u.email, u.phone, u.orguid as department, u.post_name as title, u.status, u.oidc_user_id as agent_id, u.createTime as created_at
             FROM sys_user u
             WHERE u.oidc_user_id = ?`,
            [agentId]
        );
        if (rows[0]) {
            rows[0].status = rows[0].status === '0' ? 'active' : 'inactive';
            rows[0].role_name = 'user'; // Default role since junction table is missing
            rows[0].role_level = 'user';
        }
        return rows[0];
    }

    async findById(id) {
        const db = getPool();
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.password as password_hash, u.nickname as name, u.email, u.phone, u.orguid as department, u.post_name as title, u.status, u.oidc_user_id as agent_id, u.createTime as created_at
             FROM sys_user u 
             WHERE u.id = ?`, 
            [id]
        );
        if (rows[0]) {
            rows[0].status = rows[0].status === '0' ? 'active' : 'inactive';
            rows[0].role_name = 'user'; // Default role
            rows[0].role_level = 'user';
        }
        return rows[0];
    }

    async create(user) {
        const db = getPool();
        const { username, email, password, nickname, phone, orguid, post_name, oidc_user_id } = user;
        const [result] = await db.query(
            `INSERT INTO sys_user (username, email, password, nickname, phone, orguid, post_name, oidc_user_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, email, password, nickname, phone, orguid, post_name, oidc_user_id]
        );
        return result.insertId;
    }

    async updateStatus(id, status) {
        const db = getPool();
        // status mapping: 0-在职, 1-离职
        const dbStatus = status === 'active' ? '0' : '1';
        const [result] = await db.query('UPDATE sys_user SET status = ? WHERE id = ?', [dbStatus, id]);
        return result.affectedRows > 0;
    }

    async updateUser(id, { nickname, email, orguid, post_name }) {
        const db = getPool();
        const [result] = await db.query(
            'UPDATE sys_user SET nickname = ?, email = ?, orguid = ?, post_name = ? WHERE id = ?',
            [nickname, email, orguid, post_name, id]
        );
        return result.affectedRows > 0;
    }

    async findAll({ page = 1, pageSize = 10, search = '', status = '', role = '' }) {
        const db = getPool();
        const offset = (page - 1) * pageSize;
        let query = `
            SELECT u.id, u.username, u.email, u.nickname as name, u.phone, u.orguid as department, u.post_name as title, u.status, u.oidc_user_id as agent_id, u.createTime as created_at
            FROM sys_user u
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ? OR u.oidc_user_id LIKE ?)`;
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam, searchParam);
        }

        if (status) {
            const dbStatus = status === 'active' ? '0' : '1';
            query += ` AND u.status = ?`;
            params.push(dbStatus);
        }

        const countQuery = `SELECT COUNT(*) as total FROM (${query}) as t`;
        const [countResult] = await db.query(countQuery, params);
        const total = countResult[0].total;

        query += ` ORDER BY u.createTime DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(pageSize), parseInt(offset));

        const [rows] = await db.query(query, params);

        // Map status and add default roles for compatibility
        const list = rows.map(row => ({
            ...row,
            status: row.status === '0' ? 'active' : 'inactive',
            role_name: 'user',
            role_level: 'user'
        }));

        return { list, total };
    }

    async updateLastLogin(id) {
        const db = getPool();
        await db.query('UPDATE sys_user SET updateTime = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    }
}

module.exports = new UserRepository();
