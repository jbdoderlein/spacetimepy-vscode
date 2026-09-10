export interface ValuePreview {
	reference: string | null;
	type: string;
	value: unknown;
	identity_id?: number | null;
	version?: number | null;
	is_primitive?: boolean;
	error?: boolean;
}

export interface TraceLocation {
	session_id: number;
	branch_id: number;
	step_id: number;
}

export interface FunctionCallSummary {
	id: number;
	function: string;
	function_name: string;
	qualified_name: string | null;
	module_name: string | null;
	file: string | null;
	file_path: string | null;
	line: number | null;
	first_line_number: number | null;
	start_time: string | null;
	started_at: string | null;
	end_time: string | null;
	completed_at: string | null;
	duration: number | null;
	outcome: string | null;
	code_definition_id: string | number | null;
	caller_call_id: number | null;
	has_stack_recording: boolean;
	snapshot_count: number;
	locations: TraceLocation[];
}

export interface FunctionCallDetail extends FunctionCallSummary {
	attributes: Record<string, unknown>;
	locals: Record<string, ValuePreview>;
	globals: Record<string, ValuePreview>;
	return_value: ValuePreview;
	exception: ValuePreview;
	stack_recording: StackSnapshotSummary[];
}

export interface FunctionCallsResponse {
	function_calls: FunctionCallSummary[];
	total: number;
	limit: number;
	offset: number;
}

export interface CodeDefinition {
	id: string | number;
	name: string;
	qualified_name: string | null;
	type: string;
	kind: string;
	module_path: string | null;
	content: string;
	code_content: string;
	first_line_no: number | null;
	first_line_number: number | null;
}

export interface StackSnapshotSummary {
	id: number;
	function_call_id: number;
	code_definition_id: string | number | null;
	line: number;
	line_number: number;
	timestamp: string | null;
	captured_at: string | null;
}

export interface StackFrame extends StackSnapshotSummary {
	position: number;
	snapshot_id: number;
	previous_snapshot_id: number | null;
	next_snapshot_id: number | null;
	locals: Record<string, ValuePreview>;
	globals: Record<string, ValuePreview>;
}

export interface StackRecording {
	function: FunctionCallSummary & { code: CodeDefinition | null };
	code_definitions: Record<string, CodeDefinition>;
	frames: StackFrame[];
}

export interface BranchSummary {
	id: number;
	session_id: number;
	parent_branch_id: number | null;
	forked_from_step_id: number | null;
	child_branch_ids: number[];
	name: string | null;
	status: string;
	configuration_key: string | null;
	step_count: number;
}

export interface SessionDetail {
	id: number;
	name: string | null;
	description: string | null;
	status: string;
	step_kind: string;
	root_branch_id: number;
	branches: BranchSummary[];
}

export interface BranchStep {
	id: number;
	branch_id: number;
	position: number;
	kind: string;
	source_step_id: number | null;
	label: string | null;
	function_call: FunctionCallSummary | null;
	stack_snapshot: StackSnapshotSummary | null;
}

export interface BranchDetail extends BranchSummary {
	resolved: boolean;
	steps: BranchStep[];
}

export interface DatabaseInfo {
	database: string;
	session_count: number;
	branch_count: number;
	step_count: number;
	function_call_count: number;
	stack_snapshot_count: number;
}

export interface SessionSummary {
	id: number;
	name: string | null;
	description: string | null;
	status: string;
	step_kind: string;
	root_branch_id: number;
	branch_count: number;
	start_time: string | null;
	end_time: string | null;
}

export interface SessionsResponse {
	sessions: SessionSummary[];
}

export type AlignmentRelation = 'match' | 'updated' | 'inserted' | 'deleted';

export interface AlignmentLink {
	reference_step_id: number | null;
	target_step_id: number | null;
	relation: AlignmentRelation;
}

export interface AlignmentResult {
	algorithm: string;
	algorithm_version: string;
	reference_branch_id: number;
	target_branch_id: number;
	links: AlignmentLink[];
}

export interface AlignmentAlgorithm {
	name: string;
	version: string;
	offline: boolean;
	online: boolean;
}

export interface AlignmentAlgorithmsResponse {
	algorithms: AlignmentAlgorithm[];
}
