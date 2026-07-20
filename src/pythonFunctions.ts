import * as path from 'path';
import { FunctionCallSummary } from './types';

export interface PythonFunction {
	name: string;
	qualifiedName: string;
	line: number;
	character: number;
	bodyLine: number;
}

interface Scope {
	indent: number;
	name: string;
}

const definitionPattern = /^(\s*)(?:(async)\s+)?(class|def)\s+([A-Za-z_]\w*)\b/;

function indentation(value: string): number {
	return value.replace(/\t/g, ' '.repeat(8)).length;
}

function functionBodyLine(lines: string[], definitionLine: number, definitionIndent: number): number {
	let headerEnd = definitionLine;
	let bracketDepth = 0;
	let quote: string | null = null;
	let escaped = false;

	for (let line = definitionLine; line < lines.length; line += 1) {
		const text = lines[line];
		for (let character = 0; character < text.length; character += 1) {
			const token = text[character];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (quote) {
				if (token === '\\') {
					escaped = true;
				} else if (token === quote) {
					quote = null;
				}
				continue;
			}
			if (token === '"' || token === "'") {
				quote = token;
				continue;
			}
			if (token === '#') {
				break;
			}
			if ('([{'.includes(token)) {
				bracketDepth += 1;
			} else if (')]}'.includes(token)) {
				bracketDepth = Math.max(0, bracketDepth - 1);
			} else if (token === ':' && bracketDepth === 0) {
				headerEnd = line;
				const remainder = text.slice(character + 1).trim();
				if (remainder && !remainder.startsWith('#')) {
					return line;
				}
				line = lines.length;
				break;
			}
		}
	}

	for (let line = headerEnd + 1; line < lines.length; line += 1) {
		const text = lines[line];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		if (indentation(text.match(/^\s*/)?.[0] ?? '') > definitionIndent) {
			return line;
		}
		break;
	}
	return definitionLine;
}

export function findPythonFunctions(source: string): PythonFunction[] {
	const scopes: Scope[] = [];
	const functions: PythonFunction[] = [];
	const lines = source.split(/\r?\n/);

	for (let line = 0; line < lines.length; line += 1) {
		const match = definitionPattern.exec(lines[line]);
		if (!match) {
			continue;
		}

		const indent = indentation(match[1]);
		while (scopes.length > 0 && scopes[scopes.length - 1].indent >= indent) {
			scopes.pop();
		}

		const kind = match[3];
		const name = match[4];
		const qualifiedName = [...scopes.map(scope => scope.name), name].join('.');
		if (kind === 'def') {
			functions.push({
				name,
				qualifiedName,
				line,
				character: match[1].length,
				bodyLine: functionBodyLine(lines, line, indent),
			});
		}
		scopes.push({ indent, name });
	}

	return functions;
}

export function isLaunchablePythonFunction(functionInfo: PythonFunction): boolean {
	return !functionInfo.qualifiedName.includes('.');
}

function normalizedQualifiedName(value: string): string {
	return value
		.replace(/\.<locals>\./g, '.')
		.replace(/^.*?:/, '')
		.replace(/^\.+|\.+$/g, '');
}

function qualifiedNameMatches(recorded: string, current: string): boolean {
	const normalizedRecorded = normalizedQualifiedName(recorded);
	const normalizedCurrent = normalizedQualifiedName(current);
	return normalizedRecorded === normalizedCurrent
		|| normalizedRecorded.endsWith(`.${normalizedCurrent}`);
}

export function callsForFunction(
	functionInfo: PythonFunction,
	allFunctions: PythonFunction[],
	calls: FunctionCallSummary[],
): FunctionCallSummary[] {
	const namedCalls = calls.filter(call => call.function_name === functionInfo.name || call.function === functionInfo.name);
	const qualifiedCalls = namedCalls.filter(call =>
		call.qualified_name !== null && qualifiedNameMatches(call.qualified_name, functionInfo.qualifiedName),
	);
	if (qualifiedCalls.length > 0) {
		return qualifiedCalls;
	}

	const sameNamedFunctions = allFunctions.filter(candidate => candidate.name === functionInfo.name);
	return sameNamedFunctions.length === 1 ? namedCalls : [];
}

export function recordedCallsForFunction(
	functionInfo: PythonFunction,
	allFunctions: PythonFunction[],
	calls: FunctionCallSummary[],
): FunctionCallSummary[] {
	return callsForFunction(functionInfo, allFunctions, calls)
		.sort((left, right) => (right.started_at ?? '').localeCompare(left.started_at ?? ''));
}

export function recordedFileMatches(
	recordedPath: string | null,
	currentPath: string,
	workspacePath?: string,
): boolean {
	if (!recordedPath) {
		return false;
	}
	const normalize = (value: string) => value.replace(/\\/g, '/').toLocaleLowerCase();
	const recorded = normalize(recordedPath);
	const current = normalize(currentPath);
	if (recorded === current) {
		return true;
	}
	if (workspacePath) {
		const relative = normalize(path.relative(workspacePath, currentPath));
		if (relative && recorded.endsWith(`/${relative}`)) {
			return true;
		}
	}
	return recorded.endsWith(`/${normalize(path.basename(currentPath))}`)
		|| recorded === normalize(path.basename(currentPath));
}
