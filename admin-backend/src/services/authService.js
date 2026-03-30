const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');

const JWT_SECRET = process.env.JWT_SECRET || 'push-channel-dev-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

function buildUserPayload(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role_level,
        agentId: user.agent_id
    };
}

class AuthService {
    async login(username, password) {
        const user = await userRepository.findByUsername(username);
        if (!user || user.status !== 'active') {
            throw new Error('Invalid credentials or inactive user');
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            throw new Error('Invalid credentials');
        }

        await userRepository.updateLastLogin(user.id);

        const fullUser = await userRepository.findById(user.id);
        const token = jwt.sign(
            {
                sub: fullUser.id,
                agentId: fullUser.agent_id,
                role: fullUser.role_level
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        return {
            token,
            agentId: fullUser.agent_id,
            user: buildUserPayload(fullUser)
        };
    }

    async register(userData) {
        const agentId = typeof userData.agentId === 'string' ? userData.agentId.trim() : '';
        if (!agentId) {
            throw new Error('Agent ID is required');
        }

        const existingUser = await userRepository.findByUsername(userData.username);
        if (existingUser) {
            throw new Error('Username already exists');
        }

        const existingAgentUser = await userRepository.findByAgentId(agentId);
        if (existingAgentUser) {
            throw new Error('Agent ID already exists');
        }

        const password_hash = await bcrypt.hash(userData.password, 10);
        const role_id = 3; // Default to 'user' role

        const userId = await userRepository.create({
            ...userData,
            password_hash,
            role_id,
            agent_id: agentId
        });

        return userId;
    }

    async validateToken(token) {
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            const user = await userRepository.findById(payload.sub);
            if (!user || user.status !== 'active' || user.agent_id !== payload.agentId) return null;
            return buildUserPayload(user);
        } catch {
            return null;
        }
    }

    async validateAgent(agentId) {
        const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
        if (!normalizedAgentId) return null;
        const user = await userRepository.findByAgentId(normalizedAgentId);
        if (!user || user.status !== 'active') return null;
        return buildUserPayload(user);
    }

    async logout() {
        return;
    }
}

module.exports = new AuthService();
