# MyCopilot desktop

The first-stage desktop shell uses Tauri 2, React, TypeScript, and Vite.

## Run the web frontend

From the repository root:

```bash
pnpm dev
```

Then open `http://127.0.0.1:1420`.

## Run the native macOS shell

```bash
pnpm --filter desktop tauri dev
```

The macOS window keeps the native traffic-light controls and uses an overlay
title bar so the application surface can extend behind them.

## Current scope

- Three-panel desktop layout
- Collapsible left and right sidebars
- Drag handles with constrained sidebar widths
- Responsive fallback that protects the center workspace
- Empty panel surfaces ready for feature modules

The frontend must not directly access arbitrary files or execute commands.
