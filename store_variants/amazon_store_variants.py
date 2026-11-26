"""List every product + every variant (size / colour / ...) with its ASIN from an Amazon.in
store or listing page. Runs on YOUR PC (Amazon blocks cloud servers). Python 3.9+, stdlib only.

Usage:
  Easiest: open this file in IDLE and press F5, then paste the link when asked.
  python amazon_store_variants.py "<store, search or product link>"     -> variants.csv
  python amazon_store_variants.py "<link>" -o mybrand.csv --fast        (skip opening every variant page)

Accepted links:
  - Product:       https://www.amazon.in/<name>/dp/<ASIN>   (that product's whole colour/size family)
  - Brand store:   https://www.amazon.in/stores/<Brand>/page/<id>   (its sub-pages are followed too)
  - Search/brand:  https://www.amazon.in/s?k=...  or  ...&rh=p_89:<Brand>  or  ?me=<SellerID>
                   (follows up to --max-pages result pages)

Output: one row per variant ASIN (every colour x size). Columns: parent_asin, asin, title, brand,
        <Size, Colour, ...>, price, MRP, discount %, availability, rating, review count,
        "About this item" bullets, description, main image, <one column per product attribute,
        e.g. Material composition, Fit type, Sleeve type, Collar style>, url, status

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
    m = re.search(rf"/(?:dp|gp/product)/({ASIN})", url)
    if m and "/stores/" not in url:
        return [m.group(1)]   # a single product link: its whole variant family is read in step 2
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


def _num(text: str | None) -> float | None:
    m = re.search(r"[\d,]+(?:\.\d+)?", text or "")
    try:
        return float(m.group(0).replace(",", "")) if m else None
    except ValueError:
        return None


def _price(page: str) -> float | None:
    """Selling price. Tries, in order: hidden price text, the big price digits, buy-box JSON."""
    areas = [a for a in (element_by_id(page, d) for d in (
        "corePriceDisplay_desktop_feature_div", "corePrice_feature_div", "apex_desktop",
        "corePrice_desktop", "apex_offerDisplay_desktop")) if a]
    for area in areas:
        for m in re.finditer(r'<span class="a-price(?! a-text-price)[^"]*"[^>]*>', area):
            nxt = area.find('class="a-price', m.end())
            block = area[m.end():nxt if nxt > 0 else m.end() + 800][:800]
            off = re.search(r'class="a-offscreen">([^<]*)', block)
            v = _num(off.group(1)) if off else None
            if v is None:
                whole = re.search(r'class="a-price-whole">([\d,]+)', block)
                frac = re.search(r'class="a-price-fraction">(\d+)', block)
                v = _num(whole.group(1)) if whole else None
                if v is not None and frac:
                    v += int(frac.group(1)) / 10 ** len(frac.group(1))
            if v:
                return v
        m = re.search(r'class="a-price-whole">([\d,]+)', area)
        if m and _num(m.group(1)):
            return _num(m.group(1))
    m = re.search(r'"priceAmount"\s*:\s*([\d.]+)', page)
    return float(m.group(1)) if m else None


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


# ------------------------------------------------------------------ full product details

def _text(fragment: str) -> str:
    t = re.sub(r"<(script|style)\b.*?</\1>", " ", fragment, flags=re.S | re.I)
    t = re.sub(r"<br\s*/?>|</(p|li|div|tr)>", "\n", t, flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    t = t.replace("\u200e", "").replace("\u200f", "")
    lines = [re.sub(r"[ \t\xa0]+", " ", x).strip() for x in t.split("\n")]
    return "\n".join(x for x in lines if x)


def element_by_id(page: str, el_id: str) -> str | None:
    """Inner HTML of the element with this id (handles nesting of the same tag)."""
    m = re.search(r'<([a-zA-Z0-9]+)\b[^>]*\bid="%s"[^>]*>' % re.escape(el_id), page)
    if not m:
        return None
    tag, start = m.group(1).lower(), m.end()
    tok = re.compile(r"<(/?)%s\b[^>]*?(/?)>" % tag, re.I)
    depth = 1
    for t in tok.finditer(page, start):
        if t.group(1):
            depth -= 1
            if depth == 0:
                return page[start:t.start()]
        elif not t.group(2):
            depth += 1
    return page[start:start + 20000]


_ATTR_SECTIONS = ["productOverview_feature_div", "poExpander", "productFactsDesktopExpander",
                  "productFactsDesktop_feature_div", "productDetails_feature_div",
                  "productDetails_techSpec_section_1", "productDetails_techSpec_section_2",
                  "productDetails_detailBullets_sections1", "detailBullets_feature_div",
                  "prodDetails", "technicalSpecifications_feature_div"]
_SKIP_ATTRS = {"customer reviews", "best sellers rank", "asin"}


def attributes(page: str) -> dict[str, str]:
    """Key/value attributes from the product overview, product facts and details tables."""
    out: dict[str, str] = {}

    def put(k: str, v: str):
        k = _text(k).replace("\n", " ").strip().rstrip(":").strip()
        v = _text(v).replace("\n", " ").strip()
        if k and v and len(k) <= 60 and k.lower() not in _SKIP_ATTRS and k not in out:
            out[k] = v[:500]

    for sec_id in _ATTR_SECTIONS:
        sec = element_by_id(page, sec_id)
        if not sec:
            continue
        # tables:  <tr><th|td>Key</th|td><td>Value</td></tr>
        for row in re.findall(r"<tr\b.*?</tr>", sec, re.S | re.I):
            cells = re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", row, re.S | re.I)
            if len(cells) >= 2:
                put(cells[0], cells[1])
        # detail bullets:  <span class="a-text-bold">Key : </span> <span>Value</span>
        for k, v in re.findall(r'<span class="a-text-bold">(.*?)</span>\s*<span[^>]*>(.*?)</span>', sec, re.S):
            put(k, v)
        # fashion "product facts" grid: left column key, right column value
        for k, v in re.findall(r'a-col-left[^>]*>(.*?)</div>\s*<div[^>]*a-col-right[^>]*>(.*?)</div>', sec, re.S):
            put(k, v)
    return out


def product_details(page: str) -> dict:
    d: dict = {"title": _title(page), "price_inr": _price(page)}
    area = element_by_id(page, "corePriceDisplay_desktop_feature_div") or \
        element_by_id(page, "corePrice_feature_div") or ""
    m = re.search(r'class="a-price a-text-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', area)
    mrp = _num(m.group(1)) if m else None
    d["mrp_inr"] = mrp or None
    if d["price_inr"] and mrp and mrp > d["price_inr"]:
        d["discount_pct"] = round(100 * (mrp - d["price_inr"]) / mrp)
    by = element_by_id(page, "bylineInfo")
    if by:
        b = _text(by)
        d["brand"] = re.sub(r"^(Visit the |Brand:\s*)|\s+Store$", "", b).strip()
    m = re.search(r"([0-5](?:\.\d)?) out of 5 stars", page)
    d["rating"] = float(m.group(1)) if m else None
    rc = element_by_id(page, "acrCustomerReviewText")
    m = re.search(r"[\d,]+", _text(rc)) if rc else None
    d["review_count"] = int(m.group(0).replace(",", "")) if m else None
    av = element_by_id(page, "availability")
    d["availability"] = _text(av).replace("\n", " ")[:120] if av else None
    if not d["availability"]:
        if 'id="outOfStock"' in page or "Currently unavailable" in page:
            d["availability"] = "Currently unavailable"
        elif d["price_inr"] and ('id="add-to-cart-button"' in page or 'id="buy-now-button"' in page):
            d["availability"] = "In stock (has Add to Cart)"
    fb = element_by_id(page, "feature-bullets") or element_by_id(page, "productFactsDesktopExpander") or ""
    bullets = [_text(x).replace("\n", " ") for x in
               re.findall(r'<span class="a-list-item[^"]*"[^>]*>(.*?)</span>\s*</li>', fb, re.S)]
    d["about_this_item"] = " | ".join(b for b in bullets if b)
    desc = element_by_id(page, "productDescription")
    d["description"] = _text(desc).replace("\n", " ")[:3000] if desc else ""
    m = re.search(r'"hiRes"\s*:\s*"(https://[^"]+)"', page) or \
        re.search(r'id="landingImage"[^>]*data-old-hires="(https://[^"]+)"', page)
    d["main_image"] = m.group(1) if m else ""
    d["attributes"] = attributes(page)
    return d


# ------------------------------------------------------------------ main

BASE_COLS = ["parent_asin", "asin", "is_listed_asin", "title", "brand"]
DETAIL_COLS = ["price_inr", "mrp_inr", "discount_pct", "availability", "rating", "review_count",
               "about_this_item", "description", "main_image", "url", "status"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", nargs="?", help="amazon.in store, search or product link (put it in quotes)")
    ap.add_argument("-o", "--out", default=None, help="CSV file (default: variants.csv next to this script)")
    ap.add_argument("--max-pages", type=int, default=20, help="store sub-pages / result pages to read")
    ap.add_argument("--save-html", action="store_true",
                    help="also save each fetched page into a 'pages' folder (to debug empty columns)")
    ap.add_argument("--fast", action="store_true",
                    help="don't open every variant: siblings get the family's description/attributes "
                         "but no own price/stock (much faster)")
    args = ap.parse_args()
    if not args.url:  # e.g. started with F5 in IDLE or by double-click: ask for the link
        args.url = input("Paste the amazon.in product / store / search link and press Enter:\n> ").strip().strip('"')
        if not args.url:
            print("No link given.")
            return 1
        if input("Fast mode (skip opening every variant page)? y/N: ").strip().lower() == "y":
            args.fast = True
    from pathlib import Path
    if not args.out:
        args.out = str(Path(__file__).resolve().parent / "variants.csv")
    if args.save_html:
        global fetch
        _plain_fetch, folder = fetch, Path(args.out).resolve().parent / "pages"
        folder.mkdir(exist_ok=True)

        def fetch(url: str) -> str:  # noqa: F811 - wraps the original to keep a copy
            page = _plain_fetch(url)
            name = re.sub(r"[^A-Za-z0-9]+", "_", url.replace(BASE, ""))[:80] or "page"
            (folder / f"{name}.html").write_text(page, encoding="utf-8")
            return page

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

    print("2) Reading each product family (all colours x sizes) ...")
    rows: list[dict] = []
    dims_all: list[str] = []
    attrs_all: list[str] = []
    covered: set[str] = set()
    blocked: list[str] = []

    def add_attrs(det: dict, row: dict):
        for k, v in det.get("attributes", {}).items():
            if k not in attrs_all:
                attrs_all.append(k)
            row[k] = v

    for i, asin in enumerate(listing, 1):
        if asin in covered:
            continue
        try:
            page = fetch(f"{BASE}/dp/{asin}")
        except Blocked:
            blocked.append(asin)
            print(f"   [{i}/{len(listing)}] {asin}: robot check, skipped")
            continue
        fam = variants_from_product(page, asin)
        base = product_details(page)
        for d in fam["dims"]:
            if d not in dims_all:
                dims_all.append(d)
        kids = fam["children"] or {asin: []}
        print(f"   [{i}/{len(listing)}] {asin}: {len(kids)} variant(s)  {base['title'] or ''}"[:110])
        for n, (child, values) in enumerate(kids.items(), 1):
            covered.add(child)
            row = {"parent_asin": fam["parent"], "asin": child, "is_listed_asin": "yes" if child == asin else "",
                   "url": f"{BASE}/dp/{child}"}
            for d, v in zip(fam["dims"], values):
                row[d] = v
            det, status = base, "OK"
            if child != asin:
                if args.fast:
                    det, status = {k: base.get(k) for k in ("title", "brand", "about_this_item",
                                                            "description", "attributes")}, "FAMILY DATA ONLY"
                else:
                    try:
                        det = product_details(fetch(row["url"]))
                    except Blocked:
                        det, status = {k: base.get(k) for k in ("title", "brand")}, "BLOCKED (robot check)"
                        blocked.append(child)
                    print(f"      variant {n}/{len(kids)} {child} {' / '.join(map(str, values))}: {status}")
            for k in ("title", "brand", *DETAIL_COLS):
                if k in det and det[k] is not None and k not in ("url",):
                    row[k] = det[k]
            row["status"] = status
            add_attrs(det, row)
            rows.append(row)

    cols = [*BASE_COLS, *dims_all, *DETAIL_COLS[:-2], *attrs_all, "url", "status"]
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:   # utf-8-sig: opens cleanly in Excel
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"\nDone: {len(rows)} variant row(s) from {len(listing)} listed product(s) -> {args.out}")
    if blocked:
        print(f"{len(blocked)} page(s) hit robot checks: {', '.join(blocked[:20])}. Re-run later for those.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
