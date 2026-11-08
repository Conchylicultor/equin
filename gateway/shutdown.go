package main

import (
	"context"
	"log/slog"
	"time"
)

// shutdownWithin runs the gateway's two shutdown steps — drain the HTTP
// server, then stop every backend — inside ONE budget, so their sum cannot
// exceed it.
//
// Each step used to have its own clock: the drain waited up to 15 s for
// in-flight requests (a proxied stream never ends on its own, so one open
// stream cost the whole 15 s), and only then did the backend stops begin, each
// with its own SIGTERM grace (5 s). 15 + 5 is the service manager's whole stop
// timeout (launchd's ExitTimeOut, 20 s), so a gateway holding one open stream
// and one slow backend was SIGKILLed by launchd mid-teardown — 2026-11-08
// 18:05: the drain took 15.0 s, a backend's grace then ran into the kill, and
// `./equin start --force` gave up waiting at the same instant and never
// loaded the new gateway.
//
// Now the deadline is shared: the drain gets what is left once the backend
// stops' own share (one SIGTERM grace plus the post-SIGKILL wait) is set
// aside, and the stops run under a context that ends postKillTimeout before
// the deadline, which terminateBackend answers with an early SIGKILL. A drain
// that finishes sooner leaves its time to the stops. The launcher passes the
// budget (-shutdown-timeout) from the manager's stop timeout minus a margin
// for what follows (the supervisor's StopAll, process exit).
func shutdownWithin(budget, grace time.Duration, drain, stopAll func(context.Context) error) {
	start := time.Now()
	deadline := start.Add(budget)
	drainCtx, cancelDrain := context.WithDeadline(context.Background(), deadline.Add(-(grace + postKillTimeout)))
	if err := drain(drainCtx); err != nil {
		// Requests still open past the drain's share end when their backend
		// stops (or this process exits): their own server has gone.
		slog.Warn("shutdown: HTTP drain cut short to leave the backends their share of the budget",
			"err", err, "drained", time.Since(start), "budget", budget)
	}
	cancelDrain()
	stopCtx, cancelStop := context.WithDeadline(context.Background(), deadline.Add(-postKillTimeout))
	defer cancelStop()
	_ = stopAll(stopCtx)
	slog.Info("shutdown: backends stopped", "elapsed", time.Since(start), "budget", budget)
}
