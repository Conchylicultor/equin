package main

import (
	"fmt"
	"log/slog"
	"time"
)

// phase is a worktree's backend lifecycle as ONE value: where it is, and the
// backend(s) that place holds, written together by one assignment under w.mu.
//
// It used to be two fields — `state State` and `active *backend` — that every
// transition wrote separately. On 2026-11-08 18:21 an exit handler and a hot
// restart's swap interleaved so that main was left `running` with
// `active == nil`: Ensure answered every request (nil, nil), handleHTTP
// dereferenced it 240+ times, and nothing ever moved the state again until the
// gateway restarted. Here "running" is phaseRunning, which carries the ready
// backend it serves from; there is no running without one.
//
// Who may end a phase is by identity, never by state alone:
//
//   - phaseStarting is ended only by the boot that owns its spawnAttempt.
//   - phaseRestarting is ended by the hot restart that owns `next`, or — when
//     `serving` itself exits — by that exit, which hands the in-flight
//     successor its waiters (phaseStarting{next}); the restart then ends that.
//   - phaseRunning is ended by the exit of exactly its backend, by Stop, or by
//     a Restart.
//
// A backend that is not the one a phase names (a draining predecessor, a
// spawn that lost) can never clear it.
type phase interface {
	state() State
}

type phaseIdle struct{}

// phaseStarting: a boot is in flight; every caller waits on it.
type phaseStarting struct{ spawn *spawnAttempt }

// phaseRunning: serving from bk, which has passed readiness and has its proxy.
// Built only by runningOn.
type phaseRunning struct{ bk *backend }

// phaseRestarting: serving from `serving` while `next` boots on the other
// socket.
type phaseRestarting struct {
	serving *backend
	next    *spawnAttempt
}

// phaseStopping: bk is being terminated.
type phaseStopping struct{ bk *backend }

// phaseBroken: the last boot failed with err; see Ensure for who retries it.
type phaseBroken struct {
	err   error
	until time.Time // the cooldown before a browser start may retry
}

func (phaseIdle) state() State       { return StateIdle }
func (phaseStarting) state() State   { return StateStarting }
func (phaseRunning) state() State    { return StateRunning }
func (phaseRestarting) state() State { return StateRestarting }
func (phaseStopping) state() State   { return StateStopping }
func (phaseBroken) state() State     { return StateBroken }

// runningOn is the one way to build a running phase. Go has no non-nil
// pointer type, so the invariant the union cannot carry in its type is
// asserted here, at the only place one is made: a running phase serves from a
// ready backend with its proxy.
func runningOn(bk *backend) phaseRunning {
	if bk == nil || bk.proxy == nil {
		panic("gateway: a running phase needs a ready backend with its proxy")
	}
	return phaseRunning{bk: bk}
}

// backendOf is the backend a phase currently holds — the one serving, or the
// one booting — for the status snapshot; nil when it holds none.
func backendOf(p phase) *backend {
	switch p := p.(type) {
	case phaseRunning:
		return p.bk
	case phaseRestarting:
		return p.serving
	case phaseStarting:
		return p.spawn.bk
	case phaseStopping:
		return p.bk
	}
	return nil
}

// spawnAttempt is one backend boot — a cold start, or a hot restart's
// successor — shared by every caller waiting on it. Its outcome is written
// once, before done closes, and read only after.
type spawnAttempt struct {
	done chan struct{}

	// Guarded by the owning Worktree's mu.
	bk            *backend // the spawned process; nil until spawned
	browserJoined bool     // a browser start joined before bk was published: promote on publish

	// The outcome: written before done closes.
	result *backend
	err    error
}

func newSpawnAttempt() *spawnAttempt {
	return &spawnAttempt{done: make(chan struct{})}
}

// settle records the attempt's outcome and releases its waiters.
func (a *spawnAttempt) settle(bk *backend, err error) {
	a.result, a.err = bk, err
	close(a.done)
}

// outcome is what a waiter gets once done has closed.
func (a *spawnAttempt) outcome() (*backend, error) {
	if a.err != nil {
		return nil, a.err
	}
	return a.result, nil
}

// lifecycleBug reports a transition the phase union says cannot happen: the
// owner of a phase found another phase in its place. Logged at error and
// returned as an error, so the caller fails loudly and settles its waiters
// instead of hanging them.
func (w *Worktree) lifecycleBug(owner string, found phase) error {
	err := fmt.Errorf("gateway lifecycle bug: %s found the worktree %s, not in the phase it owns", owner, found.state())
	slog.Error("gateway lifecycle bug", "worktree", w.Name, "owner", owner, "found", found.state())
	return err
}
