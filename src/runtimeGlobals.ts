import { ValuePreview } from './types';

/**
 * Names the bundled hotswap runtime injects into the module of a captured
 * function. SpaceTimePy records them like any other global.
 */
const RUNTIME_NAME_PREFIXES = ['_spacetimepy', '__spacetimepy'];

/**
 * Module constants of the hotswap runtime itself.
 *
 * A frame belonging to that module records them as its data globals. Each one
 * holds a known string, so the recorded value confirms the name really is the
 * runtime constant and not a variable of the same name in user code.
 */
const RUNTIME_CONSTANTS: Record<string, string> = {
	_ENTRY_NAME: '_spacetimepy_hotswap_entry',
	_CONTINUE_NAME: '_spacetimepy_hotswap_continue',
	_PREPARE_NAME: '_spacetimepy_hotswap_prepare',
	_CHECKPOINT_NAME: '_spacetimepy_hotswap_prepare_checkpoint',
	_FINISH_NAME: '_spacetimepy_hotswap_finish',
	_TEMPORARY_NAME: '_spacetimepy_hotswap_result',
};

/** The sentinel the runtime uses to mark a suspended hotswap call. */
const SENTINEL_NAME = '_CONTINUE';
const SENTINEL_VALUE = /^<object object at 0x[0-9a-f]+>$/;

export function isRuntimeValue(name: string, preview: ValuePreview | undefined): boolean {
	if (RUNTIME_NAME_PREFIXES.some(prefix => name.startsWith(prefix))) {
		return true;
	}
	if (preview === undefined) {
		return false;
	}
	const expected = RUNTIME_CONSTANTS[name];
	if (expected !== undefined) {
		return preview.value === expected;
	}
	return name === SENTINEL_NAME
		&& preview.type === 'object'
		&& typeof preview.value === 'string'
		&& SENTINEL_VALUE.test(preview.value);
}

export interface FilteredValues {
	values: Record<string, ValuePreview>;
	hidden: number;
}

export function withoutRuntimeValues(
	values: Record<string, ValuePreview> | undefined,
): FilteredValues {
	const entries = Object.entries(values ?? {});
	const kept = entries.filter(([name, preview]) => !isRuntimeValue(name, preview));
	return { values: Object.fromEntries(kept), hidden: entries.length - kept.length };
}

/**
 * A recorded frame whose runtime-owned locals and globals are removed.
 *
 * The counts travel with the frame so each card can say that values were
 * hidden rather than silently dropping them.
 */
export type WithoutRuntimeValues<T> = T & {
	hidden_runtime_locals: number;
	hidden_runtime_globals: number;
};

export function filterRecordedValues<
	T extends { locals?: Record<string, ValuePreview>; globals?: Record<string, ValuePreview> },
>(frame: T): WithoutRuntimeValues<T> {
	const locals = withoutRuntimeValues(frame.locals);
	const globals = withoutRuntimeValues(frame.globals);
	return {
		...frame,
		...(frame.locals === undefined ? {} : { locals: locals.values }),
		...(frame.globals === undefined ? {} : { globals: globals.values }),
		hidden_runtime_locals: locals.hidden,
		hidden_runtime_globals: globals.hidden,
	};
}
