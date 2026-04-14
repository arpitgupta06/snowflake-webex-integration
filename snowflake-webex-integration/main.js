require("dotenv").config();

const express   = require("express");
const axios     = require("axios");
const crypto    = require("crypto");
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
// APP_BASE_URL must be the ngrok URL in dev (used for login links sent in Webex DMs)
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

// ── Per-user Snowflake token store ────────────────────────────────────────────
// Key: Webex personId  →  { access_token, refresh_token, expires_at, username }
const userTokenStore = new Map();

// ── Pending question store ────────────────────────────────────────────────────
// Holds the question a user asked before they were authenticated.
// Answered automatically after OAuth completes — user doesn't need to retype.
// Key: Webex personId  →  { question, roomId }
const pendingQuestions = new Map();

// ── PKCE store ────────────────────────────────────────────────────────────────
// Key: random state  →  { verifier, webexPersonId }
const pkceStore = new Map();

function generateCodeVerifier() {
  return crypto.randomBytes(64).toString("base64url");
}
function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ── Token helpers ─────────────────────────────────────────────────────────────
function tokenIsValid(tokenInfo) {
  // Consider expired 60s before actual expiry to avoid edge cases
  return tokenInfo && Date.now() < tokenInfo.expires_at - 60_000;
}

async function refreshSnowflakeToken(personId) {
  const tokenInfo = userTokenStore.get(personId);
  if (!tokenInfo?.refresh_token) return null;

  try {
    const resp = await axios.post(
      SNOWFLAKE_TOKEN_URL,
      new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     SNOWFLAKE_CLIENT_ID,
        client_secret: SNOWFLAKE_CLIENT_SECRET,
        refresh_token: tokenInfo.refresh_token,
        redirect_uri:  REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const data = resp.data;
    const updated = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokenInfo.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
      username:      data.username || tokenInfo.username,
    };
    userTokenStore.set(personId, updated);
    console.log(`[token] Refreshed Snowflake token for ${updated.username}`);
    return updated;
  } catch (err) {
    console.error("[token] Refresh failed:", err.response?.data || err.message);
    userTokenStore.delete(personId); // clear stale token, force re-auth
    return null;
  }
}

// Returns a valid token for the user, refreshing if needed. Returns null if not authed.
async function getValidToken(personId) {
  const tokenInfo = userTokenStore.get(personId);
  if (!tokenInfo) return null;
  if (tokenIsValid(tokenInfo)) return tokenInfo;
  return refreshSnowflakeToken(personId);
}

// ── Snowflake: per-user query via OAuth token ─────────────────────────────────
// Creates a short-lived connection using the user's own OAuth token.
// Their Snowflake role and default warehouse are applied automatically — no hardcoded service account.
function askCortexAsUser(question, tokenInfo) {
  const model  = process.env.CORTEX_MODEL || "mistral-large2";
  const prompt = `You are a helpful AI assistant. Answer clearly and concisely.\n\nUser: ${question}`;

  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account:       process.env.SNOWFLAKE_ACCOUNT,
      username:      tokenInfo.username,
      authenticator: "oauth",
      token:         tokenInfo.access_token,
      database:      process.env.SNOWFLAKE_DATABASE,
      schema:        process.env.SNOWFLAKE_SCHEMA,
    });

    conn.connect((err) => {
      if (err) return reject(err);

      conn.execute({
        sqlText: "SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) AS answer",
        binds:   [model, prompt],
        complete: (err2, _stmt, rows) => {
          conn.destroy(() => {}); // close connection after query
          if (err2) return reject(err2);
          resolve(rows[0].ANSWER);
        },
      });
    });
  });
}

// ── Webex helper ──────────────────────────────────────────────────────────────
async function sendWebexMessage(roomId, markdown) {
  await axios.post(
    "https://webexapis.com/v1/messages",
    { roomId, markdown },
    {
      headers: {
        Authorization:  `Bearer ${WEBEX_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
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
// Pass ?webex_person_id=<id> so the callback can link the token to the right Webex user.
app.get("/login/snowflake", (req, res) => {
  const verifier      = generateCodeVerifier();
  const challenge     = generateCodeChallenge(verifier);
  const state         = crypto.randomBytes(16).toString("hex");
  const webexPersonId = req.query.webex_person_id || null;

  pkceStore.set(state, { verifier, webexPersonId });

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
      const { verifier, webexPersonId } = pkceStore.get(state);
      pkceStore.delete(state);

      const resp = await axios.post(
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
      const data = resp.data;

      if (webexPersonId) {
        // Link this Snowflake token to the Webex user who triggered the login
        const tokenInfo = {
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_at:    Date.now() + data.expires_in * 1000,
          username:      data.username,
        };
        userTokenStore.set(webexPersonId, tokenInfo);
        console.log(`[auth] Snowflake token stored for Webex user ${webexPersonId} (${data.username})`);

        // Answer the question the user asked before authenticating
        const pending = pendingQuestions.get(webexPersonId);
        if (pending) {
          pendingQuestions.delete(webexPersonId);
          // Don't await — let the callback page load immediately
          (async () => {
            try {
              let answer = await askCortexAsUser(pending.question, tokenInfo);
              if (answer.length > 6500) answer = answer.slice(0, 6500) + "\n\n… *(truncated)*";
              await sendWebexMessage(pending.roomId, answer);
              console.log(`[auth] Answered queued question for ${data.username}`);
            } catch (err) {
              console.error("[auth] Failed to answer queued question:", err.message);
            }
          })();
        }

        return res.send(
          `<h2>Authenticated as <strong>${data.username}</strong> ✓</h2>` +
          `<p>You can close this tab and return to Webex.</p>`
        );
      }

      // Fallback: no Webex user linked — return token as JSON (manual/test use)
      return res.json({ provider: "snowflake", ...data });
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

    // Ignore messages sent by the bot itself
    if (msg.personId === BOT_ID || msg.personEmail?.endsWith("@webex.bot")) return;

    const question = msg.text?.trim();
    if (!question) return;

    console.log(`[webhook] ${msg.personEmail}: ${question}`);

    // ── Authenticate user before querying Snowflake ────────────────────────
    const tokenInfo = await getValidToken(msg.personId);
    if (!tokenInfo) {
      // Remember what the user asked — will be answered automatically after login
      pendingQuestions.set(msg.personId, { question, roomId: msg.roomId });

      const loginUrl = `${APP_BASE_URL}/login/snowflake?webex_person_id=${encodeURIComponent(msg.personId)}`;
      await sendWebexMessage(
        msg.roomId,
        `**Snowflake authentication required.**\n\n` +
        `**[Sign in to Snowflake](${loginUrl})**\n\n` +
        `Your question will be answered automatically after you sign in.`
      );
      console.log(`[auth] Sent login prompt to ${msg.personEmail}, question queued`);
      return;
    }

    // ── Query Cortex as the authenticated user ─────────────────────────────
    let answer;
    try {
      answer = await askCortexAsUser(question, tokenInfo);
    } catch (cortexErr) {
      console.error("[cortex] Error:", cortexErr.message);
      answer = "Sorry, I couldn't generate an answer right now.";
    }

    if (answer.length > 6500) {
      answer = answer.slice(0, 6500) + "\n\n… *(truncated)*";
    }

    await sendWebexMessage(msg.roomId, answer);
    console.log(`[webhook] Replied to ${msg.personEmail} (Snowflake user: ${tokenInfo.username})`);
  } catch (err) {
    console.error("[webhook] Error:", err.response?.data || err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nServer running on http://localhost:${PORT}`);
  console.log(`  Webex login     -> http://localhost:${PORT}/login/webex`);
  console.log(`  Snowflake login -> http://localhost:${PORT}/login/snowflake`);
  console.log(`  Webhook         -> POST http://localhost:${PORT}/webhook`);
});
