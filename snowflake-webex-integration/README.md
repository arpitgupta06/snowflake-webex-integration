To integrate **Snowflake <-> Webex (via OAuth using your Security Integration)** and test **locally**, this sets up:

- Webex as **Identity Provider (IdP)**
- Snowflake as **Service Provider (SP)**
- **Two independent OAuth flows** from one Node.js app
- **PKCE** enforced on the Snowflake flow (as required by `OAUTH_ENFORCE_PKCE = TRUE`)

Both flows are tested and working.

---

# Part 1 -- Snowflake: Security Integration (OAuth)

Run this in Snowflake (database: `<your_database>`, schema: `<your_schema>`, warehouse: `<your_warehouse>`):

```sql
USE DATABASE <your_database>;
USE SCHEMA <your_schema>;
USE WAREHOUSE <your_warehouse>;

CREATE OR REPLACE SECURITY INTEGRATION WEBEX_OAUTH
  TYPE = OAUTH
  ENABLED = TRUE
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_REDIRECT_URI = 'http://localhost:3000/callback'
  OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 7776000
  OAUTH_ENFORCE_PKCE = TRUE;
```

> `OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE` is required for local `http://` testing.

---

## Get OAuth credentials from Snowflake

```sql
-- Get all integration properties (endpoints, client ID, etc.)
DESC SECURITY INTEGRATION WEBEX_OAUTH;

-- Get the Client Secret (copy OAUTH_CLIENT_SECRET from the JSON output)
SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WEBEX_OAUTH');
```

### Key values from DESC output

| Property | Value |
|---|---|
| `OAUTH_CLIENT_ID` | `<from DESC output>` |
| `OAUTH_AUTHORIZATION_ENDPOINT` | `https://<your_account>.snowflakecomputing.com/oauth/authorize` |
| `OAUTH_TOKEN_ENDPOINT` | `https://<your_account>.snowflakecomputing.com/oauth/token-request` |
| `OAUTH_REDIRECT_URI` | `http://localhost:3000/callback` |
| `OAUTH_ENFORCE_PKCE` | `true` |
| `BLOCKED_ROLES_LIST` | `ACCOUNTADMIN, ORGADMIN, SECURITYADMIN` |

`OAUTH_CLIENT_SECRET` is retrieved separately via `SYSTEM$SHOW_OAUTH_CLIENT_SECRETS`.

---

# Part 2 -- Webex: Create OAuth Integration

Go to: https://developer.webex.com

Login -> **My Apps -> Create New App -> Integration**

### Settings used

| Field | Value |
|---|---|
| App Name | `Snowflake Local Test` |
| Redirect URI | `http://localhost:3000/callback` |

**Scopes -- enable all of these:**

- `spark:people_read`
- `openid`
- `email`
- `profile`

> Note: Webex automatically includes all registered scopes even if you only request a subset. The scope `spark:people_read` will be returned automatically once registered.

After saving you get:

- **Client ID** - use as `WEBEX_CLIENT_ID` in `00.js`
- **Client Secret** - use as `WEBEX_CLIENT_SECRET` in `00.js`

---

# Part 3 -- Local Test App (Node.js)

## Install dependencies

```bash
mkdir snowflake-webex-test
cd snowflake-webex-test
npm init -y
npm install express axios
```

> `crypto` is built into Node.js -- no install needed.

---

## App code (00.js)

The app provides **two separate login flows** with a **shared `/callback`** route.
The Snowflake flow implements full **PKCE (S256)** as required by `OAUTH_ENFORCE_PKCE = TRUE`.

```js
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const app = express();

// All credentials loaded from .env
const WEBEX_CLIENT_ID     = process.env.WEBEX_CLIENT_ID;
const WEBEX_CLIENT_SECRET = process.env.WEBEX_CLIENT_SECRET;

// Snowflake OAuth credentials
// OAUTH_CLIENT_ID     -> from: DESC SECURITY INTEGRATION WEBEX_OAUTH
// OAUTH_CLIENT_SECRET -> from: SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WEBEX_OAUTH')
const SNOWFLAKE_CLIENT_ID     = process.env.SNOWFLAKE_CLIENT_ID;
const SNOWFLAKE_CLIENT_SECRET = process.env.SNOWFLAKE_CLIENT_SECRET;
const SNOWFLAKE_AUTH_URL      = process.env.SNOWFLAKE_AUTH_URL;
const SNOWFLAKE_TOKEN_URL     = process.env.SNOWFLAKE_TOKEN_URL;

const REDIRECT_URI = process.env.REDIRECT_URI;
const PORT         = process.env.PORT || 3000;

// In-memory PKCE store (use a proper session store in production)
const pkceStore = new Map();

// PKCE helpers
function generateCodeVerifier() {
  return crypto.randomBytes(64).toString("base64url");
}
function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// Route 1: Webex login
app.get("/login/webex", (req, res) => {
  const authUrl =
    `https://webexapis.com/v1/authorize?response_type=code` +
    `&client_id=${WEBEX_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=openid%20email%20profile` +
    `&state=webex`;
  res.redirect(authUrl);
});

// Route 2: Snowflake login (with PKCE)
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

// Shared callback
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).json({ error });

  try {
    // Snowflake callback -- state matches a stored PKCE verifier
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

    // Webex callback -- state === "webex"
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
```

---

# Part 4 -- Test Flow

## Start the app

```bash
node 00.js
```

## Test URLs

| URL | What it tests |
|---|---|
| `http://localhost:3000/login/webex` | Webex OAuth -- returns Webex `access_token` + `id_token` |
| `http://localhost:3000/login/snowflake` | Snowflake OAuth with PKCE -- returns Snowflake `access_token` |

---

## Verified token responses

### Webex token (confirmed working)

```json
{
  "provider": "webex",
  "token_type": "Bearer",
  "expires_in": 1209599,
  "refresh_token_expires_in": 7775999,
  "scope": "spark:people_read openid profile email",
  "access_token": "<webex_bearer_token>",
  "id_token": "<jwt>"
}
```

The `id_token` is a JWT containing:

| Claim | Meaning |
|---|---|
| `sub` | Webex user UUID |
| `org_id` | Webex org UUID |
| `iss` | `https://idbroker-b-us.webex.com/idb` |
| `aud` | Your Webex Client ID |

### Snowflake token (confirmed working)

```json
{
  "provider": "snowflake",
  "token_type": "Bearer",
  "expires_in": 599,
  "refresh_token_expires_in": 7775999,
  "scope": "refresh_token session:role:PUBLIC",
  "username": "<YOUR_USER>",
  "user_first_name": "<first_name>",
  "user_last_name": "<last_name>",
  "access_token": "<snowflake_bearer_token>",
  "refresh_token": "<refresh_token>"
}
```

---

# Part 5 -- Use Snowflake Token

### SnowSQL

```bash
snowsql -a <your_account> -u <YOUR_USER> --authenticator oauth --token "<snowflake_access_token>"
```

### Webex API (verify identity)

```
GET https://webexapis.com/v1/people/me
Authorization: Bearer <webex_access_token>
```

---

# Part 6 -- User Mapping in Snowflake

Map your Snowflake user to your Webex email so SSO identity resolves correctly:

```sql
ALTER USER <YOUR_USER> SET LOGIN_NAME = 'your_webex_email@domain.com';
```

Or configure the integration to map by email automatically:

```sql
ALTER SECURITY INTEGRATION WEBEX_OAUTH
  SET OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'email';
```

---

# Architecture

```
Browser
   |
   +-- /login/webex
   |       |
   |       v
   |   Node.js app (localhost:3000)
   |       |
   |       v
   |   https://webexapis.com/v1/authorize
   |       | (openid, email, profile, spark:people_read)
   |       v
   |   Webex Login -> code -> /callback?state=webex
   |       |
   |       v
   |   https://webexapis.com/v1/access_token
   |       |
   |       v
   |   Webex access_token + id_token (JWT with user identity)
   |
   +-- /login/snowflake
           |
           | (Node.js generates PKCE code_verifier + code_challenge S256)
           v
       https://<your_account>.snowflakecomputing.com/oauth/authorize
           | (session:role:PUBLIC, code_challenge)
           v
       Snowflake Login -> code -> /callback?state=<random>
           |
           v
       https://<your_account>.snowflakecomputing.com/oauth/token-request
           | (+ code_verifier)
           v
       Snowflake access_token (username: <YOUR_USER>, role: PUBLIC)
```

---

# Validation Checklist

| Check | Status |
|---|---|
| Security integration `WEBEX_OAUTH` created | Done |
| `OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE` for local http | Done |
| Redirect URI `http://localhost:3000/callback` matches in Snowflake, Webex and code | Done |
| Webex app scopes include `openid email profile spark:people_read` | Done |
| PKCE implemented with S256 for Snowflake flow | Done |
| `Content-Type: application/x-www-form-urlencoded` on all token POSTs | Done |
| Error handling on `/callback` | Done |
| Webex token received with `id_token` | Done |
| Snowflake token received for user `<YOUR_USER>` | Done |

---

# Next Steps

- **Link identities**: Map Webex email from `id_token` -> Snowflake `LOGIN_NAME`
- **Streamlit in Snowflake SSO**: Use this flow for Webex-authenticated Streamlit apps
- **Cortex / Snowflake Intelligence**: Token-based access for AI workloads
- **Role mapping**: Map Webex groups -> Snowflake roles via `ALLOWED_ROLES_LIST`
- **Production hardening**: Replace in-memory `pkceStore` with Redis/session middleware