import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SpaceTimePyApiClient } from './api';
import { getConfig } from './config';
import { initializeTraceDatabase } from './database';

export type ServerState = 'idle' | 'starting' | 'ready' | 'error';

export interface ServerStatus {
	state: ServerState;
	message: string;
	managed: boolean;
}

export interface CaptureRuntime {
	pythonPath: string;
	databasePath: string;
}

interface PythonEnvironmentPath {
	path?: string;
	uri?: vscode.Uri;
}

interface PythonExtensionExports {
	environments?: {
		getActiveEnvironmentPath(resource?: vscode.Uri): PythonEnvironmentPath | undefined;
	};
	settings?: {
		getExecutionDetails(resource?: vscode.Uri): { execCommand?: string[] };
	};
}

export class ServerManager implements vscode.Disposable {
	private process: ChildProcess | null = null;
	private startPromise: Promise<void> | null = null;
	private status: ServerStatus = {
		state: 'idle',
		message: 'SpaceTimePy trace server is stopped',
		managed: false,
	};
	private readonly statusEmitter = new vscode.EventEmitter<ServerStatus>();
	public readonly onDidChangeStatus = this.statusEmitter.event;

	constructor(
		private readonly api: SpaceTimePyApiClient,
		private readonly output: vscode.OutputChannel,
	) {}

	public getStatus(): ServerStatus {
		return this.status;
	}

	public async startIfConfigured(): Promise<void> {
		const config = getConfig();
		if (!config.autoStartServer) {
			if (!config.usesExternalApi) {
				await this.initializeDatabaseIfMissing();
			}
			await this.connectToExistingServer();
			return;
		}
		await this.start();
	}

	public async restart(): Promise<void> {
		await this.stop();
		await this.startIfConfigured();
	}

	public async start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.startOnce().finally(() => {
				this.startPromise = null;
			});
		}
		await this.startPromise;
	}

	public async prepareCapture(resource: vscode.Uri): Promise<CaptureRuntime> {
		const config = getConfig();
		if (config.usesExternalApi) {
			throw new Error(
				'Function capture needs the project database, but spacetimepy.apiUrl points to an external server.',
			);
		}
		if (!config.databasePath) {
			throw new Error('Open a workspace folder before launching a SpaceTimePy function capture.');
		}

		const pythonPath = await this.resolvePythonPath(resource);
		await this.verifySpaceTimePy(pythonPath);
		await initializeTraceDatabase(pythonPath, config.databasePath);
		await this.startIfConfigured();
		if (!await this.isApiReady()) {
			throw new Error(
				`The SpaceTimePy API at ${config.apiUrl} must be running so the new recording can be opened.`,
			);
		}
		return { pythonPath, databasePath: config.databasePath };
	}

	private async startOnce(): Promise<void> {
		const config = getConfig();
		if (!config.autoStartServer) {
			await this.connectToExistingServer(true);
			return;
		}
		if (!config.databasePath) {
			this.setStatus({
				state: 'error',
				message: 'Open a workspace folder so SpaceTimePy can select a project trace database',
				managed: false,
			});
			throw new Error(this.status.message);
		}

		if (await this.isApiReady()) {
			this.setStatus({
				state: 'ready',
				message: `Connected to SpaceTimePy at ${config.apiUrl}`,
				managed: false,
			});
			return;
		}

		let pythonPath: string;
		try {
			pythonPath = await this.resolvePythonPath();
			await this.verifySpaceTimePy(pythonPath);
			if (!fs.existsSync(config.databasePath)) {
				this.setStatus({
					state: 'starting',
					message: `Creating ${path.basename(config.databasePath)}`,
					managed: true,
				});
				this.output.appendLine(`Initializing empty SpaceTimePy trace: ${config.databasePath}`);
				await initializeTraceDatabase(pythonPath, config.databasePath);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.setStatus({ state: 'error', message: detail, managed: false });
			throw error;
		}
		this.setStatus({
			state: 'starting',
			message: `Starting SpaceTimePy for ${path.basename(config.databasePath)}`,
			managed: true,
		});

		this.output.appendLine(`Starting SpaceTimePy with ${pythonPath}`);
		this.output.appendLine(`Trace database: ${config.databasePath}`);
		const child = spawn(
			pythonPath,
			[
				'-m',
				'spacetimepy.interface.web.explorer',
				config.databasePath,
				'--api-only',
				'--host',
				config.host,
				'--port',
				String(config.port),
			],
			{
				cwd: path.dirname(config.databasePath),
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		this.process = child;
		child.stdout.on('data', data => this.output.append(data.toString()));
		child.stderr.on('data', data => this.output.append(data.toString()));
		child.once('error', error => {
			if (this.process === child) {
				this.process = null;
				this.setStatus({ state: 'error', message: error.message, managed: false });
			}
		});
		child.once('exit', (code, signal) => {
			if (this.process === child) {
				this.process = null;
				this.setStatus({
					state: code === 0 ? 'idle' : 'error',
					message: `SpaceTimePy server exited (${signal ?? code ?? 'unknown'})`,
					managed: false,
				});
			}
		});

		const deadline = Date.now() + Math.max(config.requestTimeout, 15_000);
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.killed) {
				throw new Error('SpaceTimePy server stopped before it became ready');
			}
			if (await this.isApiReady()) {
				this.setStatus({
					state: 'ready',
					message: `SpaceTimePy is serving ${path.basename(config.databasePath)}`,
					managed: true,
				});
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}

		await this.stop();
		this.setStatus({
			state: 'error',
			message: 'SpaceTimePy server did not become ready in time',
			managed: false,
		});
		throw new Error(this.status.message);
	}

	public async stop(): Promise<void> {
		const child = this.process;
		this.process = null;
		if (child && child.exitCode === null && !child.killed) {
			child.kill();
		}
		this.setStatus({
			state: 'idle',
			message: 'SpaceTimePy trace server is stopped',
			managed: false,
		});
	}

	public dispose(): void {
		void this.stop();
		this.statusEmitter.dispose();
	}

	private async connectToExistingServer(showError = false): Promise<void> {
		const config = getConfig();
		if (await this.isApiReady()) {
			this.setStatus({
				state: 'ready',
				message: `Connected to SpaceTimePy at ${config.apiUrl}`,
				managed: false,
			});
			return;
		}
		this.setStatus({
			state: showError ? 'error' : 'idle',
			message: `No SpaceTimePy API available at ${config.apiUrl}`,
			managed: false,
		});
		if (showError) {
			throw new Error(this.status.message);
		}
	}

	private async initializeDatabaseIfMissing(): Promise<void> {
		const config = getConfig();
		if (!config.databasePath) {
			const message = 'Open a workspace folder so SpaceTimePy can select a project trace database';
			this.setStatus({ state: 'error', message, managed: false });
			throw new Error(message);
		}
		if (fs.existsSync(config.databasePath)) {
			return;
		}

		try {
			const pythonPath = await this.resolvePythonPath();
			await this.verifySpaceTimePy(pythonPath);
			this.setStatus({
				state: 'starting',
				message: `Creating ${path.basename(config.databasePath)}`,
				managed: false,
			});
			this.output.appendLine(`Initializing empty SpaceTimePy trace: ${config.databasePath}`);
			await initializeTraceDatabase(pythonPath, config.databasePath);
			this.setStatus({
				state: 'idle',
				message: `SpaceTimePy trace is ready at ${config.databasePath}`,
				managed: false,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.setStatus({ state: 'error', message: detail, managed: false });
			throw error;
		}
	}

	private async isApiReady(): Promise<boolean> {
		try {
			await this.api.health();
			return true;
		} catch {
			return false;
		}
	}

	private async resolvePythonPath(resource?: vscode.Uri): Promise<string> {
		const configured = getConfig().pythonPath;
		if (configured) {
			return configured;
		}

		const extension = vscode.extensions.getExtension<PythonExtensionExports>('ms-python.python');
		if (extension) {
			const exports = extension.isActive ? extension.exports : await extension.activate();
			const selectedResource = resource ?? vscode.workspace.workspaceFolders?.[0]?.uri;
			const environment = exports.environments?.getActiveEnvironmentPath(selectedResource);
			const activePath = environment?.path ?? environment?.uri?.fsPath;
			if (activePath) {
				return activePath;
			}
			const executionDetails = exports.settings?.getExecutionDetails(selectedResource);
			if (executionDetails?.execCommand?.[0]) {
				return executionDetails.execCommand[0];
			}
		}

		return process.platform === 'win32' ? 'python' : 'python3';
	}

	private async verifySpaceTimePy(pythonPath: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				pythonPath,
				['-c', 'import spacetimepy; print(spacetimepy.__version__)'],
				{ stdio: ['ignore', 'pipe', 'pipe'] },
			);
			let standardError = '';
			child.stderr.on('data', data => {
				standardError += data.toString();
			});
			child.once('error', reject);
			child.once('exit', code => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(
						`The selected Python environment cannot import SpaceTimePy${standardError.trim() ? `: ${standardError.trim()}` : ''}`,
					));
				}
			});
		});
	}

	private setStatus(status: ServerStatus): void {
		this.status = status;
		this.statusEmitter.fire(status);
	}
}
