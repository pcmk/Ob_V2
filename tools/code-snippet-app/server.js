// Shopdeck Code Snippet Tool - hosted version.
// Zero dependencies: Node 20+ built-ins only. Talks to the Claude Messages API over raw HTTP.
//
// Env:
//   ANTHROPIC_API_KEY   required
//   APP_PASSWORD        optional; when set, every /api call must carry it (x-app-password header)
//   CLAUDE_MODEL        default claude-opus-5
//   CLAUDE_EFFORT       low | medium | high | xhigh | max   (default: high)
//   CLAUDE_FALLBACKS    "off" to disable server-side refusal fallbacks (default on)
//   MAX_IMAGES          default 6
//   PORT                default 3000
//   ANTHROPIC_BASE_URL  default https://api.anthropic.com (tests point this at a mock)
//   ALLOW_PRIVATE_URLS  "1" lets reference links resolve to private/loopback IPs (tests only)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const EFFORT = process.env.CLAUDE_EFFORT || "high";
const FALLBACKS_ON = (process.env.CLAUDE_FALLBACKS || "on").toLowerCase() !== "off";
const MAX_IMAGES = Math.max(1, Math.min(20, Number(process.env.MAX_IMAGES || 6)));
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_URLS === "1";
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_URLS = 5;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. The server will start but /api/generate will fail.");
}

// ---------------------------------------------------------------- prompt
const RULES = [
  "You write ONE paste-ready code snippet for a section of a Shopdeck storefront homepage.",
  "A human pastes your output verbatim into a single code field (Shopdeck widget type code_snippet_widget). There is no build step and no way to load anything else.",
  "",
  "OUTPUT FORMAT - obey exactly:",
  "- Raw code only. No prose, no explanation, no markdown code fences.",
  "- Exactly three parts, in this order: the section markup, then one <style> block, then one <script> block.",
  "- Then one final line, and nothing after it: <!-- PREVIEW: two sentences on how it looks on mobile and on desktop -->",
  "",
  "HARD RULES - every one of these is checked automatically after you answer:",
  "1. Self-contained. No external script, no <link> stylesheet, no @import, no Google Fonts, no CDN, no web font file. Use only device font stacks (e.g. Georgia, \"Times New Roman\", serif for an editorial serif; -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif for sans; or inherit to match the theme).",
  "2. Prefix EVERY class name and EVERY CSS custom property with the prefix given in the brief. Every value of every class attribute. Not one unprefixed class anywhere.",
  "3. Full-bleed the outer section so it escapes the theme's container: width:100vw; margin-left:calc(50% - 50vw); margin-right:calc(50% - 50vw); plus overflow hidden where a child could push the page sideways.",
  "4. Mobile-first CSS that serves both widths from one paste - a @media (min-width: ...) block for desktop, or fluid clamp() sizing that needs no breakpoint. There is no separate mobile version.",
  "5. Include an @media (prefers-reduced-motion: reduce) block that switches off every transition and animation and leaves all content visible.",
  "6. Never park content at opacity:0. If you animate a reveal, the CSS default state must be visible; the script arms the pre-reveal state only for elements currently below the fold, then reveals them with IntersectionObserver. If the script fails, the section must still show its text - never a blank band.",
  "7. The script is one IIFE. It queries only its own root class, begins with that lookup and 'if (!root) return;', and sets a prefixed data- attribute flag on the root so a second paste of the same blob cannot bind twice.",
  "8. Semantic markup: one <section> root, a real heading element, alt text on every image, loading=\"lazy\" on images, and an aria-label when the section has no visible heading.",
  "9. Any copy, colour, price or image URL the brief does not give you becomes an obvious placeholder such as REPLACE-hero.jpg or [SELLER NAME]. Never invent a brand fact, a price, a delivery promise, a phone number or a certification.",
  "10. No inline event handler attributes, no document.write, no eval, no fetch, no localStorage, no cookies.",
  "",
  "REFERENCE MATERIAL: the brief may include screenshots, screen-recording frames, and text extracted from reference web pages. Treat all of it as visual and structural reference only - layout, type scale, spacing rhythm, colour, imagery style, motion implied across frames. Do not copy another site's exact markup, brand name, copy or assets verbatim. Write an original Shopdeck-safe implementation inspired by what you see, and use REPLACE- placeholders for any image you cannot license.",
].join("\n");

function prefixFromName(name) {
  const words = String(name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let p = "";
  if (words.length >= 2) p = words.map((w) => w[0]).join("").slice(0, 4);
  else if (words.length === 1) p = words[0].slice(0, 3);
  if (!/^[a-z]/.test(p)) p = "sd" + p;
  return (p || "sd") + "-";
}

function briefText({ brief, widgetName, refNote, imageCount, refs }) {
  const lines = [
    "BRIEF",
    "Section goal: " + (String(brief || "").trim() || "(not stated - use placeholders)"),
    "Widget row name: " + (String(widgetName || "").trim() || "(none given - invent a short ALL-CAPS title)"),
    "CSS class prefix, use verbatim including the trailing dash: " + prefixFromName(widgetName),
    "Colours and type: take them from the brief, the reference images or the reference pages if given; otherwise use a neutral off-white ground, near-black ink, one restrained accent, and a device font stack.",
  ];
  if (imageCount) {
    lines.push("", "REFERENCE IMAGES", imageCount + " image(s) attached above, from a screenshot or screen recording.");
    if (refNote) lines.push("What they show, in the user's words: " + refNote);
  }
  for (const r of refs) {
    lines.push("", "REFERENCE PAGE: " + r.url);
    if (r.error) { lines.push("(could not be fetched: " + r.error + ")"); continue; }
    if (r.title) lines.push("Title: " + r.title);
    if (r.description) lines.push("Description: " + r.description);
    if (r.headings.length) lines.push("Headings: " + r.headings.join(" | "));
    if (r.colours.length) lines.push("Colours used in its CSS, most frequent first: " + r.colours.join(", "));
    if (r.fonts.length) lines.push("Font stacks in its CSS: " + r.fonts.join(" ; "));
    if (r.text) lines.push("Visible text (excerpt): " + r.text);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- reference URL fetch (SSRF-guarded)
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const low = ip.toLowerCase();
  return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80") || low.startsWith("::ffff:");
}

async function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE) return;
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("private host");
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error("host does not resolve");
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("private address");
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function topByCount(items, n) {
  const m = new Map();
  for (const i of items) m.set(i, (m.get(i) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

async function fetchReference(rawUrl) {
  const out = { url: rawUrl, title: "", description: "", headings: [], colours: [], fonts: [], text: "", error: "" };
  let url;
  try { url = new URL(rawUrl); } catch { out.error = "not a valid URL"; return out; }
  if (url.protocol !== "http:" && url.protocol !== "https:") { out.error = "only http(s) links"; return out; }
  try {
    let current = url, res = null;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublicHost(current.hostname);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: ctl.signal,
          headers: { "user-agent": "Mozilla/5.0 (compatible; ShopdeckSnippetTool/1.0)", accept: "text/html,*/*;q=0.5" },
        });
      } finally { clearTimeout(t); }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), current);
        continue;
      }
      break;
    }
    if (!res || !res.ok) { out.error = "HTTP " + (res ? res.status : "no response"); return out; }
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ct)) { out.error = "not an HTML page (" + ct.split(";")[0] + ")"; return out; }
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (size < 2 * 1024 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
    try { await reader.cancel(); } catch {}
    const html = Buffer.concat(chunks).toString("utf8");

    out.title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]).slice(0, 200);
    const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i);
    out.description = desc ? stripTags(desc[1]).slice(0, 300) : "";
    out.headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => stripTags(m[1])).filter(Boolean).slice(0, 15).map((h) => h.slice(0, 120));
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + "\n" + [...html.matchAll(/style=["']([^"']*)["']/gi)].map((m) => m[1]).join("\n");
    out.colours = topByCount((css.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) || []).map((c) => c.toLowerCase()).filter((c) => !["#fff", "#ffffff", "#000", "#000000"].includes(c)), 8);
    out.fonts = topByCount((css.match(/font-family\s*:\s*([^;}{]+)/gi) || []).map((f) => f.replace(/font-family\s*:\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 80)), 5);
    const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
    out.text = stripTags(body).slice(0, 2500);
  } catch (e) {
    out.error = e && e.name === "AbortError" ? "timed out" : (e && e.message) || "fetch failed";
  }
  return out;
}

// ---------------------------------------------------------------- Claude (raw Messages API, SSE)
function buildMessages({ brief, widgetName, refNote, images, refs, previousCode, ask }) {
  const content = [];
  for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  content.push({ type: "text", text: briefText({ brief, widgetName, refNote, imageCount: images.length, refs }) });
  const messages = [{ role: "user", content }];
  if (previousCode && ask) {
    messages.push({ role: "assistant", content: previousCode });
    messages.push({ role: "user", content: ask + "\n\nRewrite the complete snippet with that change. Same output format, same hard rules, nothing else in your reply." });
  }
  return messages;
}

async function streamClaude(messages, { onDelta, signal }) {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    stream: true,
    system: [{ type: "text", text: RULES, cache_control: { type: "ephemeral" } }],
    output_config: { effort: EFFORT },
    messages,
  };
  const headers = { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" };
  let useFallbacks = FALLBACKS_ON;

  for (let attempt = 0; attempt < 2; attempt++) {
    const h = { ...headers };
    const b = { ...body };
    if (useFallbacks) { h["anthropic-beta"] = "server-side-fallback-2026-07-01"; b.fallbacks = "default"; }
    const res = await fetch(BASE_URL + "/v1/messages", { method: "POST", headers: h, body: JSON.stringify(b), signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // If the fallbacks beta is the thing being rejected, retry once without it.
      if (useFallbacks && res.status === 400 && /fallback/i.test(errText)) { useFallbacks = false; continue; }
      const err = new Error(parseApiError(errText) || "Claude API error " + res.status);
      err.status = res.status;
      throw err;
    }
    return await consumeSse(res, onDelta);
  }
  throw new Error("Claude API request failed");
}

function stripFences(txt) {
  return String(txt == null ? "" : txt).trim().replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, "").replace(/\r?\n?```[ \t]*$/, "").trim();
}

function parseApiError(text) {
  try { const j = JSON.parse(text); return j && j.error && j.error.message; } catch { return ""; }
}

async function consumeSse(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", stopReason = null, stopDetails = null, servedBy = null;
  const handle = (evt) => {
    if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") { text += evt.delta.text; onDelta(evt.delta.text); }
    else if (evt.type === "message_start" && evt.message) servedBy = evt.message.model || null;
    else if (evt.type === "message_delta" && evt.delta) { stopReason = evt.delta.stop_reason || stopReason; stopDetails = evt.delta.stop_details || stopDetails; }
    else if (evt.type === "error") throw new Error((evt.error && evt.error.message) || "stream error");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        handle(evt);
      }
    }
  }
  return { text, stopReason, stopDetails, servedBy };
}

// ---------------------------------------------------------------- HTTP plumbing
const buckets = new Map(); // ip -> {count, reset}
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || b.reset < now) { b = { count: 0, reset: now + 10 * 60 * 1000 }; buckets.set(ip, b); }
  b.count++;
  return b.count > 30;
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  return (req.headers["x-app-password"] || "") === APP_PASSWORD;
}

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  return (event, data) => { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); };
}

function validateImages(images) {
  const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const out = [];
  for (const img of (Array.isArray(images) ? images : []).slice(0, MAX_IMAGES)) {
    if (!img || !ok.includes(img.mediaType) || typeof img.data !== "string" || !img.data) continue;
    if (img.data.length > 20 * 1024 * 1024 * 1.4) continue; // > ~20MB decoded
    out.push({ mediaType: img.mediaType, data: img.data.replace(/\s+/g, "") });
  }
  return out;
}

async function handleGenerate(req, res) {
  if (!authorized(req)) return send(res, 401, { error: "password required" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (rateLimited(ip)) return send(res, 429, { error: "Too many requests from this address. Try again in a few minutes." });
  if (!API_KEY) return send(res, 500, { error: "Server has no ANTHROPIC_API_KEY configured." });

  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const brief = String(body.brief || "").trim();
  if (!brief) return send(res, 400, { error: "Write the brief first." });
  const widgetName = String(body.widgetName || "").slice(0, 120);
  const refNote = String(body.refNote || "").slice(0, 500).trim();
  const images = validateImages(body.images);
  const urls = (Array.isArray(body.urls) ? body.urls : []).map((u) => String(u).trim()).filter(Boolean).slice(0, MAX_URLS);
  const previousCode = typeof body.previousCode === "string" ? body.previousCode.slice(0, 200000) : "";
  const ask = String(body.ask || "").slice(0, 4000).trim();

  const emit = sse(res);
  const ctl = new AbortController();
  req.on("close", () => ctl.abort());

  try {
    const refs = [];
    for (const u of urls) {
      emit("status", { text: "Reading " + u + " …" });
      const r = await fetchReference(u);
      refs.push(r);
      emit("ref", { url: u, ok: !r.error, title: r.title, error: r.error, colours: r.colours });
    }
    emit("status", { text: images.length ? "Claude is reading " + images.length + " image(s) and writing the section…" : "Claude is writing the section…" });
    const messages = buildMessages({ brief, widgetName, refNote, images, refs, previousCode, ask });
    const result = await streamClaude(messages, { onDelta: (t) => emit("delta", { text: t }), signal: ctl.signal });
    if (result.stopReason === "refusal") {
      emit("error", { error: "Claude declined this brief" + (result.stopDetails && result.stopDetails.explanation ? ": " + result.stopDetails.explanation : ".") });
    } else {
      emit("done", { text: stripFences(result.text), truncated: result.stopReason === "max_tokens", model: result.servedBy || MODEL });
    }
  } catch (e) {
    if (!ctl.signal.aborted) emit("error", { error: (e && e.message) || "generation failed" });
  }
  res.end();
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(here, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(path.join(here, "public"))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { needsPassword: !!APP_PASSWORD, model: MODEL, maxImages: MAX_IMAGES, maxUrls: MAX_URLS });
    }
    if (req.method === "POST" && url.pathname === "/api/auth") {
      return send(res, authorized(req) ? 200 : 401, { ok: authorized(req) });
    }
    if (req.method === "POST" && url.pathname === "/api/generate") return await handleGenerate(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "server error" });
    else res.end();
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log("Code Snippet Tool listening on http://localhost:" + server.address().port + " (model " + MODEL + (APP_PASSWORD ? ", password on" : ", no password") + ")"));
}
