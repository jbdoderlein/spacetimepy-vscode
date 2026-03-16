// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { FunctionData } from './types';
import { getFunctionData, waitForServer, getStackTrace, refreshApiData } from './services/api';
import { showFunctionDetails as showFunctionDetailsInWebview, exploreStackTrace } from './services/webview';
import { PyMonitorCodeLensProvider } from './services/codeLens';
import { state, debugLog } from './services/state';
import { ConfigService } from './services/config';
import { DebugFunctionCodeLensProvider } from './services/debugCodeLens';
import { DebuggerService } from './services/debugger';
import { GraphWebviewProvider } from './providers/graphWebviewProvider';
import { updateGraphData } from './services/graph';
import { NodeDependenciesProvider, LineInfo } from './providers/testProvider';

const execAsync = promisify(exec);
const config = ConfigService.getInstance();

let webServerProcess: ChildProcess | null = null;
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let debugPollingInterval: NodeJS.Timeout | null = null;

// Add a flag to track programmatic selection changes, export it for use in highlight.ts
export let isProgrammaticSelectionChange = false;

async function checkPythonEnvironment(): Promise<boolean> {
	try {
		const pythonExtension = vscode.extensions.getExtension('ms-python.python');
		if (!pythonExtension) {
			vscode.window.showErrorMessage('Python extension not found! Please install it first.');
			return false;
		}

		const executionDetails = await pythonExtension.exports.settings.getExecutionDetails();
		const pythonPath = executionDetails.execCommand[0];
		if (!pythonPath) {
			vscode.window.showErrorMessage('No Python executable found');
			return false;
		}

		// Check if Python is installed and accessible
		try {
			await execAsync(`${pythonPath} --version`);
		} catch (error) {
			vscode.window.showErrorMessage('Python is not accessible. Please check your Python installation.');
			return false;
		}

		return true;
	} catch (error) {
		console.error('Error checking Python environment:', error);
		vscode.window.showErrorMessage('Failed to check Python environment');
		return false;
	}
}

async function startWebServer(pythonPath: string, workspaceRoot: string): Promise<void> {
	try {
		// Kill existing server if any
		if (webServerProcess) {
			webServerProcess.kill();
			webServerProcess = null;
		}

		// Check if main.db exists
		const dbPath = path.join(workspaceRoot, 'main.db');
		if (!fs.existsSync(dbPath)) {
			vscode.window.showErrorMessage('No main.db found in workspace root');
			console.log('No main.db found in workspace root');
			return;
		}

		// Start the web server in the background
		// spacetimepy.interface.web.explorer main.db --mode api
		const command = `${pythonPath} -m spacetimepy.interface.web.explorer ${dbPath} --mode api`;
		console.log('Starting server with command:', command);

		webServerProcess = exec(command, { cwd: workspaceRoot });

		// Capture and log server output
		webServerProcess.stdout?.on('data', (data) => {
			console.log('Server stdout:', data.toString());
		});

		webServerProcess.stderr?.on('data', (data) => {
			console.error('Server stderr:', data.toString());
		});

		webServerProcess.unref(); // This makes the process run independently

		// Wait for server to be ready
		const serverReady = await waitForServer();
		if (!serverReady) {
			throw new Error('Server failed to start within timeout');
		}

		// Update status bar
		statusBarItem.text = "$(radio-tower) PyMonitor Server Running";
		statusBarItem.tooltip = "PyMonitor Web Server is running";
		statusBarItem.show();

		console.log('Web server started and ready');
	} catch (error) {
		console.error('Error starting web server:', error);
		statusBarItem.text = "$(error) PyMonitor Server Error";
		statusBarItem.tooltip = "Error starting PyMonitor server";
		statusBarItem.show();
	}
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('PyMonitor extension is now active!');

	// Store extension context for accessing resources
	extensionContext = context;
	// Store context globally so it can be accessed by other services
	(global as any).pymonitorExtensionContext = context;

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'pymonitor.restartServer';

	// Add Debug Adapter Tracker to log DAP communication and handle stepping
	vscode.debug.registerDebugAdapterTrackerFactory('*', {
		createDebugAdapterTracker(session: vscode.DebugSession) {
			return {
				onWillReceiveMessage: async m => { if (m["command"] === "stackTrace"){await updateStackRecordingIfDebugging(); }},
				//onDidSendMessage: m => console.log(`< ${JSON.stringify(m, undefined, 2)}`)
			};
		}
	});
	//context.subscriptions.push(debugTrackerFactory);

	// Register commands
	const checkCommand = vscode.commands.registerCommand('pymonitor.checkPython', checkPythonEnvironment);
	const restartCommand = vscode.commands.registerCommand('pymonitor.restartServer', async () => {
		console.log('Restart server command triggered');
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('No workspace folder found');
			return;
		}

		const pythonExtension = vscode.extensions.getExtension('ms-python.python');
		if (!pythonExtension) {
			vscode.window.showErrorMessage('Python extension not found!');
			return;
		}

		const executionDetails = await pythonExtension.exports.settings.getExecutionDetails();
		const pythonPath = executionDetails.execCommand[0];
		if (!pythonPath) {
			vscode.window.showErrorMessage('No Python executable found');
			return;
		}

		await startWebServer(pythonPath, workspaceRoot);
	});

	const showFunctionDetailsCommand = vscode.commands.registerCommand('pymonitor.showFunctionDetails', (functions: FunctionData[]) => {
		showFunctionDetailsInWebview(functions, context);
	});

	// Register code lens providers
	const codeLensProvider = new PyMonitorCodeLensProvider();
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider));

	// Register debug code lens provider
	const debugCodeLensProvider = new DebugFunctionCodeLensProvider();
	context.subscriptions.push(vscode.languages.registerCodeLensProvider(
		{ scheme: 'file', language: 'python' },
		debugCodeLensProvider
	));


	// Debug function command
	const debugFunctionCommand = vscode.commands.registerCommand('pymonitor.debugFunction', async (uri: vscode.Uri, functionInfo: any) => {
		const debugService = DebuggerService.getInstance();
		await debugService.debugFunction(uri, functionInfo);
	});

	// Register the step over (next) command
	const stepOverCommand = vscode.commands.registerCommand('pymonitor.stepOver', async () => {
		const debugService = DebuggerService.getInstance();
		await debugService.stepOver();
	});

	// Register the step over (next) command
	const hotswapLineCommand = vscode.commands.registerCommand('pymonitor.hotswapLine', async () => {
		const debugService = DebuggerService.getInstance();
		await debugService.hotswapLine();
	});

	// Register the evaluate command
	const evaluateCommand = vscode.commands.registerCommand('pymonitor.evaluate', async () => {
		// Get the input from the user
		const expression = await vscode.window.showInputBox({
			prompt: 'Enter expression to evaluate in debug context',
			placeHolder: 'e.g., x + 1, print("hello"), locals()'
		});

		if (expression) {
			const debugService = DebuggerService.getInstance();
			const result = await debugService.evaluate(expression);

			if (result) {
				// Show the result in a notification
				vscode.window.showInformationMessage(`Evaluation result: ${result.result}`);
				return result;
			} else {
				vscode.window.showErrorMessage('Failed to evaluate expression');
			}
		}
		return null;
	});

	// Register the "Go to Snapshot State" command
	const goToSnapshotStateCommand = vscode.commands.registerCommand('pymonitor.goToSnapshotState', async (snapshotId: number, dbPath: string) => {
		if (snapshotId === undefined || !dbPath) {
			console.error('Missing required parameters for goToSnapshotState command');
			vscode.window.showErrorMessage('Missing snapshot information');
			return false;
		}

		console.log(`Command triggered: Go to snapshot state #${snapshotId}`);
		const debugService = DebuggerService.getInstance();
		return await debugService.goToSnapshot(snapshotId, dbPath);
	});

	// Register the "Go to Line" command
	const gotoLineCommand = vscode.commands.registerCommand('pymonitor.gotoLine', async () => {
		const debugService = DebuggerService.getInstance();

		// Check if there's an active debug session
		if (!vscode.debug.activeDebugSession) {
			vscode.window.showErrorMessage('No active debug session found');
			return;
		}

		// Get the active editor
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor found');
			return;
		}

		// First get input from user for the line
		const lineInput = await vscode.window.showInputBox({
			prompt: 'Enter line number to find goto targets',
			placeHolder: 'e.g., 42',
			validateInput: input => {
				const lineNumber = parseInt(input);
				return isNaN(lineNumber) || lineNumber <= 0 ? 'Please enter a positive number' : null;
			}
		});

		if (!lineInput) {
			return; // User cancelled
		}

		const lineNumber = parseInt(lineInput);

		// Get the goto targets for the line
		const targets = await debugService.getGotoTargets(lineNumber, editor.document.uri);

		if (!targets || targets.length === 0) {
			vscode.window.showErrorMessage(`No valid goto targets found for line ${lineNumber}`);
			return;
		}

		// If there's only one target, use it directly
		if (targets.length === 1) {
			await debugService.gotoLine(lineNumber);
			return;
		}

		// If there are multiple targets, show a quick pick
		const targetItems = targets.map(target => ({
			label: `Line ${target.line}: ${target.label || 'Target'}`,
			description: target.instructionPointerReference || `ID: ${target.id}`,
			target: target
		}));

		const selectedTarget = await vscode.window.showQuickPick(targetItems, {
			placeHolder: 'Select a goto target'
		});

		if (selectedTarget) {
			// Create custom goto request with the selected target ID
			const threadId = (await vscode.debug.activeDebugSession.customRequest('threads'))
				.threads[0].id;

			const gotoArgs = {
				threadId: threadId,
				targetId: selectedTarget.target.id
			};

			console.log(`Sending direct goto request with args: ${JSON.stringify(gotoArgs)}`);

			try {
				const response = await vscode.debug.activeDebugSession.customRequest('goto', gotoArgs);
				console.log('Goto response:', response);
				vscode.window.showInformationMessage(`Navigated to ${selectedTarget.label}`);
			} catch (error) {
				console.error('Error in goto request:', error);
				vscode.window.showErrorMessage(`Failed to navigate: ${error}`);
			}
		}
	});

	// Register the combined "Go to Line and Load State" command
	const gotoLineAndLoadStateCommand = vscode.commands.registerCommand('pymonitor.gotoLineAndLoadState',
		async (targetLine: number, snapshotId: number, dbPath: string) => {
			if (targetLine === undefined || snapshotId === undefined || !dbPath) {
				console.error('Missing required parameters for gotoLineAndLoadState command');
				vscode.window.showErrorMessage('Missing required information for navigation');
				return false;
			}

			console.log(`Command triggered: Go to line ${targetLine} and load snapshot ${snapshotId}`);
			const debugService = DebuggerService.getInstance();
			return await debugService.gotoLineAndLoadState(targetLine, snapshotId, dbPath);
		}
	);

	context.subscriptions.push(debugFunctionCommand);
	context.subscriptions.push(stepOverCommand);
	context.subscriptions.push(evaluateCommand);
	context.subscriptions.push(goToSnapshotStateCommand);
	context.subscriptions.push(gotoLineCommand);
	context.subscriptions.push(gotoLineAndLoadStateCommand);

	// Track debugging session and update stack recording view
	const debugStartListener = vscode.debug.onDidStartDebugSession(async (session) => {
		console.log('[PyMonitor] Debug session started:', session.type);

		// Start polling for updates when debugging Python
		if (session.type === 'python') {
			console.log('[PyMonitor] Starting debug polling for stack recording updates');
			if (debugPollingInterval) {
				clearInterval(debugPollingInterval);
			}
			// Poll every 2 seconds while debugging
			// debugPollingInterval = setInterval(async () => {
			//	await updateStackRecordingIfDebugging();
			// }, 10000);
		}

		// Notify webview about debug session status
		if (state.functionDetailsPanel && state.isInStackTraceView) {
			state.functionDetailsPanel.webview.postMessage({
				command: 'debugSessionStatus',
				isDebugging: true
			});
		}
	});

	// This is an important event that fires when stepping, continuing, etc.
	const activeDebugSessionChange = vscode.debug.onDidChangeActiveDebugSession(async (session) => {
		console.log('[PyMonitor] Active debug session changed:', session?.type);

		// Notify webview about debug session status
		if (state.functionDetailsPanel && state.isInStackTraceView) {
			state.functionDetailsPanel.webview.postMessage({
				command: 'debugSessionStatus',
				isDebugging: !!session
			});
		}

		if (session?.type === 'python') {
			console.log('[PyMonitor] Python session change - updating stack recording');
			await updateStackRecordingIfDebugging();
		}
	});

	// Listen for debug session end
	const debugEndListener = vscode.debug.onDidTerminateDebugSession(async (session) => {
		console.log('[PyMonitor] Debug session ended:', session.type);

		// Stop polling when Python debugging ends
		if (session.type === 'python' && debugPollingInterval) {
			console.log('[PyMonitor] Stopping debug polling');
			clearInterval(debugPollingInterval);
			debugPollingInterval = null;
		}

		// Notify webview about debug session status
		if (state.functionDetailsPanel && state.isInStackTraceView) {
			state.functionDetailsPanel.webview.postMessage({
				command: 'debugSessionStatus',
				isDebugging: false
			});
		}
	});

	// This triggers on breakpoint hits and step operations
	const debugSessionStateChange = vscode.debug.onDidChangeBreakpoints(async () => {
		console.log('[PyMonitor] Breakpoints changed - triggering stack recording update');
		await updateStackRecordingIfDebugging();
	});

	// Listen for debug events, particularly stepping and execution
	const debugStepListener = vscode.debug.onDidReceiveDebugSessionCustomEvent(async (event) => {
		console.log(`[PyMonitor] Debug event received: ${event.event}`, event.body);
		if (event.event.startsWith('step') ||
			event.event === 'continue' ||
			event.event === 'stopOnEntry' ||
			event.event === 'breakpoint') {
			console.log(`[PyMonitor] Event ${event.event} matches update criteria - updating stack recording`);
			await updateStackRecordingIfDebugging();
		} else {
			console.log(`[PyMonitor] Event ${event.event} doesn't match criteria - no update`);
		}
	});

	// Update when a thread stops - this is the ideal time to open the stack recording
	// for the first time as we know the debugger has hit a breakpoint
	const threadStopped = vscode.debug.onDidReceiveDebugSessionCustomEvent(async (event) => {
		if (event.event === 'stopped') {
			console.log('Thread stopped, reason:', event.body?.reason);

			// This is the ideal time to open the stack recording initially
			// as we know the debugger has hit a breakpoint or stopped somewhere
			if (event.body?.reason === 'breakpoint' || event.body?.reason === 'entry') {
				console.log('Opening stack recording after breakpoint/entry hit');
				await tryOpenStackRecordingForActiveFunction();
			}

			await updateStackRecordingIfDebugging();
		}
	});

	// This function will try to identify and open the stack recording for the function
	// being debugged, but only if we're not already showing a stack recording
	async function tryOpenStackRecordingForActiveFunction() {
		// Only do this if we're not already showing a stack recording
		if (state.isInStackTraceView) {
			return;
		}

		// Get the current file
		const editor = vscode.window.activeTextEditor;
		if (!editor) {return;}

		const filePath = editor.document.fileName;
		console.log(`Looking for function data for ${filePath}`);

		// Get the most recent function execution data - should correspond to active debugging
		try {
			// Fetch fresh data from the API
			const functions = await getFunctionData(filePath);
			if (!functions || functions.length === 0) {
				console.log('No function data found');
				return;
			}

			// Store in state and update cache
			state.currentFunctionData = functions;
			state.functionDataCache.set(filePath, functions);

			// Look for the most recent function call (should be the one being debugged)
			const latestFunction = functions.sort((a, b) =>
				new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
			)[0];

			console.log('Latest function call found:', latestFunction.id);

			// Open the stack recording view for this function
			await vscode.commands.executeCommand('pymonitor.openStackRecording', latestFunction.id);
		} catch (err) {
			console.error('Failed to open stack recording view:', err);
		}
	}

	// Helper function to update stack recording view if debugging is active
	async function updateStackRecordingIfDebugging() {
		// Check if debugging is active
		if (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.type !== 'python') {
			console.log('[PyMonitor] updateStackRecordingIfDebugging: No active Python debug session');
			return;
		}

		// Only update if we're in stack trace view
		if (!state.isInStackTraceView || !state.currentStackTraceData || !state.functionDetailsPanel) {
			console.log(`[PyMonitor] updateStackRecordingIfDebugging: Not in stack trace view or missing data - isInStackTraceView: ${state.isInStackTraceView}, hasStackTraceData: ${!!state.currentStackTraceData}, hasPanel: ${!!state.functionDetailsPanel}`);
			return;
		}

		console.log('[PyMonitor] Updating stack recording during debugging');

		// Get the function ID from the current stack trace data
		const functionId = state.currentStackTraceData.function.id;
		if (!functionId) {
			console.log('No function ID found in current stack trace data');
			return;
		}

		console.log(`Refreshing stack recording for function ID: ${functionId}`);

		// Fetch fresh data directly from API without caching
		try {
			// First, refresh the API data to ensure we get the latest
			console.log('[PyMonitor] Auto-refreshing API data due to debug activity...');
			const refreshSuccess = await refreshApiData();
			if (!refreshSuccess) {
				console.log('[PyMonitor] WARNING: Failed to refresh API data during debug activity, continuing anyway...');
			} else {
				console.log('[PyMonitor] API data refreshed successfully');
			}

			// Bypass command and call API directly to avoid any caching
			console.log(`[PyMonitor] Fetching fresh stack trace data for function ID: ${functionId}`);
			const freshData = await getStackTrace(functionId);
			if (!freshData) {
				console.log('[PyMonitor] No updated stack recording data found');
				return;
			}

			console.log(`[PyMonitor] Received fresh data with ${freshData.frames.length} frames`);

			// Always update state with fresh data
			state.currentStackTraceData = freshData;

			// Refresh the tree view  by calling omniscientDebugPanel.refreshEntry
			vscode.commands.executeCommand('omniscientDebugPanel.refreshEntry');

			// Send updated data to webview directly
			if (state.functionDetailsPanel) {
				console.log('[PyMonitor] Sending updated data to webview...');
				state.functionDetailsPanel.webview.postMessage({
					command: 'updateStackTrace',
					data: freshData,
					snapshots: freshData.frames
				});
				console.log(`[PyMonitor] Auto-refreshed and sent fresh data with ${freshData.frames.length} frames to webview`);
			} else {
				console.log('[PyMonitor] No webview panel available to send data to');
			}
		} catch (err) {
			console.error('Failed to update stack recording:', err);
		}

		// update the graph view if available
		if (state.graphWebviewProvider) {
			console.log('[PyMonitor] Updating graph data for function ID:', functionId);
			updateGraphData(functionId.toString());
		}
	}

	// Open stack recording view command
	const openStackRecordingCommand = vscode.commands.registerCommand('pymonitor.openStackRecording', async (functionId) => {
		try {
			if (!functionId) {
				console.error('No function ID provided to openStackRecording');
				return;
			}

			console.log(`Opening stack recording for function ID: ${functionId}`);

			// Use the exploreStackTrace function to open the view
			await exploreStackTrace(functionId, extensionContext);
			return true;
		} catch (error) {
			console.error('Error opening stack recording:', error);
			return false;
		}
	});

	// Refresh stack recording data command - simplified to bypass caching
	const refreshStackRecordingCommand = vscode.commands.registerCommand('pymonitor.refreshStackRecording', async (functionId) => {
		try {
			if (!functionId || !state.functionDetailsPanel) {
				return null;
			}

			console.log(`Directly refreshing stack recording for function ID: ${functionId}`);

			// Fetch fresh data from API without caching
			const data = await getStackTrace(functionId);
			if (!data) {
				console.log('No updated stack recording data found');
				return null;
			}

			console.log(`Received fresh data with ${data.frames.length} frames`);

			// Update state
			state.currentStackTraceData = data;

			// Send updated data to webview
			state.functionDetailsPanel.webview.postMessage({
				command: 'updateStackTrace',
				data: data,
				snapshots: data.frames
			});

			return data;
		} catch (error) {
			console.error('Error refreshing stack recording:', error);
			return null;
		}
	});

	context.subscriptions.push(debugStartListener);
	context.subscriptions.push(activeDebugSessionChange);
	context.subscriptions.push(debugSessionStateChange);
	context.subscriptions.push(debugStepListener);
	context.subscriptions.push(threadStopped);
	context.subscriptions.push(debugEndListener);
	context.subscriptions.push(openStackRecordingCommand);
	context.subscriptions.push(refreshStackRecordingCommand);

	// Register a document change event listener for Python files
	const documentListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
		if (document.languageId === 'python') {
			console.log(`Python file opened: ${document.fileName}`);

			// Check if server is running
			const serverReady = await waitForServer();
			if (!serverReady) {
				vscode.window.showErrorMessage('PyMonitor server is not running. Please start it using the "PyMonitor: Restart Server" command.');
				return;
			}

			const functionData = await getFunctionData(document.fileName);
			if (functionData) {
				console.log('Function data for file:', functionData);
				state.functionDataCache.set(document.fileName, functionData);
				codeLensProvider.refresh();
			}

			// Refresh debug code lenses
			debugCodeLensProvider.refresh();
		}
	});

	// Add this line to track editor changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				state.currentEditor = editor;
			}
		})
	);

	// Update the click handler to only send messages to panel
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(event => {
			// Skip programmatic selection changes (from highlighting)
			if (state.isProgrammaticSelectionChange) {
				return;
			}

			if (event.textEditor === state.currentEditor &&
				event.selections.length > 0 &&
				state.isInStackTraceView) {
				const line = event.selections[0].active.line + 1;
				debugLog('Editor line clicked:', line);

				// Send line click to panel, let it handle the logic
				if (state.functionDetailsPanel) {
					state.functionDetailsPanel.webview.postMessage({
						command: 'editorLineClick',
						line: line
					});
				}
			}
		})
	);

	// Initial setup - start server once when extension is activated
	const envReady = await checkPythonEnvironment();
	if (!envReady) {
		vscode.window.showErrorMessage('Failed to initialize PyMonitor. Check the output panel for details.');
	} else {
		// Get workspace root and Python path
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('No workspace folder found');
			return;
		}

		const pythonExtension = vscode.extensions.getExtension('ms-python.python');
		if (!pythonExtension) {
			vscode.window.showErrorMessage('Python extension not found!');
			return;
		}

		const executionDetails = await pythonExtension.exports.settings.getExecutionDetails();
		const pythonPath = executionDetails.execCommand[0];
		if (!pythonPath) {
			vscode.window.showErrorMessage('No Python executable found');
			return;
		}

		// Start the server
		await startWebServer(pythonPath, workspaceRoot);

		// Load function data for all already opened Python files
		const openDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'python');
		for (const doc of openDocuments) {
			console.log(`Loading data for already opened file: ${doc.fileName}`);
			const functionData = await getFunctionData(doc.fileName);
			if (functionData) {
				state.functionDataCache.set(doc.fileName, functionData);
			}
		}
		codeLensProvider.refresh();
	}

	context.subscriptions.push(checkCommand, restartCommand, showFunctionDetailsCommand, documentListener, statusBarItem);

	// Initialize the graph example (this registers the graph webview provider)
	// new GraphExample(context);
	let graphProvider = new GraphWebviewProvider(context);
	// Register the webview provider
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			GraphWebviewProvider.viewType,
			graphProvider
		)
	);
	state.graphWebviewProvider = graphProvider; // Store reference in state
	const rootPath =
    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : "undefined";
  	const nodeDependenciesProvider = new NodeDependenciesProvider(rootPath);
  	vscode.window.registerTreeDataProvider('omniscientDebugPanel', nodeDependenciesProvider);
  	vscode.commands.registerCommand('omniscientDebugPanel.refreshEntry', () =>
    	nodeDependenciesProvider.refresh()
  	);

	vscode.commands.registerCommand('omniscientDebugPanel.gotoLine', (item: LineInfo) => {
		vscode.window.showInformationMessage(`Going to line: ${item}`);
	});

}



// This method is called when your extension is deactivated
export function deactivate() {
	// Clean up web server process
	if (webServerProcess) {
		webServerProcess.kill();
		webServerProcess = null;
	}
	if (statusBarItem) {
		statusBarItem.dispose();
	}

	// Clean up debug polling
	if (debugPollingInterval) {
		clearInterval(debugPollingInterval);
		debugPollingInterval = null;
	}
}
