use crate::storage::models::{ChatConversationRecord, ChatMessageRecord};
use rusqlite::{params, Connection};

pub fn list_conversations(
    connection: &Connection,
) -> rusqlite::Result<Vec<ChatConversationRecord>> {
    let mut conversation_statement = connection.prepare(
        "
        SELECT id, project_id, model_id, title, created_at, updated_at
        FROM conversations
        ORDER BY updated_at DESC
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
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for conversation in &mut conversations {
        conversation.messages = list_messages(connection, &conversation.id)?;
    }

    Ok(conversations)
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
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            model_id = excluded.model_id,
            title = excluded.title,
            updated_at = excluded.updated_at
        ",
        params![
            &conversation.id,
            &conversation.project_id,
            &conversation.model_id,
            &conversation.title,
            conversation.created_at,
            conversation.updated_at
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
