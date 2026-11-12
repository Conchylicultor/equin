# process-name

What a process is called in Activity Monitor and `ps`. macOS names a process by
the file it executed, so every Bun process reads `bun`; `process.title` changes
nothing there. An APFS clone is a copy sharing the original's blocks, so running
Bun through one names the process, at no disk cost.

**Never a hardlink.** A hardlink is the same inode under another name, and at
exec macOS's malware scan (syspolicyd) asks the kernel for the executable's
path — which for an inode with many names can be any of them, including one
just renamed away or deleted. syspolicyd cannot read it (ENOENT), logs
`Terminating process due to Malware rejection` and SIGKILLs the process inside
exec, before it prints anything. With every named Bun one inode of ~800
churning names, that killed a worktree's `./equin install` and a `./equin push`
(2026-11-03). Reproduced: a stable hardlink exec'd while sibling names are
made and deleted died 7 times in 2,600 runs; a stable clone 0 in 2,300. Spot one
with `log show --predicate 'process == "syspolicyd" AND eventMessage CONTAINS
"Malware rejection"'`. A fresh name — clone or link — costs one ~1.1 s scan on
its first exec, so a current clone is never re-made.

- `processName(kind, id?)` (`core`) — `equin · <kind> · <id>` (kind first, so
  a sorted list groups every build, agent and server together).
  `processKindOf(args)` reads the kind back from a `ps` command line (null for
  a process not named so) — how `debug/sentinel/machine-usage` tells backends
  and agents apart.
- `cloneNamedBinary({ bin, dir, name })` — clone `bin` into `dir` as `name`. A
  name already holding a current clone (one link, the source's size and mtime —
  a clone keeps the mtime) is left alone; otherwise the clone is swapped in with
  one rename, so an old build's hardlink is replaced. Making one holds a
  per-name kernel lock across processes (`dir/.locks/<name>`, packages/flock):
  for a name many processes share, a second maker's rename would unname the
  first's file while a process that exec'd it is still being scanned — the
  SIGKILL above. `{ kind: "refused" }` when
  the filesystem cannot (not APFS, another volume): run `bin` itself. Every
  call also removes the staging files (`.<pid>[.<seq>].tmp`) in `dir` whose
  writer is dead (a crash mid-clone; the hardlink builds' leaks), so a dir
  heals the next time anything is named in it.
- `sharedBunDir()` / `cloneSharedBun(name)` / `sharedBunsNamed(name)` — the
  machine-wide named Buns, `process-names/bun-<version>/`: one clone per name
  and Bun version, shared by every checkout and backend, so macOS scans each
  once per machine. The CLI verbs sit in it directly (named by the `./equin`
  script from its argv); what a backend starts (`cloneSharedBun`: the SDK
  agents' `equin · agent`) in its `processes/`, so no verb can take one of
  those names. `sharedBunsNamed` lists a name under every version, for the
  one who runs processes through it to reclaim an upgrade's leftovers
  (`runtime-sdk`'s daily agent-dirs reclaim does it for `equin · agent`).
- `refreshCheckoutBun(root, bin, verbsDir)` / `CHECKOUT_BUN_DIR` — the
  checkout's Bun as a clone plus a stamp, and `verbs`, a symlink to
  `verbsDir` (the `process-names` data dir's `bun-<version>/`), written by the
  CLI on every run. The `./equin` script runs the CLI as `verbs/equin · <verb>`
  (a clone of the checkout's Bun, made with `cp -c`), trusting it only while the
  stamp is newer than `mise.lock` (else it runs plain `bun`, and that run
  refreshes it). Each refresh also removes the per-checkout verb names an older
  script made (`equin · <verb> · <checkout>`).

**Why CLI verbs carry no checkout id.** macOS scans a fresh executable on its
first exec (syspolicyd: ~1 s, and two full reads of the 88 MB Bun). One name per
(verb × checkout) made every new worktree pay a dozen such scans: 37 GB of
syspolicyd reads in one hour on 2026-11-05, 28 % of the host's attributed disk
reads, and a source of the io-health `rename-stall` finding. So a verb's name is
made once per machine and Bun version, and every checkout runs it through its
`verbs` symlink — exec through a symlink is no fresh file (no scan, measured)
and is still listed under the clone's name (a symlink to a *directory*: a
symlink to the file itself names the process after its target).

**What the scan's verdict is kept by** (measured 2026-11-12, a 6 s settle
after each scan, the 322 MB claude): the (path, file) pair. Same file, same
path: 0.03 s. The scanned file renamed or moved to a new path: 1.5–1.8 s
(rescanned); hardlinked to a new path: 1.5 s; renamed back to its old path:
free; a new clone at a scanned path: 3.0–3.6 s. Not the signature: a copy of
the notarized Developer ID binary (same cdhash) scans in full, an ad-hoc
re-signed one too, with or without `com.apple.provenance`; `spctl --assess`
does not pre-warm it. A move within ~1 s of the scan sometimes skips it — the
verdict is still being written — which is why earlier tries saw "6 of 8". So a
pool of pre-scanned clones renamed into place does not help, and every new
executable path pays one scan.

Per-instance names stay only where they are worth a scan: backends (long-lived,
one per build) and the agent's claude, whose path is its macOS permission
identity (TCC keys a bundle-less client by path, so per-conversation grants
need a per-conversation file). The agent's bun is the shared `equin · agent`:
a per-conversation one cost every new conversation's first start ~1.7 s, and
its claude already carries the conversation's name.

Who names what:

| Process | Name | Where |
|---|---|---|
| CLI op | `equin · build` (one machine-wide clone per verb) | the `./equin` script |
| backend / central | `equin · server · att-…`, `equin · central` | `./equin build`, as the spec's `command` |
| SDK agent wrapper | `equin · agent` (one machine-wide clone per Bun version) | `runtime-sdk`'s `startAgentProcess` |
| the agent's claude | `equin · conv-… · <title>` | `runtime-sdk`'s `named-claude.ts` (its own scheme: a TCC grant is keyed by it) |

Children a named process spawns through `process.execPath` inherit its name — a
test worker reads as the `test` op that started it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: What a process is called in Activity Monitor and ps: processName(kind, id?) spells `equin · <kind> · <id>`, and cloneNamedBinary gives an executable that name as an APFS clone (same signed bytes, no disk cost, a file of its own — never a hardlink, whose many names let macOS's exec scan be handed a deleted one and SIGKILL the process — left alone while current, else swapped in with one rename) — macOS names a process by the file it executed, and process.title changes nothing. Also the checkout's Bun record (refreshCheckoutBun / checkoutBun) the build names backends from, and the checkout's `verbs` link to the machine-wide process-names data dir, where `./equin` runs each CLI verb as `equin · <verb>` — one clone per verb machine-wide, since macOS scans every fresh executable name on its first exec.
- Core:
  - Uses: `framework/product-name.PRODUCT_NAME`
  - Exports (values):
    - `processKindOf`
    - `processName`
- Cross-plugin:
  - Imported by:
    - `conversations/runtime-sdk`
    - `debug/sentinel/machine-usage`
    - `framework/cli/bootstrap`
    - `framework/cli/build`
- Machine:
  - Exports (types): `NamedBinary`
  - Exports (values):
    - `CHECKOUT_BUN_DIR`
    - `checkoutBun`
    - `cloneNamedBinary`
    - `cloneSharedBun`
    - `isCurrentCloneOf`
    - `refreshCheckoutBun`
    - `sharedBunDir`
    - `sharedBunsNamed`

<!-- AUTOGENERATED:END -->
