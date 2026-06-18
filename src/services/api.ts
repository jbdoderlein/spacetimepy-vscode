import * as vscode from 'vscode';
import { ApiResponse, FunctionData, ObjectGraphResponse, StackTraceResponse, SnapshotDetails, SessionSummary, SessionDetails } from '../types';
import { state, debugLog } from './state';
import { ConfigService } from './config';

const config = ConfigService.getInstance();

export async function retryFetch(url: string, maxRetries: number = 3): Promise<Response> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    throw new Error('Max retries reached');
}

export async function waitForServer(): Promise<boolean> {
    const startTime = Date.now();
    const timeout = config.getConfig().timeout;
    while (Date.now() - startTime < timeout) {
        try {
            const response = await fetch(`${config.getApiUrl()}/api/db-info`);
            if (response.ok) {
                return true;
            }
        } catch (error) {
            // Server not ready yet, continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

export async function isServerReady(): Promise<boolean> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/db-info`);
        return response.ok;
    } catch (error) {
        return false;
    }
}

export async function getFunctionData(filePath: string, functionName?: string): Promise<FunctionData[] | null> {
    try {
        const params = new URLSearchParams({ file: filePath });
        if (functionName) {
            params.set('function', functionName);
        }
        const response = await fetch(`${config.getApiUrl()}/api/function-calls?${params.toString()}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as { function_calls: FunctionData[] };
        return data.function_calls || [];
    } catch (error) {
        console.error('Error fetching function data:', error);
        return null;
    }
}

export async function getFunctionTraces(callId: string | number): Promise<FunctionData | null> {
    try {
        const response = await retryFetch(`${config.getApiUrl()}/api/function-call/${callId}`);
        const data = await response.json() as { function_call: FunctionData };
        return data.function_call;
    } catch (error) {
        console.error('Error fetching function traces:', error);
        return null;
    }
}

export async function getObjectGraph(showIsolated: boolean = false): Promise<ObjectGraphResponse | null> {
    try {
        const url = `${config.getApiUrl()}/api/object-graph${showIsolated ? '?show_isolated=true' : ''}`;
        const response = await retryFetch(url);
        const data = await response.json() as ObjectGraphResponse;
        if (data.error) {
            throw new Error(data.error);
        }
        return data;
    } catch (error) {
        console.error('Error fetching object graph:', error);
        return null;
    }
}

export async function getStackTrace(functionId: number | string): Promise<StackTraceResponse | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/stack-recording/${functionId}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as StackTraceResponse;
        return data;
    } catch (error) {
        console.error('Error fetching stack trace:', error);
        return null;
    }
}

export async function getSnapshotDetails(snapshotId: string): Promise<SnapshotDetails | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/snapshot/${snapshotId}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as SnapshotDetails;
        return data;
    } catch (error) {
        console.error('Error fetching snapshot details:', error);
        return null;
    }
}

export async function getSessionsList(): Promise<SessionSummary[] | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/sessions`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as { sessions: SessionSummary[] };
        return data.sessions;
    } catch (error) {
        console.error('Error fetching sessions list:', error);
        return null;
    }
}

export async function getSessionDetails(sessionId: number | string): Promise<SessionDetails | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/session/${sessionId}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as SessionDetails;
        return data;
    } catch (error) {
        console.error('Error fetching session details:', error);
        return null;
    }
}

export async function refreshApiData(): Promise<boolean> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return true;
    } catch (error) {
        console.error('Error refreshing API data:', error);
        console.error(error);
        return false;
    }
}

export async function getTracesList(): Promise<FunctionData[] | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/function-calls`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as { function_calls: FunctionData[] };
        // Filter to only include traces with stack recordings
        return data.function_calls.filter(trace => trace.has_stack_recording) || [];
    } catch (error) {
        console.error('Error fetching traces list:', error);
        return null;
    }
}

export async function compareTraces(trace1Id: string | number, trace2Id: string | number): Promise<any | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/compare-traces`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                trace1_id: trace1Id.toString(),
                trace2_id: trace2Id.toString()
            })
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error comparing traces:', error);
        return null;
    }
} 

export async function getGraph(functionID: string): Promise<any | null> {
    try {
        const response = await fetch(`${config.getApiUrl()}/api/function-call/${functionID}/graph`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as SnapshotDetails;
        return data;
    } catch (error) {
        console.error('Error fetching snapshot details:', error);
        return null;
    }
}
