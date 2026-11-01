#!/usr/bin/env node
/* MeowID 本地转发代理
 *
 * 为什么需要它：
 *   platform.meowid.net 的响应里没有 Access-Control-Allow-Origin（实测任何 Origin 都不放行），
 *   浏览器直连必被 CORS 拦截。所以由本地 node 转发。
 *
 * 额外好处：顺带托管 relink-workbench.html，让网页与 API 同源（127.0.0.1:8787），
 *          连跨域都不存在，网页里不用再填 base_url。
 *
 * 依赖：只用 node 内置模块，不需要 npm install。
 * 用法：node meowid-proxy.js
 *       然后浏览器打开 http://127.0.0.1:8787
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM = process.env.MEOWID_UPSTREAM || "https://platform.meowid.net";
const PAGE = path.join(__dirname, "relink-workbench.html");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Expose-Headers": "Content-Length,Content-Type",
  "Access-Control-Max-Age": "600",
};

// 转发时要丢掉的头（host/origin 必须换掉；accept-encoding 丢掉避免要解压）
const DROP = new Set(["host", "connection", "origin", "referer", "accept-encoding", "transfer-encoding", "content-length"]);

const server = http.createServer((req, res) => {
  // 1) 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 2) 健康检查
  if (req.url === "/health") {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // 3) 首页 → 托管 relink-workbench.html
  if (req.url === "/" || req.url === "/index.html") {
    fs.readFile(PAGE, (err, buf) => {
      if (err) {
        res.writeHead(500, { ...CORS, "Content-Type": "text/plain; charset=utf-8" });
        res.end("读不到 relink-workbench.html：" + err.message);
        return;
      }
      res.writeHead(200, { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(buf);
    });
    return;
  }

  // 4) 其余全部转发到 MeowID
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP.has(k.toLowerCase())) headers[k] = v;
  }
  console.log("[proxy]", req.method, req.url, "auth=" + (headers.authorization ? "yes" : "NO"));

  let target;
  try {
    target = new URL(UPSTREAM + req.url);
  } catch (e) {
    res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad url", detail: String(e.message) }));
    return;
  }

  const up = https.request(
    {
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upRes) => {
      const out = { ...CORS };
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (k.toLowerCase().startsWith("access-control-")) continue; // 用我们自己的
        out[k] = v;
      }
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    }
  );

  up.on("error", (e) => {
    console.error("[proxy error]", req.method, req.url, e.message);
    if (!res.headersSent) {
      res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "proxy upstream failed", detail: e.message }));
  });

  req.pipe(up);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("\n  端口 " + PORT + " 已被占用。换个端口：");
    console.error("    set PORT=8788 && node meowid-proxy.js");
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  MeowID 本地代理已启动");
  console.log("  ─────────────────────────────────────────────");
  console.log("  打开这个地址：  http://127.0.0.1:" + PORT);
  console.log("  转发规则：      /v1/*  →  " + UPSTREAM);
  console.log("  网页与 API 同源，base_url 会自动填好，不用手动改");
  console.log("");
  console.log("  停止：Ctrl + C");
  console.log("");
});
