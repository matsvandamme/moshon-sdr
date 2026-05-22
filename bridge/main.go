// Package main is the entry point for moshon-bridge — a small WebSocket↔rtl_tcp
// proxy that lets a browser-based SDR receiver consume IQ from a remote (or
// local) `rtl_tcp` server.
//
// Operation:
//   - HTTP server on --listen.
//   - GET /health returns 200 with version info (useful for liveness probes).
//   - GET /ws is the WebSocket endpoint. On connection it dials the configured
//     rtl_tcp host (overridable per-connection via ?target=host:port) and
//     proxies bytes in both directions.
//
// We never own the user's RF — the bridge runs on their machine. No analytics,
// no telemetry, no auth (the bridge is meant for trusted LANs / loopback).
// Origin checking is the one guardrail: only WebSocket upgrades from the
// configured Origin are accepted unless --cors-origin is "*".
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const version = "0.1.0-dev"

// Maximum size of a control frame the client may send. rtl_tcp commands are
// 5 bytes — bumping the cap to 4 KB allows headroom for any batched future
// extension without unbounding memory.
const maxClientFrameBytes = 4 * 1024

// Buffer size for the TCP→WS pipe. RTL-SDR at 2.4 MS/s × 2 bytes ≈ 4.8 MB/s.
// 64 KB ≈ 13 ms of IQ which keeps WS framing overhead reasonable.
const tcpReadBufBytes = 64 * 1024

func main() {
	listen := flag.String("listen", "127.0.0.1:9090",
		"HTTP/WebSocket listen address. Default is loopback only.")
	rtltcp := flag.String("rtltcp", "127.0.0.1:1234",
		"Default rtl_tcp server address (host:port). Per-connection override: /ws?target=host:port")
	corsOrigin := flag.String("cors-origin", "https://moshon-sdr.pages.dev",
		"Allowed WebSocket Origin. Use '*' to disable origin checking (LAN-trusted only).")
	dialTimeout := flag.Duration("dial-timeout", 5*time.Second,
		"Timeout for the upstream rtl_tcp TCP dial.")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("moshon-bridge %s\n", version)
		return
	}

	cfg := &serverConfig{
		defaultTarget: *rtltcp,
		corsOrigin:    *corsOrigin,
		dialTimeout:   *dialTimeout,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/ws", cfg.wsHandler)

	srv := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		log.Println("shutdown requested")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("moshon-bridge %s — listen=%s default-target=%s cors=%s",
		version, *listen, *rtltcp, *corsOrigin)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server: %v", err)
	}
	log.Println("bye")
}

type serverConfig struct {
	defaultTarget string
	corsOrigin    string
	dialTimeout   time.Duration
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, fmt.Sprintf(`{"name":"moshon-bridge","version":%q}`, version))
}

func (cfg *serverConfig) wsHandler(w http.ResponseWriter, r *http.Request) {
	acceptOpts := &websocket.AcceptOptions{
		// Subprotocols are unused; raw binary frames carry rtl_tcp bytes.
	}
	if cfg.corsOrigin == "*" {
		acceptOpts.InsecureSkipVerify = true
	} else {
		acceptOpts.OriginPatterns = []string{originHostPattern(cfg.corsOrigin)}
	}

	c, err := websocket.Accept(w, r, acceptOpts)
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	c.SetReadLimit(maxClientFrameBytes)
	defer c.CloseNow()

	target := r.URL.Query().Get("target")
	if target == "" {
		target = cfg.defaultTarget
	}
	if !isPlausibleTarget(target) {
		_ = c.Close(websocket.StatusPolicyViolation, "invalid target")
		return
	}

	log.Printf("ws connect from %s → dialing %s", r.RemoteAddr, target)

	tcpConn, err := net.DialTimeout("tcp", target, cfg.dialTimeout)
	if err != nil {
		log.Printf("dial %s: %v", target, err)
		_ = c.Close(websocket.StatusInternalError, fmt.Sprintf("rtl_tcp dial failed: %v", err))
		return
	}
	defer tcpConn.Close()

	// Disable Nagle so command latency stays low — IQ flows from the dongle
	// continuously anyway, so the algorithm wouldn't help.
	if tcp, ok := tcpConn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	errCh := make(chan error, 2)
	go func() { errCh <- proxyTCPToWS(ctx, tcpConn, c) }()
	go func() { errCh <- proxyWSToTCP(ctx, c, tcpConn) }()

	// First side that fails (or EOFs) ends the session.
	err = <-errCh
	cancel()
	// Drain the other side without blocking on its return.
	go func() { <-errCh }()

	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		log.Printf("ws ↔ %s ended: %v", target, err)
	} else {
		log.Printf("ws ↔ %s ended", target)
	}
}

// proxyTCPToWS reads bytes from the rtl_tcp connection and forwards them
// as binary WebSocket messages to the browser.
func proxyTCPToWS(ctx context.Context, tcp net.Conn, ws *websocket.Conn) error {
	buf := make([]byte, tcpReadBufBytes)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := tcp.Read(buf)
		if n > 0 {
			if writeErr := ws.Write(ctx, websocket.MessageBinary, buf[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			return err
		}
	}
}

// proxyWSToTCP reads rtl_tcp commands from the browser and forwards them.
// Each WS binary message is written as-is — typically a 5-byte rtl_tcp command
// frame, but we don't enforce structure here.
func proxyWSToTCP(ctx context.Context, ws *websocket.Conn, tcp net.Conn) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		msgType, data, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		if msgType != websocket.MessageBinary {
			continue
		}
		if _, err := tcp.Write(data); err != nil {
			return err
		}
	}
}

// originHostPattern extracts the host[:port] portion of a URL so it can be
// used with `websocket.AcceptOptions.OriginPatterns`, which matches hosts
// rather than full URLs.
func originHostPattern(origin string) string {
	o := strings.TrimSpace(origin)
	o = strings.TrimPrefix(o, "https://")
	o = strings.TrimPrefix(o, "http://")
	// Strip any path.
	if i := strings.IndexByte(o, '/'); i >= 0 {
		o = o[:i]
	}
	if o == "" {
		return "*"
	}
	return o
}

// isPlausibleTarget rejects obviously malformed targets without committing to
// a full URL parse. We require "host:port" and a numeric-ish port.
func isPlausibleTarget(t string) bool {
	host, port, err := net.SplitHostPort(t)
	if err != nil {
		return false
	}
	if host == "" || port == "" {
		return false
	}
	for _, ch := range port {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}
