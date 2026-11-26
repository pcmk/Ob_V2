import json
import os
import sys
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import core  # noqa: E402
import notify  # noqa: E402

A = "B0B1234567"
ENV_KEYS = ["WHATSAPP_PROVIDER", "WHATSAPP_TO", "CALLMEBOT_APIKEY", "TWILIO_ACCOUNT_SID",
            "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "META_WA_TOKEN",
            "META_WA_PHONE_NUMBER_ID", "WHATSAPP_ALERT_MIN_DROP_PCT"]


class Base(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        self.s = core.Store(":memory:")

    def tearDown(self):
        self.s.db.close()
        self._env.stop()

    def price(self, p):
        self.s.add_snapshot(core.Snapshot(A, "Earbuds", p))


class TestDecision(Base):
    def test_reasons(self):
        self.s.upsert_item(A, target_price=1000)
        self.price(1500)
        self.assertEqual(notify.drop_reasons(self.s, self.s.get_item(A)), [])
        self.price(1480)  # 1.3% drop: below 5% threshold, not at target
        self.assertEqual(notify.drop_reasons(self.s, self.s.get_item(A)), ["lowest price seen so far"])
        self.price(990)
        r = notify.drop_reasons(self.s, self.s.get_item(A))
        self.assertIn("at/below your target ₹1,000", r)
        self.assertTrue(any(x.startswith("dropped 33%") for x in r))

    def test_off_when_no_provider(self):
        self.s.upsert_item(A, target_price=1000)
        self.price(900)
        out = notify.notify_price_drops(self.s)
        self.assertEqual(out["sent"], [])
        self.assertIn("off", out["note"])

    def test_dry_run(self):
        self.s.upsert_item(A, target_price=1000)
        self.price(900)
        out = notify.notify_price_drops(self.s, dry_run=True)
        self.assertIn("₹900", out["sent"][0]["message"])
        self.assertIn(f"amazon.in/dp/{A}", out["sent"][0]["message"])
        self.assertIsNone(self.s.last_alert_price(A))  # dry run records nothing

    def test_dedupe_and_rearm(self):
        os.environ.update(WHATSAPP_PROVIDER="callmebot", WHATSAPP_TO="+910000000000", CALLMEBOT_APIKEY="k")
        self.s.upsert_item(A, target_price=1000)
        with mock.patch.object(notify, "send_whatsapp", return_value="ok") as send:
            self.price(1200)
            self.price(950)
            self.assertEqual(len(notify.notify_price_drops(self.s)["sent"]), 1)
            # same price again: no repeat
            self.price(950)
            out = notify.notify_price_drops(self.s)
            self.assertEqual(out["sent"], [])
            self.assertEqual(out["skipped_already_alerted"], [A])
            # lower still: alert
            self.price(900)
            self.assertEqual(len(notify.notify_price_drops(self.s)["sent"]), 1)
            # goes back up, then drops back to target: re-armed, alerts again
            self.price(1300)
            notify.notify_price_drops(self.s)
            self.price(980)
            self.assertEqual(len(notify.notify_price_drops(self.s)["sent"]), 1)
            self.assertEqual(send.call_count, 3)

    def test_failure_not_recorded(self):
        os.environ.update(WHATSAPP_PROVIDER="twilio")  # missing creds
        self.s.upsert_item(A, target_price=1000)
        self.price(900)
        out = notify.notify_price_drops(self.s)
        self.assertIn("Missing env vars", out["failed"][A])
        self.assertIsNone(self.s.last_alert_price(A))


class _Resp:
    def __init__(self, body=b'{"ok":true}'):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestProviders(Base):
    def _send(self, **env):
        os.environ.update(env)
        with mock.patch("urllib.request.urlopen", return_value=_Resp()) as uo:
            notify.send_whatsapp("hello ₹900")
        return uo.call_args[0][0]

    def test_callmebot(self):
        req = self._send(WHATSAPP_PROVIDER="callmebot", WHATSAPP_TO="+919999999999", CALLMEBOT_APIKEY="abc")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)
        self.assertTrue(req.full_url.startswith("https://api.callmebot.com/whatsapp.php?"))
        self.assertEqual((q["phone"][0], q["apikey"][0], q["text"][0]), ("+919999999999", "abc", "hello ₹900"))

    def test_twilio(self):
        req = self._send(WHATSAPP_PROVIDER="twilio", WHATSAPP_TO="+919999999999", TWILIO_ACCOUNT_SID="AC1",
                         TWILIO_AUTH_TOKEN="t", TWILIO_WHATSAPP_FROM="+14155238886")
        self.assertEqual(req.full_url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json")
        body = urllib.parse.parse_qs(req.data.decode())
        self.assertEqual(body["To"][0], "whatsapp:+919999999999")
        self.assertEqual(body["From"][0], "whatsapp:+14155238886")
        self.assertTrue(req.get_header("Authorization").startswith("Basic "))

    def test_meta(self):
        req = self._send(WHATSAPP_PROVIDER="meta", WHATSAPP_TO="+919999999999", META_WA_TOKEN="tok",
                         META_WA_PHONE_NUMBER_ID="123")
        self.assertEqual(req.full_url, "https://graph.facebook.com/v21.0/123/messages")
        body = json.loads(req.data)
        self.assertEqual((body["to"], body["type"], body["text"]["body"]), ("919999999999", "text", "hello ₹900"))
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")

    def test_unknown_provider(self):
        os.environ["WHATSAPP_PROVIDER"] = "pigeon"
        with self.assertRaises(core.ShoppingError):
            notify.send_whatsapp("x")


if __name__ == "__main__":
    unittest.main()
