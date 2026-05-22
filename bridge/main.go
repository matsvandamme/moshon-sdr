// Package main is the entry point for moshon-bridge, a small WebSocket↔rtl_tcp
// proxy that lets a browser-based SDR receiver consume a remote IQ stream
// from an `rtl_tcp` server.
//
// Real implementation lands in milestone B9. This file exists to anchor the
// Go module layout and prove the build chain.
package main

import (
	"flag"
	"log"
)

const version = "0.1.0-dev"

func main() {
	listen := flag.String("listen", ":9090", "WebSocket listen address (host:port)")
	rtltcp := flag.String("rtltcp", "127.0.0.1:1234", "rtl_tcp server address (host:port)")
	corsOrigin := flag.String("cors-origin", "https://moshon-sdr.pages.dev",
		"allowed Origin for WebSocket upgrades (use '*' to allow all, only on trusted LANs)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		log.Printf("moshon-bridge %s", version)
		return
	}

	log.Printf("moshon-bridge %s — listen=%s rtltcp=%s cors=%s",
		version, *listen, *rtltcp, *corsOrigin)
	log.Println("WebSocket proxy not yet implemented (planned: milestone B9)")
}
