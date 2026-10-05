/**
 * Chat history persistence backed by Unity Catalog Delta tables, accessed
 * through a Databricks SQL warehouse (Statement Execution API).
 *
 * Function signatures and return shapes match the previous Lakebase/Drizzle
 * implementation so callers do not need to change.
 */
import type { DBMessage, Chat, Vote } from './schema';
import type { VisibilityType } from '@chat-template/utils';
import { ChatSDKError } from '@chat-template/core/errors';
import type { LanguageModelV3Usage } from '@ai-sdk/provider';
import { isDatabaseAvailable } from './connection-core';
import { executeSql, tableName, type SqlParam } from './delta/sql-client';

type Row = Record<string, string | null>;

const CHAT_COLUMNS = 'id, created_at, title, user_id, visibility, last_context';
const MESSAGE_COLUMNS =
  'id, chat_id, role, parts, attachments, created_at, trace_id';

/**
 * Parse a TIMESTAMP value returned by the Statement Execution API.
 * Values are UTC, e.g. `2026-10-03T12:34:56.789Z` (a space separator and a
 * missing zone are tolerated).
 */
function parseTimestamp(value: string | null): Date {
  if (!value) return new Date(Number.NaN);
  let normalized = value.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += 'Z';
  return new Date(normalized);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toChat(row: Row): Chat {
  return {
    id: row.id as string,
    createdAt: parseTimestamp(row.created_at),
    title: row.title as string,
    userId: row.user_id as string,
    visibility: (row.visibility as Chat['visibility']) ?? 'private',
    lastContext: parseJson<LanguageModelV3Usage | null>(row.last_context, null),
  };
}

function toMessage(row: Row): DBMessage {
  return {
    id: row.id as string,
    chatId: row.chat_id as string,
    role: row.role as string,
    parts: parseJson<unknown>(row.parts, []),
    attachments: parseJson<unknown>(row.attachments, []),
    createdAt: parseTimestamp(row.created_at),
    traceId: row.trace_id,
  };
}

function toVote(row: Row): Vote {
  return {
    chatId: row.chat_id as string,
    messageId: row.message_id as string,
    isUpvoted: row.is_upvoted === 'true',
  };
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  if (!isDatabaseAvailable()) {
    console.log('[saveChat] Database not available, skipping persistence');
    return;
  }

  try {
    await executeSql(
      `INSERT INTO ${tableName('chatbot_chat')} (${CHAT_COLUMNS})
       VALUES (:id, :created_at, :title, :user_id, :visibility, NULL)`,
      [
        { name: 'id', value: id },
        { name: 'created_at', value: new Date() },
        { name: 'title', value: title },
        { name: 'user_id', value: userId },
        { name: 'visibility', value: visibility },
      ],
    );
  } catch (error) {
    console.error('[saveChat] Error saving chat:', error);
    throw new ChatSDKError('bad_request:database', 'Failed to save chat');
  }
}

export async function deleteChatById({ id }: { id: string }) {
  if (!isDatabaseAvailable()) {
    console.log('[deleteChatById] Database not available, skipping deletion');
    return null;
  }

  try {
    const [deletedChat] = await executeSql(
      `SELECT ${CHAT_COLUMNS} FROM ${tableName('chatbot_chat')} WHERE id = :id`,
      [{ name: 'id', value: id }],
    );

    const params = [{ name: 'id', value: id }];
    // Children first: Delta has no FK cascade
    await executeSql(
      `DELETE FROM ${tableName('chatbot_vote')} WHERE chat_id = :id`,
      params,
    );
    await executeSql(
      `DELETE FROM ${tableName('chatbot_message')} WHERE chat_id = :id`,
      params,
    );
    await executeSql(
      `DELETE FROM ${tableName('chatbot_chat')} WHERE id = :id`,
      params,
    );

    return deletedChat ? toChat(deletedChat) : undefined;
  } catch (error) {
    console.error('[deleteChatById] Error deleting chat:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to delete chat by id',
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  if (!isDatabaseAvailable()) {
    console.log('[getChatsByUserId] Database not available, returning empty');
    return { chats: [], hasMore: false };
  }

  try {
    // Inlined into SQL (LIMIT), so make sure it is a plain integer
    const extendedLimit = Number.isFinite(limit) ? Math.trunc(limit) + 1 : 11;

    const query = async (cursor?: { op: '>' | '<'; createdAt: Date }) => {
      const params: SqlParam[] = [{ name: 'user_id', value: id }];
      let cursorCondition = '';
      if (cursor) {
        cursorCondition = `AND created_at ${cursor.op} :cursor`;
        params.push({ name: 'cursor', value: cursor.createdAt });
      }
      const rows = await executeSql(
        `SELECT ${CHAT_COLUMNS} FROM ${tableName('chatbot_chat')}
         WHERE user_id = :user_id ${cursorCondition}
         ORDER BY created_at DESC
         LIMIT ${extendedLimit}`,
        params,
      );
      return rows.map(toChat);
    };

    const getCursorChat = async (cursorId: string) => {
      const chat = await getChatById({ id: cursorId });
      if (!chat) {
        throw new ChatSDKError(
          'not_found:database',
          `Chat with id ${cursorId} not found`,
        );
      }
      return chat;
    };

    let filteredChats: Array<Chat> = [];

    if (startingAfter) {
      const selectedChat = await getCursorChat(startingAfter);
      filteredChats = await query({
        op: '>',
        createdAt: selectedChat.createdAt,
      });
    } else if (endingBefore) {
      const selectedChat = await getCursorChat(endingBefore);
      filteredChats = await query({
        op: '<',
        createdAt: selectedChat.createdAt,
      });
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (error) {
    console.error('[getChatsByUserId] Error details:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get chats by user id',
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  if (!isDatabaseAvailable()) {
    console.log('[getChatById] Database not available, returning null');
    return null;
  }

  try {
    const [row] = await executeSql(
      `SELECT ${CHAT_COLUMNS} FROM ${tableName('chatbot_chat')} WHERE id = :id LIMIT 1`,
      [{ name: 'id', value: id }],
    );
    return row ? toChat(row) : null;
  } catch (error) {
    console.error('[getChatById] Error:', error);
    throw new ChatSDKError('bad_request:database', 'Failed to get chat by id');
  }
}

export async function saveMessages({
  messages,
}: {
  messages: Array<DBMessage>;
}) {
  if (!isDatabaseAvailable()) {
    console.log('[saveMessages] Database not available, skipping persistence');
    return;
  }

  // MERGE fails if several source rows match one target row; keep the last
  const uniqueMessages = [...new Map(messages.map((m) => [m.id, m])).values()];
  if (uniqueMessages.length === 0) return;

  try {
    const params: SqlParam[] = [];
    const valueRows = uniqueMessages.map((m, i) => {
      params.push(
        { name: `id${i}`, value: m.id },
        { name: `chat_id${i}`, value: m.chatId },
        { name: `role${i}`, value: m.role },
        { name: `parts${i}`, value: JSON.stringify(m.parts ?? []) },
        { name: `attachments${i}`, value: JSON.stringify(m.attachments ?? []) },
        { name: `created_at${i}`, value: m.createdAt ?? new Date() },
        { name: `trace_id${i}`, value: m.traceId ?? null },
      );
      return `(:id${i}, :chat_id${i}, :role${i}, :parts${i}, :attachments${i}, :created_at${i}, :trace_id${i})`;
    });

    // Upsert: new messages are inserted; existing ones (e.g. MCP approval
    // continuations) get their parts/attachments/trace ID updated
    await executeSql(
      `MERGE INTO ${tableName('chatbot_message')} AS target
       USING (
         SELECT * FROM VALUES ${valueRows.join(', ')}
         AS v(${MESSAGE_COLUMNS})
       ) AS source
       ON target.id = source.id
       WHEN MATCHED THEN UPDATE SET
         parts = source.parts,
         attachments = source.attachments,
         trace_id = source.trace_id
       WHEN NOT MATCHED THEN INSERT (${MESSAGE_COLUMNS})
         VALUES (source.id, source.chat_id, source.role, source.parts,
                 source.attachments, source.created_at, source.trace_id)`,
      params,
    );
  } catch (error) {
    console.error('[saveMessages] DB error:', error);
    throw new ChatSDKError('bad_request:database', 'Failed to save messages');
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  if (!isDatabaseAvailable()) {
    console.log(
      '[getMessagesByChatId] Database not available, returning empty',
    );
    return [];
  }

  try {
    const rows = await executeSql(
      `SELECT ${MESSAGE_COLUMNS} FROM ${tableName('chatbot_message')}
       WHERE chat_id = :chat_id
       ORDER BY created_at ASC`,
      [{ name: 'chat_id', value: id }],
    );
    return rows.map(toMessage);
  } catch (error) {
    console.error('[getMessagesByChatId] Database error:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get messages by chat id',
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  if (!isDatabaseAvailable()) {
    console.log('[getMessageById] Database not available, returning empty');
    return [];
  }

  try {
    const rows = await executeSql(
      `SELECT ${MESSAGE_COLUMNS} FROM ${tableName('chatbot_message')} WHERE id = :id`,
      [{ name: 'id', value: id }],
    );
    return rows.map(toMessage);
  } catch (error) {
    console.error('[getMessageById] Database error:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get message by id',
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  if (!isDatabaseAvailable()) {
    console.log(
      '[deleteMessagesByChatIdAfterTimestamp] Database not available, skipping deletion',
    );
    return;
  }

  try {
    const params: SqlParam[] = [
      { name: 'chat_id', value: chatId },
      { name: 'timestamp', value: timestamp },
    ];
    // Votes first so none are left pointing at deleted messages
    await executeSql(
      `DELETE FROM ${tableName('chatbot_vote')}
       WHERE chat_id = :chat_id
         AND message_id IN (
           SELECT id FROM ${tableName('chatbot_message')}
           WHERE chat_id = :chat_id AND created_at >= :timestamp
         )`,
      params,
    );
    await executeSql(
      `DELETE FROM ${tableName('chatbot_message')}
       WHERE chat_id = :chat_id AND created_at >= :timestamp`,
      params,
    );
  } catch (error) {
    console.error('[deleteMessagesByChatIdAfterTimestamp] Error:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to delete messages by chat id after timestamp',
    );
  }
}

export async function updateChatVisiblityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: 'private' | 'public';
}) {
  if (!isDatabaseAvailable()) {
    console.log(
      '[updateChatVisiblityById] Database not available, skipping update',
    );
    return;
  }

  try {
    await executeSql(
      `UPDATE ${tableName('chatbot_chat')} SET visibility = :visibility WHERE id = :id`,
      [
        { name: 'visibility', value: visibility },
        { name: 'id', value: chatId },
      ],
    );
  } catch (error) {
    console.error('[updateChatVisiblityById] Error:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to update chat visibility by id',
    );
  }
}

export async function updateChatTitleById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}) {
  if (!isDatabaseAvailable()) {
    console.log(
      '[updateChatTitleById] Database not available, skipping update',
    );
    return;
  }

  try {
    await executeSql(
      `UPDATE ${tableName('chatbot_chat')} SET title = :title WHERE id = :id`,
      [
        { name: 'title', value: title },
        { name: 'id', value: chatId },
      ],
    );
  } catch (error) {
    console.error('[updateChatTitleById] Error:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to update chat title by id',
    );
  }
}

export async function updateChatLastContextById({
  chatId,
  context,
}: {
  chatId: string;
  // Store raw LanguageModelUsage to keep it simple
  context: LanguageModelV3Usage;
}) {
  if (!isDatabaseAvailable()) {
    console.log(
      '[updateChatLastContextById] Database not available, skipping update',
    );
    return;
  }

  try {
    await executeSql(
      `UPDATE ${tableName('chatbot_chat')} SET last_context = :context WHERE id = :id`,
      [
        { name: 'context', value: JSON.stringify(context) },
        { name: 'id', value: chatId },
      ],
    );
  } catch (error) {
    console.warn('Failed to update lastContext for chat', chatId, error);
    return;
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: 'up' | 'down';
}) {
  if (!isDatabaseAvailable()) {
    return;
  }

  await executeSql(
    `MERGE INTO ${tableName('chatbot_vote')} AS target
     USING (
       SELECT :chat_id AS chat_id, :message_id AS message_id,
              :is_upvoted AS is_upvoted, :updated_at AS updated_at
     ) AS source
     ON target.chat_id = source.chat_id AND target.message_id = source.message_id
     WHEN MATCHED THEN UPDATE SET
       is_upvoted = source.is_upvoted,
       updated_at = source.updated_at
     WHEN NOT MATCHED THEN INSERT (chat_id, message_id, is_upvoted, updated_at)
       VALUES (source.chat_id, source.message_id, source.is_upvoted, source.updated_at)`,
    [
      { name: 'chat_id', value: chatId },
      { name: 'message_id', value: messageId },
      { name: 'is_upvoted', value: type === 'up' },
      { name: 'updated_at', value: new Date() },
    ],
  );
}

export async function getVotesByChatId({
  id,
}: { id: string }): Promise<Vote[]> {
  if (!isDatabaseAvailable()) {
    return [];
  }

  const rows = await executeSql(
    `SELECT chat_id, message_id, is_upvoted FROM ${tableName('chatbot_vote')}
     WHERE chat_id = :chat_id`,
    [{ name: 'chat_id', value: id }],
  );
  return rows.map(toVote);
}
