import { executeSql, tableName } from './sql-client';

/**
 * Idempotently create the Delta tables that back chat history and feedback.
 *
 * Delta has no enforced primary/foreign keys, so integrity (unique ids,
 * deleting votes before messages, etc.) is maintained by the query layer.
 * Deletion vectors keep MERGE/UPDATE/DELETE cheap and reduce write conflicts.
 */
export function getDeltaDdlStatements(): string[] {
  const tblProperties = `TBLPROPERTIES ('delta.enableDeletionVectors' = 'true')`;

  return [
    `CREATE TABLE IF NOT EXISTS ${tableName('chatbot_chat')} (
      id STRING NOT NULL,
      created_at TIMESTAMP NOT NULL,
      title STRING NOT NULL,
      user_id STRING NOT NULL,
      visibility STRING NOT NULL,
      last_context STRING COMMENT 'JSON-encoded LanguageModelV3Usage'
    )
    CLUSTER BY (user_id, created_at)
    COMMENT 'Chatbot app: chat sessions'
    ${tblProperties}`,

    `CREATE TABLE IF NOT EXISTS ${tableName('chatbot_message')} (
      id STRING NOT NULL,
      chat_id STRING NOT NULL,
      role STRING NOT NULL,
      parts STRING NOT NULL COMMENT 'JSON-encoded UI message parts',
      attachments STRING NOT NULL COMMENT 'JSON-encoded attachments',
      created_at TIMESTAMP NOT NULL,
      trace_id STRING COMMENT 'MLflow trace ID for feedback submission'
    )
    CLUSTER BY (chat_id)
    COMMENT 'Chatbot app: chat messages'
    ${tblProperties}`,

    `CREATE TABLE IF NOT EXISTS ${tableName('chatbot_vote')} (
      chat_id STRING NOT NULL,
      message_id STRING NOT NULL,
      is_upvoted BOOLEAN NOT NULL,
      updated_at TIMESTAMP NOT NULL
    )
    CLUSTER BY (chat_id)
    COMMENT 'Chatbot app: thumbs up/down feedback per message'
    ${tblProperties}`,
  ];
}

export async function ensureDeltaTables(): Promise<void> {
  for (const statement of getDeltaDdlStatements()) {
    await executeSql(statement);
  }
}
