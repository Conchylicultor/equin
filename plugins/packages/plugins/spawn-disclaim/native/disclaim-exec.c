// disclaim-exec — become the macOS responsible process of what you run.
//
//   disclaim-exec <program> [args…]
//       Replaces itself with <program> (POSIX_SPAWN_SETEXEC: same pid, stdio,
//       environment, signal dispositions and darwinbg tier), spawned with the
//       responsibility DISCLAIMED — so TCC attributes it and everything it
//       starts to <program> itself, not to whichever launchd job started this
//       process tree. <program> is looked up on PATH (posix_spawnp).
//
//   disclaim-exec --print-responsible [pid]
//       Prints the pid responsible for <pid> (default: this process). For
//       verification only.
//
// Both entry points are private SPI in libSystem (libquarantine), weak-imported
// so a macOS without them is a loud failure here rather than a load error.
// Every failure is one line on stderr and exit 127: the program never ran, and
// the caller (an agent launching claude) fails loudly.

#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs,
                                                 int disclaim)
    __attribute__((weak_import));
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid)
    __attribute__((weak_import));

static void fail(const char *what, int err) {
  fprintf(stderr, "disclaim-exec: %s: %s\n", what, strerror(err));
  _exit(127);
}

static int print_responsible(int argc, char **argv) {
  if (!responsibility_get_pid_responsible_for_pid) {
    fprintf(stderr, "disclaim-exec: responsibility_get_pid_responsible_for_pid "
                    "is not in this macOS's libSystem\n");
    _exit(127);
  }
  pid_t pid = getpid();
  if (argc >= 3) {
    char *end = NULL;
    long parsed = strtol(argv[2], &end, 10);
    if (*argv[2] == '\0' || *end != '\0' || parsed <= 0) {
      fprintf(stderr, "disclaim-exec: not a pid: %s\n", argv[2]);
      _exit(127);
    }
    pid = (pid_t)parsed;
  }
  pid_t responsible = responsibility_get_pid_responsible_for_pid(pid);
  if (responsible <= 0) fail("responsibility_get_pid_responsible_for_pid", errno);
  printf("%d\n", (int)responsible);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--print-responsible") == 0) {
    return print_responsible(argc, argv);
  }
  if (argc < 2) {
    fprintf(stderr, "usage: disclaim-exec <program> [args…] | "
                    "disclaim-exec --print-responsible [pid]\n");
    _exit(127);
  }
  if (!responsibility_spawnattrs_setdisclaim) {
    fprintf(stderr, "disclaim-exec: responsibility_spawnattrs_setdisclaim is "
                    "not in this macOS's libSystem\n");
    _exit(127);
  }

  posix_spawnattr_t attrs;
  int rc = posix_spawnattr_init(&attrs);
  if (rc != 0) fail("posix_spawnattr_init", rc);
  rc = responsibility_spawnattrs_setdisclaim(&attrs, 1);
  if (rc != 0) fail("responsibility_spawnattrs_setdisclaim", rc);
  rc = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC);
  if (rc != 0) fail("posix_spawnattr_setflags(POSIX_SPAWN_SETEXEC)", rc);

  // On success this never returns: the process image is replaced.
  rc = posix_spawnp(NULL, argv[1], NULL, &attrs, argv + 1, environ);
  fprintf(stderr, "disclaim-exec: cannot run %s: %s\n", argv[1], strerror(rc));
  _exit(127);
}
