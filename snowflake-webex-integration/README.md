# Snowflake Intelligence Webex Bot

A Webex Bot powered by **Snowflake Cortex AI** via a Node.js middleware layer.

**User experience:** Send a message to the bot in Webex → bot authenticates you with Snowflake → replies with an AI-generated answer using your own Snowflake role and warehouse.

---

## Architecture

```
User (Webex)
     |
     v
Webex Bot (Webhook — POST /webhook)
     |
     +-- Is user authenticated? ──No──> Send Snowflake login link (question queued)
     |                                         |
     |                                         v
     |                                  User signs in (/login/snowflake → /callback)
     |                                         |
     |                                  Token stored → queued question answered automatically
     |
     Yes (token valid / refreshed)
     |
     v
Node.js App (http://localhost:3000)
     |
     +-- OAuth token exchange (/login/webex, /login/snowflake)
     |
     v
Snowflake Cortex — runs as the authenticated user (their role + default warehouse)
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

# Part 2 — Snowflake: Grant Cortex Access

No shared service account is needed. Each Webex user authenticates with their own Snowflake credentials. Their own role and default warehouse are used for every query.

Run as `ACCOUNTADMIN`:

```sql
USE ROLE ACCOUNTADMIN;

-- Grant Cortex access to all users via the PUBLIC role
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE PUBLIC;

-- Ensure users' roles have warehouse access
GRANT USAGE ON WAREHOUSE DBT_HANDSON TO ROLE PUBLIC;
```

> **Dev:** users sign in with their Snowflake username and password through the OAuth consent page.
> **Prod:** replace username/password with your org's SSO / MFA — no code changes needed, the OAuth flow handles it.

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
# Dev: set to your ngrok URL so login links in Webex DMs are browser-accessible
# Prod: set to your public app URL
APP_BASE_URL=https://<your-ngrok-or-prod-url>

# Webex Bot (developer.webex.com → My Apps → Bot)
WEBEX_BOT_TOKEN=...
BOT_ID=...              # Person ID from GET /people/me — NOT the Application ID

# Snowflake connection context
# No service account — each user authenticates with their own credentials
SNOWFLAKE_ACCOUNT=lqb16037
SNOWFLAKE_DATABASE=AI_DB
SNOWFLAKE_SCHEMA=PUBLIC

# Cortex model (mistral-large2, llama3.1-70b, snowflake-arctic)
CORTEX_MODEL=mistral-large2
```

### How `main.js` works

```
1. Startup — Express starts directly. No Snowflake pre-connect needed.

2. userTokenStore (Map) — holds each user's Snowflake OAuth token in memory,
   keyed by Webex personId: { access_token, refresh_token, expires_at, username }

3. pendingQuestions (Map) — if a user asks a question before authenticating,
   it's stored here. Answered automatically after login — no retyping needed.

4. /webhook — receives Webex message → checks if user has a valid Snowflake token
   → if not: stores question in pendingQuestions, sends login link in DM
   → if yes: calls askCortexAsUser() with their token, replies with answer

5. getValidToken() — returns a valid token. If expired, attempts a refresh using
   the refresh token. Clears the token and forces re-auth if refresh fails.

6. askCortexAsUser() — creates a short-lived per-user Snowflake connection using
   authenticator: oauth. The user's own role and default warehouse are applied
   automatically — no hardcoded service account or warehouse.

7. /login/snowflake — starts Snowflake OAuth with PKCE S256. Accepts
   ?webex_person_id= so the callback can link the token to the right Webex user.

8. /callback — after Snowflake token exchange: stores token in userTokenStore,
   then checks pendingQuestions and answers any queued question automatically.
   Shows a "You can close this tab" success page to the user.

9. /login/webex — Webex OAuth flow (state=webex), separate from bot auth.
```

---

# Part 6 — Expose App Publicly (ngrok)

Webex webhooks need a public HTTPS URL to reach your local app.

```bash
ngrok http 3000
```

Copy the `https://` forwarding URL → set as `APP_BASE_URL` in `.env`.

> **Note:** ngrok free tier gives a new URL on every restart — update `APP_BASE_URL` in `.env` and re-register the Webex webhook each time.

---

# Part 7 — Start the App

```bash
node main.js
```

Expected output:
```
Server running on http://localhost:3000
  Webex login     -> http://localhost:3000/login/webex
  Snowflake login -> http://localhost:3000/login/snowflake
  Webhook         -> POST http://localhost:3000/webhook
```

---

# Part 8 — Register the Webex Webhook (one-time per ngrok URL)

```powershell
$token = "<your_bot_token>"
$url = "https://<your-ngrok-url>/webhook"
Invoke-RestMethod -Method Post -Uri "https://webexapis.com/v1/webhooks" -Headers @{"Authorization" = "Bearer $token"; "Content-Type" = "application/json"} -Body "{`"name`":`"snowflake-cortex-bot`",`"targetUrl`":`"$url`",`"resource`":`"messages`",`"event`":`"created`"}"
```

Response should include `status: active`.

### If you get 409 Conflict (duplicate webhook)

```powershell
# List existing webhooks
$webhooks = Invoke-RestMethod -Method Get -Uri "https://webexapis.com/v1/webhooks" -Headers @{"Authorization" = "Bearer $token"}
$webhooks.items | Select-Object id, name, targetUrl

# Delete the old one
$id = $webhooks.items[0].id
Invoke-RestMethod -Method Delete -Uri "https://webexapis.com/v1/webhooks/$id" -Headers @{"Authorization" = "Bearer $token"}
```

Then re-run the registration command above.

---

# Part 9 — Test Flow

### Test the bot

1. Open Webex
2. Search for the bot by email: `snowflake_intel@webex.bot`
3. Send any message (e.g. `"What is Snowflake Cortex?"`)
4. Bot replies: **"Snowflake authentication required. [Sign in to Snowflake]"**
5. Click the link → sign in with your Snowflake username/password (dev) or SSO (prod)
6. Browser shows: *"Authenticated as username ✓ — You can close this tab"*
7. Answer appears in Webex automatically — no need to retype the question

On subsequent messages the bot answers directly (token is cached and auto-refreshed).

### Test OAuth flows manually

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
| `/webhook` | POST | Receives Webex messages, authenticates user, calls Cortex, replies |
| `/login/webex` | GET | Starts Webex OAuth flow |
| `/login/snowflake` | GET | Starts Snowflake OAuth flow (PKCE / S256); accepts `?webex_person_id=` |
| `/callback` | GET | Shared OAuth callback; answers queued question after Snowflake login |

---

# Known Issues & Fixes

| Issue | Fix |
|---|---|
| Bot replies to itself (infinite loop) | Ensure `BOT_ID` is the Person ID from `GET /people/me`, not the Application ID |
| Login link in Webex DM doesn't open | `APP_BASE_URL` must be the ngrok URL, not `localhost` |
| Webhook not receiving messages | Re-register webhook after ngrok restarts — URL changes every time; also update `APP_BASE_URL` |
| User gets auth prompt on every message | Token refresh failed — check `SNOWFLAKE_CLIENT_SECRET` and that `OAUTH_ISSUE_REFRESH_TOKENS = TRUE` in the Security Integration |
| `Object does not exist` on Cortex query | User's role lacks `USAGE` on their warehouse — run `GRANT USAGE ON WAREHOUSE <wh> TO ROLE <role>` |
| 409 Conflict on webhook registration | Webhook already exists — list, delete, then re-register (see Part 8) |
