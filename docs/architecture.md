# Architecture

MyCopilot separates responsibilities across four primary boundaries:

1. The React UI renders workspace, chat, diff, terminal, task, and settings views.
2. The Tauri Rust backend owns privileged filesystem, process, Git, permission,
   and local state operations.
3. The Python agent handles planning and model interaction, but does not write
   user files or execute commands directly.
4. Shared protocol packages keep messages aligned across process boundaries.

The required safe loop is: understand the selected workspace, propose a change,
show a diff, request approval, apply the patch through Rust, run approved tests,
and feed the result back to the agent.
