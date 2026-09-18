/* findidx.c — TentacleTool/find 原生索引器（C + Win32，零依赖）
 *
 * 与 src/utils/indexer.js（Node 版）行为一致，但快数倍：
 *   - FindFirstFileW 一次系统调用拿全 元数据（Node 需要 readdir + stat 两趟 + JS 开销）
 *   - 多线程工作队列遍历（默认 8 线程）
 *   - \\?\ 长路径前缀，绕过 MAX_PATH 限制
 *
 * 输出与 Node 版 saveCache 完全一致的 TSV（首行 meta JSON，之后每行 path\tsize\tmtime\tisdir），
 * 这样 Node 端的 loadCache 可以原样加载。
 *
 * 编译（见 build.bat）:
 *   gcc -O2 -Wall -s -o findidx.exe findidx.c -lshell32
 *
 * 用法:
 *   findidx.exe --out <file.tsv> [--max-entries N] [--max-depth N] [--threads N]
 *               --home <user-home> --roots <dir1> <dir2> ...
 *
 * 跳过规则与 Node 版保持同步（SKIP_DIRS / home 级点目录与云缓存 / $前缀 / *.tmp /
 * reparse point / 根覆盖去重 home ⊂ C:\）。
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* ======================== 配置默认值 ======================== */
#define MAX_DEPTH_DEFAULT   12
#define MAX_ENTRIES_DEFAULT 250000
#define THREADS_DEFAULT     8
#define PATH_W              4096          /* 单条路径 wchar 上限（配合 \\?\ 已足够长） */

/* ======================== 全局状态 ======================== */
static CRITICAL_SECTION g_lock;
static CONDITION_VARIABLE g_cvWork;

/* 目录工作队列（FIFO，head==tail 时为空） */
static wchar_t** g_qpath;
static int*      g_qdepth;
static int*      g_qroot;
static size_t    g_qhead, g_qtail, g_qcap;
static long      g_pending;              /* 已入队未处理完的目录数 */
static volatile long g_truncated;        /* 条目达上限 */
static volatile long g_stop;             /* 通知所有线程收工 */

/* 条目存储：TSV 行进大缓冲，另存"行首偏移 + 行长"（缓冲 realloc 后指针会失效，故存偏移） */
static char*    g_buf; static size_t g_buflen, g_bufcap;

static long long g_maxEntries = MAX_ENTRIES_DEFAULT;
static int       g_maxDepth   = MAX_DEPTH_DEFAULT;
static int       g_threads    = THREADS_DEFAULT;

static wchar_t** g_roots; static int g_rootCount;
static wchar_t*  g_home;

/* ======================== 宽字符辅助（ASCII 级大小写不敏感） ======================== */
static wchar_t wlow(wchar_t c) { return (c >= L'A' && c <= L'Z') ? c + 32 : c; }

static int wcieq(const wchar_t* a, const wchar_t* b) {
    while (*a && *b) { if (wlow(*a) != wlow(*b)) return 0; a++; b++; }
    return *a == *b;
}
static int wcinicmp(const wchar_t* a, const wchar_t* b, size_t n) {
    for (size_t i = 0; i < n; i++) {
        wchar_t ca = wlow(a[i]), cb = wlow(b[i]);
        if (ca != cb) return ca < cb ? -1 : 1;
        if (ca == 0) return 0;
    }
    return 0;
}
static int wciendswith(const wchar_t* s, const wchar_t* suf) {
    size_t ls = wcslen(s), lf = wcslen(suf);
    return ls >= lf && wcinicmp(s + ls - lf, suf, lf) == 0;
}
/* path 是否位于 root 之内（含相等）：ci 比较，root 后必须跟 '\' */
static int wcicovered(const wchar_t* path, const wchar_t* root) {
    size_t lr = wcslen(root), lp = wcslen(path);
    if (lp < lr || wcinicmp(path, root, lr) != 0) return 0;
    if (lp == lr) return 1;
    return path[lr] == L'\\' || path[lr] == L'/';
}

/* ======================== 跳过名单（与 indexer.js SKIP_DIRS 同步） ======================== */
static const wchar_t* SKIP_DIRS[] = {
    L"node_modules", L".git", L".svn", L".hg", L"__pycache__", L".pytest_cache",
    L".mypy_cache", L".idea", L".vs", L".gradle", L".m2", L".nuget", L".npm",
    L".yarn", L".pnpm-store", L".cargo", L".rustup", L"venv", L".venv",
    L"site-packages", L"dist-packages", L"vendor", L"coverage", L"target",
    L"build", L".next", L".nuxt", L".turbo",
    L"AppData", L"Application Data", L"Local Settings", L"SendTo", L"Recent",
    L"My Documents", L"Windows", L"Program Files", L"Program Files (x86)",
    L"ProgramData", L"Recovery", L"PerfLogs", L"System Volume Information",
    L"Temp", L"tmp", L"cache", L"Cache", L"Packages", L"Google", L"Microsoft",
    L"Docker", L"CrashDumps", L"MicrosoftEdgeBackups", NULL
};

static int isSkippedDirName(const wchar_t* name) {
    if (name[0] == L'$') return 1;                     /* $Recycle.Bin 等 */
    if (wciendswith(name, L".tmp")) return 1;
    for (int i = 0; SKIP_DIRS[i]; i++) if (wcieq(name, SKIP_DIRS[i])) return 1;
    return 0;
}
/* home 根目录下的额外规则：点目录（IDE/Agent 内部状态）与云同步缓存 */
static int isSkippedAtHomeLevel(const wchar_t* dir, const wchar_t* name) {
    if (!g_home) return 0;
    size_t lh = wcslen(g_home);
    if (wcinicmp(dir, g_home, lh) != 0 || dir[lh] != 0) return 0;   /* 仅当 dir == home */
    if (name[0] == L'.') return 1;
    if (wcieq(name, L"WPS Cloud")) return 1;
    return 0;
}
/* 已被排在前面的根覆盖（如 home ⊂ C:\）则跳过 */
static int isCoveredBefore(const wchar_t* path, int rootIdx) {
    for (int i = 0; i < rootIdx; i++)
        if (wcicovered(path, g_roots[i])) return 1;
    return 0;
}

/* ======================== 记录条目（TSV 行） ======================== */
static long long filetime_to_ms(const FILETIME* ft) {
    ULARGE_INTEGER li;
    li.LowPart = ft->dwLowDateTime; li.HighPart = ft->dwHighDateTime;
    if (li.QuadPart == 0) return 0;
    return (long long)(li.QuadPart / 10000ULL) - 11644473600000LL;
}

/* 存储：不按 NUL 结尾依赖，显式记长度（行内容可能出现任何字节） */
static size_t* g_lineOff;   /* 每行起始偏移 */
static size_t* g_lineLen;   /* 每行字节长度 */
static size_t  g_count, g_lineCap;

/* 调用处必须已持有 g_lock */
static void mark_truncated_locked(void) {
    g_truncated = 1; g_stop = 1;
    WakeAllConditionVariable(&g_cvWork);
}

static void record_locked(const char* line, size_t len) {
    if (g_count >= (size_t)g_maxEntries) { mark_truncated_locked(); return; }
    if (g_buflen + len + 1 > g_bufcap) {
        size_t nc = g_bufcap ? g_bufcap : (1u << 24);
        while (nc < g_buflen + len + 1) nc *= 2;
        char* p = (char*)realloc(g_buf, nc);
        if (!p) { mark_truncated_locked(); return; }
        g_buf = p; g_bufcap = nc;
    }
    if (g_count >= g_lineCap) {
        size_t nc = g_lineCap ? g_lineCap * 2 : (1u << 18);
        size_t* p1 = (size_t*)realloc(g_lineOff, nc * sizeof(size_t));
        size_t* p2 = (size_t*)realloc(g_lineLen, nc * sizeof(size_t));
        if (!p1 || !p2) {
            if (p1) g_lineOff = p1;
            if (p2) g_lineLen = p2;
            mark_truncated_locked();
            return;
        }
        g_lineOff = p1; g_lineLen = p2; g_lineCap = nc;
    }
    memcpy(g_buf + g_buflen, line, len);
    g_lineOff[g_count] = g_buflen;
    g_lineLen[g_count] = len;
    g_buflen += len;
    g_count++;
    if (g_count >= (size_t)g_maxEntries) mark_truncated_locked();
}

static void record(const wchar_t* path, unsigned long long size, long long mtime, int isdir) {
    char pathU8[PATH_W * 4 + 16];
    int n = WideCharToMultiByte(CP_UTF8, 0, path, -1, pathU8, (int)sizeof(pathU8) - 64, NULL, NULL);
    if (n <= 1) return;                                /* 转换失败（非法/超长路径） */
    int plen = n - 1;                                  /* 去掉结尾 NUL */

    char line[PATH_W * 4 + 64];
    memcpy(line, pathU8, (size_t)plen);
    int tail = snprintf(line + plen, sizeof(line) - (size_t)plen,
                        "\t%llu\t%lld\t%c\n", size, mtime, isdir ? '1' : '0');
    if (tail < 0 || (size_t)(plen + tail) >= sizeof(line)) return;
    size_t total = (size_t)plen + (size_t)tail;

    EnterCriticalSection(&g_lock);
    record_locked(line, total);
    LeaveCriticalSection(&g_lock);
}

/* ======================== 工作队列 ======================== */
static void queue_push(wchar_t* path /*接管所有权*/, int depth, int rootIdx) {
    EnterCriticalSection(&g_lock);
    if (g_stop) {
        LeaveCriticalSection(&g_lock);
        free(path);
        return;
    }
    if (g_qtail == g_qcap) {
        size_t nc = g_qcap ? g_qcap * 2 : 4096;
        wchar_t** p1 = (wchar_t**)realloc(g_qpath, nc * sizeof(wchar_t*));
        int* p2 = (int*)realloc(g_qdepth, nc * sizeof(int));
        int* p3 = (int*)realloc(g_qroot, nc * sizeof(int));
        if (!p1 || !p2 || !p3) {
            free(p1); free(p2); free(p3);
            mark_truncated_locked();
            LeaveCriticalSection(&g_lock);
            free(path);
            return;
        }
        g_qpath = p1; g_qdepth = p2; g_qroot = p3; g_qcap = nc;
    }
    g_qpath[g_qtail] = path; g_qdepth[g_qtail] = depth; g_qroot[g_qtail] = rootIdx;
    g_qtail++;
    g_pending++;
    WakeAllConditionVariable(&g_cvWork);
    LeaveCriticalSection(&g_lock);
}

/* ======================== 目录处理 ======================== */
static void process_dir(const wchar_t* dir, int depth, int rootIdx) {
    wchar_t pattern[PATH_W];
    size_t dl = wcslen(dir);
    if (dl == 0 || dl + 4 >= PATH_W) return;
    if (dir[0] == L'\\' && dir[1] == L'\\') return;    /* UNC 不支持（本工具用不到） */

    /* \\?\ 前缀：长路径 + 关闭路径规范化；dir 以 \ 结尾时不重复加分隔符 */
    if (dir[dl - 1] == L'\\' || dir[dl - 1] == L'/')
        _snwprintf(pattern, PATH_W - 1, L"\\\\?\\%s*", dir);
    else
        _snwprintf(pattern, PATH_W - 1, L"\\\\?\\%s\\*", dir);
    pattern[PATH_W - 1] = 0;

    WIN32_FIND_DATAW ffd;
    HANDLE h = FindFirstFileW(pattern, &ffd);
    if (h == INVALID_HANDLE_VALUE) return;

    wchar_t full[PATH_W];
    do {
        const wchar_t* name = ffd.cFileName;
        if (name[0] == L'.' && (name[1] == 0 || (name[1] == L'.' && name[2] == 0))) continue;
        if (ffd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;   /* junction/symlink 防循环 */

        /* 拼完整路径（输出用，不带 \\?\ 前缀） */
        size_t nl = wcslen(name);
        if (dl + nl + 2 >= PATH_W) continue;
        int endsSep = (dir[dl - 1] == L'\\' || dir[dl - 1] == L'/');
        if (endsSep) { wmemcpy(full, dir, dl); wmemcpy(full + dl, name, nl); full[dl + nl] = 0; }
        else { wmemcpy(full, dir, dl); full[dl] = L'\\'; wmemcpy(full + dl + 1, name, nl); full[dl + 1 + nl] = 0; }

        long long mtime = filetime_to_ms(&ffd.ftLastWriteTime);

        if (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (isSkippedDirName(name)) continue;
            if (isSkippedAtHomeLevel(dir, name)) continue;
            if (isCoveredBefore(full, rootIdx)) continue;
            record(full, 0, mtime, 1);
            if (depth + 1 <= g_maxDepth) {
                wchar_t* dup = (wchar_t*)malloc((wcslen(full) + 1) * sizeof(wchar_t));
                if (dup) { wcscpy(dup, full); queue_push(dup, depth + 1, rootIdx); }
            }
        } else {
            if (g_stop) break;
            unsigned long long sz =
                ((unsigned long long)ffd.nFileSizeHigh << 32) | ffd.nFileSizeLow;
            record(full, sz, mtime, 0);
        }
    } while (!g_stop && FindNextFileW(h, &ffd));
    FindClose(h);
}

static DWORD WINAPI worker(LPVOID arg) {
    (void)arg;
    for (;;) {
        EnterCriticalSection(&g_lock);
        while (g_qhead == g_qtail && g_pending > 0 && !g_stop)
            SleepConditionVariableCS(&g_cvWork, &g_lock, INFINITE);
        if (g_stop || g_qhead == g_qtail) { LeaveCriticalSection(&g_lock); break; }
        wchar_t* dir = g_qpath[g_qhead];
        int depth = g_qdepth[g_qhead];
        int rootIdx = g_qroot[g_qhead];
        g_qhead++;
        LeaveCriticalSection(&g_lock);

        process_dir(dir, depth, rootIdx);
        free(dir);

        EnterCriticalSection(&g_lock);
        g_pending--;
        if (g_pending == 0) WakeAllConditionVariable(&g_cvWork);
        LeaveCriticalSection(&g_lock);
    }
    return 0;
}

/* ======================== 排序与输出 ======================== */
/* order 数组存的是"条目下标"，比较时再用下标取偏移与长度 */
static int cmp_line(const void* a, const void* b) {
    size_t ia = *(const size_t*)a, ib = *(const size_t*)b;
    size_t la = g_lineLen[ia], lb = g_lineLen[ib];
    size_t n = la < lb ? la : lb;
    int r = memcmp(g_buf + g_lineOff[ia], g_buf + g_lineOff[ib], n);
    if (r) return r;
    return la < lb ? -1 : (la > lb ? 1 : 0);
}

/* 宽路径 → UTF-8 JSON 字符串（转义 \ 和 "），返回 malloc 的 char* */
static char* utf8_json_escape(const wchar_t* w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char* s = (char*)malloc((size_t)n * 2 + 4);
    if (!s) return NULL;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL);
    /* 原地展开转义：从后往前 */
    int len = n - 1;
    int need = 0;
    for (int i = 0; i < len; i++) if (s[i] == '\\' || s[i] == '"') need++;
    char* out = (char*)malloc((size_t)len + need + 1);
    if (!out) { free(s); return NULL; }
    int j = 0;
    for (int i = 0; i < len; i++) {
        if (s[i] == '\\' || s[i] == '"') out[j++] = '\\';
        out[j++] = s[i];
    }
    out[j] = 0;
    free(s);
    return out;
}

static wchar_t* wcdup(const wchar_t* s) {
    wchar_t* p = (wchar_t*)malloc((wcslen(s) + 1) * sizeof(wchar_t));
    if (p) wcscpy(p, s);
    return p;
}

int main(void) {
    int argcW = 0;
    wchar_t** argvW = CommandLineToArgvW(GetCommandLineW(), &argcW);
    if (!argvW) return 2;

    const wchar_t* outPath = NULL;
    for (int i = 1; i < argcW; i++) {
        if (wcieq(argvW[i], L"--out") && i + 1 < argcW) outPath = argvW[++i];
        else if (wcieq(argvW[i], L"--max-entries") && i + 1 < argcW) g_maxEntries = _wtoi(argvW[++i]);
        else if (wcieq(argvW[i], L"--max-depth") && i + 1 < argcW) g_maxDepth = _wtoi(argvW[++i]);
        else if (wcieq(argvW[i], L"--threads") && i + 1 < argcW) g_threads = _wtoi(argvW[++i]);
        else if (wcieq(argvW[i], L"--home") && i + 1 < argcW) g_home = wcdup(argvW[++i]);
        else if (wcieq(argvW[i], L"--roots")) {
            g_rootCount = argcW - i - 1;
            g_roots = (wchar_t**)malloc(sizeof(wchar_t*) * (g_rootCount > 0 ? g_rootCount : 1));
            for (int j = 0; j < g_rootCount; j++) g_roots[j] = wcdup(argvW[++i]);
        }
    }
    if (!outPath || g_rootCount <= 0) {
        fwprintf(stderr, L"usage: findidx.exe --out <file> [--max-entries N] [--max-depth N] [--threads N] --home <dir> --roots <dir>...\n");
        return 2;
    }
    if (g_threads < 1) g_threads = 1;
    if (g_threads > 32) g_threads = 32;

    InitializeCriticalSection(&g_lock);
    InitializeConditionVariable(&g_cvWork);

    ULONGLONG t0 = GetTickCount64();
    FILETIME ftNow;
    GetSystemTimeAsFileTime(&ftNow);
    long long builtAt = filetime_to_ms(&ftNow);

    /* 根目录条目 + 入队 */
    for (int i = 0; i < g_rootCount; i++) {
        WIN32_FILE_ATTRIBUTE_DATA fad;
        long long mtime = 0; int isdir = 1;
        if (GetFileAttributesExW(g_roots[i], GetFileExInfoStandard, &fad)) {
            mtime = filetime_to_ms(&fad.ftLastWriteTime);
            isdir = (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;
        }
        record(g_roots[i], 0, mtime, isdir);
        queue_push(wcdup(g_roots[i]), 0, i);
    }

    /* 启动工作线程 */
    HANDLE th[32];
    int nthreads = g_threads;
    for (int i = 0; i < nthreads; i++) {
        th[i] = CreateThread(NULL, 0, worker, NULL, 0, NULL);
        if (!th[i]) nthreads = i;
    }
    WaitForMultipleObjects((DWORD)nthreads, th, TRUE, INFINITE);
    for (int i = 0; i < nthreads; i++) CloseHandle(th[i]);

    /* 排序（按路径，与 Node 版 entries.sort(p) 一致）：order 存下标 */
    size_t* order = (size_t*)malloc((g_count ? g_count : 1) * sizeof(size_t));
    if (order) {
        for (size_t i = 0; i < g_count; i++) order[i] = i;
        qsort(order, g_count, sizeof(size_t), cmp_line);
    }

    /* 写出 TSV（二进制模式，LF 行尾与 Node saveCache 一致） */
    int outn = WideCharToMultiByte(CP_UTF8, 0, outPath, -1, NULL, 0, NULL, NULL);
    char* outU8 = (char*)malloc((size_t)outn);
    WideCharToMultiByte(CP_UTF8, 0, outPath, -1, outU8, outn, NULL, NULL);
    FILE* f = fopen(outU8, "wb");
    if (!f) {
        fwprintf(stderr, L"findidx: cannot open output file\n");
        return 3;
    }

    ULONGLONG tookMs = GetTickCount64() - t0;

    /* meta 行 */
    fputs("#{\"version\":1,\"engine\":\"native-c\",\"builtAt\":", f);
    fprintf(f, "%lld", builtAt);
    fputs(",\"tookMs\":", f);
    fprintf(f, "%llu", (unsigned long long)tookMs);
    fputs(",\"count\":", f);
    fprintf(f, "%llu", (unsigned long long)g_count);
    fputs(",\"truncated\":", f);
    fputs(g_truncated ? "true" : "false", f);
    fputs(",\"roots\":[", f);
    for (int i = 0; i < g_rootCount; i++) {
        if (i) fputs(",", f);
        char* r = utf8_json_escape(g_roots[i]);
        fputs("\"", f);
        fputs(r ? r : "", f);
        fputs("\"", f);
        free(r);
    }
    fputs("]}\n", f);

    for (size_t i = 0; i < g_count; i++) {
        size_t idx = order ? order[i] : i;
        const char* line = g_buf + g_lineOff[idx];
        fwrite(line, 1, g_lineLen[idx], f);
    }
    fclose(f);

    printf("OK count=%llu tookMs=%llu truncated=%s\n",
           (unsigned long long)g_count, (unsigned long long)tookMs,
           g_truncated ? "true" : "false");
    return 0;
}
