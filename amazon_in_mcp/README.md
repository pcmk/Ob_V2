# Amazon.in Shopping MCP

Personal MCP server for **amazon.in** with two jobs: **search & compare** and **price tracking**.
It never logs in, adds to your cart or buys anything. You always check out on Amazon yourself.

## Tools

| Tool | What it does |
|---|---|
| `search_products` | Live search (needs PA-API keys). Without keys, returns an amazon.in search link |
| `get_product` | Title, price, MRP, discount %, rating, stock for one product |
| `compare_products` | Side-by-side comparison, plus the cheapest and best-rated product |
| `track_product` / `untrack_product` | Start or stop tracking, with an optional target price |
| `set_target_price` | Change the alert price |
| `list_tracked` | Latest price, target, and lowest/highest price seen |
| `refresh_prices` | Fetch current prices (one product or all) and return alerts |
| `record_price` | Log a price you saw yourself (works with no keys) |
| `price_history` | History plus lowest, highest and average |
| `check_alerts` | Items at or below target, or at their lowest price seen |
| `cart_link` | Add-to-cart link that you open yourself |

## Price sources (checked in this order)

1. **PA-API 5.0** (official). Set `AMAZON_PAAPI_ACCESS_KEY`, `AMAZON_PAAPI_SECRET_KEY` and `AMAZON_PAAPI_PARTNER_TAG`. You need an Amazon Associates account. *Not sure:* Amazon may be moving PA-API to a newer API, so check before relying on it.
2. **Page fetch** (opt-in, `AMAZON_ALLOW_PAGE_FETCH=1`). Reads the public product page, with at least 5 s between requests (`AMAZON_FETCH_MIN_GAP_SECONDS`).
   ⚠️ Automated access likely breaks Amazon's Conditions of Use. Amazon may show captchas, and the page markup changes often. Use it at your own risk and keep the volume low.
3. **Manual**. Use `record_price`.

Data is stored in SQLite at `~/.amazon_in_mcp/shop.db` (override with `AMAZON_MCP_DB`).

## Setup

```bash
pip install -r requirements.txt
```

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "amazon-in": {
      "command": "python",
      "args": ["/ABSOLUTE/PATH/amazon_in_mcp/server.py"],
      "env": { "AMAZON_ALLOW_PAGE_FETCH": "0" }
    }
  }
}
```

Claude Code one-liner: `claude mcp add amazon-in -- python /ABSOLUTE/PATH/amazon_in_mcp/server.py`

## Scheduled price checks

MCP can't push notifications. To check prices on a schedule, run this from cron:

```bash
python server.py --refresh   # prints updated prices + alerts as JSON
```

## Tests

```bash
python -m unittest discover -s tests
```
