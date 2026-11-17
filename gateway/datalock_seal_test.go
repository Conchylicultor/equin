package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func cloexec(t *testing.T, fd int) bool {
	t.Helper()
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFD, 0)
	if errno != 0 {
		t.Fatalf("F_GETFD %d: %v", fd, errno)
	}
	return flags&syscall.FD_CLOEXEC != 0
}

func makeInheritable(t *testing.T, fd int) {
	t.Helper()
	if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, 0); errno != 0 {
		t.Fatal(errno)
	}
	if cloexec(t, fd) {
		t.Fatal("setup: the fd should be inheritable")
	}
}

// inheritedLock reproduces a generation's view of the data-root lock: taken,
// then held on a descriptor exec made inheritable (the keeper's ExtraFiles).
func inheritedLock(t *testing.T) (string, *os.File) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "locks", "gateway", "gateway.lock")
	lock, err := acquireDataRootLock(path)
	if err != nil {
		t.Fatal(err)
	}
	makeInheritable(t, int(lock.Fd()))
	return path, lock
}

// startSleeper starts a long-lived child the way a generation starts a log
// relay: nothing handed to it by name.
func startSleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := ChildEnv{}.Command("/bin/sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd
}

// deadPid is the pid of a process that has exited and been reaped.
func deadPid(t *testing.T) int {
	t.Helper()
	cmd := ChildEnv{}.Command("/usr/bin/true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

// The 2026-11-17 outage, reproduced: a child started over an inheritable lock
// descriptor holds the lock after its gateway let go of it, and the refusal
// must name that child — not the dead gateway the lock file records.
func TestUnsealedLockOutlivesItsGatewayAndTheRefusalNamesTheRealHolder(t *testing.T) {
	path, lock := inheritedLock(t)
	relay := startSleeper(t)
	// The gateway exits: its copy closes; the child's stays.
	lock.Close()
	dead := deadPid(t)
	if err := os.WriteFile(path, []byte(fmt.Sprintf("%d\n", dead)), 0o644); err != nil {
		t.Fatal(err)
	}

	next, err := acquireDataRootLock(path)
	if err == nil {
		next.Close()
		t.Fatal("setup: the child should hold the inherited lock")
	}
	var held *dataRootHeldError
	if !errors.As(err, &held) {
		t.Fatalf("want dataRootHeldError, got %T: %v", err, err)
	}
	msg := err.Error()
	if !strings.Contains(msg, fmt.Sprintf("pid %d (/bin/sleep 60)", relay.Process.Pid)) {
		t.Fatalf("refusal does not name the real holder (pid %d): %s", relay.Process.Pid, msg)
	}
	if !strings.Contains(msg, fmt.Sprintf("names pid %d, which no longer runs", dead)) {
		t.Fatalf("refusal does not say the recorded pid is dead: %s", msg)
	}
}

// The fix: sealed, nothing the process starts inherits the lock, so it is free
// the moment the process that holds it lets go.
func TestSealedLockDiesWithItsGateway(t *testing.T) {
	path, lock := inheritedLock(t)
	if err := sealInheritedFds(); err != nil {
		t.Fatal(err)
	}
	if !cloexec(t, int(lock.Fd())) {
		t.Fatal("the inherited lock is still inheritable after sealing")
	}
	startSleeper(t)
	lock.Close()

	next, err := acquireDataRootLock(path)
	if err != nil {
		t.Fatalf("the lock outlived its gateway: %v", err)
	}
	next.Close()
}

// Every inherited descriptor is sealed, not a list of known ones.
func TestSealInheritedFdsSealsEveryDescriptor(t *testing.T) {
	var fds []int
	for range 3 {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		defer w.Close()
		for _, f := range []*os.File{r, w} {
			makeInheritable(t, int(f.Fd()))
			fds = append(fds, int(f.Fd()))
		}
	}
	if err := sealInheritedFds(); err != nil {
		t.Fatal(err)
	}
	for _, fd := range fds {
		if !cloexec(t, fd) {
			t.Fatalf("fd %d is still inheritable after sealing", fd)
		}
	}
}
