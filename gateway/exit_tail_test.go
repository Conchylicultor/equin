package main

import (
	"errors"
	"strings"
	"testing"
)

func TestTailKeepsOnlyThisBootsStderr(t *testing.T) {
	r := newLogRing(10)
	r.Append("stderr", "an earlier boot's error", 100)
	r.Append("stdout", "[migrate] applying x (expand)", 200)
	r.Append("stderr", `error: column "w" already exists`, 201)
	got := r.Tail(5, "stderr", 200)
	if len(got) != 1 || got[0].Line != `error: column "w" already exists` {
		t.Fatalf("tail = %+v, want only this boot's stderr line", got)
	}
}

func TestWithStderrTailKeepsTheSentinel(t *testing.T) {
	err := withStderrTail(errExitedBeforeReady, []logEntry{{Line: "boom", Stream: "stderr"}})
	if !errors.Is(err, errExitedBeforeReady) {
		t.Fatal("wrapped error lost errExitedBeforeReady")
	}
	if !strings.Contains(err.Error(), "exited before ready") || !strings.Contains(err.Error(), "  boom") {
		t.Fatalf("message = %q", err.Error())
	}
	if !strings.Contains(withStderrTail(errExitedBeforeReady, nil).Error(), "nothing to stderr") {
		t.Fatal("an empty tail must say so")
	}
}
