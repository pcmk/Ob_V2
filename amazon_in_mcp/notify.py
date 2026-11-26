"""WhatsApp price-drop alerts. Standard library only.

Pick a provider with WHATSAPP_PROVIDER = callmebot | twilio | meta (unset = alerts off).

callmebot  (free, personal use; unofficial third-party service)
    WHATSAPP_TO=+91XXXXXXXXXX  CALLMEBOT_APIKEY=...
twilio     (paid; free sandbox for testing)
    WHATSAPP_TO=+91XXXXXXXXXX  TWILIO_ACCOUNT_SID=...  TWILIO_AUTH_TOKEN=...
    TWILIO_WHATSAPP_FROM=+14155238886   (sandbox number, or your approved sender)
meta       (official WhatsApp Cloud API)
    WHATSAPP_TO=91XXXXXXXXXX  META_WA_TOKEN=...  META_WA_PHONE_NUMBER_ID=...
    META_GRAPH_VERSION=v21.0 (optional)
    Free-form text only reaches you within 24h of you messaging the business number;
    outside that window Meta requires an approved template.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from core import ShoppingError, Store, product_url


def provider() -> str | None:
    p = os.environ.get("WHATSAPP_PROVIDER", "").strip().lower()
    return p or None


def min_drop_pct() -> float:
    return float(os.environ.get("WHATSAPP_ALERT_MIN_DROP_PCT", "5"))


def _post(url: str, data: bytes, headers: dict) -> str:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return _open(req)


def _open(req) -> str:
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise ShoppingError(f"WhatsApp send failed ({e.code}): {e.read()[:300]!r}") from e
    except urllib.error.URLError as e:
        raise ShoppingError(f"WhatsApp send failed: {e.reason}") from e


def _need(*names: str) -> list[str]:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise ShoppingError(f"Missing env vars for WhatsApp ({provider()}): {', '.join(missing)}")
    return [os.environ[n] for n in names]


def send_whatsapp(text: str) -> str:
    """Send one message with the configured provider. Returns the provider's response text."""
    p = provider()
    if p == "callmebot":
        to, key = _need("WHATSAPP_TO", "CALLMEBOT_APIKEY")
        q = urllib.parse.urlencode({"phone": to, "text": text, "apikey": key})
        return _open(urllib.request.Request(f"https://api.callmebot.com/whatsapp.php?{q}"))
    if p == "twilio":
        to, sid, tok, frm = _need("WHATSAPP_TO", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
                                  "TWILIO_WHATSAPP_FROM")
        body = urllib.parse.urlencode({"From": f"whatsapp:{frm}", "To": f"whatsapp:{to}",
                                       "Body": text}).encode()
        auth = base64.b64encode(f"{sid}:{tok}".encode()).decode()
        return _post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", body,
                     {"Authorization": f"Basic {auth}",
                      "Content-Type": "application/x-www-form-urlencoded"})
    if p == "meta":
        to, tok, pnid = _need("WHATSAPP_TO", "META_WA_TOKEN", "META_WA_PHONE_NUMBER_ID")
        ver = os.environ.get("META_GRAPH_VERSION", "v21.0")
        body = json.dumps({"messaging_product": "whatsapp", "to": to.lstrip("+"),
                           "type": "text", "text": {"body": text, "preview_url": True}}).encode()
        return _post(f"https://graph.facebook.com/{ver}/{pnid}/messages", body,
                     {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    if p is None:
        raise ShoppingError("WhatsApp alerts are off. Set WHATSAPP_PROVIDER (callmebot | twilio | meta).")
    raise ShoppingError(f"Unknown WHATSAPP_PROVIDER {p!r}. Use callmebot, twilio or meta.")


# ------------------------------------------------------------------ deciding what to send

def _fmt(x: float | None) -> str:
    return "?" if x is None else f"₹{x:,.0f}"


def drop_reasons(store: Store, item: dict) -> list[str]:
    """Why this item deserves an alert right now (empty list = no alert)."""
    asin = item["asin"]
    hist = store.history(asin, 2)
    if not hist or hist[0]["price"] is None:
        return []
    price = hist[0]["price"]
    prev = hist[1]["price"] if len(hist) > 1 else None
    stats = store.stats(asin)
    reasons = []
    target = item.get("target_price")
    if target is not None and price <= target:
        reasons.append(f"at/below your target {_fmt(target)}")
    if prev is not None and prev > 0 and price < prev:
        pct = 100 * (prev - price) / prev
        if pct >= min_drop_pct():
            reasons.append(f"dropped {pct:.0f}% from {_fmt(prev)}")
    if stats["observations"] > 1 and price <= stats["lowest"] and (prev is None or price < prev):
        reasons.append("lowest price seen so far")
    return reasons


def build_message(store: Store, item: dict, reasons: list[str]) -> str:
    price = store.latest(item["asin"])["price"]
    name = item.get("title") or item["asin"]
    if len(name) > 80:
        name = name[:77] + "..."
    return (f"\U0001F4C9 Amazon.in price alert\n{name}\nNow {_fmt(price)}: "
            + "; ".join(reasons) + f"\n{product_url(item['asin'])}")


def notify_price_drops(store: Store, asins: list[str] | None = None, dry_run: bool = False) -> dict:
    """Send a WhatsApp alert for each item with a qualifying drop that wasn't already alerted
    at this price or lower. Returns what was sent / skipped / failed."""
    out: dict = {"provider": provider(), "sent": [], "skipped_already_alerted": [], "failed": {}}
    if not provider() and not dry_run:
        out["note"] = "WhatsApp alerts off (WHATSAPP_PROVIDER not set)."
        return out
    items = [store.get_item(a) for a in asins] if asins else store.list_items()
    for item in filter(None, items):
        latest = store.latest(item["asin"])
        last = store.last_alert_price(item["asin"])
        # Price went back up above what we alerted at: re-arm so the next drop alerts again.
        if last is not None and latest and latest["price"] is not None and latest["price"] > last:
            store.clear_alert(item["asin"])
            last = None
        reasons = drop_reasons(store, item)
        if not reasons:
            continue
        price = latest["price"]
        if last is not None and price >= last:
            out["skipped_already_alerted"].append(item["asin"])
            continue
        msg = build_message(store, item, reasons)
        if dry_run:
            out["sent"].append({"asin": item["asin"], "message": msg, "dry_run": True})
            continue
        try:
            send_whatsapp(msg)
            store.record_alert(item["asin"], price)
            out["sent"].append({"asin": item["asin"], "message": msg})
        except ShoppingError as e:
            out["failed"][item["asin"]] = str(e)
    return out
