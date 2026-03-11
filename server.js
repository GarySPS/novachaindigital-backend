//server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const pool = require('./db');

// JWT Middleware
const { authenticateToken } = require('./middleware/auth');

// ROUTES
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const tradeRoutes = require('./routes/trade');
const pricesRoutes = require('./routes/prices');      
const depositRoutes = require('./routes/deposit');
const withdrawalRoutes = require('./routes/withdrawal');
const kycRoutes = require('./routes/kyc');
const profileRoutes = require('./routes/profile');    
const balanceRoutes = require('./routes/balance');
const convertRoutes = require('./routes/convert');
const balanceHistoryRoutes = require('./routes/balanceHistory');
const userRoutes = require('./routes/user');
const uploadRoute = require('./routes/upload');
const earnRoutes = require('./routes/earn');

const app = express();

const allowedOrigins = [
  'https://novachain-frontend.vercel.app',
  'http://localhost:3000',
  'https://novachain.pro',
  'https://www.novachain.pro',
  'https://novachain-frontend-garys-projects-331bf079.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json());
app.use('/api/balance/history', balanceHistoryRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoute);

// --- Multer upload config ---
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// --------- ROUTE MOUNTING ---------
app.use('/api/admin', adminRoutes);
app.use('/api/trade', tradeRoutes);
app.use('/api/prices', pricesRoutes);
app.use('/api/price', pricesRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/withdraw', withdrawalRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/balance', balanceRoutes);
app.use('/api/convert', convertRoutes);     
app.use('/api/users', userRoutes);
app.use('/api/earn', earnRoutes);

// --------- BASIC ROOT CHECK ---------
app.get("/", (req, res) => {
  res.send("NovaChain API is running.");
});

// --- Fetch deposit addresses for user deposit modal (public, no auth needed) ---
app.get('/api/deposit-addresses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT coin, address, qr_url FROM deposit_addresses`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch deposit addresses" });
  }
});

// --- ADMIN: Fetch ALL trades for admin backend ---
app.get('/api/trades', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM trades ORDER BY timestamp DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Catch-all for unknown API routes
app.use((req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// --------- START SERVER ---------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// Keep-Alive Mechanism (Pings the server every 14 minutes)
const https = require('https');

setInterval(() => {
  // REPLACE with your actual Render Backend URL
  const backendUrl = 'https://novachain-backend.onrender.com'; 

  https.get(backendUrl, (res) => {
    console.log(`Self-ping sent to ${backendUrl}. Status: ${res.statusCode}`);
  }).on('error', (e) => {
    console.error(`Self-ping failed: ${e.message}`);
  });
}, 14 * 60 * 1000); // 14 minutes (Render sleeps at 15)