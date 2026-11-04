package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Service log relay.
//
// A supervised service (Postgres, PgBouncer) is a daemon that OUTLIVES the
// gateway: a gateway restart reattaches to it. So its output cannot be a pipe
// into the gateway process — the first gateway restart would cut it. Instead
// every service start gets its own relay: a detached copy of this binary in
// relay mode (`gateway -log-relay <path>`) that reads the daemon's
// stdout/stderr from a pipe and writes it through the same rotatingWriter (and
// bound) as every other gateway channel. The relay lives exactly as long as the
// daemon's processes hold the pipe's write end, and exits at EOF.
//
// That keeps the daemon from ever owning a log FILE: its log's bound is the
// writer's, by construction. (The trade, shared with Postgres's own
// logging_collector: a relay that stops reading would block the daemon's
// stderr writes once the pipe buffer fills. The relay does nothing but append
// to a local file.)

// logRelayFlag is the argv[1] that selects relay mode. Checked before the
// gateway's own flag set is parsed: relay mode takes no other flag.
const logRelayFlag = "-log-relay"

// serviceLogsSubdir is where each service's channel lives under -log-dir:
// `<log-dir>/services/<service>.log`. A subdir, so a service name can never
// collide with a namespace's `<name>.log`. Pinned to the TypeScript side
// (`SERVICE_LOGS_SUBDIR`, infra/launcher/gateway-logs) by `gateway-logs:in-sync`.
const serviceLogsSubdir = "services"

// serviceLogFdFlag is appended to a service's start command, naming the
// inherited file descriptor it hands its daemon as stdout/stderr: on argv, not
// in the environment, because the daemon would inherit an environment variable
// for life. Pinned to the start scripts' parser (`SERVICE_LOG_FD_FLAG`,
// infra/launcher/gateway-logs) by `gateway-logs:in-sync`.
const serviceLogFdFlag = "--log-fd"

// serviceLogFd is that descriptor: the first of cmd.ExtraFiles.
const serviceLogFd = 3

// serviceLogPath is the channel a service's relay writes.
func serviceLogPath(logDir, service string) string {
	return filepath.Join(logDir, serviceLogsSubdir, service+".log")
}

// runLogRelay copies r into a rotating writer at path, line by line, until EOF.
// Whole lines are written in one Write each, so a rotation never splits one;
// a final unterminated chunk at EOF is written as is.
func runLogRelay(path string, r io.Reader, maxBytes int64, maxBackups int) error {
	w := newRotatingWriter(path, maxBytes, maxBackups)
	defer w.Close()
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			if _, werr := w.Write(line); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// logRelayMain is relay mode's whole process: `gateway -log-relay <path>`.
func logRelayMain(args []string) int {
	if len(args) != 1 {
		fmt.Fprintf(os.Stderr, "gateway %s: want exactly one path, got %q\n", logRelayFlag, args)
		return 2
	}
	if err := runLogRelay(args[0], os.Stdin, maxLogBytes, maxLogBackups); err != nil {
		fmt.Fprintf(os.Stderr, "gateway %s %s: %v\n", logRelayFlag, args[0], err)
		return 1
	}
	return 0
}

// startLogRelay spawns a detached relay for one service start and returns the
// pipe's write end, for the caller to hand to the start command (and then
// close). The relay runs in its own session so it survives the gateway; its
// exit is reaped in the background while the gateway lives.
func startLogRelay(env ChildEnv, path string) (*os.File, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve own executable: %w", err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := env.Command(self, logRelayFlag, path)
	cmd.Stdin = r
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		_ = r.Close()
		_ = w.Close()
		return nil, fmt.Errorf("start log relay: %w", err)
	}
	// The relay holds its own copy of the read end; ours would keep the pipe
	// readable after the relay dies, hiding EPIPE from the daemon forever.
	_ = r.Close()
	go reapRelay(cmd)
	return w, nil
}

func reapRelay(cmd *exec.Cmd) { _ = cmd.Wait() }
