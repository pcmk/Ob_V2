/**
 * Amazon.in Price Tracker — Google Apps Script (bound to a Google Sheet).
 *
 * Sheet "Tracker":  paste product links in column A (from row 2). Optional target price in column F.
 * Sheet "History":  one row per product per check (filled automatically).
 *
 * Prices are checked by pc_price_checker.py on your PC (Amazon blocks Google's servers),
 * which talks to this script through its Web app URL (doGet / doPost below).
 *
 * Menu "Price Tracker":
 *   - Set up PC access key   (shows the key the PC script needs)
 *   - Refresh from Google servers (usually BLOCKED by Amazon)
 *
 * Optional alerts when price <= target, or drops >= DROP_ALERT_PCT vs last check:
 *   - Email: on by default, to the sheet owner.
 *   - WhatsApp (CallMeBot): set Script Properties WHATSAPP_TO (+91...) and CALLMEBOT_APIKEY.
 *     (Project Settings → Script Properties)
 *
 */

const TRACKER = 'Tracker';
const HISTORY = 'History';
const HEADERS = ['Product URL', 'ASIN', 'Title', 'Price (₹)', 'MRP (₹)', 'Target (₹)',
                 'Lowest seen (₹)', 'Last checked', 'Status'];
const HISTORY_HEADERS = ['Checked at', 'ASIN', 'Title', 'Price (₹)', 'MRP (₹)', 'Status'];
const COL = { URL: 1, ASIN: 2, TITLE: 3, PRICE: 4, MRP: 5, TARGET: 6, LOWEST: 7, CHECKED: 8, STATUS: 9 };
const DROP_ALERT_PCT = 5;
const GAP_MS = 4000;          // pause between products, to stay polite
const EMAIL_ALERTS = true;

// ------------------------------------------------------------------ menu & triggers

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Price Tracker')
    .addItem('Set up PC access key', 'setupPcKey')
    .addSeparator()
    .addItem('Refresh from Google servers (usually BLOCKED)', 'refreshPrices')
    .addItem('Turn off Google-side daily refresh', 'disableDailyTrigger')
    .addToUi();
  setupSheets_();
}

function enableDailyTrigger() {
  disableDailyTrigger();
  ScriptApp.newTrigger('refreshPrices').timeBased().everyDays(1).atHour(9).create();
  toast_('Daily refresh is ON (around 9 AM).');
}

function disableDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'refreshPrices')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ------------------------------------------------------------------ main job

/** Google-side refresh. Amazon usually blocks Google's servers (BLOCKED); prefer the PC checker. */
function refreshPrices() {
  const { tracker, history } = setupSheets_();
  const items = listItems_(tracker);
  if (!items.length) { toast_('Paste amazon.in links in column A of "Tracker" first.'); return; }
  const now = new Date();
  const alerts = [];
  items.forEach(it => {
    if (!it.asin) { applyResult_(tracker, history, it.row, {}, 'BAD LINK (no ASIN)', now, alerts); return; }
    let snap, status;
    try {
      snap = fetchProduct_(it.asin);
      status = snap.blocked ? 'BLOCKED (captcha)' : (snap.price == null ? 'NO PRICE FOUND' : 'OK');
    } catch (e) {
      snap = {}; status = 'ERROR: ' + String(e.message || e).slice(0, 80);
    }
    applyResult_(tracker, history, it.row, snap, status, now, alerts);
    Utilities.sleep(GAP_MS);
  });
  if (alerts.length) sendAlerts_(alerts);
  toast_('Checked ' + items.length + ' product(s). Alerts: ' + alerts.length);
}

/** Rows of the Tracker sheet that have a link: [{row, url, asin, target}]. */
function listItems_(tracker) {
  const last = tracker.getLastRow();
  if (last < 2) return [];
  const rows = tracker.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const urls = linkUrls_(tracker.getRange(2, COL.URL, last - 1, 1));
  const out = [];
  rows.forEach((row, i) => {
    if (!urls[i]) return;
    out.push({ row: i + 2, url: urls[i], asin: extractAsin(urls[i]), target: toNum_(row[COL.TARGET - 1]) });
  });
  return out;
}

/** Write one check result to the sheet; push an alert message if the price dropped. */
function applyResult_(tracker, history, r, snap, status, now, alerts) {
  const row = tracker.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  const asin = extractAsin(linkUrls_(tracker.getRange(r, COL.URL, 1, 1))[0]) || '';
  const prevPrice = toNum_(row[COL.PRICE - 1]);
  const prevLowest = toNum_(row[COL.LOWEST - 1]);
  const target = toNum_(row[COL.TARGET - 1]);
  const title = (snap && snap.title) || row[COL.TITLE - 1] || '';

  tracker.getRange(r, COL.ASIN).setValue(asin);
  tracker.getRange(r, COL.TITLE).setValue(title);
  tracker.getRange(r, COL.CHECKED).setValue(now);
  tracker.getRange(r, COL.STATUS).setValue(status);
  history.appendRow([now, asin, title, snap.price ?? '', snap.mrp ?? '', status]);
  if (status !== 'OK') return;

  const p = snap.price;
  tracker.getRange(r, COL.PRICE).setValue(p);
  tracker.getRange(r, COL.MRP).setValue(snap.mrp ?? '');
  tracker.getRange(r, COL.LOWEST).setValue(prevLowest == null ? p : Math.min(prevLowest, p));

  const reasons = [];
  if (target != null && p <= target && (prevPrice == null || prevPrice > target)) {
    reasons.push('at/below your target ₹' + fmt_(target));
  }
  if (prevPrice != null && p < prevPrice && (prevPrice - p) / prevPrice * 100 >= DROP_ALERT_PCT) {
    reasons.push('dropped ' + Math.round((prevPrice - p) / prevPrice * 100) + '% from ₹' + fmt_(prevPrice));
  }
  if (reasons.length) {
    alerts.push('📉 ' + String(title || asin).slice(0, 80) + '\nNow ₹' + fmt_(p) + ': ' +
                reasons.join('; ') + '\nhttps://www.amazon.in/dp/' + asin);
  }
}

// ------------------------------------------------------------------ PC checker web app
// Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
// The PC script calls it with ?key=<access key>. Without the key it refuses everything.

function setupPcKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('PC_KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, ''); props.setProperty('PC_KEY', key); }
  SpreadsheetApp.getUi().alert('PC access key',
    'Your key (keep it private):\n\n' + key +
    '\n\nPut it in config.json on your PC together with the Web app URL ' +
    '(Deploy → Manage deployments → copy the URL ending in /exec).',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authorized_(e) {
  const key = PropertiesService.getScriptProperties().getProperty('PC_KEY');
  return !!key && e && e.parameter && e.parameter.key === key;
}

/** GET ?key=...  → {items: [{row, asin}]} */
function doGet(e) {
  if (!authorized_(e)) return json_({ error: 'unauthorized' });
  const { tracker, history } = setupSheets_();
  const items = listItems_(tracker);
  const now = new Date();
  items.filter(it => !it.asin).forEach(it => applyResult_(tracker, history, it.row, {}, 'BAD LINK (no ASIN)', now, []));
  return json_({ items: items.filter(it => it.asin).map(it => ({ row: it.row, asin: it.asin })) });
}

/** POST ?key=...  body {results: [{row, asin, title, price, mrp, status}]} → {updated, alerts} */
function doPost(e) {
  if (!authorized_(e)) return json_({ error: 'unauthorized' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const { tracker, history } = setupSheets_();
    const now = new Date();
    const alerts = [];
    let updated = 0;
    (body.results || []).forEach(res => {
      const r = Number(res.row);
      if (!(r >= 2) || r > tracker.getLastRow()) return;
      // Only accept a result for the ASIN that is (still) on that row.
      const asin = extractAsin(linkUrls_(tracker.getRange(r, COL.URL, 1, 1))[0]);
      if (!asin || asin !== res.asin) return;
      const status = String(res.status || 'ERROR').slice(0, 100);
      const price = typeof res.price === 'number' ? res.price : null;
      applyResult_(tracker, history, r,
        { title: res.title || null, price: price, mrp: typeof res.mrp === 'number' ? res.mrp : null },
        status === 'OK' && price == null ? 'NO PRICE FOUND' : status, now, alerts);
      updated++;
    });
    if (alerts.length) sendAlerts_(alerts);
    return json_({ updated: updated, alerts: alerts.length });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------ fetch & parse

function fetchProduct_(asin) {
  const res = UrlFetchApp.fetch('https://www.amazon.in/dp/' + asin, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Accept-Language': 'en-IN,en;q=0.9' },
  });
  const code = res.getResponseCode();
  const html = res.getContentText();
  if (code === 503 || isBlockedPage(html)) return { blocked: true };
  if (code >= 400) throw new Error('HTTP ' + code);
  return parseProductPage(html);
}

function extractAsin(s) {
  s = String(s).trim();
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  const m = s.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[\/?#]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function isBlockedPage(html) {
  return /validateCaptcha|Enter the characters you see below|api-services-support@amazon\.com/.test(html);
}

function parseInr(text) {
  if (!text) return null;
  const m = String(text).replace(/₹/g, ' ').match(/[\d,]+(?:\.\d+)?/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : null;
}

function clean_(s) {
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function section_(html, id, len) {
  const i = html.indexOf('id="' + id + '"');
  return i >= 0 ? html.slice(i, i + (len || 6000)) : null;
}

/** Best-effort parse. Amazon changes its markup often; any field may be null. */
function parseProductPage(html) {
  const out = { title: null, price: null, mrp: null };
  let m = html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/);
  if (m) out.title = clean_(m[1]) || null;

  let area = null;
  for (const id of ['corePriceDisplay_desktop_feature_div', 'corePrice_feature_div',
                    'corePrice_desktop', 'apex_desktop']) {
    area = section_(html, id);
    if (area) break;
  }
  area = area || html;

  m = area.match(/class="a-price(?! a-text-price)[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)<\/span>/);
  if (m) out.price = parseInr(m[1]);
  if (out.price == null) {
    m = area.match(/class="a-price-whole">([\d,]+)/);
    if (m) out.price = parseInr(m[1]);
  }
  m = area.match(/class="a-price a-text-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)<\/span>/);
  if (m) out.mrp = parseInr(m[1]);
  return out;
}

// ------------------------------------------------------------------ alerts

function sendAlerts_(alerts) {
  const text = 'Amazon.in price alert\n\n' + alerts.join('\n\n');
  if (EMAIL_ALERTS) {
    const to = Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail(to, 'Amazon.in price drop (' + alerts.length + ')', text);
  }
  const props = PropertiesService.getScriptProperties();
  const phone = props.getProperty('WHATSAPP_TO');
  const key = props.getProperty('CALLMEBOT_APIKEY');
  if (phone && key) {
    alerts.forEach(a => {
      UrlFetchApp.fetch('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(phone) +
        '&text=' + encodeURIComponent(a) + '&apikey=' + encodeURIComponent(key),
        { muteHttpExceptions: true });
      Utilities.sleep(2000);
    });
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Real URL for each cell in a one-column range. Handles plain URLs, pasted links whose
 * text is the product name (rich-text links), and =HYPERLINK("url","text") formulas.
 */
function linkUrls_(range) {
  const values = range.getValues();
  const formulas = range.getFormulas();
  const rich = range.getRichTextValues();
  return values.map((v, i) => {
    const rt = rich[i][0];
    let url = rt && rt.getLinkUrl();
    if (!url && rt) {
      const run = rt.getRuns().find(x => x.getLinkUrl());
      url = run && run.getLinkUrl();
    }
    if (!url) {
      const m = String(formulas[i][0] || '').match(/HYPERLINK\(\s*"([^"]+)"/i);
      url = m && m[1];
    }
    return String(url || v[0] || '').trim();
  });
}

function setupSheets_() {
  const ss = SpreadsheetApp.getActive();
  const tracker = ss.getSheetByName(TRACKER) || ss.insertSheet(TRACKER);
  const history = ss.getSheetByName(HISTORY) || ss.insertSheet(HISTORY);
  if (tracker.getRange(1, 1).getValue() !== HEADERS[0]) {
    tracker.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    tracker.setFrozenRows(1);
  }
  if (history.getRange(1, 1).getValue() !== HISTORY_HEADERS[0]) {
    history.getRange(1, 1, 1, HISTORY_HEADERS.length).setValues([HISTORY_HEADERS]).setFontWeight('bold');
    history.setFrozenRows(1);
  }
  return { tracker, history };
}

function toNum_(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseInr(v);
  return isNaN(n) ? null : n;
}

function fmt_(n) { return Number(n).toLocaleString('en-IN'); }

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'Price Tracker', 5); } catch (e) { /* no UI when run by trigger */ }
}

// Lets the parsing functions be unit-tested in Node (ignored by Apps Script).
if (typeof module !== 'undefined') {
  module.exports = { extractAsin, isBlockedPage, parseInr, parseProductPage };
}
