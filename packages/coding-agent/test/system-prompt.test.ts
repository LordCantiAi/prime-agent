import { describe, expect, test } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { HarnessState } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createIpythonToolDefinition } from "../src/core/tools/ipython.js";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			source: "local",
			path: `/skills/${name}/SKILL.md`,
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
		kind: "markdown",
	};
}

function pythonSkill(name: string, importName = name.replaceAll("-", "_")): Skill {
	const base = skill(name);
	return {
		...base,
		kind: "python",
		python: {
			importName,
			packagePath: `/skills/${name}`,
			pyprojectPath: `/skills/${name}/pyproject.toml`,
		},
	};
}

describe("buildRlmPrompt", () => {
	test("defaults omitted activeTools to ipython guidance", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
		});

		expect(prompt).toContain("Installed Python skill modules (pre-imported): `websearch`.");
		expect(prompt).toContain("A callable `rlm` is already in your global namespace");
		expect(prompt).toContain("persistent Python REPL");
		expect(prompt).toContain("Python is the orchestration language");
	});

	test("discovers requested models through a bounded authenticated host search", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
		});

		expect(prompt).toContain("await rlm.find_models(...)");
		expect(prompt).toContain("exact returned selector");
		expect(prompt).toContain("An unavailable requested model fails spawn");
		expect(prompt).toContain("decide whether to retry or omit `model`");
		expect(prompt).not.toContain("model choices for subagents");
	});

	test("only documents ipython shell prefixes when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).not.toContain("persistent Python REPL");
	});

	test("keeps shell skill command guidance when ipython is inactive", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Installed skills available as shell commands: `websearch`.");
		expect(prompt).toContain("Each skill is also available as a shell command");
		expect(prompt).toContain("`<skill> --help`");
		expect(prompt).not.toContain("Installed Python skill modules (pre-imported)");
		expect(prompt).not.toContain("Read each skill's SKILL.md for its API");
	});

	test("gates agent messaging and observation doctrine on installed Python skills", () => {
		const withoutCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withoutCapabilities).not.toContain("agent_message.send");
		expect(withoutCapabilities).not.toContain("agent_message.list_agents");
		expect(withoutCapabilities).not.toContain("agent_observe");

		const systemPromptWithoutCapabilities = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});
		expect(systemPromptWithoutCapabilities).not.toContain("agent_message.send");
		expect(systemPromptWithoutCapabilities).not.toContain("agent_observe");

		const withCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message", "agent_observe"],
			activeTools: ["ipython"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withCapabilities).toContain("agent_message.send");
		expect(withCapabilities).toContain("agent_message.list_agents");
		expect(withCapabilities).toContain("agent_observe");
		expect(withCapabilities).toContain("restricted to your parent, siblings, and direct children");
	});

	test("does not prescribe kernel-only child replies without ipython", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message"],
			activeTools: ["bash"],
			depth: 1,
		});

		expect(prompt).toContain("You are a child agent");
		expect(prompt).not.toContain("When a task calls for an answer, reply explicitly with `await agent_message.send");
	});

	test("exposes the automatic child registry independently of observation skills", () => {
		const withoutObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
		});
		const withObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["agent_observe"],
			activeTools: ["ipython"],
		});

		for (const prompt of [withoutObserve, withObserve]) {
			expect(prompt).toContain("await rlm.list_subagents()");
			expect(prompt).toContain("await rlm.delete_subagent(child)");
			expect(prompt).toContain("recover direct child handles");
			expect(prompt).not.toContain("Write a small disk registry");
		}
	});

	test("documents the bash() orchestration contract when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Use `bash()` to invoke programs, not to write shell programs");
		expect(prompt).toContain("A `bash()` handle left running beyond its creating cell sends a completion follow-up");
	});

	test("documents preferring Python for reading and searching files when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Use Python for reading, searching, and editing files");
		expect(prompt).toContain("Always assign read/search results to named variables");
	});

	test("includes the edit skill guidance only when the edit skill is installed", () => {
		const withEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["edit"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(withEdit).toContain('await edit(path="pkg/file.py", old_str=old, new_str=new)');
		expect(withEdit).toContain("triple double quotes");

		const withoutEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(withoutEdit).not.toContain("await edit(path=");
	});
});

describe("buildSystemPrompt", () => {
	test("adds generic MCP guidance to default and custom IPython prompts", () => {
		for (const customPrompt of [undefined, "custom body"]) {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["ipython"],
				contextFiles: [],
				skills: [],
				cwd: "/repo",
				genericMcpServers: ["zebra", "filesystem"],
			});

			expect(prompt).toContain("Enabled generic MCP servers: `filesystem`, `zebra`.");
			expect(prompt).toContain('await mcp.list_tools("filesystem")');
			expect(prompt).toContain('await mcp.call_tool("filesystem", "<tool>", arguments)');
			expect(prompt).toContain("not as top-level native tool namespaces or installed Python skills");
		}

		const shellPrompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			genericMcpServers: ["filesystem"],
		});
		expect(shellPrompt).not.toContain("Generic MCP Connections");
	});

	test("uses the model-agnostic rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("refine"), pythonSkill("agent-message"), pythonSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.pi/sessions/session.jsonl");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("returns at admission, not completion");
		expect(prompt).toContain("Results arrive only through an available messaging capability or files");
		expect(prompt).toContain("recover direct child handles");
		expect(prompt).toContain("kernel restart or compaction");
		expect(prompt).toContain("rlm.list_subagents");
		expect(prompt).toContain("rlm.delete_subagent");
		expect(prompt).toContain("rlm_child_id");
		expect(prompt).toContain("name='api-reviewer'");
		expect(prompt).toContain("session_dir");
		expect(prompt).toContain("agent_observe");
		expect(prompt).toContain("restricted to your parent, siblings, and direct children");
	});

	test("adds child reply doctrine to custom prompts when messaging is available", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("agent-message")],
			cwd: "/repo",
			rlmDepth: 1,
			rlmParentAgent: "orchestrator",
		});

		expect(prompt).toContain("You are a child agent spawned by orchestrator");
		expect(prompt).toContain('await agent_message.send(message, receiver_role="parent")');
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
	});

	test("gates custom-prompt child reply doctrine on IPython and agent messaging", () => {
		const build = (selectedTools: string[], skills: Skill[]) =>
			buildSystemPrompt({
				customPrompt: "custom body",
				selectedTools,
				contextFiles: [],
				skills,
				cwd: "/repo",
				rlmDepth: 1,
			});

		expect(build(["ipython"], [])).toContain("You are a child agent spawned by your parent agent");
		expect(build(["ipython"], [])).not.toContain("agent_message.send");
		expect(build(["bash"], [pythonSkill("agent-message")])).not.toContain("agent_message.send");
	});

	test("append system prompt content is included after the rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			appendSystemPrompt: "extra instruction",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt.indexOf("Treat harness refinement as a small, evidence-backed update")).toBeLessThan(
			prompt.indexOf("extra instruction"),
		);
		expect(prompt).not.toContain("Call at most one built-in tool per turn.");
	});

	test("project context files are appended", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## AGENTS.md\n\nproject rules");
	});

	test("markdown skills are included in rlm harness prompts without Python pre-imports", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [skill("websearch")],
			cwd: "/repo",
		});

		expect(prompt).not.toContain("Installed Python skill modules (pre-imported)");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>websearch</name>");
		expect(prompt).toContain("<type>markdown</type>");
		expect(prompt).toContain("<location>/skills/websearch/SKILL.md</location>");
	});

	test("Python skills are configured for IPython and included in skill metadata", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("web-search")],
			cwd: "/repo",
		});

		expect(prompt).toContain("Installed Python skill modules (pre-imported): `web_search`.");
		expect(prompt).toContain("<name>web-search</name>");
		expect(prompt).toContain("<type>python</type>");
		expect(prompt).toContain("<python_import>web_search</python_import>");
	});

	test("prompt guidelines are appended and deduplicated", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython", "dynamic_tool"],
			promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Additional Guidance");
		expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
	});
});

describe("createIpythonToolDefinition", () => {
	test("describes project checks as target-environment work", () => {
		const tool = createIpythonToolDefinition("/repo");

		expect(tool.description).toContain("persistent Python REPL");
		expect(tool.description).toContain("target project's own environment");
		expect(tool.promptSnippet).toContain("bash() orchestration");
		const codeSchema = tool.parameters.properties.code;
		const codeDescription =
			"description" in codeSchema && typeof codeSchema.description === "string" ? codeSchema.description : "";
		expect(codeDescription).toContain("target project's own environment");
	});

	test("buildSystemPrompt omits Continual Harness State even when harnessState is provided", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				memory: {
					validation: {
						id: "validation",
						kind: "memory",
						title: "Validation",
						content: "Run npm run check after code changes.",
						path: "repo",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({ selectedTools: ["ipython"], cwd: "/repo", harnessState });
		expect(prompt).not.toContain("# Continual Harness State");
		expect(prompt).not.toContain("validation");
	});
});
