-- ============================================================================
-- Step 1: Network Rule + Secret + External Access Integration
-- Run this ONCE to set up Snowflake → Webex connectivity (no middle layer)
-- ============================================================================

USE DATABASE ai_db;
USE SCHEMA public;
USE WAREHOUSE dbt_handson;

-- ---------------------------------------------------------------------------
-- 1. Network rule — allow outbound HTTPS to Webex API
-- ---------------------------------------------------------------------------
CREATE OR REPLACE NETWORK RULE webex_api_network_rule
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = ('webexapis.com:443');

-- ---------------------------------------------------------------------------
-- 2. Store Webex credentials as Snowflake secrets
-- ---------------------------------------------------------------------------

-- Webex OAuth Client ID (from developer.webex.com)
-- Replace <WEBEX_CLIENT_ID> with the value from your .env file
CREATE OR REPLACE SECRET webex_client_id
  TYPE = GENERIC_STRING
  SECRET_STRING = '<WEBEX_CLIENT_ID>';  -- paste value from .env → WEBEX_CLIENT_ID

-- Webex OAuth Client Secret (from developer.webex.com)
-- Replace <WEBEX_CLIENT_SECRET> with the value from your .env file
CREATE OR REPLACE SECRET webex_client_secret
  TYPE = GENERIC_STRING
  SECRET_STRING = '<WEBEX_CLIENT_SECRET>';  -- paste value from .env → WEBEX_CLIENT_SECRET

-- Webex Bearer Token (replace with a valid access_token after OAuth)
-- You can obtain this by completing the Webex OAuth flow once at:
--   https://developer.webex.com/docs/getting-your-personal-access-token
-- or using the "Test" token from developer.webex.com (valid 12 hours)
-- Replace <WEBEX_BEARER_TOKEN> with the value from your .env file
CREATE OR REPLACE SECRET webex_bearer_token
  TYPE = GENERIC_STRING
  SECRET_STRING = '<WEBEX_BEARER_TOKEN>';  -- paste value from .env → WEBEX_BEARER_TOKEN

-- ---------------------------------------------------------------------------
-- 3. External Access Integration — ties network rule + secrets together
-- ---------------------------------------------------------------------------
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION webex_external_access
  ALLOWED_NETWORK_RULES = (webex_api_network_rule)
  ALLOWED_AUTHENTICATION_SECRETS = (webex_client_id, webex_client_secret, webex_bearer_token)
  ENABLED = TRUE;
