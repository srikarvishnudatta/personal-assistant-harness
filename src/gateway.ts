import { timingSafeEqual } from "node:crypto";
import type { Env } from "./env.js";

const MAX_BODY_BYTES = 65536;
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  if (!env.HARNESS_TOKEN) return Response.json({ error: "Server authentication is not configured" }, { status: 503, headers });
  const supplied = request.headers.get("Authorization") ?? "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([supplied, `Bearer ${env.HARNESS_TOKEN}`].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  if (!timingSafeEqual(new Uint8Array(a), new Uint8Array(b))) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const route = url.pathname.slice(4);
  const allowed = (request.method === "GET" && ["/history", "/memories", "/schedules", "/tasks", "/events"].includes(route)) ||
    (request.method === "POST" && ["/chat", "/memories", "/schedules", "/tasks", "/dreams/apply"].includes(route)) ||
    (request.method === "DELETE" && /^\/(memories|schedules)\/[^/]+$/.test(route));
  if (!allowed) return Response.json({ error: "Not found" }, { status: 404, headers });
  let body: Uint8Array | undefined;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return Response.json({ error: "Request too large" }, { status: 413, headers });
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  }
  const internalUrl = new URL(request.url);
  internalUrl.pathname = route;
  const forwardedHeaders = new Headers({ "X-User-Id": "personal", "Content-Type": "application/json" });
  const forwarded = new Request(internalUrl, { method: request.method, headers: forwardedHeaders, body });
  try {
    const result = await env.ASSISTANTS.getByName("personal").fetch(forwarded);
    const response = new Response(result.body, result);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch {
    return Response.json({ error: "Assistant unavailable" }, { status: 503, headers });
  }
}
