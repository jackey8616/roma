#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/prctl.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define SEATS 16
#define SEAT_UID_BASE 20000
#define PARKED_UID 19999
#define PARKED_NAME "roma-parked"
#define SERVING_USER "node"
#define ROOTS_DIR "/run/roma-launch"
#define ROOTS_FILE ROOTS_DIR "/roots"
#define REPORT_FD 3
#define MAX_DEPTH 512

#define EXIT_USAGE 64
#define EXIT_SOFTWARE 70
#define EXIT_REFUSED 77

extern char **environ;

static const char *const SHARED_WRITABLE[] = {"/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue"};

struct roots {
  char work[PATH_MAX];
  char config[PATH_MAX];
  char shim[PATH_MAX];
};

struct owners {
  uid_t ids[SEATS + 2];
  int count;
};

static uid_t serving_uid;
static gid_t serving_gid;

static void report(const char *fmt, ...) {
  if (fcntl(REPORT_FD, F_GETFD) == -1) return;
  char line[512];
  va_list args;
  va_start(args, fmt);
  int n = vsnprintf(line, sizeof line, fmt, args);
  va_end(args);
  if (n > 0) {
    size_t len = (size_t)n < sizeof line ? (size_t)n : sizeof line - 1;
    ssize_t ignored = write(REPORT_FD, line, len);
    (void)ignored;
  }
}

static _Noreturn void fail(int code, const char *fmt, ...) {
  char line[512];
  va_list args;
  va_start(args, fmt);
  vsnprintf(line, sizeof line, fmt, args);
  va_end(args);
  fprintf(stderr, "roma-launch: %s\n", line);
  report("refused %s\n", line);
  exit(code);
}

static void path_of(char *into, const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  int n = vsnprintf(into, PATH_MAX, fmt, args);
  va_end(args);
  if (n < 0 || n >= PATH_MAX) fail(EXIT_REFUSED, "a path under the configured roots is too long");
}

static bool seat_from(const char *text, int *seat) {
  if (strlen(text) != 2 || !isdigit((unsigned char)text[0]) || !isdigit((unsigned char)text[1])) {
    return false;
  }
  int n = (text[0] - '0') * 10 + (text[1] - '0');
  if (n >= SEATS) return false;
  *seat = n;
  return true;
}

static bool is_session(const char *text) {
  if (strlen(text) != 36) return false;
  for (int i = 0; i < 36; i++) {
    char c = text[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
    } else if (!(isdigit((unsigned char)c) || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

static bool is_enclosure_name(const char *text) {
  size_t len = strlen(text);
  if (len < 36 || len > 45) return false;
  char session[37];
  memcpy(session, text, 36);
  session[36] = '\0';
  if (!is_session(session)) return false;
  if (len == 36) return true;
  if (text[36] != '.' || len == 37) return false;
  for (size_t i = 37; i < len; i++) {
    char c = text[i];
    if (!(isdigit((unsigned char)c) || (c >= 'a' && c <= 'z'))) return false;
  }
  return true;
}

static uid_t seat_uid(int seat) { return (uid_t)(SEAT_UID_BASE + seat); }

static void require_account(uid_t uid, const char *name) {
  struct passwd *pw = getpwuid(uid);
  if (pw == NULL || strcmp(pw->pw_name, name) != 0 || pw->pw_gid != (gid_t)uid) {
    fail(EXIT_REFUSED, "uid %u is not %s with a group of its own; the image is not the one ADR-0036 describes",
         (unsigned)uid, name);
  }
}

static void require_accounts(void) {
  require_account(PARKED_UID, PARKED_NAME);
  for (int seat = 0; seat < SEATS; seat++) {
    char name[32];
    snprintf(name, sizeof name, "roma-seat-%02d", seat);
    require_account(seat_uid(seat), name);
  }
}

static void require_caller(void) {
  struct passwd *pw = getpwnam(SERVING_USER);
  if (pw == NULL) fail(EXIT_REFUSED, "there is no %s user", SERVING_USER);
  serving_uid = pw->pw_uid;
  serving_gid = pw->pw_gid;
  if (geteuid() != 0) fail(EXIT_REFUSED, "not setuid root");
  if (getuid() != serving_uid) fail(EXIT_REFUSED, "only roma, as %s, may run this", SERVING_USER);
}

static void require_sysctl(const char *path) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  char value[8] = {0};
  if (fd < 0 || read(fd, value, sizeof value - 1) <= 0 || atoi(value) < 1) {
    fail(EXIT_REFUSED, "%s is not on, so a link in a Session's tree could reach a file of root's", path);
  }
  close(fd);
}

static void require_trusted(int fd, const char *path, bool directory) {
  struct stat st;
  if (fstat(fd, &st) != 0) fail(EXIT_SOFTWARE, "cannot stat %s: %s", path, strerror(errno));
  if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) {
    fail(EXIT_REFUSED, "%s is not a %s", path, directory ? "directory" : "regular file");
  }
  if (st.st_uid != 0 || (st.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
    fail(EXIT_REFUSED, "%s must be root's and writable by nobody else", path);
  }
}

static void read_root(const char *line, const char *key, char *into) {
  size_t key_len = strlen(key);
  if (strncmp(line, key, key_len) != 0 || line[key_len] != ' ') return;
  const char *value = line + key_len + 1;
  size_t len = strcspn(value, "\n");
  if (len == 0 || len >= PATH_MAX || value[0] != '/' || strstr(value, "/..") != NULL) {
    fail(EXIT_REFUSED, "the %s root in %s is not an absolute path", key, ROOTS_FILE);
  }
  memcpy(into, value, len);
  into[len] = '\0';
}

static void load_roots(struct roots *roots) {
  const char *chain[] = {"/", "/run", ROOTS_DIR};
  for (size_t i = 0; i < sizeof chain / sizeof *chain; i++) {
    int fd = open(chain[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) fail(EXIT_REFUSED, "cannot open %s: %s", chain[i], strerror(errno));
    require_trusted(fd, chain[i], true);
    close(fd);
  }
  int fd = open(ROOTS_FILE, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail(EXIT_REFUSED, "cannot open %s: %s", ROOTS_FILE, strerror(errno));
  require_trusted(fd, ROOTS_FILE, false);
  FILE *file = fdopen(fd, "r");
  if (file == NULL) fail(EXIT_SOFTWARE, "cannot read %s", ROOTS_FILE);
  memset(roots, 0, sizeof *roots);
  char line[PATH_MAX + 16];
  while (fgets(line, sizeof line, file) != NULL) {
    read_root(line, "work", roots->work);
    read_root(line, "config", roots->config);
    read_root(line, "shim", roots->shim);
  }
  fclose(file);
  if (roots->work[0] == '\0' || roots->config[0] == '\0' || roots->shim[0] == '\0') {
    fail(EXIT_REFUSED, "%s does not name the work, config and shim roots", ROOTS_FILE);
  }
}

static int open_dir(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) fail(EXIT_SOFTWARE, "cannot open %s: %s", path, strerror(errno));
  return fd;
}

static int open_sessions_root(const struct roots *roots) {
  int config = open_dir(roots->config);
  if (mkdirat(config, "sessions", 0711) == 0) {
    if (fchownat(config, "sessions", serving_uid, serving_gid, AT_SYMLINK_NOFOLLOW) != 0) {
      fail(EXIT_SOFTWARE, "cannot give %s/sessions to %s: %s", roots->config, SERVING_USER, strerror(errno));
    }
  } else if (errno != EEXIST) {
    fail(EXIT_SOFTWARE, "cannot make %s/sessions: %s", roots->config, strerror(errno));
  }
  int sessions = openat(config, "sessions", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (sessions < 0) fail(EXIT_SOFTWARE, "cannot open %s/sessions: %s", roots->config, strerror(errno));
  struct stat st;
  if (fstat(sessions, &st) != 0 || st.st_uid != serving_uid) {
    fail(EXIT_REFUSED, "%s/sessions is not %s's", roots->config, SERVING_USER);
  }
  if ((st.st_mode & 07777) != 0711 && fchmod(sessions, 0711) != 0) {
    fail(EXIT_SOFTWARE, "cannot make %s/sessions passable: %s", roots->config, strerror(errno));
  }
  close(config);
  return sessions;
}

static bool owned_by(const struct owners *owners, uid_t uid) {
  for (int i = 0; i < owners->count; i++) {
    if (owners->ids[i] == uid) return true;
  }
  return false;
}

static int rechown(int dir, const struct owners *from, uid_t to, int depth) {
  if (depth > MAX_DEPTH) {
    errno = ELOOP;
    return -1;
  }
  int listing = dup(dir);
  if (listing < 0) return -1;
  DIR *entries = fdopendir(listing);
  if (entries == NULL) {
    close(listing);
    return -1;
  }
  int result = 0;
  struct dirent *entry;
  while (result == 0 && (errno = 0, entry = readdir(entries)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat st;
    if (fstatat(dir, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      result = -1;
      break;
    }
    if (S_ISDIR(st.st_mode)) {
      int sub = openat(dir, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (sub < 0 || rechown(sub, from, to, depth + 1) != 0) result = -1;
      if (sub >= 0) close(sub);
    }
    if (result == 0 && owned_by(from, st.st_uid) &&
        fchownat(dir, entry->d_name, to, (gid_t)to, AT_SYMLINK_NOFOLLOW) != 0) {
      result = -1;
    }
  }
  if (entry == NULL && errno != 0) result = -1;
  closedir(entries);
  return result;
}

static int hand_over(int root, const char *session, const struct owners *from, uid_t to, bool create) {
  bool created = false;
  if (create) {
    if (mkdirat(root, session, 0700) == 0) {
      created = true;
    } else if (errno != EEXIST) {
      return -1;
    }
  }
  int top = openat(root, session, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (top < 0) return (errno == ENOENT && !create) ? 0 : -1;
  struct stat st;
  int result = fstat(top, &st);
  bool ours = (created && st.st_uid == 0) || st.st_uid == to || owned_by(from, st.st_uid);
  if (result == 0 && !ours) {
    errno = EPERM;
    result = -1;
  }
  if (result == 0) result = rechown(top, from, to, 0);
  if (result == 0) result = fchown(top, to, (gid_t)to);
  if (result == 0) result = fchmod(top, 0700);
  close(top);
  return result;
}

static bool uid_running(uid_t uid, pid_t self) {
  DIR *proc = opendir("/proc");
  if (proc == NULL) return true;
  bool found = false;
  struct dirent *entry;
  while (!found && (entry = readdir(proc)) != NULL) {
    if (!isdigit((unsigned char)entry->d_name[0])) continue;
    pid_t pid = (pid_t)atoi(entry->d_name);
    if (pid == self) continue;
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/status", (int)pid);
    FILE *status = fopen(path, "re");
    if (status == NULL) continue;
    char line[256];
    bool zombie = false;
    bool ours = false;
    while (fgets(line, sizeof line, status) != NULL) {
      if (strncmp(line, "State:", 6) == 0) zombie = strchr(line, 'Z') != NULL;
      unsigned real, effective, saved, fs;
      if (sscanf(line, "Uid: %u %u %u %u", &real, &effective, &saved, &fs) == 4) {
        ours = real == uid || effective == uid || saved == uid || fs == uid;
      }
    }
    fclose(status);
    found = ours && !zombie;
  }
  closedir(proc);
  return found;
}

static void become(uid_t uid) {
  if (setgroups(0, NULL) != 0 || setgid((gid_t)uid) != 0 || setuid(uid) != 0) {
    fail(EXIT_SOFTWARE, "cannot become uid %u: %s", (unsigned)uid, strerror(errno));
  }
  if (setuid(0) == 0 || geteuid() == 0) fail(EXIT_SOFTWARE, "uid %u could become root again", (unsigned)uid);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail(EXIT_SOFTWARE, "cannot set no_new_privs: %s", strerror(errno));
  }
}

static int remove_tree(int dir, int depth) {
  if (depth > MAX_DEPTH) {
    errno = ELOOP;
    return -1;
  }
  int listing = dup(dir);
  if (listing < 0) return -1;
  DIR *entries = fdopendir(listing);
  if (entries == NULL) {
    close(listing);
    return -1;
  }
  int result = 0;
  struct dirent *entry;
  while (result == 0 && (errno = 0, entry = readdir(entries)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat st;
    if (fstatat(dir, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      result = -1;
      break;
    }
    if (S_ISDIR(st.st_mode)) {
      int sub = openat(dir, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (sub < 0) {
        result = -1;
        break;
      }
      if (fchmod(sub, 0700) != 0 || remove_tree(sub, depth + 1) != 0) result = -1;
      close(sub);
      if (result == 0) result = unlinkat(dir, entry->d_name, AT_REMOVEDIR);
    } else {
      result = unlinkat(dir, entry->d_name, 0);
    }
  }
  if (result == 0 && entry == NULL && errno != 0) result = -1;
  closedir(entries);
  return result;
}

static int purge_owned(int dir, uid_t uid, int depth) {
  if (depth > MAX_DEPTH) {
    report("skipped a tree deeper than %d that seat uid %u does not own\n", MAX_DEPTH, (unsigned)uid);
    return 0;
  }
  int listing = dup(dir);
  DIR *entries = listing < 0 ? NULL : fdopendir(listing);
  if (entries == NULL) {
    if (listing >= 0) close(listing);
    return -1;
  }
  int result = 0;
  struct dirent *entry;
  while (result == 0 && (errno = 0, entry = readdir(entries)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat st;
    if (fstatat(dir, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      result = -1;
      break;
    }
    if (S_ISDIR(st.st_mode)) {
      int sub = openat(dir, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (sub < 0) {
        result = -1;
        break;
      }
      if (st.st_uid == uid) {
        if (fchmod(sub, 0700) != 0 || remove_tree(sub, depth + 1) != 0) result = -1;
        close(sub);
        if (result == 0 && unlinkat(dir, entry->d_name, AT_REMOVEDIR) != 0) result = -1;
      } else {
        result = purge_owned(sub, uid, depth + 1);
        close(sub);
      }
    } else if (st.st_uid == uid && unlinkat(dir, entry->d_name, 0) != 0) {
      result = -1;
    }
  }
  if (result == 0 && entry == NULL && errno != 0) result = -1;
  closedir(entries);
  return result;
}

static int purge_shared(uid_t uid) {
  int result = 0;
  for (size_t i = 0; i < sizeof SHARED_WRITABLE / sizeof *SHARED_WRITABLE; i++) {
    int dir = open(SHARED_WRITABLE[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir < 0) {
      if (errno == ENOENT) continue;
      return -1;
    }
    if (purge_owned(dir, uid, 0) != 0) result = -1;
    close(dir);
  }
  return result;
}

static int ipc_column(const char *header, const char *name) {
  int column = 0;
  bool in_word = false;
  const char *word = NULL;
  for (const char *c = header;; c++) {
    bool space = *c == ' ' || *c == '\t' || *c == '\n' || *c == '\0';
    if (!space && !in_word) {
      in_word = true;
      word = c;
    } else if (space && in_word) {
      in_word = false;
      if ((size_t)(c - word) == strlen(name) && strncmp(word, name, strlen(name)) == 0) return column;
      column++;
    }
    if (*c == '\0') return -1;
  }
}

static bool ipc_field(const char *line, int column, long *value) {
  const char *c = line;
  for (int i = 0;; i++) {
    while (*c == ' ' || *c == '\t') c++;
    if (*c == '\0' || *c == '\n') return false;
    if (i == column) {
      char *end;
      errno = 0;
      long parsed = strtol(c, &end, 10);
      if (errno != 0 || end == c) return false;
      *value = parsed;
      return true;
    }
    while (*c != ' ' && *c != '\t' && *c != '\0' && *c != '\n') c++;
  }
}

static int remove_ipc_kind(uid_t uid, const char *table, const char *id_name, int (*remove)(int)) {
  FILE *file = fopen(table, "re");
  if (file == NULL) return errno == ENOENT ? 0 : -1;
  char line[512];
  int result = 0;
  if (fgets(line, sizeof line, file) == NULL) {
    result = ferror(file) ? -1 : 0;
    fclose(file);
    return result;
  }
  int id_at = ipc_column(line, id_name);
  int uid_at = ipc_column(line, "uid");
  int cuid_at = ipc_column(line, "cuid");
  if (id_at < 0 || uid_at < 0 || cuid_at < 0) {
    fclose(file);
    return -1;
  }
  while (fgets(line, sizeof line, file) != NULL) {
    long id, owner, creator;
    if (!ipc_field(line, id_at, &id) || !ipc_field(line, uid_at, &owner) ||
        !ipc_field(line, cuid_at, &creator)) {
      result = -1;
      continue;
    }
    if ((uid_t)owner != uid && (uid_t)creator != uid) continue;
    if (remove((int)id) != 0 && errno != EINVAL && errno != EIDRM) result = -1;
  }
  if (ferror(file)) result = -1;
  fclose(file);
  return result;
}

static int remove_shm(int id) { return shmctl(id, IPC_RMID, NULL); }
static int remove_msg(int id) { return msgctl(id, IPC_RMID, NULL); }
static int remove_sem(int id) { return semctl(id, 0, IPC_RMID); }

static int remove_ipc(uid_t uid) {
  int result = 0;
  if (remove_ipc_kind(uid, "/proc/sysvipc/shm", "shmid", remove_shm) != 0) result = -1;
  if (remove_ipc_kind(uid, "/proc/sysvipc/msg", "msqid", remove_msg) != 0) result = -1;
  if (remove_ipc_kind(uid, "/proc/sysvipc/sem", "semid", remove_sem) != 0) result = -1;
  return result;
}

static int as_user(uid_t uid, int (*work)(uid_t, const void *), const void *context) {
  pid_t child = fork();
  if (child < 0) return -1;
  if (child == 0) {
    become(uid);
    _exit(work(uid, context) == 0 ? 0 : 1);
  }
  int status;
  for (;;) {
    pid_t reaped = waitpid(-1, &status, 0);
    if (reaped == child) break;
    if (reaped < 0 && errno != EINTR) return -1;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

static int kill_seat_as_seat(uid_t uid, const void *unused) {
  (void)unused;
  struct timespec pause = {0, 20 * 1000 * 1000};
  for (int attempt = 0; attempt < 250; attempt++) {
    kill(-1, SIGKILL);
    if (!uid_running(uid, getpid())) return 0;
    nanosleep(&pause, NULL);
  }
  return -1;
}

static int remove_ipc_as_seat(uid_t uid, const void *unused) {
  (void)unused;
  return remove_ipc(uid);
}

static const char *empty_seat(int seat) {
  uid_t uid = seat_uid(seat);
  if (as_user(uid, kill_seat_as_seat, NULL) != 0) return "its processes could not all be killed";
  for (;;) {
    pid_t reaped = waitpid(-1, NULL, WNOHANG);
    if (reaped <= 0) break;
  }
  if (uid_running(uid, getpid())) return "its processes could not all be killed";
  if (as_user(uid, remove_ipc_as_seat, NULL) != 0) return "its System V IPC could not all be removed";
  if (purge_shared(uid) != 0) return "what it left in the shared directories could not all be removed";
  return NULL;
}

static int park(const struct roots *roots, const char *session, const struct owners *from) {
  int work = open_dir(roots->work);
  int sessions = open_sessions_root(roots);
  int result = hand_over(work, session, from, PARKED_UID, false);
  if (result == 0) result = hand_over(sessions, session, from, PARKED_UID, false);
  close(work);
  close(sessions);
  return result;
}

static int prepare(const struct roots *roots, const char *session, int seat) {
  struct owners parked = {{PARKED_UID}, 1};
  int work = open_dir(roots->work);
  int sessions = open_sessions_root(roots);
  int result = hand_over(work, session, &parked, seat_uid(seat), true);
  if (result == 0) result = hand_over(sessions, session, &parked, seat_uid(seat), true);
  close(work);
  close(sessions);
  return result;
}

static void make_own_dir(const char *path) {
  if (mkdir(path, 0700) != 0 && errno != EEXIST) {
    fail(EXIT_SOFTWARE, "cannot make %s: %s", path, strerror(errno));
  }
  struct stat st;
  if (lstat(path, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid()) {
    fail(EXIT_REFUSED, "%s is not this Seat's directory", path);
  }
}

static char *entry(const char *name, const char *value) {
  size_t len = strlen(name) + strlen(value) + 2;
  char *text = malloc(len);
  if (text == NULL) fail(EXIT_SOFTWARE, "out of memory");
  snprintf(text, len, "%s=%s", name, value);
  return text;
}

static const char *const OWN_VARIABLES[] = {
    "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "ROMA_MINTER_SOCKET", "ROMA_SESSION_ID", "USER", "LOGNAME",
};

static bool own_variable(const char *assignment) {
  for (size_t i = 0; i < sizeof OWN_VARIABLES / sizeof *OWN_VARIABLES; i++) {
    size_t len = strlen(OWN_VARIABLES[i]);
    if (strncmp(assignment, OWN_VARIABLES[i], len) == 0 && assignment[len] == '=') return true;
  }
  return false;
}

static _Noreturn void exec_runtime(const struct roots *roots, const char *session, int seat, char **argv) {
  uid_t uid = seat_uid(seat);
  become(uid);

  char cwd[PATH_MAX], home[PATH_MAX], tmp[PATH_MAX], enclosures[PATH_MAX], config[PATH_MAX];
  char socket[PATH_MAX], user[32];
  path_of(cwd, "%s/%s", roots->work, session);
  path_of(home, "%s/.home", cwd);
  path_of(tmp, "%s/.tmp", cwd);
  path_of(enclosures, "%s/.enclosures", cwd);
  path_of(config, "%s/sessions/%s", roots->config, session);
  path_of(socket, "%s/seat-%02d.sock", roots->shim, seat);
  snprintf(user, sizeof user, "roma-seat-%02d", seat);
  make_own_dir(home);
  make_own_dir(tmp);
  make_own_dir(enclosures);
  if (chdir(cwd) != 0) fail(EXIT_SOFTWARE, "cannot enter %s: %s", cwd, strerror(errno));

  size_t inherited = 0;
  while (environ[inherited] != NULL) inherited++;
  char **env = calloc(inherited + 9, sizeof *env);
  if (env == NULL) fail(EXIT_SOFTWARE, "out of memory");
  size_t n = 0;
  for (size_t i = 0; i < inherited; i++) {
    if (!own_variable(environ[i])) env[n++] = environ[i];
  }
  env[n++] = entry("HOME", home);
  env[n++] = entry("TMPDIR", tmp);
  env[n++] = entry("CLAUDE_CONFIG_DIR", config);
  env[n++] = entry("CLAUDE_SECURESTORAGE_CONFIG_DIR", config);
  env[n++] = entry("ROMA_MINTER_SOCKET", socket);
  env[n++] = entry("ROMA_SESSION_ID", session);
  env[n++] = entry("USER", user);
  env[n++] = entry("LOGNAME", user);
  env[n] = NULL;

  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  execvpe(argv[0], argv, env);
  fail(EXIT_SOFTWARE, "cannot run %s: %s", argv[0], strerror(errno));
}

static volatile sig_atomic_t runtime_pid = 0;

static void forward(int signal) {
  if (runtime_pid > 0) kill((pid_t)runtime_pid, signal);
}

static int run(const struct roots *roots, const char *session, int seat, char **argv) {
  if (fcntl(REPORT_FD, F_GETFD) != -1) fcntl(REPORT_FD, F_SETFD, FD_CLOEXEC);
  if (uid_running(seat_uid(seat), getpid())) {
    fail(EXIT_REFUSED, "seat %02d still has processes; it was not returned", seat);
  }
  if (prepare(roots, session, seat) != 0) {
    fail(EXIT_SOFTWARE, "cannot prepare session %s for seat %02d: %s", session, seat, strerror(errno));
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    fail(EXIT_SOFTWARE, "cannot become a subreaper: %s", strerror(errno));
  }

  struct sigaction forwarding = {0};
  forwarding.sa_handler = forward;
  sigemptyset(&forwarding.sa_mask);
  int forwarded[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
  for (size_t i = 0; i < sizeof forwarded / sizeof *forwarded; i++) {
    sigaction(forwarded[i], &forwarding, NULL);
  }

  pid_t child = fork();
  if (child < 0) fail(EXIT_SOFTWARE, "cannot fork: %s", strerror(errno));
  if (child == 0) exec_runtime(roots, session, seat, argv);
  runtime_pid = child;
  report("started %d\n", (int)child);

  int status = 0;
  for (;;) {
    int reaped_status;
    pid_t reaped = waitpid(-1, &reaped_status, 0);
    if (reaped == child) {
      status = reaped_status;
      break;
    }
    if (reaped < 0 && errno != EINTR) fail(EXIT_SOFTWARE, "lost the Runtime: %s", strerror(errno));
  }
  runtime_pid = 0;

  struct owners seat_owner = {{seat_uid(seat)}, 1};
  const char *unemptied = empty_seat(seat);
  if (unemptied != NULL) {
    report("quarantine seat %02d: %s\n", seat, unemptied);
  } else if (park(roots, session, &seat_owner) != 0) {
    report("quarantine seat %02d: session %s could not be parked: %s\n", seat, session, strerror(errno));
  } else {
    report("returned seat %02d\n", seat);
  }

  if (WIFSIGNALED(status)) {
    int signal = WTERMSIG(status);
    struct sigaction plain = {0};
    plain.sa_handler = SIG_DFL;
    sigaction(signal, &plain, NULL);
    raise(signal);
    return 128 + signal;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : EXIT_SOFTWARE;
}

static int enclose(const struct roots *roots, const char *session, int seat, const char *name) {
  become(seat_uid(seat));
  int work = open(roots->work, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (work < 0) fail(EXIT_SOFTWARE, "cannot reach %s: %s", roots->work, strerror(errno));
  int top = openat(work, session, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (top < 0) fail(EXIT_REFUSED, "session %s is not seat %02d's: %s", session, seat, strerror(errno));
  if (mkdirat(top, ".enclosures", 0700) != 0 && errno != EEXIST) {
    fail(EXIT_SOFTWARE, "cannot make .enclosures: %s", strerror(errno));
  }
  int dir = openat(top, ".enclosures", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (dir < 0) fail(EXIT_REFUSED, ".enclosures is not a directory: %s", strerror(errno));
  int out = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (out < 0) fail(EXIT_SOFTWARE, "cannot create %s: %s", name, strerror(errno));
  char buffer[65536];
  for (;;) {
    ssize_t got = read(STDIN_FILENO, buffer, sizeof buffer);
    if (got == 0) break;
    if (got < 0) {
      if (errno == EINTR) continue;
      fail(EXIT_SOFTWARE, "cannot read the Enclosure: %s", strerror(errno));
    }
    for (ssize_t done = 0; done < got;) {
      ssize_t wrote = write(out, buffer + done, (size_t)(got - done));
      if (wrote < 0) {
        if (errno == EINTR) continue;
        fail(EXIT_SOFTWARE, "cannot write %s: %s", name, strerror(errno));
      }
      done += wrote;
    }
  }
  if (close(out) != 0) fail(EXIT_SOFTWARE, "cannot write %s: %s", name, strerror(errno));
  return 0;
}

static int reclaim_as_parked(uid_t uid, const void *context) {
  (void)uid;
  return remove_tree(*(const int *)context, 0);
}

static int reclaim(const struct roots *roots, const char *session) {
  int work = open_dir(roots->work);
  int top = openat(work, session, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (top < 0) {
    if (errno == ENOENT) return 0;
    fail(EXIT_SOFTWARE, "cannot open session %s: %s", session, strerror(errno));
  }
  struct stat st;
  if (fstat(top, &st) != 0 || st.st_uid != PARKED_UID) {
    fail(EXIT_REFUSED, "session %s is not parked, so it is not reclaimed", session);
  }
  if (as_user(PARKED_UID, reclaim_as_parked, &top) != 0 || unlinkat(work, session, AT_REMOVEDIR) != 0) {
    fail(EXIT_SOFTWARE, "cannot reclaim session %s", session);
  }
  return 0;
}

static int park_every_session(int root, const struct owners *from) {
  int listing = dup(root);
  DIR *entries = listing < 0 ? NULL : fdopendir(listing);
  if (entries == NULL) return -1;
  int result = 0;
  struct dirent *entry;
  while ((errno = 0, entry = readdir(entries)) != NULL) {
    if (!is_session(entry->d_name)) continue;
    struct stat st;
    if (fstatat(root, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      fprintf(stderr, "roma-launch: cannot inspect %s: %s\n", entry->d_name, strerror(errno));
      result = -1;
      continue;
    }
    if (!S_ISDIR(st.st_mode)) continue;
    if (hand_over(root, entry->d_name, from, PARKED_UID, false) != 0) {
      fprintf(stderr, "roma-launch: cannot park %s: %s\n", entry->d_name, strerror(errno));
      result = -1;
    }
  }
  if (entry == NULL && errno != 0) result = -1;
  closedir(entries);
  return result;
}

static int sweep(const struct roots *roots) {
  for (size_t i = 0; i < sizeof SHARED_WRITABLE / sizeof *SHARED_WRITABLE; i++) {
    int dir = open(SHARED_WRITABLE[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir < 0) continue;
    if (fchown(dir, 0, 0) != 0 || fchmod(dir, 01733) != 0) {
      fail(EXIT_SOFTWARE, "cannot close the listing of %s: %s", SHARED_WRITABLE[i], strerror(errno));
    }
    close(dir);
  }
  struct owners anyone = {{0}, 0};
  anyone.ids[anyone.count++] = serving_uid;
  for (int seat = 0; seat < SEATS; seat++) {
    const char *unemptied = empty_seat(seat);
    if (unemptied != NULL) fail(EXIT_SOFTWARE, "cannot empty seat %02d: %s", seat, unemptied);
    anyone.ids[anyone.count++] = seat_uid(seat);
  }
  int work = open_dir(roots->work);
  int sessions = open_sessions_root(roots);
  int result = park_every_session(work, &anyone);
  if (park_every_session(sessions, &anyone) != 0) result = -1;
  close(work);
  close(sessions);
  if (result != 0) fail(EXIT_SOFTWARE, "some Sessions could not be parked");
  return 0;
}

static int seats(const struct roots *roots) {
  int shim = open_dir(roots->shim);
  for (int seat = 0; seat < SEATS; seat++) {
    char name[32];
    snprintf(name, sizeof name, "seat-%02d.sock", seat);
    int fd = openat(shim, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) fail(EXIT_REFUSED, "there is no %s/%s: %s", roots->shim, name, strerror(errno));
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISSOCK(st.st_mode) || st.st_uid != serving_uid) {
      fail(EXIT_REFUSED, "%s/%s is not a socket of %s's", roots->shim, name, SERVING_USER);
    }
    char path[64];
    snprintf(path, sizeof path, "/proc/self/fd/%d", fd);
    if (fchownat(fd, "", serving_uid, (gid_t)seat_uid(seat), AT_EMPTY_PATH) != 0 || chmod(path, 0660) != 0) {
      fail(EXIT_SOFTWARE, "cannot give %s to seat %02d: %s", name, seat, strerror(errno));
    }
    close(fd);
  }
  close(shim);
  return 0;
}

static _Noreturn void usage(void) {
  fail(EXIT_USAGE,
       "usage: roma-launch run <seat> <session> -- <argv>... | enclose <seat> <session> <name> | "
       "reclaim <session> | sweep | seats");
}

int main(int argc, char **argv) {
  require_caller();
  if (argc < 2) usage();
  require_accounts();
  require_sysctl("/proc/sys/fs/protected_symlinks");
  require_sysctl("/proc/sys/fs/protected_hardlinks");
  struct roots roots;
  load_roots(&roots);

  const char *mode = argv[1];
  int seat;
  if (strcmp(mode, "run") == 0) {
    if (argc < 6 || !seat_from(argv[2], &seat) || !is_session(argv[3]) || strcmp(argv[4], "--") != 0) usage();
    return run(&roots, argv[3], seat, argv + 5);
  }
  if (strcmp(mode, "enclose") == 0) {
    if (argc != 5 || !seat_from(argv[2], &seat) || !is_session(argv[3]) || !is_enclosure_name(argv[4])) usage();
    return enclose(&roots, argv[3], seat, argv[4]);
  }
  if (strcmp(mode, "reclaim") == 0) {
    if (argc != 3 || !is_session(argv[2])) usage();
    return reclaim(&roots, argv[2]);
  }
  if (strcmp(mode, "sweep") == 0 && argc == 2) return sweep(&roots);
  if (strcmp(mode, "seats") == 0 && argc == 2) return seats(&roots);
  usage();
}
