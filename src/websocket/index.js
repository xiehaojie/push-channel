const { WebSocketServer } = require("ws");
const authService = require("../services/authService");
const fetch = require("node-fetch");
const { startFileWatcher, stopFileWatcher, setBroadcastFileChange, getUserDir } = require("../controllers/fileController");
const { IGNORED_FILES, IGNORED_DIRS } = require("../config/fileFilter");
const fs = require("fs");
const path = require("path");

const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || "http://10.14.100.131:3002/webhook";

const connections = new Map(); // Map<agentId, Set<socket>>
const activeStreams = new Map();
const toolExecutionState = new Map();
const REQUEST_TIMEOUT_HINT = "Request timed out before a response was generated";

// 文件变化广播函数
function broadcastFileChange(agentId, message) {
    console.log(`[Broadcast] Received file change for agentId: ${agentId}`, message);
    const socketSet = connections.get(agentId);
    if (!socketSet) {
        console.log(`[Broadcast] No socket connections found for agentId: ${agentId}`);
        return;
    }
    console.log(`[Broadcast] Found ${socketSet.size} connections for agentId: ${agentId}`);
    const msgStr = JSON.stringify(message);
    for (const sock of socketSet) {
        if (sock.readyState === 1) { // WebSocket.OPEN
            console.log(`[Broadcast] Sending to socket`);
            sock.send(msgStr);
        } else {
            console.log(`[Broadcast] Socket not open, state: ${sock.readyState}`);
        }
    }
}

// 注入广播函数到 fileController
setBroadcastFileChange(broadcastFileChange);

function markToolRunning(agentId, running) {
  if (!agentId) return;
  if (running) {
    toolExecutionState.set(agentId, true);
  } else {
    toolExecutionState.delete(agentId);
  }
}

function isToolRunning(agentId) {
  return toolExecutionState.get(agentId) === true;
}

function isTimeoutMessage(text) {
  return typeof text === "string" && text.includes(REQUEST_TIMEOUT_HINT);
}

function broadcast(agentId, message, excludeSocket = null) {
  const socketSet = connections.get(agentId);
  if (!socketSet) return;
  const msgStr = typeof message === "string" ? message : JSON.stringify(message);
  for (const sock of socketSet) {
    if (sock !== excludeSocket && sock.readyState === 1) { // WebSocket.OPEN
      sock.send(msgStr);
    }
  }
}

let namingClient = null;
let userCenterServiceName = null;

// 从 user-center 服务获取用户信息
async function getUserFromUserCenter(jbUserId) {
    if (!namingClient || !userCenterServiceName) {
        console.error('[WebSocket] Naming client not initialized');
        return null;
    }

    try {
        const instances = await namingClient.selectInstances(userCenterServiceName);
        if (!instances || instances.length === 0) {
            console.error('[WebSocket] No instances found for user-center');
            return null;
        }

        const instance = instances[0];
        const url = `http://${instance.ip}:${instance.port}/users/jbUserId?jbUserId=${encodeURIComponent(jbUserId)}`;
        console.log('[WebSocket] Calling user-center:', url);

        const response = await fetch(url);
        const text = await response.text();
        console.log('[WebSocket] Response from user-center:', text.substring(0, 500));

        const result = JSON.parse(text);

        // user-center 返回的是 datas 字段，可能有 code 也可能没有
        const userData = result.data || result.datas;

        if (userData && (result.code === 200 || result.code === undefined)) {
            // 映射字段，兼容不同格式
            return {
                id: userData.id,
                username: userData.username,
                openclawEnabled: userData.openclawEnabled !== false // 默认为 true
            };
        }

        console.error('[WebSocket] Failed to get user:', result.message || 'Unknown error');
        return null;
    } catch (e) {
        console.error('[WebSocket] Error calling user-center:', e.message);
        return null;
    }
}

function initWebSocket(server, nc, ucServiceName) {
  namingClient = nc;
  userCenterServiceName = ucServiceName;

  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    console.log("WebSocket: A user connected");

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" })); // 只回复请求者
        return;
      }

      if (data.type === "register" && typeof data.agentId === "string") {
        const agentId = data.agentId.trim();

        if (!agentId) {
          socket.close(4001, "Invalid agent");
          return;
        }

        let user = null;
        let openclawEnabled = false;

        if (agentId.startsWith("test-agent")) {
          // 测试用户，直接允许
          user = { id: 1, username: "test" };
          openclawEnabled = true;
        } else {
          // 从 user-center 获取用户信息
          user = await getUserFromUserCenter(agentId);
          if (user) {
            openclawEnabled = user.openclawEnabled === true;
          }
        }

        if (!user) {
          console.log(`WebSocket: User not found for agentId: ${agentId}`);
          socket.close(4001, "User not found");
          return;
        }

        // 检查 openclawEnabled
        if (!openclawEnabled) {
          console.log(`WebSocket: openclawEnabled is false for agentId: ${agentId}`);
          socket.send(JSON.stringify({ type: "error", message: "没有权限" }));
          socket.close(4002, "OpenClaw not enabled");
          return;
        }

        // 支持同一 agentId 多个连接
        let socketSet = connections.get(agentId);
        if (!socketSet) {
          socketSet = new Set();
          connections.set(agentId, socketSet);
        }
        socketSet.add(socket);

        console.log(`WebSocket: User registered with agentId: ${agentId}, total connections: ${socketSet.size}`);
        socket.agentId = agentId;

        // 如果是第一个连接，启动文件监听
        if (socketSet.size === 1) {
            startFileWatcher(agentId);
        }

        // 返回当前目录下所有文件列表
        const userDir = getUserDir(agentId);
        // 支持指定子目录路径
        const subPath = typeof data.path === "string" ? data.path.trim() : "";
        const targetDir = subPath ? path.join(userDir, subPath) : userDir;
        let fileList = [];
        try {
            // 确保目录存在
            if (!fs.existsSync(targetDir)) {
                try {
                    fs.mkdirSync(targetDir, { recursive: true });
                } catch (e) {
                    console.error(`Failed to create directory: ${e.message}`);
                }
            }

            if (fs.existsSync(targetDir)) {
                const items = fs.readdirSync(targetDir, { withFileTypes: true });
                fileList = items
                    .filter(item => !IGNORED_FILES.includes(item.name) && !IGNORED_DIRS.includes(item.name))
                    .map(item => {
                        const fullPath = path.join(targetDir, item.name);
                        let fileBase64 = null;
                        let fileSize = 0;
                        if (item.isFile()) {
                            const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

                            try {
                                const stats = fs.statSync(fullPath);
                                fileSize = stats.size;

                                // 如果文件超过10M，不读取base64
                                if (fileSize > MAX_FILE_SIZE) {
                                    fileBase64 = null;
                                } else {
                                    const content = fs.readFileSync(fullPath);
                                    fileBase64 = content.toString('base64');
                                }
                            } catch (e) {
                                console.error(`Failed to read file ${fullPath}: ${e.message}`);
                            }
                        }
                        // 获取文件最后修改时间
                        let lastModified = null;
                        try {
                            const stats = fs.statSync(fullPath);
                            lastModified = stats.mtime.toISOString();
                        } catch (e) {
                            // 忽略错误
                        }

                        return {
                            name: item.name,
                            isDirectory: item.isDirectory(),
                            isFile: item.isFile(),
                            path: item.name,
                            fullPath: fullPath,
                            fileBase64: fileBase64,
                            fileSize: fileSize,
                            lastModified: lastModified
                        };
                    });
            }
        } catch (err) {
            console.error(`Failed to list files for ${agentId}: ${err.message}`);
        }

        socket.send(JSON.stringify({
            type: "registered",
            agentId: agentId,
            path: subPath,
            files: fileList
        }));

        return;
      }

      // 处理用户修改文件的事件
      if (data.type === "user-change-file" && data.fileName && data.fileBase64 !== undefined) {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        const userDir = getUserDir(agentId);
        const filePath = path.join(userDir, data.fileName);
        const normalizedUserDir = path.normalize(userDir);
        const normalizedFilePath = path.normalize(filePath);

        // 安全检查：确保路径在 userDir 内
        if (!normalizedFilePath.startsWith(normalizedUserDir + path.sep)) {
          console.error(`WebSocket: Path outside userDir, ignoring: ${filePath}`);
          socket.send(JSON.stringify({ type: "error", message: "Invalid file path" }));
          return;
        }

        try {
          const fileContent = Buffer.from(data.fileBase64, 'base64');
          fs.writeFileSync(filePath, fileContent);
          console.log(`WebSocket: File updated: ${filePath}`);
          socket.send(JSON.stringify({ type: "file-updated", fileName: data.fileName, success: true }));
        } catch (err) {
          console.error(`WebSocket: Failed to write file: ${err.message}`);
          socket.send(JSON.stringify({ type: "error", message: `Failed to write file: ${err.message}` }));
        }
        return;
      }

      // 处理用户新建文件的事件
      if (data.type === "user-create-file" && data.fileName) {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        const userDir = getUserDir(agentId);
        const filePath = path.join(userDir, data.fileName);
        const normalizedUserDir = path.normalize(userDir);
        const normalizedFilePath = path.normalize(filePath);

        // 安全检查
        if (!normalizedFilePath.startsWith(normalizedUserDir + path.sep)) {
          console.error(`WebSocket: Path outside userDir, ignoring: ${filePath}`);
          socket.send(JSON.stringify({ type: "error", message: "Invalid file path" }));
          return;
        }

        // 检查文件是否已存在
        if (fs.existsSync(filePath)) {
          socket.send(JSON.stringify({ type: "error", message: "文件已存在" }));
          return;
        }

        try {
          const content = data.fileBase64 ? Buffer.from(data.fileBase64, 'base64') : Buffer.from('');
          fs.writeFileSync(filePath, content);
          console.log(`WebSocket: File created: ${filePath}`);
          socket.send(JSON.stringify({ type: "file-created", fileName: data.fileName, success: true }));
        } catch (err) {
          console.error(`WebSocket: Failed to create file: ${err.message}`);
          socket.send(JSON.stringify({ type: "error", message: `Failed to create file: ${err.message}` }));
        }
        return;
      }

      // 处理用户删除文件的事件
      if (data.type === "user-delete-file" && data.fileName) {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        const userDir = getUserDir(agentId);
        const filePath = path.join(userDir, data.fileName);
        const normalizedUserDir = path.normalize(userDir);
        const normalizedFilePath = path.normalize(filePath);

        // 安全检查
        if (!normalizedFilePath.startsWith(normalizedUserDir + path.sep)) {
          console.error(`WebSocket: Path outside userDir, ignoring: ${filePath}`);
          socket.send(JSON.stringify({ type: "error", message: "Invalid file path" }));
          return;
        }

        // 不允许删除目录
        try {
          const stats = fs.statSync(filePath);
          if (stats.isDirectory()) {
            socket.send(JSON.stringify({ type: "error", message: "不支持删除目录" }));
            return;
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: "error", message: "文件不存在" }));
          return;
        }

        try {
          fs.unlinkSync(filePath);
          console.log(`WebSocket: File deleted: ${filePath}`);
          socket.send(JSON.stringify({ type: "file-deleted", fileName: data.fileName, success: true }));
        } catch (err) {
          console.error(`WebSocket: Failed to delete file: ${err.message}`);
          socket.send(JSON.stringify({ type: "error", message: `Failed to delete file: ${err.message}` }));
        }
        return;
      }

      // 处理用户新建文件夹的事件
      if (data.type === "user-create-dir" && data.dirName) {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        const userDir = getUserDir(agentId);
        const dirPath = path.join(userDir, data.dirName);
        const normalizedUserDir = path.normalize(userDir);
        const normalizedDirPath = path.normalize(dirPath);

        // 安全检查
        if (!normalizedDirPath.startsWith(normalizedUserDir + path.sep)) {
          console.error(`WebSocket: Path outside userDir, ignoring: ${dirPath}`);
          socket.send(JSON.stringify({ type: "error", message: "Invalid path" }));
          return;
        }

        // 检查目录是否已存在
        if (fs.existsSync(dirPath)) {
          socket.send(JSON.stringify({ type: "error", message: "目录已存在" }));
          return;
        }

        try {
          fs.mkdirSync(dirPath, { recursive: true });
          console.log(`WebSocket: Directory created: ${dirPath}`);
          socket.send(JSON.stringify({ type: "dir-created", dirName: data.dirName, success: true }));
        } catch (err) {
          console.error(`WebSocket: Failed to create directory: ${err.message}`);
          socket.send(JSON.stringify({ type: "error", message: `Failed to create directory: ${err.message}` }));
        }
        return;
      }

      // 处理用户删除文件夹的事件
      if (data.type === "user-delete-dir" && data.dirName) {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        const userDir = getUserDir(agentId);
        const dirPath = path.join(userDir, data.dirName);
        const normalizedUserDir = path.normalize(userDir);
        const normalizedDirPath = path.normalize(dirPath);

        // 安全检查
        if (!normalizedDirPath.startsWith(normalizedUserDir + path.sep)) {
          console.error(`WebSocket: Path outside userDir, ignoring: ${dirPath}`);
          socket.send(JSON.stringify({ type: "error", message: "Invalid path" }));
          return;
        }

        // 检查是否为目录
        try {
          const stats = fs.statSync(dirPath);
          if (!stats.isDirectory()) {
            socket.send(JSON.stringify({ type: "error", message: "不是目录" }));
            return;
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: "error", message: "目录不存在" }));
          return;
        }

        try {
          // 递归删除目录
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`WebSocket: Directory deleted: ${dirPath}`);
          socket.send(JSON.stringify({ type: "dir-deleted", dirName: data.dirName, success: true }));
        } catch (err) {
          console.error(`WebSocket: Failed to delete directory: ${err.message}`);
          socket.send(JSON.stringify({ type: "error", message: `Failed to delete directory: ${err.message}` }));
        }
        return;
      }

      // 处理用户重命名目录/文件夹的事件
      if (data.type === "user-rename-dir" && data.oldName && data.newName) {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        const userDir = getUserDir(agentId);
        const normalizedUserDir = path.normalize(userDir);

        // 处理 oldName
        const oldPath = data.oldName.startsWith('/') ? data.oldName : path.join(userDir, data.oldName);
        const normalizedOldPath = path.normalize(oldPath);

        // 处理 newName
        const newPath = data.newName.startsWith('/') ? data.newName : path.join(userDir, data.newName);
        const normalizedNewPath = path.normalize(newPath);

        // 安全检查
        if (!normalizedOldPath.startsWith(normalizedUserDir + path.sep) || !normalizedNewPath.startsWith(normalizedUserDir + path.sep)) {
          console.error(`WebSocket: Path outside userDir, ignoring`);
          socket.send(JSON.stringify({ type: "error", message: "Invalid path" }));
          return;
        }

        // 检查原路径是否存在
        if (!fs.existsSync(oldPath)) {
          socket.send(JSON.stringify({ type: "error", message: "原路径不存在" }));
          return;
        }

        // 检查新路径是否已存在
        if (fs.existsSync(newPath)) {
          socket.send(JSON.stringify({ type: "error", message: "目标路径已存在" }));
          return;
        }

        try {
          fs.renameSync(oldPath, newPath);
          console.log(`WebSocket: Renamed: ${oldPath} -> ${newPath}`);
          socket.send(JSON.stringify({ type: "dir-renamed", oldName: data.oldName, newName: data.newName, success: true }));
        } catch (err) {
          console.error(`WebSocket: Failed to rename: ${err.message}`);
          socket.send(JSON.stringify({ type: "error", message: `重命名失败: ${err.message}` }));
        }
        return;
      }

      if (data.type === "message" && typeof data.content === "string") {
        const agentId = socket.agentId;
        if (!agentId) {
          console.error("WebSocket: Socket not registered with agentId");
          return;
        }

        try {
          const sessionId =
            typeof data.sessionId === "string" && data.sessionId.trim() ? data.sessionId.trim() : agentId;
          const payload = { agentId, sessionId, content: data.content };

          // 广播用户发送的消息到同 agentId 的其他标签页（排除自己）
          broadcast(agentId, JSON.stringify({
            type: "message_sent",
            content: data.content,
            role: "user"
          }), socket);

          console.log("WebSocket: Forwarding to OpenClaw with payload:", payload);

          if (activeStreams.has(agentId)) {
            console.log(`WebSocket: Aborting previous stream for agent: ${agentId}`);
            activeStreams.get(agentId).abort();
            activeStreams.delete(agentId);
          }

          const abortController = new AbortController();
          activeStreams.set(agentId, abortController);

          const res = await fetch(OPENCLAW_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: abortController.signal,
          });

          if (!res.ok) {
            console.error(`WebSocket: Failed to forward to OpenClaw: ${res.statusText}`);
            broadcast(agentId,
              JSON.stringify({ type: "error", message: `OpenClaw error: ${res.statusText}` }),
            );
            return;
          }

          if (res.body) {
            let streamStarted = false;

            let buffer = "";
            res.body.on("data", (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split("\n");
              buffer = lines.pop();

              for (const line of lines) {
                if (line.trim() === "" || !line.startsWith("data: ")) continue;

                const jsonStr = line.slice(6);
                try {
                  const event = JSON.parse(jsonStr);
                  if (event.type === "content" && event.delta) {
                    if (isTimeoutMessage(event.delta) && isToolRunning(agentId)) {
                      broadcast(agentId,
                        JSON.stringify({
                          type: "timeout_deferred",
                          message: "Tools are still running. Waiting for a follow-up notification.",
                        }),
                      );
                      continue;
                    }

                    if (!streamStarted) {
                      streamStarted = true;
                      broadcast(agentId,JSON.stringify({ type: "stream_start", from: "Assistant" }));
                    }

                    broadcast(agentId,
                      JSON.stringify({
                        type: "stream",
                        content: event.delta,
                        role: "assistant",
                      }),
                    );
                  } else if (event.type === "tool_call") {
                    if (streamStarted) {
                      broadcast(agentId,JSON.stringify({ type: "stream_end" }));
                      streamStarted = false;
                    }
                    broadcast(agentId,
                      JSON.stringify({
                        type: "tool_call",
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        args: event.args ?? {},
                      }),
                    );
                  } else if (event.type === "tool_result") {
                    if (streamStarted) {
                      broadcast(agentId,JSON.stringify({ type: "stream_end" }));
                      streamStarted = false;
                    }
                    broadcast(agentId,
                      JSON.stringify({
                        type: "tool_result",
                        toolCallId: event.toolCallId,
                      }),
                    );
                  } else if (event.type === "tool_start") {
                    if (streamStarted) {
                      broadcast(agentId,JSON.stringify({ type: "stream_end" }));
                      streamStarted = false;
                    }
                    markToolRunning(agentId, true);
                    broadcast(agentId,JSON.stringify({ type: "tool_start" }));
                  } else if (event.type === "tool_end") {
                    markToolRunning(agentId, false);
                    broadcast(agentId,JSON.stringify({ type: "tool_end" }));
                  } else if (event.type === "timeout_deferred") {
                    broadcast(agentId,
                      JSON.stringify({
                        type: "timeout_deferred",
                        message:
                          event.message ||
                          "Tools are still running. Waiting for a follow-up notification.",
                      }),
                    );
                  } else if (event.type === "done" && streamStarted) {
                    broadcast(agentId,JSON.stringify({ type: "stream_end" }));
                    streamStarted = false;
                  }
                } catch (error) {
                  console.error("Error parsing SSE event:", error);
                }
              }
            });

            res.body.on("end", () => {
              console.log("OpenClaw stream ended");
              if (activeStreams.get(agentId) === abortController) {
                activeStreams.delete(agentId);
              }
              if (streamStarted && socket.readyState === socket.OPEN) {
                broadcast(agentId,JSON.stringify({ type: "stream_end" }));
                streamStarted = false;
              }
            });

            res.body.on("error", (error) => {
              if (error.name === "AbortError" || error.type === "aborted") {
                console.log(`OpenClaw stream aborted for agent: ${agentId}`);
              } else {
                console.error("OpenClaw stream error:", error);
              }
              if (activeStreams.get(agentId) === abortController) {
                activeStreams.delete(agentId);
              }
              if (streamStarted && socket.readyState === socket.OPEN) {
                broadcast(agentId,JSON.stringify({ type: "stream_end" }));
                streamStarted = false;
              }
            });
          } else {
            console.log("WebSocket: Forwarded to OpenClaw successfully (no stream body)");
          }
        } catch (error) {
          if (error.name === "AbortError") {
            console.log(`WebSocket: Stream aborted for agent: ${agentId}`);
          } else {
            console.error("WebSocket: Failed to forward to OpenClaw", error);
          }
        }
      }
    });

    socket.on("close", () => {
      console.log("WebSocket: User disconnected");
      if (!socket.agentId) return;

      // 从连接集合中移除
      const socketSet = connections.get(socket.agentId);
      if (socketSet) {
        socketSet.delete(socket);
        if (socketSet.size === 0) {
          connections.delete(socket.agentId);
          // 该 agentId 无连接时，中止其流
          if (activeStreams.has(socket.agentId)) {
            activeStreams.get(socket.agentId).abort();
            activeStreams.delete(socket.agentId);
          }
          markToolRunning(socket.agentId, false);
          // 停止文件监听
          stopFileWatcher(socket.agentId);
        }
      }
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        if (ws.agentId) {
          const socketSet = connections.get(ws.agentId);
          if (socketSet) {
            socketSet.delete(ws);
            if (socketSet.size === 0) {
              connections.delete(ws.agentId);
              // 停止文件监听
              stopFileWatcher(ws.agentId);
            }
          }
        }
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  return connections;
}

module.exports = { initWebSocket, connections, isToolRunning, markToolRunning };
