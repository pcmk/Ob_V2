"""List every product + every variant (size / colour / ...) with its ASIN from an Amazon.in
store or listing page. Runs on YOUR PC (Amazon blocks cloud servers). Python 3.9+, stdlib only.

Usage:
  python amazon_store_variants.py "<store or search link>"            -> variants.csv
  python amazon_store_variants.py "<link>" -o mybrand.csv --prices     (also fetch each variant's price; slower)

Accepted links:
  - Brand store:   https://www.amazon.in/stores/<Brand>/page/<id>   (its sub-pages are followed too)
  - Search/brand:  https://www.amazon.in/s?k=...  or  ...&rh=p_89:<Brand>  or  ?me=<SellerID>
                   (follows up to --max-pages result pages)

Output columns: parent_asin, asin, title, <one column per variant dimension, e.g. Size, Colour>,
                price_inr (only with --prices), url

Notes:
  - Store pages load their product grid with JavaScript, so a script sees no products there.
    The script then reads the brand name from the store and uses Amazon's brand search
    (amazon.in/s?rh=p_89:<Brand>) instead, which lists the same brand's products as plain HTML.
  - Amazon changes its page code often; parsing is best-effort.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import html
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.amazon.in"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
GAP_SECONDS = (5, 10)
ASIN = r"[A-Z0-9]{10}"

_last = 0.0


class Blocked(Exception):
    pass


def fetch(url: str) -> str:
    """Polite GET (random pause between requests). Raises Blocked on a robot-check page."""
    global _last
    wait = random.uniform(*GAP_SECONDS) - (time.monotonic() - _last)
    if _last and wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9",
        "Accept": "text/html", "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            page = body.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 503:
            raise Blocked(url) from e
        raise
    finally:
        _last = time.monotonic()
    if "validateCaptcha" in page or "api-services-support@amazon.com" in page:
        raise Blocked(url)
    return page


# ------------------------------------------------------------------ listing / store pages

def asins_in_listing(page: str) -> list[str]:
    """ASINs of products shown on a store or search page, in page order."""
    found = []
    patterns = [
        rf'data-asin="({ASIN})"',
        rf'/dp/({ASIN})(?=[/?"&\\])',
        rf'"asin"\s*:\s*"({ASIN})"',
        rf'"ASIN"\s*:\s*"({ASIN})"',
    ]
    for pat in patterns:
        for m in re.finditer(pat, page):
            found.append((m.start(), m.group(1)))
    seen, out = set(), []
    for _, a in sorted(found):
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


def store_subpages(page: str, store_url: str) -> list[str]:
    """Links to other pages of the same brand store (e.g. 'Men', 'Women', 'T-shirts')."""
    path = urllib.parse.urlparse(store_url).path
    m = re.match(r"(/stores/[^/]+)", path)
    if not m:
        return []
    prefix = m.group(1)
    out = []
    for href in re.findall(r'href="(/stores/[^"#]+)"', page):
        href = html.unescape(href).split("?")[0]
        if href.startswith(prefix) and "/page/" in href and href not in out:
            out.append(href)
    # Store pages sometimes link to sub-pages only by page id inside JSON.
    for pid in re.findall(r'"pageId"\s*:\s*"([0-9A-F-]{36})"', page, re.I):
        href = f"{prefix}/page/{pid}"
        if href not in out:
            out.append(href)
    return [BASE + h for h in out]


def store_brand(page: str) -> str | None:
    m = re.search(r'"brandName"\s*:\s*"([^"]+)"', page)
    return html.unescape(m.group(1)).strip() if m else None


def brand_search_url(brand: str) -> str:
    return f"{BASE}/s?" + urllib.parse.urlencode({"rh": f"p_89:{brand}"})


def next_search_page(url: str, page_no: int) -> str:
    u = urllib.parse.urlparse(url)
    q = dict(urllib.parse.parse_qsl(u.query))
    q["page"] = str(page_no)
    return urllib.parse.urlunparse(u._replace(query=urllib.parse.urlencode(q)))


def collect_asins(start_url: str, max_pages: int) -> list[str]:
    url = start_url if start_url.startswith("http") else "https://" + start_url
    asins: list[str] = []

    def add(new):
        for a in new:
            if a not in asins:
                asins.append(a)

    if "/stores/" in url:
        queue, done, brand = [url], set(), None
        while queue and len(done) < max_pages:
            u = queue.pop(0)
            if u in done:
                continue
            done.add(u)
            page = fetch(u)
            brand = brand or store_brand(page)
            before = len(asins)
            add(asins_in_listing(page))
            print(f"  store page {len(done)}: +{len(asins) - before} products ({u})")
            if not asins and brand:
                break  # grid is loaded by JavaScript; no point reading more store pages
            for s in store_subpages(page, url):
                if s not in done and s not in queue:
                    queue.append(s)
        if not asins and brand:
            # Store pages load their product grid with JavaScript, so the HTML has no products.
            # Brand search results are plain HTML: use them instead.
            print(f"  store page has no product list in its HTML; using brand search for '{brand}'")
            return collect_asins(brand_search_url(brand), max_pages)
    else:
        for n in range(1, max_pages + 1):
            page = fetch(next_search_page(url, n) if n > 1 else url)
            before = len(asins)
            add(asins_in_listing(page))
            print(f"  results page {n}: +{len(asins) - before} products")
            if len(asins) == before or 's-pagination-next' not in page or \
                    'aria-disabled="true" class="s-pagination-item s-pagination-next' in page:
                break
    return asins


# ------------------------------------------------------------------ product page variants

def _json_after(page: str, key: str):
    """Parse the JSON object/array that follows  "key" :  in the page's inline scripts."""
    m = re.search(r'"%s"\s*:\s*' % re.escape(key), page)
    if not m:
        return None
    i = m.end()
    if i >= len(page) or page[i] not in "{[":
        return None
    open_ch, close_ch = page[i], "}" if page[i] == "{" else "]"
    depth, in_str, esc = 0, False, False
    for j in range(i, min(len(page), i + 2_000_000)):
        c = page[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(page[i:j + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _title(page: str) -> str | None:
    m = re.search(r'id="productTitle"[^>]*>(.*?)</span>', page, re.S)
    if not m:
        return None
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))).strip() or None


def _price(page: str) -> float | None:
    area = page
    for div in ("corePriceDisplay_desktop_feature_div", "corePrice_feature_div", "apex_desktop"):
        i = page.find(f'id="{div}"')
        if i >= 0:
            area = page[i:i + 6000]
            break
    m = re.search(r'class="a-price(?! a-text-price)[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', area)
    if not m:
        return None
    n = re.search(r"[\d,]+(?:\.\d+)?", m.group(1))
    return float(n.group(0).replace(",", "")) if n else None


_DIM_NAMES = {"size_name": "Size", "color_name": "Colour", "style_name": "Style",
              "pattern_name": "Pattern", "flavor_name": "Flavour", "item_package_quantity": "Pack",
              "configuration": "Configuration", "material_type": "Material"}


def variants_from_product(page: str, asin: str) -> dict:
    """{'parent': ..., 'title': ..., 'price': ..., 'dims': [...], 'children': {asin: [values]}}"""
    parent = None
    m = re.search(rf'"parentAsin"\s*:\s*"({ASIN})"', page)
    if m:
        parent = m.group(1)
    dims = _json_after(page, "dimensionsDisplay") or []
    if not dims:
        dims = [_DIM_NAMES.get(d, d) for d in (_json_after(page, "dimensions") or [])]
    children = _json_after(page, "dimensionValuesDisplayData") or {}
    if not children:
        # Fallback: colour-only products often have colorToAsin {"Black": {"asin": "..."}}
        c2a = _json_after(page, "colorToAsin") or {}
        children = {v["asin"]: [k] for k, v in c2a.items() if isinstance(v, dict) and v.get("asin")}
        if children and not dims:
            dims = ["Colour"]
    children = {a: (v if isinstance(v, list) else [v]) for a, v in children.items() if re.fullmatch(ASIN, a)}
    return {"parent": parent or asin, "title": _title(page), "price": _price(page),
            "dims": [str(d) for d in dims], "children": children}


# ------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", help="amazon.in store or search link (put it in quotes)")
    ap.add_argument("-o", "--out", default="variants.csv")
    ap.add_argument("--max-pages", type=int, default=20, help="store sub-pages / result pages to read")
    ap.add_argument("--prices", action="store_true", help="also open every variant to read its price")
    args = ap.parse_args()

    print("1) Reading product list ...")
    try:
        listing = collect_asins(args.url, args.max_pages)
    except Blocked as e:
        print(f"Amazon showed a robot check on {e}. Try again later.")
        return 2
    print(f"   {len(listing)} product(s) found")
    if not listing:
        print("   None found. Try the brand's search link instead of the store link.")
        return 1

    print("2) Reading variants from each product page ...")
    rows: list[dict] = []
    all_dims: list[str] = []
    covered: set[str] = set()   # ASINs already listed as a variant of something
    blocked = []
    for i, asin in enumerate(listing, 1):
        if asin in covered:
            continue
        try:
            info = variants_from_product(fetch(f"{BASE}/dp/{asin}"), asin)
        except Blocked:
            blocked.append(asin)
            print(f"   [{i}/{len(listing)}] {asin}: robot check, skipped")
            continue
        for d in info["dims"]:
            if d not in all_dims:
                all_dims.append(d)
        kids = info["children"] or {asin: []}
        print(f"   [{i}/{len(listing)}] {asin}: {len(kids)} variant(s)  {info['title'] or ''}"[:110])
        for child, values in kids.items():
            covered.add(child)
            row = {"parent_asin": info["parent"], "asin": child, "title": info["title"] or "",
                   "url": f"{BASE}/dp/{child}", "price_inr": info["price"] if child == asin else ""}
            for d, v in zip(info["dims"], values):
                row[d] = v
            rows.append(row)

    if args.prices:
        todo = [r for r in rows if r["price_inr"] in ("", None)]
        print(f"3) Reading prices for {len(todo)} variant(s) ...")
        for n, r in enumerate(todo, 1):
            try:
                r["price_inr"] = _price(fetch(r["url"])) or ""
            except Blocked:
                print(f"   {r['asin']}: robot check, price skipped")
            if n % 10 == 0:
                print(f"   {n}/{len(todo)}")

    cols = ["parent_asin", "asin", "title", *all_dims, "price_inr", "url"]
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:   # utf-8-sig: opens cleanly in Excel
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"\nDone: {len(rows)} row(s) from {len(listing)} listed product(s) -> {args.out}")
    if blocked:
        print(f"{len(blocked)} product(s) skipped by robot checks: {', '.join(blocked)}. Re-run later.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
