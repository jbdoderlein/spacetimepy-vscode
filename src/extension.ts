import * as path from 'path';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import { getConfig } from './config';
import { DebuggerHotswapService } from './debuggerHotswap';
import { FunctionCaptureService, SnapshotReplayRequest } from './functionCapture';
import { FunctionLaunchCodeLensProvider } from './functionLaunchCodeLens';
import { PythonFunction } from './pythonFunctions';
import { RecordedExecutionCodeLensProvider } from './recordedExecutionCodeLens';
import { ServerManager, ServerStatus } from './serverManager';
import { TraceComparisonPanel } from './traceComparisonPanel';
import { TraceExplorerPanel } from './traceExplorerPanel';
import { FunctionCallSummary, SessionSummary } from './types';

function updateStatusBar(statusBar: vscode.StatusBarItem, status: ServerStatus): void {
	switch (status.state) {
		case 'ready':
			statusBar.text = '$(database) SpaceTimePy';
			break;
		case 'starting':
			statusBar.text = '$(sync~spin) SpaceTimePy';
			break;
		case 'error':
			statusBar.text = '$(error) SpaceTimePy';
			break;
		default:
			statusBar.text = '$(circle-slash) SpaceTimePy';
	}
	statusBar.tooltip = status.message;
	statusBar.show();
}

function callLabel(call: FunctionCallSummary): string {
	return call.qualified_name ?? call.function_name ?? call.function;
}

async function selectRecordedCall(calls: FunctionCallSummary[]): Promise<FunctionCallSummary | undefined> {
	if (calls.length === 1) {
		return calls[0];
	}
	const choices = calls.map(call => ({
		label: callLabel(call),
		description: call.started_at ? new Date(call.started_at).toLocaleString() : `Call ${call.id}`,
		detail: `${path.basename(call.file_path ?? call.file ?? 'unknown')} · ${call.snapshot_count} snapshots · ${call.duration === null ? 'unknown duration' : `${call.duration.toFixed(4)} s`}`,
		call,
	}));
	const selected = await vscode.window.showQuickPick(choices, {
		placeHolder: 'Select a recorded SpaceTimePy execution',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return selected?.call;
}

function sessionLabel(session: SessionSummary): string {
	return session.name ?? `Session ${session.id}`;
}

/**
 * Ask for the session to compare when the command carries no context.
 *
 * Alignment always runs inside one session, so a session must be chosen before
 * its branch pairs can be offered.
 */
async function selectSession(
	api: SpaceTimePyApiClient,
): Promise<SessionSummary | undefined> {
	const sessions = (await api.getSessions()).filter(session => session.branch_count > 1);
	if (sessions.length === 0) {
		void vscode.window.showInformationMessage(
			'No recorded session has a forked branch to compare. Use the hotswap action or “Explore from checkpoint” to create one.',
		);
		return undefined;
	}
	if (sessions.length === 1) {
		return sessions[0];
	}
	const selected = await vscode.window.showQuickPick(
		sessions
			.slice()
			.reverse()
			.map(session => ({
				label: sessionLabel(session),
				description: `${session.branch_count} branches · ${session.step_kind}`,
				detail: session.description ?? undefined,
				session,
			})),
		{ placeHolder: 'Select a SpaceTimePy session to compare', matchOnDescription: true },
	);
	return selected?.session;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('SpaceTimePy', { log: true });
	const api = new SpaceTimePyApiClient(
		() => getConfig().apiUrl,
		() => getConfig().requestTimeout,
	);
	const server = new ServerManager(api, output);
	const codeLensProvider = new RecordedExecutionCodeLensProvider(
		api,
		output,
		getConfig().codeLensRefreshInterval,
	);
	const functionCapture = new FunctionCaptureService(context, api, server, output);
	const functionLaunchCodeLensProvider = new FunctionLaunchCodeLensProvider();
	const debuggerHotswap = new DebuggerHotswapService(output);
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'spacetimepy.restartServer';
	updateStatusBar(statusBar, server.getStatus());

	context.subscriptions.push(
		output,
		server,
		codeLensProvider,
		functionCapture,
		debuggerHotswap,
		statusBar,
		debuggerHotswap.onDidSynchronizeTrace(session => {
			void functionCapture.synchronizeDebugSession(session);
		}),
		server.onDidChangeStatus(status => {
			updateStatusBar(statusBar, status);
			if (status.state === 'ready') {
				codeLensProvider.refresh();
			}
		}),
		vscode.languages.registerCodeLensProvider(
			{ scheme: 'file', language: 'python' },
			codeLensProvider,
		),
		vscode.languages.registerCodeLensProvider(
			{ scheme: 'file', language: 'python' },
			functionLaunchCodeLensProvider,
		),
		vscode.commands.registerCommand(
			'spacetimepy.debugFunction',
			async (uri?: vscode.Uri, functionInfo?: PythonFunction) => {
				if (!uri || !functionInfo) {
					void vscode.window.showInformationMessage(
						'Use the “Debug with SpaceTimePy” CodeLens above a top-level Python function.',
					);
					return;
				}
				try {
					await functionCapture.debugFunction(uri, functionInfo);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					output.appendLine(`Function launch failed: ${detail}`);
					void vscode.window.showErrorMessage(`Unable to debug with SpaceTimePy: ${detail}`);
				}
			},
		),
		vscode.commands.registerCommand('spacetimepy.hotswapCurrentFrame', async () => {
			try {
				await debuggerHotswap.hotswapCurrentFrame();
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				output.appendLine(`Live hotswap failed: ${detail}`);
				void vscode.window.showErrorMessage(`SpaceTimePy hotswap failed: ${detail}`);
			}
		}),
		vscode.commands.registerCommand(
			'spacetimepy.replaySnapshot',
			async (request?: SnapshotReplayRequest) => {
				if (!request) {
					return;
				}
				try {
					const activeSession = vscode.debug.activeDebugSession;
					if (activeSession) {
						if (!debuggerHotswap.isSpaceTimeSession(activeSession)) {
							throw new Error(
								'Close the active non-SpaceTimePy debug session before starting checkpoint exploration.',
							);
						}
						await debuggerHotswap.replayCheckpointInCurrentSession(request);
					} else {
						await functionCapture.replaySnapshot(request);
					}
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					output.appendLine(`Snapshot replay failed: ${detail}`);
					void vscode.window.showErrorMessage(`Unable to replay this snapshot: ${detail}`);
				}
			},
		),
		vscode.commands.registerCommand('spacetimepy.restartServer', async () => {
			try {
				await server.restart();
				codeLensProvider.refresh();
				if (server.getStatus().state === 'ready') {
					void vscode.window.showInformationMessage(server.getStatus().message);
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				output.appendLine(detail);
				void vscode.window.showErrorMessage(detail);
			}
		}),
		vscode.commands.registerCommand('spacetimepy.refreshTraces', async () => {
			try {
				await api.refresh();
				codeLensProvider.refresh();
				void vscode.window.showInformationMessage('SpaceTimePy recordings refreshed.');
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				output.appendLine(detail);
				void vscode.window.showErrorMessage(detail);
			}
		}),
		vscode.commands.registerCommand(
			'spacetimepy.compareTraces',
			async (request?: { sessionId?: number; branchId?: number }) => {
				try {
					const sessionId = request?.sessionId ?? (await selectSession(api))?.id;
					if (sessionId === undefined) {
						return;
					}
					await TraceComparisonPanel.show(api, sessionId, output, request?.branchId);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					output.appendLine(`Trace comparison failed: ${detail}`);
					void vscode.window.showErrorMessage(`Unable to compare SpaceTimePy traces: ${detail}`);
				}
			},
		),
		vscode.commands.registerCommand(
			'spacetimepy.openRecordedExecution',
			async (calls: FunctionCallSummary[]) => {
				const selected = await selectRecordedCall(calls);
				if (!selected) {
					return;
				}
				try {
					await TraceExplorerPanel.show(api, selected.id, output);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					output.appendLine(detail);
					void vscode.window.showErrorMessage(`Unable to open SpaceTimePy trace: ${detail}`);
				}
			},
		),
		vscode.workspace.onDidSaveTextDocument(document => {
			if (document.languageId === 'python') {
				codeLensProvider.refresh();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('spacetimepy')) {
				codeLensProvider.refresh();
				void server.restart().catch(error => {
					output.appendLine(`Configuration reload failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		}),
	);

	output.appendLine('SpaceTimePy extension activated.');
	void server.startIfConfigured().catch(error => {
		const detail = error instanceof Error ? error.message : String(error);
		output.appendLine(`Automatic server start failed: ${detail}`);
		void vscode.window.showErrorMessage(`SpaceTimePy server could not start: ${detail}`);
	});
}

export function deactivate(): void {}
