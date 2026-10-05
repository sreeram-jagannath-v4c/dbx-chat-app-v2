import {
  catalogName,
  executeSql,
  getChatHistorySchema,
  tableName,
  type ChatHistoryTable,
} from './sql-client';

/** [name, type definition (incl. NOT NULL / COMMENT)] */
type ColumnDef = [string, string];

/**
 * Single source of truth for table columns: used by CREATE TABLE for fresh
 * installs and by ensureColumns() to add columns missing from existing tables.
 * Columns added after the first release must be nullable (no NOT NULL), since
 * ALTER TABLE ADD COLUMNS cannot backfill existing rows.
 */
const TABLE_COLUMNS: Record<ChatHistoryTable, ColumnDef[]> = {
  chatbot_chat: [
    ['id', 'STRING NOT NULL'],
    ['created_at', 'TIMESTAMP NOT NULL'],
    ['title', 'STRING NOT NULL'],
    ['user_id', 'STRING NOT NULL'],
    ['visibility', 'STRING NOT NULL'],
    ['last_context', `STRING COMMENT 'JSON-encoded LanguageModelV3Usage'`],
    ['user_email', `STRING COMMENT 'Email of the chat owner (for auditing)'`],
    [
      'deleted_at',
      `TIMESTAMP COMMENT 'Set when the user deletes the chat (soft delete)'`,
    ],
  ],
  chatbot_message: [
    ['id', 'STRING NOT NULL'],
    ['chat_id', 'STRING NOT NULL'],
    ['role', 'STRING NOT NULL'],
    ['parts', `STRING NOT NULL COMMENT 'JSON-encoded UI message parts'`],
    ['attachments', `STRING NOT NULL COMMENT 'JSON-encoded attachments'`],
    ['created_at', 'TIMESTAMP NOT NULL'],
    ['trace_id', `STRING COMMENT 'MLflow trace ID for feedback submission'`],
    [
      'deleted_at',
      `TIMESTAMP COMMENT 'Set when removed by an edit/regenerate (soft delete)'`,
    ],
  ],
  chatbot_vote: [
    ['chat_id', 'STRING NOT NULL'],
    ['message_id', 'STRING NOT NULL'],
    ['is_upvoted', 'BOOLEAN NOT NULL'],
    ['updated_at', 'TIMESTAMP NOT NULL'],
  ],
};

const TABLE_OPTIONS: Record<ChatHistoryTable, { clusterBy: string; comment: string }> =
  {
    chatbot_chat: {
      clusterBy: 'user_id, created_at',
      comment: 'Chatbot app: chat sessions',
    },
    chatbot_message: {
      clusterBy: 'chat_id',
      comment: 'Chatbot app: chat messages',
    },
    chatbot_vote: {
      clusterBy: 'chat_id',
      comment: 'Chatbot app: thumbs up/down feedback per message',
    },
  };

const BASE_TABLES = Object.keys(TABLE_COLUMNS) as ChatHistoryTable[];

/**
 * Idempotently create the Delta tables that back chat history and feedback.
 *
 * Delta has no enforced primary/foreign keys, so integrity (unique ids,
 * soft deletes, etc.) is maintained by the query layer.
 * Deletion vectors keep MERGE/UPDATE/DELETE cheap and reduce write conflicts.
 */
export function getDeltaDdlStatements(): string[] {
  return BASE_TABLES.map((table) => {
    const { clusterBy, comment } = TABLE_OPTIONS[table];
    const columns = TABLE_COLUMNS[table]
      .map(([name, definition]) => `${name} ${definition}`)
      .join(',\n      ');
    return `CREATE TABLE IF NOT EXISTS ${tableName(table)} (
      ${columns}
    )
    CLUSTER BY (${clusterBy})
    COMMENT '${comment}'
    TBLPROPERTIES ('delta.enableDeletionVectors' = 'true')`;
  });
}

/**
 * Add columns that exist in TABLE_COLUMNS but not yet in the deployed tables
 * (Delta has no ADD COLUMN IF NOT EXISTS). Returns the columns added.
 */
async function ensureColumns(): Promise<string[]> {
  const rows = await executeSql(
    `SELECT table_name, column_name
     FROM ${catalogName()}.information_schema.columns
     WHERE table_schema = lower(:schema)
       AND table_name IN (${BASE_TABLES.map((t) => `'${t}'`).join(', ')})`,
    [{ name: 'schema', value: getChatHistorySchema() ?? '' }],
  );
  const existing = new Set(
    rows.map((row) => `${row.table_name}.${row.column_name}`.toLowerCase()),
  );

  const added: string[] = [];
  for (const table of BASE_TABLES) {
    const missing = TABLE_COLUMNS[table].filter(
      ([name]) => !existing.has(`${table}.${name}`),
    );
    if (missing.length === 0) continue;
    await executeSql(
      `ALTER TABLE ${tableName(table)} ADD COLUMNS (${missing
        .map(([name, definition]) => `${name} ${definition}`)
        .join(', ')})`,
    );
    added.push(...missing.map(([name]) => `${table}.${name}`));
  }
  return added;
}

export async function ensureDeltaTables(): Promise<{ addedColumns: string[] }> {
  for (const statement of getDeltaDdlStatements()) {
    await executeSql(statement);
  }
  const addedColumns = await ensureColumns();
  return { addedColumns };
}
