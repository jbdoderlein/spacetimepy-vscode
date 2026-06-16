import * as vscode from 'vscode';

const variantOriginalScheme = 'spacetime-variant-original';

interface VariantSession {
	originalUri: vscode.Uri;
	originalContent: string;
	anchorLine: number;
}

export class VariantQuickDiffService implements vscode.TextDocumentContentProvider, vscode.QuickDiffProvider, vscode.Disposable {
	private readonly sessions = new Map<string, VariantSession>();
	private readonly originalUriToDocumentUri = new Map<string, string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly sourceControl: vscode.SourceControl;
	private readonly disposables: vscode.Disposable[] = [];

	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor() {
		const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		this.sourceControl = vscode.scm.createSourceControl('spacetimeVariants', 'Spacetime variant', rootUri);
		this.sourceControl.count = 0;
		this.sourceControl.inputBox.visible = false;
		this.sourceControl.quickDiffProvider = this;

		this.disposables.push(
			this.sourceControl,
			this.onDidChangeEmitter,
			vscode.workspace.registerTextDocumentContentProvider(variantOriginalScheme, this),
			vscode.window.onDidChangeActiveTextEditor(editor => this.updateActiveVariantContext(editor)),
			vscode.workspace.onDidCloseTextDocument(document => {
				if (document.uri.scheme === variantOriginalScheme) {
					return;
				}

				this.clearVariantForUri(document.uri);
				this.updateActiveVariantContext(vscode.window.activeTextEditor);
			})
		);
		this.updateActiveVariantContext(vscode.window.activeTextEditor);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const documentUri = this.originalUriToDocumentUri.get(uri.toString());
		if (!documentUri) {
			return '';
		}

		return this.sessions.get(documentUri)?.originalContent ?? '';
	}

	provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
		return this.sessions.get(uri.toString())?.originalUri;
	}

	async startVariantFromEditor(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor found.');
			return;
		}

		if (editor.document.uri.scheme !== 'file') {
			vscode.window.showInformationMessage('Variant quick diff currently works with file-backed documents.');
			return;
		}

		const documentUri = editor.document.uri.toString();
		const originalUri = this.createOriginalUri(editor.document.uri);
		const anchorLine = editor.selection.active.line;
		const previousSession = this.sessions.get(documentUri);
		if (previousSession) {
			this.originalUriToDocumentUri.delete(previousSession.originalUri.toString());
		}

		this.sessions.set(documentUri, {
			originalUri,
			originalContent: this.createOriginalContentWithMarker(editor.document, anchorLine),
			anchorLine
		});
		this.originalUriToDocumentUri.set(originalUri.toString(), documentUri);

		await this.updateActiveVariantContext(editor);
		await this.showNextVariantChange();
	}

	async showNextVariantChange(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !this.sessions.has(editor.document.uri.toString())) {
			vscode.window.showInformationMessage('No variant snapshot is active for this editor.');
			return;
		}

		const session = this.sessions.get(editor.document.uri.toString());
		if (session) {
			const line = Math.min(session.anchorLine, editor.document.lineCount - 1);
			const position = new vscode.Position(line, editor.document.lineAt(line).range.end.character);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}

		await this.executeDirtyDiffCommand();
	}

	async clearActiveVariant(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}

		const cleared = this.clearVariantForUri(editor.document.uri);
		if (cleared) {
			await this.updateActiveVariantContext(editor);
			vscode.window.showInformationMessage('Variant snapshot cleared.');
		}
	}

	dispose(): void {
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		this.sessions.clear();
		this.originalUriToDocumentUri.clear();
	}

	private createOriginalUri(documentUri: vscode.Uri): vscode.Uri {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		return vscode.Uri.from({
			scheme: variantOriginalScheme,
			path: documentUri.path,
			query: `id=${encodeURIComponent(id)}`
		});
	}

	private clearVariantForUri(uri: vscode.Uri): boolean {
		const documentUri = uri.toString();
		const session = this.sessions.get(documentUri);
		if (!session) {
			return false;
		}

		this.originalUriToDocumentUri.delete(session.originalUri.toString());
		this.sessions.delete(documentUri);
		this.onDidChangeEmitter.fire(session.originalUri);
		return true;
	}

	private async updateActiveVariantContext(editor: vscode.TextEditor | undefined): Promise<void> {
		const hasActiveVariant = editor ? this.sessions.has(editor.document.uri.toString()) : false;
		await vscode.commands.executeCommand('setContext', 'spacetimeVariant.active', hasActiveVariant);
	}

	private createOriginalContentWithMarker(document: vscode.TextDocument, lineNumber: number): string {
		const content = document.getText();
		const line = document.lineAt(lineNumber);
		const marker = '  # Old version';
		const insertOffset = document.offsetAt(line.range.end);

		return `${content.slice(0, insertOffset)}${marker}${content.slice(insertOffset)}`;
	}

	private async executeDirtyDiffCommand(): Promise<void> {
		const commandIds = [
			'editor.action.dirtydiff.next',
			'workbench.action.editor.nextChange'
		];

		for (const commandId of commandIds) {
			try {
				await vscode.commands.executeCommand(commandId);
				return;
			} catch {
				// Try the next VS Code command id. These are built-in commands and can vary by version.
			}
		}

		vscode.window.showInformationMessage('Variant quick diff is active. Click a change marker in the editor gutter to open VS Code quick diff.');
	}
}
