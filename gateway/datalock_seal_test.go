package main

import (
	"os"
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

// An inherited descriptor (exec cleared its close-on-exec flag) is sealed, so
// what the generation starts no longer inherits the data-root lock.
func TestSealInheritedFdsMarksCloseOnExec(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	fd := int(r.Fd())
	if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, 0); errno != 0 {
		t.Fatal(errno)
	}
	if cloexec(t, fd) {
		t.Fatal("setup: the fd should be inheritable")
	}
	if err := sealInheritedFds(fd); err != nil {
		t.Fatal(err)
	}
	if !cloexec(t, fd) {
		t.Fatal("the inherited fd is still inheritable after sealing")
	}
}

// A descriptor that is not open (a keeper with no lock) is skipped, not an error.
func TestSealInheritedFdsSkipsClosedFd(t *testing.T) {
	if err := sealInheritedFds(987); err != nil {
		t.Fatalf("a closed fd should be skipped: %v", err)
	}
}
