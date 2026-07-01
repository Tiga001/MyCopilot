# AGENTS.md

## Project Goal

Build a Codex-like installable desktop application for local software engineering tasks.

The app should support:

- Selecting and reading a local project workspace
- Chat-based coding task input
- Agent-driven code understanding
- File search and file reading
- Patch / diff generation
- User-approved file modification
- Command execution and test feedback
- Iterative repair based on errors
- Local task logs and session persistence

Recommended stack:

```text
Desktop: Tauri 2
Frontend: React + TypeScript + Vite + Tailwind CSS + Shadcn UI
Local backend: Rust + Tauri commands
Agent prototype: Python + FastAPI + uv
Storage: SQLite
Sandbox: Docker, later stage
Protocol: Shared TypeScript / Rust message types
```

------

## Repository Structure

Use a monorepo layout.

```text
codex-like-app/
├── apps/
│   └── desktop/                  # Tauri desktop app
│       ├── src/                   # React frontend
│       │   ├── app/               # App entry, routing, layout
│       │   ├── components/        # Shared UI components
│       │   ├── features/          # Feature modules
│       │   │   ├── chat/          # Chat panel
│       │   │   ├── workspace/     # File tree and workspace view
│       │   │   ├── diff/          # Diff viewer
│       │   │   ├── terminal/      # Command output panel
│       │   │   ├── tasks/         # Agent task timeline
│       │   │   └── settings/      # Settings page
│       │   ├── hooks/
│       │   ├── lib/
│       │   ├── stores/
│       │   ├── styles/
│       │   └── main.tsx
│       │
│       └── src-tauri/             # Rust local backend
│           ├── src/
│           │   ├── main.rs
│           │   ├── commands/      # Tauri commands exposed to frontend
│           │   ├── fs/            # File read/write logic
│           │   ├── process/       # Command execution
│           │   ├── git/           # Git status/diff/patch helpers
│           │   ├── permissions/   # Permission checks
│           │   └── state/         # Local app state
│           ├── tauri.conf.json
│           └── Cargo.toml
│
├── python-agent/                  # First-stage agent backend
│   ├── src/
│   │   ├── main.py                # FastAPI entry
│   │   ├── agent/                 # Agent loop, planner, memory, prompts
│   │   ├── tools/                 # read_file, search_code, git_diff, apply_patch
│   │   ├── llm/                   # OpenAI / Anthropic / Gemini clients
│   │   ├── api/                   # FastAPI routes
│   │   └── storage/               # SQLite models and persistence
│   ├── tests/
│   ├── pyproject.toml
│   ├── uv.lock
│   └── .env.example
│
├── packages/
│   └── protocol/                  # Shared TypeScript protocol types
│       ├── src/
│       │   ├── events.ts
│       │   ├── commands.ts
│       │   ├── messages.ts
│       │   ├── tasks.ts
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
│
├── crates/                        # Future Rust core libraries
│   ├── agent-core/
│   ├── workspace/
│   ├── command-runner/
│   ├── git-tools/
│   ├── sandbox/
│   └── protocol-rs/
│
├── sandbox/                       # Docker sandbox configuration
├── data/                          # Local development data only
├── docs/                          # Architecture and design docs
├── scripts/                       # Dev/build/clean scripts
├── infra/                         # Future cloud infra
├── .github/workflows/
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── Cargo.toml
├── README.md
└── LICENSE
```

------

## Development Priorities

Implement the project in this order.

### Stage 1: Desktop UI Skeleton

Create the Tauri app and React UI layout.

Required panels:

- Left: workspace file tree
- Center: chat interface
- Right: diff viewer
- Bottom: terminal / command output
- Optional: task timeline panel

Do not implement complex agent behavior yet.

------

### Stage 2: Workspace Access

Implement local workspace selection and file tree display.

Rules:

- User must explicitly select a workspace directory.
- Do not scan the whole home directory by default.
- Exclude heavy or irrelevant paths:
  - `.git`
  - `node_modules`
  - `dist`
  - `build`
  - `.venv`
  - `__pycache__`
  - `.next`
  - `target`
- Respect `.gitignore` where possible.
- Limit very large files.

------

### Stage 3: Python Agent Connection

Connect the desktop app to the Python FastAPI agent.

Minimum flow:

```text
User message
→ Tauri frontend
→ Rust command or HTTP bridge
→ Python Agent
→ LLM response
→ Stream response back to UI
```

The first working version only needs normal text responses.

------

### Stage 4: Agent Tools

Implement basic tools:

- `read_file`
- `search_code`
- `git_diff`
- `generate_patch`
- `apply_patch`, only after user confirmation
- `run_command`, only after user confirmation

The agent should not directly modify files without approval.

------

### Stage 5: Diff and Confirmation

Preferred modification flow:

```text
Agent proposes patch
→ UI displays diff
→ User reviews diff
→ User confirms
→ Rust backend writes files
→ Git diff is updated
```

Do not write files directly from the Python agent.

------

### Stage 6: Command Execution and Feedback

Implement command execution through Rust/Tauri.

Required behavior:

- Show command before execution.
- Require user confirmation for risky commands.
- Stream stdout and stderr to UI.
- Support timeout and cancellation.
- Send command output back to the agent for iterative repair.

------

### Stage 7: Sandbox

Add Docker-based sandbox execution later.

Early stage may use local shell execution, but final design should prefer sandboxed execution for tests and dependency installation.

------

## Security Rules

### Frontend Restrictions

The React frontend must not directly:

- Read arbitrary files
- Write files
- Execute shell commands
- Delete files
- Access system directories

All privileged actions must go through Tauri Rust commands.

------

### User Confirmation Required

Always require confirmation before:

- Writing files
- Deleting files
- Moving files
- Applying patches
- Running shell commands
- Installing dependencies
- Running package manager commands
- Performing git commit, reset, checkout, merge, rebase, push
- Accessing files outside the selected workspace

------

### Agent Restrictions

The agent should:

- Generate proposed changes, not silently apply them
- Use structured tool calls
- Return patches or diffs for review
- Keep task logs
- Avoid modifying hidden/system files unless explicitly approved
- Avoid touching files outside the selected workspace

------

## Protocol Rules

Use shared protocol types instead of ad-hoc message shapes.

Define protocol types in:

```text
packages/protocol
```

Future Rust equivalents can live in:

```text
crates/protocol-rs
```

Recommended event types:

```ts
export type AgentEvent =
  | { type: "message"; content: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "diff"; filePath: string; patch: string }
  | { type: "command_output"; command: string; output: string }
  | { type: "task_done"; success: boolean };
```

Keep frontend, Rust backend, and Python agent aligned with the same protocol.

------

## Data Rules

The `data/` directory is for development data only.

Allowed:

- sample projects
- logs
- SQLite databases
- cached metadata

Not allowed:

- real user source code
- private credentials
- API keys
- sensitive documents

User workspaces should remain external paths selected by the user.

------

## Environment Files

Use `.env.example` to document required variables.

Never commit real `.env` files.

Possible variables:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
AGENT_PORT=8000
APP_DATABASE_URL=sqlite:///data/sqlite/app.db
```

------

## Root Workspace Config

Use `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Root `package.json` may contain:

```json
{
  "name": "codex-like-app",
  "private": true,
  "scripts": {
    "dev:desktop": "pnpm --filter desktop dev",
    "dev:agent": "cd python-agent && uv run uvicorn src.main:app --reload --port 8000",
    "dev": "concurrently \"pnpm dev:agent\" \"pnpm dev:desktop\""
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}
```

Root `Cargo.toml` should be updated only after Rust crates are initialized.

Example:

```toml
[workspace]
members = [
  "apps/desktop/src-tauri",
  "crates/agent-core",
  "crates/workspace",
  "crates/command-runner",
  "crates/git-tools",
  "crates/sandbox",
  "crates/protocol-rs"
]
resolver = "2"
```

If a crate does not yet contain its own `Cargo.toml`, do not include it in the workspace members.

------

## First Milestone

The first useful milestone is not a full Codex clone.

The first milestone is this working loop:

```text
1. Start desktop app
2. Select local project directory
3. Display file tree
4. Send user task to Python agent
5. Agent reads selected files
6. Agent returns proposed patch
7. UI displays diff
8. User confirms patch
9. Rust backend writes file
10. Rust backend runs test command
11. UI streams command output
12. Agent uses test output to continue repair
```

------

## What Not To Build First

Avoid these in the first phase:

- User account system
- Cloud sync
- Plugin marketplace
- Multi-user collaboration
- Complex long-term memory
- Full RAG system
- Automatic git push
- Autonomous file modification without approval
- Complex Docker orchestration
- Multi-agent architecture

Build the local coding loop first.

------

## Design Principle

Separate the system by responsibility:

```text
UI layer: apps/desktop/src
Local system access: apps/desktop/src-tauri
Agent logic: python-agent, later crates/agent-core
Shared protocol: packages/protocol
Execution isolation: sandbox
Documentation: docs
Scripts: scripts
```

The core product is not the chat UI. The core product is the safe local coding loop:

```text
understand workspace
→ propose change
→ show diff
→ ask approval
→ apply patch
→ run command
→ use feedback
→ repair again
```