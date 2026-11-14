package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDataRootLockRefusesASecondHolderAndNamesTheFirst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locks", "gateway", "gateway.lock")
	first, err := acquireDataRootLock(path)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer first.Close()

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want := fmt.Sprintf("%d\n", os.Getpid()); string(got) != want {
		t.Fatalf("lock file = %q, want %q", got, want)
	}

	// flock locks belong to the open file description, so a second open in
	// this process contends exactly as another process would.
	second, err := acquireDataRootLock(path)
	if err == nil {
		second.Close()
		t.Fatal("second acquire succeeded while the first holds the lock")
	}
	var held *dataRootHeldError
	if !errors.As(err, &held) {
		t.Fatalf("second acquire: want dataRootHeldError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("pid %d", os.Getpid())) {
		t.Fatalf("refusal does not name the holder: %v", err)
	}
	// The refusal must not have touched the holder's record.
	if again, _ := os.ReadFile(path); string(again) != string(got) {
		t.Fatalf("refused acquire rewrote the lock file: %q", again)
	}
}

func TestDataRootLockIsFreeOnceTheHolderCloses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.lock")
	first, err := acquireDataRootLock(path)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	first.Close()
	second, err := acquireDataRootLock(path)
	if err != nil {
		t.Fatalf("acquire after the holder closed: %v", err)
	}
	second.Close()
}
