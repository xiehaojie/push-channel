const Router = require('@koa/router');
const authController = require('./controllers/authController');
const userController = require('./controllers/userController');
const pushController = require('./controllers/pushController');

const router = new Router({ prefix: '/api' });

// Auth routes
router.post('/auth/login', authController.login);
router.post('/auth/register', authController.register);
router.get('/auth/session', authController.session);
router.post('/auth/logout', authController.logout);

// User management routes
router.get('/users', userController.list);
router.post('/users', userController.create);
router.patch('/users/:id/status', userController.updateStatus);
router.put('/users/:id', userController.updateUser);

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
