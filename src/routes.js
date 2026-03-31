const Router = require('@koa/router');
const authController = require('./controllers/authController');
const userController = require('./controllers/userController');
const pushController = require('./controllers/pushController');
const { authenticate, requireRole } = require('./middleware/auth');

const router = new Router({ prefix: '/api' });

// Auth routes
router.post('/auth/login', authController.login);
router.post('/auth/register', authController.register);
router.get('/auth/session', authenticate, authController.session);
router.post('/auth/logout', authenticate, authController.logout);

// User management routes
router.get('/users', authenticate, requireRole(['super_admin', 'admin']), userController.list);
router.post('/users', authenticate, requireRole(['super_admin', 'admin']), userController.create);
router.patch('/users/:id/status', authenticate, requireRole(['super_admin', 'admin']), userController.updateStatus);
router.put('/users/:id', authenticate, requireRole(['super_admin', 'admin']), userController.updateUser);

// Compat for old middleware endpoints
router.post('/register', authController.register);
router.post('/auth', authController.login);
router.post('/send', pushController.send);

// Root level fallback for old middleware endpoints
const rootRouter = new Router();
rootRouter.post('/register', authController.register);
rootRouter.post('/auth', authController.login);
rootRouter.post('/send', pushController.send);
// Openclaw sends here when the middlewareUrl is just the root or trailing slash issue
rootRouter.post('//send', pushController.send);
// Add webhook fallback just in case
rootRouter.post('/webhook', async (ctx) => {
    console.log('Received webhook:', ctx.request.body);
    ctx.status = 200;
    ctx.body = 'OK';
});

module.exports = { router, rootRouter };
