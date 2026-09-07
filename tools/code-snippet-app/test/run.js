// End-to-end tests with a mock Claude endpoint. No network, no API key needed.
//   node test/run.js
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNIPPET = '<section class="tfs-root" aria-label="x"><h2 class="tfs-h">Hi</h2></section>\n<style>.tfs-root{width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw)}@media (min-width:768px){.tfs-h{font-size:2rem}}@media (prefers-reduced-motion: reduce){*{transition:none}}</style>\n<script>(function(){var root=document.querySelector(".tfs-root");if(!root)return;root.setAttribute("data-tfs-bound","1");})();<\/script>\n<!-- PREVIEW: One line. Two lines. -->';

// ---------- mock Claude ----------
const received = [];
let mode = "ok"; // ok | refusal | reject-fallbacks-once | error500
let rejectedOnce = false;
const mockClaude = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body);
    received.push({ headers: req.headers, body: json });
    if (mode === "error500") { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "boom" } })); }
    if (mode === "reject-fallbacks-once" && !rejectedOnce && req.headers["anthropic-beta"]) {
      rejectedOnce = true;
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "fallbacks: unsupported beta" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: "msg_1", model: json.model } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    if (mode === "refusal") {
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "x", explanation: "no" } }, usage: { output_tokens: 0 } });
    } else {
      const parts = ["```html\n", SNIPPET.slice(0, 40), SNIPPET.slice(40), "\n```"];
      for (const p of parts) ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } });
    }
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
});

// ---------- mock reference site ----------
const site = http.createServer((req, res) => {
  if (req.url === "/redirect") { res.writeHead(302, { location: "/" }); return res.end(); }
  if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF"); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Bombay Textile Co.</title><meta name="description" content="Handloom since 1962"><style>.hero{color:#1e3c78;background:#faf5f0;font-family:Georgia, serif}.x{color:#1e3c78}</style></head><body><h1>Wear the slower side</h1><h2 style="color:#c9860b">Handloom</h2><p>Every metre takes three days.</p><script>var secret = 1;</script></body></html>`);
});

function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }

function startApp(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "..", "server.js")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; const m = out.match(/localhost:(\d+)/); if (m) resolve({ child, port: Number(m[1]) }); });
    child.stderr.on("data", (d) => process.stderr.write("[app] " + d));
    child.on("exit", (c) => { if (!out) reject(new Error("app exited " + c)); });
  });
}

async function sse(port, payload, pw) {
  const res = await fetch(`http://127.0.0.1:${port}/api/generate`, { method: "POST", headers: { "content-type": "application/json", "x-app-password": pw || "" }, body: JSON.stringify(payload) });
  if (res.headers.get("content-type") !== "text/event-stream") return { status: res.status, json: await res.json() };
  const text = await res.text();
  const events = [];
  for (const frame of text.split("\n\n")) {
    const ev = (frame.match(/^event: (.*)$/m) || [])[1];
    const data = (frame.match(/^data: (.*)$/m) || [])[1];
    if (ev && data) events.push({ ev, data: JSON.parse(data) });
  }
  return { status: res.status, events };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

(async () => {
  const claudePort = await listen(mockClaude);
  const sitePort = await listen(site);
  const base = { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudePort}`, ALLOW_PRIVATE_URLS: "1", APP_PASSWORD: "pw", PORT: "0", CLAUDE_MODEL: "claude-opus-5" };
  const app = await startApp(base);
  const strict = await startApp({ ...base, ALLOW_PRIVATE_URLS: "", APP_PASSWORD: "" });
  const P = app.port, S = strict.port;

  test("config reports password + limits", async () => {
    const c = await (await fetch(`http://127.0.0.1:${P}/api/config`)).json();
    assert.equal(c.needsPassword, true); assert.equal(c.maxImages, 6); assert.equal(c.model, "claude-opus-5");
  });
  test("static page serves", async () => {
    const r = await fetch(`http://127.0.0.1:${P}/`); assert.equal(r.status, 200);
    assert.match(await r.text(), /Code Snippet Tool/);
    assert.equal((await fetch(`http://127.0.0.1:${P}/../server.js`)).status, 404);
  });
  test("password enforced", async () => {
    assert.equal((await sse(P, { brief: "x" }, "wrong")).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${P}/api/auth`, { method: "POST", headers: { "x-app-password": "pw" } })).status, 200);
  });
  test("empty brief rejected", async () => {
    const r = await sse(P, { brief: " " }, "pw"); assert.equal(r.status, 400);
  });
  test("generate: image + url + brief -> streamed snippet, fences stripped, prompt carries image and page data", async () => {
    received.length = 0; mode = "ok";
    const r = await sse(P, { brief: "A quiet band", widgetName: "THE FABRIC STORY", refNote: "our figma", images: [{ mediaType: "image/png", data: TINY_PNG }], urls: [`http://127.0.0.1:${sitePort}/redirect`, `http://127.0.0.1:${sitePort}/pdf`] }, "pw");
    const kinds = r.events.map((e) => e.ev);
    assert.ok(kinds.includes("ref") && kinds.includes("delta") && kinds.includes("done"), "events: " + kinds.join(","));
    const refs = r.events.filter((e) => e.ev === "ref").map((e) => e.data);
    assert.equal(refs[0].ok, true); assert.equal(refs[0].title, "Bombay Textile Co.");
    assert.equal(refs[1].ok, false); assert.match(refs[1].error, /not an HTML page/);
    const done = r.events.find((e) => e.ev === "done").data;
    assert.equal(done.text, SNIPPET, "server strips markdown fences");
    assert.equal(done.truncated, false); assert.equal(done.model, "claude-opus-5");
    assert.equal(received.length, 1);
    const body = received[0].body;
    assert.equal(body.model, "claude-opus-5"); assert.equal(body.stream, true);
    assert.equal(received[0].headers["x-api-key"], "test-key");
    assert.equal(received[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01"); assert.equal(body.fallbacks, "default");
    assert.equal(body.system[0].cache_control.type, "ephemeral");
    const content = body.messages[0].content;
    assert.equal(content[0].type, "image"); assert.equal(content[0].source.media_type, "image/png");
    const txt = content[1].text;
    assert.match(txt, /CSS class prefix, use verbatim including the trailing dash: tfs-/);
    assert.match(txt, /What they show, in the user's words: our figma/);
    assert.match(txt, /REFERENCE PAGE: http:\/\/127\.0\.0\.1:\d+\/redirect/);
    assert.match(txt, /Title: Bombay Textile Co\./);
    assert.match(txt, /Headings: Wear the slower side \| Handloom/);
    assert.match(txt, /Colours used in its CSS, most frequent first: #1e3c78, #faf5f0, #c9860b/);
    assert.match(txt, /Font stacks in its CSS: Georgia, serif/);
    assert.match(txt, /Visible text \(excerpt\): Wear the slower side Handloom Every metre takes three days\./);
    assert.doesNotMatch(txt, /secret/);
    assert.match(txt, /could not be fetched: not an HTML page/);
  });
  test("refine: previous code becomes an assistant turn", async () => {
    received.length = 0; mode = "ok";
    const r = await sse(P, { brief: "A quiet band", widgetName: "X", previousCode: "<section></section>", ask: "make it dark" }, "pw");
    assert.ok(r.events.some((e) => e.ev === "done"));
    const m = received[0].body.messages;
    assert.equal(m.length, 3); assert.equal(m[1].role, "assistant"); assert.equal(m[1].content, "<section></section>");
    assert.match(m[2].content, /^make it dark\n\nRewrite the complete snippet/);
  });
  test("refusal surfaces as error event", async () => {
    mode = "refusal";
    const r = await sse(P, { brief: "x" }, "pw");
    const err = r.events.find((e) => e.ev === "error");
    assert.ok(err); assert.match(err.data.error, /declined/);
  });
  test("fallbacks beta rejected -> retried once without it", async () => {
    mode = "reject-fallbacks-once"; rejectedOnce = false; received.length = 0;
    const r = await sse(P, { brief: "x" }, "pw");
    assert.ok(r.events.some((e) => e.ev === "done"));
    assert.equal(received.length, 2);
    assert.equal(received[1].headers["anthropic-beta"], undefined); assert.equal(received[1].body.fallbacks, undefined);
  });
  test("upstream 500 -> error event with message", async () => {
    mode = "error500";
    const r = await sse(P, { brief: "x" }, "pw");
    const err = r.events.find((e) => e.ev === "error"); assert.ok(err); assert.match(err.data.error, /boom/);
    mode = "ok";
  });
  test("SSRF: private/loopback links refused unless ALLOW_PRIVATE_URLS", async () => {
    const r = await sse(S, { brief: "x", urls: [`http://127.0.0.1:${sitePort}/`, "http://localhost/", "ftp://example.com/x", "not a url"] }, "");
    const refs = r.events.filter((e) => e.ev === "ref").map((e) => e.data);
    assert.equal(refs.length, 4);
    assert.match(refs[0].error, /private/); assert.match(refs[1].error, /private/);
    assert.match(refs[2].error, /only http/); assert.match(refs[3].error, /not a valid URL/);
    assert.ok(r.events.some((e) => e.ev === "done"));
  });
  test("image validation: bad media types dropped, cap applied", async () => {
    received.length = 0;
    const imgs = Array.from({ length: 9 }, () => ({ mediaType: "image/jpeg", data: TINY_PNG }));
    imgs.push({ mediaType: "image/svg+xml", data: TINY_PNG });
    await sse(P, { brief: "x", images: imgs }, "pw");
    const content = received[0].body.messages[0].content;
    assert.equal(content.filter((c) => c.type === "image").length, 6);
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok   " + t.name); }
    catch (e) { failed++; console.log("  FAIL " + t.name + "\n       " + (e && e.message)); }
  }
  app.child.kill(); strict.child.kill(); mockClaude.close(); site.close();
  console.log(failed ? `\n${failed} failing` : `\nall ${tests.length} passing`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
