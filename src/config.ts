import * as vscode from 'vscode';
import { selectWorkspaceDatabase } from './database';

export interface SpaceTimePyConfig {
	apiUrl: string;
	autoStartServer: boolean;
	usesExternalApi: boolean;
	databasePath: string | null;
	host: string;
	port: number;
	pythonPath: string;
	requestTimeout: number;
	codeLensRefreshInterval: number;
}

function workspaceRoot(): string | null {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function resolveDatabasePath(): string | null {
	const root = workspaceRoot();
	return root ? selectWorkspaceDatabase(root).path : null;
}

export function getConfig(): SpaceTimePyConfig {
	const configuration = vscode.workspace.getConfiguration('spacetimepy');
	const host = configuration.get<string>('server.host', '127.0.0.1');
	const port = configuration.get<number>('server.port', 8000);
	const configuredApiUrl = configuration.get<string>('apiUrl', '').trim();

	return {
		apiUrl: (configuredApiUrl || `http://${host}:${port}`).replace(/\/$/, ''),
		autoStartServer: configuration.get<boolean>('server.autoStart', true) && !configuredApiUrl,
		usesExternalApi: Boolean(configuredApiUrl),
		databasePath: resolveDatabasePath(),
		host,
		port,
		pythonPath: configuration.get<string>('pythonPath', '').trim(),
		requestTimeout: configuration.get<number>('requestTimeout', 10_000),
		codeLensRefreshInterval: configuration.get<number>('codeLens.refreshInterval', 5_000),
	};
}
