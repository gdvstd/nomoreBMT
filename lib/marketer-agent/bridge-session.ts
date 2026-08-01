import type { MarketerAgentEvent } from "./types";

type BridgeEvent =
  | { type: "ready"; sessionId: string }
  | { type: "agent_event"; event: MarketerAgentEvent }
  | { type: "error"; message: string }
  | { type: "closed" };

type Listener = (event: BridgeEvent) => void;

export class MarketerBridgeSession {
  readonly id = crypto.randomUUID();
  readonly createdAt = Date.now();
  private readonly listeners = new Set<Listener>();
  private readonly queuedEvents: BridgeEvent[] = [];
  private closed = false;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener({ type: "ready", sessionId: this.id });
    for (const event of this.queuedEvents.splice(0)) listener(event);
    return () => this.listeners.delete(listener);
  }

  emit(event: BridgeEvent) {
    if (this.listeners.size === 0) {
      if (event.type !== "closed") this.queuedEvents.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  emitAgentEvent(event: MarketerAgentEvent) {
    this.emit({ type: "agent_event", event });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit({ type: "closed" });
    this.listeners.clear();
  }
}

// Next.js can compile route handlers into separate server bundles in dev.
// Keep the registry on globalThis so the POST creator and SSE consumer share
// the same session even when their module instances are not identical.
type MarketerBridgeGlobal = typeof globalThis & {
  __bmtMarketerBridgeSessions?: Map<string, MarketerBridgeSession>;
};

const bridgeGlobal = globalThis as MarketerBridgeGlobal;
const sessions = bridgeGlobal.__bmtMarketerBridgeSessions ??= new Map<string, MarketerBridgeSession>();

export function createMarketerBridgeSession() {
  const session = new MarketerBridgeSession();
  sessions.set(session.id, session);
  return session;
}

export function getMarketerBridgeSession(id: string) {
  return sessions.get(id);
}

export function deleteMarketerBridgeSession(id: string) {
  const session = sessions.get(id);
  session?.close();
  sessions.delete(id);
}
