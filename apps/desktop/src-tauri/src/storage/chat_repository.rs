use crate::storage::models::{ChatConversationRecord, ChatMessageRecord};
use rusqlite::{params, Connection, OptionalExtension};

pub fn list_conversations(
    connection: &Connection,
) -> rusqlite::Result<Vec<ChatConversationRecord>> {
    let mut conversation_statement = connection.prepare(
        "
        SELECT id, project_id, model_id, title, created_at, updated_at, pinned_at, archived_at
        FROM conversations
        ORDER BY
            CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END ASC,
            pinned_at DESC,
            updated_at DESC
        ",
    )?;

    let mut conversations = conversation_statement
        .query_map([], |row| {
            Ok(ChatConversationRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                model_id: row.get(2)?,
                title: row.get(3)?,
                messages: Vec::new(),
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned_at: row.get(6)?,
                archived_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for conversation in &mut conversations {
        conversation.messages = list_messages(connection, &conversation.id)?;
    }

    Ok(conversations)
}

pub fn get_conversation(
    connection: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Option<ChatConversationRecord>> {
    let conversation = connection
        .query_row(
            "
            SELECT id, project_id, model_id, title, created_at, updated_at, pinned_at, archived_at
            FROM conversations
            WHERE id = ?1
            ",
            params![conversation_id],
            |row| {
                Ok(ChatConversationRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    model_id: row.get(2)?,
                    title: row.get(3)?,
                    messages: Vec::new(),
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    pinned_at: row.get(6)?,
                    archived_at: row.get(7)?,
                })
            },
        )
        .optional()?;

    let Some(mut conversation) = conversation else {
        return Ok(None);
    };

    conversation.messages = list_messages(connection, conversation_id)?;
    Ok(Some(conversation))
}

pub fn save_conversation(
    connection: &mut Connection,
    conversation: ChatConversationRecord,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;

    transaction.execute(
        "
        INSERT INTO conversations (
            id,
            project_id,
            model_id,
            title,
            created_at,
            updated_at,
            pinned_at,
            archived_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            model_id = excluded.model_id,
            title = excluded.title,
            updated_at = excluded.updated_at,
            pinned_at = excluded.pinned_at,
            archived_at = excluded.archived_at
        ",
        params![
            &conversation.id,
            &conversation.project_id,
            &conversation.model_id,
            &conversation.title,
            conversation.created_at,
            conversation.updated_at,
            conversation.pinned_at,
            conversation.archived_at
        ],
    )?;

    transaction.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![&conversation.id],
    )?;

    for (index, message) in conversation.messages.iter().enumerate() {
        transaction.execute(
            "
            INSERT INTO messages (
                id,
                conversation_id,
                role,
                content,
                status,
                created_at,
                position
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                &message.id,
                &conversation.id,
                &message.role,
                &message.content,
                &message.status,
                message.created_at,
                index as i64
            ],
        )?;
    }

    transaction.commit()
}

pub fn delete_conversation(connection: &Connection, conversation_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM conversations WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

pub fn update_message_status_and_content(
    connection: &Connection,
    conversation_id: &str,
    message_id: &str,
    content: &str,
    status: Option<&str>,
    updated_at: i64,
) -> rusqlite::Result<()> {
    connection.execute(
        "
        UPDATE messages
        SET content = ?1, status = ?2
        WHERE conversation_id = ?3 AND id = ?4
        ",
        params![content, status, conversation_id, message_id],
    )?;
    connection.execute(
        "
        UPDATE conversations
        SET updated_at = ?1
        WHERE id = ?2
        ",
        params![updated_at, conversation_id],
    )?;
    Ok(())
}

fn list_messages(
    connection: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Vec<ChatMessageRecord>> {
    let mut statement = connection.prepare(
        "
        SELECT id, role, content, created_at, status
        FROM messages
        WHERE conversation_id = ?1
        ORDER BY position ASC, created_at ASC
        ",
    )?;

    let messages = statement
        .query_map(params![conversation_id], |row| {
            Ok(ChatMessageRecord {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                status: row.get(4)?,
            })
        })?
        .collect();

    messages
}
