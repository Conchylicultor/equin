package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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
			return nil, &dataRootHeldError{path: path, holder: readLockHolder(path)}
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

// dataRootHeldError: another live gateway holds this data root.
type dataRootHeldError struct {
	path   string
	holder string // its pid as recorded, or "" when the file names none
}

func (e *dataRootHeldError) Error() string {
	who := "another gateway"
	if e.holder != "" {
		who = fmt.Sprintf("another gateway (pid %s)", e.holder)
	}
	return fmt.Sprintf("%s already serves this data root (it holds %s); refusing to start a second one beside it", who, e.path)
}

func readLockHolder(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
