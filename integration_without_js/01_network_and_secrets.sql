-- ============================================================================
-- Step 1: Allow Snowflake to talk to Webex (one-time setup)
--
-- What this does:
--   Snowflake can't call external APIs by default. This opens a secure
--   outbound connection to webexapis.com and stores your Webex Bot token.
-- ============================================================================

USE DATABASE ai_db;
USE SCHEMA public;
USE WAREHOUSE dbt_handson;

-- 1. Allow outbound HTTPS to Webex
CREATE OR REPLACE NETWORK RULE webex_api_network_rule
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = ('webexapis.com:443');

-- 2. Store your Webex Bot token (paste the real value from your .env file)
CREATE OR REPLACE SECRET webex_bearer_token
  TYPE = GENERIC_STRING
  SECRET_STRING = '<WEBEX_BEARER_TOKEN>';  -- paste from .env

-- 3. Tie them together
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION webex_external_access
  ALLOWED_NETWORK_RULES = (webex_api_network_rule)
  ALLOWED_AUTHENTICATION_SECRETS = (webex_bearer_token)
  ENABLED = TRUE;
