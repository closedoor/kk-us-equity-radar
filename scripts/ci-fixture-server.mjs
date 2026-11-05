import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDashboardSnapshot } from "../public/dashboard-state.js";
import { marketPulseReference } from "../market-pulse-reference.mjs";

// Browser QA uses recorded observations, never live upstream services or a
// production cache write. Failure scenarios inject their own API responses.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const recorded = JSON.parse(await readFile(path.join(root, "dashboard-cache.json"), "utf8"));
const sourceGeneratedAt = recorded.generatedAt;
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const headers = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

function healthyFixture() {
  const data = structuredClone(recorded);
  const now = new Date().toISOString();
  Object.assign(data, { generatedAt: now, cacheAgeMs: 0, cache: false, stale: false, refreshing: false, errors: [], publicationErrors: [] });
  for (const calendar of [data.calendarSync, data.calendarSchedule]) {
    if (!calendar) continue;
    calendar.updatedAt = now;
    for (const source of Object.values(calendar.sources || {})) source.error = null;
  }
  // Only remove historical transport errors. Never invent publication proof,
  // advance an observation month, or change a recorded market risk value.
  for (const source of Object.values(data.publicationSchedule?.sources || {})) {
    if (source?.period && source.publishedAt) source.error = null;
  }
  if (!isDashboardSnapshot(data)) throw new Error("Recorded browser fixture is not a complete dashboard snapshot");
  return data;
}
healthyFixture();

const server = http.createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { ...headers, allow: "GET, HEAD" });
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === "/api/market-pulse") {
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(marketPulseReference));
      return;
    }
    if (url.pathname === "/api/dashboard") {
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(healthyFixture()));
      return;
    }
    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.resolve(publicDir, `.${requested}`);
    if (!file.startsWith(`${publicDir}${path.sep}`)) {
      res.writeHead(403, headers);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { ...headers, "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : 500, headers);
    res.end("QA fixture request failed");
  }
});
server.listen(port, host, () => console.log(JSON.stringify({ mode: "recorded-fixture-only", url: `http://${host}:${server.address().port}`, sourceGeneratedAt, upstreamRequests: 0, cacheWrites: 0 })));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
