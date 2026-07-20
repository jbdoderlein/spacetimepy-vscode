import * as vscode from 'vscode';
import { findPythonFunctions, isLaunchablePythonFunction } from './pythonFunctions';

export class FunctionLaunchCodeLensProvider implements vscode.CodeLensProvider {
	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (document.languageId !== 'python' || document.uri.scheme !== 'file') {
			return [];
		}

		return findPythonFunctions(document.getText())
			.filter(isLaunchablePythonFunction)
			.map(functionInfo => new vscode.CodeLens(
				new vscode.Range(
					functionInfo.line,
					functionInfo.character,
					functionInfo.line,
					functionInfo.character,
				),
				{
					command: 'spacetimepy.debugFunction',
					title: '$(debug-start) Debug with SpaceTimePy',
					arguments: [document.uri, functionInfo],
				},
			));
	}
}
