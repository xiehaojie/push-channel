const authService = require('../services/authService');
const { error } = require('../utils/response');

const authenticate = async (ctx, next) => {
    const authHeader = ctx.header.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        ctx.status = 401;
        ctx.body = error('Unauthorized', 401);
        return;
    }

    const token = authHeader.split(' ')[1];
    const user = await authService.validateToken(token);

    if (!user) {
        ctx.status = 401;
        ctx.body = error('Invalid or expired token', 401);
        return;
    }

    ctx.state.user = user;
    ctx.state.token = token;
    await next();
};

const requireRole = (roles) => {
    return async (ctx, next) => {
        const user = ctx.state.user;
        if (!user || !roles.includes(user.role)) {
            ctx.status = 403;
            ctx.body = error('Forbidden: Insufficient permissions', 403);
            return;
        }
        await next();
    };
};

module.exports = { authenticate, requireRole };
