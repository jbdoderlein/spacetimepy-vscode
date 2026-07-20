import * as path from 'path';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import { findPythonFunctions, recordedCallsForFunction, recordedFileMatches } from './pythonFunctions';
import { FunctionCallSummary } from './types';

interface CacheEntry {
	documentVersion: number;
	dataGeneration: number;
	calls: FunctionCallSummary[];
}

export class RecordedExecutionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this.changeEmitter.event;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly timer: NodeJS.Timeout;
	private dataGeneration = 0;
	private refreshPromise: Promise<void> | null = null;

	constructor(
		private readonly api: SpaceTimePyApiClient,
		private readonly output: vscode.OutputChannel,
		refreshInterval: number,
	) {
		this.timer = setInterval(() => this.refresh(), refreshInterval);
	}

	public refresh(): void {
		this.dataGeneration += 1;
		this.cache.clear();
		this.changeEmitter.fire();
	}

	public async provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.CodeLens[]> {
		if (document.languageId !== 'python' || document.uri.scheme !== 'file') {
			return [];
		}

		const functions = findPythonFunctions(document.getText());
		if (functions.length === 0) {
			return [];
		}

		try {
			await this.refreshTraceReader();
			if (token.isCancellationRequested) {
				return [];
			}

			const calls = await this.callsForDocument(document);
			if (token.isCancellationRequested) {
				return [];
			}
			return functions.flatMap(functionInfo => {
				const recordedCalls = recordedCallsForFunction(functionInfo, functions, calls);
				if (recordedCalls.length === 0) {
					return [];
				}
				const range = new vscode.Range(
					functionInfo.line,
					functionInfo.character,
					functionInfo.line,
					functionInfo.character,
				);
				return [new vscode.CodeLens(range, {
					command: 'spacetimepy.openRecordedExecution',
					title: `$(history) ${recordedCalls.length} recorded execution${recordedCalls.length === 1 ? '' : 's'}`,
					arguments: [recordedCalls],
				})];
			});
		} catch (error) {
			this.output.appendLine(
				`CodeLens refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	public dispose(): void {
		clearInterval(this.timer);
		this.changeEmitter.dispose();
	}

	private async refreshTraceReader(): Promise<void> {
		if (!this.refreshPromise) {
			this.refreshPromise = this.api.refresh().finally(() => {
				this.refreshPromise = null;
			});
		}
		await this.refreshPromise;
	}

	private async callsForDocument(document: vscode.TextDocument): Promise<FunctionCallSummary[]> {
		const key = document.uri.toString();
		const cached = this.cache.get(key);
		if (cached?.documentVersion === document.version && cached.dataGeneration === this.dataGeneration) {
			return cached.calls;
		}

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
		const response = await this.api.getFunctionCalls({ file: path.basename(document.uri.fsPath) });
		const calls = response.function_calls.filter(call =>
			recordedFileMatches(call.file_path ?? call.file, document.uri.fsPath, workspaceFolder),
		);
		this.cache.set(key, {
			documentVersion: document.version,
			dataGeneration: this.dataGeneration,
			calls,
		});
		return calls;
	}
}
