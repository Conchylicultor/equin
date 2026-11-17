package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// ─── the keeper ────────────────────────────────────────────────
//
// What must outlive a gateway update lives here, in the process the service
// manager supervises (launchd's program on the Mac; the child the release
// launcher waits on): the pid it watches, the listening sockets, and the
// parenthood of every long-lived child. Everything that changes — routing,
// proxying, lifecycle policy, statics, reports — is a GENERATION: a child
// gateway process the keeper starts, and replaces on POST /gateway/handover
// without closing the sockets or stopping a backend.
//
// The keeper is this same binary started WITHOUT -keeper-fd. It runs the code
// of the binary the service manager started, for its whole life: a handover
// changes the generation's binary, never the keeper's. Kept small on purpose —
// a change here reaches a machine only when its keeper restarts (a reboot, a
// service reload).
//
// The keeper never writes to a generation while holding its lock: each
// generation has its own outbound queue and writer (keeperGeneration.out), so
// a generation that stops reading stalls only itself, and a failed write
// closes that generation's socket (and kills it while it is not serving yet)
// instead of leaving a half-written frame behind.
//
// Design: research/2026-11-14-gateway-handover.md.

// keeperGeneration is one gateway generation process.
type keeperGeneration struct {
	id     int
	cmd    *exec.Cmd
	ctrl   *ctrlConn
	launch launch
	mode   generationMode
	start  time.Time
	ready  chan struct{} // closed on its ready message
	exited chan struct{} // closed once it has exited
	// readyOnce guards closing ready.
	readyOnce sync.Once

	// The outbound queue (see the header): messages and the descriptors
	// they carry (dups the writer closes once sent).
	outMu     sync.Mutex
	outCond   *sync.Cond
	out       []outMsg
	outClosed bool
}

type outMsg struct {
	m     keeperMsg
	files []*os.File
}

// keeperChild is one long-lived child the keeper started for a generation.
type keeperChild struct {
	c   *child
	tag json.RawMessage
	// spawnedBy is the generation that asked for it — a handover that aborts
	// stops what its failed successor started.
	spawnedBy int
	// knownBy: the generations told of it (its spawner, and every generation
	// whose init listed it). Only they are told of its exit: a generation
	// never hears of a pid it does not know, so a reused pid can never read
	// as an exit already seen.
	knownBy map[int]bool
}

type keeper struct {
	cfg Config

	mu        sync.Mutex
	listeners []*os.File
	addrs     []string
	children  map[int]*keeperChild
	current   *keeperGeneration
	// gens: every generation alive (the current one, a predecessor draining,
	// a successor booting).
	gens      map[int]*keeperGeneration
	nextGen   int
	everReady bool
	// handing: a handover is in flight — the current generation's death is
	// then the handover's to answer (finishHandover), not waitGeneration's.
	handing  bool
	stopping bool
	// deaths: when recent generations died unasked, for the crash window.
	deaths []time.Time
}

// recoverWindow / recoverLimit: this many generations dying unasked within
// the window, and the keeper gives up (exits non-zero — its service manager
// restarts the whole service, loudly).
const (
	recoverWindow = 5 * time.Minute
	recoverLimit  = 5
)

// readyTimeout bounds every generation's boot but the first (whose services
// may legitimately take minutes to initialise): not ready by then, it is
// killed — a handover's successor, and the serving generation keeps serving;
// a recover generation, and the keeper tries again (within recoverLimit).
const readyTimeout = 60 * time.Second

// keeperExitReq carries a decision to exit (the first generation failed its
// boot, or generations keep dying).
var keeperExitReq = make(chan int, 1)

func keeperMain(cfg Config) int {
	// The keeper logs to stderr — the service's stdio log — never to the
	// rotating gateway.log its generations write.
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)).With("process", "keeper"))
	k := &keeper{cfg: cfg, children: map[int]*keeperChild{}, gens: map[int]*keeperGeneration{}}
	// One gateway per data root (datalock.go): the keeper holds the lock for
	// its life, and every generation inherits it (startGeneration) — so the
	// lock is held until the last process of this gateway exits, even one a
	// dead keeper left behind.
	lock, err := acquireDataRootLock(cfg.LockFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gateway: fatal: %v\n", err)
		return 1
	}
	dataRootLock = lock
	if cfg.PidFile != "" {
		if err := writePidFile(cfg.PidFile); err != nil {
			fmt.Fprintf(os.Stderr, "gateway: fatal: write pid file %s: %v\n", cfg.PidFile, err)
			return 1
		}
	}
	self, err := firstBinary()
	if err != nil {
		fmt.Fprintf(os.Stderr, "gateway: fatal: keeper cannot find its own binary: %v\n", err)
		return 1
	}
	wd, _ := os.Getwd()
	first := launch{Binary: self, Args: append([]string{}, os.Args[1:]...), Env: keeperOwnEnvironment(), Dir: wd}

	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)

	gen, err := k.startGeneration(first, modeFresh, nil, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gateway: fatal: keeper could not start the gateway: %v\n", err)
		return 1
	}
	k.mu.Lock()
	k.current = gen
	k.mu.Unlock()
	slog.Info("keeper: started", "pid", os.Getpid(), "generation", gen.id, "generation_pid", gen.cmd.Process.Pid)

	for {
		select {
		case sig := <-sigs:
			return k.shutdown(sig)
		case code := <-keeperExitReq:
			return code
		}
	}
}

// firstBinary is the binary the first generation runs: argv[0] as the
// service manager spelled it when it is absolute (what the installed
// definition names, so the drift row compares like with like), else this
// process's own executable.
func firstBinary() (string, error) {
	if filepath.IsAbs(os.Args[0]) {
		return os.Args[0], nil
	}
	return os.Executable()
}

// startGeneration starts one generation and its control loop.
func (k *keeper) startGeneration(l launch, mode generationMode, state json.RawMessage, predecessor bool) (*keeperGeneration, error) {
	mine, theirs, err := socketPair()
	if err != nil {
		return nil, err
	}
	init := generationInit{Protocol: keeperProtocol, Mode: mode, KeeperPid: os.Getpid(), Launch: l, State: state, Predecessor: predecessor, SpawnedAt: time.Now().UnixMilli()}

	k.mu.Lock()
	defer k.mu.Unlock()
	k.nextGen++
	id := k.nextGen
	// The descriptors follow the init over the control socket, never as
	// inherited fds: exec's ExtraFiles calls os.File.Fd(), which would put the
	// shared listening sockets in blocking mode (rawFd). Dups, sent and
	// closed by the writer: the originals may close meanwhile (a child exits).
	var fds []*os.File
	for i, lf := range k.listeners {
		init.Listeners = append(init.Listeners, listenerInfo{Addr: k.addrs[i], Fd: len(fds)})
		fds = append(fds, lf)
	}
	for pid, kc := range k.children {
		ac := adoptChild{Pid: pid, Tag: kc.tag, StdoutFd: -1, StderrFd: -1}
		if kc.c.Stdout != nil {
			ac.StdoutFd = len(fds)
			fds = append(fds, kc.c.Stdout)
		}
		if kc.c.Stderr != nil {
			ac.StderrFd = len(fds)
			fds = append(fds, kc.c.Stderr)
		}
		init.Children = append(init.Children, ac)
		kc.knownBy[id] = true
	}
	init.Fds = len(fds)
	dups, err := dupFiles(fds)
	if err != nil {
		_ = mine.Close()
		_ = theirs.Close()
		return nil, fmt.Errorf("duplicate descriptors for the init: %w", err)
	}
	// fd 3: the control socket; fd keeperLockFd (4): the data-root lock, held
	// while the generation lives (keeperMain). The generation marks both
	// close-on-exec first thing (sealInheritedFds): exec clears the flag on
	// every inherited descriptor.
	extra := []*os.File{theirs}
	if dataRootLock != nil {
		extra = append(extra, dataRootLock)
	}
	args := append(append([]string{}, l.Args...), keeperFdFlag, "3")
	cmd, err := startGeneration(l.Binary, args, l.Env, l.Dir, extra)
	_ = theirs.Close()
	if err != nil {
		_ = mine.Close()
		closeFiles(dups...)
		return nil, err
	}
	ctrl, err := newCtrlConn(mine)
	if err != nil {
		_ = cmd.Process.Kill()
		closeFiles(dups...)
		return nil, err
	}
	gen := &keeperGeneration{id: id, cmd: cmd, ctrl: ctrl, launch: l, mode: mode, start: time.Now(), ready: make(chan struct{}), exited: make(chan struct{})}
	gen.outCond = sync.NewCond(&gen.outMu)
	k.gens[id] = gen
	// The init (and its descriptors) is queued first, under mu: every exit
	// is queued under mu too, so the generation never hears of a child it
	// was not told about first.
	gen.enqueue(keeperMsg{T: msgInit, Init: &init})
	for i := 0; i < len(dups); i += maxFdsPerMsg {
		end := min(i+maxFdsPerMsg, len(dups))
		gen.enqueueOwned(keeperMsg{T: msgFds}, dups[i:end])
	}
	go gen.writeLoop()
	go k.readGeneration(gen)
	go k.waitGeneration(gen)
	if mode != modeFresh {
		go k.boundReady(gen)
	}
	return gen, nil
}

// dupFiles duplicates descriptors (without os.File.Fd(), see rawFd).
func dupFiles(fs []*os.File) ([]*os.File, error) {
	out := make([]*os.File, 0, len(fs))
	for _, f := range fs {
		fd, err := rawFd(f)
		if err == nil {
			var nfd int
			nfd, err = syscall.Dup(fd)
			if err == nil {
				syscall.CloseOnExec(nfd)
				out = append(out, os.NewFile(uintptr(nfd), f.Name()))
				continue
			}
		}
		closeFiles(out...)
		return nil, err
	}
	return out, nil
}

// enqueue queues m for this generation (never blocks); files are dup'd now,
// so the caller keeps its own.
func (g *keeperGeneration) enqueue(m keeperMsg, files ...*os.File) {
	dups, err := dupFiles(files)
	if err != nil {
		slog.Error("keeper: could not duplicate descriptors for a message; closing the generation's socket", "generation", g.id, "type", m.T, "err", err)
		g.closeOut()
		return
	}
	g.enqueueOwned(m, dups)
}

// enqueueOwned queues m with descriptors the writer will close.
func (g *keeperGeneration) enqueueOwned(m keeperMsg, files []*os.File) {
	g.outMu.Lock()
	defer g.outMu.Unlock()
	if g.outClosed {
		closeFiles(files...)
		return
	}
	g.out = append(g.out, outMsg{m: m, files: files})
	g.outCond.Signal()
}

func (g *keeperGeneration) closeOut() {
	g.outMu.Lock()
	g.outClosed = true
	for _, o := range g.out {
		closeFiles(o.files...)
	}
	g.out = nil
	g.outCond.Signal()
	g.outMu.Unlock()
}

// writeLoop sends this generation's queue in order. A failed write leaves the
// stream unusable (a half-written frame): the socket is closed, and a
// generation not serving yet is killed — its boot cannot complete without
// what it was not sent.
func (g *keeperGeneration) writeLoop() {
	for {
		g.outMu.Lock()
		for len(g.out) == 0 && !g.outClosed {
			g.outCond.Wait()
		}
		if g.outClosed {
			g.outMu.Unlock()
			return
		}
		o := g.out[0]
		g.out = g.out[1:]
		g.outMu.Unlock()
		err := g.ctrl.send(o.m, o.files...)
		closeFiles(o.files...)
		if err != nil {
			slog.Error("keeper: a write to a generation failed; closing its socket", "generation", g.id, "type", o.m.T, "err", err)
			g.closeOut()
			g.ctrl.close()
			if !isReady(g) {
				_ = g.cmd.Process.Kill()
			}
			return
		}
	}
}

// boundReady kills a generation (other than the first) that is not serving
// within readyTimeout.
func (k *keeper) boundReady(gen *keeperGeneration) {
	t := time.NewTimer(readyTimeout)
	defer t.Stop()
	select {
	case <-gen.ready:
	case <-gen.exited:
	case <-t.C:
		slog.Error("keeper: a generation was not ready in time; killing it", "generation", gen.id, "mode", gen.mode, "timeout", readyTimeout)
		_ = gen.cmd.Process.Kill()
	}
}

// readGeneration serves one generation's control messages until it closes.
func (k *keeper) readGeneration(gen *keeperGeneration) {
	for {
		m, files, err := gen.ctrl.recv()
		if err != nil {
			return
		}
		switch m.T {
		case msgSpawn:
			k.serveSpawn(gen, m)
			closeFiles(files...)
		case msgListeners:
			k.mu.Lock()
			if len(k.listeners) == 0 {
				k.listeners = files
				for _, li := range m.Listeners {
					k.addrs = append(k.addrs, li.Addr)
				}
				files = nil
			}
			k.mu.Unlock()
			closeFiles(files...)
		case msgReady:
			gen.readyOnce.Do(func() { close(gen.ready) })
			k.mu.Lock()
			k.everReady = true
			k.mu.Unlock()
			slog.Info("keeper: generation ready", "generation", gen.id, "pid", gen.cmd.Process.Pid, "mode", gen.mode, "took", time.Since(gen.start))
		case msgHandover:
			closeFiles(files...)
			go k.handover(gen, m)
		default:
			closeFiles(files...)
			slog.Warn("keeper: unknown message", "type", m.T, "generation", gen.id)
		}
	}
}

func (k *keeper) serveSpawn(gen *keeperGeneration, m keeperMsg) {
	reply := keeperMsg{T: msgSpawned, ID: m.ID}
	if m.Spawn == nil {
		reply.Err = "spawn without a spec"
		gen.enqueue(reply)
		return
	}
	c, err := startChild(*m.Spawn)
	if err != nil {
		reply.Err = err.Error()
		gen.enqueue(reply)
		return
	}
	reply.Pid = c.Pid
	var files []*os.File
	if c.Stdout != nil {
		files = append(files, c.Stdout)
		reply.Fds = append(reply.Fds, "stdout")
	}
	if c.Stderr != nil {
		files = append(files, c.Stderr)
		reply.Fds = append(reply.Fds, "stderr")
	}
	k.mu.Lock()
	k.children[c.Pid] = &keeperChild{c: c, tag: m.Spawn.Tag, spawnedBy: gen.id, knownBy: map[int]bool{gen.id: true}}
	// Under mu, before the waiter below can queue its exit: the reply always
	// precedes the exit on this socket.
	gen.enqueue(reply, files...)
	k.mu.Unlock()
	go func() {
		<-c.done
		k.mu.Lock()
		kc := k.children[c.Pid]
		delete(k.children, c.Pid)
		closeFiles(c.Stdout, c.Stderr)
		st := c.status
		if kc != nil {
			for id := range kc.knownBy {
				if g := k.gens[id]; g != nil {
					g.enqueue(keeperMsg{T: msgExited, Pid: c.Pid, Status: &st})
				}
			}
		}
		k.mu.Unlock()
	}()
}

// waitGeneration reaps one generation and decides what its exit means.
func (k *keeper) waitGeneration(gen *keeperGeneration) {
	werr := gen.cmd.Wait()
	st := statusOf(gen.cmd.ProcessState, werr)
	close(gen.exited)
	gen.closeOut()
	gen.ctrl.close()
	k.mu.Lock()
	delete(k.gens, gen.id)
	isCurrent := k.current == gen
	wasReady := isReady(gen)
	stopping := k.stopping
	everReady := k.everReady
	handing := k.handing
	cur := k.current
	draining := k.anyDrainingLocked()
	k.mu.Unlock()

	slog.Info("keeper: generation exited", "generation", gen.id, "pid", gen.cmd.Process.Pid,
		"code", st.Code, "signaled", st.Signaled, "current", isCurrent, "ready", wasReady)
	if stopping {
		return
	}
	if !isCurrent {
		// A predecessor done draining (or a failed successor, which its
		// handover has already dealt with). Once no older generation still
		// drains — none could be proxying to a backend any more — the
		// current one may stop backends again.
		if wasReady && cur != nil && !draining {
			cur.enqueue(keeperMsg{T: msgPredecessorGone, Pid: gen.cmd.Process.Pid})
		}
		return
	}
	if handing {
		// The serving generation died mid-handover: the handover decides —
		// its successor takes over if it gets ready, else the keeper
		// recovers (finishHandover).
		slog.Error("keeper: the serving gateway died during a handover; its successor decides", "generation", gen.id)
		return
	}
	if !everReady {
		// The very first boot failed (a service that would not start, a bad
		// flag): exit with its status, as the gateway did before the keeper,
		// so the launcher reads the failure now and from the stdio log.
		code := st.Code
		if code <= 0 {
			code = 1
		}
		k.stopChildren()
		keeperExitReq <- code
		return
	}
	k.recover(gen.launch, fmt.Sprintf("the serving gateway died (code %d, signaled %v)", st.Code, st.Signaled))
}

// recover starts the last launch again over every live child — a gateway
// crash no longer stops a backend — unless generations keep dying, which
// gives up loudly.
func (k *keeper) recover(l launch, why string) {
	k.mu.Lock()
	now := time.Now()
	recent := k.deaths[:0]
	for _, t := range k.deaths {
		if now.Sub(t) < recoverWindow {
			recent = append(recent, t)
		}
	}
	k.deaths = append(recent, now)
	n := len(k.deaths)
	predecessor := k.anyDrainingLocked()
	k.mu.Unlock()
	if n >= recoverLimit {
		slog.Error("keeper: gateways keep dying; giving up", "deaths", n, "window", recoverWindow, "last", why)
		k.stopChildren()
		keeperExitReq <- 1
		return
	}
	backoff := time.Duration(n-1) * time.Second
	slog.Error("keeper: starting the gateway again over its live children", "why", why, "deaths_in_window", n, "backoff", backoff)
	time.Sleep(backoff)
	next, err := k.startGeneration(l, modeRecover, nil, predecessor)
	if err != nil {
		slog.Error("keeper: could not restart the gateway", "err", err)
		k.stopChildren()
		keeperExitReq <- 1
		return
	}
	k.mu.Lock()
	k.current = next
	k.mu.Unlock()
}

func isReady(g *keeperGeneration) bool {
	select {
	case <-g.ready:
		return true
	default:
		return false
	}
}

// anyDrainingLocked: a generation other than the current one is still alive
// and was serving (it drains requests it accepted). Called with mu held.
func (k *keeper) anyDrainingLocked() bool {
	for _, g := range k.gens {
		if g != k.current && isReady(g) {
			return true
		}
	}
	return false
}

// handover replaces from (the current generation) by a new one running req,
// once the new one serves. from keeps serving until then; on any failure it
// is told so and nothing changed.
func (k *keeper) handover(from *keeperGeneration, m keeperMsg) {
	fail := func(err error) {
		slog.Warn("keeper: handover refused", "err", err)
		from.enqueue(keeperMsg{T: msgHandoverResult, Err: err.Error()})
	}
	k.mu.Lock()
	switch {
	case k.stopping:
		k.mu.Unlock()
		fail(errors.New("the keeper is stopping"))
		return
	case k.current != from:
		k.mu.Unlock()
		fail(errors.New("only the serving generation can hand over"))
		return
	case k.handing:
		k.mu.Unlock()
		fail(errors.New("a handover is already in flight"))
		return
	case len(k.listeners) == 0:
		k.mu.Unlock()
		fail(errors.New("the keeper holds no listening socket yet"))
		return
	}
	k.handing = true
	k.mu.Unlock()

	l := from.launch
	if r := m.Launch; r != nil {
		if r.Binary != "" {
			l.Binary = r.Binary
		}
		if r.Args != nil {
			l.Args = r.Args
		}
		if r.Env != nil {
			l.Env = r.Env
		}
		if r.Dir != "" {
			l.Dir = r.Dir
		}
	}
	started := time.Now()
	next, err := k.startGeneration(l, modeHandover, m.State, true)
	if err != nil {
		k.finishHandover(from, nil, l, fmt.Errorf("start the new gateway: %w", err))
		return
	}
	select {
	case <-next.ready:
		k.finishHandover(from, next, l, nil)
		slog.Info("keeper: handed over", "from", from.id, "from_pid", from.cmd.Process.Pid,
			"to", next.id, "to_pid", next.cmd.Process.Pid, "binary", l.Binary, "took", time.Since(started))
	case <-next.exited:
		// boundReady kills one not ready in time; either way it is gone.
		k.abortSuccessor(next)
		k.finishHandover(from, nil, l, fmt.Errorf("the new gateway exited before it was ready (code %d) — its output is in the gateway's stdio log", next.cmd.ProcessState.ExitCode()))
	}
}

// finishHandover ends a handover under mu — the same section in which a
// serving generation's death is told apart (waitGeneration reads handing):
// on success the successor is current and its predecessor is told to drain;
// on failure the predecessor is told it keeps serving — or, if it died
// meanwhile, the keeper recovers over the children.
func (k *keeper) finishHandover(from, next *keeperGeneration, l launch, err error) {
	k.mu.Lock()
	k.handing = false
	fromDead := false
	select {
	case <-from.exited:
		fromDead = true
	default:
	}
	if err == nil {
		k.current = next
		from.enqueue(keeperMsg{T: msgHandoverResult, Pid: next.cmd.Process.Pid})
		if fromDead && !k.anyDrainingLocked() {
			next.enqueue(keeperMsg{T: msgPredecessorGone, Pid: from.cmd.Process.Pid})
		}
		k.mu.Unlock()
		return
	}
	k.mu.Unlock()
	if fromDead {
		k.recover(from.launch, "the serving gateway died during a handover that then failed: "+err.Error())
		return
	}
	slog.Warn("keeper: handover failed; the serving gateway keeps serving", "err", err)
	from.enqueue(keeperMsg{T: msgHandoverResult, Err: err.Error()})
}

// abortSuccessor stops whatever a successor that never became the serving
// generation started: its predecessor does not know those children.
func (k *keeper) abortSuccessor(gen *keeperGeneration) {
	k.mu.Lock()
	var orphans []int
	for pid, kc := range k.children {
		if kc.spawnedBy == gen.id {
			orphans = append(orphans, pid)
		}
	}
	k.mu.Unlock()
	for _, pid := range orphans {
		slog.Warn("keeper: stopping a child the failed successor started", "pid", pid)
		_ = syscall.Kill(-pid, syscall.SIGTERM)
	}
}

// keeperStopMargin: past the generations' own shutdown budget, how long the
// keeper waits before killing one — inside its service manager's stop
// timeout (launchd's ExitTimeOut is the budget + 5 s).
const keeperStopMargin = time.Second

// shutdown forwards the service manager's stop to every generation, waits
// for them within the stop budget, then stops whatever children remain (the
// generation's own shutdown normally stopped them all).
func (k *keeper) shutdown(sig os.Signal) int {
	k.mu.Lock()
	k.stopping = true
	gens := make([]*keeperGeneration, 0, len(k.gens))
	for _, g := range k.gens {
		gens = append(gens, g)
	}
	k.mu.Unlock()
	slog.Info("keeper: stopping", "signal", sig.String(), "generations", len(gens))
	for _, g := range gens {
		_ = g.cmd.Process.Signal(syscall.SIGTERM)
	}
	deadline := time.After(k.cfg.ShutdownTimeout + keeperStopMargin)
	for _, g := range gens {
		select {
		case <-g.exited:
		case <-deadline:
			slog.Error("keeper: a generation outlived the stop budget; killing it", "generation", g.id)
			_ = g.cmd.Process.Kill()
		}
	}
	k.stopChildren()
	return 0
}

// stopChildren SIGTERMs every remaining child group, then SIGKILLs what is
// left after a short grace.
func (k *keeper) stopChildren() {
	k.mu.Lock()
	var left []*child
	for _, kc := range k.children {
		left = append(left, kc.c)
	}
	k.mu.Unlock()
	if len(left) == 0 {
		return
	}
	slog.Warn("keeper: stopping children no generation stopped", "count", len(left))
	for _, c := range left {
		_ = syscall.Kill(-c.Pid, syscall.SIGTERM)
	}
	grace := time.After(time.Second)
	for _, c := range left {
		select {
		case <-c.done:
		case <-grace:
			_ = syscall.Kill(-c.Pid, syscall.SIGKILL)
		}
	}
}

// parseKeeperFd reports the -keeper-fd value, or 0 when absent (this
// process is a keeper).
func parseKeeperFd(v string) (int, error) {
	if v == "" {
		return 0, nil
	}
	fd, err := strconv.Atoi(v)
	if err != nil || fd < 3 {
		return 0, fmt.Errorf("%s %q: not an inherited fd", keeperFdFlag, v)
	}
	return fd, nil
}
