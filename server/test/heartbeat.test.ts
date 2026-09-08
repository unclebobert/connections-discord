import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { SocketHeartbeat } from '../src/heartbeat.ts';

/**
 * Replaces the Durable Objects auto-response heartbeat. A server can send real
 * WebSocket protocol pings, which browsers answer without any client code — so the
 * application-level ping/pong protocol is gone entirely.
 */

type FakeSocket = {
  readyState: number;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  on: (event: string, listener: () => void) => void;
  emit: (event: string) => void;
};

function createFakeSocket(readyState = WebSocket.OPEN): FakeSocket {
  const listeners = new Map<string, Array<() => void>>();
  return {
    readyState,
    ping: vi.fn(),
    terminate: vi.fn(),
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

const track = (heartbeat: SocketHeartbeat, socket: FakeSocket) =>
  heartbeat.track(socket as unknown as WebSocket);

describe('SocketHeartbeat', () => {
  it('pings a socket that answered the previous round', () => {
    const heartbeat = new SocketHeartbeat(1000);
    const socket = createFakeSocket();
    track(heartbeat, socket);

    heartbeat.sweep();
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    socket.emit('pong');
    heartbeat.sweep();
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('terminates a socket that never answered', () => {
    const heartbeat = new SocketHeartbeat(1000);
    const socket = createFakeSocket();
    track(heartbeat, socket);

    // First sweep pings and clears the liveness mark.
    heartbeat.sweep();
    // Second sweep finds no pong in between: the peer is gone even though the socket
    // still looks open, so closing gracefully would wait for a reply that never comes.
    heartbeat.sweep();

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(heartbeat.size).toBe(0);
  });

  it('drops a socket that closed', () => {
    const heartbeat = new SocketHeartbeat(1000);
    const socket = createFakeSocket();
    track(heartbeat, socket);

    socket.emit('close');

    expect(heartbeat.size).toBe(0);
  });

  it('forgets a socket that is no longer open without pinging it', () => {
    const heartbeat = new SocketHeartbeat(1000);
    const socket = createFakeSocket(WebSocket.CLOSED);
    track(heartbeat, socket);

    heartbeat.sweep();

    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(heartbeat.size).toBe(0);
  });
});
