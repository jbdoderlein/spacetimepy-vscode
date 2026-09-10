import {
	AlignmentRelation,
	AlignmentResult,
	BranchDetail,
	BranchStep,
	BranchSummary,
	SessionDetail,
} from './types';

export interface ComparisonSide {
	stepId: number;
	position: number;
	line: number | null;
	label: string;
	functionCallId: number | null;
	codeDefinitionId: string | number | null;
}

export interface ComparisonRow {
	index: number;
	relation: AlignmentRelation;
	reference: ComparisonSide | null;
	target: ComparisonSide | null;
}

export interface ComparisonBranchPair {
	reference: BranchSummary;
	target: BranchSummary;
}

export type RelationCounts = Record<AlignmentRelation, number>;

export function stepLine(step: BranchStep): number | null {
	return step.stack_snapshot?.line ?? step.function_call?.line ?? null;
}

export function stepCodeDefinitionId(step: BranchStep): string | number | null {
	return step.stack_snapshot?.code_definition_id
		?? step.function_call?.code_definition_id
		?? null;
}

export function stepLabel(step: BranchStep): string {
	const line = stepLine(step);
	if (step.stack_snapshot) {
		return line === null ? `Step ${step.position}` : `Line ${line}`;
	}
	if (step.function_call) {
		return step.function_call.qualified_name ?? step.function_call.function_name;
	}
	return step.label ?? `Step ${step.position}`;
}

export function branchLabel(branch: BranchSummary): string {
	return `${branch.name ?? `Branch ${branch.id}`} · #${branch.id}`;
}

function side(step: BranchStep | undefined): ComparisonSide | null {
	if (!step) {
		return null;
	}
	return {
		stepId: step.id,
		position: step.position,
		line: stepLine(step),
		label: stepLabel(step),
		functionCallId: step.function_call?.id ?? step.stack_snapshot?.function_call_id ?? null,
		codeDefinitionId: stepCodeDefinitionId(step),
	};
}

/**
 * Pair every alignment link with the trace steps it connects.
 *
 * The API returns step identifiers only, so the branch payloads supply the
 * recorded line and code version each aligned row displays.
 */
export function buildComparisonRows(
	alignment: AlignmentResult,
	reference: BranchDetail,
	target: BranchDetail,
): ComparisonRow[] {
	const referenceSteps = new Map(reference.steps.map(step => [step.id, step]));
	const targetSteps = new Map(target.steps.map(step => [step.id, step]));
	return alignment.links.map((link, index) => ({
		index,
		relation: link.relation,
		reference: side(
			link.reference_step_id === null ? undefined : referenceSteps.get(link.reference_step_id),
		),
		target: side(
			link.target_step_id === null ? undefined : targetSteps.get(link.target_step_id),
		),
	}));
}

export function relationCounts(rows: ComparisonRow[]): RelationCounts {
	const counts: RelationCounts = { match: 0, updated: 0, inserted: 0, deleted: 0 };
	for (const row of rows) {
		counts[row.relation] += 1;
	}
	return counts;
}

/**
 * List the branch pairs the alignment service accepts.
 *
 * Alignment compares a branch suffix with one of its direct forks, so only a
 * child branch carrying a fork step can be a comparison target.
 */
export function comparisonBranchPairs(session: SessionDetail): ComparisonBranchPair[] {
	const byId = new Map(session.branches.map(branch => [branch.id, branch]));
	return session.branches
		.filter(branch => branch.parent_branch_id !== null && branch.forked_from_step_id !== null)
		.flatMap(target => {
			const reference = byId.get(target.parent_branch_id as number);
			return reference ? [{ reference, target }] : [];
		});
}

/**
 * Choose the row a fresh comparison should open on.
 *
 * A row linking both sides shows the alignment itself, so it is preferred over
 * an inserted or deleted row that can only display one trace.
 */
export function initialRowIndex(rows: ComparisonRow[]): number | null {
	if (rows.length === 0) {
		return null;
	}
	const paired = rows.findIndex(row => row.reference !== null && row.target !== null);
	return paired >= 0 ? paired : 0;
}

/**
 * Find the closest row that has a step on one side.
 *
 * An inserted or deleted row leaves one pane without a step; showing the
 * nearest recorded code on that side keeps both panes on the same function.
 */
export function nearestSide(
	rows: ComparisonRow[],
	index: number,
	which: 'reference' | 'target',
): ComparisonSide | null {
	for (let distance = 0; distance < rows.length; distance += 1) {
		for (const candidate of distance === 0 ? [index] : [index - distance, index + distance]) {
			const row = rows[candidate];
			if (row?.[which]) {
				return row[which];
			}
		}
	}
	return null;
}

export type GraphSide = 'shared' | 'reference' | 'target';

export interface ComparisonGraphNode {
	key: string;
	label: string;
	side: GraphSide;
	/** Relation of the row that introduced the node, so a shared line that
	 * changed is distinguishable from one that did not. */
	relation: AlignmentRelation;
	/**
	 * Vertical order, unique within a column.
	 *
	 * The reference-only and fork-only runs that follow the same shared line
	 * start at the same rank, so the two paths sit side by side and rejoin at
	 * the next shared line.
	 */
	rank: number;
	/** The aligned row this node stands for, used when it is selected. */
	rowIndex: number;
	referenceLine: number | null;
	targetLine: number | null;
	/** How many aligned rows reach this line, so repeats stay visible. */
	visits: number;
}

export interface ComparisonGraphEdge {
	from: string;
	to: string;
	side: GraphSide;
}

export interface ComparisonGraph {
	nodes: ComparisonGraphNode[];
	edges: ComparisonGraphEdge[];
	/** The node each aligned row belongs to, so the two views share a selection. */
	rowNodeKeys: string[];
}

function sideKey(side: ComparisonSide): string {
	return side.line === null ? `p${side.position}` : String(side.line);
}

function sideLabel(side: ComparisonSide): string {
	return side.line === null ? `#${side.position}` : String(side.line);
}

function nodeIdentity(row: ComparisonRow): { key: string; side: GraphSide; label: string } {
	if (row.reference && row.target) {
		const reference = sideLabel(row.reference);
		const target = sideLabel(row.target);
		return {
			key: `both:${sideKey(row.reference)}:${sideKey(row.target)}`,
			side: 'shared',
			label: reference === target ? reference : `${reference} → ${target}`,
		};
	}
	if (row.reference) {
		return {
			key: `ref:${sideKey(row.reference)}`,
			side: 'reference',
			label: sideLabel(row.reference),
		};
	}
	const target = row.target as ComparisonSide;
	return { key: `tgt:${sideKey(target)}`, side: 'target', label: sideLabel(target) };
}

/**
 * Merge the two aligned traces into one graph with a node per executed line.
 *
 * A line both traces run becomes one shared node, so the graph shows a common
 * spine that splits where only one branch executed a line and joins again at
 * the next aligned line. Edges follow the recorded order of each trace and
 * carry the side that took them, which is what colours the divergent paths.
 *
 * A line reached several times, by a loop for example, stays one node and
 * counts its visits; an edge from a line to itself is therefore left out.
 */
export function buildComparisonGraph(rows: ComparisonRow[]): ComparisonGraph {
	const nodes = new Map<string, ComparisonGraphNode>();
	const rowNodeKeys: string[] = [];
	let referenceCursor = 0;
	let targetCursor = 0;

	for (const row of rows) {
		const identity = nodeIdentity(row);
		const existing = nodes.get(identity.key);
		// A revisited line keeps its place, and the trace resumes from there.
		const rank = existing
			? existing.rank
			: identity.side === 'shared'
				? Math.max(referenceCursor, targetCursor)
				: identity.side === 'reference' ? referenceCursor : targetCursor;
		if (identity.side !== 'target') {
			referenceCursor = rank + 1;
		}
		if (identity.side !== 'reference') {
			targetCursor = rank + 1;
		}
		if (existing) {
			existing.visits += 1;
		} else {
			nodes.set(identity.key, {
				key: identity.key,
				label: identity.label,
				side: identity.side,
				relation: row.relation,
				rank,
				rowIndex: row.index,
				referenceLine: row.reference?.line ?? null,
				targetLine: row.target?.line ?? null,
				visits: 1,
			});
		}
		rowNodeKeys.push(identity.key);
	}

	interface EdgeSides { from: string; to: string; reference: boolean; target: boolean }
	const edges = new Map<string, EdgeSides>();
	const connect = (which: 'reference' | 'target'): void => {
		let previous: string | null = null;
		rows.forEach((row, index) => {
			if (row[which] === null) {
				return;
			}
			const key = rowNodeKeys[index];
			if (previous !== null && previous !== key) {
				const identifier = `${previous} ${key}`;
				const edge: EdgeSides = edges.get(identifier)
					?? { from: previous, to: key, reference: false, target: false };
				edge[which] = true;
				edges.set(identifier, edge);
			}
			previous = key;
		});
	};
	connect('reference');
	connect('target');

	return {
		nodes: [...nodes.values()],
		edges: [...edges.values()].map(edge => ({
			from: edge.from,
			to: edge.to,
			side: edge.reference && edge.target
				? 'shared'
				: edge.reference ? 'reference' : 'target',
		})),
		rowNodeKeys,
	};
}
