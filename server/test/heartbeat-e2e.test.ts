import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { HEARTBEAT_PING, HEARTBEAT_PONG, type ProgressRoom } from '../src/session';
import { CHANNEL_ID, DATE, SCOPE_ID, progressRoom } from './helpers';

it('answers a ping over a live socket without waking the object', async () => {
  const stub = progressRoom('guild:heartbeat-e2e');

  const response = await stub.fetch('https://progress-room/', {
    headers: {
      Upgrade: 'websocket',
      'x-progress-user-id': '333333333333333333',
      'x-progress-scope-id': SCOPE_ID,
      'x-progress-channel-id': CHANNEL_ID,
      'x-progress-date': DATE,
      'x-progress-profile': encodeURIComponent(
        JSON.stringify({ displayName: 'Ada', avatarUrl: null }),
      ),
    },
  });

  expect(response.status).toBe(101);

  const client = response.webSocket!;
  client.accept();

  const replies: string[] = [];
  client.addEventListener('message', (event) => {
    replies.push(String(event.data));
  });

  let handlerCalls = 0;
  await runInDurableObject(stub, (room: ProgressRoom) => {
    const original = room.webSocketMessage.bind(room);
    room.webSocketMessage = (socket, message) => {
      handlerCalls += 1;
      return original(socket, message);
    };
  });

  client.send(HEARTBEAT_PING);
  await vi.waitFor(() => expect(replies).toContain(HEARTBEAT_PONG), { timeout: 3000 });

  // The whole point: the round trip is handled by the runtime. If this ever became a
  // handler invocation, every heartbeat would wake the object and the keepalive would
  // cost more than the reconnects it replaced.
  expect(handlerCalls).toBe(0);
});
