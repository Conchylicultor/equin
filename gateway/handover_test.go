package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// TestHelperHandoverBackend is the backend the handover tests' gateway spawns
// (this test binary, re-run): /api/pid answers its pid, /api/slow answers
// after 800 ms (a request in flight across a handover), POST /api/echo its
// body, and /ws upgrades to a raw byte echo.
func TestHelperHandoverBackend(t *testing.T) {
	var socket string
	for i, a := range os.Args {
		if a == "--socket" && i+1 < len(os.Args) {
			socket = os.Args[i+1]
		}
	}
	if socket == "" {
		return
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(2)
	}
	_ = http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health/ready":
			w.WriteHeader(http.StatusOK)
		case "/api/pid":
			fmt.Fprintf(w, "%d", os.Getpid())
		case "/api/slow":
			time.Sleep(800 * time.Millisecond)
			fmt.Fprintf(w, "%d", os.Getpid())
		case "/api/echo":
			_, _ = io.Copy(w, r.Body)
		case "/ws/echo":
			hj := w.(http.Hijacker)
			c, rw, err := hj.Hijack()
			if err != nil {
				return
			}
			_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			_ = rw.Flush()
			_, _ = io.Copy(c, rw)
			_ = c.Close()
		default:
			http.NotFound(w, r)
		}
	}))
}

type keeperFixture struct {
	t      *testing.T
	port   int
	keeper *exec.Cmd
	binary string
	logDir string
	stdio  string
	exited chan struct{}
	host   string
}

// startKeeperFixture builds this gateway and runs it as a keeper — the way a
// service manager does — over one worktree whose backend is this test binary.
func startKeeperFixture(t *testing.T) *keeperFixture {
	t.Helper()
	if testing.Short() {
		t.Skip("builds and runs the gateway binary")
	}
	root := t.TempDir()
	bin := filepath.Join(root, "gateway")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = os.Environ()
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	sockets, err := os.MkdirTemp("/tmp", "gwh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockets) })
	registry := filepath.Join(root, "worktrees")
	wtDir := filepath.Join(registry, "wt")
	if err := os.MkdirAll(wtDir, 0o755); err != nil {
		t.Fatal(err)
	}
	spec, _ := json.Marshal(map[string]any{
		"server":  root,
		"command": []string{os.Args[0], "-test.run=^TestHelperHandoverBackend$", "--"},
	})
	if err := os.WriteFile(filepath.Join(wtDir, "spec.json"), spec, 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	logDir := filepath.Join(root, "logs")
	stdio := filepath.Join(root, "stdio.log")
	out, err := os.Create(stdio)
	if err != nil {
		t.Fatal(err)
	}
	k := exec.Command(bin,
		"-listen", fmt.Sprintf("127.0.0.1:%d", port),
		"-log-dir", logDir, "-log-level", "debug",
		"-registry-dir", registry, "-sockets-dir", sockets,
		"-central-routes-file", filepath.Join(root, "central-routes.json"),
		"-db-config", filepath.Join(root, "no-database.json"),
		"-report-outbox-dir", filepath.Join(root, "outbox"),
		"-pid-file", filepath.Join(root, "gateway.pid"),
		"-lock-file", filepath.Join(root, "gateway.lock"),
		"-child-env", "HOME,PATH,TMPDIR",
		"-idle-timeout", "1h",
	)
	k.Env = os.Environ()
	k.Stdout, k.Stderr = out, out
	if err := k.Start(); err != nil {
		t.Fatal(err)
	}
	f := &keeperFixture{t: t, port: port, keeper: k, binary: bin, logDir: logDir, stdio: stdio, exited: make(chan struct{}), host: fmt.Sprintf("wt.localhost:%d", port)}
	go func() { _ = k.Wait(); _ = out.Close(); close(f.exited) }()
	t.Cleanup(func() {
		_ = k.Process.Signal(syscall.SIGTERM)
		select {
		case <-f.exited:
		case <-time.After(30 * time.Second):
			_ = k.Process.Kill()
		}
		if t.Failed() {
			b, err := os.ReadFile(stdio)
			t.Logf("read stdio: %v", err)
			t.Logf("keeper stdio:\n%s", b)
			g, _ := os.ReadFile(filepath.Join(logDir, "gateway.log"))
			t.Logf("gateway.log:\n%s", g)
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := f.get("/gateway/handover"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the keeper's gateway never served")
		}
		time.Sleep(50 * time.Millisecond)
	}
	return f
}

func (f *keeperFixture) url(path string) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", f.port, path)
}

// get answers a GET on the worktree's host, and fails on any non-2xx.
func (f *keeperFixture) get(path string) (string, error) {
	req, _ := http.NewRequest(http.MethodGet, f.url(path), nil)
	req.Host = f.host
	return do(req)
}

func do(req *http.Request) (string, error) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return string(b), nil
}

func (f *keeperFixture) status() handoverStatus {
	f.t.Helper()
	body, err := f.get("/gateway/handover")
	if err != nil {
		f.t.Fatal(err)
	}
	var st handoverStatus
	if err := json.Unmarshal([]byte(body), &st); err != nil {
		f.t.Fatal(err)
	}
	return st
}

func (f *keeperFixture) handover(body string) (int, string) {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.url("/gateway/handover"), strings.NewReader(body))
	req.Host = fmt.Sprintf("localhost:%d", f.port)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// load drives the worktree until stop closes: page-less API GETs, slow GETs
// (in flight across the handover) and POSTs, each on its own keep-alive
// client. Every failure is recorded.
type loadResult struct {
	ok, failed atomic.Int64
	mu         sync.Mutex
	errs       []string
	pids       map[string]bool
}

func (f *keeperFixture) load(workers int, stop <-chan struct{}) (*loadResult, *sync.WaitGroup) {
	res := &loadResult{pids: map[string]bool{}}
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			client := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 2}}
			for n := 0; ; n++ {
				select {
				case <-stop:
					return
				default:
				}
				var req *http.Request
				switch (i + n) % 3 {
				case 0:
					req, _ = http.NewRequest(http.MethodGet, f.url("/api/pid"), nil)
				case 1:
					req, _ = http.NewRequest(http.MethodGet, f.url("/api/slow"), nil)
				default:
					req, _ = http.NewRequest(http.MethodPost, f.url("/api/echo"), strings.NewReader("hello"))
				}
				req.Host = f.host
				resp, err := client.Do(req)
				if err == nil {
					b, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					if resp.StatusCode/100 != 2 {
						err = fmt.Errorf("%s %s: %s %s", req.Method, req.URL.Path, resp.Status, b)
					} else if req.URL.Path != "/api/echo" {
						res.mu.Lock()
						res.pids[string(b)] = true
						res.mu.Unlock()
					}
				}
				if err != nil {
					res.failed.Add(1)
					res.mu.Lock()
					if len(res.errs) < 10 {
						res.errs = append(res.errs, err.Error())
					}
					res.mu.Unlock()
					continue
				}
				res.ok.Add(1)
			}
		}(i)
	}
	return res, &wg
}

// wsEcho opens a WebSocket-shaped connection through the gateway.
func (f *keeperFixture) wsEcho() (net.Conn, *bufio.Reader) {
	f.t.Helper()
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.port))
	if err != nil {
		f.t.Fatal(err)
	}
	fmt.Fprintf(c, "GET /ws/echo HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: x\r\n\r\n", f.host)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil || resp.StatusCode != http.StatusSwitchingProtocols {
		f.t.Fatalf("ws upgrade: %v %v", resp, err)
	}
	return c, br
}

// A handover under load answers every request, keeps the backend process,
// and replaces the gateway process.
func TestHandoverUnderLoadKeepsTheBackend(t *testing.T) {
	f := startKeeperFixture(t)
	backendPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	before := f.status()
	ws, wsr := f.wsEcho()
	defer ws.Close()

	stop := make(chan struct{})
	res, wg := f.load(8, stop)
	time.Sleep(500 * time.Millisecond)
	code, body := f.handover("{}")
	if code != http.StatusOK {
		t.Fatalf("handover: %d %s", code, body)
	}
	time.Sleep(1500 * time.Millisecond)
	close(stop)
	wg.Wait()

	after := f.status()
	if after.Pid == before.Pid || after.Mode != modeHandover || after.KeeperPid != before.KeeperPid {
		t.Fatalf("generation: before %+v, after %+v", before, after)
	}
	if res.failed.Load() != 0 {
		t.Fatalf("%d of %d requests failed across the handover: %v", res.failed.Load(), res.ok.Load()+res.failed.Load(), res.errs)
	}
	if len(res.pids) != 1 || !res.pids[backendPid] {
		t.Fatalf("backends seen: %v, want only %s (no cold start)", res.pids, backendPid)
	}
	// The WebSocket opened before is closed by the replaced generation (its
	// client reconnects); a new one reaches the same backend.
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := wsr.ReadByte(); err == nil {
		t.Fatal("the old generation's WebSocket is still open")
	}
	ws2, wsr2 := f.wsEcho()
	defer ws2.Close()
	fmt.Fprint(ws2, "ping\n")
	_ = ws2.SetReadDeadline(time.Now().Add(5 * time.Second))
	if line, err := wsr2.ReadString('\n'); err != nil || line != "ping\n" {
		t.Fatalf("ws echo after the handover: %q %v", line, err)
	}
	// The replaced generation exits without stopping a backend.
	deadline := time.Now().Add(10 * time.Second)
	for processAlive(before.Pid) {
		if time.Now().After(deadline) {
			t.Fatal("the replaced generation never exited")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if pid, err := f.get("/api/pid"); err != nil || pid != backendPid {
		t.Fatalf("after the old generation exited: %q %v", pid, err)
	}
	t.Logf("handover: %d requests, 0 failed, backend %s kept", res.ok.Load(), backendPid)
}

// A successor that cannot come up changes nothing: the serving generation
// keeps serving.
func TestHandoverToABrokenGatewayChangesNothing(t *testing.T) {
	f := startKeeperFixture(t)
	backendPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	before := f.status()
	code, body := f.handover(`{"binary":"/usr/bin/false"}`)
	if code != http.StatusBadGateway || !strings.Contains(body, "exited before it was ready") {
		t.Fatalf("handover to /usr/bin/false: %d %s", code, body)
	}
	if st := f.status(); st.Pid != before.Pid {
		t.Fatalf("generation changed: %+v → %+v", before, st)
	}
	if pid, err := f.get("/api/pid"); err != nil || pid != backendPid {
		t.Fatalf("after a failed handover: %q %v", pid, err)
	}
	// And it can still hand over afterwards.
	if code, body := f.handover("{}"); code != http.StatusOK {
		t.Fatalf("handover after a failed one: %d %s", code, body)
	}
}

// A gateway that dies no longer takes its backends with it: the keeper starts
// the same launch again, which adopts them; requests queue on the keeper's
// socket meanwhile instead of being refused.
func TestGatewayCrashIsRecoveredOverTheLiveBackend(t *testing.T) {
	f := startKeeperFixture(t)
	backendPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	before := f.status()
	if err := syscall.Kill(before.Pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		pid, err := f.get("/api/pid")
		if err == nil {
			if pid != backendPid {
				t.Fatalf("a new backend (%s) answered, not the adopted one (%s)", pid, backendPid)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never recovered: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if st := f.status(); st.Mode != modeRecover || st.Pid == before.Pid {
		t.Fatalf("after the crash: %+v", st)
	}
}

// Stopping the keeper stops the gateway and its backends.
func TestKeeperStopStopsEverything(t *testing.T) {
	f := startKeeperFixture(t)
	backendPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	gen := f.status().Pid
	_ = f.keeper.Process.Signal(syscall.SIGTERM)
	select {
	case <-f.exited:
	case <-time.After(30 * time.Second):
		t.Fatal("the keeper did not stop")
	}
	if code := f.keeper.ProcessState.ExitCode(); code != 0 {
		t.Fatalf("keeper exit code %d", code)
	}
	pid, _ := strconv.Atoi(backendPid)
	for _, p := range []int{pid, gen} {
		if processAlive(p) {
			t.Fatalf("pid %d still alive after the keeper stopped", p)
		}
	}
}

// A handover is refused to anything that came through a front proxy.
func TestHandoverRefusesAForwardedRequest(t *testing.T) {
	f := startKeeperFixture(t)
	req, _ := http.NewRequest(http.MethodPost, f.url("/gateway/handover"), strings.NewReader("{}"))
	req.Host = fmt.Sprintf("localhost:%d", f.port)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("forwarded handover: %d", resp.StatusCode)
	}
}

// Handovers back to back under load: each one answers every request.
func TestRepeatedHandoversUnderLoad(t *testing.T) {
	f := startKeeperFixture(t)
	backendPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	res, wg := f.load(16, stop)
	for i := range 5 {
		time.Sleep(300 * time.Millisecond)
		if code, body := f.handover("{}"); code != http.StatusOK {
			t.Fatalf("handover %d: %d %s", i, code, body)
		}
	}
	time.Sleep(1200 * time.Millisecond)
	close(stop)
	wg.Wait()
	if res.failed.Load() != 0 {
		t.Fatalf("%d of %d requests failed across 5 handovers: %v", res.failed.Load(), res.ok.Load()+res.failed.Load(), res.errs)
	}
	if len(res.pids) != 1 || !res.pids[backendPid] {
		t.Fatalf("backends seen: %v, want only %s", res.pids, backendPid)
	}
	t.Logf("5 handovers: %d requests, 0 failed", res.ok.Load())
}

// A backend hot restart and then a handover at once: the successor serves
// from the restarted backend, and the old one is drained and stopped — one
// serving backend, no failed request.
func TestHandoverRightAfterAHotRestart(t *testing.T) {
	f := startKeeperFixture(t)
	oldPid, err := f.get("/api/pid")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	res, wg := f.load(8, stop)
	req, _ := http.NewRequest(http.MethodPost, f.url("/gateway/worktrees/wt/restart"), nil)
	req.Host = fmt.Sprintf("localhost:%d", f.port)
	if _, err := do(req); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if code, body := f.handover("{}"); code != http.StatusOK {
		t.Fatalf("handover: %d %s", code, body)
	}
	time.Sleep(1500 * time.Millisecond)
	close(stop)
	wg.Wait()
	if res.failed.Load() != 0 {
		t.Fatalf("%d requests failed: %v", res.failed.Load(), res.errs)
	}
	newPid, err := f.get("/api/pid")
	if err != nil || newPid == oldPid {
		t.Fatalf("after restart+handover: %q (old %s) %v", newPid, oldPid, err)
	}
	n, _ := strconv.Atoi(oldPid)
	deadline := time.Now().Add(10 * time.Second)
	for processAlive(n) {
		if time.Now().After(deadline) {
			t.Fatalf("the restarted-away backend %d still runs", n)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
