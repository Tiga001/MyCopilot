# MyCopilot

A local-first, Codex-like desktop application for software engineering tasks.

## Repository layout

- `apps/desktop`: Tauri 2 desktop application and React frontend
- `python-agent`: FastAPI-based first-stage agent backend
- `packages/protocol`: shared TypeScript protocol definitions
- `crates`: future Rust core libraries
- `sandbox`: future Docker sandbox configuration
- `data`: local development data only; never store user source code or secrets
- `docs`: architecture and design documentation
- `scripts`: development and build scripts
- `infra`: future cloud infrastructure

The implementation order and security constraints are defined in `AGENTS.md`.

## Current status

This repository currently contains the monorepo skeleton. Tauri, React, Python,
and Rust packages should be initialized in their designated directories before
adding them to runnable workspace configuration.
