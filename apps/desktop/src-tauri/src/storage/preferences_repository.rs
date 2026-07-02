use crate::storage::models::UiPreferencesRecord;
use crate::storage::now_ms;
use rusqlite::{params, Connection, OptionalExtension};

const DEFAULT_CONVERSATION_SORT: &str = "updated";
const DEFAULT_PROJECT_SORT: &str = "created";
const DEFAULT_SECTION_ORDER: &str = "projects_first";

pub fn load_ui_preferences(connection: &Connection) -> rusqlite::Result<UiPreferencesRecord> {
    let preferences = connection
        .query_row(
            "
            SELECT
                sidebar_conversation_sort,
                sidebar_project_sort,
                sidebar_section_order,
                updated_at
            FROM ui_preferences
            WHERE id = 'default'
            ",
            [],
            |row| {
                Ok(UiPreferencesRecord {
                    sidebar_conversation_sort: row.get(0)?,
                    sidebar_project_sort: row.get(1)?,
                    sidebar_section_order: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()?;

    Ok(preferences
        .map(normalize_preferences)
        .unwrap_or_else(default_ui_preferences))
}

pub fn save_ui_preferences(
    connection: &Connection,
    preferences: UiPreferencesRecord,
) -> rusqlite::Result<UiPreferencesRecord> {
    let preferences = normalize_preferences(preferences);
    let timestamp = now_ms();

    connection.execute(
        "
        INSERT INTO ui_preferences (
            id,
            sidebar_conversation_sort,
            sidebar_project_sort,
            sidebar_section_order,
            updated_at
        )
        VALUES ('default', ?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET
            sidebar_conversation_sort = excluded.sidebar_conversation_sort,
            sidebar_project_sort = excluded.sidebar_project_sort,
            sidebar_section_order = excluded.sidebar_section_order,
            updated_at = excluded.updated_at
        ",
        params![
            &preferences.sidebar_conversation_sort,
            &preferences.sidebar_project_sort,
            &preferences.sidebar_section_order,
            timestamp,
        ],
    )?;

    Ok(UiPreferencesRecord {
        updated_at: timestamp,
        ..preferences
    })
}

fn default_ui_preferences() -> UiPreferencesRecord {
    UiPreferencesRecord {
        sidebar_conversation_sort: DEFAULT_CONVERSATION_SORT.to_string(),
        sidebar_project_sort: DEFAULT_PROJECT_SORT.to_string(),
        sidebar_section_order: DEFAULT_SECTION_ORDER.to_string(),
        updated_at: 0,
    }
}

fn normalize_preferences(preferences: UiPreferencesRecord) -> UiPreferencesRecord {
    UiPreferencesRecord {
        sidebar_conversation_sort: normalize_value(
            &preferences.sidebar_conversation_sort,
            &[DEFAULT_CONVERSATION_SORT, "created"],
            DEFAULT_CONVERSATION_SORT,
        ),
        sidebar_project_sort: normalize_value(
            &preferences.sidebar_project_sort,
            &[DEFAULT_PROJECT_SORT, "recent"],
            DEFAULT_PROJECT_SORT,
        ),
        sidebar_section_order: normalize_value(
            &preferences.sidebar_section_order,
            &[DEFAULT_SECTION_ORDER, "conversations_first"],
            DEFAULT_SECTION_ORDER,
        ),
        updated_at: preferences.updated_at,
    }
}

fn normalize_value(value: &str, allowed_values: &[&str], fallback: &str) -> String {
    let value = value.trim();
    if allowed_values.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}
