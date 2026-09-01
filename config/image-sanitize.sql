SET FOREIGN_KEY_CHECKS = 0;

DELETE FROM sys_user_token;
DELETE FROM ai_device_address_book;
DELETE FROM ai_agent_voice_print;
DELETE FROM ai_agent_chat_history;
DELETE FROM ai_agent_chat_audio;
DELETE FROM ai_agent_chat_title;
DELETE FROM ai_device;
DELETE FROM ai_ota;
DELETE FROM ai_voice_clone;
DELETE FROM ai_agent_context_provider;
DELETE FROM ai_rag_knowledge_document;
DELETE FROM ai_rag_dataset;

UPDATE sys_params
SET param_value = ''
WHERE param_code IN (
  'server.secret',
  'server.private_key',
  'server.public_key',
  'server.ota',
  'server.websocket',
  'server.mqtt_signature_key',
  'aliyun.sms.access_key_id',
  'aliyun.sms.access_key_secret'
);

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.api_key', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.api_key');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.access_key_id', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.access_key_id');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.access_key_secret', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.access_key_secret');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.token', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.token');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.secret', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.secret');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.password', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.password');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.access_token', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.access_token');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.api_password', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.api_password');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.api_secret', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.api_secret');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.appkey', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.appkey');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.authorization', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.authorization');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.embedding_api_key', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.embedding_api_key');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.llm_api_key', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.llm_api_key');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.personal_access_token', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.personal_access_token');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.secret_id', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.secret_id');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.secret_key', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.secret_key');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.http_proxy', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.http_proxy');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.https_proxy', '')
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.https_proxy');

UPDATE ai_model_config
SET config_json = JSON_SET(config_json, '$.headers', JSON_OBJECT())
WHERE JSON_CONTAINS_PATH(config_json, 'one', '$.headers');

SET FOREIGN_KEY_CHECKS = 1;
