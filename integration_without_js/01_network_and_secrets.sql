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
CREATE OR REPLACE SECRET webex_client_id
  TYPE = GENERIC_STRING
  SECRET_STRING = 'Ca1ade54764cef93479d72fb4172db7f1573bfa4861645830ff7c1abe4a507df4';

-- Webex OAuth Client Secret (from developer.webex.com)
CREATE OR REPLACE SECRET webex_client_secret
  TYPE = GENERIC_STRING
  SECRET_STRING = 'e6d0c2a731692e720d91a70a497039d85f34763bc7d62e55d23a254140c14a14';

-- Webex Bearer Token (replace with a valid access_token after OAuth)
-- You can obtain this by completing the Webex OAuth flow once at:
--   https://developer.webex.com/docs/getting-your-personal-access-token
-- or using the "Test" token from developer.webex.com (valid 12 hours)
CREATE OR REPLACE SECRET webex_bearer_token
  TYPE = GENERIC_STRING
  SECRET_STRING = 'YzI0YjNlZTMtNTk1Ni00ZmRiLTk2ZjEtZWY5MDc0N2EwY2U5YTI4NWMzN2MtODVl_P0A1_6dc8d78d-8b30-4860-a0cf-2c9415a40317';

-- ---------------------------------------------------------------------------
-- 3. External Access Integration — ties network rule + secrets together
-- ---------------------------------------------------------------------------
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION webex_external_access
  ALLOWED_NETWORK_RULES = (webex_api_network_rule)
  ALLOWED_AUTHENTICATION_SECRETS = (webex_client_id, webex_client_secret, webex_bearer_token)
  ENABLED = TRUE;
