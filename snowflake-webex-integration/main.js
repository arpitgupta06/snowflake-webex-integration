require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const app = express();

// Credentials loaded from .env
const WEBEX_CLIENT_ID     = process.env.WEBEX_CLIENT_ID;
const WEBEX_CLIENT_SECRET = process.env.WEBEX_CLIENT_SECRET;

const SNOWFLAKE_CLIENT_ID     = process.env.SNOWFLAKE_CLIENT_ID;
const SNOWFLAKE_CLIENT_SECRET = process.env.SNOWFLAKE_CLIENT_SECRET;
const SNOWFLAKE_AUTH_URL      = process.env.SNOWFLAKE_AUTH_URL;
const SNOWFLAKE_TOKEN_URL     = process.env.SNOWFLAKE_TOKEN_URL;

const REDIRECT_URI = process.env.REDIRECT_URI;
const PORT         = process.env.PORT || 3000;

// In-memory store for PKCE verifier per session (use a proper session store in production)
const pkceStore = new Map();

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(64).toString("base64url");
}
function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ─── Route 1: Webex login (get Webex identity token) ─────────────────────────
app.get("/login/webex", (req, res) => {
  const authUrl =
    `https://webexapis.com/v1/authorize?response_type=code` +
    `&client_id=${WEBEX_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=openid%20email%20profile` +
    `&state=webex`;
  res.redirect(authUrl);
});

// ─── Route 2: Snowflake login (get Snowflake OAuth token with PKCE) ───────────
app.get("/login/snowflake", (req, res) => {
  const verifier  = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state     = crypto.randomBytes(16).toString("hex");

  pkceStore.set(state, verifier);

  const authUrl =
    `${SNOWFLAKE_AUTH_URL}?response_type=code` +
    `&client_id=${encodeURIComponent(SNOWFLAKE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=session%3Arole%3APUBLIC` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`;
  res.redirect(authUrl);
});

// ─── Shared callback ──────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({ error });
  }

  try {
    // Snowflake callback — state matches a stored PKCE verifier
    if (pkceStore.has(state)) {
      const verifier = pkceStore.get(state);
      pkceStore.delete(state);

      const token = await axios.post(
        SNOWFLAKE_TOKEN_URL,
        new URLSearchParams({
          grant_type:    "authorization_code",
          client_id:     SNOWFLAKE_CLIENT_ID,
          client_secret: SNOWFLAKE_CLIENT_SECRET,
          code,
          redirect_uri:  REDIRECT_URI,
          code_verifier: verifier
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      return res.json({ provider: "snowflake", ...token.data });
    }

    // Webex callback — state === "webex"
    if (state === "webex") {
      const token = await axios.post(
        "https://webexapis.com/v1/access_token",
        new URLSearchParams({
          grant_type:    "authorization_code",
          client_id:     WEBEX_CLIENT_ID,
          client_secret: WEBEX_CLIENT_SECRET,
          code,
          redirect_uri:  REDIRECT_URI
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      return res.json({ provider: "webex", ...token.data });
    }

    res.status(400).json({ error: "Unknown state / callback origin" });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`  Webex login     -> http://localhost:${PORT}/login/webex`);
  console.log(`  Snowflake login -> http://localhost:${PORT}/login/snowflake`);
});