import * as path from 'path';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import { getConfig } from './config';
import { RecordedExecutionCodeLensProvider } from './recordedExecutionCodeLens';
import { ServerManager, ServerStatus } from './serverManager';
import { TraceExplorerPanel } from './traceExplorerPanel';
import { FunctionCallSummary } from './types';

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
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'spacetimepy.restartServer';
	updateStatusBar(statusBar, server.getStatus());

	context.subscriptions.push(
		output,
		server,
		codeLensProvider,
		statusBar,
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
