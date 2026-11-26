"""Exercises the MCP tools through a stub FastMCP (works without the `mcp` package)."""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _StubFastMCP:
    def __init__(self, name):
        self.name, self.tools = name, {}

    def tool(self):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


def _install_stub():
    if hasattr(sys.modules.get("mcp.server.fastmcp"), "_stub"):
        return
    mod = types.ModuleType("mcp.server.fastmcp")
    mod.FastMCP, mod._stub = _StubFastMCP, True
    sys.modules.update({"mcp": types.ModuleType("mcp"), "mcp.server": types.ModuleType("mcp.server"),
                        "mcp.server.fastmcp": mod, "mcp.server.mcpserver": None})


class TestTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["AMAZON_MCP_DB"] = str(Path(cls.tmp.name) / "t.db")
        for k in ("AMAZON_ALLOW_PAGE_FETCH", "AMAZON_PAAPI_ACCESS_KEY",
                  "AMAZON_PAAPI_SECRET_KEY", "AMAZON_PAAPI_PARTNER_TAG"):
            os.environ.pop(k, None)
        _install_stub()
        import server
        cls.t = server.build_server().tools

    def test_flow_without_keys(self):
        t = self.t
        self.assertEqual(set(t), {"search_products", "get_product", "compare_products", "track_product",
                                  "untrack_product", "set_target_price", "list_tracked", "refresh_prices",
                                  "record_price", "price_history", "check_alerts", "cart_link"})
        r = t["search_products"]("wireless earbuds")
        self.assertFalse(r["live_results"])
        self.assertIn("amazon.in/s?k=wireless+earbuds", r["search_url"])

        a, b = "https://www.amazon.in/dp/B0B1234567", "B0C7654321"
        r = t["track_product"](a, target_price_inr=1000)
        self.assertIn("record_price", r["first_check"]["errors"]["B0B1234567"])
        t["record_price"](a, 1500, mrp_inr=4000, title="Earbuds A")
        t["record_price"](a, 950)
        t["record_price"](b, 1100, title="Earbuds B")

        alerts = t["check_alerts"]()
        self.assertEqual([x["asin"] for x in alerts], ["B0B1234567"])
        self.assertTrue(alerts[0]["hit_target"])

        cmp_ = t["compare_products"]([a, b])
        self.assertEqual(cmp_["cheapest"], "B0B1234567")
        self.assertEqual(len(cmp_["products"]), 2)

        tracked = t["list_tracked"]()
        self.assertEqual(len(tracked), 2)
        self.assertEqual(t["price_history"](a)["stats"]["lowest"], 950)
        self.assertIn("ASIN.1=B0B1234567", t["cart_link"]([a])["url"])
        self.assertTrue(t["untrack_product"](b)["removed"])
        with self.assertRaises(Exception):
            t["set_target_price"](b, 500)


if __name__ == "__main__":
    unittest.main()
