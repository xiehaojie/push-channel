const webdav = require('webdav-server').v2;
const fs = require('fs');
const path = require('path');
const { success, error } = require('../utils/response');
const { IGNORED_DIRS, IGNORED_EXTENSIONS, IGNORED_FILES } = require('../config/fileFilter');

// 默认文件目录（从环境变量读取，默认为 /root/.openclaw/）
const DEFAULT_DIR = process.env.DEFAULT_DIR || '/root/.openclaw/';
//const DEFAULT_DIR = process.env.DEFAULT_DIR || 'D:\\xwechat_files\\chufei4791_5bed\\msg\\file\\2026-03\\admin-backend\\admin-backend\\';

// 文件监听器缓存 Map<agentId, chokidar.FSWatcher>
const fileWatchers = new Map();

// 文件变化广播函数（由外部注入）
let broadcastFileChange = null;

const setBroadcastFileChange = (fn) => {
    broadcastFileChange = fn;
};

// 根据 agentId 获取用户的 workspace 路径
const getUserDir = (agentId) => {
    // 使用正斜杠，确保跨平台兼容
    return `${DEFAULT_DIR.replace(/\/$/, '')}/workspace-${agentId}`;
};

// 启动文件监听
const startFileWatcher = (agentId) => {
    // 如果已有监听器，先关闭
    if (fileWatchers.has(agentId)) {
        fileWatchers.get(agentId).close();
    }

    const userDir = getUserDir(agentId);
    console.log(`[FileWatcher] Starting watcher for: ${userDir}`);

    // 确保目录存在
    const fs = require('fs');
    if (!fs.existsSync(userDir)) {
        try {
            fs.mkdirSync(userDir, { recursive: true });
            console.log(`[FileWatcher] Created directory: ${userDir}`);
        } catch (err) {
            console.error(`[FileWatcher] Failed to create directory: ${err.message}`);
            return;
        }
    }

    // 防抖定时器 Map
    const debounceTimers = new Map();
    const DEBOUNCE_DELAY = 300; // 毫秒

    // 检查是否应该忽略该文件
    const shouldIgnore = (filePath) => {
        const fileName = path.basename(filePath);

        // 检查文件名是否在忽略列表中
        if (IGNORED_FILES.includes(fileName)) return true;

        const relativePath = path.relative(userDir, filePath);
        const parts = relativePath.split(path.sep);

        // 检查是否在忽略的目录中
        for (const part of parts) {
            if (IGNORED_DIRS.includes(part)) return true;
        }

        // 检查文件扩展名
        const ext = path.extname(filePath);
        if (IGNORED_EXTENSIONS.includes(ext)) return true;

        return false;
    };

    // 使用 fs.watch 代替 chokidar
    const watcher = fs.watch(userDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // 直接过滤任何包含路径遍历或异常路径的 filename
        if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
            console.log(`[FileWatcher] Invalid filename (contains .. or absolute), ignoring: ${filename}`);
            return;
        }

        // 构建完整路径并验证
        const fullPath = path.join(userDir, filename);
        const normalizedUserDir = path.normalize(userDir);
        const normalizedFullPath = path.normalize(fullPath);

        // 确保最终路径在 userDir 内
        if (!normalizedFullPath.startsWith(normalizedUserDir + path.sep) && normalizedFullPath !== normalizedUserDir) {
            console.log(`[FileWatcher] Path outside userDir, ignoring: ${fullPath}`);
            return;
        }

        console.log(`[FileWatcher] Event: ${eventType}, File: ${filename}, FullPath: ${fullPath}`);

        // 检查是否忽略
        if (shouldIgnore(fullPath)) {
            console.log(`[FileWatcher] Ignored: ${filename}`);
            return;
        }

        // 防抖处理：清除之前的定时器
        if (debounceTimers.has(fullPath)) {
            clearTimeout(debounceTimers.get(fullPath));
        }

        // 设置新的定时器，等待文件写入完成
        const currentEventType = eventType;
        const timer = setTimeout(() => {
            debounceTimers.delete(fullPath);

            try {
                fs.stat(fullPath, (err, stats) => {
                    if (err) {
                        // 文件可能已被删除
                        if (err.code === 'ENOENT') {
                            sendChange('unlink', fullPath);
                        }
                        return;
                    }

                    if (stats.isDirectory()) {
                        sendChange(currentEventType === 'rename' ? 'addDir' : 'change', fullPath);
                    } else {
                        sendChange(currentEventType === 'rename' ? 'add' : 'change', fullPath);
                    }
                });
            } catch (e) {
                console.log(`[FileWatcher] Error: ${e.message}`);
            }
        }, DEBOUNCE_DELAY);

        debounceTimers.set(fullPath, timer);
    });

    watcher.on('error', (error) => {
        console.log(`[FileWatcher] Error: ${error}`);
    });

    console.log(`[FileWatcher] Using fs.watch for: ${userDir}`);

    const sendChange = async (eventType, filePath) => {
        console.log(`[FileWatcher] File ${eventType}: ${filePath}`);

        // 最终安全检查：确保路径在 userDir 内
        const normalizedUserDir = path.normalize(userDir);
        const normalizedFilePath = path.normalize(filePath);
        if (!normalizedFilePath.startsWith(normalizedUserDir + path.sep) && normalizedFilePath !== normalizedUserDir) {
            console.log(`[FileWatcher] Path outside userDir in sendChange, ignoring: ${filePath}`);
            return;
        }

        if (!broadcastFileChange) {
            console.log(`[FileWatcher] broadcastFileChange is null, skipping`);
            return;
        }

        const relativePath = path.relative(userDir, filePath);
        const fileName = path.basename(filePath);

        const message = {
            type: 'file_change',
            event: eventType,
            path: relativePath,
            fullPath: filePath,
            fileName: fileName,
            fileSize: 0
        };

        // 对于添加和修改事件，读取文件内容并转换为 base64
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

        if ((eventType === 'add' || eventType === 'change') && !eventType.includes('Dir')) {
            try {
                const fs = require('fs');
                const stats = fs.statSync(filePath);
                message.fileSize = stats.size;

                // 如果文件超过10M，不读取base64
                if (stats.size > MAX_FILE_SIZE) {
                    message.fileBase64 = null;
                } else {
                    const fileContent = fs.readFileSync(filePath);
                    message.fileBase64 = fileContent.toString('base64');
                }
            } catch (err) {
                console.error(`[FileWatcher] Failed to read file for base64: ${err.message}`);
            }
        }

        console.log(`[FileWatcher] ${eventType}: ${relativePath}`);
        broadcastFileChange(agentId, message);
    };

    watcher
        .on('add', (filePath) => sendChange('add', filePath))
        .on('change', (filePath) => sendChange('change', filePath))
        .on('unlink', (filePath) => sendChange('unlink', filePath))
        .on('addDir', (filePath) => sendChange('addDir', filePath))
        .on('unlinkDir', (filePath) => sendChange('unlinkDir', filePath))
        .on('error', (error) => console.error(`[FileWatcher] Error: ${error}`));

    fileWatchers.set(agentId, watcher);
    console.log(`[FileWatcher] Watcher started for agentId: ${agentId}`);
};

// 停止文件监听
const stopFileWatcher = (agentId) => {
    if (fileWatchers.has(agentId)) {
        fileWatchers.get(agentId).close();
        fileWatchers.delete(agentId);
        console.log(`[FileWatcher] Watcher stopped for agentId: ${agentId}`);
    }
};

// 初始化 WebDAV 服务器
let webdavServer = null;

const initWebDAVServer = () => {
    const server = new webdav.WebDAVServer({
        port: process.env.WEBDAV_PORT || 3005
    });

    // 配置虚拟文件系统（默认使用 DEFAULT_DIR，启动时不会带 agentId）
    server.setFileSystem('/', new webdav.PhysicalFileSystem(DEFAULT_DIR));
    console.log('[WebDAV] File system mounted:', DEFAULT_DIR);

    // 添加 CORS 支持
    server.beforeRequest((ctx, next) => {
        // 处理预检请求
        if (ctx.request.method === 'OPTIONS') {
            ctx.response.setHeader('Access-Control-Allow-Origin', '*');
            ctx.response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS');
            ctx.response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth, Lock-Token, If');
            ctx.response.setHeader('Access-Control-Max-Age', '86400');
            ctx.response.setHeader('Content-Length', '0');
            ctx.statusCode = 204;
            return;
        }
        next();
    });

    server.afterRequest((ctx, next) => {
        ctx.response.setHeader('Access-Control-Allow-Origin', '*');
        ctx.response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS');
        ctx.response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth, Lock-Token, If');
        ctx.response.setHeader('Access-Control-Expose-Headers', 'DAV');
        next();
    });

    return server;
};

const getWebDAVServer = () => {
    if (!webdavServer) {
        webdavServer = initWebDAVServer();
    }
    return webdavServer;
};

// 启动 WebDAV 服务器
const startWebDAVServer = () => {
    const server = getWebDAVServer();
    server.start(() => {
        console.log(`[WebDAV] Server started on port ${process.env.WEBDAV_PORT || 3005}`);
    });
};

class FileController {
    async listFiles(ctx) {
        try {
            const agentId = ctx.state.user?.agentId;
            if (!agentId) {
                ctx.status = 401;
                ctx.body = error('Unauthorized: missing agentId');
                return;
            }

            const userDir = getUserDir(agentId);
            const subPath = ctx.query.path || '';
            // 使用正斜杠拼接路径
            const dirPath = subPath ? `${userDir}/${subPath.replace(/^\//, '')}` : userDir;

            const fs = require('fs').promises;
            const items = await fs.readdir(dirPath, { withFileTypes: true });

            const files = items.map(item => ({
                name: item.name,
                isDirectory: item.isDirectory(),
                isFile: item.isFile()
            }));

            ctx.body = success({
                path: dirPath,
                files
            });
        } catch (err) {
            ctx.status = 500;
            ctx.body = error(`Failed to list files: ${err.message}`);
        }
    }

    // 获取 WebDAV 服务器实例
    getServer() {
        return getWebDAVServer();
    }
}

module.exports = new FileController();
module.exports.startWebDAVServer = startWebDAVServer;
module.exports.startFileWatcher = startFileWatcher;
module.exports.stopFileWatcher = stopFileWatcher;
module.exports.setBroadcastFileChange = setBroadcastFileChange;
module.exports.getUserDir = getUserDir;
module.exports.getUserDir = getUserDir;