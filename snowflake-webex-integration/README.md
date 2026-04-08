# Snowflake Intelligence Webex Bot

A Webex Bot powered by **Snowflake Cortex AI** via a Node.js middleware layer.

**User experience:** Send a message to the bot in Webex → it replies with an AI-generated answer from Snowflake Cortex.

---

## Architecture

```
User (Webex)
     |
     v
Webex Bot (Webhook — POST /webhook)
     |
     v
Node.js App (http://localhost:3000)
     |
     +-- OAuth token exchange (/login/webex, /login/snowflake)
     |
     v
Snowflake Cortex / Intelligence API
     |
     v
Answer returned to Webex Bot → User
```

---

# Part 1 — Snowflake: Security Integration (OAuth)

Run this in Snowflake (database: `AI_DB`, schema: `PUBLIC`, warehouse: `DBT_HANDSON`):

```sql
USE DATABASE AI_DB;
USE SCHEMA PUBLIC;
USE WAREHOUSE DBT_HANDSON;

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

### Get OAuth credentials from Snowflake

```sql
-- Get all integration properties (endpoints, client ID, etc.)
DESC SECURITY INTEGRATION WEBEX_OAUTH;

-- Get the Client Secret
SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WEBEX_OAUTH');
```

| Property | Value |
|---|---|
| `OAUTH_CLIENT_ID` | from DESC output |
| `OAUTH_AUTHORIZATION_ENDPOINT` | `https://lqb16037.snowflakecomputing.com/oauth/authorize` |
| `OAUTH_TOKEN_ENDPOINT` | `https://lqb16037.snowflakecomputing.com/oauth/token-request` |
| `OAUTH_REDIRECT_URI` | `http://localhost:3000/callback` |
| `OAUTH_ENFORCE_PKCE` | `true` |

`OAUTH_CLIENT_SECRET` is retrieved separately via `SYSTEM$SHOW_OAUTH_CLIENT_SECRETS`.

---

# Part 2 — Snowflake: Bot Service Account & Cortex Access

Run as `ACCOUNTADMIN`:

```sql
USE ROLE ACCOUNTADMIN;

-- Grant Cortex access to ALL users in the org
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE PUBLIC;

-- Create dedicated service account for the Node.js bot
CREATE USER webex_bot_user
  PASSWORD          = 'your_strong_password'
  DEFAULT_ROLE      = PUBLIC
  DEFAULT_WAREHOUSE = DBT_HANDSON
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Service account for Webex Cortex bot';

GRANT ROLE PUBLIC TO USER webex_bot_user;

-- Grant warehouse access
GRANT USAGE ON WAREHOUSE DBT_HANDSON TO ROLE PUBLIC;
```

> `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE PUBLIC` gives every Snowflake user in the org access to Cortex — no per-user setup needed.

### Optional: Map Snowflake users to Webex identity

```sql
-- Map a Snowflake user to their Webex email for SSO
ALTER USER <YOUR_USER> SET LOGIN_NAME = 'your_webex_email@domain.com';

-- Or configure the integration to map by email automatically
ALTER SECURITY INTEGRATION WEBEX_OAUTH
  SET OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'email';
```

---

# Part 3 — Webex: Create OAuth Integration

Go to: [developer.webex.com](https://developer.webex.com)

Login → **My Apps → Create New App → Integration**

| Field | Value |
|---|---|
| App Name | `Snowflake Local Test` |
| Redirect URI | `http://localhost:3000/callback` |

**Scopes — enable all of these:**
- `spark:people_read`
- `openid`
- `email`
- `profile`

After saving you get:
- **Client ID** → `WEBEX_CLIENT_ID` in `.env`
- **Client Secret** → `WEBEX_CLIENT_SECRET` in `.env`

---

# Part 4 — Webex: Create the Bot

Go to: [developer.webex.com](https://developer.webex.com)

Login → **My Apps → Create New App → Bot**

| Field | Value |
|---|---|
| Bot Name | `snowflake_intelligence` |
| Bot Username | `snowflake_intel` |

After saving you get the **Bot Token** → `WEBEX_BOT_TOKEN` in `.env`

> If you lose the token, regenerate it from the bot's settings page.

### Get the Bot Person ID

```powershell
$token = "<your_bot_token>"
Invoke-RestMethod -Method Get -Uri "https://webexapis.com/v1/people/me" -Headers @{ "Authorization" = "Bearer $token" }
```

Use the `id` field from the response as `BOT_ID` in `.env`.

> **Important:** Use the `id` from this response (Person ID), NOT the Application ID — using the wrong one causes the bot to reply to its own messages in an infinite loop.

---

# Part 5 — Node.js App Setup

### Install dependencies

```bash
cd snowflake-webex-integration
npm install
```

Dependencies: `express`, `axios`, `dotenv`, `snowflake-sdk`

### Configure `.env`

Copy `.env.example` → `.env` and fill in all values:

```env
# Webex OAuth Integration (developer.webex.com → My Apps → Integration)
WEBEX_CLIENT_ID=...
WEBEX_CLIENT_SECRET=...

# Snowflake OAuth (from DESC SECURITY INTEGRATION WEBEX_OAUTH)
SNOWFLAKE_CLIENT_ID=...
SNOWFLAKE_CLIENT_SECRET=...
SNOWFLAKE_AUTH_URL=https://lqb16037.snowflakecomputing.com/oauth/authorize
SNOWFLAKE_TOKEN_URL=https://lqb16037.snowflakecomputing.com/oauth/token-request

# App settings
PORT=3000
REDIRECT_URI=http://localhost:3000/callback

# Webex Bot (developer.webex.com → My Apps → Bot)
WEBEX_BOT_TOKEN=...
BOT_ID=...              # Person ID from GET /people/me — NOT the Application ID

# Snowflake service account
SNOWFLAKE_ACCOUNT=lqb16037
SNOWFLAKE_USERNAME=webex_bot_user
SNOWFLAKE_PASSWORD=...
SNOWFLAKE_DATABASE=AI_DB
SNOWFLAKE_SCHEMA=PUBLIC
SNOWFLAKE_WAREHOUSE=DBT_HANDSON

# Cortex model (mistral-large2, llama3.1-70b, snowflake-arctic)
CORTEX_MODEL=mistral-large2
```
### Changes done in `main.js`

```
1. Added snowflake-sdk — imported and configured a Snowflake connection using service account credentials from .env (webex_bot_user)

2. connectSnowflake() — connects to Snowflake on startup and explicitly runs USE  
  WAREHOUSE in the session (SDK config alone doesn't apply it)

3. askCortex() — executes SNOWFLAKE.CORTEX.COMPLETE() via SQL, takes the user's
  question as input, returns the AI-generated answer

4. Added express.json() middleware — required to parse incoming Webex webhook POST bodies

5. /webhook route (new) — the core bot logic:
    - Receives Webex event → fetches full message text from Webex API (webhook only 
  sends message ID)
    - Skips bot's own messages (checks both personId and personEmail ending in      
  @webex.bot)
    - Calls askCortex() with the user's question
    - Truncates answer if >6500 chars
    - Posts answer back to Webex using WEBEX_BOT_TOKEN
6. Startup flow changed — app now connects to Snowflake first, and only starts    
  Express if connection succeeds (exits on failure)

Everything else (OAuth routes /login/webex, /login/snowflake, /callback, PKCE     
  logic) remained unchanged from the original.
```

---

# Part 6 — Expose App Publicly (ngrok)

Webex webhooks need a public HTTPS URL to reach your local app.

```bash
ngrok http 3000
```

Copy the `https://` forwarding URL (e.g. `https://abc123.ngrok-free.app`).

> **Note:** ngrok free tier gives a new URL on every restart — you must re-register the Webex webhook each time.

---

# Part 7 — Start the App

```bash
node main.js
```

Expected output:
```
Connected to Snowflake
Server running on http://localhost:3000
  Webex login     -> http://localhost:3000/login/webex
  Snowflake login -> http://localhost:3000/login/snowflake
  Webhook         -> POST http://localhost:3000/webhook
```

If Snowflake connection fails the app exits — fix credentials before proceeding.

---

# Part 8 — Register the Webex Webhook (one-time per ngrok URL)

```powershell
$token = "<your_bot_token>"
Invoke-RestMethod -Method Post -Uri "https://webexapis.com/v1/webhooks" -Headers @{"Authorization" = "Bearer $token"; "Content-Type" = "application/json"} -Body '{"name":"snowflake-cortex-bot","targetUrl":"https://<your-ngrok-url>/webhook","resource":"messages","event":"created"}'
```

Response should include `status: active`.

---

# Part 9 — Test Flow

### Test the bot

1. Open Webex
2. Search for the bot by email: `snowflake_intel@webex.bot`
3. Send any message (e.g. `"What is Snowflake Cortex?"`)
4. Watch the terminal for `[webhook]` logs
5. Bot replies in Webex within a few seconds

### Test OAuth flows

| URL | What it tests |
|---|---|
| `http://localhost:3000/login/webex` | Webex OAuth — returns `access_token` + `id_token` |
| `http://localhost:3000/login/snowflake` | Snowflake OAuth with PKCE — returns Snowflake `access_token` |

### Verified token responses

**Webex token:**
```json
{
  "provider": "webex",
  "token_type": "Bearer",
  "expires_in": 1209599,
  "scope": "spark:people_read openid profile email",
  "access_token": "<webex_bearer_token>",
  "id_token": "<jwt>"
}
```

**Snowflake token:**
```json
{
  "provider": "snowflake",
  "token_type": "Bearer",
  "expires_in": 599,
  "scope": "refresh_token session:role:PUBLIC",
  "username": "<YOUR_USER>",
  "access_token": "<snowflake_bearer_token>",
  "refresh_token": "<refresh_token>"
}
```

### Use Snowflake token via SnowSQL

```bash
snowsql -a lqb16037 -u <YOUR_USER> --authenticator oauth --token "<snowflake_access_token>"
```

---

# Routes Reference

| Route | Method | Description |
|---|---|---|
| `/webhook` | POST | Receives Webex messages, calls Cortex, replies |
| `/login/webex` | GET | Starts Webex OAuth flow |
| `/login/snowflake` | GET | Starts Snowflake OAuth flow (PKCE / S256) |
| `/callback` | GET | Shared OAuth callback for both providers |

---

# Known Issues & Fixes

| Issue | Fix |
|---|---|
| `No active warehouse selected` | `GRANT USAGE ON WAREHOUSE DBT_HANDSON TO ROLE PUBLIC` |
| Bot replies to itself (infinite loop) | Ensure `BOT_ID` is the Person ID from `GET /people/me`, not the Application ID |
| Webhook not receiving messages | Re-register webhook after ngrok restarts — URL changes every time |
| `Object does not exist` on connect | Warehouse not granted to the service account role |
