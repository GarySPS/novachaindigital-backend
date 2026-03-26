//routes>profile.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Ensure uploads dir exists
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer storage, limits and file type filter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed!"));
    }
    cb(null, true);
  }
});


// -------- GET /api/profile (JWT-protected) --------
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, avatar, referral FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });

    const balanceRes = await pool.query(
      "SELECT SUM(balance) as total_usd FROM user_balances WHERE user_id = $1",
      [req.user.id]
    );
    const total_usd = Number(balanceRes.rows[0].total_usd) || 0;

    let avatarUrl = "/logo192_new.png";
    if (row.avatar && typeof row.avatar === "string" && row.avatar.length > 0) {
      // Always serve public URL directly using the dynamic environment variable
      avatarUrl = row.avatar.startsWith("http")
        ? row.avatar
        : `${process.env.SUPABASE_URL}/storage/v1/object/public/avatar/${row.avatar}?t=${Date.now()}`;
    }

    res.json({
      user: {
        id: "NC-" + String(row.id).padStart(7, "0"),
        username: row.username,
        email: row.email,
        balance: total_usd,
        avatar: avatarUrl,   // <--- always a full URL or default!
        referral: row.referral || ""
      }
    });
  } catch (err) {
    console.error("❌ /api/profile error:", err);
    res.status(500).json({ error: "Database error" });
  }
});


// -------- POST /api/profile/avatar --------
// 1. Handle JSON Supabase-style avatar update
router.post('/avatar', authenticateToken, async (req, res, next) => {
  if (req.is('application/json')) {
    const userId = req.user.id;
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "Missing avatar" });
    try {
      await pool.query("UPDATE users SET avatar = $1 WHERE id = $2", [avatar, userId]);
      return res.json({ avatar });
    } catch (err) {
      return res.status(500).json({ error: "Failed to update avatar" });
    }
  }
  next();
});

// 2. Handle multipart upload avatar update (SUPABASE VERSION)
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  const userId = req.user.id;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // Build unique filename for storage
    const ext = path.extname(req.file.originalname);
    const supabaseFilename = `${userId}-${Date.now()}${ext}`;

    // Upload file buffer to Supabase Storage "avatar" bucket
    const { error: uploadError } = await supabase.storage
      .from('avatar')
      .upload(supabaseFilename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });

    if (uploadError) {
      return res.status(500).json({ error: "Failed to upload to Supabase Storage" });
    }

    // Delete old avatar from Supabase Storage (optional, for cleanup)
    const { rows } = await pool.query("SELECT avatar FROM users WHERE id = $1", [userId]);
    const oldAvatar = rows[0]?.avatar;
    if (oldAvatar && oldAvatar !== supabaseFilename) {
      await supabase.storage.from('avatar').remove([oldAvatar]).catch(()=>{});
    }

    // Update DB with new Supabase storage path (just the filename)
    await pool.query(
      "UPDATE users SET avatar = $1 WHERE id = $2",
      [supabaseFilename, userId]
    );

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from('avatar')
      .getPublicUrl(supabaseFilename);

    res.json({ success: true, avatar: publicUrlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to update avatar" });
  }
});



// -------- POST /api/profile/change-password --------
router.post('/change-password', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ error: "Missing old or new password" });
  }
  try {
    const { rows } = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
    const stored = rows[0]?.password;
    if (!stored) {
      return res.status(400).json({ error: "Incorrect old password" });
    }

    let match = false;
    if (stored.startsWith("$2")) {
      match = await bcrypt.compare(old_password, stored);
    } else {
      match = (old_password === stored);
    }

    if (!match) {
      return res.status(400).json({ error: "Incorrect old password" });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [newHash, userId]);
    res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to change password" });
  }
});

module.exports = router;
