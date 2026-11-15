package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"syscall"
	"time"
)

const ctrlWriteTimeout = 5 * time.Second

// ─── the keeper ⇄ generation control socket ───────────────────
//
// One AF_UNIX stream socketpair per generation, the generation's end inherited
// as the fd its -keeper-fd flag names. Each message is a 4-byte big-endian
// length, then that many bytes of JSON (keeperMsg), written by ONE sendmsg —
// with the file descriptors it carries (SCM_RIGHTS) attached to it. The
// kernel delivers ancillary data with the first byte of the data it was sent
// with, so the reader takes the fds from the recvmsg that reads the length.

// keeperProtocol is the version of this protocol. The keeper sends its own in
// a generation's init; a generation refuses a keeper speaking another one
// (it exits before ready, so a handover onto it fails and the old generation
// keeps serving — the machine needs a restart of the keeper itself).
const keeperProtocol = 1

// keeperFdFlag is the flag the keeper adds to a generation's argv. A gateway
// started WITHOUT it is a keeper (main.go).
const keeperFdFlag = "-keeper-fd"

// Message types.
const (
	// generation → keeper
	msgSpawn     = "spawn"     // Spawn: start a long-lived child
	msgListeners = "listeners" // Listeners + fds: the first generation's listening sockets
	msgReady     = "ready"     // the generation serves
	msgHandover  = "handover"  // Launch + State: replace me
	// keeper → generation
	msgInit            = "init"             // Init (+ fds: listeners, then children's output read ends)
	msgSpawned         = "spawned"          // ID, Pid or Err (+ fds: the child's output read ends)
	msgExited          = "exited"           // Pid, Status
	msgHandoverResult  = "handover-result"  // Err, Pid (the successor's)
	msgPredecessorGone = "predecessor-gone" // the generation this one replaced has exited
	msgFds             = "fds"              // a batch of an init's descriptors
)

type keeperMsg struct {
	T  string `json:"t"`
	ID uint64 `json:"id,omitempty"`

	Spawn     *spawnSpec      `json:"spawn,omitempty"`
	Listeners []listenerInfo  `json:"listeners,omitempty"`
	Launch    *launchRequest  `json:"launch,omitempty"`
	State     json.RawMessage `json:"state,omitempty"`
	Init      *generationInit `json:"init,omitempty"`

	Pid    int          `json:"pid,omitempty"`
	Err    string       `json:"err,omitempty"`
	Status *childStatus `json:"status,omitempty"`
	// Fds names, in order, what the attached descriptors are (for a spawned
	// reply: "stdout" / "stderr").
	Fds []string `json:"fds,omitempty"`
}

// listenerInfo is one listening socket: the address it is bound to, and in an
// init its index in the descriptors sent after it (msgFds).
type listenerInfo struct {
	Addr string `json:"addr"`
	Fd   int    `json:"fd"`
}

// launchRequest is what a handover runs: an empty field keeps the running
// generation's.
type launchRequest struct {
	Binary string   `json:"binary,omitempty"`
	Args   []string `json:"args,omitempty"`
	Env    []string `json:"env,omitempty"`
	Dir    string   `json:"dir,omitempty"`
}

// launch is a generation's full launch.
type launch struct {
	Binary string   `json:"binary"`
	Args   []string `json:"args"`
	Env    []string `json:"-"` // never sent back out (it holds secrets)
	Dir    string   `json:"dir"`
}

// generationMode: how a generation came to be.
type generationMode string

const (
	// modeFresh: the keeper's first generation — nothing to adopt; it binds
	// the listeners itself and hands them to the keeper.
	modeFresh generationMode = "fresh"
	// modeHandover: started to replace a serving generation, which sent its
	// state: adopt the listeners, the children and that state.
	modeHandover generationMode = "handover"
	// modeRecover: started after a generation died — adopt the listeners and
	// the children; there is no state (re-probe every backend).
	modeRecover generationMode = "recover"
)

type generationInit struct {
	Protocol  int            `json:"protocol"`
	Mode      generationMode `json:"mode"`
	KeeperPid int            `json:"keeperPid"`
	// SpawnedAt: when the keeper started this generation (Unix ms) — how
	// long its own process start took is the first thing its log says.
	SpawnedAt int64           `json:"spawnedAt,omitempty"`
	Launch    launch          `json:"launch"`
	Listeners []listenerInfo  `json:"listeners,omitempty"`
	Children  []adoptChild    `json:"children,omitempty"`
	State     json.RawMessage `json:"state,omitempty"`
	// Fds is how many descriptors follow the init, in msgFds batches: the
	// listeners and the children's output read ends, indexed by the Fd /
	// StdoutFd / StderrFd fields (-1: none).
	Fds int `json:"fds"`
	// Predecessor: a generation still draining requests it accepted; the new
	// one stops no backend until predecessor-gone (it may still proxy to one).
	Predecessor bool `json:"predecessor,omitempty"`
}

// adoptChild is one live child handed to a new generation: its pid, its tag,
// and the indexes of its output read ends among the init's descriptors (-1:
// none).
type adoptChild struct {
	Pid      int             `json:"pid"`
	Tag      json.RawMessage `json:"tag,omitempty"`
	StdoutFd int             `json:"stdoutFd"`
	StderrFd int             `json:"stderrFd"`
}

// ctrlConn is one end of a control socket: framed writes (serialized) and a
// framed read loop.
type ctrlConn struct {
	c   *net.UnixConn
	wmu sync.Mutex
}

func newCtrlConn(f *os.File) (*ctrlConn, error) {
	fc, err := net.FileConn(f)
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	uc, ok := fc.(*net.UnixConn)
	if !ok {
		_ = fc.Close()
		return nil, fmt.Errorf("control fd is a %T, not a unix socket", fc)
	}
	return &ctrlConn{c: uc}, nil
}

// maxFdsPerMsg bounds the descriptors one message may carry; an init's are
// sent in batches of this size (msgFds) after it.
const maxFdsPerMsg = 32

// rawFd is f's descriptor WITHOUT os.File.Fd(), which puts the descriptor in
// blocking mode — a flag of the open file shared by every copy of it, so it
// would turn a serving generation's listening socket blocking (its accept
// then holds a thread and its Close hangs until the next connection).
func rawFd(f *os.File) (int, error) {
	sc, err := f.SyscallConn()
	if err != nil {
		return 0, err
	}
	var fd int
	if err := sc.Control(func(u uintptr) { fd = int(u) }); err != nil {
		return 0, err
	}
	return fd, nil
}

func (k *ctrlConn) send(m keeperMsg, files ...*os.File) error {
	body, err := json.Marshal(m)
	if err != nil {
		return err
	}
	frame := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	var oob []byte
	if len(files) > 0 {
		fds := make([]int, len(files))
		for i, f := range files {
			fd, err := rawFd(f)
			if err != nil {
				return err
			}
			fds[i] = fd
		}
		oob = syscall.UnixRights(fds...)
	}
	k.wmu.Lock()
	defer k.wmu.Unlock()
	// Bounded: the keeper sends under its own lock, and a peer that stopped
	// reading must not wedge it.
	_ = k.c.SetWriteDeadline(time.Now().Add(ctrlWriteTimeout))
	n, _, err := k.c.WriteMsgUnix(frame, oob, nil)
	if err != nil {
		return err
	}
	if n < len(frame) {
		// The descriptors went with the first part; the rest is plain bytes.
		_, err = k.c.Write(frame[n:])
	}
	return err
}

// recv reads one message and the descriptors attached to it.
func (k *ctrlConn) recv() (keeperMsg, []*os.File, error) {
	var hdr [4]byte
	oob := make([]byte, syscall.CmsgSpace(maxFdsPerMsg*4))
	n, oobn, _, _, err := k.c.ReadMsgUnix(hdr[:], oob)
	if err != nil {
		return keeperMsg{}, nil, err
	}
	if n == 0 {
		return keeperMsg{}, nil, io.EOF
	}
	files, ferr := parseRights(oob[:oobn])
	if n < 4 {
		if _, err := io.ReadFull(k.c, hdr[n:]); err != nil {
			closeFiles(files...)
			return keeperMsg{}, nil, err
		}
	}
	if ferr != nil {
		closeFiles(files...)
		return keeperMsg{}, nil, ferr
	}
	size := binary.BigEndian.Uint32(hdr[:])
	if size > 64<<20 {
		closeFiles(files...)
		return keeperMsg{}, nil, fmt.Errorf("control message of %d bytes", size)
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(k.c, body); err != nil {
		closeFiles(files...)
		return keeperMsg{}, nil, err
	}
	var m keeperMsg
	if err := json.Unmarshal(body, &m); err != nil {
		closeFiles(files...)
		return keeperMsg{}, nil, fmt.Errorf("control message: %w", err)
	}
	return m, files, nil
}

func parseRights(oob []byte) ([]*os.File, error) {
	if len(oob) == 0 {
		return nil, nil
	}
	msgs, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return nil, err
	}
	var files []*os.File
	for _, cm := range msgs {
		fds, err := syscall.ParseUnixRights(&cm)
		if err != nil {
			closeFiles(files...)
			return nil, err
		}
		for _, fd := range fds {
			syscall.CloseOnExec(fd)
			files = append(files, os.NewFile(uintptr(fd), "keeper-fd"))
		}
	}
	return files, nil
}

func (k *ctrlConn) close() { _ = k.c.Close() }

// socketPair makes a connected AF_UNIX stream pair: one end for this process,
// one to hand to a child as an inherited fd.
func socketPair() (mine *os.File, theirs *os.File, err error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, err
	}
	syscall.CloseOnExec(fds[0])
	syscall.CloseOnExec(fds[1])
	return os.NewFile(uintptr(fds[0]), "keeper-ctrl"), os.NewFile(uintptr(fds[1]), "keeper-ctrl-child"), nil
}

var errKeeperGone = errors.New("the keeper closed the control socket")
