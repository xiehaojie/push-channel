const Router = require('@koa/router');
const userController = require('./controllers/userController');
const { authenticate, requireRole } = require('./middleware/auth');

const router = new Router();

// User management routes
router.get('/users', authenticate, requireRole(['super_admin', 'admin']), userController.list);
router.post('/users', authenticate, requireRole(['super_admin', 'admin']), userController.create);
router.patch('/users/:id/status', authenticate, requireRole(['super_admin', 'admin']), userController.updateStatus);
router.put('/users/:id', authenticate, requireRole(['super_admin', 'admin']), userController.updateUser);

module.exports = { router };
