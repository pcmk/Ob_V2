# Amazon.in daily price tracker: Google Sheet + your PC

Amazon blocks Google's servers with a captcha, so the price check runs on **your PC** (`pc_price_checker.py`) and writes the results into your Google Sheet through the Apps Script.

## 1. Update the Apps Script
Extensions → Apps Script → replace all the code with `AmazonPriceTracker.gs` → Save.

## 2. Create the access key
Reload the sheet → **Price Tracker → Set up PC access key** → copy the key.

## 3. Deploy as a Web app
In the Apps Script editor: **Deploy → New deployment** → ⚙ → **Web app**
- Execute as: **Me**
- Who has access: **Anyone** (requests without your key are refused)
- **Deploy** → copy the **Web app URL** (ends in `/exec`).

After later code changes, use Deploy → Manage deployments → ✏ → Version: **New version**. Otherwise the old code keeps running.

## 4. On your PC
1. Install Python 3 from python.org. On Windows, tick **"Add python.exe to PATH"**.
2. Make a folder, e.g. `C:\price-tracker`, and put `pc_price_checker.py` in it.
3. In the same folder, create `config.json`:
   ```json
   {"webapp_url": "https://script.google.com/macros/s/XXXX/exec", "key": "YOUR_KEY"}
   ```
4. Test it: open Command Prompt and run
   ```
   cd C:\price-tracker
   python pc_price_checker.py
   ```
   The sheet should fill in: Status `OK` and a price.

## 5. Run it daily
**Windows** (Task Scheduler): Create Basic Task → Daily, 10:00 → Start a program
- Program: `python`
- Arguments: `pc_price_checker.py`
- Start in: `C:\price-tracker`

Then in the task's Properties, tick **"Run task as soon as possible after a scheduled start is missed"**, so it catches up if the PC was off.

**macOS / Linux** (cron): `0 10 * * * cd ~/price-tracker && python3 pc_price_checker.py`

## Status values
| Status | Meaning |
|---|---|
| OK | Price updated |
| BLOCKED (captcha, from PC) | Amazon showed a robot check even from your PC; the last price is kept |
| NO PRICE FOUND | Page loaded but no price found (out of stock, or Amazon changed its page) |
| BAD LINK (no ASIN) | The link isn't an amazon.in product link |

Alerts (email, optional WhatsApp via CallMeBot) are sent by the sheet when a price reaches your target or drops 5% or more.
