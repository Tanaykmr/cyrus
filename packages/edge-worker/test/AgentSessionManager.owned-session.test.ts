import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { CodexEventMapper, CodexRunner } from "cyrus-codex-runner";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import type { ICyrusSessionSink } from "../src/sinks/IActivitySink.js";

const workspace = { path: "/tmp/owned-session-test", isGitWorktree: false };
function sink(): ICyrusSessionSink {
	return {
		id: "bound-workspace-and-namespace",
		createCyrusSession: vi.fn().mockResolvedValue(undefined),
		postActivity: vi
			.fn()
			.mockResolvedValue({ activityId: "persisted-activity" }),
	};
}

describe("Cyrus-owned session activity routing (normalizer replay, not live Codex)", () => {
	it.each([
		false,
		true,
	])("preserves a child and optional ticket link across restore: ticket=%s", async (ticket) => {
		const destination = sink();
		const manager = new AgentSessionManager();
		await manager.createOwnedSession(
			{ id: "parent", scopeRef: "parent-scope", role: "coordinator" },
			workspace,
			destination,
		);
		const descriptor = {
			id: "child",
			parentSessionId: "parent",
			scopeRef: "separately-admitted-child",
			role: "engineering" as const,
			...(ticket && {
				issueContext: {
					trackerId: "linear",
					issueId: "issue-1",
					issueIdentifier: "TEST-1",
				},
				externalSessionId: "optional-linear-session",
			}),
		};
		await manager.createOwnedSession(descriptor, workspace, destination);
		manager.addAgentRunner(
			"child",
			new CodexRunner({ workingDirectory: workspace.path }),
		);
		const mapper = new CodexEventMapper({
			workingDirectory: workspace.path,
			model: "gpt-5.5",
			getSessionId: () => "native-codex-thread",
			getStagedSkillNames: () => [],
			emitMessage: () => {},
			onThreadStarted: () => {},
		});
		mapper.reset();
		mapper.handle({ kind: "thread-started", threadId: "native-codex-thread" });
		mapper.handle({
			kind: "item-completed",
			item: {
				id: "patch-1",
				type: "file_change",
				changes: [{ path: "src/example.ts", kind: "update" }],
				status: "completed",
			},
		});
		for (const message of mapper.getMessages())
			await manager.handleClaudeMessage("child", message);
		expect(destination.postActivity).toHaveBeenCalledWith(
			"child",
			expect.objectContaining({
				type: "action",
				action: "Edit",
				parameter: expect.any(String),
			}),
			{},
		);
		expect(destination.postActivity).toHaveBeenCalledWith(
			"child",
			expect.objectContaining({
				type: "action",
				action: "Edit",
				result: expect.any(String),
			}),
			{},
		);
		const state = JSON.parse(JSON.stringify(manager.serializeState()));
		const returnToParent = vi.fn().mockResolvedValue(undefined);
		const restored = new AgentSessionManager(undefined, returnToParent);
		restored.restoreState(state.sessions, state.entries);
		restored.setActivitySink("child", destination);
		expect(restored.getSession("child")).toMatchObject({
			id: "child",
			parentSessionId: "parent",
			codexSessionId: "native-codex-thread",
			activitySinkBinding: { sinkId: destination.id, sessionId: "child" },
		});
		expect(restored.getSession("child")?.issueContext).toEqual(
			ticket ? descriptor.issueContext : undefined,
		);
		await restored.completeSession("child", {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "Investigation complete; reviewed PR reference returned.",
			session_id: "native-codex-thread",
			duration_ms: 1,
			num_turns: 1,
		} as SDKResultMessage);
		expect(destination.postActivity).toHaveBeenCalledWith(
			"child",
			{
				type: "response",
				body: "Investigation complete; reviewed PR reference returned.",
			},
			{},
		);
		expect(returnToParent).toHaveBeenCalledWith(
			"parent",
			expect.stringContaining("Investigation complete"),
			"child",
		);
		expect(destination.createCyrusSession).toHaveBeenCalledTimes(2);
		expect("createAgentSession" in destination).toBe(false);
	});

	it("does not track denied child authority or permit another sink after restore", async () => {
		const manager = new AgentSessionManager();
		const destination = sink();
		await manager.createOwnedSession(
			{ id: "parent", scopeRef: "parent-scope", role: "coordinator" },
			workspace,
			destination,
		);
		vi.mocked(destination.createCyrusSession).mockRejectedValueOnce(
			new Error("Child authority denied"),
		);
		await expect(
			manager.createOwnedSession(
				{
					id: "child",
					parentSessionId: "parent",
					scopeRef: "forged",
					role: "coordinator",
				},
				workspace,
				destination,
			),
		).rejects.toThrow("Child authority denied");
		expect(manager.getSession("child")).toBeUndefined();
		const state = manager.serializeState();
		const restored = new AgentSessionManager();
		restored.restoreState(state.sessions, state.entries);
		expect(() =>
			restored.setActivitySink("parent", { ...sink(), id: "another-customer" }),
		).toThrow("persisted session binding");
		await expect(
			restored.createOwnedSession(
				{
					id: "child",
					parentSessionId: "absent",
					scopeRef: "child-scope",
					role: "investigator",
				},
				workspace,
				destination,
			),
		).rejects.toThrow("Parent session");
	});
});
