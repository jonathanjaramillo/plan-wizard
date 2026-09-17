# pi-plan-wizard

Agentic planning + **verified implementation loop** for [pi](https://pi.dev).

- **`/plan`** — deep research → clarifying questions → structured plan, saved as a **RALPH-format** plan.
- **`/implement`** — runs that plan as a *code-driven, verified state machine* ("Ralph" loop) tuned for **small local models with limited context windows**.

---

## Usage

### Plan

```
/plan <task description>
```

For example:

```
/plan build a CLI tool that tracks project dependencies using graphviz
```

### Implement (verified Ralph loop)

```
/implement <plan_file>        run a plan as a Ralph loop
/implement --resume           resume the most recent incomplete/stopped loop
/implement-stop               stop the active loop (resume later)
```

`<plan_file>` is a plan saved by `/plan` (a markdown file in `.pi/plans/`). Example:

```
/implement .pi/plans/2026-06-14-cli-deps-tool.md
```

---

## Plan creation flow (`/plan`)

1. **You type** `/plan <description>` in pi.
2. **Research phase** — the agent automatically kicks off:
   - codebase exploration via the `scout` subagent,
   - web searches for docs, APIs, libraries via the `search` subagent,
   - direct reads with `read`, `bash`, `find`, `grep` as needed.
3. **Questions phase** — if anything is ambiguous, the agent asks clarifying questions in the chat. Just text your response.
4. **Loop** — steps 2–3 repeat until the agent has enough for a solid plan.
5. **Present** — the agent calls `present_plan`, opening a full-screen editor:
   - **Ctrl+A** – approve as-is, save to `.pi/plans/`.
   - **Ctrl+S / Alt+Enter** – save with your edits, write to `.pi/plans/`.
   - **Esc** – cancel; the agent asks about concerns and revises.
6. **Iterate or done** — if you suggest edits, it loops back through research/questions as needed. When approved, you'll see a success notification. **Planning stops here — no code is written.** Execution is a separate `/implement` step.

---

## RALPH-format plans

A `/plan` must follow a strict format so `/implement` can turn it into a *verifiable, long-running loop*. Each step is a **checkbox item** the implementer ticks off one at a time.

```markdown
## Steps

- [ ] Step 1: Create parseCsv() in src/csv.ts
  Reads a file path and returns an array of row objects.
   **Verification:** `node -e "require('./src/csv').parseCsv"` runs without error;
    and parseCsv('') returns [].
   **Verify with:** ollama/llama3.1:8b
- [ ] Step 2: Wire parseCsv into the CLI --format csv flag
   **Verification:** `./cli --format csv in.csv` prints a table and exits 0.
```

Each step has:

- a **checkbox** (flipped to `[x]` on pass, `[B]` when blocked, `[~]` when skipped),
- a **`**Verification:**`** line — *free text* describing how to confirm the step is correct (a command, a test, a behavioral check, or "best judgment"),
- an optional **`**Verify with:**`** line — a *per-step verifier model id* (a different model than the implementer) used for that step's verification.

Legacy plans written with `### Step N:` headings are still understood (the status is appended inline as `[DONE]`/`[BLOCKED]`).

---

## Implementation flow (`/implement` — the Ralph loop)

`/implement` is **code-driven, not model-driven**: a TypeScript state machine transitions the model between phases, switches models, and opens a *fresh* pi session at every boundary. This is what keeps each phase's context tiny and isolated — no compaction of a prior phase's transcript is ever fed to the next phase.

The state machine cycles, **one step at a time**, and each phase runs in its **own fresh session** (implement → verify → fix → next):

```
IMPLEMENT step N  ──▶ fresh session ──▶ VERIFY (a DIFFERENT model, clean context, runs the step's "Verification")
                                            │
                     ┌───────────────────────┴───────────────────────┐
                 PASS ✓                                          FAIL ✗
                 │                                                │
          tick [x] box                           (retries < maxVerifyRetries?)
   store carry-forward note                                  │              │
          │                                                YES            NO
          ▼                                               │              │
   go to IMPL of step N+1 ◀──────────────────────── FIX (re-verify)    mark [B] BLOCKED
                                                              │              then go to step N+1
                                                        (fix phase)
```

1. **Implement** — the implementer model does *only* the current step, then stops.
2. **Fresh session for the next phase** — the loop opens a *new* pi session so the next phase (especially the verifier) sees a genuinely clean context, never a compressed version of the previous phase's work. See *Context management* below.
3. **Verify** — a *different* model (the verifier) reads what was written and judges it against the step's `**Verification:**` criteria. It must call the `submit_verification` tool with a verdict.
4. **Branch on the verdict:**
   - **PASS** → the checkbox flips to `[x]`, the verifier's `carryForwardNotes` are stored for the next step, and the loop moves to the *implement* phase of step N+1.
   - **FAIL (under the retry limit)** → the loop goes to a *fix* phase (the implementer repairs the flagged issues), then re-verifies.
   - **FAIL (retry limit exceeded)** → the checkbox flips to `[B]` (blocked) and the loop **continues to the next step** rather than getting stuck.
   - **Verifier never submits a verdict** → re-verify up to `maxVerifyRetries` times; if it still doesn't, a synthetic failing verdict is created and the step is sent to fix.
5. **Done** — when all steps are processed, the loop stops with a summary (N passed / B blocked / S skipped).

### The `submit_verification` tool

The verifier (never the implementer) calls it with:

| field | meaning |
|-------|---------|
| `pass` | `true` if the step satisfies its verification; `false` if issues were found |
| `issues` | concrete, actionable problems (empty if `pass`) |
| `suggestedFixes` | a concrete fix per issue, index-aligned (empty if unsure) |
| `carryForwardNotes` | **required** — a short (<40-word) note for the *next* step: files created, function signatures, key assumptions |

Because the note is carried forward, each step's implementer only needs the *current* step plus the note from the previous one — the full plan never has to be re-fed into a small context window.

---

## Context management (the whole point)

Small local models fill their context fast, so the loop gives every phase its **own tiny, isolated context**:

- **Fresh session per phase** — every phase transition opens a *new* pi session (via the internal `/pw-next` command). The verifier never sees any implementer turns — it takes a genuinely fresh look at the code. There is **no per-phase compaction**.
- **Minimal per-phase prompts** — each phase gets a tight prompt (implement / verify / fix) built from the current phase plus the shared notes — not the whole plan.
- **Shared notes scratchpad** — `.pi/implement/<plan>.notes.md` is an append-only design log. Both implementer and verifier append decisions with the `append_plan_note` tool, the loop auto-annotates progress, and its full contents are inlined into every phase prompt.
- **Carry-forward notes** — the verifier's short (<40-word) note for the next step is also folded into the notes file.
- **Per-phase model switching** — the loop calls `setModel()` to switch between the implementer and the verifier (and to fix, back to the implementer) as it transitions phases.

---

## Controlling the loop

| command | what it does |
|---|---|
| `/implement <plan_file>` | start the loop on a saved plan — **auto-resumes** any existing incomplete state for that plan (picking up at the last completed step), or starts fresh if none exists |
| `/implement --resume` | resume the most recent *incomplete* loop (a stopped or interrupted one) — it switches back to the correct phase model and continues from where it left off |
| `/implement-stop` | pause the active loop. The state is written so you can resume later with `/implement --resume` |

The loop state **survives session hops and crashes**, so you can stop it, close pi, and resume in a fresh session. Re-running `/implement` on the same plan also resumes from the last checked-off step instead of restarting from step 1 — per-step status is reconciled against the checkboxes in the plan file, so you can even uncheck a box in the plan to redo just that step.

---

## Files

| path | contents |
|---|---|
| `.pi/plans/<name>.md` | the RALPH-format plan (output of `/plan`) |
| `.pi/implement/<name>.json` | the loop state for a plan (current phase, step, per-step status/retries/verdict/carry-forward notes) — the source of truth for the running loop |
| `.pi/implement/<name>.notes.md` | append-only shared notes scratchpad for the loop — agents append design decisions, the loop annotates progress, and its contents are inlined into every phase prompt |
| `.pi/plan-wizard.json` | settings (see below) |

All under the project root; gitignoring `.pi/` keeps your repo clean.

---

## Settings (`.pi/plan-wizard.json`)

| key | default | meaning |
|---|---|---|
| `maxVerifyRetries` | `3` | how many times a step may fail verification and still be sent to the *fix* phase before it's marked **blocked** and the loop moves on |
| `defaultVerifierModel` | `null` | the global verifier model (`provider/id`). `null` = "same as implement model". Pick a verifier at `/implement` time and it's remembered here for next time |

You can still override the verifier *per step* with `**Verify with:** <model>` in the plan.

---

## How It Works

A pi extension that registers:

| Component | Purpose |
|---|---|
| `registerCommand("plan")` | exposes `/plan` |
| `registerCommand("implement")` | exposes `/implement` (and `--resume`) |
| `registerCommand("implement-stop")` | expose `/implement-stop` |
| `on("input")` | intercepts `/plan <desc>` from raw input and sets planning mode |
| `on("before_agent_start")` | injects planning instructions before each LLM call (plan mode only) |
| `registerTool("present_plan")` | full-screen editor for plan approve/edit/cancel |
| `registerTool("submit_verification")` | the verifier's verdict channel (pass/issues/fixes/carry-forward) |
| `registerTool("append_plan_note")` | lets any phase append a decision to the shared notes scratchpad |
| `on("agent_settled")` | **the Ralph driver** — persists the next phase and queues `/pw-next` (implement → verify → fix → next step) |
| `on("session_start")` | rehydrates the loop from disk and dispatches a fresh phase's prompt (model switch + notes-aware prompt) in its clean session |
| `registerCommand("pw-next")` | (internal) opens the fresh session for the next phase |
| `setModel` / `newSession` | per-phase model switching and fresh-session context isolation |

---

## Requirements

- pi with the [pi-subagents](../pi-subagents) extension installed (provides the `scout`, `search`, `worker` agents used during `/plan`).
- Interactive TUI mode (`pi`) — not supported in print/RPC modes.
- A verifier model in your pi config (you'll be asked to pick one at `/implement` time, or set `defaultVerifierModel` in settings).

## Installation

**Option 1:** copy to your extensions directory.

```bash
# global
cp -r plan-wizard ~/.pi/agent/extensions/
# or project-local
cp -r plan-wizard <your-project>/.pi/extensions/
```

Then restart pi or run `/reload`.

**Option 2:** add as a pi package reference in your `settings.json`:

```jsonc
// .pi/settings.json
{
  "extensions": ["/absolute/path/to/plan-wizard/index.ts"]
}
```

## Notes

- The `/plan` command overrides pi's built-in plan-mode toggle while this extension is active. To use both, pick a different command name (e.g. `/plan-wizard`).
- Plans are written to `.pi/plans/` so they don't clutter your repo and can be gitignored.
- The Ralph loop state (`.pi/implement/<plan>.json`) is the source of truth — never edit it by hand; the loop re-reads it from disk at every phase boundary.
- Each verification can use a different model than the implementation, giving you an *independent* reviewer per step.
