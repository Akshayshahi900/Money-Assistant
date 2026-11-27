import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
// Node does not load .env automatically for `npm run dev`; Docker's env_file only
// covers container runs. Load the repository .env before importing modules that
// read CURRENT_DATE or the LLM provider configuration at startup.
const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, "../../.env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.error("Could not load .env:", e);
  }
}

const { openDb } = await import("./db");

const db = openDb();
const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

const { DEFAULT_TODAY } = await import("./dates");
const { handleChat, handleAction, loadState } = await import("./assistant");

const ctx = { db, today: DEFAULT_TODAY };
const sse = (reply: any, event: string, data: unknown) =>
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function ensureSession(id?: string) {
  const sid = id ?? randomUUID();
  db.prepare(
    "INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)",
  ).run(sid, new Date().toISOString());
  return sid;
}

app.get("/api/health", async () => ({ ok: true, today: ctx.today }));

// Refresh survival: replay the stored transcript (text + UI specs, confirmation status refreshed from DB).
app.get<{ Params: { sid: string } }>("/api/state/:sid", async (req) => ({
  messages: loadState(ctx, req.params.sid),
}));

// Chat over SSE: placeholder first (<1s target), then text + final UI, then done.
app.post<{ Body: { sessionId?: string; message: string } }>(
  "/api/chat",
  async (req, reply) => {
    const sid = ensureSession(req.body.sessionId);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const t0 = performance.now();
    let firstResponseMs: number | null = null;
    sse(reply, "session", { sessionId: sid });
    firstResponseMs = performance.now() - t0;
    sse(reply, "placeholder", {
      kind: "skeleton",
      ms: Math.round(performance.now() - t0),
    });
    try {
      const o = await handleChat(ctx, sid, req.body.message);
      sse(reply, "text", { text: o.text });
      sse(reply, "ui", o.ui);
      const completeUiMs = performance.now() - t0;
      console.info(
        JSON.stringify({
          event: "chat_latency",
          sessionId: sid,
          firstResponseMs,
          completeUiMs,
          via: o.via,
        }),
      );
      sse(reply, "done", {
        messageId: o.messageId,
        via: o.via,
        intent: o.intent,
        usage: o.usage ?? null,
        ms: Math.round(completeUiMs),
      });
    } catch (e) {
      console.error(e);
      sse(reply, "ui", {
        type: "notice",
        tone: "error",
        text: "Something went wrong. Please try again.",
      });
      const completeUiMs = performance.now() - t0;
      console.info(
        JSON.stringify({
          event: "chat_latency",
          sessionId: sid,
          firstResponseMs,
          completeUiMs,
          via: "error",
        }),
      );
      sse(reply, "done", { ms: Math.round(completeUiMs) });
    }
    reply.raw.end();
    return reply;
  },
);

// Structured UI actions (never free text). JSON in, JSON out.
app.post<{ Body: { sessionId: string; messageId: number; payload: unknown } }>(
  "/api/action",
  async (req) => {
    const sid = ensureSession(req.body.sessionId);
    return handleAction(ctx, sid, req.body.payload, req.body.messageId);
  },
);

// Serve the built frontend in production (single container).
const webDist = resolve(here, "../../web/dist");
if (existsSync(webDist)) await app.register(fstatic, { root: webDist });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`server on :${port}`);
