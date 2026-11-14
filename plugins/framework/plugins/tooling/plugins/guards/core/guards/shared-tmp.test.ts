import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { sharedTmpGuard } from "./shared-tmp";

const WT = "/r/repo/.claude/worktrees/att-123-abcd";
const LAUNCHED = "/tmp/equin-scratch/conv-1-abc";
const SESSION = "615f223d-ac72-45b2-9bb8-6f7d361d78da";

type Input = { file_path?: string; notebook_path?: string; command?: string };

function verdict(input: Input, scratch: string | null = LAUNCHED): Verdict {
  const ctx = createContext(
    WT,
    SESSION,
    [],
    undefined,
    null,
    null,
    WT,
    scratch,
  );
  return (sharedTmpGuard.check(input, ctx) ?? { kind: "allow" }) as Verdict;
}
const blocks = (input: Input) => verdict(input).kind === "deny";
const cmd = (command: string) => blocks({ command });

describe("shared-tmp guard", () => {
  test("the 2026-11-08 incident: the message file write is refused", () => {
    expect(
      cmd(
        "cat > /tmp/msg.txt <<'EOF'\nfix: x\nEOF\n./equin push -m \"$(cat /tmp/msg.txt)\"",
      ),
    ).toBe(true);
    expect(blocks({ file_path: "/tmp/msg.txt" })).toBe(true);
    expect(blocks({ file_path: "/private/tmp/review.md" })).toBe(true);
    expect(blocks({ notebook_path: "/tmp/n.ipynb" })).toBe(true);
  });

  test("writes by redirection, known writers and cwd are refused", () => {
    expect(cmd("./equin check 2>&1 | tee /tmp/tc.log")).toBe(true);
    expect(cmd("./equin test x > /tmp/t.log 2>&1")).toBe(true);
    expect(cmd("echo hi >> /var/tmp/x")).toBe(true);
    expect(cmd("cp a.txt /tmp/b.txt")).toBe(true);
    expect(cmd("mkdir -p /tmp/bp10")).toBe(true);
    expect(cmd("cd /tmp && cat > msg.txt <<'EOF'\nx\nEOF")).toBe(true);
    expect(cmd("cd /tmp && tar czf out.tgz x")).toBe(true);
    expect(cmd("cd /tmp/x && ./equin run e2e/shot.ts --out shot")).toBe(true);
    expect(cmd("curl -s http://x -o /tmp/optime/snap.json")).toBe(true);
    expect(cmd("python3 /tmp/fiximp.py a.ts")).toBe(true);
    expect(cmd("dd if=/dev/zero of=/tmp/a bs=1 count=1")).toBe(true);
    expect(cmd("bash -c 'echo x > /tmp/a'")).toBe(true);
    expect(cmd('sh -lc "cd /tmp && tar czf o.tgz x"')).toBe(true);
    expect(cmd("eval 'echo x > /tmp/a'")).toBe(true);
    expect(cmd("git clone https://x/y.git /tmp/y")).toBe(true);
  });

  test("an unknown command handed a fixed temp path is refused", () => {
    expect(cmd("./equin run e2e/screenshot.ts --out /tmp/shot")).toBe(true);
    expect(cmd("./equin run e2e/screenshot.ts --out=/tmp/shot")).toBe(true);
    expect(cmd("go build -o /tmp/gateway .")).toBe(true);
    expect(cmd("git bundle create /tmp/main.bundle main")).toBe(true);
  });

  test("the cd itself writes nothing (audit 2026-11-14: 27 refusals)", () => {
    expect(cmd("cd /tmp/fsev-tap && ls")).toBe(false);
    expect(cmd('cd /tmp; for f in tc-*.json; do head -c 200 "$f"; done')).toBe(
      false,
    );
    // Code is never read for intent: an interpreter there counts.
    expect(cmd('cd /tmp && python3 -c "\nprint(1)\n"')).toBe(true);
    expect(cmd("cd /tmp/equin-film/session; head -c 1500 places.json")).toBe(
      false,
    );
    expect(cmd("cd /tmp && find . -name '*.json'")).toBe(false);
    expect(
      cmd(
        "cd /private/tmp/claude-501/bundled-skills/2.1.319/a323/claude-api; grep -n x shared/a.md",
      ),
    ).toBe(false);
    // …but what runs there and writes still lands in the shared dir.
    expect(cmd("cd /tmp && cat > msg.txt <<'EOF'\nx\nEOF")).toBe(true);
    expect(cmd("cd /tmp && tar czf out.tgz x")).toBe(true);
    expect(cmd("cd /tmp && mkdir pgq-probe")).toBe(true);
    expect(cmd("cd /tmp/bunsrc && curl -s https://x/a.rs -o lib.rs")).toBe(
      true,
    );
    expect(
      cmd(
        "cd /tmp/photos && for f in *.jpg; do curl -sfL https://x -o $f; done",
      ),
    ).toBe(true);
    expect(
      cmd("cd /tmp/bp13-cov && python3 - <<'EOF'\nopen('a.ts','w')\nEOF"),
    ).toBe(true);
    expect(
      cmd("cd /tmp/x && python3 -c \"open('o.txt', 'w').write('1')\""),
    ).toBe(true);
    expect(cmd("cd /tmp/x && python3 fix.py")).toBe(true);
  });

  test("read-only operands are not write targets", () => {
    expect(cmd(`sips -s format bmp /tmp/x.png --out ${LAUNCHED}/c.bmp`)).toBe(
      false,
    );
    expect(cmd(`ffmpeg -y -i /tmp/in.mp4 -vf scale=1 ${LAUNCHED}/o.png`)).toBe(
      false,
    );
    expect(cmd("lsof +d /private/tmp/pw-race")).toBe(false);
    expect(cmd("otool -L /tmp/rel/watcher.node")).toBe(false);
    expect(cmd("find /tmp/equin-film -name '*.png'")).toBe(false);
    expect(cmd("git apply /tmp/hostfs-fix.patch")).toBe(false);
    expect(cmd("timeout 60 ./equin run x.ts")).toBe(false);
    // The outputs of the same commands still count.
    expect(cmd("sips -Z 320 in.jpg --out /tmp/x.png")).toBe(true);
    expect(cmd("sips -Z 900 /tmp/crop.png")).toBe(true); // in place
    expect(cmd("ffmpeg -i in.mp4 /tmp/equin-film/rt/sheet.png")).toBe(true);
    expect(cmd("find /tmp/old -delete")).toBe(true);
    expect(cmd("find . -name x -fprint /tmp/list.txt")).toBe(true);
    expect(cmd("timeout 60 ./equin run x.ts --out /tmp/shot")).toBe(true);
    expect(cmd("curl -s http://x -o /tmp/rdbg.json")).toBe(true);
  });

  test("review 2026-11-14: what still writes a shared dir is refused", () => {
    // pushd moves the cwd like cd.
    expect(cmd("pushd /tmp && cat > msg.txt <<'EOF'\nx\nEOF")).toBe(true);
    expect(cmd("pushd /tmp && tar czf o.tgz x")).toBe(true);
    // Fail-closed in a shared cwd: a write that names no file is still one.
    expect(cmd("cd /tmp && curl -O https://x.com/a.txt")).toBe(true);
    expect(cmd("cd /tmp && wget https://x.com/a.txt")).toBe(true);
    expect(cmd("cd /tmp && unzip /w/me/a.zip")).toBe(true);
    expect(cmd("cd /tmp && make")).toBe(true);
    expect(cmd("cd /tmp && python3 /w/me/gen.py")).toBe(true);
    expect(cmd("cd /tmp && xargs -n1 curl -O < /w/me/urls")).toBe(true);
    expect(cmd("cd /tmp && git apply /a/p.patch")).toBe(true);
    expect(cmd("cd /tmp && perl -e 'open(F, \">a.txt\")'")).toBe(true);
    expect(cmd("cd /tmp && awk 'BEGIN{print 1 > \"a\"}'")).toBe(true);
    expect(cmd("cd /tmp && osascript -e 'do shell script \"touch a\"'")).toBe(
      true,
    );
    expect(cmd("cd /tmp && python3 -c \"open('a.txt', mode='w')\"")).toBe(true);
    expect(
      cmd(
        "cd /tmp && python3 -c \"import pathlib; pathlib.Path('a').touch()\"",
      ),
    ).toBe(true);
    expect(cmd("cd /tmp && python3 -c \"import os; os.system('x')\"")).toBe(
      true,
    );
    // …while reads there pass.
    expect(cmd("cd /tmp && rg -n x a.log && git -C /r log")).toBe(false);
    expect(cmd("cd /tmp && awk -F'\\t' '{print $1}' a.tsv")).toBe(false);
    expect(cmd("cd /tmp/s; ls | sed 's/x//' | sort | uniq -c")).toBe(false);
    expect(cmd("cd /tmp/s; stat x | awk '{d=$2-p; if (d>3000) print d}'")).toBe(
      false,
    );
    expect(cmd("cd /tmp; curl -s http://x/a.js | head -5")).toBe(false);
    expect(cmd("cd /tmp && curl -sLO https://x/a.txt")).toBe(true);
    expect(cmd("cd /tmp && sort a -o b")).toBe(true);
    expect(cmd("cd /tmp && uniq a b")).toBe(true);
    expect(cmd("sort a -o /tmp/b")).toBe(true);
    // Ordinary names are no random suffix; $$ in a literal path is two chars.
    expect(cmd("echo x > /tmp/my_TestRun")).toBe(true);
    expect(cmd("echo x > /tmp/build-PR1234")).toBe(true);
    expect(cmd("echo x > /tmp/session-v2Final/msg.txt")).toBe(true);
    expect(blocks({ file_path: "/tmp/a_$$" })).toBe(true);
    expect(blocks({ file_path: "/tmp/r-$RANDOM.txt" })).toBe(true);
    // find's leading options, and a pipe into a writer.
    expect(cmd("find -L /tmp/x -delete")).toBe(true);
    expect(cmd("find -H /tmp/x -name a -delete")).toBe(true);
    expect(cmd("find -L /tmp/x -exec rm {} +")).toBe(true);
    expect(cmd("find /tmp/x -name '*.o' -print0 | xargs -0 rm")).toBe(true);
    expect(cmd("find /tmp/x -name '*.log' | xargs cat")).toBe(false);
    // Second review: writes onto the root, pipelines into writers, outputs.
    expect(cmd("cd /tmp && cp /a/b .")).toBe(true);
    expect(cmd("cd /tmp && mv /a/b .")).toBe(true);
    expect(cmd("cd /tmp && rsync -a /a/ .")).toBe(true);
    expect(cmd("cp /a/b /tmp")).toBe(true);
    expect(cmd("ln -s /a/b /tmp")).toBe(true);
    expect(cmd("cd /tmp && ls | xargs rm")).toBe(true);
    expect(cmd("cd /tmp && echo a | xargs touch")).toBe(true);
    expect(cmd("find /tmp/x | grep o | xargs rm")).toBe(true);
    expect(cmd("find /tmp/x -print0 | sort -z | xargs -0 rm")).toBe(true);
    expect(cmd("curl --output=/tmp/x https://x")).toBe(true);
    expect(cmd("curl --output-dir=/tmp/d -O https://x")).toBe(true);
    expect(cmd("curl -D /tmp/headers https://x")).toBe(true);
    expect(cmd("curl -c /tmp/cookies https://x")).toBe(true);
    expect(cmd("cd /tmp && curl -ofile.txt https://x")).toBe(true);
    expect(cmd("sort --output /tmp/x a")).toBe(true);
    expect(cmd("sort -uo /tmp/x a")).toBe(true);
    expect(cmd("uniq -f 1 a /tmp/out")).toBe(true);
    expect(cmd("base64 -i a -o /tmp/out")).toBe(true);
    expect(cmd("cd /tmp && sed -n 'w out.txt' /a/in")).toBe(true);
    expect(
      cmd("cd /tmp && node -e \"require('fs').appendFileSync('log', 'hi')\""),
    ).toBe(true);
    expect(
      cmd("cd /tmp && python3 -c \"import sqlite3; sqlite3.connect('d')\""),
    ).toBe(true);
    expect(cmd("cd /tmp && sed -n 1,5p a.log")).toBe(false);
    expect(cmd("curl -s https://x | jq .")).toBe(false);
    expect(cmd("cd /tmp && find . -name '*.o' -delete")).toBe(true);
    expect(cmd("cd /tmp && sips -Z 9 a.png")).toBe(true);
  });

  test("a name unique by construction is no shared name", () => {
    expect(cmd("sort a > /tmp/a_$$")).toBe(false);
    expect(cmd("curl -s -o /tmp/x.$$ http://x")).toBe(false);
    expect(cmd("echo x > /tmp/r-$RANDOM.txt")).toBe(false);
    expect(cmd("rm -r /tmp/type-check-batches-045lhL")).toBe(false);
    expect(cmd("rm -rf /tmp/ef-bench-hp8WwW")).toBe(false);
    expect(blocks({ file_path: "/tmp/tmp.wAkVzaePNQ/x.json" })).toBe(false);
    expect(
      cmd(
        "./equin run x.ts list '/tmp/systemd-private-1fdcbdbb035a44fdad86054d925ac35e-equin@website.service-K3xpmj/tmp/sgs-LuJq1H/.s.PGSQL.5433'",
      ),
    ).toBe(false);
    // A loop variable, a word or a lowercase id is no random suffix.
    expect(cmd("for s in a b; do echo > /tmp/demo-story-$s.log; done")).toBe(
      true,
    );
    expect(cmd("echo x > /tmp/my-Bundle")).toBe(true);
    expect(cmd("echo x > /tmp/notes-README")).toBe(true);
    expect(cmd("echo x > /tmp/fix-fooBar")).toBe(true);
    expect(cmd("echo x > /tmp/equin-scratch/conv-2-asram0/m.txt")).toBe(true);
    expect(cmd("rm /tmp/type-check-repo-*.json")).toBe(true);
  });

  test("another session's scratch is not this one's", () => {
    expect(cmd("echo x > /tmp/equin-scratch/conv-2/msg.txt")).toBe(true);
  });

  test("this session's scratch, unique names and reads pass", () => {
    expect(cmd(`cat > ${LAUNCHED}/msg.txt <<'EOF'\nx\nEOF`)).toBe(false);
    expect(cmd(`cat > "$${envName("SCRATCH")}/msg.txt" <<'EOF'\nx\nEOF`)).toBe(
      false,
    );
    expect(blocks({ file_path: `${LAUNCHED}/review.md` })).toBe(false);
    expect(cmd('f=$(mktemp); ./equin check > "$f"')).toBe(false);
    expect(cmd("mktemp /tmp/x.XXXXXX")).toBe(false);
    expect(cmd("cat /tmp/claude-501/x/tasks/b1.output")).toBe(false);
    expect(cmd("tail -50 /tmp/some.log; ls /tmp; rg foo /tmp/x.log")).toBe(
      false,
    );
    expect(blocks({ file_path: `${WT}/plugins/a.ts` })).toBe(false);
    expect(cmd("cp /tmp/tree-oracle.bak plugins/x.ts")).toBe(false);
    expect(cmd("sed -n 1,20p /tmp/equin-test-LqgCmT/output.log")).toBe(false);
    expect(
      cmd(
        `git diff > /private/tmp/claude-501/-r-repo/${SESSION}/scratchpad/p.patch`,
      ),
    ).toBe(false);
    expect(
      cmd("echo x > /tmp/claude-501/-r-repo/other-session/scratchpad/p"),
    ).toBe(true);
  });

  test("a message that mentions a temp path is not a write", () => {
    expect(
      cmd(
        "./equin push -m \"$(cat <<'EOF'\nfix: /tmp/msg.txt was shared\nEOF\n)\"",
      ),
    ).toBe(false);
    expect(cmd('./equin push -m "/tmp/msg.txt was shared"')).toBe(false);
  });

  test("without a delivered scratch dir, the session id names it", () => {
    const v = verdict({ file_path: "/tmp/msg.txt" }, null);
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    expect(v.reason).toContain(`/tmp/equin-scratch/${SESSION}`);
    expect(v.reason).toContain("mkdir -p");
    expect(blocks({ file_path: `/tmp/equin-scratch/${SESSION}/m` })).toBe(true); // a launched session's scratch is the conversation's
    expect(
      verdict({ file_path: `/tmp/equin-scratch/${SESSION}/m` }, null).kind,
    ).toBe("allow");
  });

  test("the denial names the scratch variable for a launched session", () => {
    const v = verdict({ command: "echo x > /tmp/msg.txt" });
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    expect(v.reason).toContain(`"$${envName("SCRATCH")}/msg.txt"`);
    expect(v.reason).toContain(LAUNCHED);
  });
});
