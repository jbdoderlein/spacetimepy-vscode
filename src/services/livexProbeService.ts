import * as vscode from 'vscode';
import { FunctionData, StackTraceResponse } from '../types';
import { getFunctionData, getStackTrace, isServerReady, waitForServer } from './api';
import { analyzeLivExSource } from './livex';

type LivExAnalysis = Awaited<ReturnType<typeof analyzeLivExSource>>;
type LivExProbeBinding = LivExAnalysis['probes'][number];
type StackFrameRecording = StackTraceResponse['frames'][number];
type FrameVariableValue = StackFrameRecording['locals'][string];

interface LivExProbeRecordingCheck {
    binding: LivExProbeBinding;
    functionCalls: FunctionData[];
    checkedFunctionCalls: FunctionData[];
    matchingFrames: Array<{
        functionCall: FunctionData;
        frame: StackFrameRecording;
        probeValue: FrameVariableValue | null;
        probeValueScope: 'locals' | 'globals' | null;
    }>;
}

interface LivExAnalysisRunResult {
    analysis: LivExAnalysis;
    apiReady: boolean;
    recordingChecks: LivExProbeRecordingCheck[];
}

interface LivExAnalysisRunOptions {
    waitForApi: boolean;
}

export class LivExProbeService implements vscode.Disposable {
    private readonly outputChannel = vscode.window.createOutputChannel('PyMonitor LivEx');
    private readonly probeDecorationType = vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 1rem'
        }
    });
    private readonly analysisTimers = new Map<string, NodeJS.Timeout>();
    private readonly analysisRunIds = new Map<string, number>();
    private readonly recordingCheckCache = new Map<string, LivExProbeRecordingCheck[]>();
    private readonly disposables: vscode.Disposable[] = [];
    private nextAnalysisRunId = 0;

    constructor() {
        this.disposables.push(
            this.outputChannel,
            this.probeDecorationType,
            vscode.commands.registerCommand('pymonitor.analyzeLivExProbes', () => this.analyzeActiveEditor()),
            vscode.workspace.onDidOpenTextDocument(document => this.scheduleDocumentAnalysis(document, 0)),
            vscode.workspace.onDidChangeTextDocument(event => this.scheduleDocumentAnalysis(event.document)),
            vscode.workspace.onDidCloseTextDocument(document => this.clearProbeDecorations(document)),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisibleEditorDecorations()),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.refreshOrScheduleEditor(editor);
                }
            })
        );
    }

    public scheduleDocumentAnalysis(document: vscode.TextDocument, delayMs: number = 750): void {
        if (document.languageId !== 'python') {
            return;
        }

        const uriKey = document.uri.toString();
        const existingTimer = this.analysisTimers.get(uriKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const runId = ++this.nextAnalysisRunId;
        this.analysisRunIds.set(uriKey, runId);
        const timer = setTimeout(() => {
            this.analysisTimers.delete(uriKey);
            this.runAutomaticAnalysis(document, runId);
        }, delayMs);
        this.analysisTimers.set(uriKey, timer);
    }

    public analyzeOpenPythonDocuments(): void {
        for (const document of vscode.workspace.textDocuments) {
            this.scheduleDocumentAnalysis(document, 0);
        }
    }

    public dispose(): void {
        for (const timer of this.analysisTimers.values()) {
            clearTimeout(timer);
        }
        this.analysisTimers.clear();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async analyzeActiveEditor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        try {
            const { analysis, apiReady, recordingChecks } = await this.runAnalysisForDocument(
                editor.document,
                { waitForApi: true }
            );
            this.applyProbeDecorations(editor.document, recordingChecks);

            writeLivExAnalysisOutput(this.outputChannel, editor.document, analysis, recordingChecks);
            this.outputChannel.show(true);

            if (!apiReady) {
                vscode.window.showWarningMessage(
                    `LivEx analysis found ${analysis.probes.length} probe(s), but PyMonitor API is not running. See PyMonitor LivEx output.`
                );
                return;
            }

            const matchedRecordingCount = recordingChecks.filter(check => check.matchingFrames.length > 0).length;
            if (analysis.parserErrors.length > 0 || analysis.diagnostics.length > 0) {
                vscode.window.showWarningMessage(
                    `LivEx analysis found ${analysis.probes.length} probe(s), ${matchedRecordingCount} with matching recordings, with parser diagnostics. See PyMonitor LivEx output.`
                );
                return;
            }

            const linkedProbeCount = analysis.probes.filter(binding => binding.functionInfo).length;
            vscode.window.showInformationMessage(
                `LivEx analysis found ${analysis.probes.length} probe(s), ${linkedProbeCount} linked to function(s), ${matchedRecordingCount} with matching recordings.`
            );
        } catch (error) {
            const message = getErrorMessage(error);
            console.error('LivEx analysis failed:', error);
            vscode.window.showErrorMessage(`LivEx analysis failed: ${message}`);
        }
    }

    private async runAutomaticAnalysis(document: vscode.TextDocument, runId: number): Promise<void> {
        const uriKey = document.uri.toString();

        try {
            const result = await this.runAnalysisForDocument(document, { waitForApi: false });
            if (this.analysisRunIds.get(uriKey) !== runId) {
                return;
            }

            this.applyProbeDecorations(document, result.recordingChecks);
        } catch (error) {
            if (this.analysisRunIds.get(uriKey) === runId) {
                this.applyProbeDecorations(document, []);
            }
            console.error('Automatic LivEx analysis failed:', error);
        }
    }

    private async runAnalysisForDocument(
        document: vscode.TextDocument,
        options: LivExAnalysisRunOptions
    ): Promise<LivExAnalysisRunResult> {
        const analysis = await analyzeLivExSource(document.getText());
        const shouldCheckApi = analysis.probes.length > 0;
        const apiReady = shouldCheckApi
            ? options.waitForApi
                ? await waitForServer()
                : await isServerReady()
            : false;
        const recordingChecks = apiReady
            ? await checkLivExProbeRecordings(document, analysis)
            : [];

        return {
            analysis,
            apiReady,
            recordingChecks
        };
    }

    private applyProbeDecorations(
        document: vscode.TextDocument,
        recordingChecks: LivExProbeRecordingCheck[]
    ): void {
        this.recordingCheckCache.set(document.uri.toString(), recordingChecks);
        const decorations = recordingChecks
            .filter(check => check.matchingFrames.length > 0)
            .map(check => createLivExProbeDecoration(document, check))
            .filter((decoration): decoration is vscode.DecorationOptions => Boolean(decoration));

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === document.uri.toString()) {
                editor.setDecorations(this.probeDecorationType, decorations);
            }
        }
    }

    private clearProbeDecorations(document: vscode.TextDocument): void {
        const uriKey = document.uri.toString();
        const timer = this.analysisTimers.get(uriKey);
        if (timer) {
            clearTimeout(timer);
            this.analysisTimers.delete(uriKey);
        }
        this.analysisRunIds.delete(uriKey);
        this.recordingCheckCache.delete(uriKey);

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === uriKey) {
                editor.setDecorations(this.probeDecorationType, []);
            }
        }
    }

    private refreshVisibleEditorDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.refreshOrScheduleEditor(editor);
        }
    }

    private refreshOrScheduleEditor(editor: vscode.TextEditor): void {
        if (editor.document.languageId !== 'python') {
            return;
        }

        const cachedChecks = this.recordingCheckCache.get(editor.document.uri.toString());
        if (cachedChecks) {
            this.applyProbeDecorations(editor.document, cachedChecks);
        } else {
            this.scheduleDocumentAnalysis(editor.document, 0);
        }
    }
}

function writeLivExAnalysisOutput(
    outputChannel: vscode.OutputChannel,
    document: vscode.TextDocument,
    analysis: LivExAnalysis,
    recordingChecks: LivExProbeRecordingCheck[] = []
): void {
    outputChannel.clear();
    outputChannel.appendLine(`LivEx analysis for ${document.fileName}`);
    outputChannel.appendLine('');
    outputChannel.appendLine('Preprocessed LivEx source:');
    outputChannel.appendLine(analysis.livexSource || '(no LivEx annotations found)');
    outputChannel.appendLine('');

    if (analysis.parserErrors.length > 0) {
        outputChannel.appendLine(`Parser errors (${analysis.parserErrors.length}):`);
        for (const error of analysis.parserErrors) {
            outputChannel.appendLine(`  - ${error.message}`);
        }
        outputChannel.appendLine('');
    }

    if (analysis.diagnostics.length > 0) {
        outputChannel.appendLine(`Diagnostics (${analysis.diagnostics.length}):`);
        for (const diagnostic of analysis.diagnostics) {
            outputChannel.appendLine(
                `  - line ${getDiagnosticLine(diagnostic)}: ${diagnostic.message}`
            );
        }
        outputChannel.appendLine('');
    }

    outputChannel.appendLine(`Functions (${analysis.functions.length}):`);
    for (const func of analysis.functions) {
        outputChannel.appendLine(
            `  - ${func.name} lines ${func.range.start.line + 1}-${func.range.end.line + 1}`
        );
    }
    outputChannel.appendLine('');

    outputChannel.appendLine(`Probes (${analysis.probes.length}):`);
    for (const binding of analysis.probes) {
        const expr = binding.requestProbe.expr;
        const scopedTarget = `${expr.scopes.map(scope => `.${scope}`).join('')}:${expr.target}`;
        const language = expr.lang ? `${expr.lang} ` : '';
        const condition = binding.requestProbe.condition
            ? ` if ${binding.requestProbe.condition}`
            : '';
        const functionLabel = binding.functionInfo
            ? `${binding.functionInfo.name} lines ${binding.functionInfo.range.start.line + 1}-${binding.functionInfo.range.end.line + 1}`
            : 'no containing function';

        outputChannel.appendLine(
            `  - line ${binding.requestProbe.line}: ${language}${scopedTarget}${condition} -> ${functionLabel}`
        );
    }

    if (recordingChecks.length === 0) {
        return;
    }

    outputChannel.appendLine('');
    outputChannel.appendLine('API recording matches:');
    for (const check of recordingChecks) {
        const functionName = check.binding.functionInfo?.name ?? 'no containing function';
        const line = check.binding.requestProbe.line;

        if (!check.binding.functionInfo) {
            outputChannel.appendLine(`  - line ${line}: skipped, no containing function`);
            continue;
        }

        if (check.functionCalls.length === 0) {
            outputChannel.appendLine(`  - line ${line} in ${functionName}: no API function calls found`);
            continue;
        }

        if (check.checkedFunctionCalls.length === 0) {
            outputChannel.appendLine(
                `  - line ${line} in ${functionName}: ${check.functionCalls.length} call(s), none with stack recording`
            );
            continue;
        }

        if (check.matchingFrames.length === 0) {
            outputChannel.appendLine(
                `  - line ${line} in ${functionName}: no recorded frame in ${check.checkedFunctionCalls.length} stack recording(s)`
            );
            continue;
        }

        const values = getProbeValueLabels(check);
        const matches = check.matchingFrames
            .map(match => {
                const value = match.probeValue
                    ? `, ${match.probeValueScope} ${check.binding.requestProbe.expr.target}=${match.probeValue.value}`
                    : `, ${check.binding.requestProbe.expr.target} not found`;
                return `call ${match.functionCall.id}, snapshot ${match.frame.snapshot_id}${value}`;
            })
            .join('; ');
        const valueSummary = values.length > 0 ? ` values ${values.join(' | ')};` : '';
        outputChannel.appendLine(`  - line ${line} in ${functionName}:${valueSummary} ${matches}`);
    }
}

async function checkLivExProbeRecordings(
    document: vscode.TextDocument,
    analysis: LivExAnalysis
): Promise<LivExProbeRecordingCheck[]> {
    const functionCallCache = new Map<string, FunctionData[]>();
    const stackTraceCache = new Map<string, StackTraceResponse | null>();

    return Promise.all(analysis.probes.map(async binding => {
        if (!binding.functionInfo) {
            return {
                binding,
                functionCalls: [],
                checkedFunctionCalls: [],
                matchingFrames: []
            };
        }

        const functionName = binding.functionInfo.name;
        const functionCalls = await getCachedFunctionCalls(
            functionCallCache,
            document.fileName,
            functionName
        );
        const checkedFunctionCalls = functionCalls.filter(call => call.has_stack_recording);
        const matchingFrames = await findMatchingFrames(
            stackTraceCache,
            checkedFunctionCalls,
            binding
        );

        return {
            binding,
            functionCalls,
            checkedFunctionCalls,
            matchingFrames
        };
    }));
}

async function getCachedFunctionCalls(
    cache: Map<string, FunctionData[]>,
    filePath: string,
    functionName: string
): Promise<FunctionData[]> {
    const cacheKey = `${filePath}:${functionName}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const calls = await getFunctionData(filePath, functionName) ?? [];
    const matchingCalls = calls.filter(call => call.function === functionName);
    cache.set(cacheKey, matchingCalls);
    return matchingCalls;
}

async function findMatchingFrames(
    cache: Map<string, StackTraceResponse | null>,
    functionCalls: FunctionData[],
    binding: LivExProbeBinding
): Promise<LivExProbeRecordingCheck['matchingFrames']> {
    for (const functionCall of functionCalls) {
        const stackTrace = await getCachedStackTrace(cache, functionCall.id);
        if (!stackTrace) {
            continue;
        }

        const matchingFrames = stackTrace.frames
            .filter(frame => frame.line === binding.requestProbe.line)
            .map(frame => {
                const resolvedValue = resolveProbeValue(frame, binding);
                return {
                    functionCall,
                    frame,
                    probeValue: resolvedValue.value,
                    probeValueScope: resolvedValue.scope
                };
            });

        if (matchingFrames.length > 0) {
            return matchingFrames;
        }
    }

    return [];
}

function resolveProbeValue(
    frame: StackFrameRecording,
    binding: LivExProbeBinding
): { value: FrameVariableValue | null; scope: 'locals' | 'globals' | null } {
    for (const variableName of getProbeVariableNameCandidates(binding)) {
        const localValue = frame.locals[variableName];
        if (localValue) {
            return { value: localValue, scope: 'locals' };
        }

        const globalValue = frame.globals[variableName];
        if (globalValue) {
            return { value: globalValue, scope: 'globals' };
        }
    }

    return { value: null, scope: null };
}

function getProbeVariableNameCandidates(binding: LivExProbeBinding): string[] {
    const target = binding.requestProbe.expr.target;
    const scopedTarget = [...binding.requestProbe.expr.scopes, target].join('.');

    return scopedTarget === target ? [target] : [scopedTarget, target];
}

function createLivExProbeDecoration(
    document: vscode.TextDocument,
    check: LivExProbeRecordingCheck
): vscode.DecorationOptions | null {
    const lineIndex = check.binding.requestProbe.line - 1;
    if (lineIndex < 0 || lineIndex >= document.lineCount) {
        return null;
    }

    const line = document.lineAt(lineIndex);
    const frameCount = check.matchingFrames.length;
    const values = getProbeValueLabels(check);
    const frameLabel = `${frameCount} stack frame${frameCount === 1 ? '' : 's'}`;
    const label = values.length > 0 ? values.join(' | ') : frameLabel;
    const hoverDetail = values.length > 0
        ? `LivEx probe resolved to ${frameLabel}: ${label}.`
        : `LivEx probe resolved to ${frameLabel}; variable ${check.binding.requestProbe.expr.target} was not found in locals/globals.`;
    const hover = new vscode.MarkdownString(
        hoverDetail
    );
    hover.isTrusted = false;

    return {
        range: new vscode.Range(line.range.end, line.range.end),
        hoverMessage: hover,
        renderOptions: {
            after: {
                contentText: `  ${label}`,
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic'
            }
        }
    };
}

function getProbeValueLabels(check: LivExProbeRecordingCheck): string[] {
    return check.matchingFrames
        .map(match => match.probeValue?.value)
        .filter((value): value is string => value !== undefined)
        .map(formatProbeValue);
}

function formatProbeValue(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

async function getCachedStackTrace(
    cache: Map<string, StackTraceResponse | null>,
    functionCallId: string | number
): Promise<StackTraceResponse | null> {
    const cacheKey = String(functionCallId);
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
    }

    const stackTrace = await getStackTrace(functionCallId);
    cache.set(cacheKey, stackTrace);
    return stackTrace;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getDiagnosticLine(diagnostic: LivExAnalysis['diagnostics'][number]): string {
    const range = diagnostic.range as { start?: { line?: unknown } } | undefined;
    return typeof range?.start?.line === 'number' ? String(range.start.line + 1) : '?';
}
