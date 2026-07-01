use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatInput {
    pub api_url: String,
    pub api_token: String,
    pub model: String,
    pub api_style: Option<AgentApiStyle>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub mode: Option<AgentRunMode>,
    pub stream: Option<bool>,
    pub context: Option<AgentRunContext>,
    pub search_config: Option<AgentSearchConfig>,
    pub approval_decision: Option<AgentApprovalDecision>,
    pub messages: Vec<AgentChatMessage>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AgentChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatOutput {
    pub content: String,
    pub status: AgentRunStatus,
    pub run_id: String,
    pub events: Vec<AgentEvent>,
    pub tool_definitions: Vec<AgentToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<AgentUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    pub proposed_actions: Vec<AgentProposedAction>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Idle,
    Running,
    WaitingForApproval,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunMode {
    Chat,
    Plan,
    Edit,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentApiStyle {
    OpenAiCompatible,
    AnthropicCompatible,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSearchMode {
    Auto,
    Disabled,
    Tavily,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSearchConfig {
    pub mode: AgentSearchMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tavily_api_key: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalDecision {
    pub action_id: String,
    pub status: AgentApprovalDecisionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunContext {
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub workspace: Option<AgentWorkspaceContext>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceContext {
    pub project_id: Option<String>,
    pub display_name: Option<String>,
    pub root_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateSnapshot {
    pub status: AgentRunStatus,
    pub active_run_id: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalStatus {
    NotRequired,
    Required,
    Approved,
    Rejected,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalDecisionStatus {
    Approved,
    Rejected,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolSafety {
    ReadOnly,
    RequiresApproval,
    Destructive,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentCommandOutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentCommandRiskLevel {
    ReadOnly,
    WritesWorkspace,
    Network,
    Destructive,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCall {
    pub id: String,
    pub tool: String,
    pub args: Value,
    pub approval_status: AgentApprovalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub safety: AgentToolSafety,
    pub requires_workspace: bool,
    pub requires_approval: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResult {
    pub call_id: String,
    pub tool: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffProposal {
    pub id: String,
    pub file_path: String,
    pub patch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub approval_status: AgentApprovalStatus,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandRequest {
    pub id: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    pub approval_status: AgentApprovalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<AgentCommandRiskLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentProposedAction {
    ToolCall { call: AgentToolCall },
    Diff { diff: AgentDiffProposal },
    Command { command: AgentCommandRequest },
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Started {
        run_id: String,
        tool_definitions: Vec<AgentToolDefinition>,
    },
    State {
        run_id: String,
        state: AgentStateSnapshot,
    },
    MessageDelta {
        run_id: String,
        delta: String,
    },
    Message {
        run_id: String,
        content: String,
    },
    ToolCall {
        run_id: String,
        call: AgentToolCall,
    },
    ToolResult {
        run_id: String,
        result: AgentToolResult,
    },
    ApprovalRequired {
        run_id: String,
        action: AgentProposedAction,
    },
    Diff {
        run_id: String,
        diff: AgentDiffProposal,
    },
    CommandOutput {
        run_id: String,
        command: String,
        stream: AgentCommandOutputStream,
        output: String,
    },
    Error {
        run_id: Option<String>,
        message: String,
        recoverable: bool,
    },
    Done {
        run_id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<AgentRunStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<AgentUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        proposed_actions: Vec<AgentProposedAction>,
    },
}

#[derive(Debug, Clone)]
pub struct AgentError {
    message: String,
}

pub type AgentResult<T> = Result<T, AgentError>;

impl AgentError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for AgentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AgentError {}

impl From<String> for AgentError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<&str> for AgentError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}
