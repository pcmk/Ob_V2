import datetime as dt
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import core  # noqa: E402

SAMPLE_PAGE = """
<html><body>
<span id="productTitle" class="a-size-large">  Boat Airdopes 141 &amp; Case  </span>
<div id="corePriceDisplay_desktop_feature_div">
  <span class="a-price aok-align-center priceToPay"><span class="a-offscreen">₹1,299.00</span>
  <span class="a-price-whole">1,299</span></span>
  <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">₹4,490.00</span></span>
</div>
<span class="a-icon-alt">4.1 out of 5 stars</span>
<span id="acrCustomerReviewText" class="a-size-base">3,45,210 ratings</span>
<div id="availability"><span>In stock</span></div>
</body></html>
"""


class TestAsin(unittest.TestCase):
    def test_extract(self):
        cases = {
            "B0B1234567": "B0B1234567",
            "b0b1234567": "B0B1234567",
            "https://www.amazon.in/boAt-Airdopes/dp/B0B1234567/ref=sr_1_1?x=1": "B0B1234567",
            "https://www.amazon.in/gp/product/B0B1234567": "B0B1234567",
            "https://www.amazon.in/gp/aw/d/B0B1234567?psc=1": "B0B1234567",
            "https://www.amazon.in/s?k=earbuds": None,
            "hello": None,
        }
        for s, want in cases.items():
            self.assertEqual(core.extract_asin(s), want, s)

    def test_short_link(self):
        self.assertTrue(core.is_short_link("https://amzn.in/d/abc123"))
        self.assertFalse(core.is_short_link("https://www.amazon.in/dp/B0B1234567"))

    def test_short_link_needs_fetch(self):
        os.environ.pop("AMAZON_ALLOW_PAGE_FETCH", None)
        with self.assertRaises(core.ShoppingError):
            core.resolve_short_link("https://amzn.in/d/abc123")

    def test_urls(self):
        self.assertEqual(core.search_url("usb c cable"), "https://www.amazon.in/s?k=usb+c+cable")
        u = core.add_to_cart_url(["B0B1234567", "B0C7654321"], 2)
        self.assertIn("ASIN.1=B0B1234567", u)
        self.assertIn("Quantity.2=2", u)


class TestParse(unittest.TestCase):
    def test_parse_inr(self):
        self.assertEqual(core.parse_inr("₹1,23,456.50"), 123456.5)
        self.assertIsNone(core.parse_inr(""))

    def test_product_page(self):
        s = core.parse_product_page(SAMPLE_PAGE, "B0B1234567")
        self.assertEqual(s.title, "Boat Airdopes 141 & Case")
        self.assertEqual(s.price, 1299.0)
        self.assertEqual(s.mrp, 4490.0)
        self.assertEqual(s.rating, 4.1)
        self.assertEqual(s.review_count, 345210)
        self.assertTrue(s.in_stock)
        self.assertEqual(s.to_dict()["discount_pct"], 71.1)

    def test_out_of_stock(self):
        page = '<div id="availability"><span>Currently unavailable.</span></div>'
        self.assertFalse(core.parse_product_page(page, "B0B1234567").in_stock)

    def test_captcha(self):
        self.assertTrue(core.is_blocked_page("<form action='/errors/validateCaptcha'>"))


class TestStore(unittest.TestCase):
    def setUp(self):
        self.s = core.Store(":memory:")

    def test_track_and_history(self):
        self.s.upsert_item("B0B1234567", target_price=1000)
        for p in (1500, 1200, 999):
            self.s.add_snapshot(core.Snapshot("B0B1234567", "Earbuds", p))
        self.assertEqual(self.s.get_item("B0B1234567")["title"], "Earbuds")
        st = self.s.stats("B0B1234567")
        self.assertEqual((st["lowest"], st["highest"], st["observations"]), (999, 1500, 3))
        self.assertEqual(self.s.latest("B0B1234567")["price"], 999)
        a = core.alert_status(self.s.get_item("B0B1234567"), self.s.latest("B0B1234567"), st)
        self.assertTrue(a["hit_target"])
        self.assertTrue(a["at_lowest_seen"])
        # update keeps other fields
        self.s.upsert_item("B0B1234567", notes="gift")
        self.assertEqual(self.s.get_item("B0B1234567")["target_price"], 1000)
        self.assertTrue(self.s.delete_item("B0B1234567"))
        self.assertEqual(self.s.history("B0B1234567"), [])

    def test_no_source(self):
        os.environ.pop("AMAZON_ALLOW_PAGE_FETCH", None)
        for k in ("AMAZON_PAAPI_ACCESS_KEY", "AMAZON_PAAPI_SECRET_KEY", "AMAZON_PAAPI_PARTNER_TAG"):
            os.environ.pop(k, None)
        snaps, errors = core.fetch_snapshots(["B0B1234567"])
        self.assertEqual(snaps, [])
        self.assertIn("record_price", errors["B0B1234567"])


class TestPaapiSigning(unittest.TestCase):
    def test_headers_shape(self):
        api = core.PAAPI("AKIDEXAMPLE", "secret", "tag-21")
        now = dt.datetime(2026, 11, 26, 12, 0, 0, tzinfo=dt.timezone.utc)
        h = api._sign_headers("GetItems", "/paapi5/getitems", "{}", now)
        self.assertEqual(h["x-amz-date"], "20261126T120000Z")
        self.assertTrue(h["Authorization"].startswith(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261126/eu-west-1/ProductAdvertisingAPI/aws4_request"))
        self.assertIn("SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target", h["Authorization"])
        # deterministic
        self.assertEqual(h, api._sign_headers("GetItems", "/paapi5/getitems", "{}", now))

    def test_snapshot_mapping(self):
        item = {"ASIN": "B0B1234567", "DetailPageURL": "https://www.amazon.in/dp/B0B1234567?tag=x",
                "ItemInfo": {"Title": {"DisplayValue": "Earbuds"}},
                "Offers": {"Listings": [{"Price": {"Amount": 1299.0}, "SavingBasis": {"Amount": 4490.0},
                                         "Availability": {"Message": "In stock"}}]}}
        s = core.PAAPI._to_snapshot(item)
        self.assertEqual((s.title, s.price, s.mrp, s.in_stock), ("Earbuds", 1299.0, 4490.0, True))


if __name__ == "__main__":
    unittest.main()
