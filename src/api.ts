import {
	AlignmentAlgorithm,
	AlignmentAlgorithmsResponse,
	AlignmentResult,
	BranchDetail,
	CodeDefinition,
	DatabaseInfo,
	FunctionCallDetail,
	FunctionCallsResponse,
	SessionDetail,
	SessionSummary,
	SessionsResponse,
	StackRecording,
	StackFrame,
} from './types';

export class SpaceTimePyApiError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = 'SpaceTimePyApiError';
	}
}

export class SpaceTimePyApiClient {
	constructor(
		private readonly baseUrl: () => string,
		private readonly timeout: () => number,
	) {}

	public async health(): Promise<DatabaseInfo> {
		return this.request<DatabaseInfo>('/api/health');
	}

	public async databaseInfo(): Promise<DatabaseInfo> {
		return this.request<DatabaseInfo>('/api/db-info');
	}

	public async refresh(): Promise<void> {
		await this.request<{ refreshed: boolean }>('/api/refresh', { method: 'POST' });
	}

	public async getFunctionCalls(options: {
		file?: string;
		functionName?: string;
		sessionId?: number;
		branchId?: number;
		limit?: number;
		offset?: number;
	} = {}): Promise<FunctionCallsResponse> {
		const parameters = new URLSearchParams();
		if (options.file) {
			parameters.set('file', options.file);
		}
		if (options.functionName) {
			parameters.set('function', options.functionName);
		}
		if (options.sessionId !== undefined) {
			parameters.set('session_id', String(options.sessionId));
		}
		if (options.branchId !== undefined) {
			parameters.set('branch_id', String(options.branchId));
		}
		parameters.set('limit', String(options.limit ?? 500));
		parameters.set('offset', String(options.offset ?? 0));
		return this.request<FunctionCallsResponse>(`/api/function-calls?${parameters}`);
	}

	public async getFunctionCall(callId: number): Promise<FunctionCallDetail> {
		const response = await this.request<{ function_call: FunctionCallDetail }>(
			`/api/function-call/${callId}`,
		);
		return response.function_call;
	}

	public async getStackRecording(callId: number): Promise<StackRecording> {
		return this.request<StackRecording>(`/api/stack-recording/${callId}`);
	}

	public async getSessions(): Promise<SessionSummary[]> {
		const response = await this.request<SessionsResponse>('/api/sessions');
		return response.sessions;
	}

	public async getSession(sessionId: number): Promise<SessionDetail> {
		return this.request<SessionDetail>(`/api/session/${sessionId}`);
	}

	public async getBranch(branchId: number, resolve = true): Promise<BranchDetail> {
		return this.request<BranchDetail>(`/api/branches/${branchId}?resolve=${resolve}`);
	}

	public async getSnapshot(snapshotId: number): Promise<StackFrame> {
		const response = await this.request<{ snapshot: StackFrame }>(
			`/api/snapshot/${snapshotId}`,
		);
		return response.snapshot;
	}

	public async getCodeDefinition(definitionId: string | number): Promise<CodeDefinition> {
		const response = await this.request<{ code_definition: CodeDefinition }>(
			`/api/code-definitions/${encodeURIComponent(String(definitionId))}`,
		);
		return response.code_definition;
	}

	public async getAlignmentAlgorithms(): Promise<AlignmentAlgorithm[]> {
		const response = await this.request<AlignmentAlgorithmsResponse>(
			'/api/alignment/algorithms',
		);
		return response.algorithms;
	}

	public async compareAlignment(options: {
		referenceBranchId: number;
		targetBranchId: number;
		algorithm?: string;
		alignmentOptions?: Record<string, unknown>;
	}): Promise<AlignmentResult> {
		const body: Record<string, unknown> = {
			reference_branch_id: options.referenceBranchId,
			target_branch_id: options.targetBranchId,
			options: options.alignmentOptions ?? {},
		};
		if (options.algorithm) {
			body.algorithm = options.algorithm;
		}
		const response = await this.request<{ alignment: AlignmentResult }>(
			'/api/alignment/compare',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		);
		return response.alignment;
	}

	private async request<T>(route: string, init?: RequestInit): Promise<T> {
		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), this.timeout());
		try {
			const response = await fetch(`${this.baseUrl()}${route}`, {
				...init,
				headers: {
					Accept: 'application/json',
					...init?.headers,
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				const detail = await response.text();
				throw new SpaceTimePyApiError(
					`SpaceTimePy API returned ${response.status}${detail ? `: ${detail}` : ''}`,
					response.status,
				);
			}
			return await response.json() as T;
		} catch (error) {
			if (error instanceof SpaceTimePyApiError) {
				throw error;
			}
			if (error instanceof Error && error.name === 'AbortError') {
				throw new SpaceTimePyApiError(`SpaceTimePy API request timed out: ${route}`);
			}
			throw new SpaceTimePyApiError(
				`Unable to reach the SpaceTimePy API at ${this.baseUrl()}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeoutHandle);
		}
	}
}
