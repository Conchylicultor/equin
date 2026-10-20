package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

// Config holds all gateway settings, parsed from command-line flags.
type Config struct {
	Listen            string
	IdleTimeout       time.Duration
	ShutdownGrace     time.Duration
	ReadyTimeout      time.Duration
	ReadyTimeoutMax   time.Duration
	SweepInterval     time.Duration
	ReconcileInterval time.Duration
	BrokenCooldown    time.Duration
	LogLevel          string
	LogFormat         string
	LogBufferLines    int
	LogDir            string
	RegistryDir       string
	SocketsDir        string
	CentralRoutesFile string
	DbConfigFile      string
	DefaultNamespace  string
	PidFile           string

	// Taskpolicy is the macOS priority tool background boots are demoted and
	// promoted with (detectTaskpolicy), "" where there is none. Not a flag:
	// main detects it; tests point it at a fake.
	Taskpolicy string

	// ChildEnv is the environment every child process starts from: the names
	// declared by -child-env, captured from the gateway's own environment once
	// at boot (see env.go). Not a flag itself — main resolves it from the flag
	// after logging is up, so a bad declaration is reported like any other
	// fatal startup error.
	ChildEnv ChildEnv
}

// dataRoot resolves the Singularity data root (`~/.singularity` by default).
//
// It exists ONLY to derive the defaults of the path flags below. Every path the
// gateway uses is a flag, so the launcher can hand it fully-resolved locations
// and the root never has to be re-derived anywhere else in the process — which
// is what let two independently-drifting copies of this fallback exist before.
func dataRoot() string {
	if dir := os.Getenv("SINGULARITY_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".singularity")
}

// parseFlags parses the command line into a Config, and returns the raw
// -child-env value alongside it: that one is validated and resolved into
// cfg.ChildEnv by main, once logging is set up to report a bad one.
func parseFlags() (Config, string) {
	var cfg Config
	flag.StringVar(&cfg.Listen, "listen", ":9000", "address to listen on")
	flag.DurationVar(&cfg.IdleTimeout, "idle-timeout", 10*time.Minute, "backend idle timeout")
	flag.DurationVar(&cfg.ShutdownGrace, "shutdown-grace", 5*time.Second, "grace period before SIGKILL")
	flag.DurationVar(&cfg.ReadyTimeout, "ready-timeout", 15*time.Second, "max wait for backend readiness")
	flag.DurationVar(&cfg.ReadyTimeoutMax, "ready-timeout-max", 90*time.Second, "ceiling for the load-adaptive backend readiness timeout; also the extra wait granted when a slow-but-alive boot escalates instead of being killed")
	flag.DurationVar(&cfg.SweepInterval, "sweep-interval", 30*time.Second, "idle sweeper tick")
	flag.DurationVar(&cfg.ReconcileInterval, "reconcile-interval", 10*time.Second, "registry-dir reconcile tick (registers worktrees the fsnotify watch missed, unregisters vanished ones)")
	flag.DurationVar(&cfg.BrokenCooldown, "broken-cooldown", 10*time.Second, "wait before retrying a failed spawn")
	flag.StringVar(&cfg.LogLevel, "log-level", "info", "log level: debug|info|warn|error")
	flag.StringVar(&cfg.LogFormat, "log-format", "text", "log format: text|json")
	flag.IntVar(&cfg.LogBufferLines, "log-buffer-lines", 1000, "per-worktree backend log ring capacity")

	// These defaults mirror the TypeScript `defineDataDir` declarations that own
	// each location (`logs/gateway`, `state/gateway`, `state/db-config`, and the
	// grandfathered-in-place `sockets` and `worktrees`). The launcher passes all
	// five explicitly, so nothing in the normal path depends on them — they exist
	// for a hand-run gateway, and they must be kept in step with
	// plugins/infra/plugins/launcher/data-dirs/index.ts.
	dataDir := dataRoot()
	defaultLogDir := filepath.Join(dataDir, "logs", "gateway")
	flag.StringVar(&cfg.LogDir, "log-dir", defaultLogDir, "directory for the gateway and per-worktree log files")
	defaultRegistry := filepath.Join(dataDir, "worktrees")
	flag.StringVar(&cfg.RegistryDir, "registry-dir", defaultRegistry, "directory of worktree JSON files")
	defaultSockets := os.Getenv("SINGULARITY_SOCKETS_DIR")
	if defaultSockets == "" {
		defaultSockets = filepath.Join(dataDir, "sockets")
	}
	flag.StringVar(&cfg.SocketsDir, "sockets-dir", defaultSockets, "directory for per-worktree Unix sockets (env: SINGULARITY_SOCKETS_DIR; short /tmp dir for deep release roots)")
	defaultCentralRoutes := filepath.Join(dataDir, "state", "gateway", "central-routes.json")
	flag.StringVar(&cfg.CentralRoutesFile, "central-routes-file", defaultCentralRoutes, "path to the central routing manifest")
	defaultDbConfig := filepath.Join(dataDir, "state", "db-config", "database.json")
	flag.StringVar(&cfg.DbConfigFile, "db-config", defaultDbConfig, "path to the managed-service (database) config the supervisor reads")
	// Fallback namespace for subdomain-less requests. Empty ⇒ such requests 404
	// (dev/multi-app). A packaged single-app build (desktop/Tauri, single-origin
	// web) sets it to the app's name so a bare-localhost webview reaches the
	// backend. The launcher passes it as this flag; the flag is the contract.
	flag.StringVar(&cfg.DefaultNamespace, "default-namespace", "", "fallback namespace for requests with no subdomain")
	// Where the gateway records its own pid. The gateway writes it itself because
	// under launchd (./singularity start on macOS) no launcher sees the spawn: a
	// gateway launchd relaunches at login or after a crash would otherwise leave
	// the file naming a dead generation. Empty ⇒ no pidfile (a hand-run gateway).
	flag.StringVar(&cfg.PidFile, "pid-file", "", "file to write this process's pid to at boot")
	// The environment names every child process may receive (see env.go).
	// Required and deliberately default-less: the declaration lives in
	// plugins/infra/plugins/launcher/core (runtimeEnvNames), and a default here
	// would be a second copy of it.
	var childEnv string
	flag.StringVar(&childEnv, "child-env", "", "REQUIRED: comma-separated environment variable names children receive (NAME_* matches a prefix); ./singularity start passes launcher/core runtimeEnvNames()")

	flag.Parse()
	return cfg, childEnv
}

func setupLogging(cfg Config) {
	var level slog.Level
	switch cfg.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	// The gateway's own logs are their own channel: a rotating gateway.log,
	// separate from each worktree backend's <name>.log. Per-process stdout/stderr
	// (Go panics, pre-logging crashes) is captured separately by the launcher.
	out := newRotatingWriter(filepath.Join(cfg.LogDir, "gateway.log"), maxLogBytes, maxLogBackups)
	var h slog.Handler
	if cfg.LogFormat == "json" {
		h = slog.NewJSONHandler(out, opts)
	} else {
		h = slog.NewTextHandler(out, opts)
	}
	slog.SetDefault(slog.New(h))
}

// fatal reports an unrecoverable startup failure and exits non-zero.
//
// It writes to BOTH slog (gateway.log, for the operator who knows to look) and
// os.Stderr. The stderr write is load-bearing, not belt-and-braces: the launcher
// redirects the gateway's stdout/stderr to gateway-stdio.log opened in "w" mode,
// so that file is truncated on every start and therefore holds exactly this
// boot's fatal error with no scrollback to read past. That is the file the
// launcher quotes back to the terminal the operator is already watching.
func fatal(stderrMsg string, logMsg string, err error) {
	slog.Error(logMsg, "err", err)
	fmt.Fprintf(os.Stderr, "%s\n", stderrMsg)
	os.Exit(1)
}

// writePidFile records this process's pid, creating the parent directory. It is
// deliberately never removed on exit: every reader already checks the pid for
// liveness, and a missing file is how a preview's reaper tells "still booting".
func writePidFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o644)
}

func main() {
	cfg, childEnvFlag := parseFlags()
	setupLogging(cfg)

	// Resolve the declared child environment before anything can spawn. The
	// names the gateway itself carries but will not forward are logged at warn:
	// the normal ./singularity start path drops nothing (the launcher already
	// filtered the gateway's own environment to the same list), so a non-empty
	// list means a hand-run gateway, and its would-be leak is visible in
	// gateway.log rather than silently absent. Names only — never values.
	declared, err := parseChildEnvFlag(childEnvFlag)
	if err != nil {
		fatal(fmt.Sprintf("gateway: fatal: %v", err), "invalid -child-env", err)
	}
	childEnv, dropped := captureChildEnv(declared)
	cfg.ChildEnv = childEnv
	cfg.Taskpolicy = detectTaskpolicy()
	slog.Info("child environment", "forwarded", childEnv.Names())
	if len(dropped) > 0 {
		slog.Warn("child environment: not forwarding undeclared variables from the gateway's own environment", "dropped", dropped)
	}

	if cfg.PidFile != "" {
		if err := writePidFile(cfg.PidFile); err != nil {
			fatal(fmt.Sprintf("gateway: fatal: write pid file %s: %v", cfg.PidFile, err),
				"write pid file failed", err)
		}
	}

	if err := os.MkdirAll(cfg.SocketsDir, 0o755); err != nil {
		slog.Error("create sockets dir failed", "err", err, "dir", cfg.SocketsDir)
		os.Exit(1)
	}
	reg := NewRegistry(&cfg)
	if err := reg.LoadAll(); err != nil {
		slog.Error("registry load failed", "err", err)
		os.Exit(1)
	}
	// Reap orphan backends left by a prior gateway generation. MUST run here —
	// after the registry is loaded but BEFORE the watcher/sweep goroutines and
	// the eager-central spawn below — because it relies on the gateway having
	// spawned zero backends yet (so any live socket is a prior-generation
	// orphan). Do not move it after anything that can start a backend.
	reconcileOrphanBackends(cfg.SocketsDir, reg)

	routes := NewCentralRoutesStore(cfg.CentralRoutesFile)
	sup, err := NewSupervisor(cfg.DbConfigFile, cfg.ChildEnv)
	if err != nil {
		// A malformed database.json is a misconfiguration, not a signal. The
		// benign "I manage my own database" case is a *missing* file, which
		// NewSupervisor already answers with an empty supervisor — so reaching
		// here means the operator wrote a config we could not honour, and
		// silently managing nothing would hide that behind a later timeout.
		fatal(fmt.Sprintf("gateway: fatal: bad managed-service config %s: %v", cfg.DbConfigFile, err),
			"supervisor: failed to load config", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	go func() {
		if err := reg.Watch(ctx); err != nil {
			slog.Error("watcher exited with error", "err", err)
		}
	}()
	go func() {
		if err := routes.Watch(ctx); err != nil {
			slog.Error("central routes watcher exited with error", "err", err)
		}
	}()
	go reg.Sweep(ctx)
	// Periodic backstop for registry drift the fsnotify watch can miss under
	// watch-FD pressure (thousands of worktree dirs). Registers worktrees whose
	// spec.json appeared without a delivered event; unregisters vanished ones.
	go reg.Reconcile(ctx)

	// Start supervised services (e.g. embedded Postgres) before backends.
	// Backends assume services are reachable; the supervisor must bring them up
	// first — so a service that fails to start is fatal, not a warning. A
	// gateway whose managed Postgres never came up can serve static files and
	// nothing else: continuing would trade a startup failure that names its
	// cause ("initdb: error: cannot be run as root") for a timeout 90s later
	// that names nothing. Because this runs before ListenAndServe, "the gateway
	// is listening" now implies "every managed service came up" — which is what
	// lets the launcher wait on the port instead of on a service's socket.
	//
	// The watchdog deliberately does NOT share this policy: a service dying
	// mid-session records its reason and the gateway stays up, since killing it
	// would tear down every live backend over a transient blip.
	if err := sup.StartAll(ctx); err != nil {
		fatal(fmt.Sprintf("gateway: fatal: managed service failed to start: %v", err),
			"supervisor: start failed", err)
	}

	// Eagerly spawn `central` so plugins that load on boot (auth, secrets) are
	// ready before the first request lands. PG is up by this point, so
	// central's plugins can connect immediately.
	if wt := reg.Get("central"); wt != nil {
		go func() {
			if _, err := wt.Ensure(ctx, StartBackground); err != nil {
				slog.Warn("eager central spawn failed", "err", err)
			}
		}()
	}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           NewProxy(reg, routes, sup, cfg.DefaultNamespace),
		ReadHeaderTimeout: 10 * time.Second,
	}

	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		slog.Info("shutdown signal received")
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer shutCancel()
		_ = srv.Shutdown(shutCtx)
		_ = reg.StopAll(shutCtx)
		// Clears watchdog goroutines; services keep running as daemons.
		sup.StopAll()
	}()

	slog.Info("gateway listening", "addr", cfg.Listen, "registry-dir", cfg.RegistryDir, "sockets-dir", cfg.SocketsDir)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
	// Block until the shutdown goroutine finishes stopping all backends.
	// srv.Shutdown returns ErrServerClosed immediately, not when done, so
	// without this wait main returns and the process exits mid-StopAll —
	// leaving bun children reparented to init instead of terminated.
	<-shutdownDone
	slog.Info("gateway stopped")
}
