package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// ─── long-lived children, whoever their parent is ────────────
//
// A backend and a main-deploy run are the gateway's long-lived children. Their
// PARENT is what outlives a gateway generation: under the keeper (keeper.go)
// the keeper spawns them on the generation's behalf, so a new generation can
// adopt them — their exit status still reaches it (the keeper waits for them),
// and their own ppid escape hatch (server-core serve.ts: exit once reparented
// to pid 1) fires only when the keeper itself is gone. A gateway with no
// keeper (a test, a hand-run gateway with -no-keeper) spawns them itself.
//
// Both paths produce the same *child, so nothing above this file knows which
// one ran.

// outputTo is where one of a child's output streams goes: a pipe the gateway
// reads (Pipe), a file opened for appending (Path), or nowhere (zero value,
// /dev/null).
type outputTo struct {
	Pipe bool   `json:"pipe,omitempty"`
	Path string `json:"path,omitempty"`
}

// spawnSpec is one child to start, as data: the keeper receives it over the
// control socket. Every child is its own process-group leader (Setpgid), so a
// stop signals the whole group (a backend's PTYs; a build's subprocesses).
type spawnSpec struct {
	// Argv[0] is resolved against the gateway's PATH before the spec leaves
	// this process (exec.LookPath), so the keeper — whose own PATH may differ
	// — runs the same binary the gateway would have.
	Argv   []string `json:"argv"`
	Env    []string `json:"env"`
	Dir    string   `json:"dir"`
	Stdout outputTo `json:"stdout"`
	Stderr outputTo `json:"stderr"`
	// Tag is what a later generation needs to adopt the child (childTag); the
	// keeper stores it verbatim and hands it to every generation it starts.
	Tag json.RawMessage `json:"tag,omitempty"`
}

// childStatus is how a child ended, portable across the control socket (a
// syscall.WaitStatus is an OS-specific bit layout).
type childStatus struct {
	Signaled bool `json:"signaled,omitempty"`
	Signal   int  `json:"signal,omitempty"`
	CoreDump bool `json:"coreDump,omitempty"`
	Code     int  `json:"code"`
	// Err is set when the wait itself failed: the status is then unknown.
	Err string `json:"err,omitempty"`
}

func statusOf(ps *os.ProcessState, waitErr error) childStatus {
	if ps == nil {
		msg := "no process state"
		if waitErr != nil {
			msg = waitErr.Error()
		}
		return childStatus{Err: msg}
	}
	ws, ok := ps.Sys().(syscall.WaitStatus)
	if !ok {
		return childStatus{Err: fmt.Sprintf("unreadable wait status %T", ps.Sys())}
	}
	if ws.Signaled() {
		return childStatus{Signaled: true, Signal: int(ws.Signal()), CoreDump: ws.CoreDump(), Code: -1}
	}
	return childStatus{Code: ws.ExitStatus()}
}

// success: exited 0, not by a signal.
func (s childStatus) success() bool { return s.Err == "" && !s.Signaled && s.Code == 0 }

// child is one running long-lived child. done closes once it has exited;
// status is valid after that.
type child struct {
	Pid    int
	Stdout *os.File // read end, when the spec asked for a pipe
	Stderr *os.File
	done   chan struct{}
	status childStatus
}

func (c *child) exited(st childStatus) {
	c.status = st
	close(c.done)
}

// spawner starts long-lived children.
type spawner interface {
	spawn(s spawnSpec) (*child, error)
}

// localSpawner: the gateway is the parent (no keeper).
type localSpawner struct{}

func (localSpawner) spawn(s spawnSpec) (*child, error) {
	return startChild(s)
}

// resolveArgv0 resolves argv[0] the way exec.Command would, against this
// process's PATH — so a spec sent to the keeper names an absolute binary.
func resolveArgv0(argv []string) ([]string, error) {
	if len(argv) == 0 {
		return nil, errors.New("empty argv")
	}
	if strings.ContainsRune(argv[0], '/') {
		// A path is resolved by the exec itself (relative to the child's dir).
		return argv, nil
	}
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, err
	}
	out := append([]string{path}, argv[1:]...)
	return out, nil
}

// openOutput opens one output stream for a child: the write end it inherits,
// and — for a pipe — the read end the parent keeps.
func openOutput(o outputTo) (write *os.File, read *os.File, err error) {
	switch {
	case o.Pipe:
		r, w, err := os.Pipe()
		if err != nil {
			return nil, nil, err
		}
		return w, r, nil
	case o.Path != "":
		f, err := os.OpenFile(o.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		return f, nil, err
	default:
		return nil, nil, nil
	}
}
