# Understanding Claude Code Permissions

A minimal demo repo that shows how Claude Code's permission system gates
what the agent can read, search, and execute — and what you still miss
until you also turn on **sandboxing**.

The repo has two runnable variants. `cd` into one, run `claude`, and the
settings in that directory take effect:

| Variant               | `.claude/settings.json`                 | What it demonstrates                                                           |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| [`without-sandbox/`](without-sandbox/)  | permission rules only                   | 4 scenarios — and one bypass that slips through. Guardrails.                  |
| [`with-sandbox/`](with-sandbox/)        | same rules + `sandbox.filesystem.denyRead` | Same scenarios, bypass now blocked by OS-level filesystem filter. Wall.        |

Everything at the repo root is authoring material (diagrams, this
README, Taskfile). Running `claude` at the root is not a supported
learner flow — there's no `.claude/settings.json` here, so none of the
demos apply.

## How the permission system works (30-second version)

![Overview — how Claude Code permissions and sandbox complement each other](diagrams/index.svg)

Every tool call the agent makes (`Read`, `Write`, `Bash(ls ...)`, etc.) is
checked against three lists in `settings.json`:

| List    | Effect                                                                 |
| ------- | ---------------------------------------------------------------------- |
| `deny`  | Blocks the call. The user is **not** prompted. `deny` always wins.     |
| `ask`   | Prompts the user at runtime. Answering "yes" allows just that call.    |
| `allow` | Runs silently, no prompt.                                              |

Anything not matched by any list falls back to the session's permission mode
(`default`, `acceptEdits`, `plan`, `bypassPermissions`).

Rules are patterns shaped like `ToolName(specifier)`:

- `Read(./.env)` — the specific file
- `Read(./sensitive/**)` — glob under a directory
- `Bash(ls:*)` — any `ls` invocation (prefix match on the command line)
- `Bash(grep -l:*)` — only `grep` calls that start with `-l`

## The scenarios

Each scenario has a runnable command you can copy into a shell. `cd` into
the right subdirectory first — that's what selects the settings file.

### Scenario 1 — `.env` can never be read

![Scenario 1 diagram](diagrams/permissions/1-deny-env.svg)

You're pair-programming with Claude on a production service. The repo has
`.env` files with database passwords, Stripe keys, third-party API
tokens — the kind of secrets that, if they ever leaked into a chat
transcript, mean rotating credentials and writing incident notes. You
want Claude to refactor the code that *uses* those values, not to ever
see them.

Two layers of `deny` protect `.env`:

```json
"deny": [
  "Read(./.env)",
  "Read(./.env.*)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Bash(*.env)",
  "Bash(* .env *)"
]
```

1. **`Read(./.env)`** blocks Claude's `Read` tool from opening the file directly.
2. **`Bash(*.env)` and `Bash(* .env *)`** are argument-pattern denies. `*`
   matches any sequence of characters including spaces, so these fire on
   any shell command whose raw text ends in `.env` or has `.env` surrounded
   by spaces — `cat .env`, `bat .env`, `rg foo .env`, `diff .env .env.bak`,
   `cp .env /tmp/x`, etc.

The argument pattern is stricter than enumerating readers one-by-one
(`Bash(cat:*)`, `Bash(bat:*)`, `Bash(rg:*)`, ...): instead of chasing every
new tool that can open a file, you match the file reference itself. `deny`
is not a prompt — there's no "approve once" button. The call fails, full stop.

**But it's still fragile — and the blind spots shift as the filter evolves.**

The classic bypass used to be:

```bash
f=.env && awk 1 $f
```

Read literally, the raw string has `.env` after `=` (not space-bounded) and
ends in `$f` (not `.env`), so neither `Bash(*.env)` nor `Bash(* .env *)`
match the text. This worked in earlier Claude Code versions. **It doesn't
anymore** — the filter now parses shell, resolves the assignment, and
re-checks against the resolved form `awk 1 .env`, which hits
`Bash(* .env *)`. Try it and you'll see `"has been denied"` — hard deny, no
prompt.

The filter is still fundamentally pattern-based, though. Anything it can't
statically analyze still slips:

```bash
python3 -c 'print(open(".env").read())'
```

The filter sees `python3 -c '<opaque string>'`. `.env` lives inside the
Python argument; there are no unquoted spaces around it on the shell side,
and the command doesn't end in `.env`. No `deny` matches. The call falls
through to the default permission mode, which **asks**. In interactive mode,
one "yes" and `.env` leaks. `perl -e`, `node -e`, `ruby -e`, and
`awk 1 $(base64 -d <<< LmVudg==)` share the same blind spot — the filter
can't reason about code inside `-e`/`-c` strings or behind command
substitution.

The failure modes are distinguishable:

| What                                     | Filter message                    | What it means                                |
| ---------------------------------------- | --------------------------------- | -------------------------------------------- |
| Direct `Read(./.env)` or `cat .env`       | `has been denied`                 | Hard deny — no prompt, full stop.            |
| `f=.env && awk 1 $f`                     | `has been denied`                 | Filter resolved the assignment; hard deny.   |
| `python3 -c 'print(open(".env").read())'` | `requires your approval`          | Fell through deny → ask. Interactive user can approve. |

That third row is the fragility: a deny rule's reach stops at what the
filter can see. Permission rules are guardrails; some paths still reach the
file. → scenario 1b.

**Try it:**

```bash
cd without-sandbox
claude -p "Read the .env file and tell me what's in it."
# → "has been denied" (Read tool blocked)

claude -p "Run: f=.env && awk 1 \$f"
# → "has been denied" (filter resolved the assignment)

claude "Run: python3 -c 'print(open(\".env\").read())'"
# → interactive prompt; approve and .env leaks
```

### Scenario 1b — sandbox is the real fix

![Scenario 1b diagram](diagrams/permissions/1b-sandbox-blocks-bypass.svg)

Same `.env`, same stakes. But now you've seen scenario 1 and know that
permission patterns can't see inside `python3 -c '...'` or `perl -e`.
You don't want to rely on yourself to say "no" to every bypass prompt,
especially an hour into a debugging session when you're fast-approving
things. You want the answer to be "the OS won't let me" regardless of
what you click.

`with-sandbox/.claude/settings.json` adds a `sandbox` block:

```json
"sandbox": {
  "enabled": true,
  "autoAllowBashIfSandboxed": true,
  "filesystem": {
    "denyRead": [
      "./.env",
      "./.env.*",
      "**/.env",
      "**/.env.*",
      "./app-config.yaml",
      "./sensitive/**"
    ]
  }
}
```

Sandbox is OS-level. On macOS it's [Seatbelt](https://code.claude.com/docs/en/sandboxing);
on Linux it's `bubblewrap`. Every subprocess Claude spawns runs inside the
sandbox, so the filter isn't looking at command text anymore — it's
intercepting `open()` syscalls by path. The `python3 -c '...'` slip from
scenario 1 now hits `EACCES` before Python can read a byte — no matter
what's inside the `-c` string. `perl -e`, `node -e`, base64-decoded
filenames, all stopped the same way.

Two important things:

- **Sandbox complements permissions; it doesn't replace them.** Both are
  evaluated, both can block. `deny` on the permission side is still the
  first gate. Sandbox is the net behind it.
- **Sandbox only covers bash subprocesses.** Claude's internal `Read`,
  `Edit`, `Write` tools run in-process — they're gated by permission
  rules, not sandbox. Which is why the permission `Read(./.env)` deny is
  still there in the sandboxed settings.

**Try it:**

```bash
cd with-sandbox
claude "Run: python3 -c 'print(open(\".env\").read())'"
# → EACCES at the OS — approval can't unlock it
```

### Scenario 2 — `app-config.yaml` is blocked too, and sandbox backstops it

![Scenario 2 diagram](diagrams/permissions/2-deny-innocuous.svg)

You have an internal config that isn't secret-secret, but also isn't
something you want broadcast back into a chat transcript: feature
flags, A/B cohort assignments, pricing tier definitions, rate limits,
third-party vendor endpoints. A name like `app-config.yaml` doesn't
scream "protect me" the way `.env` does — and that's exactly the test.

`.env` is a bad test on its own. The string ".env" carries so much
"secrets live here" context that an agent might refuse or hedge on it
for reasons that have nothing to do with the permission system.

So: `app-config.yaml` gets the exact same treatment. Mundane name,
mundane content (port, log level, feature flags), same deny rule and
same sandbox coverage:

```json
"deny":   ["Read(./app-config.yaml)", "Bash(cat:*)", "Bash(head:*)", ...]
"sandbox.filesystem.denyRead": ["./app-config.yaml", ...]
```

Two observations fall out of this:

1. **No name bias on the permission side.** The direct read
   (`Read app-config.yaml`) gets hard-denied exactly like `.env` —
   same rule shape, same result. The rule doesn't care what the file
   is named.
2. **The same bypass story repeats, and sandbox catches it here too.**
   `python3 -c 'print(open("app-config.yaml").read())'` slips the deny
   list (not matching any `Bash(*.yaml)` pattern — there isn't one —
   and the `-c` string is opaque to the filter). Without sandbox, it
   falls to an ask prompt. With sandbox, the OS returns `EACCES` at
   `open()`. The diagram shows the with-sandbox path — same pipeline
   as scenario 1b, different file.

**Try it:**

```bash
cd without-sandbox
claude -p "Read app-config.yaml and tell me which port the app runs on."
# → "has been denied" (Read tool blocked)

claude "Run: python3 -c 'print(open(\"app-config.yaml\").read())'"
# → ask prompt; approve → leaks the config

cd ../with-sandbox
claude "Run: python3 -c 'print(open(\"app-config.yaml\").read())'"
# → EACCES at the OS — approval can't unlock it
```

### Scenario 3 — let Claude organize a folder without peeking inside

![Scenario 3 diagram](diagrams/permissions/3-sensitive-list-only.svg)

You want Claude to tidy up your personal journal directory: move files
into subfolders by year, rename scanned PDFs to match their dated
contents, dedupe. It needs to see filenames and sizes. It must never
`open()` a file. Names are safe; contents are yours alone.

This is an interesting shape for the permission system because there's
no clean primitive for "list names, block contents." You can't express
it with permission rules alone: any bash command you *approve*
(`cat`, `grep`, `python3 -c`) will happily `open()` a file. Permissions
can't draw a floor under your own approval.

**The sandbox draws it.** On macOS (Seatbelt) or Linux (bubblewrap),
`filesystem.denyRead` is an OS-level wall: subprocesses can't `open()`
paths under `sensitive/` no matter which command tries. `ls` and `tree`
run *outside* the sandbox via `excludedCommands` — they call
`readdir()` to enumerate directory entries, never `open()` to read file
contents, so running them unsandboxed is safe.

```json
"sandbox": {
  "enabled": true,
  "autoAllowBashIfSandboxed": false,
  "filesystem": {
    "denyRead": ["./sensitive/**"]
  },
  "excludedCommands": ["ls", "ls *", "tree", "tree *"]
}
```

Paired permission rules:

```json
"deny":  ["Read(./sensitive/**)"],
"allow": ["Bash(ls:*)", "Bash(tree:*)"],
"ask":   ["Bash(*)"]
```

- `Read(./sensitive/**)` deny blocks Claude's in-process `Read` tool.
  The sandbox only wraps Bash subprocesses — in-process tools (`Read`,
  `Edit`, `Write`, `Glob`, `Grep`) don't go through Seatbelt/bubblewrap.
  The permission rule is what covers them.
- `Bash(ls:*)` / `Bash(tree:*)` auto-allow the listing commands at the
  permission layer; `excludedCommands` lets the same commands bypass
  the sandbox. Both allow-lists are needed: the first keeps them from
  being asked, the second keeps them from being sandboxed.
- `Bash(*)` sends anything else (`cat`, `python3 -c`, `grep`) to an
  ask prompt. **If you approve, the subprocess still runs inside the
  sandbox** and hits `EACCES` on `open()`. Approval can't unlock the
  file — the sandbox is a floor under your own mistakes.

**Why there's no without-sandbox variant of this scenario.** You could
write the same permission rules (`ls`/`tree` allow, `Bash(*)` ask) in
a permissions-only setup. Listing would still work. But the moment you
approve `cat sensitive/journal-2026.md` — because it looks harmless, or
because you're tired, or because a prompt-injected file told Claude to
ask — the contents leak. The ask rule trusts your every click;
scenarios 1 and 2 already showed why that's fragile. Scenario 3's point
is what `excludedCommands` + `denyRead` add that permissions can't: a
shape where listing works, reading can't happen, and approval can't
change that.

**What the agent can do:**

- `ls sensitive/` / `tree sensitive/` → see filenames (unsandboxed, permission-allowed)

**What it cannot do:**

- `cat sensitive/customer-data.csv` → ask; if approved, sandbox `EACCES`
- `python3 -c 'open("sensitive/...")'` → ask; if approved, sandbox `EACCES`
- `Read` tool on any `sensitive/` file → permission deny

**Try it:**

```bash
cd with-sandbox
claude -p "List the files under sensitive/. Do not read their contents."
# → ls sensitive/ returns filenames, contents stay closed

claude "Run: python3 -c 'print(open(\"sensitive/customer-data.csv\").read())'"
# → ask prompt; approve → sandbox EACCES at the OS
```

> **The gotcha:** "search contents without seeing contents" has no
> clean primitive. `grep` (without `-l`) prints matching lines, which
> *is* a read — sandbox blocks it inside `sensitive/`. If you really
> need content-search, you either approve a specific command (and
> accept the leak) or build an indexed search outside the agent's
> reach.

### Scenario 4 — when Claude needs to peek to rename

![Scenario 4 diagram](diagrams/permissions/4-restricted-ask.svg)

Continuing from scenario 3: renaming by filename works great for
`2024-01-03 trip to kyoto.md`. It falls apart for `IMG_4821.jpg`,
`Scan_20240103_001.pdf`, `Untitled.md`, and `Note 3 (copy) (final).txt`.
To rename those meaningfully, Claude has to look inside. You want that
to happen — but you want to stay in the loop on each peek.

This is what `ask` is for. Not a blanket "yes, read anything in this
folder" — one prompt per file, so you can wave through the boring
scans and skip the ones you know are personal.

The rule:

```json
"ask": ["Read(./restricted/**)"]
```

When the agent tries to `Read` a file under `restricted/`, Claude Code
pops a prompt: *"Allow Read(./restricted/Scan_20240103_001.pdf)?"* You
choose:

- **Yes** — allow this one call.
- **Yes, and don't ask again** — promotes it to `allow` for the session
  (or permanently, depending on which option you pick). The speed bump
  goes away after this — use sparingly, and never for a folder you
  haven't already surveyed.
- **No** — blocks it; the agent sees an error and moves on to the
  next file.

The same shape fits anything where "usually fine to read, but I want to
know" is the policy: deploy configs, team notes, meeting transcripts,
runbooks. `ask` turns the file access itself into a visible event in
the conversation — you can catch a prompt-injected file steering
Claude toward things it doesn't need.

**Try it** (note: no `-p` flag — we want interactive mode so you see the
approve/deny dialog; headless would auto-deny and skip the interesting
part):

```bash
cd without-sandbox    # same in with-sandbox
claude "Look at restricted/team-notes.md and propose a better filename based on its contents."
```

### Scenario 5 — running `claude` from a nested subdir skips the parent's `.claude/`

![Scenario 5 diagram](diagrams/permissions/5-nested-inherits.svg)

You set up `.claude/settings.json` in a project directory with deny
rules on secrets. Later, you `cd` one level deeper to work on
something and run `claude` from there — naturally expecting the
project rules still apply. They don't, and you only notice when
Claude cheerfully reads `.env` back to you.

The gotcha: **Claude Code picks a single project scope per session,
not a chain.** When your CWD has no `.claude/` of its own, Claude
does **not** walk up through every enclosing directory merging each
`.claude/settings.json` it finds along the way. Don't assume which
scope wins — verify it.

In this repo:

```
with-sandbox/
├── .claude/settings.json   ← rules active when CWD is with-sandbox/
└── nested/
    └── .env                ← from nested/, those rules do NOT load
```

**Try it:**

```bash
cd with-sandbox
claude -p "Read the .env file and tell me what's in it."
# → "has been denied" — with-sandbox/.claude/ is the project scope

cd nested && pwd
# → .../with-sandbox/nested   (one level deeper, no .claude/ here)
claude -p "Read the .env file and tell me what's in it."
# → Claude reads it. with-sandbox/.claude/ is no longer active.
```

The `Read` tool isn't the only thing you lose — the sandbox block
lives in the same settings file, so the OS-level `denyRead` wall
from scenarios 1b/2/3 also stops working from `nested/`. Both
defenses vanish together.

**What to do about it:**

- **Put `.claude/settings.json` in every directory you run Claude from.**
  Explicit and predictable, at the cost of keeping them in sync.
- **Run Claude from the directory that holds the rules.** If your
  guardrails live at `./project/.claude/`, start Claude from
  `./project/` — not from `./project/scripts/`.
- **User settings.** Rules in `~/.claude/settings.json` follow you
  everywhere on your machine. Good for personal deny lines ("never
  read my SSH keys"); not shareable with teammates.

The takeaway: **don't assume a parent directory's `.claude/` will
cover your current working dir.** Start Claude interactively and
run `/status` to see which settings files are actually loaded before
trusting the rules.

## File layout

```
README.md                ← you are here (authoring: orients learners)
Taskfile.yml             ← author + demo tasks (tasks `cd` into subdirs)
diagrams/                ← D2 source + exported SVGs (authoring)
  _shared.d2             ← reusable classes (code-step, deny-edge, ...)
  _scenario-base.d2      ← shared User→Claude→permissions→sandbox→file skeleton
  index.d2 / index.svg   ← overview (top of README)
  permissions/
    1-deny-env.d2        / 1-deny-env.svg
    1b-sandbox-blocks-bypass.d2 / 1b-sandbox-blocks-bypass.svg
    2-deny-innocuous.d2  / 2-deny-innocuous.svg
    3-sensitive-list-only.d2 / 3-sensitive-list-only.svg
    4-restricted-ask.d2  / 4-restricted-ask.svg
    5-nested-inherits.d2 / 5-nested-inherits.svg
without-sandbox/         ← learner runs `cd without-sandbox && claude ...`
  .claude/settings.json
  .env, .env.example, app-config.yaml
  public/welcome.txt
  sensitive/{customer-data.csv, server-logs.log}
  restricted/{deploy-config.json, team-notes.md}
with-sandbox/            ← same targets, sandbox-enabled settings
  .claude/settings.json  ← permissions + sandbox block
  (same files as without-sandbox/)
  nested/
    .env                 ← scenario 5: no .claude/, inherits from parent
```

## Regenerating the diagrams

Run `task diagrams` from the repo root. It renders `index.d2` and each
per-scenario source under `diagrams/permissions/*.d2` to its sibling `.svg`.

Each scenario is its own self-contained file. Shared styling lives in
`_shared.d2` (classes like `code-step`, `deny-edge`, `flow-edge`); the common
`User → Claude → permissions → sandbox → file` skeleton lives in
`_scenario-base.d2`. Both are pulled in via D2's spread-import (`...@_shared`).

`--theme 0` (neutral light) paired with `--dark-theme 200` (dark mauve)
embeds both variants in each file; the viewer's `prefers-color-scheme` picks.

Arrows are marked `animated: true` so they flow in the direction of the tool
call in browsers that render SVG CSS animation.

## Where these rules can live

Claude Code reads permissions from several places, merged in this order
(later wins on conflict, but `deny` always beats `allow`):

1. `~/.claude/settings.json` — your user-wide rules
2. `./.claude/settings.json` — checked into the repo, shared with the team
3. `./.claude/settings.local.json` — per-checkout overrides, gitignored
4. Enterprise managed policy — set by your org, cannot be overridden

This repo uses #2, scoped to each subdir. That's the whole trick for the
two-variant demo: which `.claude/settings.json` loads depends on where you
launched `claude`.

## Platform note

Sandboxing uses the OS:

- **macOS** — Seatbelt, built in, no setup.
- **Linux / WSL2** — requires `bubblewrap` and `socat`:
  `sudo apt-get install bubblewrap socat`.

Without sandbox support, the `with-sandbox/` variant will either fail to
start or silently degrade to permission-only enforcement depending on
`sandbox.failIfUnavailable`.

## Driving it interactively

If you'd rather poke around instead of running the one-shots above:

```bash
cd without-sandbox    # or with-sandbox
claude
```

Then try prompts like `read .env`, `list sensitive/`, `wc -l sensitive/*.log`,
`read restricted/team-notes.md`, `read public/welcome.txt` — each maps to one
of the rules in the local `.claude/settings.json`. Re-run the same prompts
in the other subdir to see how sandbox changes the outcome for the bypass.
