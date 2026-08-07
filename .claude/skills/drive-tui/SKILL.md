---
name: drive-tui
description: Manually drive and test the opencode TUI via tmux. Starts the compiled binary against an isolated fake provider, sends keystrokes, captures rendered screen state including colours, highlights and selections, and diffs before/after snapshots to verify UI behaviour. Use when verifying that a change actually works in the shipped product rather than only in unit tests.
allowed-tools: Bash
---

# drive-tui

Drive the real compiled opencode TUI. Unit tests exercise services; this
exercises the product a user actually runs. Every bug that has escaped unit
testing on this branch — a review loop spinning 337 times, a 15-second cap
printed as "1 minute", a parent that never woke on a background notification —
was only visible here.

Helper scripts live in `.claude/skills/drive-tui/`.

## Isolation

Two layers, both deliberate:

- **tmux**: every command runs on a dedicated server socket via `tmux -L claude-opencode`
  (override with `OPENCODE_TMUX_SOCKET`). Your own tmux sessions are invisible to it,
  and even `stop.sh --all` cannot touch them.
- **opencode**: each session gets a scratch `HOME`/`XDG_*` tree and its own git-backed
  project, and talks to a fake OpenAI-compatible provider on localhost. It never
  reads your real config, credentials or sessions, and never contacts a real model.

## Core tools

| Script | What it does |
|--------|-------------|
| `start.sh [session]` | Build scratch tree, start the fake provider, launch the TUI, wait until the prompt renders |
| `stop.sh [session]` | Kill the session, its provider, and its scratch tree |
| `stop.sh --all` | Tear down every session and provider on the dedicated socket |
| `send_keys.sh [session] <key...>` | Send keystrokes (each arg is one key) |
| `capture.py [session] [out.json]` | Dump the screen as JSON: text plus styled segments, colours, highlights, selections |
| `diff_snapshots.py before.json after.json` | Diff two snapshots and summarise what changed |

`capture.py` is the reason to prefer this over `capture-pane | grep`: it sees
**colour and style**, so you can assert that a warning badge is actually rendered
in the warning colour, not merely that its text is present.

## First-time setup

`capture.py` needs the `pyte` terminal emulator to read colours and styles. It
lives in a venv inside the skill (gitignored, never your global environment),
and needs Python 3.10+ for its type syntax — the system `python3` on macOS is
3.9 and will fail with a confusing `dict | None` TypeError:

```bash
/opt/homebrew/bin/python3.13 -m venv .claude/skills/drive-tui/.venv
.claude/skills/drive-tui/.venv/bin/pip install -q pyte
```

Then invoke the styled tools with that interpreter:

```bash
.claude/skills/drive-tui/.venv/bin/python .claude/skills/drive-tui/capture.py <session> out.json
```

`start.sh`, `stop.sh` and `send_keys.sh` are plain bash and need nothing.

## Key names for send_keys.sh

`Enter` `Escape` `Up` `Down` `Left` `Right` `BSpace` `Tab` `BTab` (shift+tab)
`Space` `C-c` `C-d` `C-p` `C-u`

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `BIN` | `packages/opencode/dist/opencode-darwin-arm64/bin/opencode` | Which binary to drive |
| `PROVIDER` | `goal` | Which harness provider: `goal`, `subagent`, `permission` |
| `PORT` | `5010` | Fake provider port |
| `TUI_COLS` / `TUI_ROWS` | `170` / `48` | Terminal size |
| `KEEP_WORK` | unset | Set to `1` to keep the scratch tree after `stop.sh` |

Provider scenario variables pass straight through, e.g. `REVIEWER_MODE=not_met`
for the goal provider.

## Workflow

```bash
cd .claude/skills/drive-tui
./start.sh                                  # waits until the prompt renders
./capture.py tui-test /tmp/before.json
./send_keys.sh tui-test BTab                # shift+tab: cycle permission mode
./capture.py tui-test /tmp/after.json
./diff_snapshots.py /tmp/before.json /tmp/after.json
./stop.sh                                   # reaps provider and scratch tree
```

Type a prompt and submit it:

```bash
./send_keys.sh tui-test "fix the failing test"
./send_keys.sh tui-test Enter
```

## Rules that matter

- **Never `tmux attach`** from an agent. It blocks forever and will hang the
  session. Only `send_keys.sh` and `capture.py`, which return immediately.
- **Always `stop.sh`.** Each session holds a fake provider process and roughly
  165MB of scratch tree. Leaking them fills the disk, and a full disk produces a
  flood of bogus test failures that look exactly like real ones.
- **One session at a time per socket name.** Use distinct session names and
  `PORT`s if you need concurrency.
- **Assert on what you can see.** Prefer `capture.py` plus a specific check over
  grepping for a substring — a substring can match the system prompt, the tool
  descriptions, or your own instrumentation. That has caused a false pass on this
  branch more than once.

## Related

Scripted end-to-end scenarios with built-in assertions live in
`script/goal-harness/`, `script/subagent-harness/` and `script/permission-harness/`.
Use those for regression coverage; use this skill for exploration and for
verifying anything involving colour or layout.
