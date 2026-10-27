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
