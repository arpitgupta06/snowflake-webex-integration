-- ============================================================================
-- Step 2: Snowflake UDFs & Stored Procedures to call Webex APIs directly
-- No Node.js / Express / JavaScript middle layer needed
-- ============================================================================

USE DATABASE ai_db;
USE SCHEMA public;
USE WAREHOUSE dbt_handson;

-- ---------------------------------------------------------------------------
-- 2a. Generic GET — call any Webex REST endpoint
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION call_webex_api(endpoint STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'call_webex'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests')
AS $$
import requests
import _snowflake

def call_webex(endpoint):
    token = _snowflake.get_generic_secret_string('token')
    resp = requests.get(
        f'https://webexapis.com/v1/{endpoint}',
        headers={'Authorization': f'Bearer {token}'}
    )
    return resp.json()
$$;

-- ---------------------------------------------------------------------------
-- 2b. Generic POST — call any Webex REST endpoint with a JSON body
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION call_webex_api_post(endpoint STRING, body STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'call_webex_post'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests')
AS $$
import requests
import json
import _snowflake

def call_webex_post(endpoint, body):
    token = _snowflake.get_generic_secret_string('token')
    resp = requests.post(
        f'https://webexapis.com/v1/{endpoint}',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        json=json.loads(body)
    )
    return resp.json()
$$;

-- ---------------------------------------------------------------------------
-- 2c. Send a Webex message (convenience wrapper)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE send_webex_message(room_id STRING, message_text STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'send_message'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests')
AS $$
import requests
import _snowflake

def send_message(session, room_id, message_text):
    token = _snowflake.get_generic_secret_string('token')
    resp = requests.post(
        'https://webexapis.com/v1/messages',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        json={
            'roomId': room_id,
            'text': message_text
        }
    )
    return resp.json()
$$;

-- ---------------------------------------------------------------------------
-- 2d. Send a Webex message to a person by email
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE send_webex_message_to_email(to_email STRING, message_text STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'send_message_to_email'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests')
AS $$
import requests
import _snowflake

def send_message_to_email(session, to_email, message_text):
    token = _snowflake.get_generic_secret_string('token')
    resp = requests.post(
        'https://webexapis.com/v1/messages',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        json={
            'toPersonEmail': to_email,
            'text': message_text
        }
    )
    return resp.json()
$$;

-- ---------------------------------------------------------------------------
-- 2e. Get Webex user profile (whoami)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webex_whoami()
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'whoami'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests')
AS $$
import requests
import _snowflake

def whoami():
    token = _snowflake.get_generic_secret_string('token')
    resp = requests.get(
        'https://webexapis.com/v1/people/me',
        headers={'Authorization': f'Bearer {token}'}
    )
    return resp.json()
$$;

-- ---------------------------------------------------------------------------
-- 2f. List Webex rooms
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webex_list_rooms()
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
HANDLER = 'list_rooms'
EXTERNAL_ACCESS_INTEGRATIONS = (webex_external_access)
SECRETS = ('token' = webex_bearer_token)
PACKAGES = ('requests')
AS $$
import requests
import _snowflake

def list_rooms():
    token = _snowflake.get_generic_secret_string('token')
    resp = requests.get(
        'https://webexapis.com/v1/rooms',
        headers={'Authorization': f'Bearer {token}'}
    )
    return resp.json()
$$;
