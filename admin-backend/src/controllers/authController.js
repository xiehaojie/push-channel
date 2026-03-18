const authService = require('../services/authService');
const { success, error } = require('../utils/response');

class AuthController {
    async login(ctx) {
        try {
            const { username, password } = ctx.request.body;
            if (!username || !password) {
                ctx.status = 400;
                ctx.body = error('Username and password are required');
                return;
            }

            const result = await authService.login(username, password, ctx.ip, ctx.header['user-agent']);
            ctx.body = success(result);
        } catch (err) {
            ctx.status = 401;
            ctx.body = error(err.message, 401);
        }
    }

    async register(ctx) {
        try {
            const { username, password, email, name } = ctx.request.body;
            if (!username || !password || !email || !name) {
                ctx.status = 400;
                ctx.body = error('Missing required fields');
                return;
            }

            const userId = await authService.register(ctx.request.body);
            // Auto login after register
            const result = await authService.login(username, password, ctx.ip, ctx.header['user-agent']);
            ctx.body = success(result);
        } catch (err) {
            ctx.status = 400;
            ctx.body = error(err.message);
        }
    }

    async session(ctx) {
        // Handled by auth middleware, if we reach here, session is valid
        ctx.body = success({ user: ctx.state.user });
    }

    async logout(ctx) {
        const authHeader = ctx.header.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            await authService.logout(token);
        }
        ctx.body = success(null, 'Logged out successfully');
    }
}

module.exports = new AuthController();
