import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger, Issue, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/PromptBuilder.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeRepository(
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-prompt-"));
	const templatePath = join(dir, "template.md");
	writeFileSync(templatePath, "Work from {{base_branch}}.");
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		baseBranch: "v2",
		workspaceBaseDir: "/ws",
		linearWorkspaceId: "ws-1",
		promptTemplatePath: templatePath,
		appendInstruction: "Open PRs with `gh pr create --base {{base_branch}}`.",
		...overrides,
	} as RepositoryConfig;
}

function makeBuilder(): PromptBuilder {
	return new PromptBuilder({
		logger: silentLogger,
		repositories: new Map(),
		issueTrackers: new Map(),
		gitService: { sanitizeBranchName: (name: string) => name },
	} as unknown as ConstructorParameters<typeof PromptBuilder>[0]);
}

const issue = {
	id: "issue-1",
	identifier: "ABC-1",
	title: "Test",
	branchName: "abc-1-test",
	state: Promise.resolve({ name: "Todo" }),
} as unknown as Issue;

describe("PromptBuilder repository appendInstruction", () => {
	it("fills {{base_branch}} with the branch resolved for the session", async () => {
		const repository = makeRepository();
		const { prompt } = await makeBuilder().buildIssueContextPrompt(
			issue,
			[repository],
			undefined,
			"",
			undefined,
			{
				"repo-a": {
					branch: "demo",
					source: "description-tag",
					detail: "[repo=...#demo]",
				},
			} as unknown as Parameters<PromptBuilder["buildIssueContextPrompt"]>[5],
		);

		expect(prompt).toBe(
			`Work from demo.

<repository-specific-instruction repository="Repo A">
Open PRs with \`gh pr create --base demo\`.
</repository-specific-instruction>`,
		);
	});

	it("falls back to the repository's default base branch", async () => {
		const repository = makeRepository();
		const { prompt } = await makeBuilder().buildIssueContextPrompt(
			issue,
			[repository],
			undefined,
			"",
			undefined,
			{} as Parameters<PromptBuilder["buildIssueContextPrompt"]>[5],
		);

		expect(prompt).toBe(
			`Work from v2.

<repository-specific-instruction repository="Repo A">
Open PRs with \`gh pr create --base v2\`.
</repository-specific-instruction>`,
		);
	});
});
