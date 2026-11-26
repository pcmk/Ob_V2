"""Offline tests. majesticman_store.html is a real store page (fetched 2026-11-26).
Search/product pages are synthetic, modelled on Amazon's usual markup (not verified live)."""
import csv, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import amazon_store_variants as s  # noqa: E402

STORE = (HERE / "majesticman_store.html").read_text()
SEARCH1 = '''<div data-asin="B0CJPXGDJC"><a href="/Majestic-Man-Shirt/dp/B0CJPXGDJC/ref=sr_1_1">x</a></div>
<div data-asin="B0AAAAAAA2"></div><div data-asin="B0CJPXGDJD"></div><div data-asin=""></div>
<a class="s-pagination-item s-pagination-next" href="/s?page=2">Next</a>'''
SEARCH2 = '''<div data-asin="B0BBBBBBB1"></div>
<span aria-disabled="true" class="s-pagination-item s-pagination-next s-pagination-disabled">Next</span>'''


def shirt(price, avail="In stock"):
    return f'''<span id="productTitle"> Majestic Man Checkered Cotton Shirt </span>
<a id="bylineInfo" href="/stores/MajesticMan">Visit the Majestic Man Store</a>
<span class="a-icon-alt">4.0 out of 5 stars</span><span id="acrCustomerReviewText">1,234 ratings</span>
<div id="corePriceDisplay_desktop_feature_div"><div>
 <span class="a-price aok-align-center priceToPay"><span class="a-offscreen">₹{price}.00</span></span>
 <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">₹1,499.00</span></span></div></div>
<div id="availability"><span class="a-size-medium a-color-success"> {avail} </span></div>
<div id="productFactsDesktopExpander"><div class="a-fixed-left-grid product-facts-detail"><div class="a-fixed-left-grid-inner">
 <div class="a-fixed-left-grid-col a-col-left"><span class="a-color-base">Material composition</span></div>
 <div class="a-fixed-left-grid-col a-col-right"><span class="a-color-base">100% Cotton</span></div></div></div>
 <div class="a-fixed-left-grid product-facts-detail"><div class="a-fixed-left-grid-inner">
 <div class="a-fixed-left-grid-col a-col-left"><span class="a-color-base">Sleeve type</span></div>
 <div class="a-fixed-left-grid-col a-col-right"><span class="a-color-base">Long Sleeve</span></div></div></div>
 <ul class="a-unordered-list a-vertical"><li><span class="a-list-item a-size-base a-color-base">Fit: Slim Fit</span></li>
 <li><span class="a-list-item a-size-base a-color-base">Care: Machine wash</span></li></ul></div>
<div id="detailBullets_feature_div"><ul>
 <li><span class="a-list-item"><span class="a-text-bold">Manufacturer &rlm; : &lrm;</span> <span>Majestic Man &amp; Co</span></span></li>
 <li><span class="a-list-item"><span class="a-text-bold">ASIN &rlm; : &lrm;</span> <span>B0CJPXGDJC</span></span></li></ul></div>
<div id="productDescription"><p>Premium checkered shirt.<br>Breathable cotton.</p></div>
<script>"colorImages": {{"initial": [{{"hiRes":"https://m.media-amazon.com/images/I/shirt.jpg"}}]}},
 "parentAsin" : "B0CJPARENT", "dimensions" : ["size_name","color_name"], "dimensionsDisplay" : ["Size","Colour"],
 "dimensionValuesDisplayData" : {{"B0CJPXGDJC":["M","Magenta"],"B0CJPXGDJD":["L","Magenta"],"B0CJPXGDJE":["M","Navy"]}}</script>'''


KURTA = '''<span id="productTitle">Majestic Man Kurta</span>
<script>"colorToAsin": {"Black": {"asin": "B0AAAAAAA2"}, "Beige": {"asin": "B0AAAAAAA3"}}</script>'''
PLAIN = '<span id="productTitle">Majestic Man Pyjama</span>'

PAGES = {
    "/stores/MajesticMan/page/68024481-7C7D-4905-B113-BE046D159162": STORE,
    "/s?rh=p_89%3AMajestic+Man": SEARCH1, "/s?rh=p_89%3AMajestic+Man&page=2": SEARCH2,
    "/dp/B0CJPXGDJC": shirt(599), "/dp/B0CJPXGDJD": shirt(649), "/dp/B0CJPXGDJE": shirt(599, "Currently unavailable."),
    "/dp/B0AAAAAAA2": KURTA, "/dp/B0AAAAAAA3": KURTA, "/dp/B0BBBBBBB1": PLAIN,
}


def run(url, *extra):
    out = Path(tempfile.mkdtemp()) / "v.csv"
    fetched = []

    def fake(u):
        path = u.replace(s.BASE, "").split("?lp_asin")[0]
        fetched.append(path)
        return PAGES[path]
    with mock.patch.object(s, "fetch", side_effect=fake), mock.patch.object(sys, "argv", ["x", url, "-o", str(out), *extra]):
        assert s.main() == 0
    with open(out, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f)), fetched


class T(unittest.TestCase):
    def test_product_link_full_details(self):
        rows, fetched = run("amazon.in/Majestic-Man-Checkered-Cotton-Charcoal/dp/B0CJPXGDJC?ref_=ast_sto_dp&th=1&psc=1")
        self.assertEqual([(r["asin"], r["Size"], r["Colour"], r["price_inr"], r["availability"]) for r in rows], [
            ("B0CJPXGDJC", "M", "Magenta", "599.0", "In stock"),
            ("B0CJPXGDJD", "L", "Magenta", "649.0", "In stock"),
            ("B0CJPXGDJE", "M", "Navy", "599.0", "Currently unavailable."),
        ])
        r = rows[0]
        self.assertEqual((r["parent_asin"], r["brand"], r["mrp_inr"], r["discount_pct"], r["rating"], r["review_count"]),
                         ("B0CJPARENT", "Majestic Man", "1499.0", "60", "4.0", "1234"))
        self.assertEqual(r["Material composition"], "100% Cotton")
        self.assertEqual(r["Sleeve type"], "Long Sleeve")
        self.assertEqual(r["Manufacturer"], "Majestic Man & Co")
        self.assertNotIn("ASIN", r)
        self.assertEqual(r["about_this_item"], "Fit: Slim Fit | Care: Machine wash")
        self.assertEqual(r["description"], "Premium checkered shirt. Breathable cotton.")
        self.assertEqual(r["main_image"], "https://m.media-amazon.com/images/I/shirt.jpg")
        self.assertEqual(len(fetched), 3)  # every variant page opened

    def test_fast_mode(self):
        rows, fetched = run("https://www.amazon.in/dp/B0CJPXGDJC", "--fast")
        self.assertEqual(len(fetched), 1)
        self.assertEqual([r["status"] for r in rows], ["OK", "FAMILY DATA ONLY", "FAMILY DATA ONLY"])
        self.assertEqual(rows[1]["price_inr"], "")
        self.assertEqual(rows[1]["Material composition"], "100% Cotton")

    def test_store_link(self):
        rows, _ = run("https://www.amazon.in/stores/MajesticMan/page/68024481-7C7D-4905-B113-BE046D159162"
                      "?lp_asin=B0C7TXL6QL&ref_=ast_bln")
        self.assertEqual([r["asin"] for r in rows],
                         ["B0CJPXGDJC", "B0CJPXGDJD", "B0CJPXGDJE", "B0AAAAAAA2", "B0AAAAAAA3", "B0BBBBBBB1"])
        self.assertEqual([r["Colour"] for r in rows[3:5]], ["Black", "Beige"])

    def test_store_brand(self):
        self.assertEqual(s.store_brand(STORE), "Majestic Man")
        self.assertEqual(s.asins_in_listing(STORE), [])


if __name__ == "__main__":
    unittest.main()
