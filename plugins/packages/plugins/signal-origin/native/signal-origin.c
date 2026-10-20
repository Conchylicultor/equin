/*
 * signal-origin — an SA_SIGINFO tap that records WHO sent a fatal signal.
 *
 * `process.on("SIGTERM")` tells you a signal arrived and nothing else. The
 * kernel *does* know the sender (`siginfo_t.si_pid`), but no Node/Bun API
 * surfaces it, and on darwin there is no `sigwaitinfo`/`sigtimedwait` and
 * kqueue's EVFILT_SIGNAL carries no sender — so an SA_SIGINFO handler is the
 * only route. The gateway's cgo `sigterm_darwin.go` (since removed: the gateway
 * is pure Go) did the same thing; this is that, reachable from a Bun process,
 * with the ancestry walk added and the SIG_DFL swallow fixed (see `so_chain`).
 *
 * THE BOUNDARY: this file owns the struct AND its serialization. `so_snapshot`
 * runs in NORMAL context (never in-handler), so it may format freely, and the
 * caller across the FFI line sees only `char*` + `int`. Consequently no
 * `siginfo_t` byte offset ever appears in TypeScript and the darwin/linux
 * layout difference is invisible above the FFI line. `so_layout_version` fails
 * the arm if a stale cached dylib is ever paired with newer TS.
 *
 * ASYNC-SIGNAL-SAFETY CONTRACT (`so_handler` and everything it calls):
 *   - static-BSS stores only. No malloc, no free, no locks, no stdio, no JS.
 *   - bounded syscalls only, budget ~10: getppid, 2x clock_gettime,
 *     <=8 proc_pidinfo / open+fstat+read+close, 1 proc_pidpath / readlink.
 *   - errno saved and restored around the whole body.
 *   - string handling is hand-rolled and bounded (no strlen/strcpy/snprintf).
 * Nothing may be added here that allocates or takes a lock. In particular do
 * NOT add KERN_PROCARGS2 argv capture — it is a sysctl round-trip with a
 * caller-sized buffer, well outside this budget.
 *
 * WHY THE ANCESTRY IS WALKED IN THE HANDLER, not afterwards: the `/bin/kill`
 * that sent the signal is usually reaped within milliseconds. By the time any
 * JS runs, `si_pid` is frequently a dead pid that resolves to nothing. Walking
 * it here is the whole reason this answers "who killed my build".
 */

#if !defined(__APPLE__)
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/proc_info.h>
#endif

/*
 * Bumped whenever the JSON `so_snapshot` emits changes shape. The TS side
 * compares it against its own expectation and refuses to arm on a mismatch, so
 * a stale content-addressed dylib left in the cache can never be read with the
 * wrong parser.
 */
#define SO_LAYOUT_VERSION 1u

/* NSIG is 32 on darwin and 65 on linux; 64 covers both, indexed by signo. */
#define SO_MAX_SIGNALS 64
#define SO_ANCESTRY_MAX 8
/* darwin MAXCOMLEN is 16 and `pbsi_comm` is NOT guaranteed NUL-terminated;
 * linux `/proc/<pid>/stat` comm is <=16 too. 32 leaves room and a terminator. */
#define SO_COMM_MAX 32
#define SO_PATH_MAX 4096

typedef struct {
    int32_t pid;
    int32_t ppid;
    int32_t uid;
    char comm[SO_COMM_MAX];
} so_proc_t;

/* The plain payload, deliberately free of atomics so the reader can memcpy it
 * wholesale under the seqlock without copying atomic objects. */
typedef struct {
    int32_t signo;
    /* RAW si_code. Never compared against SI_USER: darwin's <sys/signal.h>
     * declares SI_USER == 0x10001 while XNU actually delivers 1, so any such
     * comparison is wrong on the platform whose header it came from. The
     * portable discriminator is sender_pid != 0. Kept only as a breadcrumb. */
    int32_t si_code;
    int32_t sender_pid;
    int32_t sender_uid;
    /* getppid() AT SIGNAL TIME. By the time an exit hook runs, a dying parent
     * may already have been reparented to 1, so this cannot be read later. */
    int32_t self_ppid;
    int32_t ancestry_len;
    /* WHY the walk stopped: 0 = it reached the root (or the 8-level cap),
     * otherwise the errno that ended it — ESRCH above all, meaning the sender
     * was already reaped by its own parent before this process was scheduled to
     * run the handler. Without this an empty `ancestry` would be an absorbable
     * failure: indistinguishable from "the sender genuinely had no forebears". */
    int32_t ancestry_errno;
    int64_t wall_ns;
    int64_t mono_ns;
    so_proc_t ancestry[SO_ANCESTRY_MAX];
    char sender_path[SO_PATH_MAX];
} so_payload_t;

typedef struct {
    /* Seqlock: odd while the handler is writing. A reader that sees an odd
     * value, or a different value before and after its copy, retries — so it
     * can never observe a torn slot, and a second signal arriving mid-read is
     * detectable rather than silently blended. */
    _Atomic uint32_t seq;
    /* Total deliveries recorded in this slot. 0 means "nothing ever arrived",
     * which is how the reader distinguishes an untouched slot from one whose
     * seq happens to be 0. */
    _Atomic uint32_t hits;
    so_payload_t p;
} so_slot_t;

/* All static BSS: zero-initialized by the loader, never allocated. */
static so_slot_t g_slots[SO_MAX_SIGNALS];
static struct sigaction g_prev[SO_MAX_SIGNALS];
static _Atomic int g_armed[SO_MAX_SIGNALS];

/* ---------------------------------------------------------------- helpers */

/* Bounded copy with guaranteed termination. `src` need not be NUL-terminated
 * (darwin's pbsi_comm is a fixed char[16] that may fill the field exactly). */
static void so_copy_bounded(char *dst, size_t cap, const char *src, size_t src_len)
{
    size_t i = 0;
    if (cap == 0) {
        return;
    }
    while (i < src_len && i + 1 < cap && src[i] != '\0') {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

#if !defined(__APPLE__)
/* Append the decimal form of `v` at `*off` in `dst`. Hand-rolled: snprintf is
 * not async-signal-safe, and this runs in the handler to build /proc paths. */
static void so_append_u32(char *dst, size_t cap, size_t *off, uint32_t v)
{
    char tmp[12];
    int n = 0;
    if (v == 0) {
        tmp[n++] = '0';
    }
    while (v > 0 && n < (int)sizeof(tmp)) {
        tmp[n++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (n > 0 && *off + 1 < cap) {
        dst[(*off)++] = tmp[--n];
    }
    dst[*off] = '\0';
}

static void so_proc_path(char *dst, size_t cap, int32_t pid, const char *leaf)
{
    size_t off = 0;
    const char *pre = "/proc/";
    for (const char *c = pre; *c && off + 1 < cap; c++) {
        dst[off++] = *c;
    }
    dst[off] = '\0';
    so_append_u32(dst, cap, &off, (uint32_t)pid);
    for (const char *c = leaf; *c && off + 1 < cap; c++) {
        dst[off++] = *c;
    }
    dst[off] = '\0';
}
#endif

/*
 * One process's identity. `comm` resolves for ANY pid on both platforms even
 * across uids; the full path (below) does not, and that asymmetry is why they
 * are separate reads.
 *
 * Returns 0 on success, else the errno that explains the failure (the caller
 * records it, so a truncated ancestry always says why). A failure — the sender
 * already reaped, EPERM, a hardened target — truncates the chain; partial
 * attribution is still attribution.
 */
static int so_proc_read(int32_t pid, so_proc_t *out)
{
#if defined(__APPLE__)
    struct proc_bsdshortinfo bi;
    int n;
    errno = 0; /* the whole handler saves/restores errno, so clobbering is free */
    n = proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &bi, (int)sizeof(bi));
    if (n != (int)sizeof(bi)) {
        return errno != 0 ? errno : EINVAL;
    }
    out->pid = (int32_t)bi.pbsi_pid;
    out->ppid = (int32_t)bi.pbsi_ppid;
    out->uid = (int32_t)bi.pbsi_uid;
    so_copy_bounded(out->comm, sizeof(out->comm), bi.pbsi_comm, sizeof(bi.pbsi_comm));
    return 0;
#else
    char path[64];
    char buf[512];
    struct stat st;
    ssize_t total = 0;
    int fd;

    so_proc_path(path, sizeof(path), pid, "/stat");
    errno = 0;
    fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        /* ENOENT here is linux's ESRCH: the sender is gone. Normalize, so the
         * recorded reason means the same thing on both platforms. */
        return (errno == ENOENT || errno == 0) ? ESRCH : errno;
    }
    /* The owning uid is not in `stat`; the /proc entry's own st_uid is it, and
     * one fstat on an fd we already hold is cheaper than parsing `status`. */
    out->uid = (fstat(fd, &st) == 0) ? (int32_t)st.st_uid : -1;

    for (;;) {
        ssize_t n = read(fd, buf + total, sizeof(buf) - 1 - (size_t)total);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            {
                int saved = errno;
                close(fd); /* close(2) may clobber errno */
                return saved != 0 ? saved : EIO;
            }
        }
        if (n == 0) {
            break;
        }
        total += n;
        if ((size_t)total >= sizeof(buf) - 1) {
            break;
        }
    }
    close(fd);
    buf[total] = '\0';

    /* `pid (comm) state ppid ...` — comm may itself contain spaces and
     * parentheses, so the only safe split is the LAST ')'. */
    {
        ssize_t close_paren = -1;
        ssize_t open_paren = -1;
        for (ssize_t i = total - 1; i >= 0; i--) {
            if (buf[i] == ')') {
                close_paren = i;
                break;
            }
        }
        for (ssize_t i = 0; i < total; i++) {
            if (buf[i] == '(') {
                open_paren = i;
                break;
            }
        }
        if (close_paren < 0 || open_paren < 0 || close_paren <= open_paren) {
            return EINVAL;
        }
        so_copy_bounded(out->comm, sizeof(out->comm), buf + open_paren + 1,
                        (size_t)(close_paren - open_paren - 1));

        /* After ')': " <state> <ppid> ..." */
        {
            ssize_t i = close_paren + 1;
            int32_t ppid = 0;
            while (i < total && buf[i] == ' ') {
                i++;
            }
            while (i < total && buf[i] != ' ') { /* state char */
                i++;
            }
            while (i < total && buf[i] == ' ') {
                i++;
            }
            if (i >= total || buf[i] < '0' || buf[i] > '9') {
                return EINVAL;
            }
            while (i < total && buf[i] >= '0' && buf[i] <= '9') {
                ppid = ppid * 10 + (buf[i] - '0');
                i++;
            }
            out->ppid = ppid;
        }
    }
    out->pid = pid;
    return 0;
#endif
}

/*
 * The sender's full executable path. Tolerates failure by design: reading
 * another uid's exe path needs privilege we do not have, and the sender may
 * already be gone. An empty result is serialized as `null` — `comm` from the
 * ancestry walk still names it either way.
 */
static void so_sender_path(int32_t pid, char *dst, size_t cap)
{
    dst[0] = '\0';
#if defined(__APPLE__)
    {
        int n = proc_pidpath(pid, dst, (uint32_t)cap);
        if (n <= 0) {
            dst[0] = '\0';
        } else if ((size_t)n < cap) {
            dst[n] = '\0';
        } else {
            dst[cap - 1] = '\0';
        }
    }
#else
    {
        char path[64];
        ssize_t n;
        so_proc_path(path, sizeof(path), pid, "/exe");
        n = readlink(path, dst, cap - 1);
        dst[n > 0 ? (size_t)n : 0] = '\0';
    }
#endif
}

/* --------------------------------------------------------------- chaining */

/*
 * Hand the signal on to whoever held the disposition before we armed.
 *
 * THE SIG_DFL ARM IS THE LOAD-BEARING ONE. The old gateway shim chained
 * only when the previous handler is neither SIG_DFL nor SIG_IGN and did
 * nothing otherwise — safe in Go, whose runtime always installs a handler
 * before init(). Bun installs its handler LAZILY, on the first
 * `process.on(sig)`. A tap armed before that would capture SIG_DFL as `prev`,
 * fall into "do nothing", and SILENTLY SWALLOW the signal — a build that can
 * never be killed. So SIG_DFL restores the default disposition and re-raises:
 * `sig` is blocked for the duration of this handler (no SA_NODEFER), so the
 * re-raised signal becomes pending and is delivered against the freshly
 * restored default the moment the handler returns.
 */
static void so_chain(int sig, siginfo_t *info, void *ctx)
{
    /* g_prev is written once, with `sig` blocked, before g_armed is set — so
     * a plain read here cannot observe a half-written sigaction. */
    struct sigaction prev = g_prev[sig];

    if (prev.sa_flags & SA_SIGINFO) {
        if (prev.sa_sigaction != NULL) {
            prev.sa_sigaction(sig, info, ctx);
        }
        return;
    }
    if (prev.sa_handler == SIG_IGN) {
        return;
    }
    if (prev.sa_handler == SIG_DFL) {
        struct sigaction dfl;
        memset(&dfl, 0, sizeof(dfl));
        dfl.sa_handler = SIG_DFL;
        sigemptyset(&dfl.sa_mask);
        dfl.sa_flags = 0;
        sigaction(sig, &dfl, NULL);
        raise(sig);
        return;
    }
    if (prev.sa_handler != NULL) {
        prev.sa_handler(sig);
    }
}

/* ---------------------------------------------------------------- handler */

static void so_handler(int sig, siginfo_t *info, void *ctx)
{
    int saved_errno = errno;

    if (sig > 0 && sig < SO_MAX_SIGNALS) {
        so_slot_t *s = &g_slots[sig];
        so_payload_t *p = &s->p;
        uint32_t base = atomic_load_explicit(&s->seq, memory_order_relaxed);
        struct timespec ts;

        atomic_store_explicit(&s->seq, base + 1u, memory_order_relaxed);
        atomic_thread_fence(memory_order_release);

        p->signo = (int32_t)sig;
        p->si_code = (info != NULL) ? (int32_t)info->si_code : 0;
        p->sender_pid = (info != NULL) ? (int32_t)info->si_pid : 0;
        p->sender_uid = (info != NULL) ? (int32_t)info->si_uid : -1;
        p->self_ppid = (int32_t)getppid();
        p->ancestry_len = 0;
        p->ancestry_errno = 0;
        p->sender_path[0] = '\0';

        p->wall_ns = 0;
        if (clock_gettime(CLOCK_REALTIME, &ts) == 0) {
            p->wall_ns = (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
        }
        p->mono_ns = 0;
#if defined(CLOCK_MONOTONIC_RAW)
        if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) == 0) {
#else
        if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {
#endif
            p->mono_ns = (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
        }

        /* sender_pid == 0 means kernel- or tty-generated (an interactive
         * Ctrl-C lands here). There is no process to walk. */
        if (p->sender_pid > 0) {
            int32_t cur = p->sender_pid;
            for (int i = 0; i < SO_ANCESTRY_MAX && cur > 0; i++) {
                int rc = so_proc_read(cur, &p->ancestry[i]);
                if (rc != 0) {
                    /* ESRCH at i == 0 is the inherent limit of this mechanism:
                     * a short-lived sender (`/bin/kill`) whose parent reaped it
                     * before this process was scheduled to run the handler. The
                     * pid and uid are still recorded — the handler is already
                     * the earliest observable moment — but nothing on the system
                     * can resolve a reaped pid, so the reason is recorded
                     * instead of an ambiguous empty chain. */
                    p->ancestry_errno = rc;
                    break;
                }
                p->ancestry_len = i + 1;
                if (p->ancestry[i].ppid == cur) { /* pid 1 parents itself */
                    break;
                }
                cur = p->ancestry[i].ppid;
            }
            so_sender_path(p->sender_pid, p->sender_path, sizeof(p->sender_path));
        }

        atomic_thread_fence(memory_order_release);
        atomic_store_explicit(&s->seq, base + 2u, memory_order_relaxed);
        atomic_fetch_add_explicit(&s->hits, 1u, memory_order_relaxed);
    }

    errno = saved_errno;
    so_chain(sig, info, ctx);
}

/* ---------------------------------------------------------- serialization */

typedef struct {
    char *buf;
    int cap;
    int len;
    int ok;
} so_out_t;

static void so_put(so_out_t *o, const char *s)
{
    if (!o->ok) {
        return;
    }
    while (*s != '\0') {
        if (o->len + 1 >= o->cap) {
            o->ok = 0;
            return;
        }
        o->buf[o->len++] = *s++;
    }
    o->buf[o->len] = '\0';
}

static void so_put_i64(so_out_t *o, int64_t v)
{
    char tmp[24];
    int n = 0;
    uint64_t u;
    int neg = v < 0;

    if (!o->ok) {
        return;
    }
    u = neg ? (uint64_t)(-(v + 1)) + 1u : (uint64_t)v;
    if (u == 0) {
        tmp[n++] = '0';
    }
    while (u > 0 && n < (int)sizeof(tmp)) {
        tmp[n++] = (char)('0' + (u % 10u));
        u /= 10u;
    }
    if (neg) {
        if (o->len + 1 >= o->cap) {
            o->ok = 0;
            return;
        }
        o->buf[o->len++] = '-';
    }
    while (n > 0) {
        if (o->len + 1 >= o->cap) {
            o->ok = 0;
            return;
        }
        o->buf[o->len++] = tmp[--n];
    }
    o->buf[o->len] = '\0';
}

/* A comm/path is whatever bytes the kernel holds — it is not guaranteed UTF-8
 * and may contain quotes. Escape defensively so the emitted text is always
 * parseable JSON; the TS side decodes the bytes with a replacing UTF-8 decoder,
 * which handles the non-ASCII remainder. */
static void so_put_json_str(so_out_t *o, const char *s)
{
    static const char hex[] = "0123456789abcdef";
    so_put(o, "\"");
    for (; *s != '\0' && o->ok; s++) {
        unsigned char c = (unsigned char)*s;
        char e[7];
        if (c == '"' || c == '\\') {
            e[0] = '\\';
            e[1] = (char)c;
            e[2] = '\0';
        } else if (c < 0x20 || c == 0x7f) {
            e[0] = '\\';
            e[1] = 'u';
            e[2] = '0';
            e[3] = '0';
            e[4] = hex[(c >> 4) & 0xf];
            e[5] = hex[c & 0xf];
            e[6] = '\0';
        } else {
            e[0] = (char)c;
            e[1] = '\0';
        }
        so_put(o, e);
    }
    so_put(o, "\"");
}

static void so_put_field(so_out_t *o, const char *name, int64_t v)
{
    so_put(o, name);
    so_put(o, ":");
    so_put_i64(o, v);
}

/* --------------------------------------------------------- public symbols */

uint32_t so_layout_version(void)
{
    return SO_LAYOUT_VERSION;
}

/*
 * Arm one signal. 0 = armed (or already armed). Non-zero = not armed; the
 * caller fails open.
 *
 * The signal is blocked across the install so that the window between
 * `sigaction` returning `prev` and `g_prev` being written cannot be hit by a
 * delivery — otherwise a signal landing in that window would chain against a
 * zeroed sigaction.
 *
 * SA_RESTART matches what Bun installs, so arming does not change whether
 * interrupted syscalls restart.
 */
int so_install(int signo)
{
    struct sigaction sa;
    struct sigaction prev;
    sigset_t block;
    sigset_t old;
    int rc;

    if (signo <= 0 || signo >= SO_MAX_SIGNALS) {
        return 1;
    }
    /* Idempotent. Re-installing would capture OUR OWN handler as `prev` and
     * chain into infinite recursion. */
    if (atomic_load_explicit(&g_armed[signo], memory_order_acquire) != 0) {
        return 0;
    }

    sigemptyset(&block);
    sigaddset(&block, signo);
    if (sigprocmask(SIG_BLOCK, &block, &old) != 0) {
        return 2;
    }

    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = so_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    memset(&prev, 0, sizeof(prev));

    rc = sigaction(signo, &sa, &prev);
    if (rc == 0) {
        g_prev[signo] = prev;
        atomic_store_explicit(&g_armed[signo], 1, memory_order_release);
    }

    sigprocmask(SIG_SETMASK, &old, NULL);
    return rc == 0 ? 0 : 3;
}

/*
 * Serialize the recorded slot for `signo` as JSON into `buf`.
 *
 * NEVER call this from a signal handler — it is the deliberate other half of
 * the split that keeps the handler async-signal-safe.
 *
 * Returns: >0 bytes written, 0 when nothing was ever recorded for this signal,
 * <0 on error (-1 bad args, -2 the slot kept changing under the seqlock,
 * -3 the JSON did not fit in `cap`).
 */
int so_snapshot(int signo, char *buf, int cap)
{
    so_payload_t copy;
    so_slot_t *s;
    so_out_t o;
    uint32_t hits = 0;
    int got = 0;

    if (signo <= 0 || signo >= SO_MAX_SIGNALS || buf == NULL || cap < 2) {
        return -1;
    }
    s = &g_slots[signo];

    for (int attempt = 0; attempt < 8; attempt++) {
        uint32_t s1 = atomic_load_explicit(&s->seq, memory_order_acquire);
        uint32_t s2;
        if ((s1 & 1u) != 0u) {
            continue;
        }
        memcpy(&copy, &s->p, sizeof(copy));
        hits = atomic_load_explicit(&s->hits, memory_order_relaxed);
        atomic_thread_fence(memory_order_acquire);
        s2 = atomic_load_explicit(&s->seq, memory_order_relaxed);
        if (s1 == s2) {
            got = 1;
            break;
        }
    }
    if (!got) {
        return -2;
    }
    if (hits == 0) {
        buf[0] = '\0';
        return 0;
    }

    o.buf = buf;
    o.cap = cap;
    o.len = 0;
    o.ok = 1;
    buf[0] = '\0';

    so_put(&o, "{");
    so_put_field(&o, "\"signal\"", copy.signo);
    so_put(&o, ",");
    so_put_field(&o, "\"siCode\"", copy.si_code);
    so_put(&o, ",");
    so_put_field(&o, "\"senderPid\"", copy.sender_pid);
    so_put(&o, ",");
    so_put_field(&o, "\"senderUid\"", copy.sender_uid);
    so_put(&o, ",\"senderPath\":");
    if (copy.sender_path[0] == '\0') {
        so_put(&o, "null");
    } else {
        so_put_json_str(&o, copy.sender_path);
    }
    so_put(&o, ",\"ancestry\":[");
    for (int i = 0; i < copy.ancestry_len && i < SO_ANCESTRY_MAX; i++) {
        if (i > 0) {
            so_put(&o, ",");
        }
        so_put(&o, "{");
        so_put_field(&o, "\"pid\"", copy.ancestry[i].pid);
        so_put(&o, ",");
        so_put_field(&o, "\"ppid\"", copy.ancestry[i].ppid);
        so_put(&o, ",");
        so_put_field(&o, "\"uid\"", copy.ancestry[i].uid);
        so_put(&o, ",\"comm\":");
        so_put_json_str(&o, copy.ancestry[i].comm);
        so_put(&o, "}");
    }
    so_put(&o, "],");
    so_put_field(&o, "\"ancestryErrno\"", copy.ancestry_errno);
    so_put(&o, ",");
    so_put_field(&o, "\"selfPpid\"", copy.self_ppid);
    /* Nanosecond wall time exceeds 2^53, so it crosses as a decimal STRING —
     * a JSON number would silently lose precision in JS, and a bigint would
     * throw the moment a caller JSON.stringify'd the record into a log sink. */
    so_put(&o, ",\"wallNs\":\"");
    so_put_i64(&o, copy.wall_ns);
    so_put(&o, "\",\"monoNs\":\"");
    so_put_i64(&o, copy.mono_ns);
    so_put(&o, "\",");
    so_put_field(&o, "\"hits\"", (int64_t)hits);
    so_put(&o, "}");

    if (!o.ok) {
        buf[0] = '\0';
        return -3;
    }
    return o.len;
}
