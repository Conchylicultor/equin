package main

import (
	"bufio"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// A panic in a request handler used to be caught by net/http's own recover:
// one `http: panic serving …` line through the server's ErrorLog, the
// connection closed, and nothing else. On 2026-11-08 18:21–18:32 that line was
// written 240+ times (a nil backend dereferenced on every request to main) and
// nothing filed a report — main, which drains reports, was the thing down.
//
// Now Proxy.ServeHTTP recovers first: the request gets a 500 naming the panic,
// the gateway log gets it at error with its stack, and it is filed as a
// `gateway-panic` entry in the report outbox (the backend-crash writer), which
// main drains once it is up again — the outbox outlives the outage.
//
// A storm is coalesced per panic site, not per request: the first panic at a
// site is filed at once, and the ones after it within panicReportWindow are
// counted and filed as one entry when the window closes. A site that keeps
// panicking files at most two entries a window, whatever the request rate.

// gatewayPanicKind is the report kind. Declared by
// plugins/debug/plugins/gateway-panic (core/kind.ts), which owns the payload's
// schema; testdata/gateway-panic-entry.json pins this writer to it (both
// sides' tests read that one file).
const gatewayPanicKind = "gateway-panic"

// panicReportWindow is how long a site's later panics are counted before they
// are filed as one entry.
const panicReportWindow = time.Minute

// panicStackLines bounds the stack an entry carries (crashTailLines lines of
// at most crashLineMaxBytes, the backend-crash tail's bounds).
const panicStackLines = crashTailLines

// gatewayPanic is the `gateway-panic` payload.
type gatewayPanic struct {
	// Site is the function the panic was raised in (the frame below the
	// runtime's panic machinery), e.g. "equin/gateway.(*backend).incHTTP" — the
	// report's fingerprint.
	Site string `json:"site"`
	// Value is the recovered value, as text.
	Value string `json:"value"`
	// Stack is the panicking goroutine's stack, oldest call last (Go's
	// order), bounded.
	Stack []string `json:"stack"`
	// The request it was serving (the latest one, for a coalesced entry).
	Method string `json:"method"`
	Host   string `json:"host"`
	Path   string `json:"path"`
	// Count is how many panics at this site the entry covers; FirstAt and
	// LastAt (epoch ms) when the first and last of them happened.
	Count   int   `json:"count"`
	FirstAt int64 `json:"firstAt"`
	LastAt  int64 `json:"lastAt"`
}

func gatewayPanicMessage(p gatewayPanic) string {
	msg := fmt.Sprintf("gateway handler panicked in %s serving %s %s%s: %s", p.Site, p.Method, p.Host, p.Path, p.Value)
	if p.Count > 1 {
		msg += fmt.Sprintf(" (%d times)", p.Count)
	}
	return msg
}

func newGatewayPanicEntry(p gatewayPanic, gatewayPid int, checkout string) outboxEntry {
	return outboxEntry{
		Version:    1,
		Kind:       gatewayPanicKind,
		Message:    gatewayPanicMessage(p),
		Data:       p,
		OccurredAt: p.LastAt,
		Writer:     outboxWriter{Pid: gatewayPid, Checkout: checkout},
	}
}

// panicReporter files handler panics into the report outbox, coalesced per
// site (see the top of this file).
type panicReporter struct {
	outbox string
	window time.Duration
	now    func() time.Time

	mu sync.Mutex
	// open holds every site whose window is open: the panics after the one
	// that opened it, not yet filed (count 0 while there are none).
	open map[string]*gatewayPanic
}

func newPanicReporter(outbox string, window time.Duration) *panicReporter {
	return &panicReporter{outbox: outbox, window: window, now: time.Now, open: map[string]*gatewayPanic{}}
}

// startedWriter is the response writer every handler below Proxy.ServeHTTP
// writes through: it records whether the response has started (a header or
// body byte written, or the connection hijacked), so a panic after that point
// aborts the response rather than appending a 500 to a body already sent. It
// keeps the interfaces the handlers assert (Flusher for the log stream,
// Hijacker for WebSockets) and unwraps for http.ResponseController.
type startedWriter struct {
	http.ResponseWriter
	started bool
}

func (sw *startedWriter) WriteHeader(code int) {
	sw.started = true
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *startedWriter) Write(b []byte) (int, error) {
	sw.started = true
	return sw.ResponseWriter.Write(b)
}

func (sw *startedWriter) Flush() {
	sw.started = true
	if f, ok := sw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (sw *startedWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := sw.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("the response writer does not support hijacking")
	}
	sw.started = true
	return h.Hijack()
}

func (sw *startedWriter) Unwrap() http.ResponseWriter { return sw.ResponseWriter }

// recoverHandlerPanic is deferred first thing in Proxy.ServeHTTP. It lets
// http.ErrAbortHandler through (net/http's own way to abort a response
// quietly — the reverse proxy uses it), and turns any other panic into an
// error line and a report, answered with a 500 — or, once the response has
// started, by aborting it (http.ErrAbortHandler), so the client sees a cut
// response, never a complete one with the error appended.
func (pr *panicReporter) recoverHandlerPanic(w *startedWriter, r *http.Request) {
	v := recover()
	if v == nil {
		return
	}
	if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
		panic(v)
	}
	p := gatewayPanic{
		Site:   panicSite(),
		Value:  cutLine(fmt.Sprint(v)),
		Stack:  stackLines(debug.Stack()),
		Method: r.Method,
		Host:   r.Host,
		Path:   r.URL.Path,
		Count:  1,
	}
	slog.Error("gateway handler panicked", "site", p.Site, "value", p.Value,
		"method", p.Method, "host", p.Host, "path", p.Path, "stack", strings.Join(p.Stack, "\n"))
	pr.record(p)
	if w.started {
		panic(http.ErrAbortHandler)
	}
	http.Error(w, "gateway handler panicked: "+p.Value, http.StatusInternalServerError)
}

// record files p at once when it opens its site's window, else counts it into
// the entry the window's close files.
func (pr *panicReporter) record(p gatewayPanic) {
	at := pr.now().UnixMilli()
	p.FirstAt, p.LastAt = at, at
	pr.mu.Lock()
	if pending, open := pr.open[p.Site]; open {
		first := pending.FirstAt
		if pending.Count == 0 {
			first = at
		}
		count := pending.Count + 1
		*pending = p
		pending.Count, pending.FirstAt = count, first
		pr.mu.Unlock()
		return
	}
	pr.open[p.Site] = &gatewayPanic{Site: p.Site}
	pr.mu.Unlock()
	pr.file(p)
	time.AfterFunc(pr.window, func() { pr.closeWindow(p.Site) })
}

// closeWindow files what a site's window counted, if anything.
func (pr *panicReporter) closeWindow(site string) {
	pr.mu.Lock()
	pending := pr.open[site]
	delete(pr.open, site)
	pr.mu.Unlock()
	if pending != nil && pending.Count > 0 {
		pr.file(*pending)
	}
}

func (pr *panicReporter) file(p gatewayPanic) {
	if pr.outbox == "" {
		slog.Error("gateway handler panicked and no report outbox is configured; not reported",
			"site", p.Site, "count", p.Count)
		return
	}
	// The writer's checkout names it in the drain's log lines; the gateway
	// runs from a built binary, not a checkout, so it names that.
	checkout, err := os.Executable()
	if err != nil {
		checkout = "gateway"
	}
	path, err := writeOutboxEntry(pr.outbox, newGatewayPanicEntry(p, os.Getpid(), checkout), pr.now())
	if err != nil {
		slog.Error("gateway handler panicked and its report could not be filed",
			"site", p.Site, "count", p.Count, "err", err)
		return
	}
	slog.Warn("gateway handler panic reported", "site", p.Site, "count", p.Count, "entry", path)
}

// panicSite names the function a panic was raised in: the first frame of the
// recovering goroutine's stack below the runtime's panic machinery (gopanic,
// and sigpanic for a fault such as a nil dereference). Called from the
// deferred recover, so the panicking frames are still on the stack.
func panicSite() string {
	pcs := make([]uintptr, 64)
	n := runtime.Callers(1, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	seenPanic := false
	for {
		f, more := frames.Next()
		if strings.HasPrefix(f.Function, "runtime.") {
			if f.Function == "runtime.gopanic" || f.Function == "runtime.sigpanic" {
				seenPanic = true
			}
		} else if seenPanic {
			return f.Function
		}
		if !more {
			return "unknown"
		}
	}
}

// stackLines is a stack dump as bounded lines, from the panic down: the
// goroutine header, then the frames below the `panic(…)` frame (the
// recover's own frames above it — debug.Stack, recoverHandlerPanic — say
// nothing about the panic).
func stackLines(stack []byte) []string {
	lines := strings.Split(strings.TrimRight(string(stack), "\n"), "\n")
	for i, l := range lines {
		if i > 0 && strings.HasPrefix(l, "panic(") {
			lines = append(lines[:1:1], lines[i:]...)
			break
		}
	}
	if len(lines) > panicStackLines {
		lines = lines[:panicStackLines]
	}
	for i, l := range lines {
		lines[i] = cutLine(l)
	}
	return lines
}
