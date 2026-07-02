use rusqlite::Connection;

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))
        .or_else(|error| {
            if error.to_string().contains("duplicate column name") {
                Ok(())
            } else {
                Err(error)
            }
        })
}

pub fn run_migrations(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS model_provider_settings (
            id TEXT PRIMARY KEY CHECK (id = 'default'),
            api_url TEXT NOT NULL,
            api_token TEXT NOT NULL,
            search_mode TEXT NOT NULL,
            tavily_api_key TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS models (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            short_name TEXT,
            provider_path TEXT,
            supports_image INTEGER NOT NULL,
            input_price TEXT NOT NULL,
            output_price TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT,
            created_at INTEGER NOT NULL,
            pinned_at INTEGER,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            model_id TEXT,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            pinned_at INTEGER,
            archived_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            project_id TEXT,
            kind TEXT NOT NULL,
            original_name TEXT NOT NULL,
            mime_type TEXT,
            size_bytes INTEGER NOT NULL,
            storage_rel_path TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS composer_drafts (
            scope_id TEXT PRIMARY KEY,
            message TEXT NOT NULL,
            permission_mode TEXT NOT NULL,
            model_id TEXT,
            project_id TEXT,
            attachments_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ui_preferences (
            id TEXT PRIMARY KEY CHECK (id = 'default'),
            sidebar_conversation_sort TEXT NOT NULL,
            sidebar_project_sort TEXT NOT NULL,
            sidebar_section_order TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )?;

    add_column_if_missing(connection, "projects", "pinned_at", "INTEGER")?;
    add_column_if_missing(connection, "conversations", "pinned_at", "INTEGER")?;
    add_column_if_missing(connection, "conversations", "archived_at", "INTEGER")?;

    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT,
            created_at INTEGER NOT NULL,
            position INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_models_position ON models(position);
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_pinned_at ON conversations(pinned_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_archived_at ON conversations(archived_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, position);
        CREATE INDEX IF NOT EXISTS idx_attachments_conversation_id ON attachments(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attachments_project_id ON attachments(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
        CREATE INDEX IF NOT EXISTS idx_composer_drafts_updated_at ON composer_drafts(updated_at);
        ",
    )
}
