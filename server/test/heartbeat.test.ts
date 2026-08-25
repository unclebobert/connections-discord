import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_PING, HEARTBEAT_PONG, type ProgressRoom } from '../src/session';
import { progressRoom } from './helpers';

/**
 * Idle sockets were being dropped and reconnected, and every reconnect costs a Worker
 * request plus a Durable Object request. The auto-response keeps the connection alive
 * without waking the object, so it has to be registered — and stay registered across
 * hibernation, which is exactly when a silent connection is most likely to be dropped.
 */

describe('heartbeat auto-response', () => {
  it('is registered so pings never reach the message handler', async () => {
    await runInDurableObject(progressRoom('guild:heartbeat'), (_room: ProgressRoom, state) => {
      const pair = state.getWebSocketAutoResponse();

      expect(pair).not.toBeNull();
      expect(pair!.request).toBe(HEARTBEAT_PING);
      expect(pair!.response).toBe(HEARTBEAT_PONG);
    });
  });

  it('is re-registered after the object is evicted', async () => {
    const stub = progressRoom('guild:heartbeat-evict');

    await runInDurableObject(stub, (_room: ProgressRoom, state) => {
      expect(state.getWebSocketAutoResponse()).not.toBeNull();
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, (_room: ProgressRoom, state) => {
      // The constructor re-runs on wake. If registration ever moved out of it, idle
      // sockets would start dropping again the moment an object hibernated.
      const pair = state.getWebSocketAutoResponse();

      expect(pair).not.toBeNull();
      expect(pair!.request).toBe(HEARTBEAT_PING);
    });
  });

  it('answers a ping directly if one somehow reaches the handler', async () => {
    await runInDurableObject(progressRoom('guild:heartbeat-fallback'), async (room: ProgressRoom) => {
      const sent: string[] = [];
      const socket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;

      await room.webSocketMessage(socket, HEARTBEAT_PING);

      // Falling through silently would leave the client waiting for a reply it never
      // gets, which costs the reconnect the heartbeat exists to prevent.
      expect(sent).toEqual([HEARTBEAT_PONG]);
    });
  });
});
