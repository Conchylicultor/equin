package main

import (
	"errors"
	"net"
	"reflect"
	"strconv"
	"syscall"
	"testing"
)

func TestListenAddrs(t *testing.T) {
	cases := []struct {
		in   string
		want []listenAddr
	}{
		{"loopback:9000", []listenAddr{{addr: "127.0.0.1:9000"}, {addr: "[::1]:9000", ipv6Loopback: true}}},
		{"loopback:0", []listenAddr{{addr: "127.0.0.1:0"}, {addr: "[::1]:0", ipv6Loopback: true}}},
		{":9000", []listenAddr{{addr: ":9000"}}},
		{"127.0.0.1:9000", []listenAddr{{addr: "127.0.0.1:9000"}}},
		{"[::1]:9000", []listenAddr{{addr: "[::1]:9000"}}},
		{"0.0.0.0:9000", []listenAddr{{addr: "0.0.0.0:9000"}}},
		// Not a host:port at all: passed through for net.Listen to reject loudly.
		{"loopback", []listenAddr{{addr: "loopback"}}},
	}
	for _, c := range cases {
		if got := listenAddrs(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("listenAddrs(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

// freeLoopbackPort finds a port free on 127.0.0.1 (and, by the time it is
// re-bound, almost certainly on ::1 too).
func freeLoopbackPort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return strconv.Itoa(port)
}

func hasIPv6Loopback() bool {
	l, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

func TestListenAllBindsBothLoopbacks(t *testing.T) {
	port := freeLoopbackPort(t)
	listeners, err := listenAll(listenAddrs("loopback:" + port))
	if err != nil {
		t.Fatalf("listenAll: %v", err)
	}
	defer func() {
		for _, l := range listeners {
			_ = l.Close()
		}
	}()

	want := []string{"127.0.0.1:" + port}
	if hasIPv6Loopback() {
		want = append(want, "[::1]:"+port)
	}
	var got []string
	for _, l := range listeners {
		got = append(got, l.Addr().String())
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("listeners = %v, want %v", got, want)
	}
	for _, addr := range want {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatalf("dial %s: %v", addr, err)
		}
		_ = c.Close()
	}
}

func TestListenAllIPv6InUseIsFatal(t *testing.T) {
	if !hasIPv6Loopback() {
		t.Skip("no IPv6 loopback on this host")
	}
	squatter, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = squatter.Close() }()
	port := strconv.Itoa(squatter.Addr().(*net.TCPAddr).Port)

	listeners, err := listenAll(listenAddrs("loopback:" + port))
	if err == nil {
		for _, l := range listeners {
			_ = l.Close()
		}
		t.Fatal("listenAll succeeded with [::1] squatted; want EADDRINUSE")
	}
	if !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("err = %v, want EADDRINUSE", err)
	}
	// The 127.0.0.1 listener it opened first was closed: the port is free again.
	l, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		t.Fatalf("127.0.0.1:%s still held after a failed listenAll: %v", port, err)
	}
	_ = l.Close()
}

func TestListenAllIPv4InUseIsFatal(t *testing.T) {
	squatter, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = squatter.Close() }()
	port := strconv.Itoa(squatter.Addr().(*net.TCPAddr).Port)
	if _, err := listenAll(listenAddrs("loopback:" + port)); !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("err = %v, want EADDRINUSE", err)
	}
}
