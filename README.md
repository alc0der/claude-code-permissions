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

Each scenario has a runnable command. Hit ▶ in your IDE, copy into a shell
(from the right subdir), or run the `task demo:<name>` shortcut — the
Taskfile tasks handle the `cd` for you. `task` with no args lists
everything.

### Scenario 1 — `.env` can never be read

![Scenario 1 diagram](diagrams/permissions/1-deny-env.svg)

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

Or via Taskfile: `task demo:env` (direct read),
`task demo:env:old-bypass` (the awk form, now caught), and
`task demo:env:bypass` (the Python slip).

### Scenario 1b — sandbox is the real fix

![Scenario 1b diagram](diagrams/permissions/1b-sandbox-blocks-bypass.svg)

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

Or: `task demo:env:sandbox`. Same prompt as `demo:env:bypass`, different
outcome.

### Scenario 2 — `app-config.yaml` is blocked too, and sandbox backstops it

![Scenario 2 diagram](diagrams/permissions/2-deny-innocuous.svg)

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

Or via Taskfile: `task demo:config`, `task demo:config:bypass`,
`task demo:config:sandbox`.

### Scenario 3 — `./sensitive/**` is listable, not readable

![Scenario 3 diagram](diagrams/permissions/3-sensitive-list-only.svg)

You want `ls sensitive/` to work (names are fine) but
`cat sensitive/customer-data.csv` to fail (contents are not). Both
variants let you list the directory. The contrast is what happens when
a user *approves* a content-read bypass.

**The permission-layer shape** (same in both variants):

```json
"deny":  ["Read(./sensitive/**)"],
"ask":   ["Bash(*)"],
"allow": ["Bash(ls:*)", "Bash(tree:*)"]
```

- `Read(./sensitive/**)` deny blocks the in-process `Read` tool.
- `Bash(ls:*)` / `Bash(tree:*)` allow listing directory entries.
- `Bash(*)` ask routes anything else (`cat`, `python3 -c`, `grep`, …)
  through a prompt.

**Without sandbox, the trust boundary is you.** If an agent needs to
read `sensitive/customer-data.csv`, it prompts: *"Allow Bash: cat
sensitive/customer-data.csv?"* If you approve, the file is read, and
the contents flow through the agent and out to the chat. The ask is the
weakest link — approvals are irrevocable once granted.

**With sandbox, there's a floor under approval.** Even if you approve
the bash prompt, the subprocess runs inside Seatbelt (macOS) or
bubblewrap (Linux), and `open("sensitive/...")` returns `EACCES`. The
agent sees an error, not contents.

The sandbox block:

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

- `filesystem.denyRead` is the OS-level wall for **Bash subprocesses** —
  Seatbelt (macOS) or bubblewrap (Linux) returns `EACCES` on `open()`
  for any path under `sensitive/`, regardless of which command tries.
- `excludedCommands` is a prefix whitelist of commands that run
  **outside** the sandbox. `ls` and `tree` read directory entries
  (`readdir`) but never `open()` file contents, so running them
  unsandboxed is safe — they list names and sizes and nothing more.
- Paired permission rules: `"allow": ["Bash(ls:*)", "Bash(tree:*)"]`
  auto-allow them at the permission layer; `"ask": ["Bash(*)"]` sends
  anything else (like `cat`, `python3 -c`, `grep`) to a prompt. If you
  approve, the command runs inside the sandbox and hits `EACCES` if it
  tries to `open()` a sensitive file.
- The sandbox does **not** cover in-process tools (`Read`, `Edit`,
  `Write`, `Glob`, `Grep`) — those stay under permission rules. So we
  keep `"deny": ["Read(./sensitive/**)"]` as the belt alongside
  `denyRead`'s braces.

**What the agent can do:**

- `ls sensitive/` / `tree sensitive/` → see filenames (unsandboxed, permission-allowed)

**What it cannot do:**

- `cat sensitive/customer-data.csv` → ask; if approved, sandbox `EACCES`
- `python3 -c 'open("sensitive/...")'` → ask; if approved, sandbox `EACCES`
- `Read` tool on any `sensitive/` file → permission deny (the Read tool
  runs in-process and the sandbox doesn't touch it — the permission
  rule is what blocks it)

**Try it:**

```bash
# Both variants: listing works
task demo:sensitive          # without-sandbox
task demo:sensitive:sandbox  # with-sandbox
# → ls sensitive/ returns filenames

# The contrast: approve a content-read bypass
task demo:sensitive:read:sandbox
# → python3 open() asks; approve → sandbox EACCES
```

In without-sandbox the same approval would succeed and leak the file.

> **The gotcha:** "search contents without seeing contents" has no
> clean primitive. `grep` (without `-l`) prints matching lines, which
> is a read — sandbox blocks it inside `sensitive/`. If you really need
> content-search, you either approve a specific command (and accept
> the leak) or build an indexed search outside the agent's reach.

### Scenario 4 — `./restricted/**` requires an explicit OK

![Scenario 4 diagram](diagrams/permissions/4-restricted-ask.svg)

The rule:

```json
"ask": ["Read(./restricted/**)"]
```

When the agent tries to `Read` a file in `restricted/`, Claude Code pops a
prompt: *"Allow Read(./restricted/deploy-config.json)?"* You choose:

- **Yes** — allow this one call
- **Yes, and don't ask again** — promotes it to `allow` for the session (or
  permanently, depending on which option you pick)
- **No** — blocks it, and the agent gets an error it can react to

This is the right setting for files that are usually fine to read but that
you want a speed bump on — deploy configs, internal notes, anything where
you want to stay in the loop.

**Try it** (note: no `-p` flag — we want interactive mode so you see the
approve/deny dialog; headless mode would auto-deny and skip the interesting
part):

```bash
cd without-sandbox    # same in with-sandbox
claude "Summarize restricted/team-notes.md"
```

## File layout

```
README.md                ← you are here (authoring: orients learners)
Taskfile.yml             ← author + demo tasks (tasks `cd` into subdirs)
diagrams/                ← D2 source + exported SVGs (authoring)
  permissions.d2
  permissions/
    1-deny-env.svg
    1b-sandbox-blocks-bypass.svg
    2-deny-innocuous.svg
    3-sensitive-list-only.svg
    4-restricted-ask.svg
    index.svg            ← base diagram (no scenario applied)
without-sandbox/         ← learner runs `cd without-sandbox && claude ...`
  .claude/settings.json
  .env, .env.example, app-config.yaml
  public/welcome.txt
  sensitive/{customer-data.csv, server-logs.log}
  restricted/{deploy-config.json, team-notes.md}
with-sandbox/            ← same targets, sandbox-enabled settings
  .claude/settings.json  ← permissions + sandbox block
  (same files as without-sandbox/)
```

## Regenerating the diagrams

Run `task diagrams` from the repo root — a thin wrapper around:

```bash
cd diagrams
d2 --theme 0 --dark-theme 200 permissions.d2 permissions.svg
```

D2 detects the `scenarios:` block in the source and exports one SVG per
scenario into `diagrams/permissions/`, plus an `index.svg` for the base.
`--theme 0` (neutral light) paired with `--dark-theme 200` (dark mauve)
embeds both variants in each file; the viewer's `prefers-color-scheme`
picks.

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
