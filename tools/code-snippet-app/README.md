# Shopdeck Code Snippet Tool (hosted)

One link the whole team can use. Brief + screenshot / screen recording + reference links + widget name in;
a paste-ready, audited `code_snippet_widget` section out.

Why hosted: the Claude Artifact version can't take images in every viewer and can't fetch links at all.
This version runs a tiny server with the company's Claude API key, so both work in any browser.

```
tools/code-snippet-app/
  server.js          Node 20+, zero dependencies. Serves the page and proxies to the Claude API.
  public/index.html  The tool.
  test/run.js        End-to-end tests against a mock Claude (no key needed): node test/run.js
```

## Run locally

```bash
cd tools/code-snippet-app
cp .env.example .env            # fill in ANTHROPIC_API_KEY and APP_PASSWORD
set -a; source .env; set +a     # or export the variables your own way
node server.js                  # http://localhost:3000
```

## Deploy (pick one)

**Render** (free tier, ~5 minutes)
1. Push this repo to GitHub. In Render: New → Web Service → connect the repo.
2. Root directory: `tools/code-snippet-app`. Runtime: Node. Build command: *(leave empty)*. Start command: `node server.js`.
3. Environment: add `ANTHROPIC_API_KEY` and `APP_PASSWORD`.
4. Deploy. Share the `https://<name>.onrender.com` URL and the password with the team.

**Railway / Fly.io / any Docker host**: the included `Dockerfile` works as-is. Set the same two env vars.

**Vercel**: not recommended. Generation streams for 20–90 s; Vercel serverless functions time out
on the Hobby plan.

## Settings

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Required. Create at console.anthropic.com. |
| `APP_PASSWORD` | – | Strongly recommended. Anyone with the link + password can spend on your key. |
| `CLAUDE_MODEL` | `claude-opus-5` | `claude-sonnet-5` is cheaper if quality holds for your briefs. |
| `CLAUDE_EFFORT` | `high` | `medium` cuts cost; `xhigh` for harder layouts. |
| `CLAUDE_FALLBACKS` | on | Server-side refusal fallbacks (beta). Set `off` to disable. If the API rejects the beta, the server retries once without it automatically. |
| `MAX_IMAGES` | `6` | Images per generate (screenshots + video frames). |
| `PORT` | `3000` | |

## Cost and abuse guard

- Each Generate is one Claude call. With Opus 5 a typical section (a few images, ~3K output tokens)
  is on the order of a few cents; check your Console usage after the first week.
- Built-in per-IP rate limit: 30 generates per 10 minutes.
- Reference links are fetched server-side with an SSRF guard (public hosts only, 12 s timeout, 2 MB cap,
  HTML only). Set `ALLOW_PRIVATE_URLS=1` only for local testing.

## What the tool sends to Claude

The system prompt is the Shopdeck snippet contract (self-contained, prefixed classes, full-bleed,
mobile-first, reduced-motion, no `opacity:0` parking, guarded IIFE, semantic markup, placeholders,
nothing clever). The user turn carries the images, then the brief, widget name, derived CSS prefix,
your one-line description of the images, and for each link: title, description, headings, the
page's most-used CSS colours and font stacks, and a text excerpt. Claude is told to treat all of it as
reference only and never copy another site's markup, brand or assets.

## Tests

```bash
node test/run.js
```

Runs the real server against a mock Claude endpoint and a mock reference site: streaming, fence
handling, image validation, link extraction, redirects, non-HTML links, SSRF refusal, password,
refusal stop reason, fallback-beta retry, upstream errors.
