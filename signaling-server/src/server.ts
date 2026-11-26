import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { RoomManager } from './room-manager.js';

export interface SignalingServerOptions {
  host?: string;
  port?: number;
  maxClientsPerRoom?: number;
  heartbeatIntervalMs?: number;
  maxPayloadBytes?: number;
}

export interface SignalingServerInstance {
  httpServer: http.Server;
  wss: WebSocketServer;
  roomManager: RoomManager;
  listen: () => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
  getAddress: () => { host: string; port: number } | null;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

export function createSignalingServer(
  options: SignalingServerOptions = {},
): SignalingServerInstance {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 8080;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  const roomManager = new RoomManager({
    maxClientsPerRoom: options.maxClientsPerRoom,
  });

  const aliveMap = new WeakMap<WebSocket, boolean>();

  const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/health') {
      const stats = roomManager.getStats(wss.clients.size);
      const body = JSON.stringify({
        status: 'ok',
        ...stats,
        uptime: Math.floor(process.uptime()),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: maxPayloadBytes,
  });

  wss.on('connection', (socket: WebSocket) => {
    aliveMap.set(socket, true);

    socket.on('pong', () => {
      aliveMap.set(socket, true);
    });

    socket.on('message', (data: RawData) => {
      roomManager.handleRawMessage(socket, rawDataToString(data));
    });

    socket.on('close', () => {
      roomManager.handleDisconnect(socket);
    });

    socket.on('error', () => {
      roomManager.handleDisconnect(socket);
    });
  });

  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const client of wss.clients) {
        if (aliveMap.get(client) === false) {
          client.terminate();
          continue;
        }
        aliveMap.set(client, false);
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
  }

  const getAddress = (): { host: string; port: number } | null => {
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      return null;
    }
    return { host: (addr as AddressInfo).address, port: (addr as AddressInfo).port };
  };

  const listen = (): Promise<{ host: string; port: number }> => {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        const addr = getAddress();
        if (!addr) {
          reject(new Error('Server failed to bind to a TCP address.'));
          return;
        }
        resolve(addr);
      });
    });
  };

  const close = async (): Promise<void> => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    for (const client of wss.clients) {
      client.terminate();
    }
    roomManager.clear();

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });

    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  };

  return {
    httpServer,
    wss,
    roomManager,
    listen,
    close,
    getAddress,
  };
}
