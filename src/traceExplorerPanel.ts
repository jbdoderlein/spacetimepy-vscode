import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import {
	findPythonFunctions,
	functionForRecordedCall,
	recordedFileMatches,
} from './pythonFunctions';
import { filterRecordedValues, WithoutRuntimeValues } from './runtimeGlobals';
import {
	BranchDetail,
	FunctionCallDetail,
	SessionDetail,
	StackFrame,
	StackRecording,
} from './types';
import {
	BranchRecordings,
	buildBranchTimeline,
	recordingTimeline,
	TraceTimelineFrame,
} from './traceTimeline';

export interface TraceExplorerState {
	call: WithoutRuntimeValues<FunctionCallDetail>;
	recording: StackRecording;
	session: SessionDetail | null;
	branch: BranchDetail | null;
	branchFrames: TraceTimelineFrame[];
	branchRecordings: BranchRecordings;
	selectedBranchId: number | null;
	selectedStepId: number | null;
}

interface WebviewMessage {
	type?: string;
	branchId?: unknown;
	snapshotId?: unknown;
	functionCallId?: unknown;
	line?: unknown;
	stepId?: unknown;
	codeDefinitionId?: unknown;
}

export class TraceExplorerPanel {
	private static readonly panels = new Map<number, TraceExplorerPanel>();
	private readonly disposables: vscode.Disposable[] = [];
	private state: TraceExplorerState | null = null;
	private readonly recordingCache = new Map<number, Promise<StackRecording>>();
	private readonly lineDecoration: vscode.TextEditorDecorationType;
	private highlightedEditor: vscode.TextEditor | null = null;
	private highlightGeneration = 0;
	private readonly appliedSourceVersions = new Map<string, string>();
	private readonly sourceReplacementPrompts = new Map<string, Promise<boolean>>();

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly api: SpaceTimePyApiClient,
		private readonly callId: number,
		private readonly output: vscode.OutputChannel,
	) {
		this.lineDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('merge.currentContentBackground'),
			borderColor: new vscode.ThemeColor('editorInfo.foreground'),
			borderStyle: 'solid',
			borderWidth: '0 0 0 3px',
			isWholeLine: true,
		});
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage)),
			vscode.window.onDidChangeTextEditorSelection(event => this.handleEditorSelection(event)),
		);
	}

	public static async show(
		api: SpaceTimePyApiClient,
		callId: number,
		output: vscode.OutputChannel,
	): Promise<TraceExplorerPanel> {
		const existing = TraceExplorerPanel.panels.get(callId);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.One, true);
			await existing.refresh();
			return existing;
		}
		const panel = vscode.window.createWebviewPanel(
			'spacetimepy.traceExplorer',
			'SpaceTimePy Trace',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		const explorer = new TraceExplorerPanel(panel, api, callId, output);
		TraceExplorerPanel.panels.set(callId, explorer);
		try {
			await explorer.load();
			return explorer;
		} catch (error) {
			TraceExplorerPanel.panels.delete(callId);
			panel.dispose();
			throw error;
		}
	}

	public async refresh(): Promise<void> {
		await this.api.refresh();
		this.recordingCache.clear();
		await this.load();
	}

	private async load(): Promise<void> {
		const [loadedCall, recording] = await Promise.all([
			this.api.getFunctionCall(this.callId),
			this.getRecording(this.callId),
		]);
		const call = filterRecordedValues(loadedCall);
		const location = call.locations[call.locations.length - 1] ?? null;
		let session: SessionDetail | null = null;
		let branch: BranchDetail | null = null;
		if (location) {
			[session, branch] = await Promise.all([
				this.api.getSession(location.session_id),
				this.api.getBranch(location.branch_id),
			]);
		}
		const branchRecordings = branch
			? await this.getBranchRecordings(branch)
			: { [String(call.id)]: recording };

		this.state = {
			call,
			recording,
			session,
			branch,
			branchFrames: branch ? buildBranchTimeline(branch, branchRecordings) : recordingTimeline(recording),
			branchRecordings,
			selectedBranchId: branch?.id ?? null,
			selectedStepId: location?.step_id ?? null,
		};
		this.panel.title = `Trace: ${call.qualified_name ?? call.function_name}`;
		this.panel.webview.html = TraceExplorerPanel.createHtml(
			this.panel.webview.cspSource,
			this.state,
		);
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'reload':
					await this.api.refresh();
					this.recordingCache.clear();
					await this.load();
					break;
				case 'selectBranch':
					if (typeof message.branchId === 'number') {
						const branch = await this.api.getBranch(message.branchId);
						const recordings = await this.getBranchRecordings(branch);
						const frames = buildBranchTimeline(branch, recordings);
						if (this.state) {
							this.state.branch = branch;
							this.state.branchFrames = frames;
							this.state.branchRecordings = recordings;
							this.state.selectedBranchId = branch.id;
						}
						await this.panel.webview.postMessage({ type: 'branchLoaded', branch, frames, recordings });
					}
					break;
				case 'selectSnapshot':
					if (typeof message.snapshotId === 'number') {
						await this.sendSnapshot(message.snapshotId);
					}
					break;
				case 'highlightSource':
					if (typeof message.line === 'number') {
						await this.highlightSource(
							message.line,
							typeof message.functionCallId === 'number' ? message.functionCallId : undefined,
							typeof message.codeDefinitionId === 'string'
								|| typeof message.codeDefinitionId === 'number'
								? message.codeDefinitionId
								: undefined,
						);
					}
					break;
				case 'compareBranches':
					if (this.state?.session) {
						await vscode.commands.executeCommand('spacetimepy.compareTraces', {
							sessionId: this.state.session.id,
							branchId: this.state.selectedBranchId ?? undefined,
						});
					} else {
						throw new Error('This recording has no session metadata to compare.');
					}
					break;
				case 'replaySnapshot':
					if (
						typeof message.stepId === 'number'
						&& typeof message.functionCallId === 'number'
						&& this.state?.selectedBranchId !== null
						&& this.state?.selectedBranchId !== undefined
					) {
						await vscode.commands.executeCommand('spacetimepy.replaySnapshot', {
							branchId: this.state.selectedBranchId,
							stepId: message.stepId,
							functionCallId: message.functionCallId,
						});
					}
					break;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Trace explorer: ${detail}`);
			await this.panel.webview.postMessage({ type: 'error', message: detail });
		}
	}

	private async sendSnapshot(snapshotId: number): Promise<void> {
		const preloaded = Object.values(this.state?.branchRecordings ?? {})
			.flatMap(recording => recording.frames)
			.find(frame => frame.id === snapshotId);
		const snapshot = preloaded
			?? filterRecordedValues(await this.api.getSnapshot(snapshotId));
		await this.panel.webview.postMessage({
			type: 'snapshotLoaded',
			snapshotId,
			snapshot,
		});
	}

	private async highlightSource(
		line: number,
		functionCallId?: number,
		codeDefinitionId?: string | number,
	): Promise<void> {
		const generation = ++this.highlightGeneration;
		const recording = functionCallId === undefined
			? undefined
			: this.state?.branchRecordings[String(functionCallId)];
		const sourcePath = recording?.function.file_path
			?? recording?.function.file
			?? this.state?.call.file_path
			?? this.state?.call.file;
		if (!sourcePath || !fs.existsSync(sourcePath)) {
			throw new Error(`Recorded source file is unavailable: ${sourcePath ?? '(unknown)'}`);
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
		if (generation !== this.highlightGeneration) {
			return;
		}
		let displayedLine = line;
		if (recording && codeDefinitionId !== undefined) {
			displayedLine = await this.applyRecordedSourceVersion(
				document,
				recording,
				codeDefinitionId,
				generation,
				line,
			);
		}
		if (generation !== this.highlightGeneration) {
			return;
		}
		const visibleEditor = vscode.window.visibleTextEditors.find(
			candidate => candidate.document.uri.toString() === document.uri.toString(),
		);
		const editor = visibleEditor ?? await vscode.window.showTextDocument(document, {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: true,
			preview: false,
		});
		if (generation !== this.highlightGeneration) {
			return;
		}
		if (this.highlightedEditor && this.highlightedEditor !== editor) {
			this.highlightedEditor.setDecorations(this.lineDecoration, []);
		}
		this.highlightedEditor = editor;
		const lineIndex = Math.max(0, Math.min(displayedLine - 1, document.lineCount - 1));
		const range = document.lineAt(lineIndex).range;
		editor.setDecorations(this.lineDecoration, [range]);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private async applyRecordedSourceVersion(
		document: vscode.TextDocument,
		recording: StackRecording,
		codeDefinitionId: string | number,
		generation: number,
		recordedLine: number,
	): Promise<number> {
		const definition = recording.code_definitions[String(codeDefinitionId)];
		if (!definition?.code_content) {
			return recordedLine;
		}
		const functionInfo = functionForRecordedCall(
			findPythonFunctions(document.getText()),
			recording.function,
		);
		if (!functionInfo) {
			return recordedLine;
		}
		const displayedLine = definition.first_line_number === null
			? recordedLine
			: functionInfo.sourceLine + 1 + recordedLine - definition.first_line_number;
		const end = functionInfo.endLine + 1 < document.lineCount
			? new vscode.Position(functionInfo.endLine + 1, 0)
			: document.lineAt(functionInfo.endLine).rangeIncludingLineBreak.end;
		const range = new vscode.Range(
			new vscode.Position(functionInfo.sourceLine, 0),
			end,
		);
		const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		let replacement = definition.code_content.replace(/\r?\n/g, eol);
		if (end.character === 0 && !replacement.endsWith(eol)) {
			replacement += eol;
		}
		const current = document.getText(range);
		if (current === replacement) {
			this.appliedSourceVersions.set(document.uri.toString(), replacement);
			return displayedLine;
		}

		const lastApplied = this.appliedSourceVersions.get(document.uri.toString());
		const knownVersion = Object.values(recording.code_definitions).some(candidate => {
			let content = candidate.code_content.replace(/\r?\n/g, eol);
			if (end.character === 0 && !content.endsWith(eol)) {
				content += eol;
			}
			return content === current;
		});
		if (current !== lastApplied && !knownVersion) {
			const documentKey = document.uri.toString();
			let prompt = this.sourceReplacementPrompts.get(documentKey);
			if (!prompt) {
				const createdPrompt = Promise.resolve(vscode.window.showWarningMessage(
					`The current ${recording.function.function_name} source contains edits that are not in this trace.`,
					'Replace function with recorded version',
				)).then(action => action !== undefined);
				prompt = createdPrompt;
				this.sourceReplacementPrompts.set(documentKey, createdPrompt);
				const clean = () => {
					if (this.sourceReplacementPrompts.get(documentKey) === createdPrompt) {
						this.sourceReplacementPrompts.delete(documentKey);
					}
				};
				createdPrompt.then(clean, clean);
			}
			if (!await prompt || generation !== this.highlightGeneration) {
				return recordedLine;
			}
		}

		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, range, replacement);
		if (await vscode.workspace.applyEdit(edit)) {
			this.appliedSourceVersions.set(document.uri.toString(), replacement);
			return displayedLine;
		}
		return recordedLine;
	}

	private handleEditorSelection(event: vscode.TextEditorSelectionChangeEvent): void {
		if (!this.panel.visible || !this.state || event.selections.length === 0) {
			return;
		}
		const documentPath = event.textEditor.document.uri.fsPath;
		const workspacePath = vscode.workspace.getWorkspaceFolder(event.textEditor.document.uri)?.uri.fsPath;
		const matchingCallIds = Object.values(this.state.branchRecordings)
			.filter(recording => recordedFileMatches(
				recording.function.file_path ?? recording.function.file,
				documentPath,
				workspacePath,
			))
			.map(recording => recording.function.id);
		if (matchingCallIds.length === 0) {
			return;
		}

		const line = event.selections[0].active.line + 1;
		const functions = findPythonFunctions(event.textEditor.document.getText());
		const frameIndex = this.state.branchFrames.findIndex(frame => {
			if (!matchingCallIds.includes(frame.functionCallId)) {
				return false;
			}
			const recording = this.state?.branchRecordings[String(frame.functionCallId)];
			if (!recording) {
				return frame.line === line;
			}
			const definition = frame.codeDefinitionId === null
				? undefined
				: recording.code_definitions[String(frame.codeDefinitionId)];
			const functionInfo = functionForRecordedCall(functions, recording.function);
			const mappedLine = definition?.first_line_number !== null
				&& definition?.first_line_number !== undefined
				&& functionInfo
				? functionInfo.sourceLine + 1 + frame.line - definition.first_line_number
				: frame.line;
			return mappedLine === line;
		});
		if (frameIndex >= 0) {
			void this.panel.webview.postMessage({ type: 'selectFrame', index: frameIndex });
		}
	}

	private getRecording(callId: number): Promise<StackRecording> {
		let recording = this.recordingCache.get(callId);
		if (!recording) {
			recording = this.api.getStackRecording(callId).then(loaded => ({
				...loaded,
				frames: loaded.frames.map(filterRecordedValues),
			}));
			this.recordingCache.set(callId, recording);
		}
		return recording;
	}

	private async getBranchRecordings(branch: BranchDetail): Promise<BranchRecordings> {
		const callIds = [...new Set(
			branch.steps
				.map(step => step.function_call?.id ?? step.stack_snapshot?.function_call_id)
				.filter((callId): callId is number => callId !== undefined),
		)];
		const recordings = await Promise.all(callIds.map(callId => this.getRecording(callId)));
		return Object.fromEntries(recordings.map(recording => [String(recording.function.id), recording]));
	}

	private dispose(): void {
		if (TraceExplorerPanel.panels.get(this.callId) === this) {
			TraceExplorerPanel.panels.delete(this.callId);
		}
		this.highlightGeneration += 1;
		if (this.highlightedEditor) {
			this.highlightedEditor.setDecorations(this.lineDecoration, []);
		}
		this.lineDecoration.dispose();
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	public static createHtml(csp: string, state: TraceExplorerState): string {
		const nonce = randomBytes(16).toString('hex');
		const withoutStoredSource = (recording: StackRecording): StackRecording => ({
			...recording,
			function: { ...recording.function, code: null },
			code_definitions: {},
		});
		const webviewState: TraceExplorerState = {
			...state,
			recording: withoutStoredSource(state.recording),
			branchRecordings: Object.fromEntries(
				Object.entries(state.branchRecordings).map(
					([callId, recording]) => [callId, withoutStoredSource(recording)],
				),
			),
		};
		const serialized = JSON.stringify(webviewState)
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e')
			.replace(/&/g, '\\u0026');
		return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>SpaceTimePy Trace</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		body { padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); }
		button, input { font: inherit; }
		button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		.header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
		.header h1 { flex: 1; margin: 0; font-size: 1.15rem; }
		.meta { color: var(--vscode-descriptionForeground); font-size: .9em; }
		.layout { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); min-height: calc(100vh - 54px); }
		.execution { padding: 12px; border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
		.sidebar-section + .sidebar-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
		.sidebar-section h2, .card h2 { margin: 0 0 9px; font-size: .95rem; }
		.branch { display: block; width: 100%; margin: 2px 0; overflow: hidden; color: var(--vscode-sideBar-foreground); background: transparent; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
		.branch:hover { background: var(--vscode-list-hoverBackground); }
		.branch.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
		.values { min-width: 0; padding: 14px; }
		.card { margin-bottom: 12px; padding: 12px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
		.timeline-header, .controls { display: flex; align-items: center; gap: 8px; }
		.timeline-header { margin-bottom: 8px; }
		.timeline-header strong { flex: 1; }
		input[type=range] { flex: 1; min-width: 80px; }
		.local-control { margin-top: 14px; }
		.variables { max-height: 38vh; overflow: auto; }
		table { width: 100%; border-collapse: collapse; }
		th, td { padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; vertical-align: top; }
		th:first-child, td:first-child { width: 28%; }
		.variable-name { color: var(--vscode-debugTokenExpression-name, var(--vscode-symbolIcon-variableForeground, var(--vscode-foreground))); font-family: var(--vscode-editor-font-family); }
		.variable-value { overflow-wrap: anywhere; color: var(--vscode-debugTokenExpression-value, var(--vscode-foreground)); font-family: var(--vscode-editor-font-family); }
		.value-string { color: var(--vscode-debugTokenExpression-string, var(--vscode-symbolIcon-stringForeground, var(--vscode-foreground))); }
		.value-number { color: var(--vscode-debugTokenExpression-number, var(--vscode-symbolIcon-numberForeground, var(--vscode-foreground))); }
		.value-boolean { color: var(--vscode-debugTokenExpression-boolean, var(--vscode-symbolIcon-booleanForeground, var(--vscode-foreground))); }
		.value-null { color: var(--vscode-descriptionForeground); font-style: italic; }
		.value-object { color: var(--vscode-symbolIcon-objectForeground, var(--vscode-debugTokenExpression-value, var(--vscode-foreground))); }
		.error { color: var(--vscode-errorForeground); }
		.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
		.hidden-note { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: .85em; }
		@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } .execution { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); } }
	</style>
</head>
<body>
	<header class="header">
		<div><h1 id="title"></h1><div id="meta" class="meta"></div></div>
		<button id="reload" title="Refresh the database and reload this trace">Reload</button>
		<button id="compare" title="Align this branch with one of its forks line by line">Compare branches</button>
		<button id="replay" title="Explore from this state in the current debugger, or start one when needed">Explore from checkpoint</button>
	</header>
	<div class="layout">
		<aside class="execution">
			<section class="sidebar-section"><h2>Execution branches</h2><div id="branches"></div><p id="branch-empty" class="empty"></p></section>
			<section class="sidebar-section">
				<div class="timeline-header"><strong id="path-title">Recorded execution</strong><span id="position" class="meta"></span></div>
				<div class="controls"><button id="previous" title="Previous snapshot">←</button><input id="timeline" type="range" min="0" value="0"><button id="next" title="Next snapshot">→</button></div>
				<div class="controls local-control"><span class="meta">Same line</span><input id="local-timeline" type="range" min="0" value="0"><span id="local-position" class="meta"></span></div>
			</section>
		</aside>
		<main class="values">
			<div id="error" class="error"></div>
			<section class="card"><h2>Locals</h2><div id="locals" class="variables"></div></section>
			<section class="card"><h2>Globals</h2><div id="globals" class="variables"></div></section>
			<section class="card"><h2>Outcome</h2><div id="outcome" class="variables"></div></section>
		</main>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = ${serialized};
		const elements = Object.fromEntries(['title','meta','branches','branch-empty','error','path-title','position','timeline','local-timeline','local-position','locals','globals','outcome','previous','next','reload','compare','replay'].map(function(id) { return [id, document.getElementById(id)]; }));
		const loadedSnapshots = new Map();
		let frames = [];
		let currentIndex = 0;
		let currentBranchId = state.selectedBranchId;

		function text(value) { return value === null || value === undefined ? '' : String(value); }
		function displayName(call) { return call.qualified_name || call.function_name || call.function; }
		function branchName(branch) { return branch.name || ('Branch ' + branch.id); }
		function preloadRecordings(recordings) {
			Object.values(recordings || {}).forEach(function(recording) {
				recording.frames.forEach(function(frame) {
					loadedSnapshots.set(frame.id, frame);
				});
			});
		}

		preloadRecordings(state.branchRecordings);

		function renderHeader() {
			elements.title.textContent = displayName(state.call);
			const file = state.call.file_path || state.call.file || 'unknown file';
			const granularity = state.recording.frames.length > 0 ? state.recording.frames.length + ' snapshots' : 'function-level recording';
			elements.meta.textContent = file + ':' + (state.call.line || '?') + ' · ' + granularity + ' · ' + (state.call.outcome || 'recorded');
			renderOutcome();
		}

		function branchDepth(branch) {
			let depth = 0;
			let parent = branch.parent_branch_id;
			while (parent !== null && depth < state.session.branches.length) {
				depth += 1;
				const found = state.session.branches.find(function(item) { return item.id === parent; });
				parent = found ? found.parent_branch_id : null;
			}
			return depth;
		}

		function renderBranches() {
			elements.branches.replaceChildren();
			if (!state.session || state.session.branches.length === 0) {
				elements['branch-empty'].textContent = 'This recording has no branch metadata.';
				return;
			}
			elements['branch-empty'].textContent = '';
			state.session.branches.forEach(function(branch) {
				const button = document.createElement('button');
				button.className = 'branch' + (branch.id === currentBranchId ? ' selected' : '');
				button.style.paddingLeft = (8 + branchDepth(branch) * 16) + 'px';
				button.textContent = (branch.parent_branch_id === null ? '● ' : '↳ ') + branchName(branch);
				button.title = branch.parent_branch_id === null ? 'Main branch' : 'Forked at step ' + branch.forked_from_step_id;
				button.onclick = function() {
					currentBranchId = branch.id;
					renderBranches();
					elements['path-title'].textContent = 'Loading ' + branchName(branch) + '…';
					vscode.postMessage({ type: 'selectBranch', branchId: branch.id });
				};
				elements.branches.appendChild(button);
			});
		}

		function useBranch(branch, preserveStep, nextFrames) {
			currentBranchId = branch.id;
			frames = nextFrames;
			elements['path-title'].textContent = branchName(branch) + ' · resolved main path + branch suffix';
			const selected = preserveStep === null ? -1 : frames.findIndex(function(frame) { return frame.stepId === preserveStep; });
			currentIndex = selected >= 0 ? selected : 0;
			renderBranches();
			renderTimeline();
		}

		function renderTimeline() {
			const available = frames.length > 0;
			elements.replay.disabled = !available;
			elements.timeline.max = String(Math.max(0, frames.length - 1));
			elements.timeline.disabled = !available;
			elements.previous.disabled = !available || currentIndex === 0;
			elements.next.disabled = !available || currentIndex >= frames.length - 1;
			if (!available) {
				elements.position.textContent = 'Entry state · no line snapshots';
				elements['local-timeline'].max = '0';
				elements['local-timeline'].value = '0';
				elements['local-timeline'].disabled = true;
				elements['local-position'].textContent = 'entry';
				const entryLine = state.call.line || state.call.first_line_number || 1;
				renderSnapshot({
					line: entryLine,
					locals: state.call.locals || {},
					globals: state.call.globals || {},
					hidden_runtime_locals: state.call.hidden_runtime_locals,
					hidden_runtime_globals: state.call.hidden_runtime_globals
				});
				vscode.postMessage({ type: 'highlightSource', line: entryLine, functionCallId: state.call.id });
				return;
			}
			selectFrame(currentIndex);
		}

		function selectFrame(index) {
			if (frames.length === 0) { return; }
			currentIndex = Math.max(0, Math.min(index, frames.length - 1));
			const frame = frames[currentIndex];
			elements.timeline.value = String(currentIndex);
			elements.position.textContent = (currentIndex + 1) + ' / ' + frames.length + ' · line ' + frame.line;
			elements.previous.disabled = currentIndex === 0;
			elements.next.disabled = currentIndex >= frames.length - 1;
			renderLocalTimeline(frame);
			vscode.postMessage({ type: 'highlightSource', line: frame.line, functionCallId: frame.functionCallId, codeDefinitionId: frame.codeDefinitionId });
			const loaded = loadedSnapshots.get(frame.snapshotId);
			if (loaded) {
				renderSnapshot(loaded);
			} else {
				elements.locals.textContent = 'Loading snapshot…';
				elements.globals.textContent = 'Loading snapshot…';
				vscode.postMessage({ type: 'selectSnapshot', snapshotId: frame.snapshotId, functionCallId: frame.functionCallId });
			}
		}

		function renderLocalTimeline(frame) {
			const localIndices = [];
			frames.forEach(function(candidate, index) {
				if (candidate.line === frame.line && candidate.codeDefinitionId === frame.codeDefinitionId) { localIndices.push(index); }
			});
			const localIndex = localIndices.indexOf(currentIndex);
			elements['local-timeline'].max = String(Math.max(0, localIndices.length - 1));
			elements['local-timeline'].value = String(Math.max(0, localIndex));
			elements['local-timeline'].disabled = localIndices.length <= 1;
			elements['local-position'].textContent = localIndices.length > 0 ? (localIndex + 1) + ' / ' + localIndices.length : '0 / 0';
			elements['local-timeline'].oninput = function(event) { selectFrame(localIndices[Number(event.target.value)]); };
		}

		function renderSnapshot(snapshot) {
			if (!snapshot) {
				renderVariables(elements.locals, {});
				renderVariables(elements.globals, {});
				return;
			}
			renderVariables(elements.locals, snapshot.locals || {}, snapshot.hidden_runtime_locals);
			renderVariables(elements.globals, snapshot.globals || {}, snapshot.hidden_runtime_globals);
		}

		function valueText(value) {
			if (typeof value === 'string') { return value; }
			try { return JSON.stringify(value); } catch { return String(value); }
		}

		function valueClass(value) {
			if (value === null || value === undefined) { return 'value-null'; }
			if (typeof value === 'string') { return 'value-string'; }
			if (typeof value === 'number' || typeof value === 'bigint') { return 'value-number'; }
			if (typeof value === 'boolean') { return 'value-boolean'; }
			return 'value-object';
		}

		function renderOutcome() {
			const raised = state.call.outcome === 'raised' || state.call.outcome === 'exception';
			const label = raised ? 'exception' : 'return';
			const value = raised ? state.call.exception : state.call.return_value;
			renderVariables(elements.outcome, value ? { [label]: value } : {});
		}

		function hiddenNote(count) {
			const note = document.createElement('div');
			note.className = 'hidden-note';
			note.textContent = count + ' SpaceTimePy runtime ' + (count === 1 ? 'value' : 'values') + ' hidden';
			note.title = 'Names the SpaceTimePy hotswap runtime adds to the recorded frame.';
			return note;
		}

		function renderVariables(container, variables, hidden) {
			container.replaceChildren();
			const hiddenCount = hidden || 0;
			const entries = Object.entries(variables);
			if (entries.length === 0) {
				const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No recorded values.'; container.appendChild(empty);
				if (hiddenCount > 0) { container.appendChild(hiddenNote(hiddenCount)); }
				return;
			}
			const table = document.createElement('table');
			const header = document.createElement('tr');
			['Name', 'Value'].forEach(function(label) { const cell = document.createElement('th'); cell.textContent = label; header.appendChild(cell); });
			const head = document.createElement('thead'); head.appendChild(header); table.appendChild(head);
			const body = document.createElement('tbody');
			entries.forEach(function(entry) {
				const row = document.createElement('tr');
				const name = document.createElement('td');
				name.className = 'variable-name';
				name.textContent = entry[0];
				const value = document.createElement('td');
				value.className = 'variable-value ' + valueClass(entry[1].value);
				value.textContent = valueText(entry[1].value);
				value.title = entry[1].type || '';
				row.append(name, value);
				body.appendChild(row);
			});
			table.appendChild(body); container.appendChild(table);
			if (hiddenCount > 0) { container.appendChild(hiddenNote(hiddenCount)); }
		}

		elements.timeline.oninput = function(event) { selectFrame(Number(event.target.value)); };
		elements.previous.onclick = function() { selectFrame(currentIndex - 1); };
		elements.next.onclick = function() { selectFrame(currentIndex + 1); };
		elements.reload.onclick = function() { elements.reload.disabled = true; vscode.postMessage({ type: 'reload' }); };
		elements.compare.onclick = function() { vscode.postMessage({ type: 'compareBranches' }); };
		elements.replay.onclick = function() {
			const frame = frames[currentIndex];
			if (frame) { vscode.postMessage({ type: 'replaySnapshot', stepId: frame.stepId, functionCallId: frame.functionCallId }); }
		};
		window.addEventListener('message', function(event) {
			const message = event.data;
			if (message.type === 'selectFrame' && typeof message.index === 'number') {
				selectFrame(message.index);
			}
			if (message.type === 'branchLoaded') {
				preloadRecordings(message.recordings);
				useBranch(message.branch, null, message.frames);
			}
			if (message.type === 'snapshotLoaded') {
				loadedSnapshots.set(message.snapshotId, message.snapshot);
				if (frames[currentIndex] && frames[currentIndex].snapshotId === message.snapshotId) { renderSnapshot(message.snapshot); }
			}
			if (message.type === 'error') { elements.error.textContent = message.message; elements.reload.disabled = false; }
		});

		renderHeader();
		renderBranches();
		if (state.branch) { useBranch(state.branch, state.selectedStepId, state.branchFrames); }
		else { frames = state.branchFrames; elements['path-title'].textContent = 'Recorded execution'; renderTimeline(); }
	</script>
</body>
</html>`;
	}
}
