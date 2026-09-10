import * as assert from 'assert';
import * as path from 'path';
import { Script } from 'vm';
import {
	ROOT_DATABASE_NAME,
	selectWorkspaceDatabase,
	WORKSPACE_DATABASE_DIRECTORY,
	WORKSPACE_DATABASE_NAME,
} from '../database';
import {
	callsForFunction,
	findPythonFunctions,
	functionForRecordedCall,
	isLaunchablePythonFunction,
	recordedCallsForFunction,
	recordedFileMatches,
} from '../pythonFunctions';
import {
	branchLabel,
	buildComparisonGraph,
	buildComparisonRows,
	ComparisonRow,
	comparisonBranchPairs,
	initialRowIndex,
	nearestSide,
	relationCounts,
} from '../traceComparison';
import { TraceComparisonPanel, TraceComparisonState } from '../traceComparisonPanel';
import { filterRecordedValues, isRuntimeValue, withoutRuntimeValues } from '../runtimeGlobals';
import { buildBranchTimeline, findFirstFrameForEditorLine } from '../traceTimeline';
import {
	AlignmentRelation,
	AlignmentResult,
	BranchDetail,
	BranchStep,
	FunctionCallSummary,
	SessionDetail,
	StackRecording,
	ValuePreview,
} from '../types';
import { TraceExplorerPanel, TraceExplorerState } from '../traceExplorerPanel';

function call(id: number, name: string, qualifiedName: string): FunctionCallSummary {
	return {
		id,
		function: name,
		function_name: name,
		qualified_name: qualifiedName,
		module_name: 'sample',
		file: '/workspace/sample.py',
		file_path: '/workspace/sample.py',
		line: 1,
		first_line_number: 1,
		start_time: null,
		started_at: null,
		end_time: null,
		completed_at: null,
		duration: null,
		outcome: 'return',
		code_definition_id: 1,
		caller_call_id: null,
		has_stack_recording: true,
		snapshot_count: 2,
		locations: [],
	};
}

suite('Python function trace binding', () => {
	test('finds synchronous, asynchronous, nested, and method definitions', () => {
		const functions = findPythonFunctions([
			'def top_level():',
			'    pass',
			'',
			'class Worker:',
			'    async def run(self):',
			'        def nested():',
			'            pass',
		].join('\n'));

		assert.deepStrictEqual(
			functions.map(item => [item.qualifiedName, item.line]),
			[['top_level', 0], ['Worker.run', 4], ['Worker.run.nested', 5]],
		);
		assert.deepStrictEqual(functions.map(item => item.bodyLine), [1, 5, 6]);
		assert.deepStrictEqual(functions.map(item => item.endLine), [1, 6, 6]);
		assert.deepStrictEqual(functions.map(isLaunchablePythonFunction), [true, false, false]);
	});

	test('tracks decorators and complete function source ranges', () => {
		const functions = findPythonFunctions([
			'@capture(',
			'    mode="line",',
			')',
			'def calculate(value):',
			'    changed = value + 1',
			'    return changed',
			'',
			'print(calculate(1))',
		].join('\n'));

		assert.deepStrictEqual(
			[functions[0].sourceLine, functions[0].line, functions[0].endLine],
			[0, 3, 5],
		);
		assert.strictEqual(functionForRecordedCall(functions, call(1, 'calculate', 'calculate')), functions[0]);
	});

	test('finds executable bodies after multiline signatures', () => {
		const functions = findPythonFunctions([
			'def calculate(',
			'    left: int,',
			'    right: int,',
			') -> int:',
			'    # Break on executable code, not the signature or comment.',
			'    return left + right',
			'',
			'def compact(): return 1',
		].join('\n'));

		assert.deepStrictEqual(functions.map(item => item.bodyLine), [5, 7]);
	});

	test('binds moved functions by qualified name instead of recorded line', () => {
		const functions = findPythonFunctions([
			'class First:',
			'    def run(self):',
			'        pass',
			'class Second:',
			'    def run(self):',
			'        pass',
		].join('\n'));
		const calls = [call(1, 'run', 'sample.First.run'), call(2, 'run', 'sample.Second.run')];

		assert.deepStrictEqual(callsForFunction(functions[0], functions, calls).map(item => item.id), [1]);
		assert.deepStrictEqual(callsForFunction(functions[1], functions, calls).map(item => item.id), [2]);
	});

	test('does not guess when duplicate names have no qualified metadata', () => {
		const functions = findPythonFunctions('class A:\n    def run(self): pass\nclass B:\n    def run(self): pass');
		const unqualified = call(1, 'run', '');

		assert.deepStrictEqual(callsForFunction(functions[0], functions, [unqualified]), []);
	});

	test('keeps function-level recordings without line snapshots', () => {
		const functions = findPythonFunctions('def calculate(value):\n    return value + 1');
		const functionRecording = {
			...call(1, 'calculate', 'calculate'),
			has_stack_recording: false,
			snapshot_count: 0,
		};

		assert.deepStrictEqual(
			recordedCallsForFunction(functions[0], functions, [functionRecording]).map(item => item.id),
			[1],
		);
	});

	test('matches absolute and workspace-relative recorded file paths', () => {
		assert.strictEqual(recordedFileMatches('/workspace/pkg/sample.py', '/workspace/pkg/sample.py'), true);
		assert.strictEqual(recordedFileMatches('pkg/sample.py', '/workspace/pkg/sample.py', '/workspace'), true);
		assert.strictEqual(recordedFileMatches('/other/sample.py', '/workspace/pkg/different.py'), false);
	});
});

suite('Trace database selection', () => {
	const workspace = path.resolve('/workspace/project');
	const vscodeDatabase = path.join(workspace, WORKSPACE_DATABASE_DIRECTORY, WORKSPACE_DATABASE_NAME);
	const rootDatabase = path.join(workspace, ROOT_DATABASE_NAME);

	test('prefers the database inside .vscode', () => {
		const existing = new Set([vscodeDatabase, rootDatabase]);
		assert.deepStrictEqual(
			selectWorkspaceDatabase(workspace, candidate => existing.has(candidate)),
			{ path: vscodeDatabase, source: 'vscode' },
		);
	});

	test('uses trace.db in the project root as the fallback', () => {
		assert.deepStrictEqual(
			selectWorkspaceDatabase(workspace, candidate => candidate === rootDatabase),
			{ path: rootDatabase, source: 'root' },
		);
	});

	test('selects .vscode/spacetimepy.db for initialization when neither exists', () => {
		assert.deepStrictEqual(
			selectWorkspaceDatabase(workspace, () => false),
			{ path: vscodeDatabase, source: 'new' },
		);
	});
});

suite('Trace explorer webview', () => {
	test('emits syntactically valid JavaScript', () => {
		const summary = call(1, 'calculate', 'calculate');
		const storedSource = {
			id: 'source-version',
			name: 'calculate',
			qualified_name: 'calculate',
			type: 'function',
			kind: 'function',
			module_path: '/workspace/sample.py',
			content: 'SECRET_STORED_SOURCE',
			code_content: 'SECRET_STORED_SOURCE',
			first_line_no: 1,
			first_line_number: 1,
		};
		const state = {
			call: {
				...summary,
				attributes: {},
				locals: {},
				globals: {},
				return_value: { reference: null, type: 'NoneType', value: null },
				exception: { reference: null, type: 'NoneType', value: null },
				stack_recording: [],
				hidden_runtime_locals: 0,
				hidden_runtime_globals: 0,
			},
			recording: {
				function: { ...summary, code: storedSource },
				code_definitions: { 'source-version': storedSource },
				frames: [],
			},
			session: null,
			branch: null,
			branchFrames: [],
			branchRecordings: {},
			selectedBranchId: null,
			selectedStepId: null,
		} satisfies TraceExplorerState;
		const html = TraceExplorerPanel.createHtml('vscode-webview:', state);
		const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];

		assert.strictEqual(scripts.length, 1);
		assert.doesNotThrow(() => new Script(scripts[0][1]));
		assert.doesNotMatch(html, /id="source"|id="path"|>Type</);
		assert.doesNotMatch(html, /SECRET_STORED_SOURCE/);
		assert.match(html, /class="execution"/);
		assert.match(html, /class="values"/);
		assert.match(html, /\['Name', 'Value'\]/);
		assert.match(html, /value-string/);
		assert.match(html, /type: 'highlightSource'/);
		assert.match(html, /codeDefinitionId: frame.codeDefinitionId/);
	});

	test('uses line frames belonging to function-call branch steps', () => {
		const summary = call(7, 'calculate', 'calculate');
		const recording = {
			function: { ...summary, code: null },
			code_definitions: {},
			frames: [{
				id: 11,
				function_call_id: 7,
				code_definition_id: 'source-version',
				line: 12,
				line_number: 12,
				timestamp: null,
				captured_at: null,
				position: 0,
				snapshot_id: 11,
				previous_snapshot_id: null,
				next_snapshot_id: null,
				locals: {},
				globals: {},
			}],
		} satisfies StackRecording;
		const branch = {
			id: 3,
			session_id: 2,
			parent_branch_id: null,
			forked_from_step_id: null,
			child_branch_ids: [],
			name: 'main',
			status: 'completed',
			configuration_key: null,
			step_count: 1,
			resolved: true,
			steps: [{
				id: 5,
				branch_id: 3,
				position: 0,
				kind: 'function_call',
				source_step_id: null,
				label: null,
				function_call: summary,
				stack_snapshot: null,
			}],
		} satisfies BranchDetail;

		assert.deepStrictEqual(buildBranchTimeline(branch, { '7': recording }), [{
			snapshotId: 11,
			functionCallId: 7,
			codeDefinitionId: 'source-version',
			line: 12,
			stepId: 5,
			ownerBranchId: 3,
			sourceStepId: null,
		}]);
	});

	test('selects the first matching frame for an editor line and source call', () => {
		const frames = [
			{ snapshotId: 1, functionCallId: 7, codeDefinitionId: null, line: 12, stepId: 1, ownerBranchId: 1, sourceStepId: null },
			{ snapshotId: 2, functionCallId: 8, codeDefinitionId: null, line: 12, stepId: 2, ownerBranchId: 1, sourceStepId: null },
			{ snapshotId: 3, functionCallId: 7, codeDefinitionId: null, line: 12, stepId: 3, ownerBranchId: 1, sourceStepId: null },
		];

		assert.strictEqual(findFirstFrameForEditorLine(frames, 12, [7]), 0);
		assert.strictEqual(findFirstFrameForEditorLine(frames, 12, [8]), 1);
		assert.strictEqual(findFirstFrameForEditorLine(frames, 13, [7, 8]), -1);
	});
});

function snapshotStep(
	id: number,
	branchId: number,
	position: number,
	line: number,
	codeDefinitionId: string,
): BranchStep {
	return {
		id,
		branch_id: branchId,
		position,
		kind: 'stack_snapshot',
		source_step_id: null,
		label: null,
		function_call: null,
		stack_snapshot: {
			id: id * 10,
			function_call_id: 5,
			code_definition_id: codeDefinitionId,
			line,
			line_number: line,
			timestamp: null,
			captured_at: null,
		},
	};
}

function branch(
	id: number,
	parentBranchId: number | null,
	forkedFromStepId: number | null,
	steps: BranchStep[],
): BranchDetail {
	return {
		id,
		session_id: 1,
		parent_branch_id: parentBranchId,
		forked_from_step_id: forkedFromStepId,
		child_branch_ids: [],
		name: null,
		status: 'completed',
		configuration_key: null,
		step_count: steps.length,
		resolved: true,
		steps,
	};
}

suite('Trace comparison rows', () => {
	const reference = branch(1, null, null, [
		snapshotStep(11, 1, 0, 4, 'v1'),
		snapshotStep(12, 1, 1, 5, 'v1'),
		snapshotStep(13, 1, 2, 6, 'v1'),
	]);
	const target = branch(2, 1, 11, [
		snapshotStep(21, 2, 0, 4, 'v2'),
		snapshotStep(22, 2, 1, 7, 'v2'),
	]);
	const alignment: AlignmentResult = {
		algorithm: 'stack-snapshot',
		algorithm_version: '1',
		reference_branch_id: 1,
		target_branch_id: 2,
		links: [
			{ reference_step_id: 11, target_step_id: 21, relation: 'match' },
			{ reference_step_id: 12, target_step_id: 22, relation: 'updated' },
			{ reference_step_id: 13, target_step_id: null, relation: 'deleted' },
		],
	};

	test('joins alignment links with the recorded line of each side', () => {
		const rows = buildComparisonRows(alignment, reference, target);

		assert.deepStrictEqual(
			rows.map(row => [
				row.relation,
				row.reference?.line ?? null,
				row.target?.line ?? null,
			]),
			[['match', 4, 4], ['updated', 5, 7], ['deleted', 6, null]],
		);
		assert.deepStrictEqual(
			rows.map(row => [row.reference?.codeDefinitionId, row.target?.codeDefinitionId]),
			[['v1', 'v2'], ['v1', 'v2'], ['v1', undefined]],
		);
		assert.deepStrictEqual(rows.map(row => row.reference?.label), ['Line 4', 'Line 5', 'Line 6']);
	});

	test('counts relations and opens on the first linked row', () => {
		const rows = buildComparisonRows(alignment, reference, target);

		assert.deepStrictEqual(
			relationCounts(rows),
			{ match: 1, updated: 1, inserted: 0, deleted: 1 },
		);
		assert.strictEqual(initialRowIndex(rows), 0);
		assert.strictEqual(initialRowIndex([]), null);
	});

	test('opens on a one-sided row only when no row links both traces', () => {
		const inserted = buildComparisonRows(
			{ ...alignment, links: [{ reference_step_id: null, target_step_id: 21, relation: 'inserted' }] },
			reference,
			target,
		);

		assert.strictEqual(initialRowIndex(inserted), 0);
	});

	test('falls back to the closest recorded step for an unlinked side', () => {
		const rows = buildComparisonRows(alignment, reference, target);

		assert.strictEqual(nearestSide(rows, 2, 'target')?.line, 7);
		assert.strictEqual(nearestSide(rows, 2, 'reference')?.line, 6);
		assert.strictEqual(nearestSide([], 0, 'reference'), null);
	});

	test('offers only direct forks that carry a fork step', () => {
		const session = {
			id: 1,
			name: 'session',
			description: null,
			status: 'completed',
			step_kind: 'stack_snapshot',
			root_branch_id: 1,
			branches: [
				{ ...reference, resolved: undefined, steps: undefined },
				{ ...target, resolved: undefined, steps: undefined },
				{ ...branch(3, 1, null, []), resolved: undefined, steps: undefined },
				{ ...branch(4, 9, 11, []), resolved: undefined, steps: undefined },
			],
		} as unknown as SessionDetail;

		assert.deepStrictEqual(
			comparisonBranchPairs(session).map(pair => [pair.reference.id, pair.target.id]),
			[[1, 2]],
		);
		assert.strictEqual(branchLabel(session.branches[0]), 'Branch 1 · #1');
	});
});

suite('Trace comparison webview', () => {
	test('emits syntactically valid JavaScript', () => {
		const state = {
			sessionId: 1,
			sessionLabel: 'session',
			stepKind: 'stack_snapshot',
			pairs: [{ referenceId: 1, targetId: 2, label: 'Branch 1 · #1 → Branch 2 · #2' }],
			algorithms: [{ name: 'stack-snapshot', version: '1', offline: true, online: false }],
			selectedPairIndex: 0,
		} satisfies TraceComparisonState;
		const html = TraceComparisonPanel.createHtml('vscode-webview:', state);
		const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];

		assert.strictEqual(scripts.length, 1);
		assert.doesNotThrow(() => new Script(scripts[0][1]));
		assert.match(html, /type: 'compare'/);
		assert.match(html, /type: 'revealStep'/);
		assert.match(html, /id="reference-code"/);
		assert.match(html, /id="target-code"/);
		assert.match(html, /id="graph"/);
		assert.match(html, /trace-node side-/);
		assert.match(html, /'trace-edge side-' \+ edge\.side/);
		assert.match(html, /function renderGraph\(\)/);
	});

	test('reports a session that has no comparable fork', () => {
		const html = TraceComparisonPanel.createHtml('vscode-webview:', {
			sessionId: 1,
			sessionLabel: 'session',
			stepKind: 'stack_snapshot',
			pairs: [],
			algorithms: [],
			selectedPairIndex: null,
		});

		assert.match(html, /no forked branch to compare/);
	});
});

function preview(type: string, value: unknown) {
	return { reference: null, type, value };
}

suite('Recorded runtime values', () => {
	test('hides the constants the hotswap runtime records as globals', () => {
		const globals = {
			_CONTINUE: preview('object', '<object object at 0x7fb1c8583460>'),
			_CHECKPOINT_NAME: preview('str', '_spacetimepy_hotswap_prepare_checkpoint'),
			_ENTRY_NAME: preview('str', '_spacetimepy_hotswap_entry'),
			_CONTINUE_NAME: preview('str', '_spacetimepy_hotswap_continue'),
			_FINISH_NAME: preview('str', '_spacetimepy_hotswap_finish'),
			_PREPARE_NAME: preview('str', '_spacetimepy_hotswap_prepare'),
			_TEMPORARY_NAME: preview('str', '_spacetimepy_hotswap_result'),
			threshold: preview('int', 4),
		};
		const filtered = withoutRuntimeValues(globals);

		assert.deepStrictEqual(Object.keys(filtered.values), ['threshold']);
		assert.strictEqual(filtered.hidden, 7);
	});

	test('hides the helpers injected into the recorded module', () => {
		assert.strictEqual(isRuntimeValue('_spacetimepy_hotswap_entry', preview('function', 'entry')), true);
		assert.strictEqual(isRuntimeValue('_spacetimepy_hotswap_result', preview('int', 3)), true);
		assert.strictEqual(isRuntimeValue('__spacetimepy_hotswappable__', preview('bool', true)), true);
	});

	test('keeps user values that only share a runtime name', () => {
		assert.strictEqual(isRuntimeValue('_ENTRY_NAME', preview('str', 'my_entry')), false);
		assert.strictEqual(isRuntimeValue('_CONTINUE', preview('bool', true)), false);
		assert.strictEqual(isRuntimeValue('_CONTINUE', preview('object', '<Session object at 0x7fb1c8583460>')), false);
		assert.strictEqual(isRuntimeValue('spacetimepy_total', preview('int', 1)), false);
	});

	test('counts hidden locals and globals separately on a frame', () => {
		const recorded = {
			line: 6,
			locals: { arr: preview('list', '[1, 2]'), _spacetimepy_hotswap_result: preview('int', 2) },
			globals: { _ENTRY_NAME: preview('str', '_spacetimepy_hotswap_entry') },
		};
		const frame = filterRecordedValues(recorded);

		assert.deepStrictEqual(Object.keys(frame.locals), ['arr']);
		assert.deepStrictEqual(Object.keys(frame.globals), []);
		assert.strictEqual(frame.hidden_runtime_locals, 1);
		assert.strictEqual(frame.hidden_runtime_globals, 1);
		assert.strictEqual(frame.line, 6);
	});

	test('leaves a frame without recorded values untouched', () => {
		const recorded: {
			line: number;
			locals?: Record<string, ValuePreview>;
			globals?: Record<string, ValuePreview>;
		} = { line: 6 };
		const frame = filterRecordedValues(recorded);

		assert.strictEqual('locals' in frame, false);
		assert.strictEqual('globals' in frame, false);
		assert.strictEqual(frame.hidden_runtime_globals, 0);
	});
});

function graphSide(line: number, position: number) {
	return {
		stepId: 500 + position,
		position,
		line,
		label: `Line ${line}`,
		functionCallId: 1,
		codeDefinitionId: 'v1',
	};
}

function graphRows(
	entries: [AlignmentRelation, number | null, number | null][],
): ComparisonRow[] {
	return entries.map(([relation, reference, target], index) => ({
		index,
		relation,
		reference: reference === null ? null : graphSide(reference, index),
		target: target === null ? null : graphSide(target, index),
	}));
}

suite('Trace comparison graph', () => {
	// A shared prefix, an if/else each branch resolves differently, then a rejoin.
	const diamond = graphRows([
		['match', 6, 6],
		['updated', 7, 7],
		['match', 8, 8],
		['deleted', 10, null],
		['deleted', 11, null],
		['inserted', null, 9],
		['inserted', null, 10],
		['match', 12, 13],
	]);

	test('gives a shared line one node and an exclusive line its own', () => {
		const graph = buildComparisonGraph(diamond);

		assert.deepStrictEqual(
			graph.nodes.map(node => [node.label, node.side]),
			[
				['6', 'shared'], ['7', 'shared'], ['8', 'shared'],
				['10', 'reference'], ['11', 'reference'],
				['9', 'target'], ['10', 'target'],
				['12 → 13', 'shared'],
			],
		);
		assert.strictEqual(graph.nodes[1].relation, 'updated');
	});

	test('lays the two exclusive paths side by side and rejoins below them', () => {
		const graph = buildComparisonGraph(diamond);
		const rank = (label: string, side: string) =>
			graph.nodes.find(node => node.label === label && node.side === side)?.rank;

		assert.strictEqual(rank('10', 'reference'), rank('9', 'target'));
		assert.strictEqual(rank('11', 'reference'), rank('10', 'target'));
		assert.strictEqual(rank('12 → 13', 'shared'), 5);
	});

	test('colours each edge by the branches that took it', () => {
		const graph = buildComparisonGraph(diamond);
		const label = (key: string) => {
			const node = graph.nodes.find(item => item.key === key);
			return `${node?.label}/${node?.side[0]}`;
		};

		assert.deepStrictEqual(
			graph.edges.map(edge => [label(edge.from), label(edge.to), edge.side]),
			[
				['6/s', '7/s', 'shared'],
				['7/s', '8/s', 'shared'],
				['8/s', '10/r', 'reference'],
				['10/r', '11/r', 'reference'],
				['11/r', '12 → 13/s', 'reference'],
				['8/s', '9/t', 'target'],
				['9/t', '10/t', 'target'],
				['10/t', '12 → 13/s', 'target'],
			],
		);
	});

	test('collapses a repeated line into one node that counts its visits', () => {
		const graph = buildComparisonGraph(graphRows([
			['match', 8, 8],
			['match', 9, 9],
			['match', 8, 8],
			['match', 9, 9],
			['match', 10, 10],
		]));

		assert.deepStrictEqual(graph.nodes.map(node => [node.label, node.visits]), [
			['8', 2], ['9', 2], ['10', 1],
		]);
		assert.deepStrictEqual(
			graph.edges.map(edge => edge.from.split(':')[1] + '>' + edge.to.split(':')[1]),
			['8>9', '9>8', '9>10'],
		);
		assert.deepStrictEqual(graph.nodes.map(node => node.rank), [0, 1, 2]);
	});

	test('maps every row to a node so both views share one selection', () => {
		const graph = buildComparisonGraph(diamond);

		assert.strictEqual(graph.rowNodeKeys.length, diamond.length);
		assert.strictEqual(graph.rowNodeKeys[3], graph.nodes[3].key);
		assert.strictEqual(graph.rowNodeKeys[6], graph.nodes[6].key);
	});

	test('graphs nothing when the alignment produced no rows', () => {
		assert.deepStrictEqual(buildComparisonGraph([]), { nodes: [], edges: [], rowNodeKeys: [] });
	});
});
