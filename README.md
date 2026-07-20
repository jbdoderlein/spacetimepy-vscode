# SpaceTimePy for VS Code

This extension explores SpaceTimePy v2 recordings directly beside Python source code.

## Migrated features

- Recorded-execution CodeLens entries are attached by function or qualified name, so they remain on the correct function when its line moves.
- A trace explorer synchronizes snapshots and source lines in both directions: trace navigation highlights the VS Code editor, while selecting a recorded line moves the trace to its first matching snapshot.
- A compact branch picker highlights the selected replay branch and its place in the session tree.
- The extension selects or initializes a project trace database, then starts and monitors the SpaceTimePy v2 JSON API.

Comparison and LivEx functionality from the previous extension are intentionally not included. Function launch and debugger hotswapping are the next migration slices.

## Requirements

- Python 3.12 or newer
- `spacetimepy` 2.x installed in the selected Python environment
- The Microsoft Python extension
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
