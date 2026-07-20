import * as path from 'path';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import {
	PythonFunction,
	findPythonFunctions,
	isLaunchablePythonFunction,
	recordedFileMatches,
} from './pythonFunctions';
import { ServerManager } from './serverManager';
import { TraceExplorerPanel } from './traceExplorerPanel';
import { FunctionCallSummary } from './types';

interface PendingLaunch {
	uri: vscode.Uri;
	functionInfo: PythonFunction;
	knownCallIds: Set<number>;
	breakpoint: vscode.SourceBreakpoint | null;
	callId?: number;
}

interface SpaceTimePyDebugConfiguration extends vscode.DebugConfiguration {
	spacetimepyLaunchId: string;
	spacetimepySnapshotReplay?: boolean;
}

export interface SnapshotReplayRequest {
	branchId: number;
	stepId: number;
	functionCallId: number;
}

export class FunctionCaptureService implements vscode.Disposable {
	private readonly pending = new Map<string, PendingLaunch>();
	private readonly synchronizations = new Map<string, Promise<boolean>>();
	private readonly terminationSubscription: vscode.Disposable;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly api: SpaceTimePyApiClient,
		private readonly server: ServerManager,
		private readonly output: vscode.OutputChannel,
	) {
		this.terminationSubscription = vscode.debug.onDidTerminateDebugSession(session => {
			const launchId = (session.configuration as Partial<SpaceTimePyDebugConfiguration>).spacetimepyLaunchId;
			if (launchId && this.pending.has(launchId)) {
				void this.finishLaunch(launchId);
			}
		});
	}

	public async debugFunction(uri: vscode.Uri, functionInfo: PythonFunction): Promise<void> {
		if (!isLaunchablePythonFunction(functionInfo)) {
			throw new Error('SpaceTimePy function launch currently supports top-level functions only.');
		}

		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty && !await document.save()) {
			return;
		}

		const argumentsSource = await vscode.window.showInputBox({
			title: `Debug ${functionInfo.name} with SpaceTimePy`,
			prompt: `Enter Python arguments exactly as they appear inside ${functionInfo.name}(...)`,
			placeHolder: 'Example: [1, 4, 9], target=4 — leave empty to call without arguments',
			ignoreFocusOut: true,
		});
		if (argumentsSource === undefined) {
			return;
		}

		const runtime = await this.server.prepareCapture(uri);
		const knownCalls = await this.callsForFunction(uri, functionInfo.name);
		const launchId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const breakpoint = this.addEntryBreakpoint(uri, functionInfo.bodyLine);
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		const launcher = path.join(
			this.context.extensionPath,
			'python',
			'spacetimepy_vscode_runtime',
			'launch.py',
		);
		const configuration: SpaceTimePyDebugConfiguration = {
			name: `SpaceTimePy: ${functionInfo.name}`,
			type: 'debugpy',
			request: 'launch',
			program: launcher,
			python: runtime.pythonPath,
			cwd: workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath),
			console: 'integratedTerminal',
			justMyCode: true,
			args: [
				'--database', runtime.databasePath,
				'--target-file', uri.fsPath,
				'--function', functionInfo.name,
				'--arguments', argumentsSource,
				'--launch-id', launchId,
			],
			spacetimepyLaunchId: launchId,
		};

		this.pending.set(launchId, {
			uri,
			functionInfo,
			knownCallIds: new Set(knownCalls.map(call => call.id)),
			breakpoint,
		});
		this.output.appendLine(
			`Launching ${functionInfo.name} with SpaceTimePy into ${runtime.databasePath}`,
		);
		const started = await vscode.debug.startDebugging(workspaceFolder, configuration);
		if (!started) {
			this.cleanLaunch(launchId);
			throw new Error(`The Python debugger did not start for ${functionInfo.name}.`);
		}
	}

	public async replaySnapshot(request: SnapshotReplayRequest): Promise<void> {
		const call = await this.api.getFunctionCall(request.functionCallId);
		const sourcePath = call.file_path ?? call.file;
		if (!sourcePath) {
			throw new Error('The selected snapshot has no source file.');
		}
		const uri = vscode.Uri.file(sourcePath);
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty && !await document.save()) {
			return;
		}
		const functionInfo = findPythonFunctions(document.getText()).find(
			candidate => candidate.name === call.function_name && isLaunchablePythonFunction(candidate),
		);
		if (!functionInfo) {
			throw new Error(
				`Snapshot replay currently requires top-level function ${call.function_name} in the current file.`,
			);
		}

		const runtime = await this.server.prepareCapture(uri);
		const knownCalls = await this.callsForFunction(uri, functionInfo.name);
		const launchId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const breakpoint = this.addEntryBreakpoint(uri, functionInfo.bodyLine);
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		const replayLauncher = path.join(
			this.context.extensionPath,
			'python',
			'spacetimepy_vscode_runtime',
			'replay.py',
		);
		const configuration: SpaceTimePyDebugConfiguration = {
			name: `SpaceTimePy replay: ${functionInfo.name}`,
			type: 'debugpy',
			request: 'launch',
			program: replayLauncher,
			python: runtime.pythonPath,
			cwd: workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath),
			console: 'integratedTerminal',
			justMyCode: true,
			args: [
				'--database', runtime.databasePath,
				'--target-file', uri.fsPath,
				'--function', functionInfo.name,
				'--parent-branch', String(request.branchId),
				'--forked-from-step', String(request.stepId),
				'--launch-id', launchId,
			],
			spacetimepyLaunchId: launchId,
			spacetimepySnapshotReplay: true,
		};

		this.pending.set(launchId, {
			uri,
			functionInfo,
			knownCallIds: new Set(knownCalls.map(item => item.id)),
			breakpoint,
		});
		this.output.appendLine(
			`Restarting ${functionInfo.name} from branch ${request.branchId}, step ${request.stepId}`,
		);
		const started = await vscode.debug.startDebugging(workspaceFolder, configuration);
		if (!started) {
			this.cleanLaunch(launchId);
			throw new Error(`The Python debugger did not start for ${functionInfo.name}.`);
		}
	}

	public dispose(): void {
		this.terminationSubscription.dispose();
		for (const launchId of this.pending.keys()) {
			this.cleanLaunch(launchId);
		}
	}

	public async synchronizeDebugSession(session: vscode.DebugSession): Promise<void> {
		const launchId = (session.configuration as Partial<SpaceTimePyDebugConfiguration>).spacetimepyLaunchId;
		if (!launchId || !this.pending.has(launchId)) {
			return;
		}
		try {
			await this.queueSynchronization(launchId, 4);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Unable to refresh live execution: ${detail}`);
		}
	}

	private addEntryBreakpoint(uri: vscode.Uri, bodyLine: number): vscode.SourceBreakpoint | null {
		const exists = vscode.debug.breakpoints.some(candidate =>
			candidate instanceof vscode.SourceBreakpoint
			&& candidate.location.uri.toString() === uri.toString()
			&& candidate.location.range.start.line === bodyLine,
		);
		if (exists) {
			return null;
		}
		const breakpoint = new vscode.SourceBreakpoint(
			new vscode.Location(uri, new vscode.Position(bodyLine, 0)),
		);
		vscode.debug.addBreakpoints([breakpoint]);
		return breakpoint;
	}

	private cleanLaunch(launchId: string): PendingLaunch | undefined {
		const launch = this.pending.get(launchId);
		if (!launch) {
			return undefined;
		}
		this.pending.delete(launchId);
		if (launch.breakpoint) {
			vscode.debug.removeBreakpoints([launch.breakpoint]);
		}
		return launch;
	}

	private async finishLaunch(launchId: string): Promise<void> {
		const launch = this.pending.get(launchId);
		if (!launch) {
			return;
		}

		try {
			let synchronized = await this.queueSynchronization(launchId, 12, true);
			if (!synchronized && launch.callId !== undefined) {
				// A forcibly terminated process can leave a useful open recording.
				// Refresh that trace instead of claiming nothing was captured.
				synchronized = await this.queueSynchronization(launchId, 1);
			}
			if (!synchronized) {
				void vscode.window.showWarningMessage(
					`The ${launch.functionInfo.name} debug session ended before a SpaceTimePy recording was created.`,
				);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Unable to open captured execution: ${detail}`);
			void vscode.window.showErrorMessage(`Unable to open the SpaceTimePy recording: ${detail}`);
		} finally {
			this.cleanLaunch(launchId);
		}
	}

	private queueSynchronization(
		launchId: string,
		attempts: number,
		requireCompleted = false,
	): Promise<boolean> {
		const previous = this.synchronizations.get(launchId) ?? Promise.resolve(false);
		const queued = previous
			.catch(() => false)
			.then(() => this.synchronizeLaunch(launchId, attempts, requireCompleted));
		this.synchronizations.set(launchId, queued);
		const clean = () => {
			if (this.synchronizations.get(launchId) === queued) {
				this.synchronizations.delete(launchId);
			}
		};
		queued.then(clean, clean);
		return queued;
	}

	private async synchronizeLaunch(
		launchId: string,
		attempts: number,
		requireCompleted = false,
	): Promise<boolean> {
		const launch = this.pending.get(launchId);
		if (!launch) {
			return false;
		}
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			await this.api.refresh();
			const calls = await this.callsForFunction(launch.uri, launch.functionInfo.name);
			const recorded = calls.find(call =>
				(launch.callId === undefined
					? !launch.knownCallIds.has(call.id)
					: call.id === launch.callId)
				&& (!requireCompleted || call.outcome !== 'running'),
			);
			if (recorded) {
				launch.callId = recorded.id;
				await TraceExplorerPanel.show(this.api, recorded.id, this.output);
				return true;
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		return false;
	}

	private async callsForFunction(uri: vscode.Uri, functionName: string): Promise<FunctionCallSummary[]> {
		const workspacePath = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
		const response = await this.api.getFunctionCalls({
			file: path.basename(uri.fsPath),
			functionName,
		});
		return response.function_calls
			.filter(call => recordedFileMatches(call.file_path ?? call.file, uri.fsPath, workspacePath))
			.sort((left, right) => (right.started_at ?? '').localeCompare(left.started_at ?? ''));
	}
}
