import * as vscode from 'vscode';
import { FunctionInfo } from './treeSitter';
import { debugLog } from './state';
import { getFunctionData, getSessionsList, getSessionDetails, getFunctionTraces, refreshApiData } from './api';
import { showFunctionDetails, exploreStackTrace } from './webview';


/**
 * DebugConfiguration for a Python function
 */
interface PyMonitorDebugConfig extends vscode.DebugConfiguration {
    name: string;
    type: string;
    request: string;
    program: string;
    pythonPath?: string;
    args: string[];
    console: string;
    cwd?: string;
    stopOnEntry?: boolean;
    testFunction?: string;
    env?: Record<string, string>;
}

/**
 * Available input options for function debugging
 */
enum DebugInputOption {
    DEFAULT = 'Use default values',
    HISTORY = 'Select from previous function calls',
    MANUAL = 'Enter values manually'
}

/**
 * Service to handle debugging Python functions
 */
export class DebuggerService {
    private static instance: DebuggerService;
    // Store the selected function call ID for reanimation
    private selectedFunctionCallId: string | number | null = null;
    // Store the current debug session ID and related info
    private currentDebugSessionId: string | null = null;
    private currentDebugFunctionInfo: { uri: vscode.Uri, functionName: string } | null = null;

    private constructor() {}

    /**
     * Get the singleton instance
     */
    public static getInstance(): DebuggerService {
        if (!DebuggerService.instance) {
            DebuggerService.instance = new DebuggerService();
        }
        return DebuggerService.instance;
    }

    /**
     * Start a debug session for a specific function
     */
    public async debugFunction(uri: vscode.Uri, functionInfo: FunctionInfo): Promise<boolean> {
        try {
            // Reset selected call ID
            this.selectedFunctionCallId = null;
            
            debugLog(`Starting debug session for function: ${functionInfo.name} in ${uri.fsPath}`);

            // Generate a unique session ID for this debug session
            const debugSessionId = `debug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.currentDebugSessionId = debugSessionId;
            this.currentDebugFunctionInfo = { uri, functionName: functionInfo.name };

            debugLog(`Generated debug session ID: ${debugSessionId}`);

            // Get Python extension
            const pythonExtension = vscode.extensions.getExtension('ms-python.python');
            if (!pythonExtension) {
                vscode.window.showErrorMessage('Python extension not found! Please install it first.');
                return false;
            }

            // Get Python execution details
            const executionDetails = await pythonExtension.exports.settings.getExecutionDetails();
            const pythonPath = executionDetails.execCommand[0];
            if (!pythonPath) {
                vscode.window.showErrorMessage('No Python executable found');
                return false;
            }

            // Ensure there's a breakpoint at the function start
            await this.ensureBreakpointAtFunction(uri, functionInfo);

            // Prompt user to choose how to provide function inputs
            const inputOption = await vscode.window.showQuickPick(
                [
                    DebugInputOption.DEFAULT,
                    DebugInputOption.HISTORY,
                    DebugInputOption.MANUAL
                ],
                {
                    placeHolder: 'Select how to provide function inputs',
                    title: `Debug ${functionInfo.name}()`
                }
            );

            if (!inputOption) {
                // User cancelled
                return false;
            }

            // Define function arguments based on user's choice
            let callArgs: Map<string, string> = new Map();
            let useReanimation = false;

            // Process based on user choice
            switch (inputOption) {
                case DebugInputOption.HISTORY:
                    const historicArgs = await this.getFunctionCallHistory(uri.fsPath, functionInfo.name);
                    if (!historicArgs) {
                        return false;
                    }
                    callArgs = historicArgs;
                    // If we have a selected function call ID, we'll use reanimation
                    useReanimation = !!this.selectedFunctionCallId;
                    break;

                case DebugInputOption.MANUAL:
                    const manualArgs = await this.promptForArgumentValues(functionInfo.params);
                    if (!manualArgs) {
                        return false;
                    }
                    callArgs = manualArgs;
                    break;

                case DebugInputOption.DEFAULT:
                default:
                    // Use default values
                    callArgs = this.getDefaultArgumentValues(functionInfo.params);
                    break;
            }

            // Create debug configuration
            const debugConfig: PyMonitorDebugConfig = {
                name: `Debug ${functionInfo.name}`,
                type: 'python',
                request: 'launch',
                program: uri.fsPath,
                pythonPath: pythonPath,
                args: [debugSessionId], // Pass the unique session ID
                console: 'integratedTerminal',
                stopOnEntry: true, // Stop at the first line of the function
                // Add an environment variable to indicate we want to debug a specific function
                env: {
                    'PYMONITOR_DEBUG_FUNCTION': functionInfo.name,
                    'PYMONITOR_DEBUG_MODE': 'true',
                    'PYMONITOR_SESSION_ID': debugSessionId
                }
            };

            // Create a wrapper file that will call the function with selected args
            const wrapperFile = await this.createWrapperFile(uri.fsPath, functionInfo, callArgs, useReanimation, debugSessionId);
            if (wrapperFile) {
                debugConfig.program = wrapperFile.fsPath;
                debugConfig.stopOnEntry = false; // We want to stop on the function entry, not the wrapper
            }

            // Start debugging
            const debugStarted = await vscode.debug.startDebugging(undefined, debugConfig);
            debugLog(`Debug session started: ${debugStarted}`);
            
            if (debugStarted) {
                debugLog(`Setting up monitoring for debug session: ${debugSessionId}`);
                // After a short delay, start monitoring for the function execution
                setTimeout(() => {
                    debugLog(`Starting monitoring for debug session: ${debugSessionId}`);
                    this.monitorForDebugExecution(debugSessionId, uri, functionInfo.name);
                }, 2000); // Wait 2 seconds for the debug session to initialize
            } else {
                debugLog(`Failed to start debug session`);
            }
            
            return debugStarted;
        } catch (error) {
            debugLog('Error starting debug session:', error);
            vscode.window.showErrorMessage(`Failed to start debug session: ${error}`);
            return false;
        }
    }


    /**
     * Start a debug session for a specific function
     */
    public async debugFunctionProgrammatically(
        uri: vscode.Uri,
        functionInfo: { name: string, params: string[] },
        paramValues: Map<string, string>,
        useReanimation: boolean = false,
        selectedFunctionCallId: string | number | null = null
    ): Promise<boolean> {
        try {
            // Reset selected call ID
            this.selectedFunctionCallId = selectedFunctionCallId;

            debugLog(`Starting debug session for function: ${functionInfo.name} in ${uri.fsPath}`);

            // Generate a unique session ID for this debug session
            const debugSessionId = `debug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.currentDebugSessionId = debugSessionId;
            this.currentDebugFunctionInfo = { uri, functionName: functionInfo.name };

            debugLog(`Generated debug session ID: ${debugSessionId}`);

            // Get Python extension
            const pythonExtension = vscode.extensions.getExtension('ms-python.python');
            if (!pythonExtension) {
                vscode.window.showErrorMessage('Python extension not found! Please install it first.');
                return false;
            }

            // Get Python execution details
            const executionDetails = await pythonExtension.exports.settings.getExecutionDetails();
            const pythonPath = executionDetails.execCommand[0];
            if (!pythonPath) {
                vscode.window.showErrorMessage('No Python executable found');
                return false;
            }

            // Create debug configuration
            const debugConfig: PyMonitorDebugConfig = {
                name: `Debug ${functionInfo.name}`,
                type: 'python',
                request: 'launch',
                program: uri.fsPath,
                pythonPath: pythonPath,
                args: [debugSessionId], // Pass the unique session ID
                console: 'integratedTerminal',
                stopOnEntry: true, // Stop at the first line of the function
                // Add an environment variable to indicate we want to debug a specific function
                env: {
                    'PYMONITOR_DEBUG_FUNCTION': functionInfo.name,
                    'PYMONITOR_DEBUG_MODE': 'true',
                    'PYMONITOR_SESSION_ID': debugSessionId
                }
            };
            const fInfo = { ...functionInfo, range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) }; // Dummy range for programmatic call
            // Create a wrapper file that will call the function with selected args
            const wrapperFile = await this.createWrapperFile(uri.fsPath, fInfo, paramValues, useReanimation, debugSessionId);
            if (wrapperFile) {
                debugConfig.program = wrapperFile.fsPath;
                debugConfig.stopOnEntry = false; // We want to stop on the function entry, not the wrapper
            }

            // Start debugging
            const debugStarted = await vscode.debug.startDebugging(undefined, debugConfig);
            debugLog(`Debug session started: ${debugStarted}`);

            if (debugStarted) {
                debugLog(`Setting up monitoring for debug session: ${debugSessionId}`);
                // After a short delay, start monitoring for the function execution
                setTimeout(() => {
                    debugLog(`Starting monitoring for debug session: ${debugSessionId}`);
                    this.monitorForDebugExecution(debugSessionId, uri, functionInfo.name);
                }, 2000); // Wait 2 seconds for the debug session to initialize
            } else {
                debugLog(`Failed to start debug session`);
            }

            return debugStarted;
        } catch (error) {
            debugLog('Error starting debug session:', error);
            vscode.window.showErrorMessage(`Failed to start debug session: ${error}`);
            return false;
        }
    }


    /**
     * Ensure a breakpoint exists at the start of the function
     */
    private async ensureBreakpointAtFunction(uri: vscode.Uri, functionInfo: FunctionInfo): Promise<void> {
        try {
            // Check if there's already a breakpoint at the function location
            const existingBreakpoints = vscode.debug.breakpoints;
            const functionStartLine = functionInfo.range.start.line;
            
            // Check if any breakpoint already exists at this location
            const breakpointExists = existingBreakpoints.some(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const location = bp.location;
                    return location.uri.toString() === uri.toString() && 
                           location.range.start.line === functionStartLine;
                }
                return false;
            });
            
            // If no breakpoint exists, add one
            if (!breakpointExists) {
                debugLog(`Adding breakpoint at start of function ${functionInfo.name} (line ${functionStartLine + 1})`);
                const breakpoint = new vscode.SourceBreakpoint(
                    new vscode.Location(
                        uri,
                        new vscode.Position(functionStartLine+1, 0)
                    )
                );
                vscode.debug.addBreakpoints([breakpoint]);
                
                // Inform the user
                vscode.window.showInformationMessage(
                    `Added breakpoint at the start of function ${functionInfo.name}`
                );
            } else {
                debugLog(`Breakpoint already exists at function ${functionInfo.name}`);
            }
        } catch (error) {
            debugLog('Error ensuring breakpoint at function:', error);
            vscode.window.showWarningMessage(
                `Could not add breakpoint at function ${functionInfo.name}: ${error}`
            );
        }
    }

    /**
     * Create default argument values based on parameter names
     */
    private getDefaultArgumentValues(params: string[]): Map<string, string> {
        const args = new Map<string, string>();
        
        for (const param of params) {
            // Create simple default values based on parameter names
            if (param.includes('path') || param.includes('file') || param.includes('name')) {
                args.set(param, `"example_${param}"`);
            } else if (param.includes('num') || param.includes('count') || param.includes('index')) {
                args.set(param, '0');
            } else if (param.includes('bool') || param.includes('flag') || param.includes('enable')) {
                args.set(param, 'True');
            } else if (param.includes('list') || param.includes('array')) {
                args.set(param, '[]');
            } else if (param.includes('dict') || param.includes('map') || param.includes('config')) {
                args.set(param, '{}');
            } else {
                args.set(param, 'None');
            }
        }
        
        return args;
    }

    /**
     * Get function call history from API to show as options
     */
    private async getFunctionCallHistory(filePath: string, functionName: string): Promise<Map<string, string> | null> {
        try {
            // Get function call history from API
            const functionCalls = await getFunctionData(filePath);
            
            if (!functionCalls || functionCalls.length === 0) {
                vscode.window.showInformationMessage('No previous function calls found in history.');
                return null;
            }

            // Filter to only include calls for the specific function
            const relevantCalls = functionCalls.filter(call => call.function === functionName);
            
            if (relevantCalls.length === 0) {
                vscode.window.showInformationMessage(`No previous calls found for function "${functionName}".`);
                return null;
            }

            // Create options with date and argument preview
            const callOptions = relevantCalls.map(call => {
                const date = new Date(call.start_time).toLocaleString();
                const argsPreview = Object.entries(call.locals || {})
                    .map(([name, data]) => `${name}=${data.value}`)
                    .join(', ').substring(0, 50) + (Object.keys(call.locals || {}).length > 2 ? '...' : '');
                
                return {
                    label: `${date}`,
                    description: argsPreview,
                    call: call
                };
            });

            // Let user select from call history
            const selectedCall = await vscode.window.showQuickPick(callOptions, {
                placeHolder: 'Select a previous function call to use its arguments',
                title: `Previous calls to ${functionName}()`
            });

            if (!selectedCall) {
                // User cancelled
                return null;
            }

            // Store the selected call ID for reanimation
            this.selectedFunctionCallId = selectedCall.call.id;
            
            // Convert the selected call's arguments to a Map
            const args = new Map<string, string>();
            
            for (const [name, data] of Object.entries(selectedCall.call.locals || {})) {
                let valueStr: string;
                
                // Format the value based on type
                if (typeof data.value === 'string') {
                    // Ensure strings are properly quoted
                    valueStr = JSON.stringify(data.value);
                } else if (data.type === 'list' || data.type === 'dict' || data.type === 'tuple') {
                    // Use the literal representation for collections
                    valueStr = data.value;
                } else {
                    // For other types, use the value directly
                    valueStr = data.value;
                }
                
                args.set(name, valueStr);
            }
            
            return args;
        } catch (error) {
            debugLog('Error getting function call history:', error);
            vscode.window.showErrorMessage('Failed to retrieve function call history');
            return null;
        }
    }

    /**
     * Prompt the user to enter values for each parameter
     */
    private async promptForArgumentValues(params: string[]): Promise<Map<string, string> | null> {
        const args = new Map<string, string>();
        
        // For each parameter, prompt the user to enter a value
        for (const param of params) {
            const defaultValue = this.getDefaultArgumentValues([param]).get(param) || 'None';
            
            const inputValue = await vscode.window.showInputBox({
                prompt: `Enter value for parameter "${param}"`,
                value: defaultValue,
                title: `Parameter: ${param}`,
                valueSelection: [0, defaultValue.length]
            });
            
            if (inputValue === undefined) {
                // User cancelled
                return null;
            }
            
            args.set(param, inputValue);
        }
        
        return args;
    }

    /**
     * Monitor for the appearance of the function execution from the debug session
     * and automatically open the webview when found
     */
    private async monitorForDebugExecution(sessionId: string, uri: vscode.Uri, functionName: string): Promise<void> {
        const maxAttempts = 30; // Maximum attempts (30 seconds with 1-second intervals)
        let attempts = 0;
        
        debugLog(`[MONITOR] Starting to monitor for debug execution: ${sessionId}, function: ${functionName}`);

        const checkForExecution = async () => {
            try {
                attempts++;
                debugLog(`[MONITOR] Checking for debug execution, attempt ${attempts}/${maxAttempts} for session: ${sessionId}`);

                // First, refresh the API data to ensure we get fresh sessions
                debugLog(`[MONITOR] Refreshing API data...`);
                const refreshSuccess = await refreshApiData();
                if (!refreshSuccess) {
                    debugLog(`[MONITOR] WARNING: Failed to refresh API data, continuing anyway...`);
                }

                // Now check if there's a session with our ID
                debugLog(`[MONITOR] Fetching sessions list...`);
                const sessions = await getSessionsList();
                if (!sessions) {
                    debugLog(`[MONITOR] FAILED to get sessions list`);
                    if (attempts < maxAttempts) {
                        setTimeout(checkForExecution, 1000);
                    } else {
                        debugLog(`[MONITOR] Giving up after ${maxAttempts} attempts - no sessions list`);
                    }
                    return;
                }

                debugLog(`[MONITOR] Retrieved ${sessions.length} sessions from API`);
                sessions.forEach((session, index) => {
                    debugLog(`[MONITOR] Session ${index}: name="${session.name}", id=${session.id}`);
                });

                // Look for our debug session
                const debugSession = sessions.find(session => 
                    session.name.includes(sessionId) || session.name.includes(`Debugger Session ${sessionId}`)
                );

                if (!debugSession) {
                    debugLog(`[MONITOR] Debug session not found yet: ${sessionId}`);
                    debugLog(`[MONITOR] Looking for sessions containing: "${sessionId}" or "Debugger Session ${sessionId}"`);
                    if (attempts < maxAttempts) {
                        setTimeout(checkForExecution, 1000);
                    } else {
                        debugLog(`[MONITOR] Giving up after ${maxAttempts} attempts - session not found`);
                    }
                    return;
                }

                debugLog(`[MONITOR] Found debug session: "${debugSession.name}" (ID: ${debugSession.id})`);

                // Get session details to find function executions
                debugLog(`[MONITOR] Fetching session details for session ID: ${debugSession.id}`);
                const sessionDetails = await getSessionDetails(debugSession.id);
                if (!sessionDetails) {
                    debugLog(`[MONITOR] FAILED to get session details for ID: ${debugSession.id}`);
                    if (attempts < maxAttempts) {
                        setTimeout(checkForExecution, 1000);
                    } else {
                        debugLog(`[MONITOR] Giving up after ${maxAttempts} attempts - no session details`);
                    }
                    return;
                }

                debugLog(`[MONITOR] Session details retrieved successfully`);

                // The session details now include full function_calls data, not just IDs
                const allFunctionCalls = (sessionDetails as any).function_calls || [];
                debugLog(`[MONITOR] Found ${allFunctionCalls.length} function calls in session`);

                if (allFunctionCalls.length === 0) {
                    debugLog(`[MONITOR] No function calls found yet in session`);
                    if (attempts < maxAttempts) {
                        setTimeout(checkForExecution, 1000);
                    } else {
                        debugLog(`[MONITOR] Giving up after ${maxAttempts} attempts - no function calls`);
                    }
                    return;
                }

                // Filter the function calls by function name (we already have full data)
                debugLog(`[MONITOR] Filtering function calls by function name: ${functionName}`);
                const functionExecutions = allFunctionCalls.filter((call: any) => {
                    debugLog(`[MONITOR] Checking function call: function="${call.function}", id=${call.id}`);
                    return call.function === functionName;
                });
                
                debugLog(`[MONITOR] Filtered to ${functionExecutions.length} matching function calls`);

                debugLog(`[MONITOR] Total matching function executions found: ${functionExecutions.length}`);

                if (functionExecutions.length === 0) {
                    debugLog(`[MONITOR] No function executions found yet for ${functionName}`);
                    if (attempts < maxAttempts) {
                        setTimeout(checkForExecution, 1000);
                    } else {
                        debugLog(`[MONITOR] Giving up after ${maxAttempts} attempts - no matching executions`);
                    }
                    return;
                }

                debugLog(`[MONITOR] SUCCESS! Found ${functionExecutions.length} function execution(s) for ${functionName}`);

                // Open the stack recording directly for the first/most recent function execution
                const context = (global as any).pymonitorExtensionContext;
                debugLog(`[MONITOR] Extension context available:`, !!context);
                
                if (context && functionExecutions.length > 0) {
                    const targetExecution = functionExecutions[0]; // Use the first execution
                    const functionId = targetExecution.id;
                    debugLog(`[MONITOR] Opening webview and navigating to stack recording for function execution ID: ${functionId}`);
                    
                    try {
                        // First create the webview panel with the function details
                        debugLog(`[MONITOR] Creating webview panel...`);
                        showFunctionDetails(functionExecutions, context);
                        
                        // Then immediately navigate to the stack recording view
                        debugLog(`[MONITOR] Navigating to stack recording...`);
                        // Use setTimeout to ensure the panel is created before navigating
                        setTimeout(async () => {
                            try {
                                await exploreStackTrace(functionId, context);
                                debugLog(`[MONITOR] Stack recording opened successfully for function ID: ${functionId}`);
                            } catch (error) {
                                debugLog(`[MONITOR] Error navigating to stack recording:`, error);
                            }
                        }, 100); // Small delay to ensure panel is ready
                        
                        vscode.window.showInformationMessage(
                            `Debug session started - opened stack recording for ${functionName} execution`
                        );
                    } catch (error) {
                        debugLog(`[MONITOR] Error opening webview:`, error);
                        vscode.window.showErrorMessage(
                            `Failed to open webview for ${functionName} execution: ${error}`
                        );
                    }
                } else {
                    debugLog(`[MONITOR] ERROR: Extension context not available or no executions found`);
                }

            } catch (error) {
                debugLog(`[MONITOR] EXCEPTION in checkForExecution:`, error);
                if (attempts < maxAttempts) {
                    setTimeout(checkForExecution, 1000);
                } else {
                    debugLog(`[MONITOR] Giving up after ${maxAttempts} attempts due to persistent errors`);
                }
            }
        };

        // Start checking
        debugLog(`[MONITOR] Starting execution check loop...`);
        checkForExecution();
    }

    /**
     * Create a temporary Python file that will import and call the target function
     */
    private async createWrapperFile(
        targetFile: string, 
        functionInfo: FunctionInfo, 
        argValues: Map<string, string>,
        useReanimation: boolean = false,
        sessionId?: string
    ): Promise<vscode.Uri | null> {
        try {
            // Get workspace folder
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetFile));
            if (!workspaceFolder) {
                return null;
            }

            // Create file content
            const modulePath = vscode.workspace.asRelativePath(targetFile, false);
            const moduleName = modulePath.replace(/\.[^/.]+$/, '').replace(/\//g, '.');
            
            let content = `# PyMonitor debug wrapper - temporary file\n`;
            content += `import sys\n`;
            content += `import os\n`;
            content += `import spacetimepy\n`;
            
            // Use the provided session ID or fallback to sys.argv[1]
            const sessionName = sessionId ? `"Debugger Session ${sessionId}"` : `f"Debugger Session {sys.argv[1]}"`;
            
            // If using reanimation, use the new spacetimepy.core.reanimation API
            if (useReanimation && this.selectedFunctionCallId) {
                content += `from spacetimepy.core.reanimation import execute_function_call, load_execution_data\n\n`;
                content += `from spacetimepy.interface.debugger import inject_do_jump, hotline\n\n`;
                content += `# Add workspace to Python path\n`;
                content += `sys.path.insert(0, "${workspaceFolder.uri.fsPath.replace(/\\/g, '\\\\')}")\n`;
                content += `db_path = os.path.join("${workspaceFolder.uri.fsPath.replace(/\\/g, '\\\\')}", "main.db")\n`;
                content += `monitor = spacetimepy.init_monitoring(db_path=db_path, in_memory=False)\n\n`;
                
                content += `# Use the new API for function execution replay\n`;
                content += `if __name__ == "__main__":\n`;
                content += `    spacetimepy.start_session(${sessionName})\n`;
                content += `    try:\n`;
                content += `        print(f"Starting reanimation for function execution ID: ${this.selectedFunctionCallId}")\n`;
                content += `        \n`;
                content += `        result = execute_function_call(\n`;
                content += `            function_execution_id="${this.selectedFunctionCallId}",\n`;
                content += `            db_path_or_session=db_path,\n`;
                content += `            import_path="${workspaceFolder.uri.fsPath.replace(/\\/g, '\\\\')}",\n`;
                content += `            enable_monitoring=True,\n`;
                content += `            reload_module=True,\n`;
                content += `            additional_decorators=[spacetimepy.interface.debugger.hotline,spacetimepy.line()]\n`;
                content += `        )\n`;
                content += `        \n`;
                content += `        print(f"Reanimation completed successfully with result: {result}")\n`;
                content += `        \n`;
                content += `    except Exception as e:\n`;
                content += `        print(f"Error during function reanimation: {e}")\n`;
                content += `        import traceback\n`;
                content += `        traceback.print_exc()\n`;
                content += `    spacetimepy.end_session()\n`;
            } else {
                // Standard approach with simplified script
                content += `from spacetimepy.interface.debugger import inject_do_jump, hotline\n\n`;
                content += `sys.path.insert(0, "${workspaceFolder.uri.fsPath.replace(/\\/g, '\\\\')}")\n`;
                content += `db_path = os.path.join("${workspaceFolder.uri.fsPath.replace(/\\/g, '\\\\')}", "main.db")\n`;
                content += `monitor = spacetimepy.init_monitoring(db_path=db_path, in_memory=False)\n`;
                content += `from ${moduleName} import ${functionInfo.name}\n`;
                content += `spacetimepy.interface.debugger.hotline(${functionInfo.name})\n`;
                content += `spacetimepy.line()(${functionInfo.name})\n\n`;

                content += `# Call the function\n`;
                content += `if __name__ == "__main__":\n`;
                content += `    spacetimepy.start_session(${sessionName})\n`;

                // Create a function call with the provided arguments
                const callArgs = functionInfo.params
                    .map(param => `${param}=${argValues.get(param) || 'None'}`)
                    .join(', ');
                
                if (callArgs) {
                    content += `    ${functionInfo.name}(${callArgs})\n`;
                } else {
                    content += `    ${functionInfo.name}()\n`;
                }
                content += `    spacetimepy.end_session()\n`;
            }
            
            // Create temporary file
            const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'pymonitor');
            await vscode.workspace.fs.createDirectory(tempDir);
            
            const tempFile = vscode.Uri.joinPath(tempDir, `debug_${functionInfo.name}_${sessionId || 'session'}.py`);
            await vscode.workspace.fs.writeFile(tempFile, Buffer.from(content, 'utf8'));
            
            return tempFile;
        } catch (error) {
            debugLog('Error creating wrapper file:', error);
            return null;
        }
    }

    /**
     * Step over (next) in the current debug session
     */
    public async stepOver(): Promise<boolean> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                vscode.window.showErrorMessage('No active debug session found');
                return false;
            }

            // Execute 'next' command on the active thread
            // Assuming thread ID 1, which is typically the main thread
            await activeSession.customRequest('next', { threadId: 1 });
            return true;
        } catch (error) {
            debugLog('Error executing step over command:', error);
            vscode.window.showErrorMessage(`Failed to execute step over: ${error}`);
            return false;
        }
    }

    /**
     * Evaluates an expression in the current debug context
     * @param expression The expression to evaluate
     * @param frameId Optional frame ID to evaluate in a specific stack frame
     * @param threadId Optional thread ID to evaluate in a specific thread
     * @returns The result of the evaluation or null if evaluation failed
     */
    public async evaluate(expression: string, frameId?: number, threadId?: number): Promise<any> {
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session');
                return null;
            }

            // Create the arguments for the evaluate request
            const args: any = {
                expression: expression,
                context: 'repl'
            };

            // Add frameId if provided
            if (frameId !== undefined) {
                args.frameId = frameId;
            } else {
                const stackTrace = await session.customRequest('stackTrace', { threadId: threadId || 1 });
                args.frameId = stackTrace.stackFrames[0].id;
            }

            // Add threadId if provided
            if (threadId !== undefined) {
                args.threadId = threadId;
            }

            // Log more detailed information about our request
            console.log('=== DAP Evaluate Request ===');
            console.log(`Session ID: ${session.id}`);
            console.log(`Session Type: ${session.type}`);
            console.log(`Expression: ${expression}`);
            console.log(`Frame ID: ${frameId !== undefined ? frameId : 'Not specified'}`);
            console.log(`Thread ID: ${threadId !== undefined ? threadId : 'Not specified'}`);
            console.log(`Arguments: ${JSON.stringify(args)}`);

            // Send the evaluate request to the debug adapter
            console.log(`Sending evaluate request to debug adapter...`);
            const response = await session.customRequest('evaluate', args);
            
            // Log detailed response info
            console.log('=== DAP Evaluate Response ===');
            console.log(`Result: ${response.result}`);
            console.log(`Type: ${response.type}`);
            console.log(`Presentation Hint: ${response.presentationHint}`);
            console.log(`Variables Reference: ${response.variablesReference}`);
            console.log(`Named Variables: ${response.namedVariables}`);
            console.log(`Indexed Variables: ${response.indexedVariables}`);
            console.log(`Memory Reference: ${response.memoryReference}`);
            console.log('Full Response:', response);
            
            return response;
        } catch (error) {
            console.error('=== DAP Evaluate Error ===');
            console.error(`Error evaluating expression: ${expression}`);
            console.error(`Error details:`, error);
            return null;
        }
    }

    public async hotswapLine(){
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session');
                return;
            }

            // Get the current stack trace
            const stackTrace = await session.customRequest('stackTrace', { threadId: 1 });
            if (!stackTrace || !stackTrace.stackFrames || stackTrace.stackFrames.length === 0) {
                console.log('No stack frames found');
                return;
            }

            // Get the current frame ID
            const frameId = stackTrace.stackFrames[0].id;

            // Send the hotswap request
            // hot swap is evaluate "_ahs_reload()", continue, and evaluate "_ahs_correct_jump()"
            const response1 = await session.customRequest('evaluate', { 
                expression: `_ahs_reload()`,
                frameId: frameId,
                threadId: 1,
                context: 'repl',
            });
            const response2 = await session.customRequest('continue', { 
                threadId: 1,
            });
            const response3 = await session.customRequest('evaluate', { 
                expression: `_ahs_correct_jump()`,
                frameId: frameId,
                threadId: 1,
                context: 'repl',
            });
            console.log('Hotswap response:', response1, response2, response3);
        } catch (error) {
            console.error('Error during hotswap:', error);
            vscode.window.showErrorMessage(`Failed to hotswap line: ${error}`);
        }
    }

    public async hotswapSpecificLine(inputLine: number){
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session');
                return;
            }

            // Get the current stack trace
            const stackTrace = await session.customRequest('stackTrace', { threadId: 1 });
            if (!stackTrace || !stackTrace.stackFrames || stackTrace.stackFrames.length === 0) {
                console.log('No stack frames found');
                return;
            }

            // Get the current frame ID
            const frameId = stackTrace.stackFrames[0].id;

            // Send the hotswap request
            // hot swap is evaluate "_ahs_reload()", continue, and evaluate "_ahs_correct_jump()"
            const response1 = await session.customRequest('evaluate', { 
                expression: `_ahs_reload(${inputLine})`,
                frameId: frameId,
                threadId: 1,
                context: 'repl',
            });
            const response2 = await session.customRequest('continue', { 
                threadId: 1,
            });
            const response3 = await session.customRequest('evaluate', { 
                expression: `_ahs_correct_jump()`,
                frameId: frameId,
                threadId: 1,
                context: 'repl',
            });
            console.log('Hotswap response:', response1, response2, response3);
        } catch (error) {
            console.error('Error during hotswap:', error);
            vscode.window.showErrorMessage(`Failed to hotswap line: ${error}`);
        }
    }

    /**
     * Loads a specific snapshot state during a debug session
     * Uses the Debug Adapter Protocol and spacetimepy.core.reanimation tools
     * 
     * @param snapshotId The ID of the snapshot to load
     * @param dbPath Path to the database file
     * @param frameId Optional frame ID to evaluate in a specific stack frame
     * @returns True if successful, false otherwise
     */
    public async goToSnapshot(snapshotId: number, dbPath: string, frameId?: number): Promise<boolean> {
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session found');
                vscode.window.showErrorMessage('No active debug session found. Please start debugging first.');
                return false;
            }

            console.log(`=== Loading Snapshot State ===`);
            console.log(`Snapshot ID: ${snapshotId}`);
            console.log(`DB Path: ${dbPath}`);
            
            // Get basic thread info - but don't fail if we can't get frame details
            let threadId: number | undefined;
            try {
                const threadsResponse = await session.customRequest('threads');
                if (threadsResponse.threads && threadsResponse.threads.length > 0) {
                    threadId = threadsResponse.threads[0].id;
                    console.log(`Using thread ID: ${threadId}`);
                }
            } catch (error) {
                console.log('Could not get thread info, will try without it:', error);
            }
            
            // Use the direct load_snapshot_in_frame function - simplest approach!
            console.log(`Loading snapshot ${snapshotId} using load_snapshot_in_frame...`);
            const loadSnapshotCommand = `import spacetimepy; spacetimepy.load_snapshot_in_frame(${snapshotId}, "${dbPath}")`;
            
            try {
                console.log('Executing snapshot loading command...');
                const response = await this.evaluate(loadSnapshotCommand, frameId, threadId);
                console.log('Snapshot loading response:', response);
            } catch (evalError) {
                console.error('Error during evaluation:', evalError);
                vscode.window.showErrorMessage(`Error executing snapshot load: ${evalError}`);
                return false;
            }

            // Use gotoLine to move to the line of the snapshot
        } catch (error) {
            console.error('Error in goToSnapshot:', error);
            vscode.window.showErrorMessage(`Failed to load snapshot: ${error}`);
            return false;
        }
        return true;
    }

    /**
     * Gets valid goto targets for a specific line
     * @param line The source line number (1-based)
     * @param source Optional source information, if omitted will use the active editor
     * @param threadId Optional thread ID
     * @returns Array of GotoTarget objects or null if operation failed
     */
    public async getGotoTargets(line: number, source?: vscode.Uri, threadId?: number): Promise<any[] | null> {
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session');
                return null;
            }
            
            // If no source provided, try to get it from active editor
            if (!source) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    console.error('No active editor found to get source for goto targets');
                    return null;
                }
                source = editor.document.uri;
            }
            
            console.log(`=== DAP GotoTargets Request ===`);
            console.log(`Source: ${source.toString()}`);
            console.log(`Line: ${line}`);
            
            // Create args for the gotoTargets request
            const gotoTargetsArgs = {
                source: {
                    path: source.fsPath
                },
                line: line
            };
            
            console.log(`Sending gotoTargets request with args: ${JSON.stringify(gotoTargetsArgs)}`);
            
            // Send the gotoTargets request
            const response = await session.customRequest('gotoTargets', gotoTargetsArgs);
            
            console.log('=== DAP GotoTargets Response ===');
            console.log('Full Response:', response);
            
            if (response && response.targets && response.targets.length > 0) {
                console.log(`Found ${response.targets.length} goto targets for line ${line}`);
                return response.targets;
            } else {
                console.log(`No goto targets found for line ${line}`);
                return [];
            }
        } catch (error) {
            console.error('=== DAP GotoTargets Error ===');
            console.error(`Error getting goto targets for line: ${line}`);
            console.error(`Error details:`, error);
            return null;
        }
    }

    /**
     * Navigates to a specific line in the current debug session
     * @param targetLine The line number to navigate to (1-based)
     * @param threadId Optional thread ID (defaults to using the first available thread)
     * @returns True if successful, false otherwise
     */
    public async gotoLine(targetLine: number, threadId?: number): Promise<boolean> {
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session');
                vscode.window.showErrorMessage('No active debug session found');
                return false;
            }
            
            console.log(`=== DAP Goto Line Debug Info ===`);
            console.log(`Target line: ${targetLine}`);
            console.log(`Thread ID provided: ${threadId !== undefined ? threadId : 'Not specified'}`);
            
            // Get the thread ID if not provided
            if (threadId === undefined) {
                try {
                    console.log('Requesting thread information for goto...');
                    const threadsResponse = await session.customRequest('threads');
                    console.log('Threads response:', threadsResponse);
                    
                    if (threadsResponse.threads && threadsResponse.threads.length > 0) {
                        // Use the first thread - typically the main thread
                        threadId = threadsResponse.threads[0].id;
                        console.log(`Using thread ID: ${threadId} for goto request`);
                    } else {
                        vscode.window.showErrorMessage('No threads found for goto operation');
                        return false;
                    }
                } catch (error) {
                    console.error('Error getting thread information for goto:', error);
                    vscode.window.showErrorMessage(`Error getting thread information: ${error}`);
                    return false;
                }
            }
            
            // First request valid goto targets for the line
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return false;
            }
            
            const targets = await this.getGotoTargets(targetLine, editor.document.uri);
            if (!targets || targets.length === 0) {
                vscode.window.showErrorMessage(`No valid goto targets found for line ${targetLine}`);
                return false;
            }
            
            // Use the first available target
            const targetId = targets[0].id;
            console.log(`Using target ID: ${targetId} for goto request`);
            
            // Create the goto request arguments
            const gotoArgs = {
                threadId: threadId,
                targetId: targetId
            };
            
            console.log(`Sending goto request with args: ${JSON.stringify(gotoArgs)}`);
            
            // Send the goto request to the debug adapter
            const response = await session.customRequest('goto', gotoArgs);
            
            // Log detailed response info
            console.log('=== DAP Goto Response ===');
            console.log('Full Response:', response);
            
            vscode.window.showInformationMessage(`Navigated to line ${targetLine}`);
            return true;
        } catch (error) {
            console.error('=== DAP Goto Error ===');
            console.error(`Error navigating to line: ${targetLine}`);
            console.error(`Error details:`, error);
            vscode.window.showErrorMessage(`Failed to navigate to line ${targetLine}: ${error}`);
            return false;
        }
    }

    /**
     * Navigates to a specific line and loads a snapshot state in one operation
     * Useful for snapshot-based debugging where you want to move to a specific line
     * and restore the state at that point.
     * 
     * @param targetLine The line number to navigate to (1-based)
     * @param snapshotId The ID of the snapshot to load
     * @param dbPath Path to the database file
     * @returns True if successful, false otherwise
     */
    public async gotoLineAndLoadState(targetLine: number, snapshotId: number, dbPath: string): Promise<boolean> {
        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                console.log('No active debug session');
                vscode.window.showErrorMessage('No active debug session found');
                return false;
            }
            
            console.log(`=== DAP Goto Line and Load State ===`);
            console.log(`Target line: ${targetLine}`);
            console.log(`Snapshot ID: ${snapshotId}`);
            console.log(`DB Path: ${dbPath}`);
            
            // Get the active editor
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return false;
            }
            
            // First, get thread information
            let threadId: number | undefined;
            try {
                console.log('Requesting thread information...');
                const threadsResponse = await session.customRequest('threads');
                console.log('Threads response:', threadsResponse);
                
                if (threadsResponse.threads && threadsResponse.threads.length > 0) {
                    // Use the first thread - typically the main thread
                    threadId = threadsResponse.threads[0].id;
                    console.log(`Using thread ID: ${threadId}`);
                } else {
                    vscode.window.showErrorMessage('No threads found for operation');
                    return false;
                }
            } catch (error) {
                console.error('Error getting thread information:', error);
                vscode.window.showErrorMessage(`Error getting thread information: ${error}`);
                return false;
            }
            
            // Get goto targets for the line
            console.log(`Getting goto targets for line ${targetLine}...`);
            const targets = await this.getGotoTargets(targetLine, editor.document.uri);
            if (!targets || targets.length === 0) {
                vscode.window.showErrorMessage(`No valid goto targets found for line ${targetLine}`);
                return false;
            }
            
            // Use the first available target
            const targetId = targets[0].id;
            console.log(`Using target ID: ${targetId} for goto request`);
            
            // First, navigate to the target line
            console.log(`Step 1: Navigating to line ${targetLine} with target ID ${targetId}`);
            try {
                const gotoArgs = {
                    threadId: threadId,
                    targetId: targetId
                };
                
                console.log(`Sending goto request with args: ${JSON.stringify(gotoArgs)}`);
                const gotoResponse = await session.customRequest('goto', gotoArgs);
                console.log(`Goto response:`, gotoResponse);
            } catch (error) {
                console.error('Failed to navigate to line:', error);
                vscode.window.showErrorMessage(`Failed to navigate to line ${targetLine}: ${error}`);
                return false;
            }
            
            // Then, load the snapshot state
            console.log(`Step 2: Loading snapshot state ${snapshotId}`);
            const stateResult = await this.goToSnapshot(snapshotId, dbPath);
            if (!stateResult) {
                console.error('Failed to load state');
                return false;
            }
            
            console.log('Successfully navigated to line and loaded state');
            vscode.window.showInformationMessage(`Navigated to line ${targetLine} and loaded snapshot #${snapshotId}`);
            return true;
        } catch (error) {
            console.error('=== DAP Goto and Load State Error ===');
            console.error(`Error details:`, error);
            vscode.window.showErrorMessage(`Failed to navigate and load state: ${error}`);
            return false;
        }
    }
} 