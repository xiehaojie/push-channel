const { error } = require('../utils/response');

const authenticate = async (ctx, next) => {
    // 假设网关在 Header 中透传了这些信息
    const userId = ctx.get('X-User-Id');
    const userName = ctx.get('X-User-Name');
    const userRole = ctx.get('X-User-Role');
    const agentId = ctx.get('X-Agent-Id');

    if (!userId) {
        ctx.status = 401;
        ctx.body = error('Unauthorized: No user info from Gateway', 401);
        return;
    }

    // 将网关信息封装到 ctx.state.user 中，供后续业务代码使用
    ctx.state.user = {
        id: userId,
        name: userName,
        role: userRole,
        agentId: agentId
    };
    
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
