import { getEditorBridgeSession } from "@/lib/editor-agent/bridge-session";

export const runtime = "nodejs";

type Params = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  const session = getEditorBridgeSession(sessionId);

  if (!session) {
    return new Response("Editor bridge session not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: unknown, eventName: string) => {
        controller.enqueue(encoder.encode(
          `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`,
        ));
      };

      unsubscribe = session.subscribe((event) => {
        write(event, event.type);
        if (event.type === "closed") controller.close();
      });
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
