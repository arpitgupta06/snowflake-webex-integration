-- ============================================================================
-- Step 3: Test & Run the Bot
-- ============================================================================

USE DATABASE ai_db;
USE SCHEMA public;
USE WAREHOUSE dbt_handson;

-- ─── 1. Test the bot manually (one-time run) ─────────────────────────────
-- First, send a message in your Webex room (e.g. "What is Snowflake?")
-- Then run this to process it:

-- CALL run_webex_bot(
--   '<WEBEX_ROOM_ID>',
--   'mistral-large2',
--   'You are a helpful AI assistant. Answer clearly and concisely.'
-- );

-- ─── 2. Start the bot (runs automatically every 1 minute) ────────────────
-- ALTER TASK webex_bot_task RESUME;

-- ─── 3. Stop the bot ─────────────────────────────────────────────────────
-- ALTER TASK webex_bot_task SUSPEND;

-- ─── 4. See what the bot has answered ────────────────────────────────────
SELECT * FROM webex_processed_messages ORDER BY answered_at DESC LIMIT 20;

-- ─── 5. Check task status ────────────────────────────────────────────────
-- SHOW TASKS LIKE 'webex_bot_task';

-- ─── 6. Reset (re-answer all messages) ───────────────────────────────────
-- TRUNCATE TABLE webex_processed_messages;
