# v061 seg-01 — 工人流程里的消息可见性事实（worker report）

Segment: `commhub_tasks/v061/spec.md` §seg-01, sha12 `4d2bc4552176` (verified with
`bash scripts/anet_payload.sh verify` before touching anything).
Taken on branch `main` at `679788f`, after `git pull --rebase origin main`.

## Pre-flight re-check (the spec asks for it)

`git fetch` + fast-forward to `679788f`, then re-read the segment's **Problem**:
§2 step 6 ended at "Merging several tasks into one report = none of them take effect." and
**Worker discipline** had no visibility bullet — the segment was **not** implemented at v0.6.3, so
the work was done, not skipped.

## Changes (SKILL.md §2 only, 2 places)

1. **§2 step 6 (Report)** — a 6-line cross-reference block, no new table:
   - `report_completion` writes `completions` + `tasks.result` only — no `inbox` row for the
     dispatcher, no `user_inbox` row, no unread badge; the Tasks page is the only place it shows;
   - the dispatcher must **read** the text → `send_reply` (manual node: `reply … --via send_reply`),
     stated as **terminal** (`replied` is not in the set `retry_task` accepts), so never a question;
   - a **person** must be notified mid-task → `report_status(status="blocked")` +
     `send_desktop_message` (manual node: `dm`), task stays `running`;
   - ends with "Channel table: §7.0 — cite it, do not copy it." No table duplicated, nothing in
     §7.0–§7.3 removed.
2. **Worker discipline** — one added bullet: delivering the work and notifying a person are
   different calls; the wrong one strands the round (§7.0).

Runtime-neutral: the MCP tool names (`report_completion` / `send_reply` / `send_desktop_message` /
`report_status`) carry the rule; the `anet_manual_node.sh` spellings appear only inside
parenthesized "manual node:" examples. Names checked against the running hub's `tools/list`, not
against prose.

## How it was verified

| gate | result |
|---|---|
| `python3 scripts/run_evals.py` | 66 passed / 0 failed / 0 skipped (unchanged — no golden case touched) |
| `python3 scripts/run_evals.py --validate` | VALID |
| `validate.py .` | VALID (2 pre-existing warnings: 696-line body, 2 run-vs-read labels — seg-05 scope) |
| `security_scan.py .` | CLEAN |
| `skill_graph.py run .` | skill graph OK (spec PASS, security PASS, pipeline/eval_schema) |
| `run_pipeline.py` | see "pipeline" line in the reported result |

Body line count moved 687 → 696: seg-01 adds narrative + one rule, the 500-line warning is seg-05's
to clear; no rule, table row, or measured fact was deleted.

## Not done (deliberately)

- **No version bump**: the spec says bump `metadata.version` once per accepted **batch**; a single
  segment is not a batch — that is the dispatcher's call.
- **No golden case**: seg-01 acceptance says "no golden case changes required"; `case-13` stays free
  for seg-04.
- This report is a separate file so seg-01's sha12 (`4d2bc4552176`) stays valid for the other
  workers who have to verify the same spec file.
