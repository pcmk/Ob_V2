"""Offline test. majesticman_store.html is a real store page (fetched 2026-11-26).
Search/product pages are synthetic, modelled on Amazon's usual markup (not verified live)."""
import csv, os, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import amazon_store_variants as s  # noqa: E402

STORE = (HERE / "majesticman_store.html").read_text()
SEARCH1 = '''<div data-asin="B0C7TXL6QL"><a href="/Majestic-Man-Shirt/dp/B0C7TXL6QL/ref=sr_1_1">x</a></div>
<div data-asin="B0AAAAAAA2"></div><div data-asin="B0C7TXL6QM"></div><div data-asin=""></div>
<a class="s-pagination-item s-pagination-next" href="/s?page=2">Next</a>'''
SEARCH2 = '''<div data-asin="B0BBBBBBB1"></div>
<span aria-disabled="true" class="s-pagination-item s-pagination-next s-pagination-disabled">Next</span>'''
SHIRT = '''<span id="productTitle"> Majestic Man Cotton Shirt </span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">₹599.00</span></span></div>
<script>var dataToReturn = { "parentAsin" : "B0C7PARENT",
 "dimensions" : ["size_name","color_name"], "dimensionsDisplay" : ["Size","Colour"],
 "dimensionValuesDisplayData" : {"B0C7TXL6QL":["M","Navy \\"Blue\\""],"B0C7TXL6QM":["L","Navy \\"Blue\\""],"B0C7TXL6QN":["M","White"]},
 "other": {"x":[1,2]} };</script>'''
KURTA = '''<span id="productTitle">Majestic Man Kurta</span>
<script>"colorImages": {}, "colorToAsin": {"Black": {"asin": "B0AAAAAAA2"}, "Beige": {"asin": "B0AAAAAAA3"}}</script>'''
PLAIN = '<span id="productTitle">Majestic Man Pyjama</span>'

PAGES = {
    "/stores/MajesticMan/page/68024481-7C7D-4905-B113-BE046D159162": STORE,
    "/s?rh=p_89%3AMajestic+Man": SEARCH1,
    "/s?rh=p_89%3AMajestic+Man&page=2": SEARCH2,
    "/dp/B0C7TXL6QL": SHIRT, "/dp/B0AAAAAAA2": KURTA, "/dp/B0BBBBBBB1": PLAIN,
}


def fake_fetch(url):
    path = url.replace(s.BASE, "")
    if path not in PAGES:
        raise AssertionError(f"unexpected fetch {url}")
    return PAGES[path]


class T(unittest.TestCase):
    def test_store_to_csv(self):
        out = Path(tempfile.mkdtemp()) / "v.csv"
        argv = ["x", "https://www.amazon.in/stores/MajesticMan/page/68024481-7C7D-4905-B113-BE046D159162"
                "?lp_asin=B0C7TXL6QL&ref_=ast_bln", "-o", str(out)]
        # store link query string is dropped by our fake only if we normalise it:
        with mock.patch.object(s, "fetch", side_effect=lambda u: fake_fetch(u.split("?lp_asin")[0])), \
             mock.patch.object(sys, "argv", argv):
            self.assertEqual(s.main(), 0)
        with open(out, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        got = [(r["parent_asin"], r["asin"], r.get("Size", ""), r.get("Colour", ""), r["price_inr"]) for r in rows]
        self.assertEqual(got, [
            ("B0C7PARENT", "B0C7TXL6QL", "M", 'Navy "Blue"', "599.0"),
            ("B0C7PARENT", "B0C7TXL6QM", "L", 'Navy "Blue"', ""),
            ("B0C7PARENT", "B0C7TXL6QN", "M", "White", ""),
            ("B0AAAAAAA2", "B0AAAAAAA2", "", "Black", ""),
            ("B0AAAAAAA2", "B0AAAAAAA3", "", "Beige", ""),
            ("B0BBBBBBB1", "B0BBBBBBB1", "", "", ""),
        ])
        self.assertEqual(rows[0]["title"], "Majestic Man Cotton Shirt")
        self.assertEqual(list(rows[0])[:5], ["parent_asin", "asin", "title", "Size", "Colour"])

    def test_store_brand(self):
        self.assertEqual(s.store_brand(STORE), "Majestic Man")
        self.assertEqual(s.asins_in_listing(STORE), [])


if __name__ == "__main__":
    unittest.main()
