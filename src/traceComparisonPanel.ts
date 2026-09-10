import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import { findPythonFunctions, functionForRecordedCall } from './pythonFunctions';
import {
	branchLabel,
	buildComparisonGraph,
	buildComparisonRows,
	ComparisonBranchPair,
	ComparisonGraph,
	ComparisonRow,
	ComparisonSide,
	comparisonBranchPairs,
	initialRowIndex,
	RelationCounts,
	relationCounts,
} from './traceComparison';
import {
	AlignmentAlgorithm,
	BranchDetail,
	CodeDefinition,
	FunctionCallSummary,
	SessionDetail,
} from './types';

export interface ComparisonCodeVersion {
	name: string;
	content: string;
	firstLineNumber: number | null;
}

export interface ComparisonPayload {
	algorithm: string;
	algorithmVersion: string;
	referenceLabel: string;
	targetLabel: string;
	rows: ComparisonRow[];
	counts: RelationCounts;
	graph: ComparisonGraph;
	codeVersions: Record<string, ComparisonCodeVersion>;
	initialIndex: number | null;
}

export interface ComparisonPairChoice {
	referenceId: number;
	targetId: number;
	label: string;
}

export interface TraceComparisonState {
	sessionId: number;
	sessionLabel: string;
	stepKind: string;
	pairs: ComparisonPairChoice[];
	algorithms: AlignmentAlgorithm[];
	selectedPairIndex: number | null;
}

interface WebviewMessage {
	type?: string;
	pairIndex?: unknown;
	algorithm?: unknown;
	side?: unknown;
	stepId?: unknown;
	line?: unknown;
	functionCallId?: unknown;
	codeDefinitionId?: unknown;
}

function pairChoice(pair: ComparisonBranchPair): ComparisonPairChoice {
	return {
		referenceId: pair.reference.id,
		targetId: pair.target.id,
		label: `${branchLabel(pair.reference)} → ${branchLabel(pair.target)}`,
	};
}

export class TraceComparisonPanel {
	private static readonly panels = new Map<number, TraceComparisonPanel>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly lineDecoration: vscode.TextEditorDecorationType;
	private state: TraceComparisonState | null = null;
	private rows: ComparisonRow[] = [];
	private branches = new Map<number, BranchDetail>();
	private highlightedEditor: vscode.TextEditor | null = null;
	private highlightGeneration = 0;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly api: SpaceTimePyApiClient,
		private readonly sessionId: number,
		private readonly output: vscode.OutputChannel,
	) {
		this.lineDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('merge.incomingContentBackground'),
			borderColor: new vscode.ThemeColor('editorInfo.foreground'),
			borderStyle: 'solid',
			borderWidth: '0 0 0 3px',
			isWholeLine: true,
		});
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(
				message => this.handleMessage(message as WebviewMessage),
			),
		);
	}

	public static async show(
		api: SpaceTimePyApiClient,
		sessionId: number,
		output: vscode.OutputChannel,
		preferredBranchId?: number,
	): Promise<TraceComparisonPanel> {
		const existing = TraceComparisonPanel.panels.get(sessionId);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			await existing.load(preferredBranchId);
			return existing;
		}
		const panel = vscode.window.createWebviewPanel(
			'spacetimepy.traceComparison',
			'SpaceTimePy Comparison',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		const comparison = new TraceComparisonPanel(panel, api, sessionId, output);
		TraceComparisonPanel.panels.set(sessionId, comparison);
		try {
			await comparison.load(preferredBranchId);
			return comparison;
		} catch (error) {
			TraceComparisonPanel.panels.delete(sessionId);
			panel.dispose();
			throw error;
		}
	}

	private async load(preferredBranchId?: number): Promise<void> {
		const [session, algorithms] = await Promise.all([
			this.api.getSession(this.sessionId),
			this.loadAlgorithms(),
		]);
		const pairs = comparisonBranchPairs(session).map(pairChoice);
		const preferred = pairs.findIndex(
			pair => pair.targetId === preferredBranchId || pair.referenceId === preferredBranchId,
		);
		this.state = {
			sessionId: session.id,
			sessionLabel: session.name ?? `Session ${session.id}`,
			stepKind: session.step_kind,
			pairs,
			algorithms,
			selectedPairIndex: pairs.length === 0 ? null : Math.max(0, preferred),
		};
		this.rows = [];
		this.branches.clear();
		this.panel.title = `Compare: ${this.state.sessionLabel}`;
		this.panel.webview.html = TraceComparisonPanel.createHtml(
			this.panel.webview.cspSource,
			this.state,
		);
	}

	private async loadAlgorithms(): Promise<AlignmentAlgorithm[]> {
		try {
			return (await this.api.getAlignmentAlgorithms()).filter(algorithm => algorithm.offline);
		} catch (error) {
			this.output.appendLine(
				`Trace comparison: alignment algorithms unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'reload':
					await this.api.refresh();
					await this.load();
					break;
				case 'compare':
					if (typeof message.pairIndex === 'number') {
						await this.compare(
							message.pairIndex,
							typeof message.algorithm === 'string' && message.algorithm
								? message.algorithm
								: undefined,
						);
					}
					break;
				case 'revealStep':
					if (typeof message.line === 'number' && typeof message.functionCallId === 'number') {
						await this.revealStep(
							message.line,
							message.functionCallId,
							typeof message.codeDefinitionId === 'string'
								|| typeof message.codeDefinitionId === 'number'
								? message.codeDefinitionId
								: undefined,
						);
					}
					break;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Trace comparison: ${detail}`);
			await this.panel.webview.postMessage({ type: 'error', message: detail });
		}
	}

	private async compare(pairIndex: number, algorithm?: string): Promise<void> {
		const pair = this.state?.pairs[pairIndex];
		if (!pair) {
			throw new Error('Select a branch pair to compare.');
		}
		const [alignment, reference, target] = await Promise.all([
			this.api.compareAlignment({
				referenceBranchId: pair.referenceId,
				targetBranchId: pair.targetId,
				algorithm,
			}),
			this.api.getBranch(pair.referenceId, true),
			this.api.getBranch(pair.targetId, false),
		]);
		this.branches = new Map([[reference.id, reference], [target.id, target]]);
		this.rows = buildComparisonRows(alignment, reference, target);
		const payload: ComparisonPayload = {
			algorithm: alignment.algorithm,
			algorithmVersion: alignment.algorithm_version,
			referenceLabel: branchLabel(reference),
			targetLabel: branchLabel(target),
			rows: this.rows,
			counts: relationCounts(this.rows),
			graph: buildComparisonGraph(this.rows),
			codeVersions: await this.loadCodeVersions(this.rows),
			initialIndex: initialRowIndex(this.rows),
		};
		await this.panel.webview.postMessage({ type: 'comparison', payload });
	}

	private async loadCodeVersions(
		rows: ComparisonRow[],
	): Promise<Record<string, ComparisonCodeVersion>> {
		const identifiers = new Set<string>();
		for (const row of rows) {
			for (const side of [row.reference, row.target]) {
				if (side?.codeDefinitionId !== null && side?.codeDefinitionId !== undefined) {
					identifiers.add(String(side.codeDefinitionId));
				}
			}
		}
		const loaded = await Promise.all(
			[...identifiers].map(async identifier => {
				try {
					const definition = await this.api.getCodeDefinition(identifier);
					return [identifier, TraceComparisonPanel.codeVersion(definition)] as const;
				} catch (error) {
					this.output.appendLine(
						`Trace comparison: code version ${identifier} unavailable: ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				}
			}),
		);
		return Object.fromEntries(loaded.filter(entry => entry !== null));
	}

	private static codeVersion(definition: CodeDefinition): ComparisonCodeVersion {
		return {
			name: definition.qualified_name ?? definition.name,
			content: definition.code_content ?? definition.content,
			firstLineNumber: definition.first_line_number ?? definition.first_line_no,
		};
	}

	/**
	 * Highlight an aligned trace line in the editor.
	 *
	 * The panel never rewrites the file, so the recorded line is mapped through
	 * the current position of the same function and the decoration says when the
	 * open source no longer matches the recorded version.
	 */
	private async revealStep(
		line: number,
		functionCallId: number,
		codeDefinitionId?: string | number,
	): Promise<void> {
		const generation = ++this.highlightGeneration;
		const call = this.findCall(functionCallId) ?? await this.api.getFunctionCall(functionCallId);
		const sourcePath = call.file_path ?? call.file;
		if (!sourcePath || !fs.existsSync(sourcePath)) {
			throw new Error(`Recorded source file is unavailable: ${sourcePath ?? '(unknown)'}`);
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
		if (generation !== this.highlightGeneration) {
			return;
		}
		const functionInfo = functionForRecordedCall(
			findPythonFunctions(document.getText()),
			call,
		);
		const definition = codeDefinitionId === undefined
			? null
			: await this.api.getCodeDefinition(codeDefinitionId).catch(() => null);
		if (generation !== this.highlightGeneration) {
			return;
		}
		const firstLineNumber = definition?.first_line_number ?? definition?.first_line_no ?? null;
		const displayedLine = functionInfo && firstLineNumber !== null
			? functionInfo.sourceLine + 1 + line - firstLineNumber
			: line;
		const recordedSource = definition?.code_content ?? definition?.content ?? null;
		const currentSource = functionInfo
			? document.getText(new vscode.Range(
				new vscode.Position(functionInfo.sourceLine, 0),
				document.lineAt(functionInfo.endLine).range.end,
			))
			: null;
		const matchesRecording = recordedSource !== null
			&& currentSource !== null
			&& recordedSource.trim() === currentSource.trim();

		const editor = vscode.window.visibleTextEditors.find(
			candidate => candidate.document.uri.toString() === document.uri.toString(),
		) ?? await vscode.window.showTextDocument(document, {
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
		editor.setDecorations(this.lineDecoration, [{
			range,
			hoverMessage: matchesRecording
				? `SpaceTimePy: aligned trace line ${line}`
				: `SpaceTimePy: aligned trace line ${line} of a recorded version that differs from this file`,
		}]);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private findCall(functionCallId: number): FunctionCallSummary | undefined {
		for (const branch of this.branches.values()) {
			for (const step of branch.steps) {
				if (step.function_call?.id === functionCallId) {
					return step.function_call;
				}
			}
		}
		return undefined;
	}

	public dispose(): void {
		TraceComparisonPanel.panels.delete(this.sessionId);
		this.highlightedEditor?.setDecorations(this.lineDecoration, []);
		this.lineDecoration.dispose();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	public static createHtml(csp: string, state: TraceComparisonState): string {
		const nonce = randomBytes(16).toString('hex');
		const serialized = JSON.stringify(state)
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e')
			.replace(/&/g, '\\u0026');
		return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>SpaceTimePy Comparison</title>
	<style nonce="${nonce}">
		:root {
			color-scheme: light dark;
			--relation-match: var(--vscode-descriptionForeground, #808080);
			--relation-updated: var(--vscode-charts-yellow, #d7a100);
			--relation-inserted: var(--vscode-charts-green, #4caf50);
			--relation-deleted: var(--vscode-charts-red, #d16969);
		}
		body { padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); }
		button, select { font: inherit; }
		button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
		button:hover:enabled { background: var(--vscode-button-hoverBackground); }
		button:disabled { opacity: .55; cursor: default; }
		select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); padding: 4px 6px; max-width: 100%; }
		.header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
		.header h1 { flex: 1; margin: 0; font-size: 1.15rem; }
		.meta { color: var(--vscode-descriptionForeground); font-size: .9em; }
		.controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
		.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
		.field label { color: var(--vscode-descriptionForeground); font-size: .85em; }
		.badge { padding: 1px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 9px; font-size: .85em; }
		.summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
		.legend { display: flex; flex-wrap: wrap; gap: 10px; margin-left: auto; }
		.legend span { display: flex; align-items: center; gap: 4px; font-size: .85em; }
		.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
		.swatch.match { background: var(--relation-match); }
		.swatch.updated { background: var(--relation-updated); }
		.swatch.inserted { background: var(--relation-inserted); }
		.swatch.deleted { background: var(--relation-deleted); }
		.layout { display: grid; grid-template-columns: minmax(210px, 280px) minmax(0, 1fr) minmax(200px, 360px); align-items: start; }
		.rows { max-height: calc(100vh - 190px); overflow: auto; border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
		table { width: 100%; border-collapse: collapse; }
		th, td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; white-space: nowrap; }
		th { position: sticky; top: 0; background: var(--vscode-sideBar-background); font-size: .85em; }
		tbody tr { cursor: pointer; border-left: 3px solid transparent; }
		tbody tr:hover { background: var(--vscode-list-hoverBackground); }
		tbody tr.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
		tr.relation-match { border-left-color: var(--relation-match); }
		tr.relation-updated { border-left-color: var(--relation-updated); }
		tr.relation-inserted { border-left-color: var(--relation-inserted); }
		tr.relation-deleted { border-left-color: var(--relation-deleted); }
		.panes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; min-width: 0; }
		.pane { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--vscode-panel-border); }
		.pane header { display: flex; align-items: baseline; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
		.pane header strong { font-size: .95rem; }
		.code { max-height: calc(100vh - 260px); overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
		.code-line { display: flex; gap: 10px; padding: 0 10px; white-space: pre; }
		.code-line .number { min-width: 3.5ch; color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
		.code-line.aligned { background: var(--vscode-editor-selectionHighlightBackground); }
		.code-line.aligned.relation-match { box-shadow: inset 3px 0 0 var(--relation-match); }
		.code-line.aligned.relation-updated { box-shadow: inset 3px 0 0 var(--relation-updated); }
		.code-line.aligned.relation-inserted { box-shadow: inset 3px 0 0 var(--relation-inserted); }
		.code-line.aligned.relation-deleted { box-shadow: inset 3px 0 0 var(--relation-deleted); }
		.error { padding: 0 16px; color: var(--vscode-errorForeground); }
		.empty { padding: 12px 16px; color: var(--vscode-descriptionForeground); font-style: italic; }
		.graph { display: flex; flex-direction: column; min-width: 0; border-left: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
		.graph header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
		.graph header strong { font-size: .95rem; }
		.graph-canvas { max-height: calc(100vh - 226px); overflow: auto; padding: 8px 4px; }
		.graph-canvas svg { display: block; }
		.trace-node rect { fill: var(--vscode-editor-background); stroke: var(--relation-match); stroke-width: 2px; }
		.trace-node text { fill: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 11px; text-anchor: middle; dominant-baseline: central; }
		.trace-node .visits { fill: var(--vscode-descriptionForeground); font-size: 9px; text-anchor: end; }
		.trace-node { cursor: pointer; }
		.trace-node:hover rect { fill: var(--vscode-list-hoverBackground); }
		.trace-node.side-shared rect { stroke: var(--relation-match); }
		.trace-node.side-shared.relation-updated rect { stroke: var(--relation-updated); fill: color-mix(in srgb, var(--relation-updated) 20%, var(--vscode-editor-background)); }
		.trace-node.side-reference rect { stroke: var(--relation-deleted); fill: color-mix(in srgb, var(--relation-deleted) 22%, var(--vscode-editor-background)); }
		.trace-node.side-target rect { stroke: var(--relation-inserted); fill: color-mix(in srgb, var(--relation-inserted) 22%, var(--vscode-editor-background)); }
		.trace-node.selected rect { stroke-width: 3px; }
		.trace-node.selected text { font-weight: 700; }
		.trace-node:focus { outline: none; }
		.trace-node:focus rect { stroke-dasharray: 3 2; }
		.trace-edge { fill: none; stroke-width: 1.6px; }
		.trace-edge.side-shared { stroke: var(--relation-match); }
		.trace-edge.side-reference { stroke: var(--relation-deleted); }
		.trace-edge.side-target { stroke: var(--relation-inserted); }
		.trace-arrow { stroke: none; }
		.trace-arrow.side-shared { fill: var(--relation-match); }
		.trace-arrow.side-reference { fill: var(--relation-deleted); }
		.trace-arrow.side-target { fill: var(--relation-inserted); }
		@media (max-width: 1100px) { .layout { grid-template-columns: minmax(210px, 290px) minmax(0, 1fr); } .graph { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--vscode-panel-border); } .graph-canvas { max-height: 60vh; } }
		@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } .rows { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); } .panes { grid-template-columns: 1fr; } }
	</style>
</head>
<body>
	<header class="header">
		<div><h1 id="title"></h1><div id="session-meta" class="meta"></div></div>
		<button id="reload" title="Refresh the database and reload this session">Reload</button>
	</header>
	<div class="controls">
		<div class="field"><label for="pair">Reference branch → fork</label><select id="pair"></select></div>
		<div class="field"><label for="algorithm">Alignment algorithm</label><select id="algorithm"></select></div>
		<button id="compare">Compare traces</button>
		<label class="meta"><input id="sync" type="checkbox" checked> Reveal aligned line in the editor</label>
	</div>
	<div id="error" class="error"></div>
	<div id="summary" class="summary" hidden></div>
	<p id="placeholder" class="empty"></p>
	<div id="layout" class="layout" hidden>
		<div class="rows">
			<table>
				<thead><tr><th>Reference</th><th>Relation</th><th>Fork</th></tr></thead>
				<tbody id="rows"></tbody>
			</table>
		</div>
		<div class="panes">
			<section class="pane"><header><strong>Reference</strong><span id="reference-meta" class="meta"></span></header><div id="reference-code" class="code"></div></section>
			<section class="pane"><header><strong>Fork</strong><span id="target-meta" class="meta"></span></header><div id="target-code" class="code"></div></section>
		</div>
		<aside class="graph">
			<header>
				<strong>Execution graph</strong><span id="graph-meta" class="meta"></span>
				<span class="legend" aria-label="Execution graph legend">
					<span><i class="swatch match"></i>both</span>
					<span><i class="swatch updated"></i>changed</span>
					<span><i class="swatch deleted"></i>reference only</span>
					<span><i class="swatch inserted"></i>fork only</span>
				</span>
			</header>
			<div id="graph" class="graph-canvas"></div>
		</aside>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = ${serialized};
		const elements = Object.fromEntries(['title','session-meta','pair','algorithm','compare','sync','reload','error','summary','placeholder','layout','rows','reference-meta','target-meta','reference-code','target-code','graph','graph-meta'].map(function(id) { return [id, document.getElementById(id)]; }));
		let comparison = null;
		let selectedIndex = null;

		function option(value, label, selected) {
			const element = document.createElement('option');
			element.value = String(value);
			element.textContent = label;
			element.selected = Boolean(selected);
			return element;
		}

		function renderHeader() {
			elements.title.textContent = 'Trace comparison · ' + state.sessionLabel;
			elements['session-meta'].textContent = state.stepKind + ' trace · ' + state.pairs.length + ' comparable branch pair' + (state.pairs.length === 1 ? '' : 's');
		}

		function renderControls() {
			elements.pair.replaceChildren();
			state.pairs.forEach(function(pair, index) {
				elements.pair.appendChild(option(index, pair.label, index === state.selectedPairIndex));
			});
			elements.algorithm.replaceChildren();
			elements.algorithm.appendChild(option('', 'Default for this trace granularity', true));
			state.algorithms.forEach(function(algorithm) {
				elements.algorithm.appendChild(option(algorithm.name, algorithm.name + ' · ' + algorithm.version, false));
			});
			const comparable = state.pairs.length > 0;
			elements.pair.disabled = !comparable;
			elements.compare.disabled = !comparable;
			elements.placeholder.textContent = comparable
				? 'Choose a branch pair, then compare. Alignments are calculated on demand and are not stored.'
				: 'This session has no forked branch to compare. Use the hotswap action or “Explore from checkpoint” to create one.';
		}

		function relationCell(side, relation) {
			const cell = document.createElement('td');
			cell.textContent = side ? side.label : '—';
			if (!side) { cell.classList.add('meta'); }
			cell.title = side ? 'Step ' + side.stepId + ' · position ' + side.position + ' · ' + relation : 'No corresponding step';
			return cell;
		}

		function renderSummary() {
			const counts = comparison.counts;
			elements.summary.replaceChildren();
			const pair = document.createElement('strong');
			pair.textContent = comparison.referenceLabel + ' → ' + comparison.targetLabel;
			const algorithm = document.createElement('span');
			algorithm.className = 'badge';
			algorithm.textContent = comparison.algorithm + ' · ' + comparison.algorithmVersion;
			const total = document.createElement('span');
			total.className = 'badge';
			total.textContent = comparison.rows.length + ' aligned rows';
			const legend = document.createElement('span');
			legend.className = 'legend';
			['match','updated','inserted','deleted'].forEach(function(relation) {
				const item = document.createElement('span');
				const swatch = document.createElement('i');
				swatch.className = 'swatch ' + relation;
				item.appendChild(swatch);
				item.appendChild(document.createTextNode(relation + ' ' + counts[relation]));
				legend.appendChild(item);
			});
			elements.summary.append(pair, algorithm, total, legend);
			elements.summary.hidden = false;
		}

		function renderRows() {
			elements.rows.replaceChildren();
			comparison.rows.forEach(function(row) {
				const line = document.createElement('tr');
				line.className = 'relation-' + row.relation;
				line.dataset.index = String(row.index);
				const relation = document.createElement('td');
				relation.textContent = row.relation;
				line.append(relationCell(row.reference, row.relation), relation, relationCell(row.target, row.relation));
				line.onclick = function() { selectRow(row.index); };
				elements.rows.appendChild(line);
			});
		}

		function nearestSide(index, which) {
			for (let distance = 0; distance < comparison.rows.length; distance += 1) {
				const candidates = distance === 0 ? [index] : [index - distance, index + distance];
				for (const candidate of candidates) {
					const row = comparison.rows[candidate];
					if (row && row[which]) { return row[which]; }
				}
			}
			return null;
		}

		function renderCode(which, side, aligned, relation) {
			const container = elements[which + '-code'];
			const meta = elements[which + '-meta'];
			container.replaceChildren();
			const identifier = side && side.codeDefinitionId !== null && side.codeDefinitionId !== undefined ? String(side.codeDefinitionId) : null;
			const version = identifier === null ? null : comparison.codeVersions[identifier];
			if (!side || !version) {
				meta.textContent = side ? 'No stored source for this step' : 'No corresponding step';
				return;
			}
			const first = version.firstLineNumber === null ? 1 : version.firstLineNumber;
			meta.textContent = version.name + ' · ' + (aligned ? 'line ' + side.line : 'nearest recorded context');
			let alignedElement = null;
			version.content.split(/\r?\n/).forEach(function(text, offset) {
				const number = first + offset;
				const element = document.createElement('div');
				element.className = 'code-line';
				if (aligned && number === side.line) {
					element.classList.add('aligned', 'relation-' + relation);
					alignedElement = element;
				}
				const gutter = document.createElement('span');
				gutter.className = 'number';
				gutter.textContent = String(number);
				const source = document.createElement('span');
				source.textContent = text;
				element.append(gutter, source);
				container.appendChild(element);
			});
			if (alignedElement) { alignedElement.scrollIntoView({ block: 'center' }); }
		}

		const SVG_NS = 'http://www.w3.org/2000/svg';
		const NODE_HEIGHT = 26;
		const ROW_GAP = 54;
		const COLUMN_GAP = 96;
		const COLUMN_INDEX = { reference: 0, shared: 1, target: 2 };

		function svg(tag, attributes) {
			const element = document.createElementNS(SVG_NS, tag);
			Object.keys(attributes || {}).forEach(function(name) {
				element.setAttribute(name, String(attributes[name]));
			});
			return element;
		}

		function nodeWidth(label) {
			return Math.max(30, label.length * 7 + 18);
		}

		function arrowMarker(side) {
			const marker = svg('marker', {
				id: 'arrow-' + side, viewBox: '0 0 8 8', refX: 7, refY: 4,
				markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse'
			});
			marker.appendChild(svg('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: 'trace-arrow side-' + side }));
			return marker;
		}

		function edgePath(from, to, bow) {
			if (to.y > from.y) {
				const y1 = from.y + NODE_HEIGHT / 2;
				const y2 = to.y - NODE_HEIGHT / 2;
				const middle = (y1 + y2) / 2;
				return 'M ' + from.x + ' ' + y1 + ' C ' + from.x + ' ' + middle + ', ' + to.x + ' ' + middle + ', ' + to.x + ' ' + y2;
			}
			// A loop returns to an earlier line. Leaving from the right of both
			// nodes and running up a lane clear of every column keeps the return
			// path from crossing the nodes in between.
			const radius = 8;
			const start = from.x + from.width / 2;
			const end = to.x + to.width / 2;
			return 'M ' + start + ' ' + from.y
				+ ' H ' + (bow - radius)
				+ ' Q ' + bow + ' ' + from.y + ' ' + bow + ' ' + (from.y - radius)
				+ ' V ' + (to.y + radius)
				+ ' Q ' + bow + ' ' + to.y + ' ' + (bow - radius) + ' ' + to.y
				+ ' H ' + end;
		}

		function renderGraph() {
			const graph = comparison.graph;
			elements.graph.replaceChildren();
			elements['graph-meta'].textContent = graph.nodes.length + ' nodes · ' + graph.edges.length + ' edges';
			if (graph.nodes.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = 'No executed lines to graph.';
				elements.graph.appendChild(empty);
				return;
			}
			const widest = Math.max.apply(null, graph.nodes.map(function(node) { return nodeWidth(node.label); }));
			const columnWidth = Math.max(COLUMN_GAP, widest + 22);
			const left = widest / 2 + 28;
			const placed = new Map();
			graph.nodes.forEach(function(node) {
				placed.set(node.key, {
					node: node,
					width: nodeWidth(node.label),
					x: left + COLUMN_INDEX[node.side] * columnWidth,
					y: NODE_HEIGHT / 2 + 10 + node.rank * ROW_GAP
				});
			});
			const bow = left + 2 * columnWidth + widest / 2 + 22;
			const width = bow + 12;
			const depth = Math.max.apply(null, graph.nodes.map(function(node) { return node.rank; }));
			const height = NODE_HEIGHT + 20 + depth * ROW_GAP;
			const canvas = svg('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, role: 'img' });
			canvas.setAttribute('aria-label', 'Executed lines of both branches and the paths between them');

			const defs = svg('defs', {});
			['shared', 'reference', 'target'].forEach(function(side) { defs.appendChild(arrowMarker(side)); });
			canvas.appendChild(defs);

			graph.edges.forEach(function(edge) {
				const from = placed.get(edge.from);
				const to = placed.get(edge.to);
				if (!from || !to) { return; }
				const path = svg('path', {
					class: 'trace-edge side-' + edge.side,
					d: edgePath(from, to, bow),
					'marker-end': 'url(#arrow-' + edge.side + ')'
				});
				path.appendChild(svg('title', {})).textContent = from.node.label + ' to ' + to.node.label
					+ (edge.side === 'shared' ? ', both branches' : edge.side === 'reference' ? ', reference only' : ', fork only');
				canvas.appendChild(path);
			});

			graph.nodes.forEach(function(node) {
				const position = placed.get(node.key);
				const width = nodeWidth(node.label);
				const group = svg('g', {
					class: 'trace-node side-' + node.side + ' relation-' + node.relation,
					transform: 'translate(' + position.x + ',' + position.y + ')',
					tabindex: 0, role: 'button'
				});
				group.dataset.nodeKey = node.key;
				group.dataset.rowIndex = String(node.rowIndex);
				group.appendChild(svg('rect', { x: -width / 2, y: -NODE_HEIGHT / 2, width: width, height: NODE_HEIGHT, rx: NODE_HEIGHT / 2 }));
				const label = svg('text', { y: 0 });
				label.textContent = node.label;
				group.appendChild(label);
				if (node.visits > 1) {
					const visits = svg('text', { class: 'visits', x: -width / 2 - 5, y: 0 });
					visits.textContent = '×' + node.visits;
					group.appendChild(visits);
				}
				const description = node.side === 'shared'
					? 'Line ' + node.referenceLine + ' of the reference and line ' + node.targetLine + ' of the fork, ' + node.relation
					: node.side === 'reference'
						? 'Line ' + node.referenceLine + ', reference only'
						: 'Line ' + node.targetLine + ', fork only';
				group.appendChild(svg('title', {})).textContent = description + ' · ' + node.visits + (node.visits === 1 ? ' visit' : ' visits');
				group.onclick = function() { selectRow(node.rowIndex); };
				group.onkeydown = function(event) {
					if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRow(node.rowIndex); }
				};
				canvas.appendChild(group);
			});
			elements.graph.appendChild(canvas);
		}

		function highlightGraph(index) {
			const key = comparison.graph.rowNodeKeys[index];
			elements.graph.querySelectorAll('g').forEach(function(element) {
				element.classList.toggle('selected', element.dataset.nodeKey === key);
			});
		}

		function selectRow(index) {
			const row = comparison && comparison.rows[index];
			if (!row) { return; }
			selectedIndex = index;
			elements.rows.querySelectorAll('tr').forEach(function(element) {
				element.classList.toggle('selected', Number(element.dataset.index) === index);
			});
			highlightGraph(index);
			renderCode('reference', row.reference || nearestSide(index, 'reference'), Boolean(row.reference), row.relation);
			renderCode('target', row.target || nearestSide(index, 'target'), Boolean(row.target), row.relation);
			const focus = row.target || row.reference;
			if (elements.sync.checked && focus && focus.line !== null && focus.functionCallId !== null) {
				vscode.postMessage({ type: 'revealStep', line: focus.line, functionCallId: focus.functionCallId, codeDefinitionId: focus.codeDefinitionId });
			}
		}

		function showComparison(payload) {
			comparison = payload;
			elements.error.textContent = '';
			elements.placeholder.hidden = true;
			elements.layout.hidden = false;
			renderSummary();
			renderRows();
			renderGraph();
			if (payload.initialIndex === null) {
				elements.placeholder.hidden = false;
				elements.placeholder.textContent = 'The alignment produced no rows for this branch pair.';
			} else {
				selectRow(payload.initialIndex);
			}
		}

		elements.compare.onclick = function() {
			elements.compare.disabled = true;
			elements.error.textContent = '';
			elements.placeholder.hidden = false;
			elements.placeholder.textContent = 'Aligning branch traces…';
			vscode.postMessage({ type: 'compare', pairIndex: Number(elements.pair.value), algorithm: elements.algorithm.value });
		};
		elements.reload.onclick = function() { elements.reload.disabled = true; vscode.postMessage({ type: 'reload' }); };

		window.addEventListener('message', function(event) {
			const message = event.data;
			if (message.type === 'comparison') {
				elements.compare.disabled = false;
				showComparison(message.payload);
			}
			if (message.type === 'error') {
				elements.compare.disabled = false;
				elements.reload.disabled = false;
				elements.placeholder.hidden = true;
				elements.error.textContent = message.message;
			}
		});

		renderHeader();
		renderControls();
	</script>
</body>
</html>`;
	}
}
