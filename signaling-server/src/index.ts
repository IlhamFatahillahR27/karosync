import { createSignalingServer } from './server.js';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const host = process.env.HOST ?? '0.0.0.0';
const port = parsePositiveInt(process.env.PORT, 8080);
const maxClientsPerRoom = parsePositiveInt(process.env.MAX_CLIENTS_PER_ROOM, 8);
const heartbeatIntervalMs = parsePositiveInt(process.env.HEARTBEAT_INTERVAL_MS, 30_000);

const server = createSignalingServer({
  host,
  port,
  maxClientsPerRoom,
  heartbeatIntervalMs,
});

const address = await server.listen();
console.log(
  `[karosync/signaling] Listening on ws://${address.host}:${address.port} (health: http://${address.host}:${address.port}/health)`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[karosync/signaling] Received ${signal}, shutting down...`);
  try {
    await server.close();
    process.exit(0);
  } catch (err) {
    console.error('[karosync/signaling] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
