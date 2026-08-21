import { env } from 'cloudflare:workers';
import type { ProgressRoom } from '../src/session';

/**
 * The generated Env types PROGRESS_ROOMS as a bare DurableObjectNamespace, so stubs
 * come back opaque and runInDurableObject cannot see the instance type. Bindings in
 * src/env.ts carries the class, so re-apply it here rather than at every call site.
 */
export function progressRoom(name: string) {
  const namespace = env.PROGRESS_ROOMS as unknown as DurableObjectNamespace<ProgressRoom>;
  return namespace.getByName(name);
}

/**
 * Total rows billed since the last reset. `sqlUsage` is the production
 * instrumentation added to diagnose the Durable Objects quota; reusing it here means
 * the tests assert against exactly the counter Cloudflare bills from.
 */
export function rowsWritten(room: ProgressRoom) {
  let total = 0;
  for (const usage of room.sqlUsage.values()) {
    total += usage.rowsWritten;
  }
  return total;
}

export function rowsWrittenForPrefix(room: ProgressRoom, prefix: string) {
  let total = 0;
  for (const [site, usage] of room.sqlUsage) {
    if (site.startsWith(prefix)) {
      total += usage.rowsWritten;
    }
  }
  return total;
}

export function resetUsage(room: ProgressRoom) {
  room.sqlUsage.clear();
}

export const DATE = '2026-08-20';
export const SCOPE_ID = 'guild:111111111111111111';
export const CHANNEL_ID = '222222222222222222';

export const attachmentFor = (userId: string) => ({
  userId,
  scopeId: SCOPE_ID,
  channelId: CHANNEL_ID,
  date: DATE,
});
