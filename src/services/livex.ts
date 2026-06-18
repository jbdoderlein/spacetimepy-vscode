import {
    isProbe,
    parseLivEx,
    type DefinitionList,
    type ExecRequestProbe,
    type LivExDiagnostic,
    type LivExParserError,
    type Probe
} from 'livex';
import { FunctionInfo, parsePythonSource } from './treeSitter';

export interface LivExProbeBinding {
    probe: Probe;
    requestProbe: ExecRequestProbe;
    functionInfo: FunctionInfo | null;
}

export interface LivExSourceAnalysis {
    livexSource: string;
    ast: DefinitionList;
    parserErrors: LivExParserError[];
    diagnostics: LivExDiagnostic[];
    functions: FunctionInfo[];
    probes: LivExProbeBinding[];
}

export async function analyzeLivExSource(sourceCode: string): Promise<LivExSourceAnalysis> {
    const livexSource = preprocessLivEx(sourceCode);
    const parsed = await parseLivEx(livexSource);
    const functions = parsePythonSource(sourceCode);
    const probes = extractProbeBindings(parsed.ast, functions);

    return {
        livexSource,
        ast: parsed.ast,
        parserErrors: parsed.parserErrors,
        diagnostics: parsed.diagnostics,
        functions,
        probes
    };
}

export async function getListProbes(sourceCode: string): Promise<LivExProbeBinding[]> {
    return (await analyzeLivExSource(sourceCode)).probes;
}

export function preprocessLivEx(sourceCode: string): string {
    const lines = sourceCode.split('\n');
    const livexLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const annotationStart = line.indexOf('#@');

        if (annotationStart === -1 || !line.includes('probe')) {
            continue;
        }

        const annotation = line.substring(annotationStart + 2).trimStart();
        livexLines.push(`[${i + 1}]${annotation}`);
    }

    return livexLines.join('\n');
}

export function extractProbeBindings(ast: DefinitionList, functions: FunctionInfo[]): LivExProbeBinding[] {
    return ast.defs
        .filter(isProbe)
        .map(probe => ({
            probe,
            requestProbe: toRequestProbe(probe),
            functionInfo: findFunctionForLine(functions, probe.line)
        }));
}

export function findFunctionForLine(functions: FunctionInfo[], oneBasedLine: number): FunctionInfo | null {
    const zeroBasedLine = oneBasedLine - 1;
    const candidates = functions.filter(func =>
        func.range.start.line <= zeroBasedLine &&
        func.range.end.line >= zeroBasedLine
    );

    if (candidates.length === 0) {
        return null;
    }

    return candidates.sort((a, b) => getRangeSize(a) - getRangeSize(b))[0];
}

function toRequestProbe(probe: Probe): ExecRequestProbe {
    return {
        line: probe.line,
        expr: {
            target: probe.expr.target,
            lang: probe.expr.lang ?? '',
            scopes: probe.expr.scopes
        },
        condition: probe.condition
    };
}

function getRangeSize(functionInfo: FunctionInfo): number {
    return functionInfo.range.end.line - functionInfo.range.start.line;
}
