"""Core logic for the Amazon.in shopping MCP: storage, ASIN parsing, price sources.

No dependency on the `mcp` package, so it can be tested on its own.
Standard library only.
"""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import hmac
import html
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

MARKETPLACE_HOST = "www.amazon.in"
BASE_URL = f"https://{MARKETPLACE_HOST}"

# ---------------------------------------------------------------- ASIN helpers

_ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
_URL_ASIN_RE = re.compile(
    r"/(?:dp|gp/product|gp/aw/d|o/ASIN|exec/obidos/ASIN)/([A-Z0-9]{10})(?:[/?#]|$)",
    re.IGNORECASE,
)
_SHORT_HOSTS = {"amzn.in", "amzn.to", "a.co", "amzn.eu"}


class ShoppingError(Exception):
    """Error with a message meant for the end user."""


def extract_asin(url_or_asin: str) -> str | None:
    """Return the ASIN from a product URL or bare ASIN, else None."""
    s = url_or_asin.strip()
    if _ASIN_RE.match(s.upper()) and not s.lower().startswith("http"):
        return s.upper()
    m = _URL_ASIN_RE.search(s)
    return m.group(1).upper() if m else None


def is_short_link(url: str) -> bool:
    host = urllib.parse.urlparse(url.strip()).hostname or ""
    return host.lower().removeprefix("www.") in _SHORT_HOSTS


def product_url(asin: str) -> str:
    return f"{BASE_URL}/dp/{asin}"


def search_url(query: str) -> str:
    return f"{BASE_URL}/s?k={urllib.parse.quote_plus(query)}"


def add_to_cart_url(asins: list[str], qty: int = 1) -> str:
    """Amazon 'cart add' link. You still review and check out on Amazon yourself.
    Format follows Amazon's documented add-to-cart form (may change: not guaranteed)."""
    params = {}
    for i, a in enumerate(asins, start=1):
        params[f"ASIN.{i}"] = a
        params[f"Quantity.{i}"] = str(qty)
    return f"{BASE_URL}/gp/aws/cart/add.html?{urllib.parse.urlencode(params)}"


# ---------------------------------------------------------------- data model

@dataclass
class Snapshot:
    asin: str
    title: str | None = None
    price: float | None = None  # INR
    mrp: float | None = None  # list price / "M.R.P." in INR
    in_stock: bool | None = None
    rating: float | None = None
    review_count: int | None = None
    url: str | None = None
    source: str = "manual"  # manual | paapi | page

    def to_dict(self) -> dict:
        d = asdict(self)
        if self.price and self.mrp and self.mrp > self.price:
            d["discount_pct"] = round(100 * (self.mrp - self.price) / self.mrp, 1)
        return d


# ---------------------------------------------------------------- storage

def default_db_path() -> Path:
    return Path(os.environ.get("AMAZON_MCP_DB", Path.home() / ".amazon_in_mcp" / "shop.db"))


def _locked(fn):
    def wrapper(self, *a, **kw):
        with self.lock:
            return fn(self, *a, **kw)
    wrapper.__name__, wrapper.__doc__ = fn.__name__, fn.__doc__
    return wrapper


class Store:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path else default_db_path()
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        # MCP servers run sync tools in worker threads: share one connection behind a lock.
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.lock = threading.RLock()
        self.db.row_factory = sqlite3.Row
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
                asin TEXT PRIMARY KEY,
                title TEXT,
                target_price REAL,
                notes TEXT,
                added_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS prices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asin TEXT NOT NULL,
                price REAL,
                mrp REAL,
                in_stock INTEGER,
                rating REAL,
                review_count INTEGER,
                source TEXT,
                ts TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prices_asin_ts ON prices(asin, ts);
            CREATE TABLE IF NOT EXISTS alerts (
                asin TEXT PRIMARY KEY,
                price REAL NOT NULL,
                ts TEXT NOT NULL
            );
            """
        )
        self.db.commit()

    @staticmethod
    def _now() -> str:
        return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    # items
    @_locked
    def upsert_item(self, asin: str, title: str | None = None,
                    target_price: float | None = None, notes: str | None = None) -> None:
        row = self.get_item(asin)
        if row is None:
            self.db.execute(
                "INSERT INTO items(asin, title, target_price, notes, added_at) VALUES (?,?,?,?,?)",
                (asin, title, target_price, notes, self._now()),
            )
        else:
            self.db.execute(
                "UPDATE items SET title=COALESCE(?, title), target_price=COALESCE(?, target_price),"
                " notes=COALESCE(?, notes) WHERE asin=?",
                (title, target_price, notes, asin),
            )
        self.db.commit()

    @_locked
    def get_item(self, asin: str) -> dict | None:
        r = self.db.execute("SELECT * FROM items WHERE asin=?", (asin,)).fetchone()
        return dict(r) if r else None

    @_locked
    def list_items(self) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT * FROM items ORDER BY added_at")]

    @_locked
    def delete_item(self, asin: str, keep_history: bool = False) -> bool:
        cur = self.db.execute("DELETE FROM items WHERE asin=?", (asin,))
        if not keep_history:
            self.db.execute("DELETE FROM prices WHERE asin=?", (asin,))
        self.db.execute("DELETE FROM alerts WHERE asin=?", (asin,))
        self.db.commit()
        return cur.rowcount > 0

    # prices
    @_locked
    def add_snapshot(self, s: Snapshot) -> None:
        self.db.execute(
            "INSERT INTO prices(asin, price, mrp, in_stock, rating, review_count, source, ts)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (s.asin, s.price, s.mrp, None if s.in_stock is None else int(s.in_stock),
             s.rating, s.review_count, s.source, self._now()),
        )
        if s.title:
            self.db.execute("UPDATE items SET title=COALESCE(title, ?) WHERE asin=?", (s.title, s.asin))
        self.db.commit()

    @_locked
    def history(self, asin: str, limit: int = 100) -> list[dict]:
        rows = self.db.execute(
            "SELECT price, mrp, in_stock, rating, review_count, source, ts FROM prices"
            " WHERE asin=? ORDER BY ts DESC, id DESC LIMIT ?", (asin, limit),
        )
        return [dict(r) for r in rows]

    def latest(self, asin: str) -> dict | None:
        h = self.history(asin, 1)
        return h[0] if h else None

    # alerts (last price we sent a WhatsApp alert at, to avoid repeats)
    @_locked
    def last_alert_price(self, asin: str) -> float | None:
        r = self.db.execute("SELECT price FROM alerts WHERE asin=?", (asin,)).fetchone()
        return r["price"] if r else None

    @_locked
    def record_alert(self, asin: str, price: float) -> None:
        self.db.execute("INSERT OR REPLACE INTO alerts(asin, price, ts) VALUES (?,?,?)",
                        (asin, price, self._now()))
        self.db.commit()

    @_locked
    def clear_alert(self, asin: str) -> None:
        self.db.execute("DELETE FROM alerts WHERE asin=?", (asin,))
        self.db.commit()

    @_locked
    def stats(self, asin: str) -> dict:
        r = self.db.execute(
            "SELECT MIN(price) lo, MAX(price) hi, AVG(price) avg, COUNT(price) n FROM prices"
            " WHERE asin=? AND price IS NOT NULL", (asin,),
        ).fetchone()
        return {"lowest": r["lo"], "highest": r["hi"],
                "average": round(r["avg"], 2) if r["avg"] is not None else None,
                "observations": r["n"]}


# ---------------------------------------------------------------- page parsing

_PRICE_NUM_RE = re.compile(r"[\d,]+(?:\.\d+)?")


def parse_inr(text: str | None) -> float | None:
    if not text:
        return None
    m = _PRICE_NUM_RE.search(text.replace("₹", " "))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def _section(page: str, div_id: str, length: int = 6000) -> str | None:
    i = page.find(f'id="{div_id}"')
    return page[i:i + length] if i >= 0 else None


def is_blocked_page(page: str) -> bool:
    markers = ("validateCaptcha", "Enter the characters you see below",
               "api-services-support@amazon.com")
    return any(m in page for m in markers)


def parse_product_page(page: str, asin: str) -> Snapshot:
    """Best-effort parse of an amazon.in product page. Amazon changes its markup
    often, so any field may come back None."""
    snap = Snapshot(asin=asin, url=product_url(asin), source="page")

    m = re.search(r'id="productTitle"[^>]*>(.*?)</span>', page, re.S)
    if m:
        snap.title = _clean(m.group(1)) or None

    # Buy-box price: look inside the core price blocks first, then fall back.
    price_area = None
    for div in ("corePriceDisplay_desktop_feature_div", "corePrice_feature_div",
                "corePrice_desktop", "apex_desktop"):
        price_area = _section(page, div)
        if price_area:
            break
    area = price_area or page
    m = re.search(r'class="a-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', area)
    if m and "a-text-price" not in area[max(0, m.start() - 5):m.start() + 40]:
        snap.price = parse_inr(m.group(1))
    if snap.price is None:
        m = re.search(r'class="a-price-whole">([\d,]+)', area)
        if m:
            snap.price = parse_inr(m.group(1))

    m = re.search(r'class="a-price a-text-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', area)
    if m:
        snap.mrp = parse_inr(m.group(1))

    m = re.search(r"([0-5](?:\.\d)?) out of 5 stars", page)
    if m:
        snap.rating = float(m.group(1))
    m = re.search(r'id="acrCustomerReviewText"[^>]*>\s*([\d,]+)', page)
    if m:
        snap.review_count = int(m.group(1).replace(",", ""))

    avail = _section(page, "availability", 1500)
    if avail:
        t = _clean(avail.split("</div>", 1)[0]).lower()
        if "unavailable" in t or "out of stock" in t:
            snap.in_stock = False
        elif "in stock" in t or "left in stock" in t or "usually dispatched" in t:
            snap.in_stock = True
    if snap.in_stock is None and snap.price is not None:
        snap.in_stock = True
    return snap


# ---------------------------------------------------------------- page fetch (opt-in)

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_MIN_GAP_S = float(os.environ.get("AMAZON_FETCH_MIN_GAP_SECONDS", "5"))
_last_fetch = 0.0


def page_fetch_enabled() -> bool:
    return os.environ.get("AMAZON_ALLOW_PAGE_FETCH", "").strip() in {"1", "true", "yes"}


def _http_get(url: str) -> tuple[str, str]:
    """GET with a polite minimum gap between requests. Returns (final_url, body)."""
    global _last_fetch
    wait = _MIN_GAP_S - (time.monotonic() - _last_fetch)
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA, "Accept-Language": "en-IN,en;q=0.9",
        "Accept": "text/html", "Accept-Encoding": "gzip",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            return r.geturl(), body.decode("utf-8", "replace")
    finally:
        _last_fetch = time.monotonic()


def resolve_short_link(url: str) -> str | None:
    if not page_fetch_enabled():
        raise ShoppingError("Short links (amzn.in/...) need AMAZON_ALLOW_PAGE_FETCH=1 to resolve. "
                            "Paste the full amazon.in/dp/... link or the ASIN instead.")
    final, _ = _http_get(url)
    return extract_asin(final)


def fetch_page_snapshot(asin: str) -> Snapshot:
    _, page = _http_get(product_url(asin))
    if is_blocked_page(page):
        raise ShoppingError("Amazon returned a captcha/robot check. Try later, or record the price manually.")
    return parse_product_page(page, asin)


# ---------------------------------------------------------------- PA-API 5.0 (optional)

class PAAPI:
    """Minimal Product Advertising API 5.0 client for amazon.in (SigV4, stdlib only).

    Needs env: AMAZON_PAAPI_ACCESS_KEY, AMAZON_PAAPI_SECRET_KEY, AMAZON_PAAPI_PARTNER_TAG.
    Note: Amazon may be migrating PA-API to a newer API; verify before relying on it.
    """

    HOST = "webservices.amazon.in"
    REGION = "eu-west-1"
    SERVICE = "ProductAdvertisingAPI"
    RESOURCES = [
        "ItemInfo.Title",
        "Offers.Listings.Price",
        "Offers.Listings.SavingBasis",
        "Offers.Listings.Availability.Message",
    ]

    def __init__(self, access_key: str, secret_key: str, partner_tag: str):
        self.ak, self.sk, self.tag = access_key, secret_key, partner_tag

    @classmethod
    def from_env(cls) -> "PAAPI | None":
        ak = os.environ.get("AMAZON_PAAPI_ACCESS_KEY")
        sk = os.environ.get("AMAZON_PAAPI_SECRET_KEY")
        tag = os.environ.get("AMAZON_PAAPI_PARTNER_TAG")
        return cls(ak, sk, tag) if ak and sk and tag else None

    def _sign_headers(self, op: str, path: str, body: str, now: dt.datetime) -> dict:
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        target = f"com.amazon.paapi5.v1.ProductAdvertisingAPIv1.{op}"
        headers = {
            "content-encoding": "amz-1.0",
            "content-type": "application/json; charset=utf-8",
            "host": self.HOST,
            "x-amz-date": amz_date,
            "x-amz-target": target,
        }
        signed = ";".join(sorted(headers))
        canonical = "\n".join([
            "POST", path, "",
            "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)),
            signed,
            hashlib.sha256(body.encode()).hexdigest(),
        ])
        scope = f"{date}/{self.REGION}/{self.SERVICE}/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope,
                             hashlib.sha256(canonical.encode()).hexdigest()])

        def h(key: bytes, msg: str) -> bytes:
            return hmac.new(key, msg.encode(), hashlib.sha256).digest()

        k = h(("AWS4" + self.sk).encode(), date)
        k = h(k, self.REGION)
        k = h(k, self.SERVICE)
        k = h(k, "aws4_request")
        sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={self.ak}/{scope}, "
                                    f"SignedHeaders={signed}, Signature={sig}")
        return headers

    def _call(self, op: str, payload: dict) -> dict:
        path = f"/paapi5/{op.lower()}"
        payload = {**payload, "PartnerTag": self.tag, "PartnerType": "Associates",
                   "Marketplace": MARKETPLACE_HOST, "Resources": self.RESOURCES}
        body = json.dumps(payload)
        headers = self._sign_headers(op, path, body, dt.datetime.now(dt.timezone.utc))
        req = urllib.request.Request(f"https://{self.HOST}{path}", data=body.encode(),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise ShoppingError(f"PA-API {op} failed ({e.code}): {e.read()[:500]!r}") from e

    @staticmethod
    def _to_snapshot(item: dict) -> Snapshot:
        listing = ((item.get("Offers") or {}).get("Listings") or [{}])[0]
        avail = ((listing.get("Availability") or {}).get("Message") or "").lower()
        return Snapshot(
            asin=item["ASIN"],
            title=(((item.get("ItemInfo") or {}).get("Title") or {}).get("DisplayValue")),
            price=(listing.get("Price") or {}).get("Amount"),
            mrp=(listing.get("SavingBasis") or {}).get("Amount"),
            in_stock=None if not avail else ("in stock" in avail or "usually" in avail),
            url=item.get("DetailPageURL"),
            source="paapi",
        )

    def search(self, keywords: str, count: int = 10, min_price: float | None = None,
               max_price: float | None = None) -> list[Snapshot]:
        payload: dict = {"Keywords": keywords, "ItemCount": max(1, min(count, 10)), "SearchIndex": "All"}
        # PA-API prices are in the lowest currency unit (paise).
        if min_price is not None:
            payload["MinPrice"] = int(min_price * 100)
        if max_price is not None:
            payload["MaxPrice"] = int(max_price * 100)
        data = self._call("SearchItems", payload)
        return [self._to_snapshot(i) for i in (data.get("SearchResult") or {}).get("Items", [])]

    def get_items(self, asins: list[str]) -> list[Snapshot]:
        out: list[Snapshot] = []
        for i in range(0, len(asins), 10):  # PA-API limit: 10 ASINs per call
            data = self._call("GetItems", {"ItemIds": asins[i:i + 10]})
            out += [self._to_snapshot(x) for x in (data.get("ItemsResult") or {}).get("Items", [])]
        return out


# ---------------------------------------------------------------- price lookup

def fetch_snapshots(asins: list[str]) -> tuple[list[Snapshot], dict[str, str]]:
    """Get live data via PA-API if configured, else page fetch if enabled.
    Returns (snapshots, errors_by_asin)."""
    errors: dict[str, str] = {}
    api = PAAPI.from_env()
    if api:
        try:
            snaps = api.get_items(asins)
            got = {s.asin for s in snaps}
            for a in asins:
                if a not in got:
                    errors[a] = "not returned by PA-API"
            return snaps, errors
        except ShoppingError as e:
            if not page_fetch_enabled():
                return [], {a: str(e) for a in asins}
    if page_fetch_enabled():
        snaps = []
        for a in asins:
            try:
                snaps.append(fetch_page_snapshot(a))
            except Exception as e:  # noqa: BLE001 - report per item, keep going
                errors[a] = str(e)
        return snaps, errors
    msg = ("No live price source configured. Set PA-API keys, or AMAZON_ALLOW_PAGE_FETCH=1, "
           "or use record_price to log the price you see.")
    return [], {a: msg for a in asins}


def alert_status(item: dict, latest: dict | None, stats: dict) -> dict:
    price = latest["price"] if latest else None
    target = item.get("target_price")
    return {
        "asin": item["asin"],
        "title": item.get("title"),
        "current_price": price,
        "target_price": target,
        "hit_target": bool(price is not None and target is not None and price <= target),
        "at_lowest_seen": bool(price is not None and stats["observations"] > 1 and price <= stats["lowest"]),
        "lowest_seen": stats["lowest"],
        "last_checked": latest["ts"] if latest else None,
        "url": product_url(item["asin"]),
    }
