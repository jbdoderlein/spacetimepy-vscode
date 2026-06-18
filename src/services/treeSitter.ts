import * as vscode from 'vscode';
import { Tree } from 'tree-sitter';
import Parser from 'tree-sitter';
import PythonParser from 'tree-sitter-python';
const parser = new Parser();
parser.setLanguage(PythonParser as any); // Type assertion to bypass type error

/**
 * Interface for function information
 */
export interface FunctionInfo {
    name: string;
    range: vscode.Range;
    params: string[];
    docstring?: string;
}

/**
 * Parse Python source code and extract function definitions using tree-sitter.
 */
export function parsePythonSource(sourceCode: string): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const tree : Tree = parser.parse(sourceCode);
    const root = tree.rootNode;

    // Find function definitions
    const functionNodes = root.descendantsOfType('function_definition');

    for (const node of functionNodes) {
        const functionName = node.child(1)?.text;
        const functionParamsList = node.child(2);
        const functionParams = functionParamsList?.children
        .filter(param => param.type === 'identifier' || param.type === 'argument')
        .map(param => param.text);
        
        if (!functionName || !functionParams) {
            continue;
        }

        const functionRange = new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column)
        );

        const functionInfo: FunctionInfo = {
            name: functionName,
            range: functionRange,
            params: functionParams.map(param => param.trim())
        };

        functions.push(functionInfo);
    }
    return functions;
}

/**
 * Parse a Python file and extract function definitions using tree-sitter.
 */
export function parsePythonFile(document: vscode.TextDocument): FunctionInfo[] {
    return parsePythonSource(document.getText());
}
