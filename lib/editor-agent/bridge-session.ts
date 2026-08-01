import type {
  EditorAgentEvent,
  EditorAgentMode,
  OpenPencilToolRequest,
  OpenPencilToolResult,
} from "./types";
import type { OpenPencilBridge } from "./types";

export type BridgeToolRequest = OpenPencilToolRequest & { requestId: string };

type BridgeEvent =
  | { type: "ready"; sessionId: string }
  | { type: "tool_call"; request: BridgeToolRequest }
  | { type: "agent_event"; event: EditorAgentEvent }
  | { type: "error"; message: string }
  | { type: "closed" };

type Listener = (event: BridgeEvent) => void;

type PendingCall = {
  resolve: (value: OpenPencilToolResult) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const TOOL_CALL_TIMEOUT_MS = 120_000;

export class EditorBridgeSession {
  readonly id = crypto.randomUUID();
  readonly createdAt = Date.now();
  mode: EditorAgentMode = "auto";
  private readonly listeners = new Set<Listener>();
  private readonly queuedEvents: BridgeEvent[] = [];
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener({ type: "ready", sessionId: this.id });
    for (const event of this.queuedEvents.splice(0)) listener(event);
    return () => this.listeners.delete(listener);
  }

  emit(event: BridgeEvent) {
    if (this.listeners.size === 0) {
      // The POST that starts a run and the SSE connection are separate HTTP
      // requests. Keep early tool calls until the browser has subscribed.
      if (event.type !== "closed") this.queuedEvents.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  emitAgentEvent(event: EditorAgentEvent) {
    this.emit({ type: "agent_event", event });
  }

  invoke(request: OpenPencilToolRequest): Promise<OpenPencilToolResult> {
    if (this.closed) return Promise.reject(new Error("Editor bridge session is closed"));
    if (this.mode === "review") {
      return Promise.reject(new Error("Editor agent is paused while the user is in review mode"));
    }

    const requestId = crypto.randomUUID();
    const toolRequest: BridgeToolRequest = { ...request, requestId };

    return new Promise<OpenPencilToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for browser tool: ${request.toolName}`));
      }, TOOL_CALL_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timeout });
      this.emit({ type: "tool_call", request: toolRequest });
    });
  }

  respond(requestId: string, response: OpenPencilToolResult) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(response);
    return true;
  }

  reject(requestId: string, message: string) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.reject(new Error(message));
    return true;
  }

  setMode(mode: EditorAgentMode) {
    this.mode = mode;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Editor bridge session closed"));
      this.pending.delete(requestId);
    }
    this.emit({ type: "closed" });
    this.listeners.clear();
  }
}

const sessions = new Map<string, EditorBridgeSession>();

export function createEditorBridgeSession() {
  const session = new EditorBridgeSession();
  sessions.set(session.id, session);
  return session;
}

export function getEditorBridgeSession(id: string) {
  return sessions.get(id);
}

export function deleteEditorBridgeSession(id: string) {
  const session = sessions.get(id);
  session?.close();
  sessions.delete(id);
}

export function createSessionBridge(session: EditorBridgeSession): OpenPencilBridge {
  return {
    invoke: (request) => session.invoke(request),
  };
}
