use crate::storage::{now_ms, storage_error, usage_repository, StorageState};
use my_copilot_agent::{
    AgentUsageClearInput, AgentUsageClearOutput, AgentUsageSummaryInput, AgentUsageSummaryOutput,
};
use tauri::State;

#[tauri::command]
pub fn agent_get_usage_summary(
    state: State<'_, StorageState>,
    input: AgentUsageSummaryInput,
) -> Result<AgentUsageSummaryOutput, String> {
    let connection = state.connection()?;
    usage_repository::usage_summary(&connection, &input, now_ms()).map_err(storage_error)
}

#[tauri::command]
pub fn agent_clear_usage_records(
    state: State<'_, StorageState>,
    input: AgentUsageClearInput,
) -> Result<AgentUsageClearOutput, String> {
    let connection = state.connection()?;
    usage_repository::clear_usage_records(&connection, &input).map_err(storage_error)
}
