package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/Shinyaigeek/aura/server/internal/shares"
)

// runShare implements `aura-server share <file>...`: copy each file into the
// share dir so it shows up in the mobile app's gallery. This is pure file
// copy and does NOT talk to a running server — it works whether or not
// aura-server is up, which is the point: it's a one-command way for Claude
// Code (or anyone) to hand a file back, with or without aura.
//
// The destination dir is resolved exactly like the server does (-dir flag,
// else AURA_SHARE_DIR, else ~/.aura/share) so a file shared via this command
// lands where the server is serving from.
func runShare(args []string) error {
	fs := flag.NewFlagSet("share", flag.ContinueOnError)
	dir := fs.String("dir", defaultShareDir(), "share directory (env AURA_SHARE_DIR)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	files := fs.Args()
	if len(files) == 0 {
		return errors.New("usage: aura-server share [-dir <path>] <file>...")
	}

	store, err := shares.NewStore(*dir)
	if err != nil {
		return err
	}

	var firstErr error
	for _, f := range files {
		dst, err := store.Import(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "share: %s: %v\n", f, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		fmt.Println(dst)
	}
	return firstErr
}
