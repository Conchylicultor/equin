package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The same cases as plugins/infra/plugins/paths/plugins/data-root-layout/core/internal/data-root-layout.test.ts.
func TestHomeDataRoot(t *testing.T) {
	cases := []struct {
		name  string
		setup func(home string)
		want  string // dir name under home; "" = an error
	}{
		{"fresh home", func(string) {}, currentDataDirName},
		{"only current", func(h string) { mkdir(t, h, currentDataDirName) }, currentDataDirName},
		{"only legacy", func(h string) { mkdir(t, h, legacyDataDirName) }, legacyDataDirName},
		{"legacy links to current", func(h string) {
			mkdir(t, h, currentDataDirName)
			link(t, currentDataDirName, filepath.Join(h, legacyDataDirName))
		}, currentDataDirName},
		{"legacy links elsewhere", func(h string) {
			mkdir(t, h, "external")
			link(t, filepath.Join(h, "external"), filepath.Join(h, legacyDataDirName))
		}, legacyDataDirName},
		{"both, separate", func(h string) {
			mkdir(t, h, legacyDataDirName)
			mkdir(t, h, currentDataDirName)
		}, ""},
		{"dangling legacy link", func(h string) {
			link(t, filepath.Join(h, "gone"), filepath.Join(h, legacyDataDirName))
		}, legacyDataDirName},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			c.setup(home)
			got, err := homeDataRoot(home)
			if c.want == "" {
				if err == nil {
					t.Fatalf("want an error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if want := filepath.Join(home, c.want); got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		})
	}
}

func mkdir(t *testing.T, home, name string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(home, name), 0o755); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, target, at string) {
	t.Helper()
	if err := os.Symlink(target, at); err != nil {
		t.Fatal(err)
	}
}

// The same shapes as plugins/infra/plugins/paths/plugins/data-root-layout/core/internal/declare-data-root-sh.test.ts:
// the token every child is told must be the one paths/core would decide.
func TestHomeDataRootLayoutToken(t *testing.T) {
	cases := []struct {
		name  string
		setup func(home string)
		want  string
	}{
		{"fresh home", func(string) {}, "current"},
		{"only current", func(h string) { mkdir(t, h, currentDataDirName) }, "current"},
		{"only legacy", func(h string) { mkdir(t, h, legacyDataDirName) }, "legacy"},
		{"legacy links to current", func(h string) {
			mkdir(t, h, currentDataDirName)
			link(t, currentDataDirName, filepath.Join(h, legacyDataDirName))
		}, "current-legacy-link"},
		{"legacy links elsewhere", func(h string) {
			mkdir(t, h, "external")
			link(t, filepath.Join(h, "external"), filepath.Join(h, legacyDataDirName))
		}, "legacy"},
		{"both, separate", func(h string) {
			mkdir(t, h, legacyDataDirName)
			mkdir(t, h, currentDataDirName)
		}, ""},
		{"dangling legacy link", func(h string) {
			link(t, filepath.Join(h, "gone"), filepath.Join(h, legacyDataDirName))
		}, "legacy"},
		{"dangling legacy link beside current", func(h string) {
			mkdir(t, h, currentDataDirName)
			link(t, filepath.Join(h, "gone"), filepath.Join(h, legacyDataDirName))
		}, ""},
		{"legacy beside a current link to it", func(h string) {
			mkdir(t, h, legacyDataDirName)
			link(t, legacyDataDirName, filepath.Join(h, currentDataDirName))
		}, ""},
		{"legacy beside a dangling current link", func(h string) {
			mkdir(t, h, legacyDataDirName)
			link(t, filepath.Join(h, "gone"), filepath.Join(h, currentDataDirName))
		}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			c.setup(home)
			if got := homeDataRootLayoutToken(home); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
