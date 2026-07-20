import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const WORKSPACE_DATABASE_DIRECTORY = '.vscode';
export const WORKSPACE_DATABASE_NAME = 'spacetimepy.db';
export const ROOT_DATABASE_NAME = 'trace.db';

export type DatabaseSource = 'vscode' | 'root' | 'new';

export interface DatabaseSelection {
	path: string;
	source: DatabaseSource;
}

export function selectWorkspaceDatabase(
	workspaceRoot: string,
	pathExists: (candidate: string) => boolean = fs.existsSync,
): DatabaseSelection {
	const vscodeDatabase = path.join(
		workspaceRoot,
		WORKSPACE_DATABASE_DIRECTORY,
		WORKSPACE_DATABASE_NAME,
	);
	if (pathExists(vscodeDatabase)) {
		return { path: vscodeDatabase, source: 'vscode' };
	}

	const rootDatabase = path.join(workspaceRoot, ROOT_DATABASE_NAME);
	if (pathExists(rootDatabase)) {
		return { path: rootDatabase, source: 'root' };
	}

	return { path: vscodeDatabase, source: 'new' };
}

export async function initializeTraceDatabase(
	pythonPath: string,
	databasePath: string,
): Promise<void> {
	if (fs.existsSync(databasePath)) {
		return;
	}

	await fs.promises.mkdir(path.dirname(databasePath), { recursive: true });
	const initializeScript = [
		'import sys',
		'from spacetimepy import TraceData',
		'trace = TraceData.open(sys.argv[1], create_if_missing=True)',
		'trace.close()',
	].join('\n');

	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			pythonPath,
			['-c', initializeScript, databasePath],
			{ stdio: ['ignore', 'ignore', 'pipe'] },
		);
		let standardError = '';
		child.stderr.on('data', data => {
			standardError += data.toString();
		});
		child.once('error', reject);
		child.once('exit', code => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(
				`SpaceTimePy could not initialize ${databasePath}${standardError.trim() ? `: ${standardError.trim()}` : ''}`,
			));
		});
	});

	if (!fs.existsSync(databasePath)) {
		throw new Error(`SpaceTimePy did not create the trace database at ${databasePath}`);
	}
}
