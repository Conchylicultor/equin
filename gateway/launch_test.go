package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The namespace and the socket both travel on argv: in the environment, every
// process the backend starts would inherit them. The bare --principal-stamped
// declares that this gateway stamps the principal header.
func TestBackendLaunch(t *testing.T) {
	args := backendLaunch("att-1", "/s/att-1.sock")
	if want := []string{"--namespace", "att-1", "--socket", "/s/att-1.sock", "--principal-stamped"}; !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

// Specs written during the argv transition still carry "socketTransport".
// The key is meaningless now, and a spec that has it must keep loading.
func TestLoadSpecIgnoresRetiredSocketTransport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spec.json")
	if err := os.WriteFile(path, []byte(`{"server": "/abs/server", "socketTransport": "argv"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	spec, err := loadSpec(path)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Server != "/abs/server" {
		t.Fatalf("Server = %q, want /abs/server", spec.Server)
	}
}
