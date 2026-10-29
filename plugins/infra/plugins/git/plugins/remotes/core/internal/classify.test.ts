import { describe, expect, test } from "bun:test";
import { classifyRemoteFailure, type RemoteCapture } from "./classify";
import { SOURCE_REPO } from "@plugins/framework/plugins/product-name/core";

// Every sample below is real `git push` output, kept verbatim — including the
// generic `fatal:` tail git appends to causes that mean opposite things, which
// is the thing the classifier has to see past.
const capture = (stderr: string, exitCode = 128): RemoteCapture => ({
  exitCode,
  timedOut: false,
  stdout: "",
  stderr,
});

describe("classifyRemoteFailure", () => {
  // There is no success arm: a command that worked has no failure to classify,
  // and answering "unclassified" for one would hand the caller a cause for
  // something that never went wrong. Each caller decides what success means —
  // for the write probe, that it may publish.
  test("a command that succeeded is a misuse, not an outcome", () => {
    expect(() => classifyRemoteFailure(capture("", 0))).toThrow(
      /no failure to classify/,
    );
  });

  // The deadline is checked before that guard, because a killed child's exit
  // code is the runtime's business and may well be 0.
  test("our own deadline is a failure whatever the exit code says", () => {
    expect(
      classifyRemoteFailure({
        exitCode: 0,
        timedOut: true,
        stdout: "",
        stderr: "",
      }),
    ).toEqual({ kind: "unreachable", detail: "the command timed out" });
  });

  test("an unreachable host is not a read-only repository", () => {
    const outcome = classifyRemoteFailure(
      capture(
        "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known\n" +
          "fatal: Could not read from remote repository.\n",
      ),
    );
    expect(outcome.kind).toBe("unreachable");
    expect(outcome).toHaveProperty("detail", expect.stringContaining("ssh:"));
  });

  test("a refused connection is unreachable", () => {
    expect(
      classifyRemoteFailure(
        capture(
          "ssh: connect to host github.com port 22: Connection refused\n" +
            "fatal: Could not read from remote repository.\n",
        ),
      ).kind,
    ).toBe("unreachable");
  });

  test("https with no route out is unreachable", () => {
    expect(
      classifyRemoteFailure(
        capture(
          "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 75000 ms: Couldn't connect to server\n",
        ),
      ).kind,
    ).toBe("unreachable");
  });

  test("our own deadline is unreachable, whatever git had printed", () => {
    expect(
      classifyRemoteFailure({
        exitCode: 143,
        timedOut: true,
        stdout: "",
        stderr: "",
      }).kind,
    ).toBe("unreachable");
  });

  // The ordering trap: this stderr contains "permission denied", and it means
  // the remote never found out who we are.
  test("a rejected ssh key is a credentials problem, not a permission answer", () => {
    expect(
      classifyRemoteFailure(
        capture(
          "git@github.com: Permission denied (publickey).\n" +
            "fatal: Could not read from remote repository.\n",
        ),
      ).kind,
    ).toBe("no-credentials");
  });

  test("a suppressed username prompt is a credentials problem", () => {
    expect(
      classifyRemoteFailure(
        capture(
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        ),
      ).kind,
    ).toBe("no-credentials");
  });

  test("github refusing a write to a repo it knows we cannot write is denied", () => {
    expect(
      classifyRemoteFailure(
        capture(
          `remote: Permission to ${SOURCE_REPO}.git denied to someone.\n` +
            "fatal: unable to access 'https://github.com/Conchylicultor/equin.git/': The requested URL returned error: 403\n",
        ),
      ).kind,
    ).toBe("denied");
  });

  test("a private repo answering as absent is denied", () => {
    expect(
      classifyRemoteFailure(
        capture(
          "ERROR: Repository not found.\n" +
            "fatal: Could not read from remote repository.\n",
        ),
      ).kind,
    ).toBe("denied");
  });

  test("a read-only filesystem remote is denied", () => {
    expect(
      classifyRemoteFailure(
        capture(
          "error: insufficient permission for adding an object to repository database ./objects\n",
        ),
      ).kind,
    ).toBe("denied");
  });

  test("a bare permission denial, with no more specific cause, is denied", () => {
    expect(
      classifyRemoteFailure(capture("fatal: '/srv/up.git' Permission denied\n"))
        .kind,
    ).toBe("denied");
  });

  // The generic line git prints for BOTH an unreachable host and a rejected
  // key. On its own it says nothing, and guessing from it is exactly the
  // mistake that would record a flat network as a read-only repository.
  test("the generic tail alone names no cause", () => {
    expect(
      classifyRemoteFailure(
        capture("fatal: Could not read from remote repository.\n"),
      ).kind,
    ).toBe("unclassified");
  });

  test("an unclassified failure carries git's own first line", () => {
    const outcome = classifyRemoteFailure(
      capture("fatal: the remote end hung up unexpectedly\n"),
    );
    expect(outcome).toEqual({
      kind: "unclassified",
      detail: "fatal: the remote end hung up unexpectedly",
    });
  });
});
