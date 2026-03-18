-- 创建数据库
CREATE DATABASE IF NOT EXISTS admin_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE admin_db;

-- 创建角色表
CREATE TABLE roles (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) UNIQUE NOT NULL COMMENT '角色名称',
    description TEXT COMMENT '角色描述',
    level ENUM('super_admin', 'admin', 'user') DEFAULT 'user' COMMENT '角色级别',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_name (name),
    INDEX idx_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 插入默认角色
INSERT INTO roles (name, description, level) VALUES 
('超级管理员', '拥有系统所有权限', 'super_admin'),
('管理员', '拥有大部分管理权限', 'admin'),
('普通用户', '基础用户权限', 'user');

-- 创建权限表
CREATE TABLE permissions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(100) UNIQUE NOT NULL COMMENT '权限代码',
    name VARCHAR(100) NOT NULL COMMENT '权限名称',
    module VARCHAR(50) NOT NULL COMMENT '所属模块',
    description TEXT COMMENT '权限描述',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_code (code),
    INDEX idx_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 插入基础权限
INSERT INTO permissions (code, name, module, description) VALUES
('user.view', '查看用户', '用户管理', '查看用户列表和详情'),
('user.create', '创建用户', '用户管理', '创建新用户'),
('user.update', '更新用户', '用户管理', '更新用户信息'),
('user.delete', '删除用户', '用户管理', '删除用户'),
('role.view', '查看角色', '角色管理', '查看角色列表和详情'),
('role.create', '创建角色', '角色管理', '创建新角色'),
('role.update', '更新角色', '角色管理', '更新角色信息'),
('role.delete', '删除角色', '角色管理', '删除角色'),
('admin.access', '访问后台', '系统管理', '访问后台管理系统');

CREATE TABLE role_permissions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 创建用户表
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL COMMENT '用户名',
    email VARCHAR(100) UNIQUE NOT NULL COMMENT '邮箱',
    password_hash VARCHAR(255) NOT NULL COMMENT '加密密码',
    name VARCHAR(100) NOT NULL COMMENT '真实姓名',
    phone VARCHAR(20) COMMENT '联系电话',
    department VARCHAR(100) COMMENT '所属部门',
    title VARCHAR(100) COMMENT '职位',
    status ENUM('active', 'inactive') DEFAULT 'active' COMMENT '状态',
    role_id INT COMMENT '角色ID',
    session_id VARCHAR(128) UNIQUE COMMENT 'Fixed Session ID',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL COMMENT '最后登录时间',
    INDEX idx_username (username),
    INDEX idx_email (email),
    INDEX idx_status (status),
    INDEX idx_role_id (role_id),
    FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 插入超级管理员用户 (密码为 admin123, hash 为 $2b$10$zJak3zgriEd4PFGTqHX65ewLN6iHTBEwwOJ6PppZyyIJFjRe0yGEK)
INSERT INTO users (username, email, password_hash, name, department, title, status, role_id) 
VALUES ('admin', 'admin@example.com', '$2b$10$zJak3zgriEd4PFGTqHX65ewLN6iHTBEwwOJ6PppZyyIJFjRe0yGEK', '超级管理员', '技术部', '系统管理员', 'active', 1);

-- 创建会话表
CREATE TABLE sessions (
    session_id VARCHAR(128) PRIMARY KEY COMMENT '会话ID',
    user_id INT NOT NULL COMMENT '用户ID',
    expires_at TIMESTAMP NOT NULL COMMENT '过期时间',
    ip_address VARCHAR(45) COMMENT 'IP地址',
    user_agent TEXT COMMENT '用户代理',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
