import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import db from '../models/database';
import { terminalService } from '../services/terminalService';
import type { User } from '../types';

interface SocketWithUser extends Socket {
  user?: User;
  isAlive?: boolean;
  terminalSessionIds?: Set<string>;
}

const taskRooms = new Map<string, Set<string>>();

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 5000;

function authenticateSocket(socket: Socket, next: (err?: Error) => void) {
  const token = socket.handshake.auth?.token || 
                socket.handshake.headers?.authorization?.replace('Bearer ', '');

  if (!token) {
    logger.error('❌ WebSocket 认证失败: 未提供 token');
    return next(new Error('未提供认证token'));
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { id: string };
    
    const user = db.prepare('SELECT id, username, email, role, enabled FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    
    if (!user || !user.enabled) {
      logger.error('❌ WebSocket 认证失败: 用户不存在或已禁用');
      return next(new Error('用户不存在或已禁用'));
    }

    (socket as SocketWithUser).user = user;
    logger.info(`✅ WebSocket 认证成功: ${user.username}`);
    next();
  } catch (error: unknown) {
    logger.error('❌ WebSocket 认证失败:', error);
    return next(new Error('无效的token'));
  }
}

export function setupWebSocket(io: SocketIOServer) {
  io.use(authenticateSocket);

  const heartbeatInterval = setInterval(() => {
    io.sockets.sockets.forEach((socket) => {
      const socketWithUser = socket as SocketWithUser;
      if (socketWithUser.isAlive === false) {
        logger.warn(`💔 WebSocket client ${socket.id} did not respond to ping, disconnecting`);
        socket.disconnect();
        return;
      }
      socketWithUser.isAlive = false;
      socket.emit('ping');
    });
  }, HEARTBEAT_INTERVAL);

  io.on('connection', (socket: Socket) => {
    const user = (socket as SocketWithUser).user;
    (socket as SocketWithUser).isAlive = true;
    (socket as SocketWithUser).terminalSessionIds = new Set();
    logger.info(`🔌 Client connected: ${socket.id} (User: ${user?.username})`);

    socket.on('pong', () => {
      (socket as SocketWithUser).isAlive = true;
    });

    let pingTimeout: NodeJS.Timeout | null = null;
    socket.conn.on('ping', () => {
      pingTimeout = setTimeout(() => {
        logger.warn(`💔 WebSocket client ${socket.id} ping timeout, disconnecting`);
        socket.disconnect();
      }, HEARTBEAT_TIMEOUT);
    });

    socket.conn.on('pong', () => {
      if (pingTimeout) {
        clearTimeout(pingTimeout);
        pingTimeout = null;
      }
    });

    socket.on('task:subscribe', (taskId: string) => {
      socket.join(`task:${taskId}`);
      if (!taskRooms.has(taskId)) {
        taskRooms.set(taskId, new Set());
      }
      taskRooms.get(taskId)!.add(socket.id);
      logger.info(`📡 Client ${socket.id} subscribed to task ${taskId}`);
    });

    socket.on('task:unsubscribe', (taskId: string) => {
      socket.leave(`task:${taskId}`);
      taskRooms.get(taskId)?.delete(socket.id);
      logger.info(`📤 Client ${socket.id} unsubscribed from task ${taskId}`);
    });

    socket.on('alert:subscribe', () => {
      socket.join('alerts');
      logger.info(`🔔 Client ${socket.id} subscribed to alerts`);
    });

    socket.on('terminal:open', async (data: { serverId: string; cols: number; rows: number }, callback: (result: { sessionId?: string; error?: string }) => void) => {
      try {
        const result = await terminalService.createTerminalSession(data.serverId, data.cols, data.rows);
        
        if (result.error) {
          callback({ error: result.error });
          return;
        }

        const sock = socket as SocketWithUser;
        sock.terminalSessionIds!.add(result.sessionId);
        socket.join(`terminal:${result.sessionId}`);

        const shellDataHandler = (shellData: Buffer) => {
          socket.emit('terminal:data', {
            sessionId: result.sessionId,
            data: shellData.toString('utf-8')
          });
        };

        result.shell.on('data', shellDataHandler);

        socket.on('terminal:disconnect', () => {
          result.shell.removeListener('data', shellDataHandler);
        });

        socket.on(`terminal:close-session:${result.sessionId}`, () => {
          result.shell.removeListener('data', shellDataHandler);
        });

        callback({ sessionId: result.sessionId });
      } catch (err) {
        callback({ error: err instanceof Error ? err.message : 'Unknown error' });
      }
    });

    socket.on('terminal:data', (data: { sessionId: string; data: string }) => {
      const role = (socket as SocketWithUser).user?.role;
      terminalService.sendData(data.sessionId, data.data, role);
    });

    socket.on('terminal:resize', (data: { sessionId: string; cols: number; rows: number }) => {
      terminalService.resizeTerminal(data.sessionId, data.cols, data.rows);
    });

    socket.on('terminal:close', (data: { sessionId: string }) => {
      const sock = socket as SocketWithUser;
      sock.terminalSessionIds!.delete(data.sessionId);
      socket.leave(`terminal:${data.sessionId}`);
      socket.emit(`terminal:close-session:${data.sessionId}`);
      terminalService.closeTerminalSession(data.sessionId);
    });

    socket.on('disconnect', () => {
      logger.info(`❌ Client disconnected: ${socket.id}`);
      taskRooms.forEach((sockets) => {
        sockets.delete(socket.id);
      });
      
      const sock = socket as SocketWithUser;
      const sessions = sock.terminalSessionIds;
      if (sessions) {
        sessions.forEach((sessionId) => {
          terminalService.closeTerminalSession(sessionId);
        });
        sock.terminalSessionIds = new Set();
      }

      if (pingTimeout) {
        clearTimeout(pingTimeout);
        pingTimeout = null;
      }
    });
  });

  io.on('close', () => {
    clearInterval(heartbeatInterval);
    logger.info('🔌 WebSocket server closed, heartbeat interval cleared');
  });
}

export function emitToTask(io: SocketIOServer, taskId: string, event: string, data: Record<string, unknown>) {
  io.to(`task:${taskId}`).emit(event, { taskId, ...data });
}

export function emitToAlerts(io: SocketIOServer, event: string, data: Record<string, unknown>) {
  io.to('alerts').emit(event, data);
}

export function broadcast(io: SocketIOServer, event: string, data: Record<string, unknown>) {
  io.emit(event, data);
}
