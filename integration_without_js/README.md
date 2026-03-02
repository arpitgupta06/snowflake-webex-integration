# Webex Bot powered by Snowflake Intelligence (No Middle Layer)

A Webex Bot that answers user questions using **Snowflake Intelligence (Cortex)** — with zero middleware.

**User experience:** You ask a question in Webex → the bot replies with the answer. That's it.  
**Behind the scenes:** Snowflake reads Webex messages, runs them through Cortex AI, and posts the answer back.

---

## How it looks

```
You (in Webex):     "What were last month's sales?"
Bot (in Webex):     "Last month's total sales were $1.2M, a 15% increase over..."
```

The user only sees Webex. They don't know Snowflake Intelligence is generating the answer.

---

## How it works (behind the scenes)

```
┌──────────────────┐           ┌──────────────────────────────────┐
│  Webex Room      │           │  Snowflake                       │
│                  │  poll     │                                  │
│  User: "last     │ ◄──────  │  Scheduled Task (every 1 min)    │
│   month sales?"  │           │    │                             │
│                  │           │    ▼                             │
│  Bot: "Sales     │  reply    │  Snowflake Intelligence (Cortex) │
│   were $1.2M..." │ ──────►  │    generates the answer          │
└──────────────────┘           └──────────────────────────────────┘
```

No JS server. No Express. No webhook endpoint. No deployment needed.

---

## Why SQL?

Snowflake can't call external APIs (like Webex) by default. We need 3 small SQL steps to enable it:

1. **Allow outbound HTTPS** to webexapis.com (network rule)
2. **Store the bot token** securely (Snowflake secret)
3. **Create one stored procedure** that reads messages, asks Cortex, and replies

That's the entire "integration". After that, a scheduled task runs it automatically.

---

## Setup

### Step 0: Get your credentials

1. **Create a Webex Bot** at https://developer.webex.com → My Apps → Create Bot
   - Copy the **Bot Token** (it never expires)
2. **Get your Room ID**: Add the bot to a Webex room, then find the room ID from the Webex app URL or API
3. Copy `.env.example` → `.env` and paste your values:

```bash
cp .env.example .env
```

| `.env` variable | What it is |
|---|---|
| `WEBEX_BEARER_TOKEN` | Your Webex Bot token |
| `WEBEX_ROOM_ID` | The room the bot monitors |
| `CORTEX_MODEL` | AI model (e.g. `mistral-large2`) |

### Step 1: Open Snowflake gateway to Webex

Run [01_network_and_secrets.sql](01_network_and_secrets.sql) — paste your bot token from `.env` into `SECRET_STRING`.

### Step 2: Create the bot

Run [02_webex_functions.sql](02_webex_functions.sql) — paste your room ID from `.env` into `<WEBEX_ROOM_ID>`.

### Step 3: Test it

Send a message in your Webex room, then run manually:

```sql
CALL run_webex_bot('<WEBEX_ROOM_ID>', 'mistral-large2', 'You are a helpful AI assistant.');
```

You should see the bot reply in Webex.

### Step 4: Activate the bot (runs forever)

```sql
ALTER TASK webex_bot_task RESUME;
```

Now the bot checks for new messages every minute and replies automatically.

Stop it anytime:
```sql
ALTER TASK webex_bot_task SUSPEND;
```

---

## What gets created in Snowflake

| Object | What it does |
|---|---|
| `webex_bearer_token` | Secret — stores your bot token securely |
| `webex_external_access` | Integration — allows Snowflake to call Webex API |
| `run_webex_bot()` | Procedure — the entire bot logic in one procedure |
| `webex_bot_task` | Task — runs the bot every 1 minute |
| `webex_processed_messages` | Table — tracks answered messages (no duplicates) |

---

## Comparison: JS middle layer vs this approach

| | With JS (`snowflake-webex-integration/`) | Without JS (this directory) |
|---|---|---|
| What you deploy | Node.js server + Express | Nothing — just SQL in Snowflake |
| Bot logic runs in | Your local machine / server | Snowflake itself |
| Dependencies | npm, axios, dotenv, express | None |
| Server needed? | Yes (localhost:3000) | No |
| Scheduling | You keep the server running | Snowflake Task (automatic) |
| Maintenance | Update deps, restart on crash | Zero |
