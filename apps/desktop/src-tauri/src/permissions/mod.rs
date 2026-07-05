use my_copilot_agent::{
    AgentChatInput, AgentCommandPermission, AgentCommandRiskLevel, AgentPermissions,
    AgentWritePermission,
};

pub fn policy_from_input(input: &AgentChatInput) -> AgentPermissions {
    input
        .context
        .as_ref()
        .map(|context| context.permissions)
        .unwrap_or_default()
}

pub fn require_patch_write(
    policy: AgentPermissions,
    outside_workspace: bool,
) -> Result<(), String> {
    match (policy.write, outside_workspace) {
        (AgentWritePermission::Denied, _) => {
            Err("当前写入权限为 denied，不能应用文件修改。".to_string())
        }
        (AgentWritePermission::WorkspaceOnly, true) => {
            Err("当前写入权限仅允许修改 workspace 内文件。".to_string())
        }
        _ => Ok(()),
    }
}

pub fn require_command_execution(
    policy: AgentPermissions,
    risk_level: AgentCommandRiskLevel,
    automatic: bool,
) -> Result<(), String> {
    if automatic && policy.command != AgentCommandPermission::AutoApprove {
        return Err("当前命令权限不允许自动审批执行。".to_string());
    }

    if policy.write == AgentWritePermission::Denied && risk_level != AgentCommandRiskLevel::ReadOnly
    {
        return Err("当前写入权限为 denied，只允许执行明确分类为 read_only 的命令。".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use my_copilot_agent::{AgentReadPermission, AgentWritePermission};

    fn policy(write: AgentWritePermission) -> AgentPermissions {
        AgentPermissions {
            read: AgentReadPermission::WorkspaceOnly,
            write,
            command: AgentCommandPermission::RequireApproval,
            patch: Default::default(),
        }
    }

    #[test]
    fn denied_write_blocks_patch_and_mutating_commands() {
        let policy = policy(AgentWritePermission::Denied);
        assert!(require_patch_write(policy, false).is_err());
        assert!(
            require_command_execution(policy, AgentCommandRiskLevel::WritesWorkspace, false)
                .is_err()
        );
        assert!(require_command_execution(policy, AgentCommandRiskLevel::ReadOnly, false).is_ok());
    }

    #[test]
    fn workspace_write_rejects_outside_patch() {
        assert!(require_patch_write(policy(AgentWritePermission::WorkspaceOnly), true).is_err());
    }
}
