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
- Recorded values that the bundled hotswap runtime adds to a captured frame are hidden from the Locals and Globals cards, which report how many were hidden.
- **Trace comparison** aligns a branch with one of its forks step by step, using the alignment service of SpaceTimePy. Each aligned row is classified as match, updated, inserted or deleted, the two recorded code versions are shown side by side with the aligned line highlighted in both, and an execution graph draws one node per executed line, colouring the lines only one branch reached.

LivEx functionality from the previous extension is intentionally not included.

## Trace comparison

Open **SpaceTimePy: Compare Branch Traces** from the command palette, or use **Compare branches** in the trace explorer header to compare the branch already on screen.

Alignment runs inside one session and always compares a reference branch with one of its direct forks, starting at the step the fork was created from. The extension therefore offers exactly those branch pairs; a session without a fork has nothing to compare, so record one first with the hotswap action or **Explore from checkpoint**.

For a line-granularity trace the default algorithm is `stack-snapshot`, which diffs the two recorded code definitions and derives a line-to-line correspondence from that diff before matching the trace steps. Another registered offline algorithm can be selected instead. Alignments are calculated on demand by the API and are not stored.

The panel shows the same alignment three ways: the aligned rows as a list, the two recorded sources side by side, and an execution graph.

The graph carries one node per executed line. A line both branches ran is a single grey node, so the two traces share one spine that splits where only one branch executed a line and joins again at the next aligned line. Reference-only lines are red on the left, fork-only lines green on the right, and a shared line whose code changed is yellow. Edges follow the recorded order of each trace and take the colour of the branches that took them, so a loop appears as an edge returning to an earlier node and a repeated line keeps one node with its visit count beside it. Selecting a node selects its aligned row, and selecting a row highlights its node.

Selecting an aligned row shows both recorded source versions side by side and highlights the aligned line in each. An inserted or deleted row has no counterpart on one side, so that pane keeps the nearest recorded context instead. While **Reveal aligned line in the editor** is enabled, the row also highlights the matching line in the open source file. That panel never rewrites the file: it maps the recorded line through the current position of the same function, and the highlight says so when the file no longer matches the recorded version.

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
