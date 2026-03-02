# Snowflake ↔ Webex Integration (No Middle Layer)

Direct integration using **Snowflake External Access Integration** — no Node.js, no Express, no JavaScript.

Snowflake calls Webex APIs natively via Python UDFs and stored procedures.

---

## Architecture

```
Snowflake SQL / UDF / Stored Procedure
        |
        | HTTPS (via External Access Integration)
        v
  webexapis.com/v1/*
```

No intermediate server. No PKCE management. No callback routes.

---

## Setup (run in order)

### 1. Network rule, secrets & integration

Run [01_network_and_secrets.sql](01_network_and_secrets.sql) in Snowflake.

**Before running**, update the `webex_bearer_token` secret with a valid Webex access token.  
Get one from: https://developer.webex.com → Log in → copy your test token, or complete the OAuth flow once.

### 2. Create UDFs & procedures

Run [02_webex_functions.sql](02_webex_functions.sql) in Snowflake.

This creates:

| Function / Procedure | Purpose |
|---|---|
| `call_webex_api(endpoint)` | Generic GET to any `/v1/{endpoint}` |
| `call_webex_api_post(endpoint, body)` | Generic POST with JSON body |
| `send_webex_message(room_id, text)` | Send message to a room |
| `send_webex_message_to_email(email, text)` | Send direct message by email |
| `webex_whoami()` | Get your Webex profile |
| `webex_list_rooms()` | List all Webex rooms |

### 3. Test

Run examples from [03_usage_examples.sql](03_usage_examples.sql).

---

## Credentials

All secrets are stored in the `.env` file (never committed to Git).  
Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Source |
|---|---|
| `WEBEX_CLIENT_ID` | From https://developer.webex.com → My Apps |
| `WEBEX_CLIENT_SECRET` | From https://developer.webex.com → My Apps |
| `WEBEX_BEARER_TOKEN` | Personal access token or OAuth access_token |

> **Note:** You still need a valid Webex **access token** (Bearer token) for the API calls.  
> The Client ID/Secret are stored as secrets in case you want to implement token refresh inside Snowflake later.

---

## Token Refresh (Optional)

To auto-refresh the Webex token from within Snowflake, you can create a stored procedure:

```sql
CREATE OR REPLACE PROCEDURE refresh_webex_token(refresh_token_value STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'refresh'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('cid' = webex_client_id, 'csecret' = webex_client_secret)
PACKAGES = ('requests')
AS $$
import requests, _snowflake

def refresh(session, refresh_token_value):
    resp = requests.post('https://webexapis.com/v1/access_token', data={
        'grant_type': 'refresh_token',
        'client_id': _snowflake.get_generic_secret_string('cid'),
        'client_secret': _snowflake.get_generic_secret_string('csecret'),
        'refresh_token': refresh_token_value
    })
    data = resp.json()
    # Update the stored secret with the new token
    session.sql(f"ALTER SECRET webex_bearer_token SET SECRET_STRING = '{data['access_token']}'").collect()
    return data
$$;
```

---

## Comparison with the old approach

| | Old (Node.js middle layer) | New (native Snowflake) |
|---|---|---|
| Runtime | Node.js + Express + axios | Snowflake Python UDF |
| Infrastructure | Separate server (localhost:3000) | None — runs inside Snowflake |
| Auth complexity | PKCE, callback routes, state mgmt | Bearer token stored as secret |
| Maintenance | npm dependencies, server uptime | Zero — SQL only |
| Scheduling | External cron / orchestrator | Snowflake Tasks |
