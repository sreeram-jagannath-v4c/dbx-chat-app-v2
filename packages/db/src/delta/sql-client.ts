/**
 * Minimal client for the Databricks SQL Statement Execution API.
 * https://docs.databricks.com/api/workspace/statementexecution
 *
 * Chat history lives in Unity Catalog Delta tables and is read/written
 * through a SQL warehouse using the app's credentials (service principal
 * in Databricks Apps, CLI user locally).
 */
import {
  getAuthMethod,
  getCachedCliHost,
  getDatabricksToken,
  getDatabricksUserIdentity,
} from '@chat-template/auth';
import { getHostUrl } from '@chat-template/utils';

export type SqlParamType =
  | 'STRING'
  | 'BOOLEAN'
  | 'INT'
  | 'BIGINT'
  | 'TIMESTAMP';

export interface SqlParam {
  name: string;
  value: string | number | boolean | Date | null;
  type?: SqlParamType;
}

type Row = Record<string, string | null>;

interface StatementResponse {
  statement_id: string;
  status: {
    state:
      | 'PENDING'
      | 'RUNNING'
      | 'SUCCEEDED'
      | 'FAILED'
      | 'CANCELED'
      | 'CLOSED';
    error?: { error_code?: string; message?: string };
  };
  manifest?: {
    schema?: { columns?: Array<{ name: string }> };
    total_chunk_count?: number;
  };
  result?: {
    data_array?: Array<Array<string | null>>;
    next_chunk_index?: number;
  };
}

interface ChunkResponse {
  data_array?: Array<Array<string | null>>;
  next_chunk_index?: number;
}

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 120_000;

export function getWarehouseId(): string | undefined {
  return process.env.DATABRICKS_WAREHOUSE_ID;
}

export function getChatHistoryCatalog(): string | undefined {
  return process.env.CHAT_HISTORY_CATALOG;
}

export function getChatHistorySchema(): string | undefined {
  return process.env.CHAT_HISTORY_SCHEMA;
}

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * Fully qualified, backtick-quoted name of a chat history table.
 */
export function tableName(
  table: 'chatbot_chat' | 'chatbot_message' | 'chatbot_vote',
): string {
  const catalog = getChatHistoryCatalog();
  const schema = getChatHistorySchema();
  if (!catalog || !schema) {
    throw new Error(
      'CHAT_HISTORY_CATALOG and CHAT_HISTORY_SCHEMA must be set to use Delta chat history',
    );
  }
  return `${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}.${table}`;
}

let cachedHost: string | null = null;

async function getHost(): Promise<string> {
  if (cachedHost) return cachedHost;
  if (getAuthMethod() === 'cli') {
    // Resolves and caches the CLI profile's host
    await getDatabricksUserIdentity();
    const cliHost = getCachedCliHost();
    if (!cliHost) {
      throw new Error('CLI authentication succeeded but host was not cached');
    }
    cachedHost = cliHost;
  } else {
    cachedHost = getHostUrl();
  }
  return cachedHost;
}

function serializeParam(param: SqlParam) {
  const { name, value } = param;
  if (value === null) {
    return { name, type: param.type ?? 'STRING' };
  }
  if (value instanceof Date) {
    return { name, value: value.toISOString(), type: 'TIMESTAMP' };
  }
  if (typeof value === 'boolean') {
    return { name, value: String(value), type: 'BOOLEAN' };
  }
  if (typeof value === 'number') {
    return { name, value: String(value), type: param.type ?? 'BIGINT' };
  }
  return { name, value, type: param.type ?? 'STRING' };
}

async function apiRequest<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const [host, token] = await Promise.all([getHost(), getDatabricksToken()]);
  const response = await fetch(`${host}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `SQL Statement API ${response.status} ${response.statusText}: ${text}`,
    );
  }
  return (await response.json()) as T;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a parameterized SQL statement on the configured warehouse and
 * return the rows as objects keyed by column name. Values are returned as
 * strings (or null), exactly as the JSON_ARRAY format provides them.
 */
export async function executeSql(
  statement: string,
  params: SqlParam[] = [],
): Promise<Row[]> {
  const warehouseId = getWarehouseId();
  if (!warehouseId) {
    throw new Error('DATABRICKS_WAREHOUSE_ID must be set');
  }

  let response = await apiRequest<StatementResponse>(
    '/api/2.0/sql/statements',
    {
      method: 'POST',
      body: {
        statement,
        warehouse_id: warehouseId,
        parameters: params.map(serializeParam),
        wait_timeout: '30s',
        on_wait_timeout: 'CONTINUE',
        format: 'JSON_ARRAY',
        disposition: 'INLINE',
      },
    },
  );

  // Warehouse may still be starting; poll until the statement finishes
  const startedAt = Date.now();
  while (
    response.status.state === 'PENDING' ||
    response.status.state === 'RUNNING'
  ) {
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      await apiRequest(
        `/api/2.0/sql/statements/${response.statement_id}/cancel`,
        { method: 'POST' },
      ).catch(() => undefined);
      throw new Error(
        `SQL statement ${response.statement_id} timed out after ${MAX_WAIT_MS}ms`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
    response = await apiRequest<StatementResponse>(
      `/api/2.0/sql/statements/${response.statement_id}`,
    );
  }

  if (response.status.state !== 'SUCCEEDED') {
    const error = response.status.error;
    throw new Error(
      `SQL statement ${response.statement_id} ${response.status.state}: ${
        error?.error_code ?? ''
      } ${error?.message ?? ''}`.trim(),
    );
  }

  const columns = response.manifest?.schema?.columns?.map((c) => c.name) ?? [];
  const data = [...(response.result?.data_array ?? [])];

  // Fetch any remaining inline chunks
  let nextChunk = response.result?.next_chunk_index;
  while (nextChunk !== undefined && nextChunk !== null) {
    const chunk = await apiRequest<ChunkResponse>(
      `/api/2.0/sql/statements/${response.statement_id}/result/chunks/${nextChunk}`,
    );
    data.push(...(chunk.data_array ?? []));
    nextChunk = chunk.next_chunk_index;
  }

  return data.map((values) => {
    const row: Row = {};
    columns.forEach((column, index) => {
      row[column] = values[index] ?? null;
    });
    return row;
  });
}
