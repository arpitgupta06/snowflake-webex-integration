-- ── Context ───────────────────────────────────────────────────────────────────
USE DATABASE AI_DB;
USE SCHEMA PUBLIC;
USE WAREHOUSE DBT_HANDSON;


-- ── Step 1: Security Integration (Snowflake OAuth) ────────────────────────────
-- Each Webex user authenticates with their own Snowflake credentials.
-- No shared service account is used.

CREATE OR REPLACE SECURITY INTEGRATION WEBEX_OAUTH
  TYPE = OAUTH
  ENABLED = TRUE
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_REDIRECT_URI = 'http://localhost:3000/callback'
  OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE   -- required for local http:// testing
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 7776000    -- 90 days
  OAUTH_ENFORCE_PKCE = TRUE;

-- Get client ID and endpoints (copy to .env)
DESC SECURITY INTEGRATION WEBEX_OAUTH;

-- Get client secret (copy to .env as SNOWFLAKE_CLIENT_SECRET)
SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WEBEX_OAUTH');


-- ── Step 2: Grant Cortex access to users ──────────────────────────────────────
USE ROLE ACCOUNTADMIN;

-- Grant Cortex AI access to everyone in the PUBLIC role
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE PUBLIC;

-- Ensure users' roles have access to the warehouse
-- Repeat for any additional warehouses/roles your users have
GRANT USAGE ON WAREHOUSE DBT_HANDSON TO ROLE PUBLIC;


-- ── Optional: Map Snowflake users to Webex email for SSO ──────────────────────
-- ALTER USER <YOUR_SNOWFLAKE_USER> SET LOGIN_NAME = 'your_webex_email@domain.com';
-- ALTER SECURITY INTEGRATION WEBEX_OAUTH
--   SET OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'email';


-- ── Cleanup: Remove old service account (if previously created) ───────────────
-- The webex_bot_user service account is no longer used. The app now authenticates
-- each Webex user individually using their own Snowflake credentials.
-- Safe to drop if it exists:
--
-- DROP USER webex_bot_user;
