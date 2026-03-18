const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const userRepository = require('../repositories/userRepository');
const sessionRepository = require('../repositories/sessionRepository');

class AuthService {
    async login(username, password, ip, userAgent) {
        const user = await userRepository.findByUsername(username);
        if (!user || user.status !== 'active') {
            throw new Error('Invalid credentials or inactive user');
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            throw new Error('Invalid credentials');
        }

        // Use existing fixed session_id or generate one if missing (lazy migration)
        let sessionId = user.session_id;
        if (!sessionId) {
            sessionId = uuidv4();
            await userRepository.updateSessionId(user.id, sessionId);
        }

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        await sessionRepository.create(sessionId, user.id, expiresAt, ip, userAgent);
        await userRepository.updateLastLogin(user.id);

        const fullUser = await userRepository.findById(user.id);

        return {
            sessionId,
            user: {
                id: fullUser.id,
                username: fullUser.username,
                email: fullUser.email,
                name: fullUser.name,
                role: fullUser.role_level
            }
        };
    }

    async register(userData) {
        const existingUser = await userRepository.findByUsername(userData.username);
        if (existingUser) {
            throw new Error('Username already exists');
        }

        const password_hash = await bcrypt.hash(userData.password, 10);
        const role_id = 3; // Default to 'user' role
        const session_id = uuidv4();

        const userId = await userRepository.create({
            ...userData,
            password_hash,
            role_id,
            session_id
        });

        return userId;
    }

    async validateSession(sessionId) {
        const session = await sessionRepository.findById(sessionId);
        if (!session) return null;

        const user = await userRepository.findById(session.user_id);
        if (!user || user.status !== 'active') return null;

        return {
            id: user.id,
            username: user.username,
            email: user.email,
            name: user.name,
            role: user.role_level
        };
    }

    async logout(sessionId) {
        await sessionRepository.delete(sessionId);
    }
}

module.exports = new AuthService();
