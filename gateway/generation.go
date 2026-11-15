package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// ─── a gateway generation's half of the keeper ─────────────────
//
// A gateway started by the keeper (-keeper-fd) spawns its long-lived children
// through it (keeperClient), adopts the ones a predecessor left (adopt.go),
// and can be replaced by a successor (handover.go).

// keeperClient is a generation's connection to its keeper, and the spawner of
// its long-lived children.
type keeperClient struct {
	ctrl *ctrlConn
	init generationInit
	// fds: the descriptors sent after the init, indexed by its fields.
	fds []*os.File

	mu       sync.Mutex
	nextID   uint64
	pending  map[uint64]chan spawnReply
	children map[int]*child
	// exitsBefore holds exits that arrived before the child they name was
	// registered (an adopted child registers after the init is read).
	early map[int]childStatus
	// adopting: the init's children are not all registered yet (early
	// records their exits only until adoptionDone).
	adopting bool

	handover chan keeperMsg // a handover-result
	// predecessorGone closes when the generation this one replaced exited.
	predecessorGone chan struct{}
	predOnce        sync.Once
	// detached: this generation was replaced; it no longer acts on exits.
	detached atomic.Bool
	closed   chan struct{}
}

const maxEarlyExits = 1024

// spawnReplyTimeout bounds a spawn's round trip to the keeper (a fork/exec):
// past it the keeper is wedged, and the boot that asked fails loudly instead
// of holding its worktree in phaseStarting.
const spawnReplyTimeout = 30 * time.Second

type spawnReply struct {
	m     keeperMsg
	files []*os.File
}

// connectKeeper reads the init the keeper sends first and starts the read
// loop.
func connectKeeper(fd int) (*keeperClient, error) {
	f := os.NewFile(uintptr(fd), "keeper-ctrl")
	if f == nil {
		return nil, fmt.Errorf("%s %d: no such descriptor", keeperFdFlag, fd)
	}
	ctrl, err := newCtrlConn(f)
	if err != nil {
		return nil, err
	}
	m, files, err := ctrl.recv()
	closeFiles(files...)
	if err != nil {
		return nil, fmt.Errorf("read the keeper's init: %w", err)
	}
	if m.T != msgInit || m.Init == nil {
		return nil, fmt.Errorf("the keeper's first message is %q, not an init", m.T)
	}
	if m.Init.Protocol != keeperProtocol {
		return nil, fmt.Errorf("the keeper speaks protocol %d, this gateway %d — the keeper itself must be restarted (a service reload) to run this gateway", m.Init.Protocol, keeperProtocol)
	}
	// The init's descriptors follow it, in batches.
	var fds []*os.File
	for len(fds) < m.Init.Fds {
		fm, files, err := ctrl.recv()
		if err != nil {
			closeFiles(fds...)
			return nil, fmt.Errorf("read the keeper's descriptors: %w", err)
		}
		if fm.T != msgFds {
			closeFiles(append(fds, files...)...)
			return nil, fmt.Errorf("the keeper sent %q among an init's descriptors", fm.T)
		}
		fds = append(fds, files...)
	}
	kc := &keeperClient{
		fds:             fds,
		ctrl:            ctrl,
		init:            *m.Init,
		pending:         map[uint64]chan spawnReply{},
		children:        map[int]*child{},
		early:           map[int]childStatus{},
		adopting:        true,
		handover:        make(chan keeperMsg, 1),
		predecessorGone: make(chan struct{}),
		closed:          make(chan struct{}),
	}
	if !m.Init.Predecessor {
		kc.predOnce.Do(func() { close(kc.predecessorGone) })
	}
	go kc.readLoop()
	return kc, nil
}

func (kc *keeperClient) readLoop() {
	defer close(kc.closed)
	for {
		m, files, err := kc.ctrl.recv()
		if err != nil {
			slog.Error("keeper control socket closed", "err", err)
			kc.mu.Lock()
			for id, ch := range kc.pending {
				ch <- spawnReply{m: keeperMsg{Err: errKeeperGone.Error()}}
				delete(kc.pending, id)
			}
			kc.mu.Unlock()
			return
		}
		switch m.T {
		case msgSpawned:
			kc.mu.Lock()
			ch := kc.pending[m.ID]
			delete(kc.pending, m.ID)
			kc.mu.Unlock()
			if ch == nil {
				closeFiles(files...)
				continue
			}
			ch <- spawnReply{m: m, files: files}
		case msgExited:
			closeFiles(files...)
			st := childStatus{Err: "no status"}
			if m.Status != nil {
				st = *m.Status
			}
			kc.mu.Lock()
			c := kc.children[m.Pid]
			if c != nil {
				delete(kc.children, m.Pid)
			} else if kc.adopting && len(kc.early) < maxEarlyExits {
				// A child not registered YET (an adopted one, registered
				// after the init is read) — or another generation's,
				// which this one never registers: bounded.
				kc.early[m.Pid] = st
			}
			kc.mu.Unlock()
			if c != nil && !kc.detached.Load() {
				c.exited(st)
			}
		case msgHandoverResult:
			closeFiles(files...)
			select {
			case kc.handover <- m:
			default:
			}
		case msgPredecessorGone:
			closeFiles(files...)
			kc.predOnce.Do(func() { close(kc.predecessorGone) })
			slog.Info("the gateway this one replaced has exited", "pid", m.Pid)
		default:
			closeFiles(files...)
		}
	}
}

// spawn asks the keeper to start a child; the keeper is its parent.
func (kc *keeperClient) spawn(s spawnSpec) (*child, error) {
	argv, err := resolveArgv0(s.Argv)
	if err != nil {
		return nil, err
	}
	s.Argv = argv
	kc.mu.Lock()
	kc.nextID++
	id := kc.nextID
	ch := make(chan spawnReply, 1)
	kc.pending[id] = ch
	kc.mu.Unlock()
	if err := kc.ctrl.send(keeperMsg{T: msgSpawn, ID: id, Spawn: &s}); err != nil {
		kc.mu.Lock()
		delete(kc.pending, id)
		kc.mu.Unlock()
		return nil, fmt.Errorf("ask the keeper to spawn: %w", err)
	}
	var r spawnReply
	select {
	case r = <-ch:
	case <-time.After(spawnReplyTimeout):
		kc.mu.Lock()
		delete(kc.pending, id)
		kc.mu.Unlock()
		return nil, fmt.Errorf("the keeper did not answer a spawn within %s", spawnReplyTimeout)
	}
	if r.m.Err != "" {
		closeFiles(r.files...)
		return nil, errors.New(r.m.Err)
	}
	c := &child{Pid: r.m.Pid, done: make(chan struct{})}
	for i, name := range r.m.Fds {
		if i >= len(r.files) {
			break
		}
		switch name {
		case "stdout":
			c.Stdout = r.files[i]
		case "stderr":
			c.Stderr = r.files[i]
		default:
			_ = r.files[i].Close()
		}
	}
	kc.register(c)
	return c, nil
}

// register starts tracking c's exit — or, when the keeper already said it
// exited, records that at once.
func (kc *keeperClient) register(c *child) {
	kc.mu.Lock()
	st, gone := kc.early[c.Pid]
	if gone {
		delete(kc.early, c.Pid)
	} else {
		kc.children[c.Pid] = c
	}
	kc.mu.Unlock()
	if gone {
		c.exited(st)
	}
}

// adoptionDone drops the exits recorded for children not registered: once
// every child the init listed is registered, an exit for an unknown pid
// names no child of this generation (and must not be matched to a later
// child that reuses the pid).
func (kc *keeperClient) adoptionDone() {
	kc.mu.Lock()
	kc.early = map[int]childStatus{}
	kc.adopting = false
	kc.mu.Unlock()
}

// adopted turns one child the init listed into a *child this generation
// tracks, its output read ends opened from the inherited fds.
func (kc *keeperClient) adopted(a adoptChild) *child {
	c := &child{Pid: a.Pid, done: make(chan struct{})}
	c.Stdout = kc.initFd(a.StdoutFd)
	c.Stderr = kc.initFd(a.StderrFd)
	kc.register(c)
	return c
}

// sendListeners hands the first generation's listening sockets to the keeper,
// which holds them for every later generation.
func (kc *keeperClient) sendListeners(ls []net.Listener) error {
	var files []*os.File
	var infos []listenerInfo
	for _, l := range ls {
		tl, ok := l.(*net.TCPListener)
		if !ok {
			return fmt.Errorf("listener %s is a %T", l.Addr(), l)
		}
		f, err := tl.File()
		if err != nil {
			return err
		}
		files = append(files, f)
		infos = append(infos, listenerInfo{Addr: l.Addr().String()})
	}
	err := kc.ctrl.send(keeperMsg{T: msgListeners, Listeners: infos}, files...)
	closeFiles(files...)
	return err
}

// inheritedListeners opens the listening sockets the keeper handed this
// generation, checked against the addresses -listen names: a different
// -listen is a different socket, which only a restart of the keeper binds.
func (kc *keeperClient) inheritedListeners(want []listenAddr) ([]net.Listener, error) {
	have := map[string]bool{}
	var out []net.Listener
	for _, li := range kc.init.Listeners {
		have[normalAddr(li.Addr)] = true
		f := kc.initFd(li.Fd)
		if f == nil {
			return nil, fmt.Errorf("the keeper's init names listener %s with no descriptor", li.Addr)
		}
		l, err := net.FileListener(f)
		_ = f.Close()
		if err != nil {
			return nil, fmt.Errorf("inherited listener %s: %w", li.Addr, err)
		}
		out = append(out, l)
	}
	for _, w := range want {
		if have[normalAddr(w.addr)] {
			continue
		}
		if w.ipv6Loopback && len(out) > 0 {
			continue // the keeper's host has no IPv6 loopback (listenAll)
		}
		return nil, fmt.Errorf("-listen %s is not the address the keeper holds (%v) — changing it needs a restart of the keeper", w.addr, keys(have))
	}
	return out, nil
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func (kc *keeperClient) sendReady() error {
	return kc.ctrl.send(keeperMsg{T: msgReady})
}

// requestHandover asks the keeper to replace this generation and waits for
// its answer: the successor's pid, or why it did not take over.
func (kc *keeperClient) requestHandover(l *launchRequest, state json.RawMessage) (int, error) {
	// Drop a stale result (none is expected).
	select {
	case <-kc.handover:
	default:
	}
	if err := kc.ctrl.send(keeperMsg{T: msgHandover, Launch: l, State: state}); err != nil {
		return 0, err
	}
	select {
	case m := <-kc.handover:
		if m.Err != "" {
			return 0, errors.New(m.Err)
		}
		return m.Pid, nil
	case <-kc.closed:
		return 0, errKeeperGone
	}
}

// normalAddr spells a listen address one way: an unspecified host ("",
// 0.0.0.0, ::) as "*", so ":443" and the "[::]:443" a wildcard listener
// reports compare equal.
func normalAddr(a string) string {
	host, port, err := net.SplitHostPort(a)
	if err != nil {
		return a
	}
	if host == "" {
		return "*:" + port
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() {
			return "*:" + port
		}
		return net.JoinHostPort(ip.String(), port)
	}
	return net.JoinHostPort(host, port)
}

// initFd is the init's i-th descriptor, nil for -1 (or out of range).
func (kc *keeperClient) initFd(i int) *os.File {
	if i < 0 || i >= len(kc.fds) {
		return nil
	}
	return kc.fds[i]
}
