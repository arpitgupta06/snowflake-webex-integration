require("dotenv").config();

const express  = require("express");
const axios    = require("axios");
const crypto   = require("crypto");
const snowflake = require("snowflake-sdk");

const app = express();
app.use(express.json());

// ── Credentials ───────────────────────────────────────────────────────────────
const WEBEX_CLIENT_ID     = process.env.WEBEX_CLIENT_ID;
const WEBEX_CLIENT_SECRET = process.env.WEBEX_CLIENT_SECRET;
const WEBEX_BOT_TOKEN     = process.env.WEBEX_BOT_TOKEN;
const BOT_ID              = process.env.BOT_ID;

const SNOWFLAKE_CLIENT_ID     = process.env.SNOWFLAKE_CLIENT_ID;
const SNOWFLAKE_CLIENT_SECRET = process.env.SNOWFLAKE_CLIENT_SECRET;
const SNOWFLAKE_AUTH_URL      = process.env.SNOWFLAKE_AUTH_URL;
const SNOWFLAKE_TOKEN_URL     = process.env.SNOWFLAKE_TOKEN_URL;

const REDIRECT_URI = process.env.REDIRECT_URI;
const PORT         = process.env.PORT || 3000;

// ── Snowflake connection ──────────────────────────────────────────────────────
const sfConnection = snowflake.createConnection({
  account:   process.env.SNOWFLAKE_ACCOUNT,
  username:  process.env.SNOWFLAKE_USERNAME,
  password:  process.env.SNOWFLAKE_PASSWORD,
  database:  process.env.SNOWFLAKE_DATABASE,
  schema:    process.env.SNOWFLAKE_SCHEMA,
  warehouse: process.env.SNOWFLAKE_WAREHOUSE,
});

function connectSnowflake() {
  return new Promise((resolve, reject) => {
    sfConnection.connect((err) => {
      if (err) return reject(err);
      // Explicitly set warehouse in the session (SDK config alone is not always applied)
      sfConnection.execute({
        sqlText: `USE WAREHOUSE ${process.env.SNOWFLAKE_WAREHOUSE}`,
        complete: (err2) => {
          if (err2) return reject(err2);
          resolve();
        },
      });
    });
  });
}

function askCortex(question) {
  const model  = process.env.CORTEX_MODEL || "mistral-large2";
  const prompt = `You are a helpful AI assistant. Answer clearly and concisely.\n\nUser: ${question}`;
  return new Promise((resolve, reject) => {
    sfConnection.execute({
      sqlText: "SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) AS answer",
      binds:   [model, prompt],
      complete: (err, stmt, rows) => {
        if (err) reject(err);
        else resolve(rows[0].ANSWER);
      },
    });
  });
}

// ── PKCE helpers (Snowflake OAuth flow) ───────────────────────────────────────
const pkceStore = new Map();

function generateCodeVerifier() {
  return crypto.randomBytes(64).toString("base64url");
}
function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ── Route: Webex OAuth login ──────────────────────────────────────────────────
app.get("/login/webex", (req, res) => {
  const authUrl =
    `https://webexapis.com/v1/authorize?response_type=code` +
    `&client_id=${WEBEX_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=openid%20email%20profile` +
    `&state=webex`;
  res.redirect(authUrl);
});

// ── Route: Snowflake OAuth login (PKCE) ───────────────────────────────────────
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

// ── Route: Shared OAuth callback ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).json({ error });

  try {
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
          code_verifier: verifier,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      return res.json({ provider: "snowflake", ...token.data });
    }

    if (state === "webex") {
      const token = await axios.post(
        "https://webexapis.com/v1/access_token",
        new URLSearchParams({
          grant_type:    "authorization_code",
          client_id:     WEBEX_CLIENT_ID,
          client_secret: WEBEX_CLIENT_SECRET,
          code,
          redirect_uri:  REDIRECT_URI,
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

// ── Route: Webex Bot Webhook ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Acknowledge immediately so Webex doesn't retry
  res.sendStatus(200);

  const event = req.body;

  // Only handle new messages
  if (event.resource !== "messages" || event.event !== "created") return;

  const messageId = event.data?.id;
  if (!messageId) return;

  try {
    // Fetch the full message — webhook payload only contains the message ID
    const msgResp = await axios.get(
      `https://webexapis.com/v1/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${WEBEX_BOT_TOKEN}` } }
    );
    const msg = msgResp.data;

    // Ignore messages sent by the bot itself (check both personId and email as fallback)
    if (msg.personId === BOT_ID || msg.personEmail?.endsWith("@webex.bot")) return;

    const question = msg.text?.trim();
    if (!question) return;

    console.log(`[webhook] ${msg.personEmail}: ${question}`);

    // Ask Snowflake Cortex
    let answer;
    try {
      answer = await askCortex(question);
    } catch (cortexErr) {
      console.error("[cortex] Error:", cortexErr.message);
      answer = "Sorry, I couldn't generate an answer right now.";
    }

    if (answer.length > 6500) {
      answer = answer.slice(0, 6500) + "\n\n… *(truncated)*";
    }

    // Reply in Webex
    await axios.post(
      "https://webexapis.com/v1/messages",
      { roomId: msg.roomId, markdown: answer },
      {
        headers: {
          Authorization:  `Bearer ${WEBEX_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`[webhook] Replied to message ${messageId}`);
  } catch (err) {
    console.error("[webhook] Error:", err.response?.data || err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectSnowflake()
  .then(() => {
    console.log("Connected to Snowflake");
    app.listen(PORT, () => {
      console.log(`\nServer running on http://localhost:${PORT}`);
      console.log(`  Webex login     -> http://localhost:${PORT}/login/webex`);
      console.log(`  Snowflake login -> http://localhost:${PORT}/login/snowflake`);
      console.log(`  Webhook         -> POST http://localhost:${PORT}/webhook`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to Snowflake:", err.message);
    process.exit(1);
  });
