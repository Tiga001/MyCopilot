// Implements the right-sidebar embedded command-line terminal feature.
// This module is intentionally separate from the agent command runner.

pub mod commands;

mod session;

pub use session::TerminalSessionState;
