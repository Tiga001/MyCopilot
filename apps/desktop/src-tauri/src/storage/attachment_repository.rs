use crate::storage::models::AttachmentRecord;
use rusqlite::{params, Connection};

pub fn save_attachment(
    connection: &Connection,
    attachment: &AttachmentRecord,
) -> rusqlite::Result<()> {
    connection.execute(
        "
        INSERT INTO attachments (
            id,
            conversation_id,
            message_id,
            project_id,
            kind,
            original_name,
            mime_type,
            size_bytes,
            storage_rel_path,
            created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            message_id = excluded.message_id,
            project_id = excluded.project_id,
            kind = excluded.kind,
            original_name = excluded.original_name,
            mime_type = excluded.mime_type,
            size_bytes = excluded.size_bytes,
            storage_rel_path = excluded.storage_rel_path,
            created_at = excluded.created_at
        ",
        params![
            &attachment.id,
            &attachment.conversation_id,
            &attachment.message_id,
            &attachment.project_id,
            &attachment.kind,
            &attachment.original_name,
            &attachment.mime_type,
            attachment.size_bytes,
            &attachment.storage_rel_path,
            attachment.created_at
        ],
    )?;

    Ok(())
}

pub fn list_conversation_attachments(
    connection: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Vec<AttachmentRecord>> {
    let mut statement = connection.prepare(
        "
        SELECT
            id,
            conversation_id,
            message_id,
            project_id,
            kind,
            original_name,
            mime_type,
            size_bytes,
            storage_rel_path,
            created_at
        FROM attachments
        WHERE conversation_id = ?1
        ORDER BY created_at ASC, id ASC
        ",
    )?;

    let attachments = statement
        .query_map(params![conversation_id], attachment_from_row)?
        .collect();

    attachments
}

pub fn list_project_attachments(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<AttachmentRecord>> {
    let mut statement = connection.prepare(
        "
        SELECT
            id,
            conversation_id,
            message_id,
            project_id,
            kind,
            original_name,
            mime_type,
            size_bytes,
            storage_rel_path,
            created_at
        FROM attachments
        WHERE project_id = ?1
        ORDER BY created_at DESC, id ASC
        ",
    )?;

    let attachments = statement
        .query_map(params![project_id], attachment_from_row)?
        .collect();

    attachments
}

pub fn list_project_deletion_attachments(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<AttachmentRecord>> {
    let mut statement = connection.prepare(
        "
        SELECT
            id,
            conversation_id,
            message_id,
            project_id,
            kind,
            original_name,
            mime_type,
            size_bytes,
            storage_rel_path,
            created_at
        FROM attachments
        WHERE project_id = ?1
            OR conversation_id IN (
                SELECT id
                FROM conversations
                WHERE project_id = ?1
            )
        ORDER BY created_at ASC, id ASC
        ",
    )?;

    let attachments = statement
        .query_map(params![project_id], attachment_from_row)?
        .collect();

    attachments
}

pub fn list_attachment_storage_rel_paths(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(
        "
        SELECT storage_rel_path
        FROM attachments
        ",
    )?;

    let paths = statement.query_map([], |row| row.get(0))?.collect();

    paths
}

fn attachment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentRecord> {
    Ok(AttachmentRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        message_id: row.get(2)?,
        project_id: row.get(3)?,
        kind: row.get(4)?,
        original_name: row.get(5)?,
        mime_type: row.get(6)?,
        size_bytes: row.get(7)?,
        storage_rel_path: row.get(8)?,
        created_at: row.get(9)?,
    })
}
