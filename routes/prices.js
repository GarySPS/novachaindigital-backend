// routes/prices.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// --- Config ---
const TWELVE_API_KEY = process.env.TWELVE_API_KEY; // Read Twelve Data key from .env

const CG_ID = {
  bitcoin: "bitcoin",
  btc: "bitcoin",
  ethereum: "ethereum",
  tether: "tether",
  solana: "solana",
  ripple: "ripple",
  toncoin: "toncoin",
};

// --- Binance Symbols for direct matching ---
const BINANCE_SYMBOL = {
  bitcoin: "BTCUSDT",
  btc: "BTCUSDT",
  ethereum: "ETHUSDT",
  tether: "USDT",
  solana: "SOLUSDT",
  ripple: "XRPUSDT",
  toncoin: "TONUSDT",
};

// --- Commodity Symbols for Twelve Data ---
const TWELVE_SYMBOL = {
  xau: "XAU/USD",
  xag: "XAG/USD",
  wti: "WTI/USD",
  natgas: "NG/USD",
  xcu: "XCU/USD",
};

// Helper to check if it's a known Forex/Commodity
function isForexOrCommodity(apiSymbol) {
    return !!TWELVE_SYMBOL[apiSymbol?.toLowerCase()];
}

// Helper to check if it's a known Crypto for CoinGecko
function isCrypto(apiSymbol) {
    return !!CG_ID[apiSymbol?.toLowerCase()];
}


// --- Caches (Keep as is) ---
const symbolCache = {}; // Cache structure: { 'bitcoin': { t: ms, price, high_24h, ... }, 'xau': { ... } }
const LIST_REFRESH_MS = 60000;
const SYMBOL_STALE_OK_MS = 5 * 60_000;

/* GET /api/prices/:symbol - Handles Crypto, Forex, and Commodities */
router.get("/:symbol", async (req, res) => {
  const requestedApiSymbol = req.params.symbol.toLowerCase(); // e.g., 'bitcoin', 'xau', 'eurusd'
  const now = Date.now();

  console.log(`Received price request for: ${requestedApiSymbol}`);

  // ===== FIX: Force USDT to always be $1.00 =====
  if (requestedApiSymbol === 'usdt' || requestedApiSymbol === 'tether') {
    return res.json({
      symbol: requestedApiSymbol,
      price: 1.00,
      high_24h: 1.00,
      low_24h: 1.00,
      volume_24h: 100000000,
      percent_change_24h: 0.00,
      cached: true
    });
  }
  // ==============================================

  // --- Check Cache First ---
  if (symbolCache[requestedApiSymbol] && now - symbolCache[requestedApiSymbol].t < LIST_REFRESH_MS) {
    console.log(`Serving cached data for ${requestedApiSymbol}`);
    return res.json({
      symbol: requestedApiSymbol,
      ...symbolCache[requestedApiSymbol],
      cached: true
    });
  }

  // --- Determine Asset Type and Fetch ---
  let priceData = null;

  try {
    // Check if it's Forex or Commodity first
    if (isForexOrCommodity(requestedApiSymbol)) {
        console.log(`Identified ${requestedApiSymbol} as Forex/Commodity. Using Twelve Data.`);
        if (!TWELVE_API_KEY) throw new Error("Twelve Data API Key not configured");

        const twelveSymbol = TWELVE_SYMBOL[requestedApiSymbol];
        if (!twelveSymbol) throw new Error(`No Twelve Data symbol mapping for ${requestedApiSymbol}`);

        // --- Fetch from Twelve Data ---
        let currentPrice = null;
        let high_24h = null;
        let low_24h = null;
        let volume_24h = null;
        let percent_change_24h = null;

        try {
            // 1. Get current price (1 API call)
            const priceUrl = `https://api.twelvedata.com/price?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
            console.log(`Fetching Twelve Data price for ${requestedApiSymbol} (${twelveSymbol})`);
            const { data: priceResponse } = await axios.get(priceUrl, { timeout: 4000 });
            currentPrice = Number(priceResponse?.price);

            // 2. Get 24h stats (Quote Endpoint) (1 API call)
            const quoteUrl = `https://api.twelvedata.com/quote?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
            console.log(`Fetching Twelve Data quote for ${requestedApiSymbol} (${twelveSymbol})`);
            const { data: quoteResponse } = await axios.get(quoteUrl, { timeout: 4000 });

            if (quoteResponse) {
                high_24h = Number(quoteResponse.high);
                low_24h = Number(quoteResponse.low);
                percent_change_24h = Number(quoteResponse.percent_change);
                volume_24h = Number(quoteResponse.volume); 
            }

        } catch (tdErr) {
            console.warn(`Twelve Data request failed for ${requestedApiSymbol}: ${tdErr.message}`);
            currentPrice = null; 
        }

        // --- Check for failure and use synthetic data ---
        if (!isFinite(currentPrice) || currentPrice <= 0) {
            console.warn(`⚠️ Twelve Data failed for ${requestedApiSymbol}. Using synthetic fallback.`);
            priceData = getSyntheticData(requestedApiSymbol);
        } else {
            // --- Success! Map the data ---
             priceData = {
                price: currentPrice,
                high_24h: isFinite(high_24h) ? high_24h : null,
                low_24h: isFinite(low_24h) ? low_24h : null,
                volume_24h: isFinite(volume_24h) ? volume_24h : null,
                percent_change_24h: isFinite(percent_change_24h) ? percent_change_24h : null,
            };
        }
        
    } else if (isCrypto(requestedApiSymbol)) {
    // --- Fetch Crypto Data using Binance to match TradingView ---
    console.log(`Identified ${requestedApiSymbol} as Crypto.`);
    const binanceSym = BINANCE_SYMBOL[requestedApiSymbol];

    if (!binanceSym) {
        throw new Error(`Unsupported crypto symbol: ${requestedApiSymbol}`);
    }

    try {
        // Primary Binance 24hr ticker
        const binUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`;
        console.log(`Fetching Binance 24hr data for ${binanceSym}`);
        const { data: bData } = await axios.get(binUrl, { timeout: 8000 });

        priceData = {
            price: Number(bData.lastPrice),
            high_24h: Number(bData.highPrice),
            low_24h: Number(bData.lowPrice),
            volume_24h: Number(bData.quoteVolume),
            percent_change_24h: Number(bData.priceChangePercent),
        };

        // Safety check: fallback retry only if price is invalid
        if (!priceData || !isFinite(priceData.price) || priceData.price <= 0) {
            console.warn(`⚠️ Binance price invalid for ${requestedApiSymbol}. Retrying simple lastPrice endpoint...`);
            const retry = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`);
            priceData = {
                price: Number(retry.data.price),
                high_24h: Number(retry.data.price),
                low_24h: Number(retry.data.price),
                volume_24h: 0,
                percent_change_24h: 0,
            };
        }

    } catch (err) {
        console.error(`Binance fetch failed for ${requestedApiSymbol}: ${err.message}`);
        throw new Error(`CRITICAL: Unable to fetch Binance price for ${requestedApiSymbol}`);
    }
} else {
        throw new Error(`Unsupported symbol/id: ${requestedApiSymbol}`);
    }

    if (!priceData) {
        throw new Error(`Invalid or zero price data processed for ${requestedApiSymbol}`);
    }

    symbolCache[requestedApiSymbol] = { t: now, ...priceData };
    return res.json({ symbol: requestedApiSymbol, ...priceData });

  } catch (err) {
    console.error(`CRITICAL ERROR processing ${requestedApiSymbol}:`, err.message);
    
    if (symbolCache[requestedApiSymbol] && now - symbolCache[requestedApiSymbol].t <= SYMBOL_STALE_OK_MS) {
      return res.json({
        symbol: requestedApiSymbol,
        ...symbolCache[requestedApiSymbol],
        stale: true
      });
    }

    // REMOVED: Fake Synthetic Data. 
    // It is better to show "Loading..." on the frontend than a fake price.
    return res.status(503).json({ 
      error: "LIVE_DATA_UNAVAILABLE", 
      symbol: requestedApiSymbol, 
      detail: err.message 
    });
  }
});

// Cache for the full list
let listCache = { t: 0, data: [] };
const LIST_CACHE_DURATION = 10_000; // Cache the full list for 10 seconds

/* GET /api/prices - Fetches the list of top cryptocurrencies */
router.get("/", async (req, res) => {
  const now = Date.now();
  // Vercel Hobby plan might limit concurrent requests or timeout. Reduce limit?
  const limit = Math.min(parseInt(req.query.limit) || 100, 100); // Limit to 100 max

  console.log(`Received price list request with limit: ${limit}`);

  // --- Check List Cache ---
  if (listCache.data.length > 0 && now - listCache.t < LIST_CACHE_DURATION) {
    console.log(`Serving cached list data (first ${limit} items).`);
    return res.json({ data: listCache.data.slice(0, limit) });
  }

  // --- Fetch fresh list from CoinGecko ---
  try {
    const cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`;
    console.log(`Fetching CoinGecko market list from: ${cgUrl}`);

    // Increased timeout for potentially slower Vercel Hobby plan network
    const { data: cgDataArr } = await axios.get(cgUrl, { timeout: 15000 });
    console.log(`Received CoinGecko market list response. Count: ${cgDataArr?.length}`);

    if (!cgDataArr || !Array.isArray(cgDataArr)) {
      throw new Error("Invalid data received from CoinGecko markets endpoint");
    }

    // --- Map CoinGecko data ---
    const formattedData = cgDataArr.map(coin => {
        
        // FIX: Override USDT price/change in the list data
        let finalPrice = coin.current_price;
        let finalChange = coin.price_change_percentage_24h;
        
        if (coin.symbol.toUpperCase() === 'USDT' || coin.id === 'tether') {
            finalPrice = 1.00;
            finalChange = 0.00;
        }
        
        return {
            id: coin.id,
            name: coin.name,
            symbol: coin.symbol.toUpperCase(),
            cmc_rank: coin.market_cap_rank,
            quote: {
                USD: {
                    price: finalPrice, // Use the fixed price
                    volume_24h: coin.total_volume,
                    percent_change_24h: finalChange, // Use the fixed change (0%)
                    market_cap: coin.market_cap,
                }
            },
        };
    });

    console.log(`Successfully formatted ${formattedData.length} coins.`);

    // Update list cache only if data is valid
    if (formattedData.length > 0) {
        listCache = { t: now, data: formattedData };
        console.log(`Updated list cache.`);
    }

    return res.json({ data: formattedData });

  } catch (err) {
    console.error("ERROR fetching CoinGecko market list:", err.message);
     if (err.response) {
       console.error("Axios Response Error Data:", err.response.data);
       console.error("Axios Response Error Status:", err.response.status);
     } else if (err.request) {
       // Log request details if available (might be large)
       console.error("Axios Request Error:", "Request made but no response received or network error.");
     }


    // --- Stale List Cache Fallback ---
    if (listCache.data.length > 0 && now - listCache.t <= SYMBOL_STALE_OK_MS) {
        console.warn(`Serving stale list cache due to error (first ${limit} items).`);
        return res.json({ data: listCache.data.slice(0, limit), stale: true });
    }

    // --- Final Error ---
    console.error(`No live or stale list data available. Sending 503.`);
    // Send a clearer error message
    return res.status(503).json({ error: "MARKET_DATA_UNAVAILABLE", message: "Could not fetch market list data.", detail: err.message });
  }
});

const STATIC_PRICE_FALLBACKS = {
  xau: 4235.62,
  xag: 50.14,
  wti: 57.95,
  natgas: 4.67,
  xcu: 5.12,
  // Add crypto defaults
  bitcoin: 93752.5,
  btc: 3752.5,
  ethereum: 3210.65,
  solana: 145.40,
  ripple: 2.2,
  toncoin: 1.64,
  tether: 1.00,
  usdt: 1.00,
};

function getSyntheticData(symbol) {
  const base = STATIC_PRICE_FALLBACKS[symbol] || 100;
  const rand = (Math.random() - 0.5) * 0.02; // ±1% jitter
  const price = base * (1 + rand);
  const high = price * (1 + 0.01);
  const low = price * (1 - 0.01);
  const volume = 1_000_000 * (1 + Math.random());
  const change = (Math.random() - 0.5) * 2; // ±1% change
  return {
    price: Number(price.toFixed(2)),
    high_24h: Number(high.toFixed(2)),
    low_24h: Number(low.toFixed(2)),
    volume_24h: Math.round(volume),
    percent_change_24h: Number(change.toFixed(2)),
  };
}


module.exports = router;