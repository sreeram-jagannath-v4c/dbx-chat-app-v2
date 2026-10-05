/**
 * Environment-agnostic database connection utilities
 * Can be used in both Next.js server components and Node.js contexts
 */

export interface DatabaseConfig {
  host: string;
  port: string;
  database: string;
  sslMode: string;
}

export interface DatabaseCredentials {
  username: string;
  password: string;
}

/**
 * Get the database schema name to use
 * Hardcoded to ai_chatbot for consistency with drizzle-kit generate
 */
export function getSchemaName(): string {
  const schemaName = 'ai_chatbot';
  console.log(`[getSchemaName] Using hardcoded schema: ${schemaName}`);
  return schemaName;
}

/**
 * Get database configuration from environment variables
 */
export function getDatabaseConfigFromEnv(): DatabaseConfig | null {
  const pgHost = process.env.PGHOST;
  const pgPort = process.env.PGPORT || '5432';
  const pgDatabase = process.env.PGDATABASE;
  const pgSSLMode = process.env.PGSSLMODE || 'require';

  if (!pgHost || !pgDatabase) {
    return null;
  }

  return {
    host: pgHost,
    port: pgPort,
    database: pgDatabase,
    sslMode: pgSSLMode,
  };
}

/**
 * Check if persistent chat storage is available.
 * Chat history is stored in Delta tables via a SQL warehouse, so this
 * requires the warehouse ID and the target catalog/schema.
 */
export function isDatabaseAvailable(): boolean {
  return !!(
    process.env.DATABRICKS_WAREHOUSE_ID &&
    process.env.CHAT_HISTORY_CATALOG &&
    process.env.CHAT_HISTORY_SCHEMA
  );
}

/**
 * Check if a (legacy) Lakebase/Postgres connection is configured.
 * Only used by the Postgres migration/reset scripts.
 */
export function isPostgresConfigured(): boolean {
  return !!(process.env.PGDATABASE || process.env.POSTGRES_URL);
}

/**
 * Build PostgreSQL connection URL from config and credentials
 */
export function buildConnectionUrl(
  config: DatabaseConfig,
  credentials: DatabaseCredentials,
): string {
  const encodedUser = encodeURIComponent(credentials.username);
  const encodedPassword = encodeURIComponent(credentials.password);

  return `postgresql://${encodedUser}:${encodedPassword}@${config.host}:${config.port}/${config.database}?sslmode=${config.sslMode}`;
}

/**
 * Get connection URL using POSTGRES_URL if available
 */
export function getPostgresUrlFromEnv(): string | null {
  return process.env.POSTGRES_URL || null;
}

/**
 * Validate that required database environment variables are set
 */
export function validateDatabaseConfig(): void {
  if (!isPostgresConfigured()) {
    throw new Error('Either POSTGRES_URL or PGHOST and PGDATABASE must be set');
  }
}
