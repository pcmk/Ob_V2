"""Amazon.in personal shopping MCP server: search & compare, price tracking.

Run:  python server.py            (stdio MCP server)
      python server.py --refresh  (refresh all tracked prices once, print alerts and
                                   send WhatsApp price-drop alerts; for cron)

It never logs in, adds to cart or buys. Checkout stays with you on amazon.in.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import core  # noqa: E402
import notify  # noqa: E402
from core import ShoppingError, Snapshot, Store  # noqa: E402

store = Store()


def _resolve_asin(url_or_asin: str) -> str:
    asin = core.extract_asin(url_or_asin)
    if not asin and core.is_short_link(url_or_asin):
        asin = core.resolve_short_link(url_or_asin)
    if not asin:
        raise ShoppingError(f"Could not find an ASIN in {url_or_asin!r}. "
                            "Use an amazon.in/dp/<ASIN> link or the 10-character ASIN.")
    return asin


def _refresh(asins: list[str]) -> dict:
    snaps, errors = core.fetch_snapshots(asins)
    for s in snaps:
        store.add_snapshot(s)
    return {"updated": [s.to_dict() for s in snaps], "errors": errors}


def _alerts() -> list[dict]:
    out = []
    for item in store.list_items():
        a = core.alert_status(item, store.latest(item["asin"]), store.stats(item["asin"]))
        if a["hit_target"] or a["at_lowest_seen"]:
            out.append(a)
    return out


# ------------------------------------------------------------------ tools

def build_server():
    try:  # mcp 2.x renamed FastMCP -> MCPServer
        from mcp.server.mcpserver import MCPServer as Server
    except ImportError:  # mcp 1.x
        from mcp.server.fastmcp import FastMCP as Server

    mcp = Server("amazon-in-shopping")

    @mcp.tool()
    def search_products(query: str, max_results: int = 10,
                        min_price_inr: float | None = None,
                        max_price_inr: float | None = None) -> dict:
        """Search amazon.in for products. Live results need PA-API keys; without them
        this returns an amazon.in search link to open in your browser."""
        api = core.PAAPI.from_env()
        if not api:
            return {"live_results": False,
                    "note": "No PA-API keys set, so live search is unavailable. Open the link, "
                            "then give me product links/ASINs to compare or track.",
                    "search_url": core.search_url(query)}
        items = api.search(query, max_results, min_price_inr, max_price_inr)
        return {"live_results": True, "results": [s.to_dict() for s in items]}

    @mcp.tool()
    def get_product(url_or_asin: str) -> dict:
        """Get current details (title, price, MRP, discount, rating, stock) for one product."""
        asin = _resolve_asin(url_or_asin)
        res = _refresh([asin]) if store.get_item(asin) else None
        if res is None:
            snaps, errors = core.fetch_snapshots([asin])
            if errors:
                return {"asin": asin, "url": core.product_url(asin), "error": errors[asin]}
            return snaps[0].to_dict()
        return res["updated"][0] if res["updated"] else {"asin": asin, "error": res["errors"].get(asin)}

    @mcp.tool()
    def compare_products(urls_or_asins: list[str]) -> dict:
        """Compare 2+ products side by side. Uses live data if available, else the last
        recorded price for tracked items. Ranks by price and by rating."""
        asins = [_resolve_asin(u) for u in urls_or_asins]
        snaps, errors = core.fetch_snapshots(asins)
        rows = {s.asin: s.to_dict() for s in snaps}
        for a in asins:
            if a not in rows:
                last = store.latest(a)
                item = store.get_item(a) or {}
                if last:
                    rows[a] = {**Snapshot(a, item.get("title"), last["price"], last["mrp"],
                                         None if last["in_stock"] is None else bool(last["in_stock"]),
                                         last["rating"], last["review_count"], core.product_url(a),
                                         "stored").to_dict(), "as_of": last["ts"]}
        table = [rows.get(a, {"asin": a, "error": errors.get(a)}) for a in asins]
        priced = [r for r in table if r.get("price") is not None]
        rated = [r for r in table if r.get("rating") is not None]
        return {
            "products": table,
            "cheapest": min(priced, key=lambda r: r["price"])["asin"] if priced else None,
            "best_rated": max(rated, key=lambda r: (r["rating"], r.get("review_count") or 0))["asin"]
            if rated else None,
            "errors": {a: e for a, e in errors.items() if a not in rows},
        }

    @mcp.tool()
    def track_product(url_or_asin: str, target_price_inr: float | None = None,
                      notes: str | None = None) -> dict:
        """Start tracking a product's price. Optionally set a target price (alert when at/below)."""
        asin = _resolve_asin(url_or_asin)
        store.upsert_item(asin, target_price=target_price_inr, notes=notes)
        res = _refresh([asin])
        return {"tracking": store.get_item(asin), "first_check": res}

    @mcp.tool()
    def untrack_product(url_or_asin: str, keep_history: bool = False) -> dict:
        """Stop tracking a product (deletes its price history unless keep_history=True)."""
        asin = _resolve_asin(url_or_asin)
        return {"asin": asin, "removed": store.delete_item(asin, keep_history)}

    @mcp.tool()
    def set_target_price(url_or_asin: str, target_price_inr: float) -> dict:
        """Change the target price for a tracked product."""
        asin = _resolve_asin(url_or_asin)
        if not store.get_item(asin):
            raise ShoppingError(f"{asin} is not tracked. Use track_product first.")
        store.upsert_item(asin, target_price=target_price_inr)
        return store.get_item(asin)

    @mcp.tool()
    def list_tracked() -> list[dict]:
        """List tracked products with latest price, target, and lowest/highest seen."""
        out = []
        for item in store.list_items():
            a = core.alert_status(item, store.latest(item["asin"]), store.stats(item["asin"]))
            out.append({**a, **{"highest_seen": store.stats(item["asin"])["highest"],
                                "notes": item.get("notes")}})
        return out

    @mcp.tool()
    def refresh_prices(url_or_asin: str | None = None) -> dict:
        """Fetch current prices for one tracked product, or all if none given."""
        asins = [_resolve_asin(url_or_asin)] if url_or_asin else [i["asin"] for i in store.list_items()]
        if not asins:
            return {"note": "Nothing tracked yet."}
        res = _refresh(asins)
        res["alerts"] = _alerts()
        res["whatsapp"] = notify.notify_price_drops(store, asins)
        return res

    @mcp.tool()
    def record_price(url_or_asin: str, price_inr: float, mrp_inr: float | None = None,
                     in_stock: bool | None = None, title: str | None = None) -> dict:
        """Manually log a price you saw (works with no API keys and no page fetching)."""
        asin = _resolve_asin(url_or_asin)
        if not store.get_item(asin):
            store.upsert_item(asin, title=title)
        store.add_snapshot(Snapshot(asin, title, price_inr, mrp_inr, in_stock, source="manual"))
        return {"recorded": store.latest(asin), "stats": store.stats(asin),
                "whatsapp": notify.notify_price_drops(store, [asin])}

    @mcp.tool()
    def price_history(url_or_asin: str, limit: int = 50) -> dict:
        """Price history and lowest/highest/average for a tracked product."""
        asin = _resolve_asin(url_or_asin)
        return {"asin": asin, "item": store.get_item(asin), "stats": store.stats(asin),
                "history": store.history(asin, limit)}

    @mcp.tool()
    def check_alerts() -> list[dict]:
        """Tracked products currently at/below target price or at their lowest seen price
        (based on stored data; call refresh_prices first for fresh numbers)."""
        return _alerts()

    @mcp.tool()
    def send_test_whatsapp(message: str = "Test from your Amazon.in price tracker") -> dict:
        """Send a test WhatsApp message to check your alert setup."""
        return {"provider": notify.provider(), "response": notify.send_whatsapp(message)[:300]}

    @mcp.tool()
    def preview_whatsapp_alerts() -> dict:
        """Show which price-drop alerts would be sent now, without sending them."""
        return notify.notify_price_drops(store, dry_run=True)

    @mcp.tool()
    def cart_link(urls_or_asins: list[str], quantity: int = 1) -> dict:
        """Build an amazon.in add-to-cart link. You open it, review, and check out yourself."""
        asins = [_resolve_asin(u) for u in urls_or_asins]
        return {"url": core.add_to_cart_url(asins, quantity),
                "note": "Opens Amazon's add-to-cart confirmation; nothing is purchased automatically."}

    return mcp


def main() -> None:
    if "--refresh" in sys.argv:
        asins = [i["asin"] for i in store.list_items()]
        res = _refresh(asins) if asins else {"updated": [], "errors": {}}
        res["alerts"] = _alerts()
        res["whatsapp"] = notify.notify_price_drops(store, asins)
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return
    build_server().run()


if __name__ == "__main__":
    main()
