use crate::storage::models::UiPreferencesRecord;
use crate::storage::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

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
                sidebar_project_order_json,
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
                    sidebar_project_order: parse_project_order_json(row.get::<_, String>(2)?.as_str()),
                    sidebar_section_order: row.get(3)?,
                    updated_at: row.get(4)?,
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
    let project_order_json =
        serde_json::to_string(&preferences.sidebar_project_order).unwrap_or_else(|_| "[]".to_string());

    connection.execute(
        "
        INSERT INTO ui_preferences (
            id,
            sidebar_conversation_sort,
            sidebar_project_sort,
            sidebar_project_order_json,
            sidebar_section_order,
            updated_at
        )
        VALUES ('default', ?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            sidebar_conversation_sort = excluded.sidebar_conversation_sort,
            sidebar_project_sort = excluded.sidebar_project_sort,
            sidebar_project_order_json = excluded.sidebar_project_order_json,
            sidebar_section_order = excluded.sidebar_section_order,
            updated_at = excluded.updated_at
        ",
        params![
            &preferences.sidebar_conversation_sort,
            &preferences.sidebar_project_sort,
            &project_order_json,
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
        sidebar_project_order: Vec::new(),
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
            &[DEFAULT_PROJECT_SORT, "recent", "manual"],
            DEFAULT_PROJECT_SORT,
        ),
        sidebar_project_order: normalize_project_order(preferences.sidebar_project_order),
        sidebar_section_order: normalize_value(
            &preferences.sidebar_section_order,
            &[DEFAULT_SECTION_ORDER, "conversations_first"],
            DEFAULT_SECTION_ORDER,
        ),
        updated_at: preferences.updated_at,
    }
}

fn parse_project_order_json(project_order_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(project_order_json).unwrap_or_default()
}

fn normalize_project_order(project_order: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    project_order
        .into_iter()
        .filter_map(|project_id| {
            let project_id = project_id.trim().to_string();
            if project_id.is_empty() || !seen.insert(project_id.clone()) {
                return None;
            }
            Some(project_id)
        })
        .collect()
}

fn normalize_value(value: &str, allowed_values: &[&str], fallback: &str) -> String {
    let value = value.trim();
    if allowed_values.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}
