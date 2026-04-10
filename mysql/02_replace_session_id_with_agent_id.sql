ALTER TABLE users
    ADD COLUMN agent_id VARCHAR(128) NULL UNIQUE COMMENT '用户唯一 Agent ID' AFTER password_hash;

UPDATE users
SET agent_id = COALESCE(NULLIF(session_id, ''), CONCAT('user-', id))
WHERE agent_id IS NULL;

ALTER TABLE users
    MODIFY COLUMN agent_id VARCHAR(128) NOT NULL;

ALTER TABLE users
    DROP COLUMN session_id;

DROP TABLE IF EXISTS sessions;
