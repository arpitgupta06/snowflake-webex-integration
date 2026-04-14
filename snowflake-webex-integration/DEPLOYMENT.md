# Production Deployment Guide

**Server:** `http://64.102.188.197`  
**App port:** `3000`  
**Public base URL:** `http://64.102.188.197:3000`

---

## Prerequisites

The following must be available on the server before deploying:

- Node.js v18+ (`node --version`)
- npm (`npm --version`)
- git (`git --version`)
- A process manager — this guide uses **PM2** (`npm install -g pm2`)

---

## Step 1 — Snowflake: Update the Security Integration

The Security Integration was created with a `localhost` redirect URI. In production it must point to the public server.

Run in Snowflake (as `ACCOUNTADMIN`):

```sql
USE DATABASE AI_DB;
USE SCHEMA PUBLIC;
USE WAREHOUSE DBT_HANDSON;

CREATE OR REPLACE SECURITY INTEGRATION WEBEX_OAUTH
  TYPE = OAUTH
  ENABLED = TRUE
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_REDIRECT_URI = 'http://64.102.188.197:3000/callback'
  OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 7776000
  OAUTH_ENFORCE_PKCE = TRUE;

-- Re-fetch credentials after recreating the integration
DESC SECURITY INTEGRATION WEBEX_OAUTH;
SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WEBEX_OAUTH');
```

> Copy the new `SNOWFLAKE_CLIENT_ID`, `SNOWFLAKE_CLIENT_SECRET`, `SNOWFLAKE_AUTH_URL`, and `SNOWFLAKE_TOKEN_URL` — you will need them in Step 4.

---

## Step 2 — Webex: Update the OAuth Integration Redirect URI

Go to [developer.webex.com](https://developer.webex.com) → My Apps → your OAuth Integration → Edit.

- Change the Redirect URI from `http://localhost:3000/callback` to:
  ```
  http://64.102.188.197:3000/callback
  ```
- Save. The `WEBEX_CLIENT_ID` and `WEBEX_CLIENT_SECRET` remain the same.

---

## Step 3 — Clone the Repository on the Server

SSH into the server, then:

```bash
ssh user@64.102.188.197

# Clone the repo (adjust the URL to your actual remote)
git clone https://github.com/<your-org>/<your-repo>.git /opt/snowflake-webex-integration

cd /opt/snowflake-webex-integration/snowflake-webex-integration

# Install dependencies
npm install --omit=dev
```

---

## Step 4 — Create the `.env` File

```bash
cp .env.example .env
nano .env        # or vim .env
```

Fill in every variable:

```dotenv
# Webex OAuth Integration
WEBEX_CLIENT_ID=<from developer.webex.com>
WEBEX_CLIENT_SECRET=<from developer.webex.com>

# Snowflake OAuth (re-run DESC + SYSTEM$ after recreating the integration in Step 1)
SNOWFLAKE_CLIENT_ID=<from DESC SECURITY INTEGRATION WEBEX_OAUTH>
SNOWFLAKE_CLIENT_SECRET=<from SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WEBEX_OAUTH')>
SNOWFLAKE_AUTH_URL=https://lqb16037.snowflakecomputing.com/oauth/authorize
SNOWFLAKE_TOKEN_URL=https://lqb16037.snowflakecomputing.com/oauth/token-request

# App settings
PORT=3000
REDIRECT_URI=http://64.102.188.197:3000/callback
APP_BASE_URL=http://64.102.188.197:3000

# Webex Bot
WEBEX_BOT_TOKEN=<from developer.webex.com Bot page>
BOT_ID=<Person ID from GET /people/me — NOT the Application ID>

# Snowflake context
SNOWFLAKE_ACCOUNT=lqb16037
SNOWFLAKE_DATABASE=AI_DB
SNOWFLAKE_SCHEMA=PUBLIC

# Cortex model
CORTEX_MODEL=mistral-large2
```

> **Security:** Never commit `.env` to git. Confirm `.gitignore` contains `.env`.

---

## Step 5 — Open the Firewall Port

The server must allow inbound TCP on port `3000`.

```bash
# Ubuntu / Debian (ufw)
sudo ufw allow 3000/tcp
sudo ufw status

# RHEL / CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

Verify from your local machine:

```bash
curl http://64.102.188.197:3000/
# Should get a response (404 or HTML — any non-timeout means the port is open)
```

---

## Step 6 — Start the App with PM2

```bash
# Install PM2 globally if not already installed
npm install -g pm2

cd /opt/snowflake-webex-integration/snowflake-webex-integration

# Start the app
pm2 start main.js --name snowflake-webex

# Save the process list so it survives reboots
pm2 save

# Enable PM2 to start on system boot
pm2 startup
# Run the command that pm2 startup prints out (copy-paste it)
```

Useful PM2 commands:

```bash
pm2 status                  # check if app is running
pm2 logs snowflake-webex    # live logs
pm2 restart snowflake-webex # restart after a config/code change
pm2 stop snowflake-webex    # stop
pm2 delete snowflake-webex  # remove from PM2
```

---

## Step 7 — Register the Webex Webhook

> Run this **once** (or whenever the server URL changes). If you already have a webhook pointing to the old URL, delete it first.

**List existing webhooks:**

```powershell
Invoke-RestMethod -Method Get `
  -Uri "https://webexapis.com/v1/webhooks" `
  -Headers @{ "Authorization" = "Bearer <WEBEX_BOT_TOKEN>" }
```

**Delete an old webhook (if exists):**

```powershell
Invoke-RestMethod -Method Delete `
  -Uri "https://webexapis.com/v1/webhooks/<webhook-id>" `
  -Headers @{ "Authorization" = "Bearer <WEBEX_BOT_TOKEN>" }
```

**Register the new production webhook:**

```powershell
$token = "<WEBEX_BOT_TOKEN>"
$url   = "http://64.102.188.197:3000/webhook"

Invoke-RestMethod -Method Post `
  -Uri "https://webexapis.com/v1/webhooks" `
  -Headers @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body "{`"name`":`"snowflake-cortex-bot`",`"targetUrl`":`"$url`",`"resource`":`"messages`",`"event`":`"created`"}"
```

Or with curl (Linux):

```bash
curl -X POST https://webexapis.com/v1/webhooks \
  -H "Authorization: Bearer <WEBEX_BOT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "snowflake-cortex-bot",
    "targetUrl": "http://64.102.188.197:3000/webhook",
    "resource": "messages",
    "event": "created"
  }'
```

---

## Step 8 — Smoke Test

1. **Health check** — confirm the app is reachable:
   ```bash
   curl http://64.102.188.197:3000/
   ```

2. **Webhook reachability** — send a test POST:
   ```bash
   curl -X POST http://64.102.188.197:3000/webhook \
     -H "Content-Type: application/json" \
     -d '{"resource":"messages","event":"created","data":{"id":"test"}}'
   # Expected: 200 OK
   ```

3. **End-to-end** — open Webex, DM the bot with any question. You should receive a Snowflake login link. Complete the login and verify the bot replies with a Cortex answer.

---

## Updating the App

```bash
ssh user@64.102.188.197
cd /opt/snowflake-webex-integration/snowflake-webex-integration

git pull

npm install --omit=dev   # only needed if package.json changed

pm2 restart snowflake-webex
pm2 logs snowflake-webex   # watch for startup errors
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` times out on port 3000 | Firewall blocking the port | Run the `ufw` / `firewalld` commands in Step 5 |
| Bot sends login link but OAuth page shows "redirect_uri mismatch" | Redirect URI in Webex or Snowflake still set to `localhost` | Redo Steps 1 and 2 |
| Bot replies to itself (infinite loop) | `BOT_ID` is the Application ID, not Person ID | Get Person ID via `GET /v1/people/me` with the bot token |
| 409 Conflict when registering webhook | Old webhook with same URL exists | List webhooks, delete the old one, re-register |
| User gets auth prompt on every message | Snowflake token refresh failing | Check `SNOWFLAKE_CLIENT_SECRET` and that `OAUTH_ISSUE_REFRESH_TOKENS = TRUE` |
| `Object does not exist` on Cortex query | User's role lacks warehouse access | `GRANT USAGE ON WAREHOUSE DBT_HANDSON TO ROLE PUBLIC` |
| App crashes on startup | Missing `.env` values | Run `pm2 logs snowflake-webex` and check which variable is undefined |
