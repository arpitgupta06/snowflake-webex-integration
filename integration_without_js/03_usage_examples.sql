-- ============================================================================
-- Step 3: Usage Examples — call Webex directly from Snowflake SQL
-- ============================================================================

USE DATABASE ai_db;
USE SCHEMA public;
USE WAREHOUSE dbt_handson;

-- ---------------------------------------------------------------------------
-- Test 1: Who am I? (verify token works)
-- ---------------------------------------------------------------------------
SELECT webex_whoami();

-- Parse specific fields
SELECT
  webex_whoami():displayName::STRING   AS display_name,
  webex_whoami():emails[0]::STRING     AS email,
  webex_whoami():orgId::STRING         AS org_id;

-- ---------------------------------------------------------------------------
-- Test 2: List all Webex rooms
-- ---------------------------------------------------------------------------
SELECT webex_list_rooms();

-- Flatten into rows
SELECT
  r.value:id::STRING    AS room_id,
  r.value:title::STRING AS room_title,
  r.value:type::STRING  AS room_type
FROM TABLE(FLATTEN(webex_list_rooms():items)) r;

-- ---------------------------------------------------------------------------
-- Test 3: Call any GET endpoint
-- ---------------------------------------------------------------------------

-- List teams
SELECT call_webex_api('teams');

-- Get a specific room's details (replace <room_id>)
-- SELECT call_webex_api('rooms/<room_id>');

-- ---------------------------------------------------------------------------
-- Test 4: Send a message to a Webex room
-- ---------------------------------------------------------------------------

-- Replace <room_id> with an actual room ID from Test 2
-- CALL send_webex_message('<room_id>', 'Hello from Snowflake — no middle layer!');

-- ---------------------------------------------------------------------------
-- Test 5: Send a direct message by email
-- ---------------------------------------------------------------------------

-- CALL send_webex_message_to_email('colleague@company.com', 'Alert from Snowflake pipeline!');

-- ---------------------------------------------------------------------------
-- Test 6: Combine with Snowflake data — data-driven alerts
-- ---------------------------------------------------------------------------

-- Example: Send row count alert to a Webex room
-- CALL send_webex_message('<room_id>',
--   (SELECT 'Table row count: ' || COUNT(*)::STRING FROM ai_db.public.your_table)
-- );

-- Example: Send alert when a threshold is breached
-- CALL send_webex_message('<room_id>',
--   (SELECT CASE
--      WHEN COUNT(*) > 1000 THEN 'WARNING: Row count exceeded 1000 — count is ' || COUNT(*)::STRING
--      ELSE 'OK: Row count is ' || COUNT(*)::STRING
--    END
--    FROM ai_db.public.your_table)
-- );

-- ---------------------------------------------------------------------------
-- Test 7: Generic POST (create a room, etc.)
-- ---------------------------------------------------------------------------

-- Create a new Webex room
-- SELECT call_webex_api_post('rooms', '{"title": "Snowflake Alerts"}');
