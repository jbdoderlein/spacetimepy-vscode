import * as vscode from 'vscode';

interface DebugProtocolMessage {
	type?: string;
	event?: string;
	body?: { threadId?: number };
}

interface StackFrameResponse {
	stackFrames?: Array<{
		id: number;
		name: string;
		line: number;
		source?: { path?: string };
	}>;
}

export interface ActiveCheckpointRequest {
	branchId: number;
	stepId: number;
}

export class DebuggerHotswapService implements vscode.Disposable {
	private readonly stoppedWaiters = new Map<string, Set<() => void>>();
	private readonly restoredSnapshotSessions = new Set<string>();
	private readonly hotswapInProgress = new Set<string>();
	private readonly synchronizedTraceEmitter = new vscode.EventEmitter<vscode.DebugSession>();
	private readonly trackerRegistration: vscode.Disposable;
	private readonly terminationSubscription: vscode.Disposable;
	public readonly onDidSynchronizeTrace = this.synchronizedTraceEmitter.event;

	constructor(private readonly output: vscode.OutputChannel) {
		this.trackerRegistration = vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {
			createDebugAdapterTracker: session => ({
				onDidSendMessage: message => {
					const protocolMessage = message as DebugProtocolMessage;
					if (protocolMessage.type === 'event' && protocolMessage.event === 'stopped') {
						this.resolveStopped(session.id);
						if (
							session.configuration.spacetimepySnapshotReplay === true
							&& !this.restoredSnapshotSessions.has(session.id)
						) {
							this.restoredSnapshotSessions.add(session.id);
							void this.restoreSnapshotSession(session, protocolMessage.body?.threadId)
								.then(() => this.synchronizeTrace(session, protocolMessage.body?.threadId));
						} else if (!this.hotswapInProgress.has(session.id)) {
							void this.synchronizeTrace(session, protocolMessage.body?.threadId);
						}
					}
				},
			}),
		});
		this.terminationSubscription = vscode.debug.onDidTerminateDebugSession(session => {
			this.restoredSnapshotSessions.delete(session.id);
		});
	}

	public async hotswapCurrentFrame(): Promise<void> {
		const session = vscode.debug.activeDebugSession;
		if (!session || session.type !== 'debugpy') {
			throw new Error('Pause an active Python debug session before hotswapping.');
		}
		if (typeof session.configuration.spacetimepyLaunchId !== 'string') {
			throw new Error(
				'Live hotswap is available in sessions started with “Debug with SpaceTimePy”.',
			);
		}

		const threadId = await this.firstThreadId(session);
		const frame = await this.topFrame(session, threadId);
		await this.saveSource(frame.source?.path);
		this.output.appendLine(`Preparing live hotswap in ${frame.name} at line ${frame.line}`);
		const prepared = await session.customRequest('evaluate', {
			expression: '_spacetimepy_hotswap_prepare()',
			frameId: frame.id,
			threadId,
			context: 'repl',
		});
		this.output.appendLine(`Hotswap line mapping: ${prepared?.result ?? '(prepared)'}`);

		const restored = await this.completePreparedReplacement(session, threadId);
		this.output.appendLine(`Replacement state restored: ${restored?.result ?? '(restored)'}`);
		void vscode.window.showInformationMessage(
			`SpaceTimePy replaced ${frame.name}; execution now follows the new branch.`,
		);
	}

	public isSpaceTimeSession(session: vscode.DebugSession): boolean {
		return session.type === 'debugpy'
			&& typeof session.configuration.spacetimepyLaunchId === 'string';
	}

	public async replayCheckpointInCurrentSession(
		request: ActiveCheckpointRequest,
	): Promise<void> {
		const session = vscode.debug.activeDebugSession;
		if (!session || !this.isSpaceTimeSession(session)) {
			throw new Error(
				'The active debugger was not launched by SpaceTimePy and cannot restore this checkpoint.',
			);
		}
		const threadId = await this.firstThreadId(session);
		const frame = await this.topFrame(session, threadId);
		await this.saveSource(frame.source?.path);
		this.output.appendLine(
			`Preparing checkpoint step ${request.stepId} in active ${frame.name}`,
		);
		const prepared = await session.customRequest('evaluate', {
			expression: `_spacetimepy_hotswap_prepare_checkpoint(${request.branchId}, ${request.stepId})`,
			frameId: frame.id,
			threadId,
			context: 'repl',
		});
		this.output.appendLine(`Checkpoint line mapping: ${prepared?.result ?? '(prepared)'}`);

		const restored = await this.completePreparedReplacement(session, threadId);
		this.output.appendLine(`Checkpoint state restored: ${restored?.result ?? '(restored)'}`);
		void vscode.window.showInformationMessage(
			`SpaceTimePy forked checkpoint step ${request.stepId} in the current debug session.`,
		);
	}

	public dispose(): void {
		this.trackerRegistration.dispose();
		this.terminationSubscription.dispose();
		this.synchronizedTraceEmitter.dispose();
		for (const waiters of this.stoppedWaiters.values()) {
			for (const resolve of waiters) {
				resolve();
			}
		}
		this.stoppedWaiters.clear();
	}

	private async restoreSnapshotSession(
		session: vscode.DebugSession,
		stoppedThreadId?: number,
	): Promise<void> {
		try {
			const threadId = stoppedThreadId ?? await this.firstThreadId(session);
			const frame = await this.topFrame(session, threadId);
			const restored = await session.customRequest('evaluate', {
				expression: '_spacetimepy_hotswap_finish()',
				frameId: frame.id,
				threadId,
				context: 'repl',
			});
			this.output.appendLine(`Recorded snapshot restored: ${restored?.result ?? '(restored)'}`);
			void vscode.window.showInformationMessage(
				'SpaceTimePy restored the selected snapshot into the restarted function.',
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Snapshot restoration failed: ${detail}`);
			void vscode.window.showErrorMessage(`SpaceTimePy snapshot restoration failed: ${detail}`);
		}
	}

	private async synchronizeTrace(
		session: vscode.DebugSession,
		stoppedThreadId?: number,
	): Promise<void> {
		if (typeof session.configuration.spacetimepyLaunchId !== 'string') {
			return;
		}
		try {
			const threadId = stoppedThreadId ?? await this.firstThreadId(session);
			const frame = await this.topFrame(session, threadId);
			await session.customRequest('evaluate', {
				expression: "(lambda runtime: runtime is not None and (runtime.commit() or True))(__import__('spacetimepy').get_active_spacetime())",
				frameId: frame.id,
				threadId,
				context: 'repl',
			});
			this.synchronizedTraceEmitter.fire(session);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Live trace synchronization skipped: ${detail}`);
		}
	}

	private async completePreparedReplacement(
		session: vscode.DebugSession,
		threadId: number,
	): Promise<{ result?: string } | undefined> {
		const stopped = this.waitForStopped(session.id, 15_000);
		this.hotswapInProgress.add(session.id);
		let restored: { result?: string } | undefined;
		try {
			await session.customRequest('continue', { threadId });
			await stopped;

			const replacement = await this.topFrame(session, threadId);
			restored = await session.customRequest('evaluate', {
				expression: '_spacetimepy_hotswap_finish()',
				frameId: replacement.id,
				threadId,
				context: 'repl',
			});
		} finally {
			this.hotswapInProgress.delete(session.id);
		}
		await this.synchronizeTrace(session, threadId);
		return restored;
	}

	private async firstThreadId(session: vscode.DebugSession): Promise<number> {
		const response = await session.customRequest('threads') as {
			threads?: Array<{ id: number }>;
		};
		const threadId = response.threads?.[0]?.id;
		if (threadId === undefined) {
			throw new Error('The Python debugger did not report a paused thread.');
		}
		return threadId;
	}

	private async topFrame(session: vscode.DebugSession, threadId: number): Promise<NonNullable<StackFrameResponse['stackFrames']>[number]> {
		const response = await session.customRequest('stackTrace', {
			threadId,
			startFrame: 0,
			levels: 1,
		}) as StackFrameResponse;
		const frame = response.stackFrames?.[0];
		if (!frame) {
			throw new Error('The Python debugger did not report an active stack frame.');
		}
		return frame;
	}

	private async saveSource(sourcePath: string | undefined): Promise<void> {
		if (!sourcePath) {
			return;
		}
		const document = vscode.workspace.textDocuments.find(
			candidate => candidate.uri.scheme === 'file' && candidate.uri.fsPath === sourcePath,
		);
		if (document?.isDirty && !await document.save()) {
			throw new Error('The edited Python file must be saved before hotswapping.');
		}
	}

	private waitForStopped(sessionId: string, timeout: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const waiters = this.stoppedWaiters.get(sessionId) ?? new Set<() => void>();
			let timeoutHandle: NodeJS.Timeout;
			const finish = () => {
				clearTimeout(timeoutHandle);
				waiters.delete(finish);
				if (waiters.size === 0) {
					this.stoppedWaiters.delete(sessionId);
				}
				resolve();
			};
			waiters.add(finish);
			this.stoppedWaiters.set(sessionId, waiters);
			timeoutHandle = setTimeout(() => {
				waiters.delete(finish);
				if (waiters.size === 0) {
					this.stoppedWaiters.delete(sessionId);
				}
				reject(new Error('The replacement function did not reach its entry breakpoint.'));
			}, timeout);
		});
	}

	private resolveStopped(sessionId: string): void {
		const waiters = this.stoppedWaiters.get(sessionId);
		if (!waiters) {
			return;
		}
		for (const resolve of [...waiters]) {
			resolve();
		}
	}
}
