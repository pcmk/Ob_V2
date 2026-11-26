"""Daily Amazon.in price checker for your Google Sheet — runs on YOUR PC.

Why on your PC: Amazon blocks Google's (and other cloud) servers with a captcha.
Your home internet connection usually gets the normal product page.

Setup (once):
  1. In the sheet: Price Tracker → Set up PC access key, and deploy the Apps Script as a Web app.
  2. Next to this file create config.json:
        {"webapp_url": "https://script.google.com/macros/s/XXXX/exec", "key": "YOUR_KEY"}
  3. Test:  python pc_price_checker.py
  4. Schedule it daily (Windows Task Scheduler / macOS-Linux cron). See README.md.

Python 3.9+; standard library only. Writes a log to pc_price_checker.log.
"""

from __future__ import annotations

import gzip
import html
import json
import logging
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
GAP_SECONDS = (6, 12)          # random pause between products, to stay polite
RETRY_AFTER_BLOCK_SECONDS = 90  # one retry if Amazon shows a robot check

log = logging.getLogger("price")

# ------------------------------------------------------------------ Amazon page

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http(url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 30) -> str:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body.decode("utf-8", "replace")


def parse_inr(text: str | None) -> float | None:
    if not text:
        return None
    m = re.search(r"[\d,]+(?:\.\d+)?", text.replace("₹", " "))
    return float(m.group(0).replace(",", "")) if m else None


def is_blocked(page: str) -> bool:
    return any(s in page for s in ("validateCaptcha", "Enter the characters you see below",
                                   "api-services-support@amazon.com"))


def parse_product(page: str) -> dict:
    """Best-effort parse; Amazon changes its markup often, so fields may be None."""
    out = {"title": None, "price": None, "mrp": None}
    m = re.search(r'id="productTitle"[^>]*>(.*?)</span>', page, re.S)
    if m:
        out["title"] = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))).strip() or None
    area = page
    for div in ("corePriceDisplay_desktop_feature_div", "corePrice_feature_div",
                "corePrice_desktop", "apex_desktop"):
        i = page.find(f'id="{div}"')
        if i >= 0:
            area = page[i:i + 6000]
            break
    m = re.search(r'class="a-price(?! a-text-price)[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', area)
    if m:
        out["price"] = parse_inr(m.group(1))
    if out["price"] is None:
        m = re.search(r'class="a-price-whole">([\d,]+)', area)
        if m:
            out["price"] = parse_inr(m.group(1))
    m = re.search(r'class="a-price a-text-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', area)
    if m:
        out["mrp"] = parse_inr(m.group(1))
    return out


def check_product(asin: str) -> dict:
    url = f"https://www.amazon.in/dp/{asin}"
    headers = {"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9",
               "Accept": "text/html", "Accept-Encoding": "gzip"}
    for attempt in (1, 2):
        try:
            page = http(url, headers=headers)
        except urllib.error.HTTPError as e:
            if e.code == 503 and attempt == 1:
                time.sleep(RETRY_AFTER_BLOCK_SECONDS)
                continue
            return {"status": f"ERROR: HTTP {e.code}"}
        except urllib.error.URLError as e:
            return {"status": f"ERROR: {e.reason}"}
        if is_blocked(page):
            if attempt == 1:
                log.info("%s: robot check, retrying once in %ss", asin, RETRY_AFTER_BLOCK_SECONDS)
                time.sleep(RETRY_AFTER_BLOCK_SECONDS)
                continue
            return {"status": "BLOCKED (captcha, from PC)"}
        snap = parse_product(page)
        snap["status"] = "OK" if snap["price"] is not None else "NO PRICE FOUND"
        return snap
    return {"status": "BLOCKED (captcha, from PC)"}


# ------------------------------------------------------------------ Google Sheet (Apps Script web app)

def sheet_call(cfg: dict, payload: dict | None = None) -> dict:
    url = cfg["webapp_url"] + "?" + urllib.parse.urlencode({"key": cfg["key"]})
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    # Apps Script answers POST with a redirect to the result; urllib follows it as GET.
    text = http(url, data=data, headers=headers, timeout=120)
    try:
        res = json.loads(text)
    except json.JSONDecodeError:
        raise SystemExit("The Web app URL did not return JSON. Check webapp_url (must end in /exec) "
                         "and that access is set to 'Anyone'.\nFirst 200 chars: " + text[:200])
    if res.get("error"):
        raise SystemExit(f"Sheet refused the request: {res['error']} (check 'key' in config.json)")
    return res


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout),
                                  logging.FileHandler(HERE / "pc_price_checker.log", encoding="utf-8")])
    if not CONFIG.exists():
        print(f"Missing {CONFIG}. Create it with webapp_url and key (see top of this file).")
        return 1
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    items = sheet_call(cfg)["items"]
    log.info("Sheet has %d product(s) to check", len(items))
    results = []
    for n, it in enumerate(items):
        if n:
            time.sleep(random.uniform(*GAP_SECONDS))
        snap = check_product(it["asin"])
        log.info("row %s %s: %s %s", it["row"], it["asin"], snap["status"],
                 f"₹{snap['price']:,.0f}" if snap.get("price") else "")
        results.append({"row": it["row"], "asin": it["asin"], **snap})

    if results:
        res = sheet_call(cfg, {"results": results})
        log.info("Sheet updated: %s row(s), %s alert(s) sent", res.get("updated"), res.get("alerts"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
