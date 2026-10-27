import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ObserverReader,
  integer,
  requestError,
} from "./concept-system/observer-read.mjs";
const assets = fileURLToPath(new URL("../observer-ui/dist/", import.meta.url));
export async function startObserverServer({
  directory,
  port = 0,
  assetDirectory = assets,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("端口须为 0–65535");
  if (!fs.existsSync(path.join(assetDirectory, "index.html")))
    throw Error("观察页面尚未构建，请先运行 npm run build:observer");
  const reader = new ObserverReader(directory);
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const json = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const authority = `127.0.0.1:${server.address().port}`,
        origin = `http://${authority}`;
      if (
        req.headers.host !== authority ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw requestError("仅允许本机同源访问", 403);
      if (!["GET", "HEAD"].includes(req.method)) {
        res.setHeader("Allow", "GET, HEAD");
        throw requestError("观察页面仅提供只读查询", 405);
      }
      const url = new URL(req.url, origin),
        q = url.searchParams,
        number = (key, def, min = 0, max = Number.MAX_SAFE_INTEGER) =>
          integer(q.get(key), def, min, max);
      const text = (key, def = "") => {
        const value = q.get(key) ?? def;
        if (value.length > 300) throw requestError("查询内容过长");
        return value;
      };
      let out;
      if (url.pathname === "/api/overview") out = reader.overview();
      else if (url.pathname === "/api/collections") {
        const subject = text("subject");
        if (subject && !["fish", "user"].includes(subject))
          throw requestError("未知主体");
        out = reader.collections({
          page: number("page", 1, 1, 100000),
          limit: number("limit", 12, 1, 100),
          subject,
          query: text("query"),
        });
      } else if (url.pathname.startsWith("/api/collections/"))
        out = reader.collection(decodeURIComponent(url.pathname.slice(17)), {
          page: number("page", 1, 1, 100000),
          limit: number("limit", 30, 1, 100),
        });
      else if (url.pathname === "/api/decisions") {
        const stage = text("stage", "all");
        if (!["all", "pending", "committed"].includes(stage))
          throw requestError("未知决策状态");
        out = reader.decisions({
          before: number("before", Number.MAX_SAFE_INTEGER, 1),
          limit: number("limit", 15, 1, 100),
          stage,
          trace: text("trace"),
        });
      } else if (url.pathname.startsWith("/api/decisions/"))
        out = reader.decision(decodeURIComponent(url.pathname.slice(15)));
      else if (url.pathname === "/api/events")
        out = reader.events({
          trace_id: text("trace_id"),
          decision_id: text("decision_id"),
          after: number("after", 0),
          limit: number("limit", 50, 1, 200),
        });
      else if (url.pathname === "/api/versions")
        out = reader.versions(text("role", "persona"), {
          before: number("before", Number.MAX_SAFE_INTEGER, 1),
          limit: number("limit", 50, 1, 100),
        });
      else if (url.pathname === "/api/diff")
        out = reader.diff(text("role"), text("from"), text("to"));
      else if (url.pathname.startsWith("/api/evidence/"))
        out = reader.evidence(url.pathname.slice(14));
      else {
        const files = {
          "/": ["index.html", "text/html; charset=utf-8"],
          "/app.js": ["app.js", "text/javascript; charset=utf-8"],
          "/app.css": ["app.css", "text/css; charset=utf-8"],
        };
        const file = files[url.pathname];
        if (!file) throw requestError("页面不存在", 404);
        res.writeHead(200, { "Content-Type": file[1] });
        res.end(
          req.method === "HEAD"
            ? undefined
            : fs.readFileSync(path.join(assetDirectory, file[0])),
        );
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(200);
        res.end();
      } else json(200, out);
    } catch (e) {
      json(e.status ?? 503, {
        error: e.status
          ? e.message
          : "无法读取观察数据，请检查数据库和快照是否可用",
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
