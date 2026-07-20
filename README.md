# SpaceTimePy for VS Code

This extension explores SpaceTimePy v2 recordings directly beside Python source code.

## Migrated features

- Recorded-execution CodeLens entries are attached by function or qualified name, so they remain on the correct function when its line moves.
- A trace explorer synchronizes snapshots and source lines in both directions: trace navigation highlights the VS Code editor, while selecting a recorded line moves the trace to its first matching snapshot.
- A compact branch picker highlights the selected replay branch and its place in the session tree.
- The extension selects or initializes a project trace database, then starts and monitors the SpaceTimePy v2 JSON API.
- A Debug CodeLens launches a top-level function through a bundled wrapper, accepts either manual Python expressions or exact entry arguments from a selected previous call, applies line capture without adding source decorators, and opens the trace at the initial function pause. The same panel follows each later debugger stop.
- The debugger lightning action reloads edited function code, restores the paused frame state, and records the replacement suffix as a child branch whose first step is the mapped replacement of the paused source line.
- **Explore from checkpoint** reuses a compatible paused SpaceTimePy debug session and forks the selected historical step. When no debugger is open, it starts a new session instead.
- Selecting a trace step changes only the corresponding function in the editor to its recorded code definition. These edits remain unsaved and undoable; the extension asks before replacing unrecognized user edits.

Comparison and LivEx functionality from the previous extension are intentionally not included.

## Debug and replay workflow

Use **Debug with SpaceTimePy** above a top-level Python function. Choose either manual arguments—Python expressions exactly as they would appear inside the call, for example `[1, 4, 9], target=4`—or a previous call. Previous-call mode materializes the stored entry objects directly in Python, including trusted pickled values. The extension uses a bundled wrapper and does not add a decorator to the project file.

The trace explorer opens beside the source when the debugger first pauses in the function. At every later pause, the debug process commits its current recording and the explorer refreshes to the latest step and branch.

While that debug session is paused, save an edited function and use the lightning button in the debug toolbar. The hotswap runtime maps the paused line to the edited function, restores locals, records that migrated state as the replacement for the fork step, and tells SpaceTimePy to continue in a child branch of the same session.

From a line-level trace, choose a snapshot and use **Explore from checkpoint**. If the same SpaceTimePy execution is paused, the extension restores the selected locals and safe data globals into a replacement frame and records a new branch in that session. With no active debugger, it opens the selected source under `debugpy` and starts the branch there. An active unrelated debug session must be closed first.

As the trace timeline moves between code versions, the editor replaces only the recorded function—not the whole file—and does not save the change. Navigating between known recorded versions is automatic. If that function has user edits not recognized as a recorded or explorer-applied version, replacement requires confirmation. Editing the displayed version and choosing hotswap or checkpoint exploration saves it through the normal debugger workflow.

The first debugger migration intentionally supports top-level functions and one active captured call. The function must keep a compatible name and call signature after editing. Snapshot replay does not yet substitute recorded external-interaction results.

## Requirements

- Python 3.12 or newer
- `spacetimepy` 2.x installed in the selected Python environment
- The Microsoft Python extension
- `debugpy` supplied by the Microsoft Python extension
- An open workspace folder

The database selection order is:

1. `.vscode/spacetimepy.db` when it exists
2. `trace.db` in the project root when it exists
3. A newly initialized empty `.vscode/spacetimepy.db`

Empty databases are initialized with the same `TraceData.open(..., create_if_missing=True)` mechanism used by the SpaceTimePy MCP server. SpaceTimePy trace values may contain trusted pickle data, so do not place an untrusted database at either discovered path.

## Settings

- `spacetimepy.server.autoStart`: start the local JSON API automatically
- `spacetimepy.server.host` / `spacetimepy.server.port`: local API bind address
- `spacetimepy.apiUrl`: connect to an already running API instead of starting one
- `spacetimepy.pythonPath`: override the selected Python interpreter
- `spacetimepy.requestTimeout`: API request timeout
- `spacetimepy.codeLens.refreshInterval`: recorded-execution CodeLens refresh interval

All command and setting identifiers use the `spacetimepy` namespace.

Function capture and replay require the automatically selected local database. They are unavailable when `spacetimepy.apiUrl` points to an external server because that setting does not identify a writable database path.
