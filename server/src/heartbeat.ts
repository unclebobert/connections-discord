import { WebSocket } from 'ws';

/**
 * Keeps idle sockets alive and reaps dead ones.
 *
 * Cloudflare and Discord's activity proxy both close WebSockets that go quiet, and a
 * Connections board is quiet for minutes at a time. Unlike a browser, a server can
 * send real WebSocket protocol pings, which the client answers automatically — so
 * none of this needs any client-side code.
 */
export class SocketHeartbeat {
  private readonly alive = new WeakSet<WebSocket>();
  private readonly sockets = new Set<WebSocket>();
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  // Parameter properties are deliberately avoided: Node runs these sources directly
  // with strip-only type removal, which cannot emit the implied assignments.
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  track(socket: WebSocket) {
    this.alive.add(socket);
    this.sockets.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    socket.on('close', () => this.sockets.delete(socket));
  }

  start() {
    this.timer ??= setInterval(() => this.sweep(), this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get size() {
    return this.sockets.size;
  }

  sweep() {
    for (const socket of this.sockets) {
      if (socket.readyState !== WebSocket.OPEN) {
        this.sockets.delete(socket);
        continue;
      }

      if (!this.alive.has(socket)) {
        // Missed the previous round trip, so the peer is gone even though the socket
        // still looks open. Closing gracefully would wait for a reply that never comes.
        socket.terminate();
        this.sockets.delete(socket);
        continue;
      }

      this.alive.delete(socket);
      socket.ping();
    }
  }
}
