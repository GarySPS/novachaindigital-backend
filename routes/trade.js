// routes/trade.js — FREE live pricing (CoinGecko + Binance)
require("dotenv").config();
const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../db");
const { authenticateToken } = require("../middleware/auth"); // keep if used

/* -------------------- Helpers -------------------- */
const ALLOWED_COINS = ["BTC", "ETH", "SOL", "XRP", "TON"];
const ALLOWED_FOREX = ["XAU", "XAG", "WTI", "NATGAS", "XCU"];

// Normalize "btc/usdt", "BTCUSDT", "btc-usdt" -> "BTC"
function normalizeSymbol(input) {
  if (!input) return "";
  let s = String(input).trim().toUpperCase().replace(/\s+/g, "");

  // split composite pairs like "TON/USDT" or "eth-usd"
  if (s.includes("/")) s = s.split("/")[0];
  if (s.includes("-")) s = s.split("-")[0];

  // only strip the suffix if there's something BEFORE it
  if (s !== "USDT" && s.endsWith("USDT")) s = s.slice(0, -4);
  if (s !== "USD"  && s.endsWith("USD"))  s = s.slice(0, -3);

  return s;
}


// "buy"/"sell" -> "BUY"/"SELL"
function normalizeDirection(input) {
  const d = String(input || "").trim().toUpperCase();
  if (d === "BUY" || d === "SELL") return d;
  if (d === "LONG") return "BUY";
  if (d === "SHORT") return "SELL";
  return d.includes("SELL") ? "SELL" : "BUY";
}

const TWELVE_API_KEY = process.env.TWELVE_API_KEY;

// API Symbol -> Twelve Data Symbol (must be UPPERCASE)
const TWELVE_SYMBOL = {
  XAU: "XAU/USD",
  XAG: "XAG/USD",
  WTI: "CL=F",
  NATGAS: "NG=F",
  XCU: "HG=F",
};

// Helper to check if it's a known Forex/Commodity
function isForexOrCommodity(sym) {
  return !!TWELVE_SYMBOL[sym]; // Check uppercase symbol
}

async function getSpotUSD(symbol) {
  const sym = String(symbol || "").toUpperCase(); // sym is "BTC", "XAU", etc.

  // --- Check if Forex/Commodity (Twelve Data) ---
  if (isForexOrCommodity(sym)) {
    try {
      if (!TWELVE_API_KEY) throw new Error("Twelve Data API Key not configured");
      const twelveSymbol = TWELVE_SYMBOL[sym]; // e.g., "XAU/USD"
      const priceUrl = `https://api.twelvedata.com/price?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
      
      console.log(`Fetching Twelve Data price for ${sym} (${twelveSymbol})`);
      const { data: priceResponse } = await axios.get(priceUrl, { timeout: 7000 });
      
      const price = Number(priceResponse?.price);
      if (isFinite(price) && price > 0) {
        console.log(`Success (Twelve Data) ${sym}: ${price}`);
        return price;
      }
      throw new Error("Invalid price from Twelve Data");
    } catch (err) {
      console.error(`Twelve Data fetch failed for ${sym}: ${err.message}`);
      // Throw error because we know it's not crypto
      throw new Error(`LIVE_PRICE_UNAVAILABLE (Forex: ${sym})`);
    }
  }

  // --- Check if Crypto (Binance first to match chart, then Coinbase) ---
  const isCrypto = ["BTC", "ETH", "SOL", "XRP", "TON"].includes(sym);
  
  if (isCrypto) {
    // ----- Primary: Binance -----
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`;
      const { data } = await axios.get(url, { timeout: 7000 });
      const price = Number(data?.price);
      if (isFinite(price) && price > 0) return price;
    } catch {}

    // ----- Fallback: Coinbase -----
    try {
      const url = `https://api.coinbase.com/v2/prices/${sym}-USD/spot`;
      const { data } = await axios.get(url, {
        timeout: 7000,
        headers: { "CB-VERSION": "2023-01-01" },
      });
      const price = Number(data?.data?.amount);
      if (isFinite(price) && price > 0) return price;
    } catch {}
  }

  throw new Error(`LIVE_PRICE_UNAVAILABLE (Crypto/All: ${sym})`);
}

// --- Fake result price helpers (tiny, realistic gap) ---
function _priceDecimals(sym) {
  if (sym === "XRP" || sym === "TON") return 4;
  // All Commodities use 2 decimals
  if (ALLOWED_FOREX.includes(sym)) return 2;
  // Default (BTC, ETH, SOL)
  return 2;
}
// WITH THIS (and pass 'sym' as an argument):
function _calcGap(startPrice, sym) {
  const pct = 0.0002 + Math.random() * 0.0006; // 0.02%–0.08%
  let minTick;

  if (ALLOWED_FOREX.includes(sym)) {
    minTick = 0.01; // e.g., Gold $3978.37 -> $3978.38
  } else if (sym === "XRP" || sym === "TON") {
    minTick = 0.0001;
  } else if (sym === "SOL") {
    minTick = 0.01;
  } else {
    minTick = 0.1; // Default for BTC, ETH
  }
  
  const raw = startPrice * pct;
  return Math.max(raw, minTick);
}
function _fakeResultPrice(startPrice, direction, result, symbol) {
  const gap = _calcGap(startPrice);
  let p;
  if (result === "WIN") {
    p = direction === "BUY" ? startPrice + gap : startPrice - gap;
  } else {
    p = direction === "BUY" ? startPrice - gap : startPrice + gap;
  }
  return Number(p.toFixed(_priceDecimals(symbol)));
}

async function getUserTradeMode(user_id) {
  const { rows } = await pool.query("SELECT mode FROM user_trade_modes WHERE user_id = $1", [user_id]);
  return (rows[0] && rows[0].mode) || null;
}
async function getTradeMode() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'TRADE_MODE'");
  return (rows[0] && rows[0].value) || "AUTO";
}

/* -------------------- Admin: set global trade mode -------------------- */
router.post("/set-trade-mode", async (req, res) => {
  const { mode } = req.body;
  if (!["AUTO", "ALL_WIN", "ALL_LOSE"].includes(mode)) {
    return res.status(400).json({ error: "Invalid trade mode" });
  }
  try {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('TRADE_MODE', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [mode]
    );
    res.json({ success: true, mode });
  } catch {
    res.status(500).json({ error: "Failed to update mode" });
  }
});

/* -------------------- POST /api/trade -------------------- */
router.post("/", async (req, res) => {
  try {
    let { user_id, direction, amount, duration, symbol } = req.body;
    if (!user_id || !direction || !amount || !duration) {
      return res.status(400).json({ error: "Missing trade data" });
    }

    const normSymbol = normalizeSymbol(symbol || "BTC");  // e.g., "BTC"
    const normDirection = normalizeDirection(direction);  // "BUY"/"SELL"

    if (!ALLOWED_COINS.includes(normSymbol) && !ALLOWED_FOREX.includes(normSymbol)) {
      return res.status(400).json({ error: "Invalid coin symbol" });
    }

    const safeDuration = Math.max(5, Math.min(120, Number(duration)));
    const safeAmount = Math.max(1, Number(amount));

    // Check user and balance
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [user_id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const usdtRes = await pool.query(
      "SELECT * FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const usdt = usdtRes.rows[0];
    if (!usdt || parseFloat(usdt.balance) < safeAmount) {
      return res.status(400).json({ error: "Insufficient USDT" });
    }

// (optional) client-side price from the UI we can trust as a last resort
const client_price = Number(req.body.client_price);

let start_price = NaN;
try {
  start_price = await getSpotUSD(normSymbol);
} catch { /* fall through */ }

// If server fetch failed, but client provided a sane price, use it
if (!isFinite(start_price) || start_price <= 0) {
  if (isFinite(client_price) && client_price > 0) {
    start_price = client_price;
  } else {
    // final hard fallback so trades never break
    const fallback = { BTC: 65000, ETH: 3400, SOL: 140, XRP: 0.6, TON: 7.0 };
    start_price = fallback[normSymbol] || 1;
  }
}

// normalize decimals for display consistency
const entryDecimals = (normSymbol === "XRP" || normSymbol === "TON") ? 4 : 2;
start_price = Number(start_price.toFixed(entryDecimals));


    // 2) Deduct stake
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = 'USDT'",
      [safeAmount, user_id]
    );

    // 3) Save pending trade
    const timestamp = new Date().toISOString();
    const insertTradeRes = await pool.query(
      `INSERT INTO trades 
        (user_id, symbol, direction, amount, duration, start_price, result, profit, result_price, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id`,
      [user.id, normSymbol, normDirection, safeAmount, safeDuration, start_price, "PENDING", 0, null, timestamp]
    );
    const trade_id = insertTradeRes.rows[0].id;

// 4) Finish trade after countdown using ADMIN/AUTO mode and FAKE result price
setTimeout(async () => {
  try {
    // mode (user override > global)
    let mode = await getUserTradeMode(user_id);
    if (!mode) mode = await getTradeMode();

    // WITH THIS (Fixed Payout Map):
    // Fixed Payout Map from Frontend UI (in decimal)
    const FIXED_PROFIT_MAP = {
      30: 0.30,  // 30%
      60: 0.50,  // 50%
      90: 0.70,  // 70%
      120: 1.00, // 100%
    };

    // Calculate payout percent from the fixed map
    // Default to 30% if duration is not 30, 60, 90, or 120 (e.g., if safeDuration was clamped to 5s)
    let profitRate = FIXED_PROFIT_MAP[safeDuration] || 0.30; 
    
    // Convert rate to percentage (e.g., 0.30 -> 30)
    let percent = profitRate * 100;

    // We may still look at the market to decide AUTO result,
    // but we will NOT use it for displayed result_price.
    let end_price_for_decision = start_price;
    try {
      end_price_for_decision = await getSpotUSD(normSymbol);
    } catch {
      /* ignore – fall back to start_price for decision */
    }

    // decide result
    let result;
    if (mode === "WIN" || mode === "ALL_WIN") {
      result = "WIN";
    } else if (mode === "LOSE" || mode === "ALL_LOSE") {
      result = "LOSE";
    } else {
      const wentUp = end_price_for_decision >= start_price;
      const buyWins = normDirection === "BUY" && wentUp;
      const sellWins = normDirection === "SELL" && !wentUp;
      result = (buyWins || sellWins) ? "WIN" : "LOSE";
    }

    // compute profit (binary: win = +amount * percent, loss = -amount)
    let profit = Number((safeAmount * percent / 100).toFixed(2));
    if (result === "LOSE") profit = -safeAmount;

// --- compute a tiny, realistic fake result price around start_price ---
const _priceDecimals = (sym) => (sym === "XRP" || sym === "TON") ? 4 : 2;
const _calcGap = (sp) => {
  const pct = 0.0002 + Math.random() * 0.0006; // 0.02%–0.08%
  const minTick = sp < 2 ? 0.0001 : sp < 100 ? 0.01 : 0.1;
  const raw = sp * pct;
  return Math.max(raw, minTick);
};
const _gap = _calcGap(start_price, normSymbol);

// If WIN: BUY -> higher than start, SELL -> lower than start
// If LOSS: invert the direction relative to start
let _rp = start_price;
if (result === "WIN") {
  _rp = (normDirection === "BUY") ? start_price + _gap : start_price - _gap;
} else {
  _rp = (normDirection === "BUY") ? start_price - _gap : start_price + _gap;
}
const result_price = Number(_rp.toFixed(_priceDecimals(normSymbol)));

    // persist settlement
    await pool.query(
      `UPDATE trades SET result = $1, profit = $2, result_price = $3 WHERE id = $4`,
      [result, profit, result_price, trade_id]
    );

    // credit if win: return stake + profit (stake was already deducted at entry)
    if (result === "WIN") {
      await pool.query(
        `UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = 'USDT'`,
        [safeAmount + profit, user_id]
      );
    }

    // snapshot
    const { rows: balRows } = await pool.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const newBalance = balRows[0] ? parseFloat(balRows[0].balance) : 0;
    await pool.query(
      `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
       VALUES ($1, $2, $3, $4, NOW())`,
      [user_id, "USDT", newBalance, 1]
    );
  } catch (err) {
    console.error("Trade finish error:", err);
  }
}, safeDuration * 1000);

    res.json({
      status: "pending",
      trade_id,
      start_price,
      symbol: normSymbol,
      direction: normDirection,
      amount: safeAmount,
      duration: safeDuration,
      message: "Trade started! Wait for countdown..."
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- History & Admin -------------------- */
router.get("/history/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM trades WHERE user_id = $1 ORDER BY timestamp DESC`,
      [user_id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: "DB error" });
  }
});

router.get("/trades", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        t.id AS trade_id,
        t.user_id,
        u.username,
        t.direction,
        t.amount,
        t.duration,
        t.result,
        t.profit,
        t.timestamp
      FROM trades t
      LEFT JOIN users u ON t.user_id = u.id
      ORDER BY t.timestamp DESC
    `);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

module.exports = router;
