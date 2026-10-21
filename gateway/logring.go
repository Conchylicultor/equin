package main

import (
	"strings"
	"sync"
)

// logEntry mirrors LogEntryWire in plugins/logs/shared/protocol.ts so the
// frontend can render gateway-sourced logs with the same component.
type logEntry struct {
	Seq         uint64 `json:"seq"`
	Line        string `json:"line"`
	Stream      string `json:"stream"` // "stdout" | "stderr"
	TimestampMs int64  `json:"timestamp"`
}

// logRing is a fixed-capacity ring buffer of backend log lines with pub/sub.
// Safe for concurrent use. Entries survive backend respawns — the ring is
// owned by the Worktree, not the process.
type logRing struct {
	mu       sync.Mutex
	capacity int
	buf      []logEntry
	head     int // index of the oldest entry when full
	size     int
	nextSeq  uint64
	subs     map[int]chan logEntry
	nextSub  int
}

func newLogRing(capacity int) *logRing {
	if capacity <= 0 {
		capacity = 1000
	}
	return &logRing{
		capacity: capacity,
		buf:      make([]logEntry, capacity),
		subs:     make(map[int]chan logEntry),
	}
}

// Append records a new line and fans it out to live subscribers. Slow
// subscribers drop entries rather than blocking the producer.
func (r *logRing) Append(stream, line string, timestampMs int64) {
	r.mu.Lock()
	r.nextSeq++
	e := logEntry{
		Seq:         r.nextSeq,
		Line:        line,
		Stream:      stream,
		TimestampMs: timestampMs,
	}
	if r.size < r.capacity {
		r.buf[(r.head+r.size)%r.capacity] = e
		r.size++
	} else {
		r.buf[r.head] = e
		r.head = (r.head + 1) % r.capacity
	}
	subs := make([]chan logEntry, 0, len(r.subs))
	for _, ch := range r.subs {
		subs = append(subs, ch)
	}
	r.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- e:
		default:
			// Slow subscriber — drop rather than block the producer.
		}
	}
}

// Subscribe returns a snapshot of current entries and a channel that receives
// future entries. Call unsub when done.
func (r *logRing) Subscribe() (snapshot []logEntry, ch <-chan logEntry, unsub func()) {
	r.mu.Lock()
	defer r.mu.Unlock()

	snap := make([]logEntry, r.size)
	for i := 0; i < r.size; i++ {
		snap[i] = r.buf[(r.head+i)%r.capacity]
	}

	c := make(chan logEntry, 64)
	id := r.nextSub
	r.nextSub++
	r.subs[id] = c

	return snap, c, func() {
		r.mu.Lock()
		if sub, ok := r.subs[id]; ok {
			delete(r.subs, id)
			close(sub)
		}
		r.mu.Unlock()
	}
}

// Tail returns up to the last n entries whose Stream has the given prefix and
// that were appended at or after sinceMs, in chronological order. Used to
// surface a backend that died during boot: its own last words, not an earlier
// boot's (the ring outlives respawns).
func (r *logRing) Tail(n int, streamPrefix string, sinceMs int64) []logEntry {
	r.mu.Lock()
	defer r.mu.Unlock()

	matches := make([]logEntry, 0, r.size)
	for i := 0; i < r.size; i++ {
		e := r.buf[(r.head+i)%r.capacity]
		if strings.HasPrefix(e.Stream, streamPrefix) && e.TimestampMs >= sinceMs {
			matches = append(matches, e)
		}
	}
	if n < len(matches) {
		matches = matches[len(matches)-n:]
	}
	return matches
}
