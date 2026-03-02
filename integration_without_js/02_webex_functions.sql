-- ============================================================================
-- Step 2: The Webex Bot — powered by Snowflake Intelligence (Cortex)
--
-- How it works:
--   1. User asks a question in Webex (e.g. "last month sales")
--   2. Snowflake checks for new messages every minute
--   3. Snowflake Intelligence (Cortex) generates the answer
--   4. The answer appears in Webex — as if the bot replied
--
-- No JS, no server, no middle layer. Just this SQL + a scheduled task.
-- ============================================================================

USE DATABASE ai_db;
USE SCHEMA public;
USE WAREHOUSE dbt_handson;

-- Table to track which messages the bot already answered (avoids duplicates)
CREATE TABLE IF NOT EXISTS webex_processed_messages (
  message_id    STRING PRIMARY KEY,
  sender_email  STRING,
  question      STRING,
  answer        STRING,
  answered_at   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- THE BOT: reads Webex messages → asks Cortex → replies in Webex
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE run_webex_bot(
    room_id        STRING,       -- which Webex room to monitor
    cortex_model   STRING,       -- e.g. 'mistral-large2', 'llama3.1-70b'
    system_prompt  STRING        -- shapes how the AI answers
)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'run_bot'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests', 'snowflake-snowpark-python')
AS $$
import requests, _snowflake

def run_bot(session, room_id, cortex_model, system_prompt):
    token = _snowflake.get_generic_secret_string('token')
    headers = {'Authorization': f'Bearer {token}'}

    # Who am I? (so we don't reply to our own messages)
    me = requests.get('https://webexapis.com/v1/people/me', headers=headers).json()
    bot_id = me.get('id', '')

    # Get recent messages from the room
    resp = requests.get(
        f'https://webexapis.com/v1/messages?roomId={room_id}&max=20',
        headers=headers
    )
    if resp.status_code != 200:
        return f'Webex API error: {resp.status_code}'

    messages = resp.json().get('items', [])

    # Which messages did we already answer?
    done = session.sql("SELECT message_id FROM webex_processed_messages").collect()
    done_ids = {r['MESSAGE_ID'] for r in done}

    count = 0
    for msg in reversed(messages):  # oldest first
        msg_id = msg.get('id', '')
        text   = msg.get('text', '').strip()

        # Skip: already answered, from the bot itself, or empty
        if msg_id in done_ids or msg.get('personId') == bot_id or not text:
            continue

        # Ask Snowflake Intelligence (Cortex)
        try:
            prompt = f"System: {system_prompt}\n\nUser: {text}" if system_prompt else text
            rows = session.sql(
                "SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) AS answer",
                params=[cortex_model, prompt]
            ).collect()
            answer = rows[0]['ANSWER'] if rows else 'Sorry, I could not generate an answer.'
        except Exception as e:
            answer = f'Error: {str(e)}'

        if len(answer) > 6500:
            answer = answer[:6500] + '\n\n… *(truncated)*'

        # Reply in Webex
        requests.post(
            'https://webexapis.com/v1/messages',
            headers={**headers, 'Content-Type': 'application/json'},
            json={'roomId': room_id, 'markdown': answer}
        )

        # Remember we answered this
        q = text.replace("'", "''")
        a = answer.replace("'", "''")
        e = msg.get('personEmail', '').replace("'", "''")
        session.sql(f"""
            INSERT INTO webex_processed_messages (message_id, sender_email, question, answer)
            VALUES ('{msg_id}', '{e}', '{q}', '{a}')
        """).collect()
        count += 1

    return f'{count} new message(s) answered'
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEDULED TASK: runs the bot every 1 minute automatically
-- ─────────────────────────────────────────────────────────────────────────────
-- Paste your WEBEX_ROOM_ID from .env below:

CREATE OR REPLACE TASK webex_bot_task
  WAREHOUSE = dbt_handson
  SCHEDULE  = '1 MINUTE'
AS
  CALL run_webex_bot(
    '<WEBEX_ROOM_ID>',           -- from .env
    'mistral-large2',            -- Cortex model
    'You are a helpful AI assistant. Answer questions clearly and concisely. If asked about data, provide specific numbers when possible.'
  );

-- ⚠️  Task starts SUSPENDED. To activate the bot:
-- ALTER TASK webex_bot_task RESUME;
--
-- To stop:
-- ALTER TASK webex_bot_task SUSPEND;
