const userRepository = require('../repositories/userRepository');
const { success, error } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

class UserController {
    async list(ctx) {
        try {
            const { page, pageSize, search, status, role } = ctx.query;
            const result = await userRepository.findAll({
                page: parseInt(page) || 1,
                pageSize: parseInt(pageSize) || 10,
                search,
                status,
                role
            });
            ctx.body = success({
                ...result,
                page: parseInt(page) || 1,
                pageSize: parseInt(pageSize) || 10
            });
        } catch (err) {
            ctx.status = 500;
            ctx.body = error('Failed to fetch users');
        }
    }

    async updateStatus(ctx) {
        try {
            const { id } = ctx.params;
            const { status } = ctx.request.body;

            if (!['active', 'inactive'].includes(status)) {
                ctx.status = 400;
                ctx.body = error('Invalid status');
                return;
            }

            const updated = await userRepository.updateStatus(id, status);
            if (!updated) {
                ctx.status = 404;
                ctx.body = error('User not found');
                return;
            }

            ctx.body = success(null, 'Status updated successfully');
        } catch (err) {
            ctx.status = 500;
            ctx.body = error('Failed to update status');
        }
    }

    async updateUser(ctx) {
        try {
            const { id } = ctx.params;
            const { name, email, department, title } = ctx.request.body;
            const updated = await userRepository.updateUser(id, { name, email, department, title });
            if (!updated) {
                ctx.status = 404;
                ctx.body = error('User not found');
                return;
            }
            ctx.body = success(null, 'User updated successfully');
        } catch (err) {
            ctx.status = 500;
            ctx.body = error('Failed to update user');
        }
    }

    async create(ctx) {
        try {
            const { username, password, email, name, phone, department, title, role_id } = ctx.request.body;
            if (!username || !password || !email || !name) {
                ctx.status = 400;
                ctx.body = error('Missing required fields');
                return;
            }

            const existingUser = await userRepository.findByUsername(username);
            if (existingUser) {
                ctx.status = 400;
                ctx.body = error('Username already exists');
                return;
            }

            const bcrypt = require('bcrypt');
            const password_hash = await bcrypt.hash(password, 10);
            const userRoleId = role_id || 3; // Default to 'user'
            const session_id = uuidv4();

            const userId = await userRepository.create({
                username, email, password_hash, name, phone, department, title, role_id: userRoleId, session_id
            });

            ctx.body = success({ id: userId, session_id }, 'User created successfully');
        } catch (err) {
            ctx.status = 500;
            ctx.body = error('Failed to create user');
        }
    }
}

module.exports = new UserController();
