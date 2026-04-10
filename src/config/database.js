const mysql = require('mysql2/promise');

let pool;

async function initDB(dbConfig) {
    if (pool) return pool;

    pool = mysql.createPool({
        host: dbConfig.DB_HOST || 'localhost',
        user: dbConfig.DB_USER || 'admin_user',
        password: dbConfig.DB_PASSWORD || 'admin_password',
        database: dbConfig.DB_NAME || 'admin_db',
        port: dbConfig.DB_PORT || 3306,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'utf8mb4'
    });
    return pool;
}

module.exports = { initDB, getPool: () => pool };
