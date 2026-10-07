/**
 * dsh-session-menu-delete — Host half.
 *
 * 给侧栏会话行 “...” 菜单里的「删除会话」提供真正的删除动作：
 *   1. 会话工件目录（<dshHome>/sessions/<slug>/<sessionId>/）
 *   2. 投影缓存记录（<dshHome>/storages/session_projcache/sessions/<id>.json）
 *   3. 工作区账本里的归属（workspaceRegistry 的 sessionIds）
 *   4. 归档 / 置顶集合里的该 id
 *   5. 该会话派生出的**子代理会话**（级联，见下）
 *
 * 级联规则（只认子代理，绝不碰分叉）：
 *   子代理会话是独立落盘的会话工件，header 带 `origin: 'subagent'` +
 *   `parentSession` + `delegationDepth >= 1`，与父会话平级放在同一个 slug 目录里。
 *   不级联就会留下"父会话没了、子代理还在"的孤儿（还会作为独立行出现在列表里）。
 *   因此删除时扫描全部会话 header，顺着 `origin === 'subagent'` 的血缘递归收集后代
 *   （子代理还能再起子代理），先删后代再删自己。
 *   用户主动 **fork** 出来的会话同样有 `parentSession` 但没有 `origin`，
 *   一律不删 —— 那是独立对话，不是运行时产物。
 *
 * 附件孤儿清理（/attachments/*）：
 *   附件是**内容寻址**的独立对象（<dshHome>/attachments/v1/objects/<前2位>/<sha256>），
 *   删会话只摘引用、不动物件，于是会攒下没人引用的孤儿。清理走四条安全规则：
 *     1. **每次删除都重新判定**，绝不复用上一次扫描的陈旧结论；单份工件的解压结果
 *        按 `(size, mtimeNs, ctimeNs, ino)` 缓存 —— 四者全等则内容必然没变，
 *        引用集合也就必然没变（推导见 `artifactIdentity`）。这是确定性判定，
 *        不是"新鲜度窗口"那种概率性保护。
 *     2. 结构化解析 `attachmentId`（含 tool/result 里的图片），不做文本匹配；
 *     3. 引用集合取**两个来源的并集**：活会话的内存事件（`sessions.list()` →
 *        `ownEvents()`，覆盖未落盘的引用）+ 磁盘日志（覆盖已落盘的、含 fork 的 seed）；
 *     4. 顺手清理只碰「引用者**全部**落在本次被删集合内」的对象 ——
 *        被 fork 副本或其它会话共享的一律不动。
 *   扫描分两阶段：先只问「待删的这批会话引用过什么」（只读它们自己的工件），
 *   候选为空就直接收工；候选非空才去证明「集合外没人还在用」。
 *   第一阶段**只会少删、不会误删** —— 判断错了也顶多留下孤儿。
 *   删除是**直删，没有回收站**：能走到这一步的对象，最后一个引用者刚刚消失，
 *   没有回流路径需要它。代价是误判不可恢复，所以四条规则一条都不能省。
 *
 * 其余设计约束：
 *   - 账本改动一律走 workspaceRegistry 的**公开** API（entity.detachSession、
 *     archiveSession/unarchiveSession/unpinSession），不直接改 workspace.json，
 *     也不碰未发布的 requireState/setState —— 否则 DSH 的内存态会在下一次写盘时
 *     把手改的内容覆盖回去。
 *   - 会话仍持有活 Agent 时，按 DSH 自己的 dispose 顺序摘除：
 *     cancel({kind:'disposed'}) → await whenIdle() → scope.dispose()；
 *     任一步超时即**中止删除**（不留半死状态），然后才动文件。
 *   - 不可逆的账本变更放在文件删除**之后**：rm 失败时账本未动，会话照常可见、可重试。
 *   - 目录定位只认「会话根 / 一层 slug / 会话 id」结构，杜绝路径拼接越界。
 *   - 所有对内部服务的访问都窄化取值：版本差异下取不到就跳过对应步骤。
 *   - 删改类端点必须带 `x-dsh-plugin-call: 1`；带 Origin 的浏览器请求再走
 *     `connection.requestRejection`（插件路由不经 DSH 的鉴权网关）。
 */
import { readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

export const name = "dsh-session-menu-delete";

export const inject = ["webServer", "workspaceRegistry"];

const API_PREFIX = "/session-menu-delete/api";
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 自定义请求头：删改类端点一律要求它。
 * 自定义头必然触发 CORS 预检，而本服务端不返回任何 CORS 响应头 —— 预检失败，
 * 网页就发不出这个请求；本机脚本/命令行补上即可，零成本。
 */
const CALL_HEADER = "x-dsh-plugin-call";
const CALL_HEADER_VALUE = "1";
/** 浏览器发起的请求会带 Origin；这类请求额外走 DSH 自己的 Host/Origin 围栏 + 会话 cookie 校验。 */
const BROWSER_MARKER_HEADER = "origin";

/** 活体摘除的等待上限默认值；可由插件 config 覆盖（bundle patch 的 `config:` 字段）。 */
const DEFAULT_IDLE_TIMEOUT_MS = 8000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读取请求头，同时兼容 Node 的 `IncomingMessage.headers` 与 Fetch 的 `Headers`。 */
const headerOf = (req, name) => {
  const headers = req?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
};

/**
 * 带超时的等待，**区分**三种结局：
 *   `"done"`     在超时内完成；
 *   `"rejected"` 被拒绝（收尾本身失败，例如 agent driver reject）；
 *   `"timeout"`  超时。
 * 早先把"拒绝"和"超时"合并成一个 false，于是 whenIdle 真 reject 时会报"超时"，误导排查。
 */
const settleWithin = async (operation, ms) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(() => "done", () => "rejected"),
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise("timeout"), ms); })
    ]);
  } catch {
    return "rejected";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const fail = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

/**
 * 与 DSH 的 `dsh-home-paths` 保持同语义：先展开 `~`，再绝对化。
 *
 * DSH 侧是 `resolve(expandHomePath(configured ?? $DSH_HOME ?? ~/.dsh))`。
 * 早先这里只做 `trim()`，于是 `DSH_HOME="~/dsh"` 时 DSH 用 `<home>/dsh`、
 * 本插件却拼出相对路径 —— 会对着**另一个目录**执行递归删除并回报成功。
 * 空白串两边都当未设置（一致）。
 */
const expandHomePath = (path) => {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
};

const resolveDshHome = () => {
  const fromEnv = process.env.DSH_HOME;
  const raw = typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv : join(homedir(), ".dsh");
  return resolve(expandHomePath(raw));
};

/** zstd 支持按需加载：运行时没有就退化为"读不到内容"，相关功能保守降级。 */
let zstdApi;
const zstd = async () => {
  if (zstdApi === undefined) {
    try {
      const zlib = await import("node:zlib");
      zstdApi = {
        create: typeof zlib.createZstdDecompress === "function" ? zlib.createZstdDecompress : undefined,
        sync: typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : undefined
      };
    } catch {
      zstdApi = { create: undefined, sync: undefined };
    }
  }
  return zstdApi;
};

/** 只解压到第一个换行就停：工件的第一帧就是 header 行，不必展开整份日志。 */
const readZstdHeaderLine = async (file) => {
  const api = await zstd();
  if (api.create === undefined) return undefined;
  return new Promise((resolve) => {
    let settled = false;
    let stream;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { stream?.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    try {
      stream = createReadStream(file).pipe(api.create());
    } catch {
      return finish(undefined);
    }
    // StringDecoder：按 UTF-8 边界解码。直接用 chunk.toString("utf8") 会在
    // 分块边界切断多字节字符（header 里的 cwd 可能是中文路径），
    // JSON.parse 失败后整条会话会**静默**从血缘图里消失 -> 级联漏删子代理。
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { finish(JSON.parse(buffer.slice(0, newline))); }
      catch { finish(undefined); }
    });
    stream.on("error", () => finish(undefined));
    stream.on("end", () => {
      if (settled) return;
      buffer += decoder.end();
      const line = buffer.split("\n")[0];
      if (line.trim() === "") return finish(undefined);
      try { finish(JSON.parse(line)); }
      catch { finish(undefined); }
    });
  });
};

/** 未压缩工件（session.v4.jsonl）的首行 header。 */
const readFirstJsonLine = async (file) => {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { finish(JSON.parse(buffer.slice(0, newline))); }
      catch { finish(undefined); }
    });
    stream.on("error", () => finish(undefined));
    stream.on("end", () => finish(undefined));
  });
};

/**
 * 一个会话目录里的**规范**工件名：`session.jsonl`（第 0 代）或 `session.v<N>.jsonl`，
 * 可带 `.zstd` 后缀（与 DSH `dsh-session-format` 的 CANONICAL_LOG_FILENAME 一致）。
 */
const CANONICAL_ARTIFACT_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/**
 * 选出该读哪个工件。
 *
 * DSH 会**保留历史格式世代**（README：“retains immutable historical format
 * generations”；迁移只发布新世代，从不删被取代的那份），所以同一目录里
 * 可能同时存在 `session.jsonl` 与 `session.v4.jsonl.zstd`。
 * DSH 自己的规则是**取最高版本**（`resolveGenerationInDirectory` 里
 * `generations.sort((l, r) => r.version - l.version)[0]`），这里照抄，
 * 而不是像早先那样按 readdir 顺序取第一个（NTFS 上 v0 会排在 v4 前面）。
 *
 * 正则与 DSH 的 `CANONICAL_LOG_FILENAME` 一致：**不带 `i`**（DSH 只认小写名）。
 * 同一版本若两种编码并存，DSH 会直接 `throw encodingMismatch`；这里退化为
 * **确定性优先 `.zstd`**（当前世代格式），而不是交给 readdir 顺序。
 * 非规范名（历史/异常命名）退化为排序后取第一个，保证确定性。
 */
const pickSessionArtifact = (files) => {
  const generations = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    const match = CANONICAL_ARTIFACT_RE.exec(file.name);
    if (match === null) continue;
    generations.push({
      name: file.name,
      version: match[1] === undefined ? 0 : Number(match[1]),
      zstd: match[2] !== undefined
    });
  }
  if (generations.length === 0) {
    return files
      .filter((file) => file.isFile() && /\.(zstd|jsonl)$/i.test(file.name))
      .map((file) => file.name)
      .sort()[0];
  }
  generations.sort((left, right) => right.version - left.version
    || Number(right.zstd) - Number(left.zstd)
    || left.name.localeCompare(right.name));
  return generations[0].name;
};

/**
 * 读出整份会话日志文本（多帧 zstd 或未压缩 jsonl）。
 *
 * DSH 的工件是多帧 zstd，而 Node 的解压只吃一帧，所以按 magic 切帧；
 * magic 又可能恰好出现在压缩数据内部，于是对每一帧做**试探式**解压：
 * 失败就把窗口扩到下一个 magic，直到解开或到文件末尾。
 */
const readSessionLogText = async (file) => {
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return undefined;
  }
  if (file.toLowerCase().endsWith(".jsonl")) return buffer.toString("utf8");

  const api = await zstd();
  if (api.sync === undefined) return undefined;

  const parts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (start === -1) break;
    let end = buffer.indexOf(ZSTD_MAGIC, start + 4);
    if (end === -1) end = buffer.length;

    let decoded;
    for (;;) {
      try { decoded = api.sync(buffer.subarray(start, end)); break; }
      catch {
        const next = buffer.indexOf(ZSTD_MAGIC, end + 4);
        if (next === -1) {
          if (end === buffer.length) break; // 到末尾仍解不开 -> 放弃这一帧
          end = buffer.length;
        } else {
          end = next;
        }
      }
    }
    if (decoded !== undefined) parts.push(decoded);
    cursor = end;
  }
  return Buffer.concat(parts).toString("utf8");
};

/** 递归收集任意嵌套结构里的 attachmentId（`sha256:…` 前缀会被剥掉）。 */
const harvestAttachmentRefs = (node, out) => {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) harvestAttachmentRefs(item, out);
    return out;
  }
  const id = node.attachmentId;
  if (typeof id === "string" && id !== "") out.add(id.replace(/^sha256:/i, "").toLowerCase());
  for (const value of Object.values(node)) harvestAttachmentRefs(value, out);
  return out;
};

export function apply(ctx, config = {}) {
  const home = resolveDshHome();
  const sessionsRoot = join(home, "sessions");
  const projectionCacheDir = join(home, "storages", "session_projcache", "sessions");
  const attachmentsRoot = join(home, "attachments", "v1", "objects");
  // 活体摘除的等待上限：可由 bundle patch 的 config 覆盖，也便于测试真正走到超时分支。
  const idleTimeoutMs = Number.isFinite(config?.idleTimeoutMs) && config.idleTimeoutMs >= 0
    ? config.idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS;
  const disposeTimeoutMs = Number.isFinite(config?.disposeTimeoutMs) && config.disposeTimeoutMs >= 0
    ? config.disposeTimeoutMs
    : DEFAULT_DISPOSE_TIMEOUT_MS;

  const warn = (message) => {
    try { ctx.logger?.warn?.(`session-menu-delete: ${message}`); } catch { /* 日志失败不影响流程 */ }
  };
  const info = (message) => {
    try { ctx.logger?.info?.(`session-menu-delete: ${message}`); } catch { /* ignore */ }
  };

  /** 服务访问：cordis 的属性代理在未声明 inject 时会抛错，所以一律窄化取值。 */
  const service = (key) => {
    try {
      if (typeof ctx.get === "function") {
        const found = ctx.get(key);
        if (found !== undefined) return found;
      }
    } catch { /* 未注册或未就绪 */ }
    try { return ctx[key]; } catch { return undefined; }
  };

  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 32 * 1024) throw fail("请求体过大", "bad-request");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  /** 会话目录名就是会话 id；只在会话根下的一层 slug 目录里找。 */
  const locateSessionDir = async (sessionId) => {
    let slugs;
    try {
      slugs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const candidate = join(sessionsRoot, slug.name, sessionId);
      try {
        const details = await stat(candidate);
        if (details.isDirectory()) return candidate;
      } catch { /* 该 slug 下没有就继续 */ }
    }
    return undefined;
  };

  /** 扫全部会话工件首行，得到 id → { parentSession, origin, dir }。读不到就跳过该条。 */
  const scanLineage = async () => {
    const lineage = new Map();
    let slugs;
    try {
      slugs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return lineage;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const slugDir = join(sessionsRoot, slug.name);
      let sessions;
      try {
        sessions = await readdir(slugDir, { withFileTypes: true });
      } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const dir = join(slugDir, session.name);
        let files;
        try {
          files = await readdir(dir, { withFileTypes: true });
        } catch { continue; }
        const artifact = pickSessionArtifact(files);
        if (artifact === undefined) continue;
        const header = artifact.toLowerCase().endsWith(".zstd")
          ? await readZstdHeaderLine(join(dir, artifact))
          : await readFirstJsonLine(join(dir, artifact));
        if (header === null || typeof header !== "object") continue;
        const id = typeof header.id === "string" && header.id !== "" ? header.id : session.name;
        lineage.set(id, {
          id,
          dir,
          parentSession: typeof header.parentSession === "string" && header.parentSession !== ""
            ? header.parentSession
            : undefined,
          origin: header.origin === "subagent" ? "subagent" : undefined,
          delegationDepth: typeof header.delegationDepth === "number" ? header.delegationDepth : undefined
        });
      }
    }
    return lineage;
  };

  /**
   * 收集 rootId 派生的全部**子代理**会话（含多层委派）。
   * 血缘图里只放 origin === 'subagent' 的会话，所以 fork 出来的会话
   * （有 parentSession、无 origin）永远不会被收进来。
   */
  const collectSubagentDescendants = async (rootId) => {
    let lineage;
    try {
      lineage = await scanLineage();
    } catch (error) {
      warn(`血缘扫描失败，退化为只删目标会话: ${error?.message ?? error}`);
      return [];
    }
    const childrenOf = new Map();
    for (const row of lineage.values()) {
      if (row.origin !== "subagent") continue;
      const parent = row.parentSession;
      if (parent === undefined || parent === row.id) continue;
      const bucket = childrenOf.get(parent);
      if (bucket === undefined) childrenOf.set(parent, [row.id]);
      else bucket.push(row.id);
    }
    const found = [];
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const child of childrenOf.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
    return found;
  };

  //#region 附件孤儿清理

  /**
   * 收集 hash → Set(会话 id) 的真实引用。
   *
   * 两个来源**都要算**，缺一不可：
   *
   *   1. **活会话的内存事件**（`sessions.list()` → `session.ownEvents()`）——
   *      未落盘的引用在这里可见，而且几乎零成本（纯对象遍历，不解压、不解析 JSON）。
   *   2. **磁盘上的会话日志**——已经落盘的引用（含 fork 的 seed 历史）。
   *
   * 只看磁盘会有**结构性盲区**：一个仍存活、刚看过某张图、引用还没 flush 的会话
   * 在磁盘上不可见，于是「引用者是否全部落在被删集合内」会被误判成「是」，
   * 把活会话还要用的对象删掉（`Attachment object is missing.` 就是这么来的）。
   * 补上内存来源之后这个盲区就关闭了 —— 这才是判据成立的关键。
   *
   * 两个来源对同一 (hash, 会话) 取并集，天然幂等。
   */
  /**
   * 工件引用索引的进程内缓存：工件文件路径 -> { key, hashes }。
   *
   * 为什么按 `(size, mtimeNs, ctimeNs, ino)` 判定「没变」是**确定性**的：
   * DSH 对会话工件只有三种写法（`dsh-session-persistence-jsonl`）——
   *   · 追加 `appendLines`（open "a"）     -> size 必增；
   *   · 截断 `rollbackAppend` / `repair`  -> size 必减；
   *   · 首次创建 `materializeWin32`       -> 目标必须**不存在**（rejectExistingLog）。
   * 没有任何一条路径会用等长内容原地替换已有工件；即便真发生等长重写，
   * mtime/ctime 也必然更新（本机实测过）。四个字段全等 => 内容未变 => 引用集合未变。
   *
   * 缓存实例建在 `apply()` 内部：一个 ctx 一份，测试里多次 `apply()` 不会互相串。
   * 上限只为防止长期运行下 Map 无限增长（条目本身很小，几个 hash 而已）。
   */
  const ARTIFACT_CACHE_LIMIT = 1024;
  const artifactRefCache = new Map();

  /** 工件身份键；文件不存在或属性读不到时返回 undefined（一律当作 miss）。 */
  const artifactIdentity = async (file) => {
    try {
      const info = await stat(file, { bigint: true });
      if (!info.isFile()) return undefined;
      return `${info.size}|${info.mtimeNs}|${info.ctimeNs}|${info.ino}`;
    } catch {
      return undefined;
    }
  };

  /**
   * 扫一个工件文件的引用集合，走缓存。
   *
   * 顺序是**先 stat 再 read**，这一点不能反：
   *   反过来就成了「读到 stat 之前的内容、却按 stat 之后的身份缓存」——
   *   下一次命中会回吐一份**少报**的旧结果，而少报是危险方向（会删掉在用的附件）。
   *   按现在的顺序，读的当口若文件被追加，缓存键指向的是更旧的身份 -> 下次必然 miss。
   * 读完再 stat 一次：两次身份不同说明期间文件被改过，结果仍然可用，但不入缓存。
   */
  const scanArtifactRefs = async (file) => {
    const before = await artifactIdentity(file);
    if (before === undefined) return undefined;

    const hit = artifactRefCache.get(file);
    if (hit !== undefined && hit.key === before) return hit.hashes;

    const hashes = new Set();
    const text = await readSessionLogText(file);
    if (text !== undefined && text.includes("attachmentId")) {
      for (const line of text.split("\n")) {
        if (line === "" || !line.includes("attachmentId")) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        for (const hash of harvestAttachmentRefs(row, new Set())) hashes.add(hash);
      }
    }

    const after = await artifactIdentity(file);
    if (after !== undefined && after === before) {
      if (artifactRefCache.size >= ARTIFACT_CACHE_LIMIT) artifactRefCache.clear();
      artifactRefCache.set(file, { key: before, hashes });
    }
    return hashes;
  };

  /**
   * 收集 hash -> Set(会话 id) 的真实引用。
   *
   * `options.only` 给定时只统计这些会话（内存源按 `session.id`、磁盘源按目录名，
   * 两者在 DSH 里恒等）—— 用于「待删的这批引用过什么」这一阶段，
   * 其余会话的历史一个字节都不读。
   */
  const collectAttachmentReferences = async (options = {}) => {
    const only = options.only;
    const refs = new Map();
    const addReference = (hash, owner) => {
      let owners = refs.get(hash);
      if (owners === undefined) {
        owners = new Set();
        refs.set(hash, owners);
      }
      owners.add(owner);
    };

    // ---- 来源 1：活会话的内存事件 -----------------------------------------
    const sessions = service("sessions");
    if (sessions !== undefined && typeof sessions.list === "function") {
      let live = [];
      try { live = sessions.list() ?? []; } catch { live = []; }
      for (const session of live) {
        const owner = typeof session?.id === "string" && session.id !== "" ? session.id : undefined;
        if (owner === undefined) continue;
        if (only !== undefined && !only.has(owner)) continue;
        let events = [];
        try {
          if (typeof session.ownEvents === "function") events = session.ownEvents() ?? [];
        } catch { events = []; }
        for (const event of events) {
          for (const hash of harvestAttachmentRefs(event, new Set())) addReference(hash, owner);
        }
      }
    }

    // ---- 来源 2：磁盘上的会话日志 -----------------------------------------
    let slugs;
    try {
      slugs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return refs; // 磁盘读不到也要保住内存来源的结果
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const slugDir = join(sessionsRoot, slug.name);
      let sessions;
      try {
        sessions = await readdir(slugDir, { withFileTypes: true });
      } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        if (only !== undefined && !only.has(session.name)) continue;
        const dir = join(slugDir, session.name);
        let files;
        try {
          files = await readdir(dir, { withFileTypes: true });
        } catch { continue; }
        for (const file of files) {
          if (!file.isFile()) continue;
          const lower = file.name.toLowerCase();
          if (!lower.endsWith(".zstd") && !lower.endsWith(".jsonl")) continue;
          const hashes = await scanArtifactRefs(join(dir, file.name));
          if (hashes === undefined) continue;
          for (const hash of hashes) addReference(hash, session.name);
        }
      }
    }
    return refs;
  };

  const listAttachmentObjects = async () => {
    const objects = [];
    let shards;
    try {
      shards = await readdir(attachmentsRoot, { withFileTypes: true });
    } catch {
      return objects;
    }
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(attachmentsRoot, shard.name);
      let files;
      try {
        files = await readdir(shardDir, { withFileTypes: true });
      } catch { continue; }
      for (const file of files) {
        if (!file.isFile()) continue;
        const full = join(shardDir, file.name);
        let details;
        try {
          details = await stat(full);
        } catch { continue; }
        objects.push({
          hash: file.name.toLowerCase(),
          file: full,
          sizeBytes: details.size,
          mtimeMs: details.mtimeMs
        });
      }
    }
    return objects;
  };

  /**
   * 每次调用都**重新**解析引用，绝不复用上一次的结果 ——
   * 孤儿的身份会在两次扫描之间改变（附件是内容寻址的，"看一眼"就产生引用）。
   *
   * 零引用的对象就是孤儿，当场可清。
   */
  const surveyAttachments = async () => {
    const refs = await collectAttachmentReferences();
    const objects = await listAttachmentObjects();
    const orphans = [];
    let referenced = 0;
    for (const object of objects) {
      const owners = refs.get(object.hash);
      if (owners !== undefined && owners.size > 0) {
        referenced += 1;
        continue;
      }
      orphans.push(object);
    }
    return { objects, referenced, orphans };
  };

  const describe = (object) => ({
    hash: object.hash,
    sizeBytes: object.sizeBytes,
    ageMinutes: Math.round((Date.now() - object.mtimeMs) / 60000)
  });

  /** confirm !== true 时只预览；确认后直接删掉孤儿（没有回收站）。 */
  const cleanOrphanAttachments = async (options = {}) => {
    const survey = await surveyAttachments();
    const summary = {
      dryRun: options.confirm !== true,
      totalObjects: survey.objects.length,
      referenced: survey.referenced,
      orphanCount: survey.orphans.length,
      orphanBytes: survey.orphans.reduce((sum, object) => sum + object.sizeBytes, 0),
      orphans: survey.orphans.map(describe),
      removed: []
    };
    if (options.confirm !== true || survey.orphans.length === 0) return summary;

    const result = await removeAttachmentObjects(survey.orphans);
    summary.removed = result.removed;
    info(`attachments: removed ${summary.removed.length}/${survey.orphans.length} orphans`);
    return summary;
  };

  /**
   * 分片目录空了就删掉。
   * objects/<前2位>/<哈希> 这层壳不会自己消失：每清一次就会在 objects/ 下多留几个空目录，
   * 在文件管理器里看起来就是"一堆空文件夹"。
   */
  const pruneEmptyShards = async (shards) => {
    for (const shard of shards) {
      try {
        // rmdir 对非空目录直接失败（ENOTEMPTY）—— 这正是要的：早先是
        // 「readdir 判空 -> rm -r」，两步之间若有别的会话往这个分片写入新对象，
        // rm -r 会把它一起删掉；rmdir 没有这个窗口。
        await rmdir(shard);
      } catch { /* 目录不见了、或里面还有东西 —— 都不是错误 */ }
    }
  };

  /**
   * 删掉一批附件对象。**没有回收站** —— 删就是删。
   *
   * 之所以敢直删：能走到这里的对象，其"最后一个引用者"刚刚消失（会话已删、或判定为孤儿），
   * 没有回流路径需要它们。删除前的一切判定都在调用方完成，这里只负责落地 + 收尾空分片目录。
   */
  const removeAttachmentObjects = async (objects) => {
    if (objects.length === 0) return { removed: [] };
    const removed = [];
    const touchedShards = new Set();
    for (const object of objects) {
      // 先 stat 确认它在：`rm(..., {force:true})` 对不存在的路径不报错，
      // 不能拿"没抛异常"当"删掉了"（与 removeProjectionRecord 同一原则）。
      try {
        await stat(object.file);
      } catch {
        continue;
      }
      try {
        await rm(object.file, { force: true });
        removed.push(object.hash);
        touchedShards.add(dirname(object.file));
      } catch (error) {
        warn(`附件删除失败 ${object.hash}: ${error?.message ?? error}`);
      }
    }
    await pruneEmptyShards(touchedShards);
    return { removed };
  };

  /**
   * 找出"引用者全部落在 doomed 集合内"的附件 —— 即随这批会话一起失去最后引用的那些。
   * 只要还被集合外的任何一个会话引用着就不动它：fork 副本共享的图正是靠这条活下来的。
   *
   * 引用集合有两个来源（活会话内存事件 + 磁盘日志），所以「仍然存活、刚看过这张图、
   * 但引用还没落盘」的会话是**可见**的 —— 早先只看磁盘时的那个结构性盲区已关闭。
   *
   * 判定为独享就立刻删。
   */
  const collectDoomedAttachments = async (doomed) => {
    /*
     * 第一阶段：只问「待删的这批会话引用过什么」。
     *
     * 磁盘来源被 `only` 限制成这几个会话自己的工件，其余会话的历史一个字节都不读；
     * 活会话的内存事件同样只取 doomed 里的那几个。
     *
     * 候选为空 => 不存在「引用者非空且全部落在 doomed 内」的对象 => 没有任何东西可删，
     * 直接收工。这是删「没引用过附件的会话」时的常态，省掉对全部历史的那次重扫。
     * 注意这一步**只会少删、不会误删**：即便过滤条件判断错了导致候选为空，
     * 结果也只是留下孤儿，而不是删掉在用的对象。
     */
    const candidates = await collectAttachmentReferences({ only: doomed });
    if (candidates.size === 0) return { objects: [] };

    // 第二阶段：候选非空，才需要证明「集合外没人还在用」。判据与早先完全一致。
    const refs = await collectAttachmentReferences();
    const objects = await listAttachmentObjects();
    const picked = [];
    for (const object of objects) {
      const owners = refs.get(object.hash);
      if (owners === undefined || owners.size === 0) continue; // 本来就没人引用 -> 归独立清理管
      let exclusive = true;
      for (const owner of owners) {
        if (!doomed.has(owner)) { exclusive = false; break; }
      }
      if (!exclusive) continue;                                // 还有别人在用 -> 绝不碰
      picked.push(object);
    }
    return { objects: picked };
  };

  //#endregion

  /**
   * 补发 `agent/disposed` —— 逐字照抄 DSH 的 `AgentRegistry.emitDisposed`。
   *
   * **必须带 carrier**：该事件声明为 `this: Scoped<Agent>`。cordis 的 dispatch 只在
   * `args[0]` 是对象时才把它当 thisArg；若像早先那样写 `ctx.emit("agent/disposed", { agent })`
   * （字符串打头 → `thisArg = null`），dispatch 会**先**同步触发 `internal/dispatch`，
   * 而 `dsh-scope` 的 invariant 对"无 carrier 的 scoped 事件"直接 `fail`（抛异常）
   * —— 结果是**一个监听者都收不到**，而 store 条目已经摘了，这条边就永久丢失
   * （正是本函数要避免的伤害）。carrier 就在 entry 上：`agents.enter()` 存的
   * `scopeTarget(agent, agent)`。
   *
   * 另外 DSH 对每个 listener 单独 try/catch；`ctx.emit` 没有这层保护，
   * 一个 listener 抛错会吃掉它后面所有 listener，所以这里也照抄。
   */
  const emitAgentDisposed = (entry) => {
    const events = ctx.events;
    if (events === undefined || typeof events.dispatch !== "function") {
      warn(`agent/disposed 未补发：ctx.events 不可用（${entry.id}）`);
      return;
    }
    if (entry.carrier === undefined) {
      warn(`agent/disposed 未补发：store 条目上没有 carrier（${entry.id}）`);
      return;
    }
    // dispatch 会就地消费 args 的前两项（carrier 与事件名），剩下的就是 payload。
    const args = [entry.carrier, "agent/disposed", { agent: entry.agent }];
    let callbacks;
    try { callbacks = events.dispatch("emit", args); }
    catch (error) {
      warn(`agent/disposed 派发失败 ${entry.id}: ${error?.message ?? error}`);
      return;
    }
    for (const callback of callbacks) {
      try {
        const returned = callback(...args);
        Promise.resolve(returned).catch((error) => {
          warn(`agent/disposed 监听者拒绝 ${entry.id}: ${error?.message ?? error}`);
        });
      } catch (error) {
        warn(`agent/disposed 监听者抛错 ${entry.id}: ${error?.message ?? error}`);
      }
    }
  };

  /**
   * 把 agent 从注册表里摘掉。
   *
   * 正规路径是 `agents.enter()` 返回的 detach 闭包，而它只交给 owner fiber，
   * 插件拿不到（`scope.dispose()` 并不会触发它 —— DSH 自己的 dispose 也是
   * 先 `scope.dispose()` 再显式 `detachAgent?.()`）。
   *
   * 所以这里做等价的两件事：先摘 store，再补发配对的 `agent/disposed`。
   * 只对 `announced === true` 的条目补发，与 `detachEntered` 的
   * `if (!entry.announced) return;` 保持一致。**必须补发**：`detachEntered` 开头是
   * `if (this.store.get(entry.id) !== entry) return;`，一旦我们先摘了 store，
   * 这条边就**永久**发不出去了 —— 下游（goal-round-driver / schedule /
   * subagent / file-reference / agent-team 等）的状态会一直收不到它。
   */
  const unregisterAgent = (agent) => {
    const agents = service("agents");
    const store = agents?.store;
    if (!(store instanceof Map)) return false;
    const entry = store.get(agent.id);
    if (entry === undefined || entry.agent !== agent) return false;
    // 与 DSH 的 `detachEntered` **同序**：先摘 store，再发事件。
    // 顺序不能反 —— 监听者在 `agent/disposed` 里查 `agents.get(id)` 时
    // 必须已经查不到这个 agent（那正是该事件的语义）。
    store.delete(agent.id);
    if (entry.announced === true) emitAgentDisposed(entry);
    return true;
  };

  /**
   * 摘掉 sessions store 里的条目 —— 这一步会发出**正确的** `session/disposed`
   * （`detachEntered` -> `emitDisposed`，带真实 Session 与 carrier）。
   *
   * `sessions.enter()` 返回的 disposer 会尊重 `announcing`/`appending` 延迟
   * （置 `detachRequested` 等 dispatch 结束），直接调 `entry.detach()` 不会。
   * 早先这里只是 `await sleep(200)` 赌一把；现在按 DSH 自己的条件轮询等待。
   */
  const detachSessionEntry = async (sessionId, attempts = 40, intervalMs = 50) => {
    const sessions = service("sessions");
    const store = sessions?.store;
    if (!(store instanceof Map)) return false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const entry = store.get(sessionId);
      if (entry === undefined) return false;
      if (!entry.announcing && !entry.appending) {
        if (typeof entry.detach !== "function") return false;
        entry.detach();
        return true;
      }
      await sleep(intervalMs);
    }
    warn(`会话 ${sessionId} 的 store 条目仍在 announcing/appending，未摘除`);
    return false;
  };

  /**
   * 按 DSH 自己的顺序把一个仍活着的会话摘下来。
   *
   * 对齐 `dsh-agent-loop` 的 `AgentHandle.dispose()`：
   *   `machine.cancel({ kind: "disposed" })` -> `await machine.whenIdle()`
   *   -> `await machine.scope.dispose()` -> `handle.close()`
   *   -> `detachAgent?.()` / `detachSession?.()`
   *
   * 早先漏了 `whenIdle()`，还把 `scope.dispose()` 和 3 秒超时赛跑、超时后照删文件 ——
   * 等于在 loop 还在收尾时拆 scope、在句柄还没关时 rm（Windows 上就是 EPERM/EBUSY）。
   * 现在等 idle 与拆 scope 各自有超时，**任一超时就抛错中止整个删除**：
   * 宁可报错让用户重试，也不留"文件删了一半 / 账本摘了文件还在"的半死状态。
   */
  const retireLiveSession = async (sessionId) => {
    let wasLive = false;
    let detachedLive = false;

    const agents = service("agents");
    if (agents !== undefined && typeof agents.get === "function") {
      let agent;
      try { agent = agents.get(sessionId); } catch { agent = undefined; }
      if (agent !== undefined) {
        wasLive = true;
        try { agent.cancel?.({ kind: "disposed" }); } catch { /* 已停止 */ }

        const idle = typeof agent.whenIdle === "function"
          ? await settleWithin(agent.whenIdle(), idleTimeoutMs)
          : "done";
        if (idle !== "done") {
          throw fail(idle === "timeout"
            ? `会话 ${sessionId} 收尾超时（whenIdle 超过 ${idleTimeoutMs}ms），已中止删除`
            : `会话 ${sessionId} 收尾失败（whenIdle 被拒绝，agent 可能已出错），已中止删除`, "busy");
        }

        const scope = agent.scope;
        if (scope !== undefined && typeof scope.dispose === "function") {
          const disposal = await settleWithin(scope.dispose(), disposeTimeoutMs);
          if (disposal !== "done") {
            throw fail(disposal === "timeout"
              ? `会话 ${sessionId} 的 scope 拆解超时（超过 ${disposeTimeoutMs}ms），已中止删除`
              : `会话 ${sessionId} 的 scope 拆解被拒绝，已中止删除`, "busy");
          }
        }

        unregisterAgent(agent);
      }
    }

    const sessions = service("sessions");
    if (sessions !== undefined) {
      const session = typeof sessions.get === "function" ? sessions.get(sessionId) : undefined;
      if (session !== undefined && typeof sessions.flush === "function") {
        // flush 抛错 = 落盘失败；此时删文件会丢掉还没写下去的事件 -> 中止。
        // 返回 false 只表示"没有 durability 监听者参与"（例如从未落盘的空会话），
        // 那不是错误，不能拿来当中止条件。
        try {
          await sessions.flush(session);
        } catch (error) {
          throw fail(`会话 ${sessionId} 落盘失败，已中止删除: ${error?.message ?? error}`, "busy");
        }
      }
      // 摘掉 store 条目会发出**正确的** `session/disposed`（带真实 Session 与 carrier）。
      detachedLive = await detachSessionEntry(sessionId);
    }
    return { wasLive, detachedLive };
  };

  const detachFromWorkspaces = async (sessionId) => {
    const registry = ctx.workspaceRegistry;
    // 窄化取值：服务缺失就跳过这一步（离线工具用 mock ctx 跑同一条代码路径时正是这种情形），
    // 不让"账本摘不掉"升级成"整个删除失败"。
    if (registry === undefined || registry === null || typeof registry.list !== "function") return 0;
    let detached = 0;
    for (const entity of registry.list()) {
      const ids = Array.isArray(entity.sessionIds) ? entity.sessionIds : [];
      if (!ids.includes(sessionId)) continue;
      try {
        await entity.detachSession(sessionId);
        detached += 1;
      } catch (error) {
        warn(`工作区账本摘除失败 ${sessionId}: ${error?.message ?? error}`);
      }
    }
    return detached;
  };

  /**
   * 读删除前的归档 / 置顶状态，供失败回滚使用。
   * 取不到（服务缺失或 getter 不存在）就返回 `undefined` —— 不猜，宁可放弃回滚。
   */
  const readSetState = (sessionId) => {
    const registry = ctx.workspaceRegistry;
    if (registry === undefined || registry === null) return undefined;
    try {
      const archived = registry.archivedSessionIds;
      const pinned = registry.pinnedSessionIds;
      if (!Array.isArray(archived) || !Array.isArray(pinned)) return undefined;
      return { archived: archived.includes(sessionId), pinned: pinned.includes(sessionId) };
    } catch {
      return undefined;
    }
  };

  /**
   * 删除失败时把归档 / 置顶恢复到删前状态。
   *
   * `archiveSession` 会在同一次写入里 `pinnedSessionIds.filter(id => id !== sessionId)`
   * （DSH 的"归档即摘 pin"语义），所以插件摘集合时用户原来的置顶就没了；
   * 若随后 `rm` 失败，会话还在盘上、还在侧栏，置顶却永久消失 —— 删除失败不该顺手改偏好。
   * 先恢复 pin 再恢复 archive（`pinSession` 对已归档会话会抛错，顺序不能反）。
   */
  const restoreSetState = async (sessionId, before) => {
    if (before === undefined) return;
    const registry = ctx.workspaceRegistry;
    if (registry === undefined || registry === null) return;
    try {
      if (before.pinned && typeof registry.pinSession === "function") await registry.pinSession(sessionId);
      if (before.archived && typeof registry.archiveSession === "function") {
        await registry.archiveSession(sessionId, { stopActivity: false });
      }
    } catch (error) {
      warn(`恢复归档/置顶状态失败 ${sessionId}: ${error?.message ?? error}`);
    }
  };

  /**
   * 停掉该会话的一切在途活动，并把它从归档 / 置顶集合里摘干净。
   *
   * 走**公开** API：`archiveSession(id, { stopActivity: true })` 是 DSH 自己
   * 「停止会话工作」的受支持入口 —— 它先持久化归档集（`agent/pre-step` 闸门读的正是它，
   * 所以每次唤醒都已被挡住），再经 `workspace/session-stop` waterfall 通知各 provider
   * （dsh-agent 的 turn、jobs、schedule、subagent、workspace、desktop-host）；
   * 并在同一次写入里顺带摘掉 pin。随后 `unarchiveSession` 去掉归档集里的 id，
   * `unpinSession` 兜底 —— 两者都明确"不做存在性检查"，传已删 id 安全且幂等。
   *
   * 早先是直接 `requireState/setState` 手改状态（这三个方法都没发布在服务目录里），
   * 而且没有任何 try/catch —— 一旦抛错会在"已摘 agent、已摘账本"之后中断整个删除。
   * 现在每一步独立容错，失败只记日志。
   *
   * 必须在删文件**之前**调用：`archiveSession` 要求会话仍"known"（live 或持久化）。
   *
   * 已知小缺口：`archiveSession` 对**已经在归档集合里**的会话会提前返回（不重复发停活信号）。
   * 这是可接受的 —— 归档本身就是"隐藏并挡住唤醒"的状态，一个已归档的会话按定义已经不在活动；
   * 且这种情形下随后仍会执行 unarchive/unpin，集合不会残留。
   */
  const stopActivityAndForget = async (sessionId, before = undefined) => {
    const registry = ctx.workspaceRegistry;
    if (registry === undefined || registry === null) return { stopped: false, forgotten: false };

    let stopped = false;
    // 已归档的会话：DSH 的 `archiveSession` 第一行就 `return`（**不**重复发
    // `workspace/session-stop`），所以这里不能谎报 stopped=true。
    if (before?.archived !== true && typeof registry.archiveSession === "function") {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
        stopped = true;
      } catch (error) {
        warn(`停止会话活动失败 ${sessionId}: ${error?.message ?? error}`);
      }
    }

    let forgotten = false;
    for (const name of ["unarchiveSession", "unpinSession"]) {
      if (typeof registry[name] !== "function") continue;
      try {
        await registry[name](sessionId);
        forgotten = true;
      } catch (error) {
        warn(`${name} 失败 ${sessionId}: ${error?.message ?? error}`);
      }
    }
    return { stopped, forgotten };
  };

  /**
   * 删投影缓存记录。
   * @returns 是否**真的删掉了一个文件** —— 注意 `rm(..., {force:true})` 对不存在的路径
   * 不报错，所以不能拿"没抛异常"当"删掉了"；先 stat 确认它在，删不存在就老实返回 false。
   * （stat 与 rm 之间有理论竞态：期间被别人删掉会多报一次 true，无害，不值得为它加锁。）
   */
  const removeProjectionRecord = async (sessionId) => {
    const file = join(projectionCacheDir, `${sessionId}.json`);
    try {
      await stat(file);
    } catch {
      return false;
    }
    try {
      await rm(file, { force: true });
      return true;
    } catch (error) {
      warn(`投影缓存清理失败 ${sessionId}: ${error?.message ?? error}`);
      return false;
    }
  };

  /**
   * 删一个会话：摘活体 → 停活并清集合 → 删工件 → 清缓存 → 摘账本 → 通知客户端。
   *
   * 顺序是刻意的。早先是「先摘账本、再删文件」，于是 rm 一旦失败就留下
   * **最坏的状态**：会话从账本里没了、文件还在 —— 而会话列表是「工件扫描 ∪ 内存 store」，
   * 重启后这个会话会重新出现在侧栏，并被启动对账重新挂回工作区。
   * 现在把不可逆的账本变更放在文件删除**之后**：
   *   - retire 失败 -> 抛错，什么都没动；
   *   - rm 失败    -> 抛错，账本未动（会话照常可见，可重试）；
   *   - 账本摘除   -> 最后一步，且逐个 entity 容错。
   * 「停活 + 清归档/置顶集合」放在 rm 之前是必须的（archiveSession 要求会话仍 known），
   * 但它是可逆且良性的：即便随后 rm 失败，会话也只是变成"未归档、未置顶"的一致状态。
   */
  const removeOne = async (sessionId) => {
    const { wasLive, detachedLive } = await retireLiveSession(sessionId);
    // 摘除后重新定位：空白会话可能在 flush 时刚落盘第一个工件。
    const dir = await locateSessionDir(sessionId);

    // 删前记录归档/置顶状态：删除失败时要恢复回去（见下面的 catch）。
    const setStateBefore = readSetState(sessionId);
    const { stopped, forgotten } = await stopActivityAndForget(sessionId, setStateBefore);

    let filesRemoved = false;
    if (dir !== undefined) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        // 文件没删掉 -> 会话照常存在，但上面已经把它从归档/置顶集合里摘了。
        // 恢复到删前状态，别让"删失败"顺手改掉用户偏好。
        await restoreSetState(sessionId, setStateBefore);
        throw error;
      }
      filesRemoved = true;
    }
    const cacheRemoved = await removeProjectionRecord(sessionId);
    const detached = await detachFromWorkspaces(sessionId);

    /*
     * 让所有已连接的客户端丢掉这一行。
     *
     * 真实链路：`api-session/removed` -> dsh-api-session-controller 的
     * `ctx.remote.$on("api-session/removed", id => sessions.handleSessionRemoved(id))`
     * -> 客户端摘要消失 -> 侧栏（工作区成员 ∩ 摘要）里那一行随之消失。
     *
     * ⚠️ 为什么**不再**自己发 `session/disposed`：
     *   1. 那个事件声明为 `this: Scoped<Session>`，必须带 carrier；插件拿不到 carrier
     *      （`scopeTarget` 是 dsh-session 的内部函数）。无 carrier 派发会先触发
     *      `internal/dispatch`，被 dsh-scope 的 invariant 直接 fail —— 一个监听者都收不到；
     *   2. 活会话本来就会由 `entry.detach()` 发出**正确**的那一个（带真实 Session
     *      与 carrier），我们再发一次纯属多余；
     *   3. 冷会话（或 live 条目没摘成）需要的只是"通知客户端这一行没了"，
     *      而那正是 `api-session/removed` 的语义 —— 该事件**没有** scoped 声明
     *      （`'api-session/removed'(sessionId: SessionId): void`），无需 carrier。
     */
    if (!detachedLive) {
      try { ctx.emit?.("api-session/removed", sessionId); }
      catch (error) { warn(`api-session/removed 派发失败 ${sessionId}: ${error?.message ?? error}`); }
    }

    info(`removed ${sessionId} (files=${filesRemoved}, cache=${cacheRemoved}, detached=${detached}, `
      + `wasLive=${wasLive}, stopped=${stopped}, forgotten=${forgotten})`);
    return { sessionId, filesRemoved, cacheRemoved, detached, wasLive, stopped, forgotten };
  };

  const deleteSession = async (sessionId, options = {}) => {
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      throw fail("会话 id 不合法", "bad-request");
    }

    const cascade = options.cascade !== false;
    const descendants = cascade ? await collectSubagentDescendants(sessionId) : [];
    if (descendants.length > 0) {
      info(`cascade: ${sessionId} 派生 ${descendants.length} 个子代理会话 -> ${descendants.join(", ")}`);
    }

    // 必须在删之前算：会话日志一没，"谁引用过什么"就无从得知了。
    // doomed 含级联的子代理 —— 父与子代理共同引用、外面又没人引用的附件，也要跟着走。
    const doomed = new Set([sessionId, ...descendants]);
    let owned = { objects: [] };
    if (options.attachments !== false) {
      try {
        owned = await collectDoomedAttachments(doomed);
      } catch (error) {
        warn(`附件归属扫描失败，跳过顺手清理: ${error?.message ?? error}`);
      }
    }

    // 先删后代，再删自己：父会话消失后子代理就成了无主孤儿。
    const cascadeResults = [];
    const cascadeFailed = [];
    for (const childId of descendants) {
      try {
        cascadeResults.push(await removeOne(childId));
      } catch (error) {
        // 子代理没删掉就必须报出来：它现在是无主孤儿，静默会让调用方以为级联完整。
        cascadeFailed.push({ sessionId: childId, error: error?.message ?? String(error) });
        warn(`级联删除子代理 ${childId} 失败: ${error?.message ?? error}`);
      }
    }
    const self = await removeOne(sessionId);

    // 会话没了，这些对象才真正失去最后引用 —— 现在删掉（没有回收站）。
    let attachmentsRemoved = 0;
    if (owned.objects.length > 0) {
      const removedResult = await removeAttachmentObjects(owned.objects);
      attachmentsRemoved = removedResult.removed.length;
      info(`attachments: ${attachmentsRemoved} 个会话独享附件已删除`);
    }

    return {
      ...self,
      cascadeRemoved: cascadeResults.length,
      cascadeIds: cascadeResults.map((row) => row.sessionId),
      cascadeFailed,
      attachmentsRemoved
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        /*
         * ---- 访问控制（两层，必须最先执行）--------------------------------
         *
         * 1) 必须带自定义头 `x-dsh-plugin-call: 1`。
         *    自定义头**必然**触发 CORS 预检，而本服务端不返回任何 CORS 响应头，
         *    于是预检失败、浏览器根本发不出这个请求 —— 网页侧被彻底拦死，
         *    而本机脚本/命令行补一个头即可（零成本）。
         *
         * 2) 浏览器发起的请求（带 Origin）再走 DSH 自己的 Host/Origin 围栏
         *    + 会话 cookie 校验（`connection.requestRejection`：跨站/异源 403，
         *    未认证 401）。本机脚本不带 Origin，因此不受影响。
         *
         * 背景：插件自己的 prefix 路由**不经** DSH 的鉴权网关（那层闸门写在
         * client-connection 自己的 `/api` 路由内部），所以必须自己补上。
         * 放在 URL 解析之前：任何请求（包括畸形 URL）都得先过闸门。
         */
        if (headerOf(req, CALL_HEADER) !== CALL_HEADER_VALUE) {
          return send(res, 403, {
            ok: false,
            code: "forbidden",
            error: `缺少请求头 ${CALL_HEADER}: ${CALL_HEADER_VALUE}`
          });
        }
        /*
         * Host/Origin 围栏是**无条件**的：DSH 自己的注释写着
         * "The Host fence binds every request, browser-looking or not"，
         * 它自己的 `/api` 路由也是对每个请求 `connection.admit(req)`。
         *
         * ⚠️ 早先这里把整段条件化到"带 Origin"的请求上 —— 那是错的，而且是个真漏洞：
         * DNS-rebinding 页面与目标**同源**，不触发 CORS 预检、可自由设置自定义头，
         * 而同源 GET 又不带 Origin → 围栏被整个跳过，响应还能被那个页面读走
         * （`Host: evil.com` 照过）。可读走 `/health`（DSH home 绝对路径）、
         * `/lineage`（会话 id）、`/attachments/orphans`（附件 hash，还会触发全量日志扫描）。
         *
         * 所以拆开处理：
         *   - `403`（Host/Origin 围栏失败）**一律执行** —— 纯请求头判定，与 cookie 无关；
         *   - `401`（浏览器会话未认证）只对浏览器发起的请求执行，否则本机脚本
         *     （本来就没有 cookie）会被误伤。
         */
        const connection = service("connection");
        if (connection !== undefined && typeof connection.requestRejection === "function") {
          let rejection;
          try { rejection = connection.requestRejection(req); } catch { rejection = undefined; }
          const browserRequest = headerOf(req, BROWSER_MARKER_HEADER) !== undefined;
          if (rejection === 403 || (rejection === 401 && browserRequest)) {
            return send(res, rejection, {
              ok: false,
              code: "forbidden",
              error: rejection === 401
                ? "浏览器会话未通过校验"
                : "请求未通过 Host/Origin 围栏"
            });
          }
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || "/"
          : "/";

        const readJson = async () => {
          const raw = await readBody(req);
          if (raw.trim() === "") return {};
          try { return JSON.parse(raw); }
          catch { throw fail("请求体不是合法 JSON", "bad-request"); }
        };

        if (req.method === "GET" && path === "/health") {
          return send(res, 200, {
            ok: true,
            result: {
              home,
              sessionsRoot,
              projectionCacheDir,
              attachmentsRoot,
              cascade: true,
              attachments: true,
              attachmentsCascade: true,
              attachmentsRecoverable: false,
              // 只管 attachments/v1/objects（图片对象）。file-objects/ 与 files/ 下的
              // 文件类附件本插件不清理 —— 如实回显，别让调用方以为"附件都管了"。
              attachmentKinds: ["image-objects"],
              callHeader: CALL_HEADER
            }
          });
        }

        if (req.method === "GET" && path === "/lineage") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          if (!SESSION_ID_RE.test(sessionId)) return send(res, 400, { ok: false, error: "sessionId 不合法" });
          const descendants = await collectSubagentDescendants(sessionId);
          return send(res, 200, { ok: true, result: { sessionId, descendants } });
        }

        if (req.method === "GET" && path === "/attachments/orphans") {
          const result = await cleanOrphanAttachments({ confirm: false });
          return send(res, 200, { ok: true, result });
        }

        if (req.method === "POST" && path === "/attachments/clean") {
          const body = await readJson();
          const result = await cleanOrphanAttachments({ confirm: body?.confirm === true });
          return send(res, 200, { ok: true, result });
        }

        if (req.method !== "POST" || path !== "/delete") {
          return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
        }

        const body = await readJson();
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        const result = await deleteSession(sessionId, {
          cascade: body?.cascade !== false,
          attachments: body?.attachments !== false
        });
        return send(res, 200, { ok: true, result });
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : undefined;
        const status = code === "bad-request" ? 400
          : code === "session-running" ? 409
            : code === "busy" ? 409
              : code === "not-found" ? 404
                : 500;
        warn(`api error: ${error?.message ?? error}`);
        return send(res, status, { ok: false, ...(code === undefined ? {} : { code }), error: error?.message ?? String(error) });
      }
    }
  }), "session-menu-delete: http api");
}
