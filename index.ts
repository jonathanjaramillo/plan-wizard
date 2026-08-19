/**
 * Plan Wizard v3 — Ralph-style implementation loop.
 *
 * Two commands:
 *   /plan <description>   — research, clarify, and produce a RALPH-FORMAT plan
 *                          (checkbox steps, each with a free-text verification
 *                          and an optional per-step "Verify with:" model override).
 *   /implement [plan]     — runs the plan as a code-driven state machine:
 *                            implement step N (implement model)
 *                              -> [compact]
 *                              -> verify step N (verifier model, a DIFFERENT model)
 *                              -> [compact]
 *                              -> if PASS: check the box, store carry-forward notes,
 *                                 [compact], advance to step N+1
 *                                 if FAIL: [compact], fix (implement model) -> verify again
 *                                     (up to maxVerifyRetries; exceeded => mark
 *                                      BLOCKED and continue to the next step)
 *
 * Designed for SMALL LOCAL MODELS with tiny context windows: every phase gets a
 * fresh, minimal prompt, the context is compacted at every phase boundary, and a
 * tiny "carry-forward notes" field bridges context between phases so the model
 * never has to hold the full conversation.
 *
 * State (survives compaction / crashes) lives in .pi/implement/<plan>.json.
 * Settings live in .pi/plan-wizard.json.
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
// The model type is provided by pi-ai via ExtensionContext["model"] — we derive
// it from there instead of importing pi-ai directly, because pi-ai is not always
// resolvable from the plugin's own location (it only lives nested under pi-coding-agent).
type AnyModel = NonNullable<ExtensionContext["model"]>;
import { Static, Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";

/* ─────────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────────── */

type StepStatus = "pending" | "in_progress" | "pass" | "blocked" | "skipped";
type Phase = "idle" | "implement" | "verify" | "fix" | "done" | "stopped";

interface Verdict {
	pass: boolean;
	issues: string[];
	fixes: string[];
	notes: string; // carry-forward note for the next step
}

interface RalphStep {
	index: number;
	title: string;
	description: string;
	verification: string; // free-text criteria
	verifyWith: string | null; // per-step verifier model override ("provider/id")
	status: StepStatus;
	retries: number; // failed verify attempts counted against maxVerifyRetries
	noVerdictRetries: number; // times the verifier finished without calling submit_verification
	lastVerdict: Verdict | null;
	memory: string; // carry-forward note from the last verdict (what the NEXT step must know)
}

interface RalphState {
	planFile: string;
	cwd: string; // project root, used to locate the state file consistently
	planTitle: string;
	phase: Phase;
	currentStep: number;
	implementModel: string; // "provider/id"
	verifierModel: string; // "provider/id" (global default)
	maxVerifyRetries: number;
	stopped: boolean; // set by /implement-stop; a marker only — /implement --resume can still resume it
	steps: RalphStep[];
}

interface PlanWizardSettings {
	defaultVerifierModel: string | null; // null => "same as implement model"
	maxVerifyRetries: number;
}

/* ─────────────────────────────────────────────────────
   Module state
   ───────────────────────────────────────────────────── */

let ralphActive = false;
let ralphState: RalphState | null = null;
let loopInFlight = false; // guards the agent_settled loop against re-entrancy
let loopPaused = false; // user pressed /implement-stop

// ---- Live ExtensionAPI reference -------------------------------------------
// Module-level helpers (goToPhase, startRalphLoop) run OUTSIDE the extension
// entry, so they cannot capture `pi` as a closure variable. They reach the
// live ExtensionAPI through P(), which is assigned from the entry's `pi` below.
let __pi: ExtensionAPI | undefined;
function P(): ExtensionAPI {
	if (!__pi) throw new Error("plan-wizard: ExtensionAPI not initialized (entry not run yet)");
	return __pi;
}
/* ─────────────────────────────────────────────────────
   Path helpers
   ───────────────────────────────────────────────────── */

const DEFAULT_SETTINGS: PlanWizardSettings = {
	defaultVerifierModel: null,
	maxVerifyRetries: 3,
};

function getPlanDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "plans");
}

function getImplementDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "implement");
}

function getSettingsPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "plan-wizard.json");
}

/** State file for a given plan, e.g. <plan>.md -> <plan>.json */
function getStatePath(cwd: string, planFile: string): string {
	const base = path.basename(planFile);
	const name = base.replace(/\.md$/i, ".json");
	return path.join(getImplementDir(cwd), name);
}

/* ─────────────────────────────────────────────────────
   Settings
   ───────────────────────────────────────────────────── */

async function loadSettings(cwd: string): Promise<PlanWizardSettings> {
	try {
		const content = await fs.promises.readFile(getSettingsPath(cwd), "utf-8");
		const parsed = JSON.parse(content);
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

async function saveSettings(cwd: string, settings: PlanWizardSettings): Promise<void> {
	const filePath = getSettingsPath(cwd);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

/* ─────────────────────────────────────────────────────
   State file (source of truth for the loop)
   ───────────────────────────────────────────────────── */

async function readRalphState(cwd: string, planFile: string): Promise<RalphState | null> {
	const filePath = getStatePath(cwd, planFile);
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as RalphState;
		if (!parsed || !Array.isArray(parsed.steps)) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeRalphState(state: RalphState): Promise<void> {
	const filePath = getStatePath(state.cwd, state.planFile);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/* ─────────────────────────────────────────────────────
   Plan parsing (RALPH format)
   ───────────────────────────────────────────────────── */

function generatePlanFilename(description: string): string {
	const slug = description
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	const now = new Date();
	const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	return `${dateStr}-${slug}.md`;
}

/**
 * Parse a RALPH-FORMAT plan document into steps.
 *
 * Recognises both of these step formats:
 *
 *   - [ ] Step 1: Title
 *     description...
 *     **Verification:** ...
 *     **Verify with:** ollama/llama3.1:8b   (optional)
 *
 *   ### Step 1: Title            (legacy; no checkbox, no verification)
 *     description...
 *
 * Lines under a step are collected until the next step marker, a "## " heading,
 * or a "# " heading.
 */
/** Strip leading/trailing markdown emphasis (**, *, __, _, whitespace) from a title. */
function stripEmphasis(s: string): string {
	return s
		.replace(/^[\s*_]+/, "")
		.replace(/[\s*_]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

function parseRalphSteps(planText: string): RalphStep[] {
	const lines = planText.split("\n");
	const steps: RalphStep[] = [];
	const stepLineRe = /^(-\s+)?\[[ xXB~]\]\s*[*_]{0,3}\s*Step\s+\d+[:.)]\s*[*_]{0,3}\s*(.+)/i; // checkbox style (tolerant of **Step N:** bold/italic markers)
	const headingStepRe = /^###\s*[*_]{0,3}\s*Step\s+\d+[:.)]\s*[*_]{0,3}\s+(.+)/i; // legacy heading style (tolerant of emphasis)
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const isStep = stepLineRe.test(line) || headingStepRe.test(line);
		if (!isStep) {
			i++;
			continue;
		}

		let title = "";
		if (stepLineRe.test(line)) {
			const m = line.match(stepLineRe)!;
			title = stripEmphasis((m[2] ?? ""));
		} else {
			const m = line.match(headingStepRe)!;
			title = stripEmphasis((m[1] ?? ""));
		}

		// Collect the body: everything until the next step / "## " / "# " heading.
		const body: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const l = lines[j];
			if (stepLineRe.test(l) || headingStepRe.test(l)) break; // next step
			if (/^\s*#{1,2}\s/.test(l)) break; // new section (## or #)
			body.push(l);
			j++;
		}

		const bodyText = body.join("\n").trim();

		// Extract **Verification:** and **Verify with:** from the body; the rest is the description.
		let verification = "";
		let verifyWith: string | null = null;
		const descLines: string[] = [];
		let inVerification = false;
		let inVerifyWith = false;

		for (const bl of body) {
			const verMatch = bl.match(/^\s*\*{0,2}\s*Verification\s*[:)]?\s*\*{0,2}\s*[:)]?\s*(.*)$/i);
			const wMatch = bl.match(/^\s*\*{0,2}\s*Verify\s+with\s*[:)]?\s*\*{0,2}\s*[:)]?\s*(.*)$/i);
			if (verMatch) {
				inVerification = true;
				inVerifyWith = false;
				const rest = (verMatch[1] ?? "").trim();
				if (rest) verification = verification ? `${verification}\n${rest}` : rest;
				continue;
			}
			if (wMatch) {
				inVerifyWith = true;
				inVerification = false;
				const rest = (wMatch[1] ?? "").trim();
				if (rest && !/^(same|current|implement)$/i.test(rest)) verifyWith = rest;
				continue;
			}
			if (inVerification) {
					// Continuation line for the verification block. A blank line ends the block\n
					// (so it does not append an empty trailing line to the criteria).
					if (bl.trim().length > 0) {
						verification = `${verification}\n${bl.trim()}`;
					} else {
						inVerification = false;
					}
					continue;
			}
			if (inVerifyWith) {
				inVerifyWith = false;
			}
			descLines.push(bl);
		}

		// Trim leading/trailing blank lines from the description.
		let description = descLines.join("\n").trim();
		description = description.replace(/^\s*\*{0,2}\s*Verification\s*[:)]?\s*\*{0,2}\s*[:)]?.*$/gim, "");
		description = description.replace(/^\s*\*{0,2}\s*Verify\s+with\s*[:)]?\s*\*{0,2}\s*[:)]?.*$/gim, "");
		description = description.replace(/\s+/g, (m) => (m.includes("\n") ? m : " "));

		const stepIndex = steps.length;
		steps.push({
			index: stepIndex,
			title: title || `Step ${stepIndex + 1}`,
			description: description || "(see plan)",
			verification,
			verifyWith,
			status: "pending",
			retries: 0,
			noVerdictRetries: 0,
			lastVerdict: null,
			memory: "",
		});

		i = j;
	}

	return steps;
}

/**
 * Flip the checkbox for a step in the plan file.
 * mark: "x" (pass), "B" (blocked), "~" (skipped), " " (pending)
 */
async function setStepCheckbox(cwd: string, planFile: string, stepIndex: number, mark: "x" | "B" | "~" | " "): Promise<boolean> {
	const p = path.isAbsolute(planFile) ? planFile : path.join(getPlanDir(cwd), planFile);
	let content: string;
	try {
		content = await fs.promises.readFile(p, "utf-8");
	} catch {
		return false;
	}
	const lines = content.split("\n");
	const stepNumber = stepIndex + 1;
	let changed = false;

	for (let n = 0; n < lines.length; n++) {
		const line = lines[n];
		// Checkbox style: - [ ] Step N: ...
		const cb = line.match(/^(\s*-\s+)\[([ xXB~])\]\s*[*_]{0,3}\s*(Step\s+\d+[:.)]\s*.+)$/i);
		if (cb) {
			const numMatch = cb[3].match(/^Step\s+(\d+)[:.)]/i);
			if (numMatch && parseInt(numMatch[1], 10) === stepNumber) {
				lines[n] = `${cb[1]}[${mark}] ${stripEmphasis(cb[3])}`;
				changed = true;
				break;
			}
			continue;
		}
		// Legacy heading style: ### Step N: ...  (append an inline status marker)
		const hd = line.match(/^(###\s+)[*_]{0,3}\s*Step\s+(\d+)[:.)]\s*[*_]{0,3}\s*(.+)/i);
		if (hd) {
			const numMatch = hd[2];
			if (parseInt(numMatch, 10) === stepNumber) {
				const statusWord = mark === "x" ? "DONE" : mark === "B" ? "BLOCKED" : mark === "~" ? "SKIPPED" : "";
				if (statusWord && !lines[n].includes(statusWord)) {
					lines[n] = `${lines[n]} [${statusWord}]`;
				}
				changed = true;
				break;
			}
		}
	}

	if (!changed) return false;
	try {
		await fs.promises.writeFile(p, lines.join("\n"), "utf-8");
		return true;
	} catch {
		return false;
	}
}

/* ─────────────────────────────────────────────────────
   Model helpers
   ───────────────────────────────────────────────────── */

/** Canonical "provider/id" identifier for a model. */
function modelKey(model: AnyModel | undefined): string {
	if (!model) return "";
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve a model from a query string that may be "provider/id", "id", "provider",
 * or a select label like "ollama/llama3.1:8b (8k window)".
 */
function findModelByQuery(ctx: ExtensionContext, query: string | null | undefined): AnyModel | undefined {
	if (!query) return ctx.model;
	let q = query.trim();
	if (q.toLowerCase().includes("same as implement") || q.toLowerCase() === "same" || q.toLowerCase() === "current") {
		return ctx.model;
	}
	// Strip a trailing parenthetical (window/reasoning annotation) if present.
	const parenIdx = q.indexOf(" (");
	if (parenIdx > 0) q = q.slice(0, parenIdx).trim();

	const models = ctx.modelRegistry.getAvailable();
	// Exact "provider/id"
	let m = models.find((x) => `${x.provider}/${x.id}` === q);
	if (m) return m;
	// Exact "id"
	m = models.find((x) => x.id === q);
	if (m) return m;
	// Prefix match (label could start with "provider/id")
	m = models.find((x) => q.startsWith(`${x.provider}/${x.id}`));
	if (m) return m;
	// "provider" only -> first model in that provider
	m = models.find((x) => x.provider === q);
	if (m) return m;
	// Case-insensitive contains on id
	m = models.find((x) => q.toLowerCase().includes(x.id.toLowerCase()));
	if (m) return m;
	return undefined;
}

/** Build a human-readable label for a model, including window + reasoning. */
function modelLabel(model: AnyModel): string {
	const kw = Math.round(model.contextWindow / 1000);
	const reason = model.reasoning ? " reasoning" : "";
	return `${model.provider}/${model.id} (${kw}k window${reason})`;
}

function listModelOptions(ctx: ExtensionContext): AnyModel[] {
	// Prefer the session-scoped model list (the same set /scoped-models shows)
	// so the verifier picker lists only the models the user has enabled, not the
	// entire provider catalogue (e.g. every OpenRouter model). Fall back to the
	// full catalogue only when no scoping is configured (scopedModels is then empty).
	const scoped = ctx.scopedModels;
	if (scoped && scoped.length > 0) {
		return scoped.map((sm) => sm.model);
	}
	try {
		return ctx.modelRegistry.getAvailable();
	} catch {
		return [];
	}
}

/* ─────────────────────────────────────────────────────
   Prompt builders (minimal, per-phase)
   ───────────────────────────────────────────────────── */

function buildPlanInstructions(description: string): string {
	return [
		"You are **an expert planning agent for the Ralph implementation loop**. Follow this workflow: you MUST use the `present_plan` tool — never print the plan directly.",
		"",
		"## Phase 1 — Deep Research",
		"- Use the subagent tool (scout for code exploration, search for web research) and read/bash/find/grep to understand the codebase, patterns, dependencies, and constraints.",
		"- Do web searches if you need docs/APIs/libs/current info.",
		"",
		"## Phase 2 — Clarifying Questions",
		"If anything is ambiguous, ASK the user directly in your response as plain text. Present options and wait for the user's answer. You may ask follow-up questions. Loop Phases 1–2 as needed until you have enough for a solid plan.",
		"",
		"## Phase 3 — Create Plan in RALPH FORMAT",
		"Your plan MUST use the EXACT format below so /implement can turn it into a verifiable, long-running loop. Each step is a **checkbox item** the implementer checks off one at a time, and each step MUST have a **Verification** line (free text) and MAY have a **Verify with:** line (a model id for that step's verification).",
		"",
		"### Required format",
		"```markdown",
		`# Plan: ${description}`,
		"",
		"## Overview",
		"...",
		"",
		"## Architecture",
		"...",
		"",
		"## Steps",
		"- [ ] Step 1: <short imperative title>",
		"  <1–3 sentence description of exactly what to build or change>",
		"  **Verification:** <concrete, checkable way to confirm this step is done. e.g. 'running `npm test` passes; calling parseCsv(\"a,b\") returns [{a:1,b:2}]'>",
		"  **Verify with:** <OPTIONAL — a model id like 'ollama/llama3.1:8b' to verify THIS step; omit to use the global verifier>",
		"- [ ] Step 2: <...>",
		"  ...",
		"## Dependencies",
		"...",
		"",
		"## Risks",
		"...",
		"",
		"## Acceptance Criteria",
		"- [ ] ...",
		"```",
		"",
		"IMPORTANT: keep steps small and independently verifiable (a small local model should be able to complete each one in a single run). Prefer 5–15 focused steps over 3 big ones. Put each step's verification on its own **Verification:** line so it is unambiguous.",
		"",
		"## Phase 4 — Present & Complete",
		"Call `present_plan` with the COMPLETE plan (all sections). Do NOT implement anything — planning only. Your job ENDS when `present_plan` succeeds. STOP.",
		"**Do not implement, code, or write files beyond the plan itself.**",
	].join("\n");
}

/**
 * The prompt handed to the IMPLEMENT model for one step. Deliberately minimal:
 * only the current step + carry-forward note from the previous step.
 */
function buildImplementPrompt(state: RalphState, step: RalphStep): string {
	const prev = state.steps[step.index - 1];
	const carryForward = prev?.memory || "";
	return [
		`[RALPH IMPLEMENT · step ${step.index + 1}/${state.steps.length} of "${state.planTitle}"]`,
		"",
		"Do ONLY this one step, then STOP. Do not touch other steps. When finished, stop producing output — the loop will hand the work to an independent verifier (a different model).",
		"",
		`## STEP ${step.index + 1}: ${step.title}`,
		step.description,
		"",
		"## Carry-forward note from the previous step",
		carryForward ? carryForward : "(this is the first step — no prior context)",
		"",
		"## Guidance",
		"- Read the relevant files first, then write/edit the code to satisfy THIS step.",
		"- Keep changes minimal and focused on this step.",
		"- If the step is genuinely blocked (missing dependency, impossible without more info), leave a clear comment and STOP — do not invent work.",
		"- Do NOT call `submit_verification` — that tool is only for the verify phase (a different model).",
	].join("\n");
}

/**
 * The prompt handed to the VERIFIER model. It is an INDEPENDENT reviewer that may
 * be a different model than the implementer.
 */
function buildVerifyPrompt(state: RalphState, step: RalphStep, isReverify: boolean): string {
	return [
		`[RALPH VERIFY · step ${step.index + 1}/${state.steps.length} of "${state.planTitle}"]${isReverify ? " (re-verification)" : ""}`,
		"",
		`You are an INDEPENDENT VERIFIER (a different model from the implementer). Read what was written for step ${step.index + 1} and judge whether it is correct and complete. You do NOT write or edit code — you only verify.`,
		"",
		`## STEP ${step.index + 1}: ${step.title}`,
		step.description,
		"",
		"## Verification criteria",
		step.verification || "(No explicit criteria were given. Use your best judgment: confirm the step's description is fully and correctly satisfied, the code compiles/runs, and there are no obvious bugs)",
		"",
		"## How to verify",
		"- Read the relevant files. If the criteria mention a command or test, run it (you have bash/read/grep).",
		"- Be strict and specific: a vague 'looks fine' is not acceptable — cite what you checked.",
		"- You MUST call the `submit_verification` tool with your verdict: { pass, issues[], suggestedFixes[], carryForwardNotes }.",
		"- If pass=true: leave `issues` and `suggestedFixes` empty.",
		"- If pass=false: list concrete, actionable issues (one per problem) and, where known, concrete `suggestedFixes` (one per issue).",
		"- `carryForwardNotes` (required): a SHORT note (< 40 words) for the NEXT step — key facts the next implementer needs (files created, function signatures, assumptions). e.g. 'parseCsv() in src/csv.ts returns Row[]; assumes UTF-8.'",
		"- After calling submit_verification, STOP. The loop takes over.",
	].join("\n");
}

/**
 * The prompt handed to the IMPLEMENT model to FIX a step the verifier rejected.
 */
function buildFixPrompt(state: RalphState, step: RalphStep): string {
	const v = step.lastVerdict;
	const issues = v?.issues ?? [];
	const fixes = v?.fixes ?? [];
	const out: string[] = [
		`[RALPH FIX · step ${step.index + 1}/${state.steps.length} of "${state.planTitle}"]`,
		"",
		`The independent verifier REJECTED step ${step.index + 1}. Fix the issues below, then STOP — the loop will re-verify with a different model.`,
		"",
		`## STEP ${step.index + 1}: ${step.title}`,
		step.description,
		"",
		`## Issues flagged by the verifier`,
		issues.length ? issues.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(no specific issues listed — re-read the step and fix whatever the verifier likely found; be conservative)",
		"",
	];
	if (fixes.length) {
		out.push(
			"## Suggested fixes from the verifier",
			...fixes.map((s, i) => `   ${i + 1}. ${s}`),
			"",
		);
	}
	if (v?.notes) {
		out.push(`## Verifier's carry-forward note`, v.notes, "");
	}
	out.push(
		"## Guidance",
		"- Fix ONLY the flagged issues. Do not touch other steps.",
		"- Keep changes minimal and focused.",
		"- Do NOT call `submit_verification` — that is only for the verify phase.",
		"- If you cannot fix an issue, leave a clear comment and STOP so the verifier can mark it blocked.",
	);
	return out.join("\n");
}

/**
 * Custom instructions for ctx.compact() at a phase boundary. Told to keep ONLY
 * the essentials so a small local model's context stays minimal.
 */
function buildCompactionInstructions(phase: Phase, state: RalphState, step: RalphStep | undefined): string {
	const stepNum = step ? step.index + 1 : "?";
	const lines: string[] = [
		`This is the Ralph implementation loop for plan "${state.planTitle}". The context is intentionally compacted aggressively to fit a small local model.`,
		`Preserve ONLY the essentials below. Drop or heavily summarize everything else.`,
		"",
		`Preserve:`,
		`  - Plan title: ${state.planTitle}`,
		`  - Current phase: ${phase}`,
		`  - Current step: ${stepNum}`,
		`  - Current step title: ${step ? step.title : "(n/a)"}`,
	];
	if (phase === "implement" && step) {
		const prev = state.steps[step.index - 1];
		lines.push(`  - Carry-forward note from previous step: ${prev?.memory || "(first step)"}`);
		lines.push(`  - This step's goal: ${step.description}`);
	}
	if (phase === "verify" && step) {
		lines.push(`  - Verification criteria: ${step.verification || "(best judgment)"}`);
		lines.push(`  - Carry-forward note so far: ${step.memory || "(none yet)"}`);
	}
	if (phase === "fix" && step && step.lastVerdict) {
		const v = step.lastVerdict;
		lines.push(`  - Issues to fix: ${(v.issues ?? []).join("; ") || "(none listed)"}`);
		lines.push(`  - Suggested fixes: ${(v.fixes ?? []).join("; ") || "(use judgment)"}`);
	}
	lines.push("", "The next phase's full prompt is sent right after this compaction — do not try to re-derive or expand it here.");
	return lines.join("\n");
}

/* ─────────────────────────────────────────────────────
   Progress UI
   ───────────────────────────────────────────────────── */

function updateProgress(ctx: ExtensionContext): void {
	if (!ralphState) return;
	const s = ralphState;
	const done = s.steps.filter((x) => x.status === "pass").length;
	const blocked = s.steps.filter((x) => x.status === "blocked").length;
	const skipped = s.steps.filter((x) => x.status === "skipped").length;
	const total = s.steps.length;
	const phase = s.phase;

	ctx.ui.setStatus(
		"plan-wizard",
		ctx.ui.theme.fg("accent", `⟳ ${done}/${total} ${phase === "idle" ? "ready" : phase}`),
	);

	if (ctx.hasUI && ctx.mode === "tui") {
		const lines: string[] = [`Plan: ${s.planTitle}`, `Progress: ${done}/${total} · phase: ${phase} · ${blocked} blocked · ${skipped} skipped`, ""];
		for (const step of s.steps.slice(0, 12)) {
			const label = step.title.slice(0, 62);
			let marker = "○";
			let color = "muted";
			if (step.index === s.currentStep && phase !== "done" && phase !== "stopped") {
				marker = "▶";
				color = "warning";
			} else if (step.status === "pass") {
				marker = "✓";
				color = "success";
			} else if (step.status === "blocked") {
				marker = "B";
				color = "error";
			} else if (step.status === "skipped") {
				marker = "~";
				color = "muted";
			} else if (step.status === "in_progress") {
				marker = "◷";
				color = "dim";
			} else {
				marker = "○";
				color = "dim";
			}
			lines.push(`   ${ctx.ui.theme.fg(color, marker)} ${ctx.ui.theme.fg("dim", label)}`);
		}
		if (s.steps.length > 12) {
			lines.push(`   ${ctx.ui.theme.fg("muted", `... and ${s.steps.length - 12} more`)}`);
		}
		ctx.ui.setWidget("plan-wizard", lines);
	}
}

/* ─────────────────────────────────────────────────────
   present_plan tool schema
   ───────────────────────────────────────────────────── */

const presentPlanSchema = Type.Object({
	plan: Type.String({ description: "Full markdown text of the plan (in RALPH FORMAT) to review and approve" }),
});
type PresentPlanParams = Static<typeof presentPlanSchema>;

/* ─────────────────────────────────────────────────────
   submit_verification tool schema
   ───────────────────────────────────────────────────── */

const submitVerificationSchema = Type.Object({
	pass: Type.Boolean({ description: "true = the step satisfies its verification criteria; false = issues were found" }),
	issues: Type.Array(Type.String({ description: "A specific, actionable problem that prevents the step from passing (empty if pass=true)" }), {
		description: "Concrete issues found. One per problem. Empty if pass=true.",
	}),
	suggestedFixes: Type.Array(Type.String({ description: "A concrete fix for the corresponding issue, aligned index-wise (empty if unknown or if pass=true)" }), {
		description: "Concrete suggested fixes. One per issue (aligned by index). May be empty if unsure.",
	}),
	carryForwardNotes: Type.String({
		description: "A SHORT note (< 40 words) for the NEXT step: files created, function signatures, key assumptions the next implementer must know. REQUIRED.",
	}),
});
type SubmitVerificationParams = Static<typeof submitVerificationSchema>;

/* ─────────────────────────────────────────────────────
   The Ralph loop (code-driven state machine)
   ─────────────────────────────────────────────────────
   Driven by the `agent_settled` event. Each phase is exactly one agent run;
   the loop transitions phase -> compact -> next phase, switching models and
   sending a fresh, minimal prompt for each phase.
   ───────────────────────────────────────────────────── */

/**
 * After a phase's run settles, move to the next phase:
 *  1. switch the active model (pi.setModel),
 *  2. compact the context,
 *  3. (on compact complete) send the next phase's minimal prompt,
 *  4. release the re-entrancy guard.
 *
 * The actual transition + prompt is produced by `nextPromptFor`.
 */
async function goToPhase(ctx: ExtensionContext, phase: Phase): Promise<void> {
	const state = ralphState;
	if (!state) {
		loopInFlight = false;
		return;
	}
	state.phase = phase;
	const step = state.steps[state.currentStep];

	// 1. Choose the model for this phase.
	let modelQuery: string | null = null;
	if (phase === "verify") {
		const s = state.steps[state.currentStep];
		modelQuery = s?.verifyWith || state.verifierModel;
	} else {
		// implement or fix always uses the implement model
		modelQuery = state.implementModel;
	}
	const targetModel = findModelByQuery(ctx, modelQuery);
	if (targetModel && targetModel !== ctx.model) {
		const ok = await P().setModel(targetModel);
		if (!ok) {
			ctx.ui.notify(`Could not switch to ${modelQuery || "(default)"}. Continuing with current model.`, "warning");
		}
	}

	// 2 + 3. Compact, then (on complete) send the next prompt and release the guard.
	const compactionMsg = buildCompactionInstructions(phase, state, step);
	const nextPrompt = buildNextPrompt(phase, state, step);
	let fired = false;
	const fireNext = () => {
		if (fired) return;
		fired = true;
		loopInFlight = false;
		try {
			P().sendUserMessage(nextPrompt);
			updateProgress(ctx);
		} catch (e) {
			ctx.ui.notify(`Failed to send ${phase} prompt: ${(e as Error).message}`, "error");
		}
	};
	try {
		ctx.compact({
			customInstructions: compactionMsg,
			onComplete: () => fireNext(),
			onError: (err) => {
				ctx.ui.notify(`Compaction failed: ${err.message}. Continuing without compaction.`, "warning");
				fireNext();
			},
		});
	} catch (e) {
		ctx.ui.notify(`Compaction error: ${(e as Error).message}. Continuing.`, "warning");
		fireNext();
	}
}

function buildNextPrompt(phase: Phase, state: RalphState, step: RalphStep | undefined): string {
	switch (phase) {
		case "implement":
			return step ? buildImplementPrompt(state, step) : "Implementation complete.";
		case "verify": {
			const s = state.steps[state.currentStep];
			return s ? buildVerifyPrompt(state, s, s.noVerdictRetries > 0 || s.retries > 0) : "Nothing to verify.";
		}
		case "fix": {
			const s = state.steps[state.currentStep];
			return s ? buildFixPrompt(state, s) : "Nothing to fix.";
		}
		default:
			return "Implementation complete.";
	}
}

/**
 * Decide and execute the transition from the CURRENT (just-finished) phase to the
 * next. Invoked from the agent_settled handler.
 */
async function advanceLoop(ctx: ExtensionContext): Promise<void> {
	const state = ralphState;
	if (!state || !ralphActive) {
		loopInFlight = false;
		return;
	}

	switch (state.phase) {
		// ── Implement phase just finished -> Verify ──
		case "implement": {
			const step = state.steps[state.currentStep];
			await goToPhase(ctx, "verify");
			// verify uses the same step
			void step;
			return;
		}

		// ── Fix phase just finished -> re-Verify ──
		case "fix": {
			await goToPhase(ctx, "verify");
			return;
		}

		// ── Verify phase just finished -> branch on the verdict ──
		case "verify": {
			const step = state.steps[state.currentStep];
			if (!step.lastVerdict) {
				// Verifier finished without calling submit_verification. Re-verify up to
				// (maxVerifyRetries) times; then treat as a failure and go to fix.
				if (step.noVerdictRetries < state.maxVerifyRetries) {
					step.noVerdictRetries += 1;
					await writeRalphState(state);
					ctx.ui.notify("Verifier did not submit a verdict. Re-verifying…", "info");
					await goToPhase(ctx, "verify");
					return;
				}
				// Give up: synthesize a failure verdict so the loop can continue.
				step.lastVerdict = {
					pass: false,
					issues: ["The verifier finished without calling submit_verification."],
					fixes: [],
					notes: "",
				};
				await writeRalphState(state);
			}
			const verdict = step.lastVerdict;

			if (verdict.pass) {
				// ✅ PASS — check the box, store carry-forward note, advance to next step.
				step.status = "pass";
				step.memory = verdict.notes || step.memory;
				await setStepCheckbox(ctx.cwd, state.planFile, step.index, "x");
				await writeRalphState(state);
				ctx.ui.notify(`Step ${step.index + 1} "${step.title}" — PASS ✅`, "success");
				await nextStepOrFinish(ctx);
				return;
			}

			// ❌ FAIL — retry up to maxVerifyRetries, else mark blocked and continue.
			step.status = "in_progress";
			step.retries += 1;
			await writeRalphState(state);
			if (step.retries > state.maxVerifyRetries) {
				// Exceeded retries: mark BLOCKED (checkbox -> B) and continue to the next step.
				step.status = "blocked";
				await setStepCheckbox(ctx.cwd, state.planFile, step.index, "B");
				await writeRalphState(state);
				ctx.ui.notify(`Step ${step.index + 1} "${step.title}" — FAILED after ${step.retries} attempts; marked BLOCKED. Continuing to the next step.`, "error");
				await nextStepOrFinish(ctx);
				return;
			}
			// Else: go to the FIX phase (implement model).
			ctx.ui.notify(`Step ${step.index + 1} "${step.title}" — FAILED (attempt ${step.retries}/${state.maxVerifyRetries}). Moving to the fix phase.`, "warning");
			await goToPhase(ctx, "fix");
			return;
		}

		// ── Already done/stopped ──
		case "done":
		case "stopped":
		case "idle":
		default: {
			finishLoop(ctx, state.phase === "stopped" ? "stopped" : "done");
			return;
		}
	}
}

/**
 * Move to the next pending step, or finish the whole plan.
 */
async function nextStepOrFinish(ctx: ExtensionContext): Promise<void> {
	const state = ralphState;
	if (!state) return;
	const nextIndex = state.currentStep + 1;
	if (nextIndex >= state.steps.length) {
		const pass = state.steps.filter((s) => s.status === "pass").length;
		const blocked = state.steps.filter((s) => s.status === "blocked").length;
		const skipped = state.steps.filter((s) => s.status === "skipped").length;
		state.phase = "done";
		await writeRalphState(state);
		finishLoop(ctx, "done");
		ctx.ui.notify(`Plan "${state.planTitle}" complete — ${pass} passed, ${blocked} blocked, ${skipped} skipped.`, "success");
		return;
	}
	// Advance to the next step.
	state.currentStep = nextIndex;
	state.steps[nextIndex].status = "in_progress";
	await writeRalphState(state);
	await goToPhase(ctx, "implement");
}

function finishLoop(ctx: ExtensionContext | undefined, reason: "done" | "stopped"): void {
	if (!ctx) return;
	ralphActive = false;
	loopInFlight = false;
	if (ralphState) {
		ralphState.phase = reason === "stopped" ? "stopped" : "done";
		void writeRalphState(ralphState);
	}
	ctx.ui.setStatus(
		"plan-wizard",
		ctx.ui.theme.fg(reason === "stopped" ? "warning" : "success", reason === "stopped" ? "■ stopped" : "✓ complete"),
	);
	ctx.ui.setWidget("plan-wizard", undefined);
}

/* ─────────────────────────────────────────────────────
   /implement entry — start or resume a Ralph loop
   ───────────────────────────────────────────────────── */

async function startRalphLoop(cwd: string, planFilePath: string, ctx: ExtensionContext, opts?: { resume?: boolean }): Promise<void> {
	// 1. Read and parse the plan.
	let planText: string;
	try {
		planText = await fs.promises.readFile(planFilePath, "utf-8");
	} catch (err) {
		ctx.ui.notify(`Could not read plan file: ${(err as Error).message}`, "error");
		return;
	}
	if (!planText.trim()) {
		ctx.ui.notify("Plan file is empty.", "warning");
		return;
	}
	const titleMatch = planText.match(/^#\s+Plan:\s*(.+)$/mi);
	const planTitle = titleMatch ? titleMatch[1].trim() : path.basename(planFilePath, ".md");

	// 2. Parse steps.
	const steps = parseRalphSteps(planText);
	if (steps.length === 0) {
		ctx.ui.notify(
			"Could not parse any steps from the plan. Use the RALPH FORMAT: '- [ ] Step N: title' with a 'Verification:' line per step.",
			"error",
		);
		return;
	}

	// 3. Load settings + resolve the verifier model.
	const settings = await loadSettings(cwd);
	const implementModel = modelKey(ctx.model) || "(current)";
	let verifierModel = implementModel;

	if (opts?.resume) {
			// Resume existing state if present.
		const existing = await readRalphState(cwd, planFilePath);
		if (existing && existing.phase !== "done") {
			ralphState = existing;
			ralphState.currentStep = clampCurrentStep(existing);
			ralphActive = true;
			ralphState.stopped = false; // a resumed loop is active again
			const resumeStep = ralphState.steps[ralphState.currentStep];
			const resumePrompt =
					ralphState.phase === "verify"
						? buildVerifyPrompt(ralphState, resumeStep, true)
						: ralphState.phase === "fix"
							? buildFixPrompt(ralphState, resumeStep)
							: buildImplementPrompt(ralphState, resumeStep);
			ctx.ui.notify(`Resuming loop: ${planTitle} (step ${ralphState.currentStep + 1}/${ralphState.steps.length}, phase ${ralphState.phase}).`, "info");
			updateProgress(ctx);
			// Switch to the model for the resumed phase so a mid-verify resume
			// uses the verifier, not the default implement model.
			const resumeModelQuery =
				ralphState.phase === "verify"
					? (resumeStep?.verifyWith || ralphState.verifierModel)
					: ralphState.implementModel;
			const resumeTarget = findModelByQuery(ctx, resumeModelQuery);
			if (resumeTarget && resumeTarget !== ctx.model) {
				await P().setModel(resumeTarget);
			}
			// Send a prompt to actually resume the interrupted phase — without this the
			// loop would sit idle, since there is no run in progress to trigger agent_settled.
			P().sendUserMessage(resumePrompt);
			return;
		}
	}

	// 4. Decide the verifier.
	//    - If a global default is set in settings, use it.
	//    - Otherwise, ask the user to pick one (or "same as implement").
	let verifierResolved = false;
	if (settings.defaultVerifierModel) {
		verifierModel = settings.defaultVerifierModel;
		verifierResolved = true;
	}
	if (!verifierResolved && ctx.hasUI && ctx.mode === "tui") {
		const models = listModelOptions(ctx);
		const options = [`Same as implement model (${implementModel})`];
		for (const m of models) options.push(modelLabel(m));
		ctx.ui.notify(`Choose the verifier model for "${planTitle} (default: settings or the implement model).`, "info");
		const choice = await ctx.ui.select("Verifier model (a DIFFERENT model reviews each step)", options);
		if (!choice) {
			ctx.ui.notify("Verifier selection cancelled.", "warning");
			return;
		}
		const model = findModelByQuery(ctx, choice) || ctx.model;
		verifierModel = modelKey(model) || implementModel;
		// Persist the choice so future /implement runs reuse it.
		if (choice.toLowerCase().includes("same as implement")) {
			settings.defaultVerifierModel = null;
		} else {
			settings.defaultVerifierModel = verifierModel;
		}
		await saveSettings(cwd, settings);
	} else if (!verifierResolved) {
		// Non-TUI: fall back to the implement model (no separate verifier).
		verifierModel = implementModel;
	}

	// 5. Build the state.
	const state: RalphState = {
		planFile: planFilePath,
		cwd, // project root — needed by writeRalphState to locate the state file
		planTitle,
		phase: "implement",
		currentStep: 0,
		implementModel,
		verifierModel,
		maxVerifyRetries: settings.maxVerifyRetries,
		stopped: false,
		steps: steps.map((s) => ({ ...s, status: "pending", retries: 0, noVerdictRetries: 0, lastVerdict: null, memory: "" })),
	};
	ralphState = state;
	ralphState.steps[0].status = "in_progress";
	await writeRalphState(state);
	ralphActive = true;

	// 6. Send the first implement prompt.
	const firstPrompt = buildImplementPrompt(state, state.steps[0]);
	ctx.ui.notify(`Starting Ralph loop: ${planTitle} (${state.steps.length} steps, verifier ${verifierModel}).`, "info");
	updateProgress(ctx);
	P().sendUserMessage(firstPrompt);
}

/** If a state was mid-step, make sure currentStep points at a real in-progress step. */
function clampCurrentStep(state: RalphState): number {
	if (state.currentStep < 0) return 0;
	if (state.currentStep >= state.steps.length) return Math.max(0, state.steps.length - 1);
	return state.currentStep;
}

/* ─────────────────────────────────────────────────────
   Extension entry
   ───────────────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	// Assign the live ExtensionAPI so module-level helpers (goToPhase,
	// startRalphLoop) can reach it through P().
	__pi = pi;

	/* ── /plan ───────────────────────────────────────────── */
	pi.registerCommand("plan", {
		description: "Start the planning workflow (produces a RALPH-format plan). Usage: /plan <task>",
		handler: async (args, ctx) => {
			if (!args || !args.trim()) {
				ctx.ui.notify("Usage: /plan <description> to start planning", "info");
				return;
			}
			planDescription = args.trim();
			planMode = true;
			ctx.ui.setStatus("plan-wizard", ctx.ui.theme.fg("warning", "planning…"));
			const scopedMessage = `[Planning mode — do NOT implement. Use /implement later.]\n\n${planDescription}`;
			pi.sendUserMessage(scopedMessage);
		},
	});

	/* ── present_plan tool ───────────────────────────────── */
	pi.registerTool({
		name: "present_plan",
		label: "Present Plan for Review",
		description:
			"Show the generated RALPH-format plan to the user in a full-screen editor for approval/edit/cancel.\n" +
			"- Ctrl+A: Approve as-is and save to .pi/plans/.\n" +
			"- Ctrl+S / Alt+Enter: Save the user's edits to .pi/plans/.\n" +
			"- Esc: Cancel — the user will give feedback and you should revise.",
		parameters: presentPlanSchema,
		async execute(_toolCallId, params: PresentPlanParams, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Cannot show plan dialog (no interactive TUI)." }],
					details: {} as Record<string, never>,
				};
			}
			const edited = await ctx.ui.editor("Review & Approve Plan", params.plan);
			if (edited === null) {
				return {
					content: [{ type: "text", text: "User cancelled — did not approve the plan. Ask about their concerns and revise." }],
					details: {} as Record<string, never>,
				};
			}
			try {
				const dir = getPlanDir(ctx.cwd);
				await fs.promises.mkdir(dir, { recursive: true });
				const description = planDescription ?? "untitled-plan";
				const baseName = generatePlanFilename(description);
				await fs.promises.writeFile(path.join(dir, baseName), edited.trim(), "utf-8");
				planMode = false;
				planDescription = null;
				ctx.ui.notify(`Plan saved to .pi/plans/${baseName}`, "success");
				return {
					content: [
						{
							type: "text",
							text: `Plan approved and saved to .pi/plans/${baseName}\n\nSTOP — planning is complete. Do NOT implement this plan.\nThe user will run /implement to execute it as a Ralph loop.`,
						},
					],
					details: {} as Record<string, never>,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to save plan: ${(err as Error).message}` }],
					details: {} as Record<string, never>,
				};
			}
		},
		renderCall(args, theme) {
			const preview = (args.plan as string)
				.split("\n")
				.slice(0, 2)
				.join("\n");
			return new Text(
				theme.fg("toolTitle", theme.bold("present_plan ")) +
					theme.fg("muted", "showing plan for review…") +
					"\n" +
					theme.fg("dim", preview),
				0,
				0,
			);
		},
		renderResult(result, _opts, theme) {
			const msg = result.content[0]?.text ?? "";
			if (msg.includes("cancelled")) {
				return new Text(theme.fg("warning", "Plan cancelled — user needs clarification"), 0, 0);
			}
			const match = msg.match(/\.pi\/plans\/([^)]+)/);
			return new Text(theme.fg("success", "Plan saved") + (match ? ` "${theme.fg("accent", match[1])}"` : ""), 0, 0);
		},
	});

	/* ── /implement ──────────────────────────────────────── */
	pi.registerCommand("implement", {
		description: "Run a plan as a verified Ralph loop. Usage: /implement [plan_file | --resume]",
		getArgumentCompletions: async (prefix) => {
			try {
				const files = await listPlanFiles(process.cwd());
				const filtered = files.filter((f) => f.startsWith(prefix));
				return filtered.length > 0 ? filtered.map((f) => ({ value: f, label: f })) : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			// --resume: resume the most recent incomplete loop.
			if (args && args.trim().toLowerCase() === "--resume") {
				const dir = getImplementDir(ctx.cwd);
				let latest: RalphState | null = null;
				let latestMtime = 0;
				try {
					const entries = await fs.promises.readdir(dir);
					for (const e of entries) {
						if (!e.endsWith(".json")) continue;
						const p = path.join(dir, e);
						try {
							const c = await fs.promises.readFile(p, "utf-8");
							const s = JSON.parse(c) as RalphState;
							if (!s || !Array.isArray(s.steps)) continue;
							if (s.phase === "done") continue;
							const st = await fs.promises.stat(p);
							if (st.mtimeMs > latestMtime) {
								latestMtime = st.mtimeMs;
								latest = s;
							}
						} catch {
							/* ignore */
						}
					}
				} catch {
					/* dir missing */
				}
				if (!latest) {
					ctx.ui.notify("No incomplete Ralph loop found to resume.", "info");
					return;
				}
				await startRalphLoop(ctx.cwd, latest.planFile, ctx, { resume: true });
				return;
			}

			// No args: browse & select.
			if (!args || !args.trim()) {
				if (ctx.hasUI && ctx.mode === "tui") {
					const availablePlans = await listPlanFiles(ctx.cwd);
					if (availablePlans.length === 0) {
						ctx.ui.notify("No plans found in .pi/plans/. Create one with /plan first.", "info");
						return;
					}
					const items = await Promise.all(
						availablePlans.map(async (f) => {
							const full = path.join(getPlanDir(ctx.cwd), f);
							try {
								const c = await fs.promises.readFile(full, "utf-8");
								const t = c.match(/^#\s+Plan:\s*(.+)$/mi);
								return `${f} — ${t ? t[1].trim() : "(no title)"}`;
							} catch {
								return f;
							}
						}),
					);
					const choice = await ctx.ui.select("Select a plan to implement", items);
					if (!choice) return;
					const chosenFile = choice.split(" — ")[0].trim();
					await startRalphLoop(ctx.cwd, chosenFile, ctx);
				} else {
					ctx.ui.notify("Usage: /implement <plan_file> to run a plan", "info");
				}
				return;
			}

			// A plan file was given.
			const planFile = args.trim();
			const fullPlanPath = path.isAbsolute(planFile) ? planFile : path.join(getPlanDir(ctx.cwd), planFile);
			await startRalphLoop(ctx.cwd, fullPlanPath, ctx);
		},
	});

	/* ── submit_verification tool ────────────────────────── */
	pi.registerTool({
		name: "submit_verification",
		label: "Submit Verification Verdict",
		description:
			"Called by the VERIFIER (a different model) to report the pass/fail verdict for the current step. " +
			"Call this EXACTLY ONCE per verify phase. After calling it, STOP — the loop takes over. Do not call this during the implement or fix phases.",
		parameters: submitVerificationSchema,
		async execute(_toolCallId, params: SubmitVerificationParams, _signal, _onUpdate, ctx) {
			if (!ralphActive || !ralphState) {
				return {
					content: [{ type: "text", text: "No active Ralph loop — this tool is only for the /implement verify phase." }],
					details: {} as Record<string, never>,
				};
			}
			if (ralphState.phase !== "verify") {
				return {
					content: [{ type: "text", text: `Not in the verify phase (current phase: ${ralphState.phase}). Do not call submit_verification now — the loop will route you correctly.` }],
					details: {} as Record<string, never>,
				};
			}
			const step = ralphState.steps[ralphState.currentStep];
			if (!step) {
				return {
					content: [{ type: "text", text: "No current step to verify." }],
					details: {} as Record<string, never>,
				};
			}
			step.lastVerdict = {
				pass: params.pass,
				issues: params.issues,
				fixes: params.suggestedFixes,
				notes: params.carryForwardNotes || "",
			};
			if (params.pass) step.memory = params.carryForwardNotes || step.memory;
			try {
				await writeRalphState(ralphState);
			} catch (e) {
				ctx.ui.notify(`Warning: could not persist verdict: ${(e as Error).message}`, "warning");
			}
			const summary = params.pass
				? "PASS ✅"
				: `FAIL ❌ (${params.issues.length} issue(s))`;
			return {
				content: [
					{
						type: "text",
						text: `Verdict recorded: ${summary}\n\nSTOP. Do not make any further tool calls, edits, or output — the Ralph loop is now taking over and will run the next phase (fix or the next step). Calling submit_verification again in this run has no effect.`,
					},
				],
				details: {} as Record<string, never>,
			};
		},
		renderCall(args, theme) {
			const p = args as SubmitVerificationParams;
			return new Text(
				theme.fg("toolTitle", theme.bold("submit_verification ")) +
					theme.fg(p.pass ? "success" : "error", p.pass ? "PASS ✅" : "FAIL ❌") +
					` (${(p.issues || []).length} issue(s))`,
				0,
				0,
			);
		},
		renderResult(result, _opts, theme) {
			const msg = result.content[0]?.text ?? "";
			const pass = msg.includes("PASS");
			return new Text(theme.fg(pass ? "success" : "error", pass ? "Verdict: PASS ✅" : "Verdict: FAIL ❌"), 0, 0);
		},
	});

	/* ── /implement-stop ─────────────────────────────────── */
	pi.registerCommand("implement-stop", {
		description: "Stop the current Ralph loop. Usage: /implement-stop",
		handler: async (_args, ctx) => {
			if (!implementMode) {
				ctx.ui.notify("No Ralph loop in progress.", "info");
				return;
			}
			implementMode = false;
			ralphActive = false;
			loopPaused = true;
			loopInFlight = false;
			if (ralphState) {
				ralphState.stopped = true;
				// keep the real phase (implement/verify/fix) so /implement --resume can
				// continue from where it left off; 'stopped' is only a was-halted marker.
				void writeRalphState(ralphState);
			}
			ctx.ui.setStatus("plan-wizard", ctx.ui.theme.fg("warning", "■ stopped"));
			ctx.ui.setWidget("plan-wizard", undefined);
			ctx.ui.notify("Ralph loop stopped by user. Re-run /implement --resume to continue.", "warning");
			// Tell the model to stop, without triggering a new turn.
			try {
				pi.sendMessage(
					{
						customType: "ralph-stop",
						content: "The user stopped the Ralph loop. Do not continue any remaining steps. Halt.",
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch {
				/* ignore */
			}
		},
	});

	/* ── /plan-settings ──────────────────────────────────── */
	pi.registerCommand("plan-settings", {
		description: "Configure the Ralph loop: default verifier model and max verify retries. Usage: /plan-settings",
		handler: async (_args, ctx) => {
			const settings = await loadSettings(ctx.cwd);

			// Verifier model.
			const models = listModelOptions(ctx);
			const options = ["Same as implement model (Recommended)"];
			for (const m of models) options.push(modelLabel(m));
			const vChoice = await ctx.ui.select("Default verifier model (the model that reviews each step)", options);
			if (!vChoice) return;
			if (vChoice.toLowerCase().includes("same as implement")) {
				settings.defaultVerifierModel = null;
			} else {
				const m = findModelByQuery(ctx, vChoice);
				settings.defaultVerifierModel = m ? modelKey(m) : vChoice;
			}

			// Max verify retries.
			const retryChoice = await ctx.ui.select("Max verify retries per step before marking BLOCKED and moving on", [
				"1",
				"2",
				"3 (Recommended)",
				"4",
				"5",
			]);
			if (!retryChoice) return;
			settings.maxVerifyRetries = parseInt(retryChoice, 10) || 3;

			await saveSettings(ctx.cwd, settings);
			ctx.ui.notify(
				`Settings saved — verifier: ${settings.defaultVerifierModel ?? "same as implement"}, max retries: ${settings.maxVerifyRetries}.`,
				"success",
			);
		},
	});

	/* ── before_agent_start (plan mode only) ─────────────── */
	pi.on("before_agent_start", async (_event, ctx) => {
		// Clear stale status if neither mode is active.
		if (!planMode && !implementMode && !ralphActive) {
			ctx.ui.setStatus("plan-wizard", undefined);
			ctx.ui.setWidget("plan-wizard", undefined);
			return;
		}
		// Plan mode: inject planning instructions each turn so the model stays on-task.
		if (planMode && planDescription) {
			const sysPrompt = buildPlanInstructions(planDescription);
			const fullPrompt =
				"[PLAN WIZARD ACTIVE]\n\n" +
				sysPrompt +
				"\n\nKey reminders:" +
				"\n- Use subagent (scout for code exploration, search for web research)." +
				"\n- If you need clarification, ask the user directly in your response and wait for the answer." +
				"\n- Produce the plan in RALPH FORMAT (checkbox steps + a Verification: line per step + optional Verify with:)." +
				"\n- **CRITICAL:** You MUST call the `present_plan` tool. Do NOT print the plan in a message." +
				"\n- Your job ENDS when present_plan succeeds. STOP and do not implement.";
			return {
				message: {
					customType: "plan-wizard-context",
					content: fullPrompt,
					display: true,
				},
			};
		}
		// Ralph loop: the per-phase prompt is sent via sendUserMessage, not injected here.
		return undefined;
	});

	/* ── agent_settled — the Ralph loop driver ───────────── */
	pi.on("agent_settled", async (_event, ctx) => {
		// Plan mode: detect completion (model called present_plan) and clean up.
		if (planMode) {
			// The planning run ends here; present_plan already cleared planMode on success.
			// If we're still in plan mode, the run ended without present_plan — re-remind once.
			return;
		}
		if (!ralphActive || !ralphState) return;
		if (loopPaused) return;
		if (loopInFlight) return;

		loopInFlight = true;
		try {
			// Re-read from disk in case the verifier updated the state.
			const fresh = await readRalphState(ctx.cwd, ralphState.planFile);
			if (fresh) ralphState = fresh;
			await advanceLoop(ctx);
		} catch (e) {
			console.error("ralph loop error:", e);
			if (ctx) ctx.ui.notify(`Ralph loop error: ${(e as Error).message}`, "error");
			loopInFlight = false;
		}
	});

	/* ── session_start — resume an incomplete loop ───────── */
	pi.on("session_start", async (_event, ctx) => {
		// Scan for the most recent incomplete (non-stopped, non-done) loop and resume it.
		const dir = getImplementDir(ctx.cwd);
		try {
			const entries = await fs.promises.readdir(dir);
			let latest: RalphState | null = null;
			let latestMtime = 0;
			for (const e of entries) {
				if (!e.endsWith(".json")) continue;
				const p = path.join(dir, e);
				try {
					const c = await fs.promises.readFile(p, "utf-8");
					const s = JSON.parse(c) as RalphState;
					if (!s || !Array.isArray(s.steps)) continue;
					if (s.phase === "done") continue;
					const st = await fs.promises.stat(p);
					if (st.mtimeMs > latestMtime) {
						latestMtime = st.mtimeMs;
						latest = s;
					}
				} catch {
					/* ignore */
				}
			}
			if (latest) {
					// Peek only — do NOT auto-resume. Auto-resume would set ralphActive
					// without sending a prompt, leaving the loop visibly "stuck". The
					// user resumes explicitly with /implement --resume.
					const cs = clampCurrentStep(latest);
					ctx.ui.notify(`An incomplete Ralph loop exists: "${latest.planTitle}" (step ${cs + 1}/${latest.steps.length}, phase ${latest.phase}). Run "/implement --resume" to continue it.`, "info");
			}
		} catch {
			/* no implement dir yet */
		}
	});

	/* ── session_shutdown — cleanup ──────────────────────── */
	pi.on("session_shutdown", async () => {
		planMode = false;
		planDescription = null;
		implementMode = false;
		ralphActive = false;
		loopPaused = false;
		loopInFlight = false;
	});
}

/* ─────────────────────────────────────────────────────
   Plan-mode-only globals and helpers
   ───────────────────────────────────────────────────── */

let planMode = false;
let planDescription: string | null = null;
// Implement-mode flag mirrors ralphActive but is kept for /implement-stop + before_agent_start.
let implementMode = false;

async function listPlanFiles(cwd: string): Promise<string[]> {
	const dir = getPlanDir(cwd);
	try {
		const entries = await fs.promises.readdir(dir);
		return entries.filter((e) => e.endsWith(".md"));
	} catch {
		return [];
	}
}

