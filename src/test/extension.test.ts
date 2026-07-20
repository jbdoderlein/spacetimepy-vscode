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
	recordedCallsForFunction,
	recordedFileMatches,
} from '../pythonFunctions';
import { buildBranchTimeline, findFirstFrameForEditorLine } from '../traceTimeline';
import { BranchDetail, FunctionCallSummary, StackRecording } from '../types';
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
