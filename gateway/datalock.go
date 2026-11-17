package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// One gateway per data root.
//
// A gateway owns its data root's runtime: the managed services it supervises
// (Postgres, PgBouncer), the registry it spawns backends from, the pid file.
// A second gateway on the same root cannot share any of that — its supervisor
// finds the first one's postmaster live, "reattaches" over a socket dir that is
// not the live one's, and dies; on the way it has already truncated the shared
// stdio log and written to gateway.log. That is what happened on the website
// box on 2026-11-14, when a ship ran a pre-swap bundle whose extractor booted a
// whole host beside the serving one.
//
// So the gateway takes an exclusive flock on a file in its data root before it
// does anything else, and holds it for its life (the kernel drops it when the
// process exits, however it exits — nothing to clean up, nothing stale). A
// second gateway fails at once, naming the one that holds the root. A
// successor started by a restart never sees it: every restart path (systemd,
// `./equin start`'s reload) waits for the old process to be gone first.

// dataRootLock is held, open, for the process's life. A package variable so the
// *os.File is never unreachable: its finalizer would close the descriptor and
// release the lock while the gateway still runs.
var dataRootLock *os.File

// acquireDataRootLock takes the data root's gateway lock, or says who holds it.
// The holder's pid is written into the file after the lock is taken, for the
// refusal of the next one to name.
func acquireDataRootLock(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, heldError(path)
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return nil, err
	}
	if _, err := f.WriteAt([]byte(fmt.Sprintf("%d\n", os.Getpid())), 0); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// dataRootHeldError: something holds this data root's gateway lock. It names
// what really holds it (holders, read from the kernel's open files), not only
// the pid the lock file records: that pid is the gateway that TOOK the lock,
// and on 2026-11-17 it was long dead — a log relay that had inherited the
// descriptor held it, and the refusal named the dead gateway.
type dataRootHeldError struct {
	path     string
	recorded string // the pid the lock file records, or "" when it names none
	// recordedLive: that pid is still a running process.
	recordedLive bool
	holders      []lockHolder
	// listErr: the holders could not be listed (then only recorded is known).
	listErr error
}

// lockHolder is one process with the lock file open.
type lockHolder struct {
	pid     int
	command string // its argv as ps prints it, or "" when it exited meanwhile
}

func (h lockHolder) String() string {
	if h.command == "" {
		return fmt.Sprintf("pid %d", h.pid)
	}
	return fmt.Sprintf("pid %d (%s)", h.pid, h.command)
}

func (e *dataRootHeldError) Error() string {
	var b strings.Builder
	if len(e.holders) > 0 {
		names := make([]string, len(e.holders))
		for i, h := range e.holders {
			names[i] = h.String()
		}
		fmt.Fprintf(&b, "another gateway already serves this data root: its lock %s is held by %s", e.path, strings.Join(names, ", "))
	} else if e.recorded != "" {
		fmt.Fprintf(&b, "another gateway (pid %s) already serves this data root (it holds %s)", e.recorded, e.path)
	} else {
		fmt.Fprintf(&b, "another gateway already serves this data root (it holds %s)", e.path)
	}
	if e.recorded != "" && len(e.holders) > 0 && !e.heldByRecorded() {
		if e.recordedLive {
			fmt.Fprintf(&b, "; the lock file names pid %s, which does not hold it", e.recorded)
		} else {
			fmt.Fprintf(&b, "; the lock file names pid %s, which no longer runs — the holder inherited the lock from it", e.recorded)
		}
	} else if e.recorded != "" && len(e.holders) == 0 && !e.recordedLive {
		fmt.Fprintf(&b, "; pid %s no longer runs — a process it started may hold the lock", e.recorded)
	}
	if e.listErr != nil {
		fmt.Fprintf(&b, " (its holders could not be listed: %v)", e.listErr)
	}
	b.WriteString("; refusing to start a second one beside it")
	return b.String()
}

func (e *dataRootHeldError) heldByRecorded() bool {
	for _, h := range e.holders {
		if strconv.Itoa(h.pid) == e.recorded {
			return true
		}
	}
	return false
}

// heldError reads who holds the lock at path, for a refusal to name.
func heldError(path string) *dataRootHeldError {
	e := &dataRootHeldError{path: path, recorded: readLockHolder(path)}
	if pid, err := strconv.Atoi(e.recorded); err == nil && pid > 0 {
		// Signal 0: delivered to nothing, answers whether the pid exists.
		// EPERM means it exists under another user.
		err := syscall.Kill(pid, 0)
		e.recordedLive = err == nil || errors.Is(err, syscall.EPERM)
	}
	e.holders, e.listErr = listLockHolders(path)
	return e
}

func readLockHolder(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// lsofCandidates: where lsof lives (macOS; Linux distributions). Absolute, so
// the lookup needs no PATH — it runs before the child environment exists.
var lsofCandidates = []string{"/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"}

// listLockHolders lists every process with path open — the processes that
// share the lock's open file, which is what holds a flock. Only on the
// refusal path, bounded: a diagnosis, never a decision.
func listLockHolders(path string) ([]lockHolder, error) {
	lsof := ""
	for _, c := range lsofCandidates {
		if _, err := os.Stat(c); err == nil {
			lsof = c
			break
		}
	}
	if lsof == "" {
		return nil, errors.New("no lsof on this machine")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := ChildEnv{}.CommandContext(ctx, lsof, "-n", "-w", "-F", "p", "--", path).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 && len(out) == 0 {
		// lsof exits 1 when nothing has the file open: the holder exited
		// between the refused flock and this read.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", lsof, err)
	}
	var holders []lockHolder
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "p") {
			continue
		}
		pid, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, fmt.Errorf("%s: unexpected line %q", lsof, line)
		}
		holders = append(holders, lockHolder{pid: pid, command: processCommand(ctx, pid)})
	}
	return holders, nil
}

// processCommand is pid's argv as ps prints it, "" when it has exited.
func processCommand(ctx context.Context, pid int) string {
	out, err := ChildEnv{}.CommandContext(ctx, "/bin/ps", "-o", "args=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	cmd := strings.TrimSpace(string(out))
	// A gateway's argv runs to a dozen absolute paths: enough to tell what it is.
	if len(cmd) > 160 {
		cmd = cmd[:160] + "…"
	}
	return cmd
}

// sealInheritedFds marks every descriptor this process inherited close-on-exec,
// so nothing it starts receives one it was not handed by name (ExtraFiles).
// Called first thing in main, in every mode (keeper, generation, relay).
//
// exec clears FD_CLOEXEC on every descriptor it hands a child (ExtraFiles),
// so a generation receives the control socket and the data-root lock
// inheritable — and, left so, handed both to every process it starts itself
// (a supervised service's log relay, which outlives every gateway). The
// relay then held the data-root lock after its gateway exited: the next
// gateway refused to start ("another gateway already serves this data
// root"), the first full restart of the service under a keeper left the
// machine with no gateway (2026-11-17, the move off the legacy port).
//
// Every descriptor, not a list of the ones the keeper hands today: a
// descriptor added to ExtraFiles later, or one a launcher leaks into the
// keeper, can then not leak further either. Go opens everything of its own
// close-on-exec, so after this no descriptor of this process is inheritable
// except by naming it. Sealed, the process still holds each for its life.
func sealInheritedFds() error {
	fds, err := openFds()
	if err != nil {
		return err
	}
	for _, fd := range fds {
		if fd < 3 {
			continue // stdio: dup'd onto a child's 0–2 by name, never leaked
		}
		if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC); errno != 0 {
			// The listing's own directory descriptor, closed since.
			if errno == syscall.EBADF {
				continue
			}
			return fmt.Errorf("seal inherited fd %d: %w", fd, errno)
		}
	}
	return nil
}

// openFds lists this process's open descriptors: /dev/fd (fdesc on macOS, a
// link to /proc/self/fd on Linux).
func openFds() ([]int, error) {
	entries, err := os.ReadDir("/dev/fd")
	if err != nil {
		return nil, fmt.Errorf("list open descriptors: %w", err)
	}
	fds := make([]int, 0, len(entries))
	for _, e := range entries {
		fd, err := strconv.Atoi(e.Name())
		if err != nil {
			continue // "." / ".." where listed
		}
		fds = append(fds, fd)
	}
	return fds, nil
}
