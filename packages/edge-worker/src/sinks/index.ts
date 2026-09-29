/**
 * Activity sinks for posting agent session activities to various platforms.
 *
 * @module sinks
 */

export type {
	ActivityPostOptions,
	ActivityPostResult,
	ActivitySignal,
	CyrusSessionDescriptor,
	IActivitySink,
	ICyrusSessionSink,
	SessionActivitySink,
} from "./IActivitySink.js";
export { LinearActivitySink } from "./LinearActivitySink.js";
export { NoopActivitySink } from "./NoopActivitySink.js";
export * from "./session-delivery.js";
