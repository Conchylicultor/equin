package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"
)

// A supervised service (embedded Postgres, PgBouncer — whatever database.json
// lists) that dies mid-session takes every database connection with it, and
// what the user sees is the downstream errors in every backend, none of which
// names the cause. The gateway's watchdog is the one place that sees the
// service go: its readiness probe stops answering. So the watchdog files the
// outage once it settles — the service answering again after its start
// command ran, or left `crashed` — as one `service-down` entry in the report
// outbox (the same writer as a backend crash, crash_report.go), which main's
// backend drains into `reports`.
//
// Generic by construction: the supervisor knows a service only by its config
// (name, start command, probe), so the report carries only what any service
// has — the probe and why it failed, how long it had been up, what its start
// command said, and the tail of its own log channel (services/<name>.log,
// written by its log relay). Adding a service to database.json reports it with
// no code here.
//
// Filed when the outage SETTLES, not when it is detected: the outcome is part
// of the evidence, and while the database is down main could not record the
// entry anyway. A recovered outage reaches main once the database is back; a
// service left crashed waits in the outbox until main can drain it (its
// next boot with a database), like main's own crash.
//
// Unlike a backend, a service is a daemon the gateway did not spawn as its
// child (the start command forks it), so there is no wait status: no signal,
// no pid. A probe failure is what was observed, and the report says only that;
// whether the daemon had actually died is in its start command's output
// ("already running; reattaching" vs a fresh start) and in its log tail.

// serviceDownKind is the report kind. Declared by
// plugins/debug/plugins/service-down (core/kind.ts), which owns the payload's
// schema; testdata/service-down-entry.json pins this writer to it (both sides'
// tests read that one file).
const serviceDownKind = "service-down"

// serviceLogTailMaxBytes bounds the read of a service's log for its tail: the
// relay's file can be up to maxLogBytes (50 MB), and crashTailLines lines of up
// to crashLineMaxBytes each fit in this.
const serviceLogTailMaxBytes = crashTailLines * crashLineMaxBytes

// How an outage ended.
const (
	outcomeRecovered = "recovered" // the start command ran and the probe answered again
	outcomeCrashed   = "crashed"   // the start command failed, or the service never answered; the watchdog stopped
)

// serviceDown is the `service-down` payload.
type serviceDown struct {
	Service string `json:"service"`
	// Probe names what the watchdog dials, e.g. "unix /…/.s.PGSQL.5433".
	Probe string `json:"probe"`
	// ProbeError is why the probe failed: the dial's own error (refused, no
	// such file, i/o timeout).
	ProbeError string `json:"probeError"`
	// UpSince is epoch ms the service last became running (null when the
	// watchdog never saw it running — not reachable today, a watchdog is only
	// armed on a running service).
	UpSince    *int64 `json:"upSince"`
	DetectedAt int64  `json:"detectedAt"` // epoch ms the probe failed
	Outcome    string `json:"outcome"`    // outcomeRecovered | outcomeCrashed
	SettledAt  int64  `json:"settledAt"`  // epoch ms it answered again, or was marked crashed
	// RestartError is why the re-start failed (cut at crashLineMaxBytes: the
	// command's whole output is in RestartOutput); null when it recovered.
	RestartError *string `json:"restartError"`
	// RestartOutput is the start command's output lines, oldest first.
	RestartOutput []string `json:"restartOutput"`
	// LogPath is the service's own log channel; LogTail its last lines as of
	// the detection, oldest first — what the daemon said before it went.
	LogPath string   `json:"logPath"`
	LogTail []string `json:"logTail"`
	// LogTailError is why the log could not be read (LogTail is then empty);
	// null when it was read (a missing file reads as an empty tail).
	LogTailError *string `json:"logTailError"`
}

// serviceOutage is an outage the watchdog detected and has not settled yet.
type serviceOutage struct {
	down serviceDown
}

// newOutage records what the watchdog saw when the probe failed — including
// the log tail, read now, before the start command's own lines join it.
func (sup *Supervisor) newOutage(svc *Service, probeErr error, detectedAt time.Time) serviceOutage {
	svc.mu.Lock()
	since := svc.runningSince
	svc.mu.Unlock()
	var upSince *int64
	if !since.IsZero() {
		ms := since.UnixMilli()
		upSince = &ms
	}
	logPath := serviceLogPath(sup.logDir, svc.config.Name)
	// An unreadable log does not stop the report: it says why it has no tail.
	tail, err := readLogTail(logPath)
	var tailErr *string
	if err != nil {
		msg := err.Error()
		tailErr = &msg
		tail = []string{}
	}
	return serviceOutage{down: serviceDown{
		Service:       svc.config.Name,
		Probe:         svc.probe.String(),
		ProbeError:    probeErr.Error(),
		UpSince:       upSince,
		DetectedAt:    detectedAt.UnixMilli(),
		RestartOutput: []string{},
		LogPath:       logPath,
		LogTail:       tail,
		LogTailError:  tailErr,
	}}
}

// settle completes the outage with how it ended.
func (o serviceOutage) settle(outcome string, settledAt time.Time, restartOutput string, restartErr error) serviceDown {
	d := o.down
	d.Outcome = outcome
	d.SettledAt = settledAt.UnixMilli()
	if restartErr != nil {
		msg := cutLine(restartErr.Error())
		d.RestartError = &msg
	}
	d.RestartOutput = tailLines(restartOutput)
	return d
}

// serviceDownMessage is the report's one-line message.
func serviceDownMessage(d serviceDown) string {
	msg := fmt.Sprintf("service %s stopped answering", d.Service)
	if d.UpSince != nil {
		up := time.Duration(d.DetectedAt-*d.UpSince) * time.Millisecond
		msg += fmt.Sprintf(" after %s up", up.Round(time.Second))
	}
	msg += fmt.Sprintf(" (%s)", d.ProbeError)
	took := (time.Duration(d.SettledAt-d.DetectedAt) * time.Millisecond).Round(100 * time.Millisecond)
	if d.Outcome == outcomeRecovered {
		return msg + fmt.Sprintf("; re-started, answering again after %s", took)
	}
	reason := ""
	if d.RestartError != nil {
		reason = firstLine(*d.RestartError)
	}
	return msg + fmt.Sprintf("; re-start failed after %s, left crashed: %s", took, reason)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// newServiceDownEntry wraps an outage as an outbox entry from this gateway.
// checkout is the gateway's working directory: a service has no checkout of
// its own (its start command names its script by absolute path).
func newServiceDownEntry(d serviceDown, gatewayPid int, checkout string) outboxEntry {
	return outboxEntry{
		Version:    1,
		Kind:       serviceDownKind,
		Message:    serviceDownMessage(d),
		Data:       d,
		OccurredAt: d.DetectedAt,
		Writer:     outboxWriter{Pid: gatewayPid, Checkout: checkout},
	}
}

// reportServiceDown files a settled outage. A failure to file is logged at
// error level — the gateway log is then the only record, and it says so.
func (sup *Supervisor) reportServiceDown(d serviceDown) {
	if sup.outboxDir == "" {
		slog.Error("supervised service went down and no report outbox is configured; not reported",
			"name", d.Service, "outcome", d.Outcome)
		return
	}
	checkout, err := os.Getwd()
	if err != nil {
		checkout = fmt.Sprintf("(unknown: %v)", err)
	}
	path, err := writeOutboxEntry(sup.outboxDir, newServiceDownEntry(d, os.Getpid(), checkout), time.Now())
	if err != nil {
		slog.Error("supervised service went down and its report could not be filed",
			"name", d.Service, "outcome", d.Outcome, "err", err)
		return
	}
	slog.Warn("supervised service outage reported", "name", d.Service, "outcome", d.Outcome, "entry", path)
}

// readLogTail returns the last crashTailLines lines of the file at path,
// each cut like a crash tail's, reading at most serviceLogTailMaxBytes from
// its end. A missing file is an empty tail (the service never wrote a line);
// any other failure is an error.
func readLogTail(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - serviceLogTailMaxBytes
	partial := start > 0
	if !partial {
		start = 0
	}
	buf := make([]byte, info.Size()-start)
	if _, err := f.ReadAt(buf, start); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if partial {
		// The read began mid-line: drop that partial first line.
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	return tailLines(string(buf)), nil
}

// tailLines splits text into lines and keeps the last crashTailLines, each cut
// at crashLineMaxBytes — the same bounds as a backend crash's stderr tail.
func tailLines(text string) []string {
	t := newLineTail(crashTailLines)
	if text = strings.TrimRight(text, "\n"); text != "" {
		for _, line := range strings.Split(text, "\n") {
			t.add(line)
		}
	}
	return t.lines()
}
