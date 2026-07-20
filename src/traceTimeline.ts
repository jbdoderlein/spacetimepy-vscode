import { BranchDetail, StackRecording } from './types';

export interface TraceTimelineFrame {
	snapshotId: number;
	functionCallId: number;
	codeDefinitionId: string | number | null;
	line: number;
	stepId: number | null;
	ownerBranchId: number | null;
	sourceStepId: number | null;
}

export type BranchRecordings = Record<string, StackRecording>;

export function recordingTimeline(recording: StackRecording): TraceTimelineFrame[] {
	return recording.frames.map(frame => ({
		snapshotId: frame.id,
		functionCallId: frame.function_call_id,
		codeDefinitionId: frame.code_definition_id,
		line: frame.line,
		stepId: null,
		ownerBranchId: null,
		sourceStepId: null,
	}));
}

export function buildBranchTimeline(
	branch: BranchDetail,
	recordings: BranchRecordings,
): TraceTimelineFrame[] {
	return branch.steps.flatMap(step => {
		if (step.stack_snapshot) {
			return [{
				snapshotId: step.stack_snapshot.id,
				functionCallId: step.stack_snapshot.function_call_id,
				codeDefinitionId: step.stack_snapshot.code_definition_id,
				line: step.stack_snapshot.line,
				stepId: step.id,
				ownerBranchId: step.branch_id,
				sourceStepId: step.source_step_id,
			}];
		}

		const callId = step.function_call?.id;
		const recording = callId === undefined ? undefined : recordings[String(callId)];
		return recording?.frames.map(frame => ({
			snapshotId: frame.id,
			functionCallId: frame.function_call_id,
			codeDefinitionId: frame.code_definition_id,
			line: frame.line,
			stepId: step.id,
			ownerBranchId: step.branch_id,
			sourceStepId: step.source_step_id,
		})) ?? [];
	});
}

export function findFirstFrameForEditorLine(
	frames: TraceTimelineFrame[],
	line: number,
	functionCallIds: Iterable<number>,
): number {
	const acceptedCalls = new Set(functionCallIds);
	return frames.findIndex(frame =>
		frame.line === line && acceptedCalls.has(frame.functionCallId),
	);
}
