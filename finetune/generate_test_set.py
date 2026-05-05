import json

SYSTEM_PROMPT = "你是程序设计领域的AI助教，专注于帮助学生掌握编程知识和技能。熟悉C语言等主流编程语言，精通数据结构、算法、软件工程等核心知识。\n\n## 输入格式\n每条用户消息固定包含以下三部分（某部分为\"空\"表示未提供）：\n- 用户问题：用户的核心诉求\n- 用户提供的代码：用户选中的代码片段\n- 参考文档：从知识库检索的相关文档\n\n## 回答要求\n1. 优先依据参考文档作答，文档不足或不相关时基于专业知识回答\n2. 代码不为空时，结合代码实际情况分析问题，将文档知识与代码对应\n3. 简洁精准，直接回答核心问题\n4. 必要时提供完整可运行的代码示例（用代码块包裹）\n5. 使用简洁中文，专业术语保留英文原文"

def make_entry(question, code, docs, answer):
    user_content = f"用户问题：{question}"
    user_content += f"\n\n用户提供的代码：\n{code}" if code else "\n\n用户提供的代码：空"
    user_content += f"\n\n参考文档：\n{docs}" if docs else "\n\n参考文档：空"
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": answer}
        ]
    }

data = []

# 测试集：与训练集不同的问题，用于评估微调效果

data.append(make_entry(
    "我的程序输出了奇怪的值，有时候是负数有时候是很大的正数",
    "unsigned int a = 3;\nunsigned int b = 5;\nint diff = a - b;\nprintf(\"diff = %d\\n\", diff);",
    None,
    "`a - b` 是 `3 - 5 = -2`，但 `a` 和 `b` 都是 `unsigned int`，运算结果也是 `unsigned`，变成 `4294967294`。赋给 `int diff` 时发生实现定义行为，通常变成 `-2`，但这不可移植。\n\n**修复：** 至少一个操作数用有符号类型\n```c\nint diff = (int)a - (int)b;\n```\n\n**原则：** 避免无符号和有符号混用运算，特别是减法。循环变量与 `size_t` 比较时也要注意。"
))

data.append(make_entry(
    "这段代码有什么问题？",
    "int *p = realloc(ptr, new_size);\nif (!p) { /* 分配失败 */ }\n// 使用p...",
    None,
    "如果 `realloc` 失败返回 `NULL`，原始 `ptr` 仍然有效，但你丢失了对它的引用（`p` 是NULL，`ptr` 如果之前被覆盖就找不回了），导致内存泄漏。\n\n**正确写法：**\n```c\nint *tmp = realloc(ptr, new_size);\nif (!tmp) {\n    free(ptr);  // 失败时仍可释放原内存\n    return;\n}\nptr = tmp;  // 成功后再赋值\n```\n\n**关键：** 用临时指针接收 `realloc` 返回值，检查成功后再赋给原指针。"
))

data.append(make_entry(
    "如何实现一个循环缓冲区？",
    None,
    None,
    "```c\ntypedef struct {\n    int *buf;\n    int cap;\n    int head;\n    int tail;\n    int count;\n} RingBuf;\n\nRingBuf ringbuf_new(int cap) {\n    RingBuf rb;\n    rb.buf = malloc(cap * sizeof(int));\n    rb.cap = cap;\n    rb.head = rb.tail = rb.count = 0;\n    return rb;\n}\n\nint ringbuf_push(RingBuf *rb, int val) {\n    if (rb->count == rb->cap) return -1;  // 满\n    rb->buf[rb->tail] = val;\n    rb->tail = (rb->tail + 1) % rb->cap;\n    rb->count++;\n    return 0;\n}\n\nint ringbuf_pop(RingBuf *rb, int *out) {\n    if (rb->count == 0) return -1;  // 空\n    *out = rb->buf[rb->head];\n    rb->head = (rb->head + 1) % rb->cap;\n    rb->count--;\n    return 0;\n}\n```\n\n**要点：** 取模实现循环；`count` 区分满和空；入队出队均O(1)。"
))

data.append(make_entry(
    "如何理解C语言的内存模型？栈、堆、数据段分别是什么？",
    None,
    None,
    "C程序内存布局（从低地址到高地址）：\n\n```\n┌──────────┐ 低地址\n│  代码段   │ 可执行指令（只读）\n├──────────┤\n│  数据段   │ 已初始化全局/静态变量\n├──────────┤\n│  BSS段    │ 未初始化全局/静态变量（自动清零）\n├──────────┤\n│  堆       │ malloc分配，向上增长\n│    ↓      │\n├──────────┤\n│    ↑      │\n│  栈       │ 局部变量，向下增长\n├──────────┤\n│ 命令行参数 │\n└──────────┘ 高地址\n```\n\n**栈：** 自动管理，函数返回即释放，速度快但空间有限（通常1-8MB）\n**堆：** 手动管理（malloc/free），空间大但需防泄漏\n**数据段/BSS：** 全局生命周期，程序结束才释放\n\n**常见问题：** 栈溢出（递归太深/VLA太大）、堆泄漏（忘记free）、返回栈地址（悬垂指针）。"
))

data.append(make_entry(
    "如何实现一个简单的线程池？",
    None,
    "POSIX线程（pthread）是C语言多线程编程的标准接口。关键函数：pthread_create创建线程、pthread_join等待线程、pthread_mutex_lock/unlock互斥锁、pthread_cond_wait/signal条件变量。线程池模式：预先创建固定数量工作线程，通过任务队列分发工作。",
    "根据参考文档，用 pthread 实现简单线程池：\n\n```c\n#include <pthread.h>\n\ntypedef struct Task { void (*fn)(void *); void *arg; struct Task *next; } Task;\n\ntypedef struct {\n    Task *head, *tail;\n    pthread_mutex_t lock;\n    pthread_cond_t cond;\n    int shutdown;\n} ThreadPool;\n\nvoid *worker(void *arg) {\n    ThreadPool *pool = arg;\n    while (1) {\n        pthread_mutex_lock(&pool->lock);\n        while (!pool->head && !pool->shutdown)\n            pthread_cond_wait(&pool->cond, &pool->lock);\n        if (pool->shutdown) { pthread_mutex_unlock(&pool->lock); return NULL; }\n        Task *t = pool->head;\n        pool->head = t->next;\n        if (!pool->head) pool->tail = NULL;\n        pthread_mutex_unlock(&pool->lock);\n        t->fn(t->arg);\n        free(t);\n    }\n}\n\nvoid pool_submit(ThreadPool *pool, void (*fn)(void *), void *arg) {\n    Task *t = malloc(sizeof(Task));\n    t->fn = fn; t->arg = arg; t->next = NULL;\n    pthread_mutex_lock(&pool->lock);\n    if (pool->tail) pool->tail->next = t;\n    else pool->head = t;\n    pool->tail = t;\n    pthread_cond_signal(&pool->cond);\n    pthread_mutex_unlock(&pool->lock);\n}\n```\n\n**核心：** 互斥锁保护任务队列；条件变量通知工作线程；shutdown标志优雅退出。"
))

data.append(make_entry(
    "这段代码有什么问题？",
    "char buf[10];\nsprintf(buf, \"%s:%d\", hostname, port);",
    None,
    "**缓冲区溢出风险**。如果 `hostname` 很长或 `port` 数字很大，可能超过9个字符+`\\0`的限制。\n\n**修复：用snprintf**\n```c\nchar buf[10];\nsnprintf(buf, sizeof(buf), \"%s:%d\", hostname, port);\n```\n\n`snprintf` 保证不越界，结果被截断也不会溢出。\n\n**安全函数对照：**\n- `sprintf` → `snprintf`\n- `strcpy` → `strncpy` 或 `strlcpy`\n- `strcat` → `strncat` 或 `snprintf` 追加\n- `gets` → `fgets`（永远不用gets）"
))

data.append(make_entry(
    "如何实现一个简单的词频统计程序？",
    None,
    None,
    "```c\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <ctype.h>\n\n#define TABLE_SIZE 1024\n\ntypedef struct Entry {\n    char word[64];\n    int count;\n    struct Entry *next;\n} Entry;\n\nEntry *table[TABLE_SIZE] = {0};\n\nunsigned hash(const char *s) {\n    unsigned h = 5381;\n    while (*s) h = h * 33 + (unsigned char)*s++;\n    return h % TABLE_SIZE;\n}\n\nvoid count_word(const char *w) {\n    unsigned idx = hash(w);\n    Entry *e = table[idx];\n    while (e) {\n        if (strcmp(e->word, w) == 0) { e->count++; return; }\n        e = e->next;\n    }\n    e = malloc(sizeof(Entry));\n    strncpy(e->word, w, 63);\n    e->word[63] = '\\0';\n    e->count = 1;\n    e->next = table[idx];\n    table[idx] = e;\n}\n\nvoid print_counts(void) {\n    for (int i = 0; i < TABLE_SIZE; i++)\n        for (Entry *e = table[i]; e; e = e->next)\n            printf(\"%4d %s\\n\", e->count, e->word);\n}\n```\n\n**设计：** 哈希表+链地址法；`count_word` 查找或插入；时间O(n)平均。"
))

data.append(make_entry(
    "C语言中如何处理可变参数函数？",
    None,
    None,
    "用 `<stdarg.h>` 中的宏：\n\n```c\n#include <stdarg.h>\n#include <stdio.h>\n\nint sum(int count, ...) {\n    va_list ap;\n    va_start(ap, count);\n    int total = 0;\n    for (int i = 0; i < count; i++)\n        total += va_arg(ap, int);\n    va_end(ap);\n    return total;\n}\n\n// 使用\nint result = sum(3, 10, 20, 30);  // 60\n```\n\n**步骤：** `va_start` 初始化 → `va_arg` 逐个获取 → `va_end` 清理\n\n**注意：**\n1. 必须有某种方式知道参数个数（如 `printf` 用格式字符串，`sum` 用count参数）\n2. `va_arg` 的类型必须与实际类型匹配\n3. `char`/`short` 会提升为 `int`，`float` 提升为 `double`"
))

data.append(make_entry(
    "这段代码有什么问题？",
    "int *arr = malloc(n * sizeof(int));\nif (n > 0) {\n    arr[0] = 1;\n}",
    None,
    "虽然检查了 `n > 0` 再使用数组，但没有检查 `malloc` 是否成功。如果 `malloc` 返回 `NULL`，即使 `n > 0`，`arr[0] = 1` 也会崩溃。\n\n**修复：**\n```c\nint *arr = malloc(n * sizeof(int));\nif (!arr) { fprintf(stderr, \"malloc failed\\n\"); exit(1); }\nif (n > 0) arr[0] = 1;\n```\n\n**另一个隐患：** 如果 `n` 很大，`n * sizeof(int)` 可能整数溢出，`malloc` 分配的内存比预期小。可用 `calloc` 避免溢出：`calloc(n, sizeof(int))`。"
))

data.append(make_entry(
    "如何实现字符串去重？",
    "char str[] = \"programming\";",
    None,
    "```c\n#include <string.h>\n\nvoid remove_duplicates(char *s) {\n    int len = strlen(s);\n    int tail = 1;\n    for (int i = 1; i < len; i++) {\n        int j;\n        for (j = 0; j < tail; j++)\n            if (s[j] == s[i]) break;\n        if (j == tail) s[tail++] = s[i];\n    }\n    s[tail] = '\\0';\n}\n```\n\n**算法：** 维护一个不重复的尾部，每个字符检查是否已在尾部出现。时间O(n²)。\n\n**优化：** 如果字符集有限（如ASCII），用布尔数组记录已出现字符，O(n)：\n```c\nvoid remove_duplicates_fast(char *s) {\n    int seen[256] = {0};\n    int tail = 0;\n    for (int i = 0; s[i]; i++)\n        if (!seen[(unsigned char)s[i]])\n            s[tail++] = s[i], seen[(unsigned char)s[i]] = 1;\n    s[tail] = '\\0';\n}\n```"
))

data.append(make_entry(
    "如何理解C语言的预处理阶段？#include、#define、#ifdef分别做什么？",
    None,
    None,
    "预处理在编译之前执行，处理所有 `#` 开头的指令：\n\n**#include：** 文本替换，把头文件内容插入当前位置\n```c\n#include <stdio.h>    // 系统头文件\n#include \"myheader.h\"  // 用户头文件\n```\n\n**#define：** 宏定义，文本替换\n```c\n#define MAX 100              // 常量\n#define SQUARE(x) ((x)*(x))  // 带参数宏\n```\n\n**#ifdef/#ifndef：** 条件编译\n```c\n#ifdef DEBUG\n    printf(\"debug info\\n\");\n#endif\n\n#ifndef HEADER_H\n#define HEADER_H\n// 头文件内容\n#endif\n```\n\n**常用预定义宏：** `__FILE__`（文件名）、`__LINE__`（行号）、`__DATE__`、`__TIME__`\n\n**注意：** 宏只是文本替换，没有类型检查，容易出bug。能用 `const`/`enum`/`inline` 替代的就别用宏。"
))

data.append(make_entry(
    "如何实现一个简单的JSON解析器？",
    None,
    None,
    "递归下降解析器是最清晰的方式：\n\n```c\ntypedef enum { JSON_NULL, JSON_NUM, JSON_STR, JSON_ARR, JSON_OBJ } JsonType;\n\ntypedef struct JsonVal {\n    JsonType type;\n    double num;\n    char *str;\n    struct JsonVal *child;\n    struct JsonVal *next;\n    char *key;\n} JsonVal;\n\n// 核心解析函数\nJsonVal *parse_value(const char **p);  // 根据首字符分派\nJsonVal *parse_string(const char **p); // 解析 \"...\"\nJsonVal *parse_number(const char **p); // 解析数字\nJsonVal *parse_array(const char **p);  // 解析 [...]\nJsonVal *parse_object(const char **p); // 解析 {...}\n```\n\n**解析流程：** 跳过空白 → 看首字符 → 分派到对应解析函数\n- `{` → object，逐个解析 key:value\n- `[` → array，逐个解析 value\n- `\"` → string，处理转义\n- 数字 → number\n- `null`/`true`/`false` → 对应类型\n\n**建议：** 生产环境用 cJSON、jansson 等成熟库。"
))

data.append(make_entry(
    "这段代码有什么问题？",
    "void copy_data(int *dst, int *src, int n) {\n    for (int i = 0; i < n; i++)\n        dst[i] = src[i];\n}",
    "如果src和dst指向的内存区域有重叠，memmove可以正确处理，而memcpy不能保证。当dst > src且两者重叠时，从前往后复制会覆盖尚未读取的数据。memmove会检测重叠并选择复制方向。",
    "根据参考文档，如果 `dst` 和 `src` 指向的内存有重叠，你的代码可能出错。例如 `dst = src + 3` 时，从前往后复制会覆盖尚未读取的数据。\n\n**修复：** 使用 `memmove`（安全处理重叠）：\n```c\nvoid copy_data(int *dst, int *src, int n) {\n    memmove(dst, src, n * sizeof(int));\n}\n```\n\n**memcpy vs memmove：**\n- `memcpy`：不处理重叠，可能更快\n- `memmove`：处理重叠，略慢但安全\n\n**规则：** 源和目标可能重叠时用 `memmove`；确定不重叠时用 `memcpy`。"
))

data.append(make_entry(
    "如何实现一个简单的命令行菜单系统？",
    None,
    None,
    "```c\n#include <stdio.h>\n#include <string.h>\n\ntypedef void (*MenuHandler)(void);\n\ntypedef struct {\n    const char *key;\n    const char *desc;\n    MenuHandler handler;\n} MenuItem;\n\nvoid cmd_help(void) { printf(\"Available commands: help, list, quit\\n\"); }\nvoid cmd_list(void) { printf(\"Item 1, Item 2, Item 3\\n\"); }\nvoid cmd_quit(void) { printf(\"Bye!\\n\"); }\n\nMenuItem menu[] = {\n    {\"help\", \"Show help\", cmd_help},\n    {\"list\", \"List items\", cmd_list},\n    {\"quit\", \"Exit program\", cmd_quit},\n};\n#define MENU_SIZE (sizeof(menu)/sizeof(menu[0]))\n\nint main(void) {\n    char input[64];\n    while (1) {\n        printf(\"> \");\n        if (!fgets(input, sizeof(input), stdin)) break;\n        input[strcspn(input, \"\\n\")] = '\\0';\n        for (size_t i = 0; i < MENU_SIZE; i++)\n            if (strcmp(input, menu[i].key) == 0) { menu[i].handler(); break; }\n    }\n    return 0;\n}\n```\n\n**设计：** 函数指针数组+描述，易扩展；`fgets` 安全读取输入。"
))

data.append(make_entry(
    "这段代码有什么问题？",
    "int x = 1;\nswitch (x) {\n    case 1:\n        int y = 10;\n        printf(\"y = %d\\n\", y);\n        break;\n    case 2:\n        printf(\"y = %d\\n\", y);  // y可能未初始化\n        break;\n}",
    None,
    "在 `switch` 的 `case` 中直接声明变量是危险的。跳转到 `case 2` 时，`y` 的声明被跳过，但编译器可能不报错。\n\n**修复：用大括号限制作用域**\n```c\nswitch (x) {\n    case 1: {\n        int y = 10;\n        printf(\"y = %d\\n\", y);\n        break;\n    }\n    case 2:\n        // y不可访问\n        break;\n}\n```\n\n**规则：** 每个 `case` 块用 `{}` 包裹，避免变量作用域问题。编译加 `-Wjump-misses-init` 可检测。"
))

data.append(make_entry(
    "如何实现一个简单的定时器？",
    None,
    "C标准库中clock()函数返回程序执行的CPU时间：clock_t clock(void)，除以CLOCKS_PER_SEC得到秒数。对于实际时间，可用time()函数：time_t time(time_t *tloc)返回当前日历时间。更高精度可用gettimeofday（POSIX）或QueryPerformanceCounter（Windows）。",
    "根据参考文档，不同精度的定时方式：\n\n**1. 秒级（标准C）**\n```c\n#include <time.h>\ntime_t start = time(NULL);\n// 执行操作...\ndouble elapsed = difftime(time(NULL), start);\n```\n\n**2. 毫秒级（POSIX）**\n```c\n#include <sys/time.h>\nstruct timeval tv;\ngettimeofday(&tv, NULL);\nlong ms = tv.tv_sec * 1000 + tv.tv_usec / 1000;\n```\n\n**3. CPU时间（标准C）**\n```c\nclock_t start = clock();\n// 执行操作...\ndouble cpu_time = (double)(clock() - start) / CLOCKS_PER_SEC;\n```\n\n**注意：** `clock()` 测量CPU时间（不含sleep），`time()` 测量实际时间。性能测试优先用CPU时间。"
))

with open("fine_tune_test_set_c_programming.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"测试集生成完成，共 {len(data)} 条")
