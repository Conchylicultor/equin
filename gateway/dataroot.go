package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// The data root's dir names under the home dir. The legacy one mirrors
// LEGACY_IDS.dataDirName (framework/product-name); the current one is
// "." + PRODUCT_NAME.
const (
	currentDataDirName = ".equin"
	legacyDataDirName  = ".singularity"
)

// homeDataRoot is the Go twin of paths/core's readHomeDataRootLayout
// (data-root-layout.ts), with the same cases (dataroot_test.go): an install
// keeps its legacy root until `./equin data-dir migrate` moves it.
//
//   - legacy absent                         → current (fresh, or migrated)
//   - legacy a link resolving to current    → current (a migration that kept its link)
//   - legacy anything else, current absent  → legacy (not yet migrated)
//   - legacy anything else, current present → error (two roots; a human decides)
func homeDataRoot(home string) (string, error) {
	current := filepath.Join(home, currentDataDirName)
	legacy := filepath.Join(home, legacyDataDirName)

	if _, err := os.Lstat(legacy); errors.Is(err, fs.ErrNotExist) {
		return current, nil
	} else if err != nil {
		return "", err
	}
	legacyResolved, legacyErr := filepath.EvalSymlinks(legacy)
	currentResolved, currentErr := filepath.EvalSymlinks(current)
	currentExists := currentErr == nil
	if currentErr != nil && !errors.Is(currentErr, fs.ErrNotExist) {
		return "", currentErr
	}
	if legacyErr != nil && !errors.Is(legacyErr, fs.ErrNotExist) {
		return "", legacyErr
	}
	if legacyErr == nil && currentExists && legacyResolved == currentResolved {
		return current, nil
	}
	if currentExists {
		return "", fmt.Errorf("two data roots: %s and %s both exist and are not the same directory; an install not yet migrated keeps its data in %s, and %s is what `./equin data-dir migrate` moves it to — look at what %s holds and remove or move one aside", legacy, current, legacy, current, current)
	}
	return legacy, nil
}

// homeDataRootLayoutToken is the decided home layout as it travels to every
// child in EQUIN_DATA_ROOT_LAYOUT (paths/core HOME_LAYOUT_TOKENS): "current",
// "current-legacy-link" or "legacy", or "" for two separate roots, which no
// child is told about — its own entry point decides and throws the split.
// Case for case paths/core decideDataRootLayout, which is stricter than
// homeDataRoot about one shape: the legacy root beside a current LINK to it is
// a split there (dataroot_test.go holds both).
func homeDataRootLayoutToken(home string) string {
	current := filepath.Join(home, currentDataDirName)
	legacy := filepath.Join(home, legacyDataDirName)
	legacyInfo, err := os.Lstat(legacy)
	if errors.Is(err, fs.ErrNotExist) {
		return "current"
	}
	if err != nil {
		return "" // unreadable: the child's own decision reports it
	}
	if legacyInfo.Mode()&fs.ModeSymlink != 0 {
		l, lerr := filepath.EvalSymlinks(legacy)
		c, cerr := filepath.EvalSymlinks(current)
		if lerr == nil && cerr == nil && l == c {
			return "current-legacy-link"
		}
	}
	_, err = os.Lstat(current)
	if errors.Is(err, fs.ErrNotExist) {
		return "legacy"
	}
	return "" // a split, or unreadable
}

// dataRootLayoutEnv is the entry the gateway adds to every child's base
// environment: the layout it decided, so a backend, a supervised service and
// everything they start inherit a decided root (infra/paths CLAUDE.md, § The
// data root). None when EQUIN_DIR names the root, or for a split.
func dataRootLayoutEnv() []string {
	if readEnv("DIR") != "" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil // dataRoot() has already refused to start without one
	}
	token := homeDataRootLayoutToken(home)
	if token == "" {
		return nil
	}
	return []string{envPrefix + "DATA_ROOT_LAYOUT=" + token}
}
