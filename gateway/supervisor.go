package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
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

// ReadyProbe checks whether a service is reachable.
type ReadyProbe interface {
	Check(timeout time.Duration) bool
}

// UnixProbe dials a Unix domain socket.
type UnixProbe struct{ Path string }

func (p UnixProbe) Check(timeout time.Duration) bool {
	c, err := net.DialTimeout("unix", p.Path, timeout)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// TCPProbe dials a TCP host:port.
type TCPProbe struct{ Addr string }

func (p TCPProbe) Check(timeout time.Duration) bool {
	c, err := net.DialTimeout("tcp", p.Addr, timeout)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// Service is one supervised process.
type Service struct {
	config    ServiceConfig
	probe     ReadyProbe
	mu        sync.Mutex
	state     ServiceState
	lastErr   string // why the service last crashed; empty unless state is Crashed
	watchStop chan struct{}
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
}

const (
	defaultWatchdogInterval = 2 * time.Second
	startReadyTimeout       = 30 * time.Second
	probeTimeout            = 1500 * time.Millisecond
	probeInterval           = 500 * time.Millisecond
)

// NewSupervisor reads the config file and builds the supervisor. If the file
// is missing or has no services, the supervisor is empty (nothing to manage).
// env is the environment every service start command runs with.
func NewSupervisor(configPath string, env ChildEnv) (*Supervisor, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			slog.Info("supervisor: no database config file; no services to manage", "path", configPath)
			return &Supervisor{env: env}, nil
		}
		return nil, fmt.Errorf("supervisor: read config: %w", err)
	}

	var cfg databaseConfigFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("supervisor: parse config: %w", err)
	}

	sup := &Supervisor{env: env}
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

	if err := sup.execStartCommand(svc.config); err != nil {
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
func (sup *Supervisor) execStartCommand(cfg ServiceConfig) error {
	if len(cfg.Start) == 0 {
		return fmt.Errorf("empty start command")
	}
	cmd := sup.env.Command(cfg.Start[0], cfg.Start[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("start command failed: %w: %s", err, string(out))
	}
	return nil
}

func waitForReady(ctx context.Context, probe ReadyProbe, deadline time.Duration) bool {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()

	// Check immediately before first tick.
	if probe.Check(probeTimeout) {
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return false
		case <-ticker.C:
			if probe.Check(probeTimeout) {
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
			if svc.probe.Check(probeTimeout) {
				continue
			}
			slog.Error("supervisor: watchdog detected service down; attempting re-start", "name", svc.config.Name)
			svc.setState(ServiceStarting)
			if err := sup.execStartCommand(svc.config); err != nil {
				slog.Error("supervisor: re-start failed; not retrying", "name", svc.config.Name, "err", err)
				svc.setCrashed(err)
				return
			}
			if !waitForReady(ctx, svc.probe, startReadyTimeout) {
				slog.Error("supervisor: re-started but service not ready; marking crashed", "name", svc.config.Name)
				svc.setCrashed(fmt.Errorf("re-started but service did not become ready within %s", startReadyTimeout))
				return
			}
			svc.setState(ServiceRunning)
			slog.Info("supervisor: service re-started successfully", "name", svc.config.Name)
		}
	}
}
