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
 *   删会话只摘引用、不动物件，于是会攒下没人引用的孤儿。清理走三条安全规则：
 *     1. **删除瞬间重算**引用，绝不复用上一次扫描的陈旧结论；
 *     2. 结构化解析 `attachmentId`（含 tool/result 里的图片），不做文本匹配；
 *     3. **新鲜度保护**：mtime 在窗口内（默认 15 分钟）的对象一律跳过 ——
 *        刚上传/刚被看一眼的图，其引用可能还没落盘，"看一眼就等于引用一次"。
 *   删除是**直删，没有回收站**：能走到这一步的对象，最后一个引用者刚刚消失，
 *   没有回流路径需要它。代价是误判不可恢复，所以三条规则一条都不能省。
 *
 * 其余设计约束：
 *   - 账本改动一律走 workspaceRegistry 服务（enqueueOperation / setState、
 *     entity.detachSession），不直接改 workspace.json —— 否则 DSH 的内存态会在
 *     下一次写盘时把手改的内容覆盖回去。
 *   - 会话仍持有活 Agent 时，先按 DSH 自己的 retire 顺序摘除（cancel →
 *     scope.dispose → agents.store.delete → sessions 条目 detach），再删文件。
 *   - 目录定位只认「会话根 / 一层 slug / 会话 id」结构，杜绝路径拼接越界。
 *   - 所有对内部服务的访问都窄化取值：版本差异下取不到就跳过对应步骤。
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-session-menu-delete";

export const inject = ["webServer", "workspaceRegistry"];

const API_PREFIX = "/session-menu-delete/api";
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FRESH_WINDOW_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fail = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

/**
 * 解析 freshMinutes 字段（查询串或请求体）。
 * 注意 `Number(null) === 0` —— 缺省时若不显式判空，窗口会被算成 0 毫秒，
 * 新鲜度保护就静默失效了。缺省/非法一律回落到默认窗口。
 */
const parseFreshWindow = (value) => {
  if (value === null || value === undefined || value === "") return undefined;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60000 : undefined;
};

const resolveDshHome = () => {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
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
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { finish(JSON.parse(buffer.slice(0, newline))); }
      catch { finish(undefined); }
    });
    stream.on("error", () => finish(undefined));
    stream.on("end", () => {
      if (settled) return;
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

export function apply(ctx) {
  const home = resolveDshHome();
  const sessionsRoot = join(home, "sessions");
  const projectionCacheDir = join(home, "storages", "session_projcache", "sessions");
  const attachmentsRoot = join(home, "attachments", "v1", "objects");

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
        for (const file of files) {
          if (!file.isFile()) continue;
          const lower = file.name.toLowerCase();
          let header;
          if (lower.endsWith(".zstd")) header = await readZstdHeaderLine(join(dir, file.name));
          else if (lower.endsWith(".jsonl")) header = await readFirstJsonLine(join(dir, file.name));
          else continue;
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
          break; // 一个会话目录只认第一个工件
        }
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

  /** 逐会话解析日志，收集 hash → Set(会话 id) 的真实引用。 */
  const collectAttachmentReferences = async () => {
    const refs = new Map();
    let slugs;
    try {
      slugs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return refs;
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
        for (const file of files) {
          if (!file.isFile()) continue;
          const lower = file.name.toLowerCase();
          if (!lower.endsWith(".zstd") && !lower.endsWith(".jsonl")) continue;
          const text = await readSessionLogText(join(dir, file.name));
          if (text === undefined || !text.includes("attachmentId")) continue;
          for (const line of text.split("\n")) {
            if (line === "" || !line.includes("attachmentId")) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            for (const hash of harvestAttachmentRefs(row, new Set())) {
              let owners = refs.get(hash);
              if (owners === undefined) {
                owners = new Set();
                refs.set(hash, owners);
              }
              owners.add(session.name);
            }
          }
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
   */
  const surveyAttachments = async (freshMs = FRESH_WINDOW_MS) => {
    const refs = await collectAttachmentReferences();
    const objects = await listAttachmentObjects();
    const now = Date.now();
    const orphans = [];
    const protectedFresh = [];
    let referenced = 0;
    for (const object of objects) {
      const owners = refs.get(object.hash);
      if (owners !== undefined && owners.size > 0) {
        referenced += 1;
        continue;
      }
      if (now - object.mtimeMs < freshMs) protectedFresh.push(object);
      else orphans.push(object);
    }
    return { objects, referenced, orphans, protectedFresh };
  };

  const describe = (object) => ({
    hash: object.hash,
    sizeBytes: object.sizeBytes,
    ageMinutes: Math.round((Date.now() - object.mtimeMs) / 60000)
  });

  /** confirm !== true 时只预览；确认后直接删掉孤儿（没有回收站）。 */
  const cleanOrphanAttachments = async (options = {}) => {
    const freshMs = Number.isFinite(options.freshMs) && options.freshMs >= 0
      ? options.freshMs
      : FRESH_WINDOW_MS;
    const survey = await surveyAttachments(freshMs);
    const summary = {
      dryRun: options.confirm !== true,
      freshWindowMinutes: Math.round(freshMs / 60000),
      totalObjects: survey.objects.length,
      referenced: survey.referenced,
      orphanCount: survey.orphans.length,
      orphanBytes: survey.orphans.reduce((sum, object) => sum + object.sizeBytes, 0),
      orphans: survey.orphans.map(describe),
      protectedFresh: survey.protectedFresh.map(describe),
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
        if ((await readdir(shard)).length === 0) await rm(shard, { recursive: true, force: true });
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
   * 这里**不套新鲜度窗口**。窗口防的是"引用还没落盘"，而能进这个集合的前提恰恰相反：
   * 引用已经在盘上、且引用者全都要被删掉 —— 主人没了，它不可能再被谁需要。
   * 曾经在这里套窗口，代价是：删掉一个刚读过图的会话，那些图被静默跳过，
   * 既不进回收站也不留痕迹，变成永远没人管的孤儿（真踩过，一次 11 张）。
   * 落盘实时性由 DSH 保证（实测会话日志 mtime == 最新事件时间），
   * 万一真误判，对象进的是回收站，可按哈希还原。
   */
  const collectDoomedAttachments = async (doomed) => {
    const refs = await collectAttachmentReferences();
    let relevant = false;
    for (const owners of refs.values()) {
      for (const owner of owners) {
        if (doomed.has(owner)) { relevant = true; break; }
      }
      if (relevant) break;
    }
    if (!relevant) return { objects: [] }; // 短路：这批会话没引用过任何附件

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

  /** 按 DSH 自己的顺序把一个仍活着的会话摘下来（任一步失败都不阻断删除）。 */
  const retireLiveSession = async (sessionId) => {
    let touched = false;

    const agents = service("agents");
    if (agents !== undefined && typeof agents.get === "function") {
      let agent;
      try { agent = agents.get(sessionId); } catch { agent = undefined; }
      if (agent !== undefined) {
        touched = true;
        try { agent.cancel?.({ kind: "disposed" }); } catch { /* 已停止 */ }
        try {
          const scope = agent.scope;
          if (scope !== undefined && typeof scope.dispose === "function") {
            await Promise.race([scope.dispose(), sleep(3000)]);
          }
        } catch { /* 拆解超时也继续 */ }
        try { agents.store?.delete?.(sessionId); } catch { /* best-effort */ }
      }
    }

    const sessions = service("sessions");
    if (sessions !== undefined) {
      try {
        const session = typeof sessions.get === "function" ? sessions.get(sessionId) : undefined;
        if (session !== undefined && typeof sessions.flush === "function") {
          await sessions.flush(session);
          touched = true;
        }
      } catch { /* ignore */ }
      try {
        const entry = sessions.store?.get?.(sessionId);
        if (entry !== undefined && typeof entry.detach === "function") {
          entry.detach();
          await sleep(200);
          touched = true;
        }
      } catch { /* ignore */ }
    }
    return touched;
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

  const forgetInSets = async (sessionId) => {
    const registry = ctx.workspaceRegistry;
    if (registry === undefined || registry === null) return;
    if (typeof registry.enqueueOperation !== "function" || typeof registry.requireState !== "function"
      || typeof registry.setState !== "function") return;
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      const archived = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
      const pinned = Array.isArray(state.pinnedSessionIds) ? state.pinnedSessionIds : [];
      if (!archived.includes(sessionId) && !pinned.includes(sessionId)) return;
      await registry.setState({
        ...state,
        archivedSessionIds: archived.filter((id) => id !== sessionId),
        pinnedSessionIds: pinned.filter((id) => id !== sessionId)
      });
    });
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

  /** 删一个会话：摘活体 → 摘账本 → 删工件 → 清缓存 → 通知客户端。 */
  const removeOne = async (sessionId) => {
    const wasLive = await retireLiveSession(sessionId);
    // 摘除后重新定位：空白会话可能在 flush 时刚落盘第一个工件。
    const dir = await locateSessionDir(sessionId);
    const detached = await detachFromWorkspaces(sessionId);
    await forgetInSets(sessionId);

    let filesRemoved = false;
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      filesRemoved = true;
    }
    const cacheRemoved = await removeProjectionRecord(sessionId);

    // 让所有已连接的客户端丢掉这一行。
    try { ctx.emit?.("session/disposed", { id: sessionId }); } catch { /* 无监听者也无妨 */ }

    info(`removed ${sessionId} (files=${filesRemoved}, cache=${cacheRemoved}, detached=${detached}, wasLive=${wasLive})`);
    return { sessionId, filesRemoved, cacheRemoved, detached, wasLive };
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
    for (const childId of descendants) {
      try {
        cascadeResults.push(await removeOne(childId));
      } catch (error) {
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
      attachmentsRemoved
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
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
              freshWindowMinutes: Math.round(FRESH_WINDOW_MS / 60000)
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
          const freshMs = parseFreshWindow(url.searchParams.get("freshMinutes"));
          const result = await cleanOrphanAttachments({ confirm: false, freshMs });
          return send(res, 200, { ok: true, result });
        }

        if (req.method === "POST" && path === "/attachments/clean") {
          const body = await readJson();
          const freshMs = parseFreshWindow(body?.freshMinutes);
          const result = await cleanOrphanAttachments({ confirm: body?.confirm === true, freshMs });
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
            : code === "not-found" ? 404
              : 500;
        warn(`api error: ${error?.message ?? error}`);
        return send(res, status, { ok: false, ...(code === undefined ? {} : { code }), error: error?.message ?? String(error) });
      }
    }
  }), "session-menu-delete: http api");
}
