// nifty-dip-alert.js
const axios = require("axios");
const { DateTime } = require("luxon");
require("dotenv/config");

/**
 * Expanded ETF/Index list for Indian market.
 * Add or adjust symbols as needed for your Alpha Vantage account.
 */
const WATCHLIST = [
  { name: "Nifty 50 (NIFTYBEES)", symbol: "NIFTYBEES" },
  { name: "Nifty Next 50 (JUNIORBEES)", symbol: "JUNIORBEES" },
  { name: "Nifty Midcap 150 (NETFMID150)", symbol: "NETFMID150" },
  { name: "Nifty Smallcap 250 (MOTISMLCAP)", symbol: "MOTISMLCAP" }, // Example, verify symbol
  { name: "Nifty Bank (BANKBEES)", symbol: "BANKBEES" },
  { name: "Nifty IT (INFY)", symbol: "INFY" }, // Proxy, as IT ETF may not be available
  { name: "Nifty FMCG (NIFTYFMCG)", symbol: "NIFTYFMCG" }, // Example, verify symbol
  // Add more as needed
];

const API_KEY = process.env.ALPHAVANTAGE_API_KEY;
if (!API_KEY) {
  console.error("Missing ALPHAVANTAGE_API_KEY in .env");
  process.exit(1);
}

const THRESHOLD_PCT = -0.5; // -0.5% dip
const EARLY_CUTOFF_MINUTES = Number(process.env.EARLY_CUTOFF_MINUTES ?? 15);

function isWithinTradingAlertWindow(nowIST) {
  const day = nowIST.weekday; // 1=Mon..7=Sun
  if (day > 5) return false;
  const start = nowIST.set({ hour: 9, minute: 20, second: 0, millisecond: 0 });
  const cutoff = nowIST.set({ hour: 15, minute: 0, second: 0, millisecond: 0 }).minus({ minutes: EARLY_CUTOFF_MINUTES });
  return nowIST >= start && nowIST <= cutoff;
}

class Notifier {
  async notify(message) {
    // Override in subclasses
    console.log("[NOTIFY]", message);
  }
}

class TelegramNotifier extends Notifier {
  constructor(botToken, chatId) {
    super();
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async notify(message) {
    if (!this.botToken || !this.chatId) {
      return { ok: false, error: "Missing Telegram credentials" };
    }
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const payload = {
        chat_id: this.chatId,
        text: message,
        parse_mode: "Markdown",
      };
      const { data } = await axios.post(url, payload, { timeout: 10000 });
      return { ok: true, telegram: data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

class ConsoleNotifier extends Notifier {
  async notify(message) {
    console.log("[ALERT]", message);
  }
}

async function fetchQuote(symbol) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const q = data?.["Global Quote"];
  if (!q || !q["05. price"] || !q["08. previous close"]) {
    const fallback = await fetchIntraday5Min(symbol);
    return fallback;
  }
  const price = Number(q["05. price"]);
  const prevClose = Number(q["08. previous close"]);
  return { symbol, price, prevClose, source: "GLOBAL_QUOTE" };
}

async function fetchIntraday5Min(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=compact&apikey=${API_KEY}`;
    const { data } = await axios.get(url, { timeout: 20000 });
    const ts = data?.["Time Series (5min)"];
    if (!ts) return null;
    const times = Object.keys(ts).sort().reverse();
    const latest = ts[times[0]];
    const price = Number(latest["4. close"]);
    const daily = await fetchDailyPrevClose(symbol);
    if (!daily) return null;
    return { symbol, price, prevClose: daily.prevClose, source: "INTRADAY+DAILY" };
  } catch {
    return null;
  }
}

async function fetchDailyPrevClose(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${API_KEY}`;
    const { data } = await axios.get(url, { timeout: 20000 });
    const ts = data?.["Time Series (Daily)"];
    if (!ts) return null;
    const days = Object.keys(ts).sort().reverse();
    const latest = ts[days[0]];
    const prev = ts[days[1]];
    const prevClose = prev ? Number(prev["4. close"]) : Number(latest["4. close"]);
    return { prevClose };
  } catch {
    return null;
  }
}

function pctChange(latest, prior) {
  if (!isFinite(latest) || !isFinite(prior) || prior === 0) return null;
  return ((latest - prior) / prior) * 100;
}

let lastDips = []; // Store last dips for /get endpoint

async function checkWatchlist(notifier = new ConsoleNotifier(), skipNotify = false) {
  const nowIST = DateTime.now().setZone("Asia/Kolkata");
  if (!isWithinTradingAlertWindow(nowIST)) {
    return { ok: false, message: "Outside alert window", dips: [] };
  }

  const dips = [];
  for (let i = 0; i < WATCHLIST.length; i++) {
    const item = WATCHLIST[i];
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 1300));
      const quote = await fetchQuote(item.symbol);
      if (!quote) continue;
      const change = pctChange(quote.price, quote.prevClose);
      if (change === null) continue;
      if (change <= THRESHOLD_PCT) {
        const msg =
          `🚨 Dip Alert\n` +
          `${item.name} (${item.symbol}) is ${change.toFixed(2)}% vs prev close.\n` +
          `Price: ₹${quote.price.toFixed(2)} | Prev: ₹${quote.prevClose.toFixed(2)}\n` +
          `(${nowIST.toFormat("dd LLL yyyy HH:mm")} IST)`;

        let telegramResponse = null;
        if (!skipNotify) {
          await notifier.notify(msg);
          if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
            const tgNotifier = new TelegramNotifier(process.env.TG_BOT_TOKEN, process.env.TG_CHAT_ID);
            telegramResponse = await tgNotifier.notify(msg);
          }
        }

        dips.push({
          name: item.name,
          symbol: item.symbol,
          price: quote.price,
          prevClose: quote.prevClose,
          change: Number(change.toFixed(2)),
          time: nowIST.toISO(),
          telegram: telegramResponse, // Only here, not in /get
        });
      }
    } catch (e) {
      // Optionally log error
    }
  }
  lastDips = dips.map(d => {
    // Remove telegram field for /get endpoint
    const { telegram, ...rest } = d;
    return rest;
  });
  return { ok: true, dips };
}

// Vercel/Express compatible handler
async function handler(req, res) {
  // For Vercel, req/res are provided; for Express, same signature
  if (req.url === "/get" && req.method === "GET") {
    // Return last dips in JSON, no Telegram response
    res.setHeader("Content-Type", "application/json");
    res.status(200).json({ ok: true, dips: lastDips });
    return;
  }
  const result = await checkWatchlist();
  // Remove telegram field from dips for main response, but keep it in a subfield if present
  const dips = result.dips.map(d => {
    const { telegram, ...rest } = d;
    return rest;
  });
  const telegramResponses = result.dips.map(d => d.telegram).filter(Boolean);
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    ok: result.ok,
    dips,
    telegram: telegramResponses.length ? telegramResponses : undefined,
  });
}
checkWatchlist()

// For Vercel: export as default
module.exports = handler;

// For local/CLI testing, uncomment below:
if (require.main === module) {
  checkWatchlist().then(console.log);
}
