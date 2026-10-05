// IMPORTANT: Load environment variables FIRST, before any other imports
// This ensures env vars are available when other modules are initialized
import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({
  path: join(__dirname, '..', '.env'),
});

// Now import other modules that depend on environment variables
import {
  isDatabaseAvailable,
  ensureDeltaTables,
  tableName,
} from '@chat-template/db';

async function main() {
  console.log('🔄 Ensuring Delta chat history tables exist...');

  if (!isDatabaseAvailable()) {
    console.warn('⚠️ Delta chat history configuration not found!');
    console.warn(
      'ℹ️ Set DATABRICKS_WAREHOUSE_ID, CHAT_HISTORY_CATALOG and CHAT_HISTORY_SCHEMA to enable persistent chat history.',
    );
    console.warn('💡 Skipping table setup in ephemeral mode...');
    process.exit(0);
  }

  try {
    const { addedColumns } = await ensureDeltaTables();
    for (const column of addedColumns) {
      console.log(`➕ Added column ${column}`);
    }
    for (const table of [
      'chatbot_chat',
      'chatbot_message',
      'chatbot_vote',
    ] as const) {
      console.log(`✅ ${tableName(table)}`);
    }
    console.log('✅ Delta chat history tables ready');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Delta table setup failed:', errorMessage);
    process.exit(1);
  }
}

main();
