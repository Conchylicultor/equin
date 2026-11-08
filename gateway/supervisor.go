package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Generic service supervisor. Reads a list of services from the database
// config file, starts each one, probes readiness, and arms a watchdog.
// The supervisor knows nothing about what services are — it just executes
// start commands and dials sockets.

// ServiceState is the lifecycle state of a supervised service.
type ServiceState int

const (
	ServiceStopped ServiceState = iota
	ServiceStarting
	ServiceRunning
	ServiceCrashed
)

func (s ServiceState) String() string {
	switch s {
	case ServiceStopped:
		return "stopped"
	case ServiceStarting:
		return "starting"
	case ServiceRunning:
		return "running"
	case ServiceCrashed:
		return "crashed"
	default:
		return "unknown"
	}
}

// ServiceConfig is one entry in the database.json "services" array.
type ServiceConfig struct {
	Name     string          `json:"name"`
	Start    []string        `json:"start"`
	Ready    json.RawMessage `json:"ready"`
	Watchdog *WatchdogConfig `json:"watchdog"`
}

// WatchdogConfig controls the health-check ticker for a service.
type WatchdogConfig struct {
	IntervalSec int `json:"intervalSec"`
}

// databaseConfigFile is the on-disk shape of ~/.equin/state/db-config/database.json.
// Only the "services" field is read by the supervisor.
type databaseConfigFile struct {
	Services []ServiceConfig `json:"services"`
}

// ReadyProbe checks whether a service is reachable: nil when it answered, else
// why not (the dial's own error — refused, no such socket, timed out), which a
// service-down report carries as what the watchdog saw.
type ReadyProbe interface {
	Check(timeout time.Duration) error
	// String names what is probed, e.g. "unix /path/.s.PGSQL.5433".
	String() string
}

// UnixProbe dials a Unix domain socket.
type UnixProbe struct{ Path string }

func (p UnixProbe) Check(timeout time.Duration) error {
	return dialProbe("unix", p.Path, timeout)
}

func (p UnixProbe) String() string { return "unix " + p.Path }

// TCPProbe dials a TCP host:port.
type TCPProbe struct{ Addr string }

func (p TCPProbe) Check(timeout time.Duration) error {
	return dialProbe("tcp", p.Addr, timeout)
}

func (p TCPProbe) String() string { return "tcp " + p.Addr }

func dialProbe(network, addr string, timeout time.Duration) error {
	c, err := net.DialTimeout(network, addr, timeout)
	if err != nil {
		return err
	}
	_ = c.Close()
	return nil
}

// Service is one supervised process.
type Service struct {
	config  ServiceConfig
	probe   ReadyProbe
	mu      sync.Mutex
	state   ServiceState
	lastErr string // why the service last crashed; empty unless state is Crashed
	// runningSince is when the service last reached ServiceRunning: how long
	// it had been up when a watchdog found it down.
	runningSince time.Time
	watchStop    chan struct{}
}

// setState transitions the service. Reaching ServiceRunning clears lastErr here
// rather than at each call site: a running service by definition has no
// outstanding failure, and centralizing the clear means a future transition
// cannot forget it and leave a stale reason attached to a healthy service.
// Crash transitions go through setCrashed, which carries the reason.
func (s *Service) setState(st ServiceState) {
	s.mu.Lock()
	s.state = st
	if st == ServiceRunning {
		s.lastErr = ""
		s.runningSince = time.Now()
	}
	s.mu.Unlock()
}

// setCrashed marks the service crashed together with the error that caused it,
// atomically. A `crashed` state with no reason is a value no consumer can act
// on — the launcher and /gateway/services both need the text, not just the fact.
func (s *Service) setCrashed(err error) {
	s.mu.Lock()
	s.state = ServiceCrashed
	s.lastErr = err.Error()
	s.mu.Unlock()
}

func (s *Service) getState() ServiceState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// snapshot reads state and lastErr under one lock, so the reported reason
// always belongs to the reported state.
func (s *Service) snapshot() ServiceSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ServiceSnapshot{
		Name:  s.config.Name,
		State: s.state.String(),
		Error: s.lastErr,
	}
}

// ServiceSnapshot is the JSON shape returned by /gateway/services.
type ServiceSnapshot struct {
	Name  string `json:"name"`
	State string `json:"state"`
	// omitempty keeps a healthy service's JSON byte-identical to what it was
	// before the field existed — consumers only ever see `error` on a failure.
	Error string `json:"error,omitempty"`
}

// Supervisor manages a set of services read from database.json.
type Supervisor struct {
	services []*Service
	// env is the declared base environment every start command runs with (see
	// env.go). Postgres and PgBouncer are daemons that outlive the command, so
	// whatever they inherit they keep for the life of the cluster.
	env ChildEnv
	// logDir is the gateway's -log-dir: each service's output goes to
	// serviceLogPath(logDir, name) through a detached relay (logrelay.go).
	logDir string
	// outboxDir is the gateway's -report-outbox-dir: a service the watchdog
	// finds down mid-session is filed there (service_report.go).
	outboxDir string
	// startCommandTimeout bounds one run of a start command
	// (defaultStartCommandTimeout; tests shorten it).
	startCommandTimeout time.Duration
}

const (
	defaultWatchdogInterval = 2 * time.Second
	startReadyTimeout       = 30 * time.Second
	probeTimeout            = 1500 * time.Millisecond
	probeInterval           = 500 * time.Millisecond

	// defaultStartCommandTimeout bounds a start command we do not control
	// (bun, pg_ctl, initdb, whatever a future service runs). It is NOT what
	// keeps the known start scripts finite — each bounds its own waits (pg_ctl
	// -t 30, PgBouncer's 30 s readiness loop, the cluster session's 60 s
	// per-call deadline), and their worst case is well inside it. It catches
	// the next unbounded wait nobody has found yet, and says so: the error
	// names the bound and carries the output so far, so the outage is filed
	// with it (service-down) instead of the watchdog blocking forever.
	defaultStartCommandTimeout = 5 * time.Minute
	// startCommandWaitDelay is how long the command's output pipe may stay
	// open after the command itself exits: a process it started that kept
	// the pipe as its stdout/stderr (a daemon that never detached its stdio)
	// would otherwise hold CombinedOutput open for the daemon's whole life.
	startCommandWaitDelay = 5 * time.Second
)

// NewSupervisor reads the config file and builds the supervisor. If the file
// is missing or has no services, the supervisor is empty (nothing to manage).
// env is the environment every service start command runs with; logDir is
// where each service's output channel lives; outboxDir is the report outbox a
// mid-session outage is filed into.
func NewSupervisor(configPath string, env ChildEnv, logDir, outboxDir string) (*Supervisor, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			slog.Info("supervisor: no database config file; no services to manage", "path", configPath)
			return &Supervisor{env: env, logDir: logDir, outboxDir: outboxDir}, nil
		}
		return nil, fmt.Errorf("supervisor: read config: %w", err)
	}

	var cfg databaseConfigFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("supervisor: parse config: %w", err)
	}

	sup := &Supervisor{env: env, logDir: logDir, outboxDir: outboxDir}
	for _, sc := range cfg.Services {
		probe, err := parseReadyProbe(sc.Ready)
		if err != nil {
			return nil, fmt.Errorf("supervisor: service %q: %w", sc.Name, err)
		}
		sup.services = append(sup.services, &Service{
			config: sc,
			probe:  probe,
			state:  ServiceStopped,
		})
	}
	return sup, nil
}

func parseReadyProbe(raw json.RawMessage) (ReadyProbe, error) {
	var shape map[string]string
	if err := json.Unmarshal(raw, &shape); err != nil {
		return nil, fmt.Errorf("parse ready probe: %w", err)
	}
	if p, ok := shape["unix"]; ok {
		return UnixProbe{Path: p}, nil
	}
	if p, ok := shape["tcp"]; ok {
		return TCPProbe{Addr: p}, nil
	}
	return nil, fmt.Errorf("ready probe must have \"unix\" or \"tcp\" key")
}

// StartAll starts every service sequentially: exec start command, wait for
// readiness, arm watchdog.
func (sup *Supervisor) StartAll(ctx context.Context) error {
	for _, svc := range sup.services {
		if err := sup.startService(ctx, svc); err != nil {
			return fmt.Errorf("service %q: %w", svc.config.Name, err)
		}
	}
	return nil
}

func (sup *Supervisor) startService(ctx context.Context, svc *Service) error {
	svc.setState(ServiceStarting)
	slog.Info("supervisor: starting service", "name", svc.config.Name)

	if _, err := sup.execStartCommand(ctx, svc.config); err != nil {
		svc.setCrashed(err)
		return err
	}

	// Verify readiness by polling the probe (the start command may return
	// before the daemon is fully reachable).
	if !waitForReady(ctx, svc.probe, startReadyTimeout) {
		err := fmt.Errorf("service did not become ready within %s", startReadyTimeout)
		svc.setCrashed(err)
		return err
	}

	svc.setState(ServiceRunning)
	slog.Info("supervisor: service ready", "name", svc.config.Name)
	sup.startWatchdog(ctx, svc)
	return nil
}

// execStartCommand runs a service's start command to completion with the
// declared base environment, set explicitly: a nil Env here used to mean the
// command — and the daemon it leaves running — inherited the gateway's whole
// environment, starter's shell and all.
//
// Every start gets its own log relay (logrelay.go): the command inherits the
// relay pipe's write end as fd 3, named by `--log-fd 3` on its argv, and hands it
// to the daemon it starts as stdout/stderr — so the daemon never owns a log
// file. A start that only reattaches to a running daemon leaves the fd unused;
// once this function closes its own copy the relay reads EOF and exits without
// ever opening the file.
//
// Returns the command's own output (what it did: started the daemon, or found
// it running and reattached); a failure's error carries it too.
//
// Bounded, because the watchdog and boot both wait on it: a start that never
// returns leaves its service down and unwatched with nothing filed. The
// command runs in its own process group, and at startCommandTimeout (or when
// ctx ends) the whole group is killed — its helpers (pg_ctl, initdb) with it,
// but never the daemon: a daemon detaches into its own session (pg_ctl and
// the PgBouncer script both setsid it), which is what makes it a daemon. A
// command that exits while something it started still holds its output pipe
// fails too (startCommandWaitDelay), naming that.
func (sup *Supervisor) execStartCommand(ctx context.Context, cfg ServiceConfig) (string, error) {
	if len(cfg.Start) == 0 {
		return "", fmt.Errorf("empty start command")
	}
	logW, err := startLogRelay(sup.env, serviceLogPath(sup.logDir, cfg.Name))
	if err != nil {
		return "", err
	}
	defer logW.Close()
	timeout := sup.startCommandTimeout
	if timeout <= 0 {
		timeout = defaultStartCommandTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := append(append([]string{}, cfg.Start[1:]...), serviceLogFdFlag, strconv.Itoa(serviceLogFd))
	cmd := sup.env.CommandContext(runCtx, cfg.Start[0], args...)
	cmd.ExtraFiles = []*os.File{logW}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// The group's id is the command's pid (Setpgid). ESRCH: it is gone.
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		return nil
	}
	cmd.WaitDelay = startCommandWaitDelay
	started := time.Now()
	out, err := cmd.CombinedOutput()
	switch {
	case errors.Is(runCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil:
		return string(out), fmt.Errorf("start command did not exit within %s (ran %s); killed it and every process in its group — a wait inside it has no bound of its own: %s",
			timeout, time.Since(started).Round(time.Millisecond), string(out))
	case errors.Is(err, exec.ErrWaitDelay):
		return string(out), fmt.Errorf("start command exited, but a process it started still held its output pipe %s later (a daemon that did not detach its stdout/stderr): %s",
			startCommandWaitDelay, string(out))
	case err != nil:
		return string(out), fmt.Errorf("start command failed: %w: %s", err, string(out))
	}
	return string(out), nil
}

func waitForReady(ctx context.Context, probe ReadyProbe, deadline time.Duration) bool {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()

	// Check immediately before first tick.
	if probe.Check(probeTimeout) == nil {
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return false
		case <-ticker.C:
			if probe.Check(probeTimeout) == nil {
				return true
			}
		}
	}
}

// StopAll stops all watchdog goroutines. Services themselves are daemons
// and keep running — the supervisor doesn't own their process lifecycle.
func (sup *Supervisor) StopAll() {
	for _, svc := range sup.services {
		svc.mu.Lock()
		if svc.watchStop != nil {
			close(svc.watchStop)
			svc.watchStop = nil
		}
		svc.mu.Unlock()
	}
}

// List returns a snapshot of all services.
func (sup *Supervisor) List() []ServiceSnapshot {
	out := make([]ServiceSnapshot, 0, len(sup.services))
	for _, svc := range sup.services {
		out = append(out, svc.snapshot())
	}
	return out
}

// Get returns a snapshot of a single service, or nil if not found.
func (sup *Supervisor) Get(name string) *ServiceSnapshot {
	for _, svc := range sup.services {
		if svc.config.Name == name {
			snap := svc.snapshot()
			return &snap
		}
	}
	return nil
}

// ─── watchdog ────────────────────────────────────────────────

func (sup *Supervisor) startWatchdog(ctx context.Context, svc *Service) {
	svc.mu.Lock()
	if svc.watchStop != nil {
		svc.mu.Unlock()
		return
	}
	stop := make(chan struct{})
	svc.watchStop = stop
	svc.mu.Unlock()
	go sup.runWatchdog(ctx, svc, stop)
}

// runWatchdog dials the service's readiness probe on a ticker. On failure,
// attempts one re-exec of the start command; if that also fails, marks the
// service Crashed and stops watching.
//
// Either way the outage is filed as a service-down report once it settles
// (service_report.go): a service that died mid-session took every database
// connection with it, and the backends' downstream errors never name it.
func (sup *Supervisor) runWatchdog(ctx context.Context, svc *Service, stop <-chan struct{}) {
	interval := defaultWatchdogInterval
	if svc.config.Watchdog != nil && svc.config.Watchdog.IntervalSec > 0 {
		interval = time.Duration(svc.config.Watchdog.IntervalSec) * time.Second
	}

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-t.C:
			if svc.getState() != ServiceRunning {
				continue
			}
			probeErr := svc.probe.Check(probeTimeout)
			if probeErr == nil {
				continue
			}
			if !sup.recoverService(ctx, svc, probeErr) {
				return
			}
		}
	}
}

// recoverService handles one outage the watchdog found: re-runs the start
// command, waits for readiness, and files the outage with how it ended.
// Returns false when the service is left Crashed (the watchdog stops).
func (sup *Supervisor) recoverService(ctx context.Context, svc *Service, probeErr error) bool {
	name := svc.config.Name
	outage := sup.newOutage(svc, probeErr, time.Now())
	slog.Error("supervisor: watchdog detected service down; attempting re-start", "name", name, "probe", svc.probe.String(), "err", probeErr)
	svc.setState(ServiceStarting)
	out, err := sup.execStartCommand(ctx, svc.config)
	if err != nil {
		if ctx.Err() != nil {
			// The gateway is shutting down and stopped the command: not the
			// service failing, so nothing settled and there is nothing to file.
			return false
		}
		slog.Error("supervisor: re-start failed; not retrying", "name", name, "err", err)
		svc.setCrashed(err)
		sup.reportServiceDown(outage.settle(outcomeCrashed, time.Now(), out, err))
		return false
	}
	if !waitForReady(ctx, svc.probe, startReadyTimeout) {
		if ctx.Err() != nil {
			// The gateway is shutting down, not the service failing: nothing
			// settled, so there is no outcome to file.
			return false
		}
		slog.Error("supervisor: re-started but service not ready; marking crashed", "name", name)
		err := fmt.Errorf("re-started but service did not become ready within %s", startReadyTimeout)
		svc.setCrashed(err)
		sup.reportServiceDown(outage.settle(outcomeCrashed, time.Now(), out, err))
		return false
	}
	svc.setState(ServiceRunning)
	slog.Info("supervisor: service re-started successfully", "name", name)
	sup.reportServiceDown(outage.settle(outcomeRecovered, time.Now(), out, nil))
	return true
}
