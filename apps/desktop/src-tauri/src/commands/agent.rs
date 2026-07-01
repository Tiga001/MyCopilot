use my_copilot_agent::{send_chat, AgentChatInput, AgentChatOutput};

#[tauri::command]
pub async fn agent_send_chat(input: AgentChatInput) -> Result<AgentChatOutput, String> {
    send_chat(input).await.map_err(|error| error.to_string())
}
