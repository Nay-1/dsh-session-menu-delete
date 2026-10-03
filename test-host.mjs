/**
 * host 半的离线冒烟测试：用临时 DSH_HOME + mock 服务跑通 /delete 与级联删除，
 * 全程不碰真实的 ~/.dsh。
 *
 * 工件用真实的多帧 zstd 写（第一帧是 header 行），这样级联血缘扫描走的是
 * 与线上完全相同的解压路径。
 */
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Readable } from "node:stream";
import { zstdCompressSync } from "node:zlib";

const CONTRACT = [];
const check = (label, condition) => {
  CONTRACT.push(`${condition ? "PASS" : "FAIL"}  ${label}`);
  return condition;
};

// ---- 临时 DSH_HOME -------------------------------------------------------
const home = await mkdtemp(join(tmpdir(), "dsh-menu-delete-test-"));
process.env.DSH_HOME = home;

const slug = "--C-Users-demo-fake-project--";
const sessionsDir = join(home, "sessions", slug);
const cacheDir = join(home, "storages", "session_projcache", "sessions");
await mkdir(cacheDir, { recursive: true });

/** 写一份真实的会话工件：header 帧 + 正文帧（可附加事件），外加一条投影缓存。 */
const writeArtifact = async (id, header, extraEvents = []) => {
  const dir = join(sessionsDir, id);
  await mkdir(dir, { recursive: true });
  const headerLine = JSON.stringify({
    type: "session", version: 4, isSeeded: false, agentPreset: "standard",
    createdAt: Date.now(), cwd: "C:\\Users\\demo\\fake-project", ...header
  });
  const frames = [
    zstdCompressSync(Buffer.from(`${headerLine}\n`, "utf8")),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "event", event: { type: "noop", seq: 1, time: Date.now(), data: null } })}\n`, "utf8"))
  ];
  if (extraEvents.length > 0) {
    const body = `${extraEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
    frames.push(zstdCompressSync(Buffer.from(body, "utf8")));
  }
  await writeFile(join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
  await writeFile(join(cacheDir, `${id}.json`), JSON.stringify({ version: 7, record: {} }));
};

// 顶层：一个活会话（有 agent）、一个冷会话
const liveId = "session-test-live-0001";
const coldId = "session-test-cold-0002";
await writeArtifact(liveId, { id: liveId, delegationDepth: 0 });
await writeArtifact(coldId, { id: coldId, delegationDepth: 0 });

// 血缘家族，覆盖"父会话起了子代理 + 又 fork 出一个会话，而那个 fork 自己也起了子代理"：
//   parent ─┬─ childA(子代理) ── grandchild(孙代理)
//           ├─ childB(子代理)
//           └─ forked(fork：有 parentSession + isSeeded、无 origin) ── forkedChild(它自己的子代理)
const parentId = "session-family-parent-01";
const childA = "family-child-a-01";
const childB = "family-child-b-01";
const grandchild = "family-grandchild-01";
const forked = "session-family-forked-01";
const forkedChild = "family-forked-child-01";
await writeArtifact(parentId, { id: parentId, delegationDepth: 0 });
await writeArtifact(childA, { id: childA, parentSession: parentId, origin: "subagent", delegationDepth: 1 });
await writeArtifact(childB, { id: childB, parentSession: parentId, origin: "subagent", delegationDepth: 1 });
await writeArtifact(grandchild, { id: grandchild, parentSession: childA, origin: "subagent", delegationDepth: 2 });
await writeArtifact(forked, { id: forked, parentSession: parentId, isSeeded: true, seedLength: 12, delegationDepth: 0 });
await writeArtifact(forkedChild, { id: forkedChild, parentSession: forked, origin: "subagent", delegationDepth: 1 });

// ---- 附件对象（内容寻址：文件名 = 内容的 sha256）----------------------------
const objectsRoot = join(home, "attachments", "v1", "objects");
const HOUR_MS = 60 * 60 * 1000;
const hashReferenced = "a".repeat(64);    // 被 user/message 正常引用
const hashInToolResult = "d".repeat(64);  // 只在 tool/result 里被引用（考结构化解析）
const hashOrphanOld = "b".repeat(64);     // 孤儿 + 老 -> 可清理
const hashOrphanFresh = "c".repeat(64);   // 孤儿 + 刚生成 -> 同样是孤儿，照清

const putObject = async (hash, ageMs = 2 * HOUR_MS) => {
  const dir = join(objectsRoot, hash.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const file = join(dir, hash);
  await writeFile(file, Buffer.from(`payload-${hash.slice(0, 8)}`, "utf8"));
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
  return file;
};
await putObject(hashReferenced);
await putObject(hashInToolResult);
await putObject(hashOrphanOld);
await putObject(hashOrphanFresh, 0);

await writeArtifact("session-attach-a", { id: "session-attach-a", delegationDepth: 0 }, [
  {
    type: "user/message", seq: 2, time: Date.now(), data: {
      content: [{ type: "image", attachment: { attachmentId: `sha256:${hashReferenced}`, bytes: 24, name: "a.png" } }]
    }
  }
]);
await writeArtifact("session-attach-b", { id: "session-attach-b", delegationDepth: 0 }, [
  {
    type: "tool/result", seq: 2, time: Date.now(), data: {
      message: {
        role: "tool", content: [
          { type: "image", attachment: { attachmentId: `sha256:${hashInToolResult}`, bytes: 24, name: "tool.png" } }
        ]
      }
    }
  }
]);

// ---- mock cordis ctx -----------------------------------------------------
let route;
const detached = [];
const emitted = [];
const cancelled = [];
const idleWaits = [];
const activityStops = [];
const forgotten = [];
/** 走 `ctx.events.dispatch` 的派发记录（带 carrier 的那条路）。 */
const dispatched = [];
/** 监听者收到的 `agent/disposed` payload —— 证明事件真的到达了监听者。 */
const agentDisposedSeen = [];
const emitListeners = new Map([
  ["agent/disposed", [(payload) => { agentDisposedSeen.push(payload); }]]
]);

/** 活体 agent：cancel / whenIdle / scope.dispose 三件套，与 DSH 的 Agent 形状一致。 */
const makeAgent = (overrides = {}) => ({
  id: liveId,
  cancel: (options) => cancelled.push(options),
  whenIdle: async () => { idleWaits.push(true); },
  scope: { dispose: async () => { cancelled.push("dispose"); } },
  ...overrides
});
const fakeAgent = makeAgent();

/** sessions store 条目：announcing/appending 延迟保护 + detach 闭包。 */
const makeEntry = (id) => ({
  id,
  announcing: false,
  appending: false,
  detach: () => {
    sessionsStore.delete(id);
    detachedSessions.push(id);
  }
});
const sessionsStore = new Map();
const detachedSessions = [];
sessionsStore.set(liveId, makeEntry(liveId));

/** 活会话（内存态）：`collectAttachmentReferences` 的来源 1。测试往里塞即可。 */
const liveSessions = [];

const agentsStore = new Map();
/** scope carrier：DSH 的 `agents.enter()` 会把它存在条目上，补发事件时必须带上。 */
const liveCarrier = { scope: liveId };
agentsStore.set(liveId, { id: liveId, agent: fakeAgent, announced: true, carrier: liveCarrier });

/** 一个"收尾收不完"的活体：whenIdle 拒绝 -> retire 必须中止删除（不留半死状态）。 */
const stuckId = "session-stuck-0001";
const stuckAgent = makeAgent({ id: stuckId, whenIdle: async () => { throw new Error("driver failed"); } });
agentsStore.set(stuckId, { id: stuckId, agent: stuckAgent, announced: true, carrier: { scope: stuckId } });

/** 级联里同样卡住的子代理：父删得掉，但它删不掉 —— 必须被如实报出。 */
const stuckChildId = "family-stuck-child-01";
const stuckChildAgent = makeAgent({ id: stuckChildId, whenIdle: async () => { throw new Error("driver failed"); } });
agentsStore.set(stuckChildId, { id: stuckChildId, agent: stuckChildAgent, announced: true });

const ctx = {
  logger: { info: () => {}, warn: (message) => console.log("[host warn]", message) },
  get: (key) => {
    if (key === "agents") {
      const byId = new Map([[liveId, fakeAgent], [stuckId, stuckAgent], [stuckChildId, stuckChildAgent]]);
      return { get: (id) => byId.get(id), store: agentsStore };
    }
    if (key === "sessions") {
      return {
        get: (id) => (id === liveId ? { id, header: { id } } : undefined),
        flush: async () => true,
        store: sessionsStore,
        // 来源 1：活会话的内存事件（未落盘的引用在这里可见）
        list: () => liveSessions
      };
    }
    return undefined;
  },
  webServer: { register: (registered) => { route = registered; return () => {}; } },
  workspaceRegistry: {
    list: () => [{
      id: "ws-1",
      sessionIds: [liveId, coldId, parentId, childA, childB, grandchild, forked, forkedChild],
      detachSession: async (id) => { detached.push(id); }
    }],
    // 公开 API：停活走 archiveSession(stopActivity)，清集合走 unarchive/unpin。
    archiveSession: async (id, options) => { activityStops.push([id, options]); },
    unarchiveSession: async (id) => { forgotten.push(["unarchiveSession", id]); },
    unpinSession: async (id) => { forgotten.push(["unpinSession", id]); }
  },
  effect: (fn) => { fn(); },
  emit: (event, payload) => emitted.push([event, payload]),
  /*
   * 复刻 cordis 的 `dispatch`：`args[0]` 是对象时当 thisArg（scope carrier）消费掉，
   * 再消费事件名，剩下的就是 payload —— 并返回绑定到 thisArg 的监听者。
   * 补发 `agent/disposed` 必须走这条路（无 carrier 会被 dsh-scope 的 invariant fail）。
   */
  events: {
    dispatch: (mode, args) => {
      const thisArg = typeof args[0] === "object" && args[0] !== null ? args.shift() : null;
      const name = args.shift();
      dispatched.push({ mode, name, thisArg, args: [...args] });
      return emitListeners.get(name) ?? [];
    }
  }
};

// ---- 加载并应用 host 半 ---------------------------------------------------
const host = await import(new URL("./lib/index.js", import.meta.url).href);
check("host 半导出 name", host.name === "dsh-session-menu-delete");
check("host 半导出 apply", typeof host.apply === "function");
check("host 半声明 inject(webServer, workspaceRegistry)",
  Array.isArray(host.inject) && host.inject.includes("webServer") && host.inject.includes("workspaceRegistry"));
host.apply(ctx);
check("路由已注册到 /session-menu-delete/api", route?.path === "/session-menu-delete/api");

// ---- 请求助手 -------------------------------------------------------------
const CALL_HEADER = { "x-dsh-plugin-call": "1" };
const request = async (method, url, body, headers = CALL_HEADER) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const captured = { status: undefined, payload: undefined };
  const res = {
    writeHead: (status) => { captured.status = status; },
    end: (text) => { captured.payload = JSON.parse(text); }
  };
  await route.handler(req, res);
  return captured;
};

// ---- 基础用例 -------------------------------------------------------------
{
  const res = await request("GET", "/session-menu-delete/api/health");
  const r = res.payload.result;
  check("GET /health → 200 ok 且标记 cascade", res.status === 200 && res.payload.ok === true
    && r.cascade === true);
  check("health 仍如实声明只管图片对象", Array.isArray(r.attachmentKinds)
    && r.attachmentKinds.length === 1 && r.attachmentKinds[0] === "image-objects");
  check("health 回显请求头要求", r.callHeader === "x-dsh-plugin-call");
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "../../etc" });
  check("非法 id 被拒（400）", res.status === 400 && res.payload.code === "bad-request");
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: coldId });
  check("冷会话删除 → 200", res.status === 200 && res.payload.ok === true);
  check("冷会话无后代（cascadeRemoved=0）", res.payload.result.cascadeRemoved === 0);
  check("工件目录已删除", !existsSync(join(sessionsDir, coldId)));
  check("投影缓存记录已删除", !existsSync(join(cacheDir, `${coldId}.json`)));
  check("工作区账本已摘除", detached.includes(coldId));
  // 停活 + 清集合改走公开 API（不再手改 requireState/setState）
  check("停活走 archiveSession(id, { stopActivity: true })",
    activityStops.some(([id, options]) => id === coldId && options?.stopActivity === true));
  check("归档集合用 unarchiveSession 清", forgotten.some(([name, id]) => name === "unarchiveSession" && id === coldId));
  check("置顶集合用 unpinSession 清", forgotten.some(([name, id]) => name === "unpinSession" && id === coldId));
  check("冷会话通过 api-session/removed 宣告消失（该事件无 scoped 声明，不需要 carrier）",
    emitted.some(([event, payload]) => event === "api-session/removed" && payload === coldId));
  check("**不再**伪造 session/disposed（scoped 事件无 carrier 会被 invariant fail）",
    !emitted.some(([event]) => event === "session/disposed"));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: liveId });
  check("活会话删除 → 200（先摘除 agent）", res.status === 200 && res.payload.ok === true);
  check("返回值标记 wasLive", res.payload.result.wasLive === true);
  check("agent 被 cancel({kind:'disposed'})", cancelled.some((item) => item && item.kind === "disposed"));
  // 回归：早先漏了 whenIdle，直接在 loop 收尾时拆 scope
  check("等到了 agent.whenIdle()（DSH dispose 顺序）", idleWaits.length > 0);
  check("agent scope 被 dispose", cancelled.includes("dispose"));
  check("agent 已从 agents.store 摘除", !agentsStore.has(liveId));
  // 回归：早先裸 store.delete 会让 detachEntered 的守卫永久挡住 agent/disposed；
  // 而补发时**必须带 scope carrier**，否则 dsh-scope 的 invariant 会 fail，一个监听者都收不到。
  check("补发了 agent/disposed，且带 scope carrier（走 ctx.events.dispatch）",
    dispatched.some((row) => row.name === "agent/disposed" && row.thisArg === liveCarrier
      && row.args[0]?.agent === fakeAgent));
  check("该事件真的到达了监听者（payload 形状 { agent }）",
    agentDisposedSeen.some((payload) => payload?.agent === fakeAgent));
  check("sessions store 条目已 detach", detachedSessions.includes(liveId));
  check("活会话工件也已删除", !existsSync(join(sessionsDir, liveId)));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-does-not-exist" });
  check("不存在的会话也返回 ok（幂等）", res.status === 200 && res.payload.result.filesRemoved === false);
  // 回归：rm(force:true) 对不存在的路径不报错，早先这里会把"没删到"也报成 true
  check("不存在的会话不会谎报删掉了投影缓存", res.payload.result.cacheRemoved === false);
}

{
  // 正面对照：工件与缓存都在时必须如实报 true（用一个专用会话，免得被上面的用例删掉）
  const cacheProbeId = "session-cache-probe-0001";
  await writeArtifact(cacheProbeId, { id: cacheProbeId, delegationDepth: 0 });
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: cacheProbeId });
  check("缓存文件存在时如实报 true",
    res.payload.result.filesRemoved === true && res.payload.result.cacheRemoved === true);
}

// ---- 级联用例 -------------------------------------------------------------
{
  const res = await request("GET", `/session-menu-delete/api/lineage?sessionId=${parentId}`);
  const kids = res.payload.result.descendants;
  check("GET /lineage 列出 3 个后代（2 子代理 + 1 孙代理）", res.status === 200 && kids.length === 3
    && kids.includes(childA) && kids.includes(childB) && kids.includes(grandchild));
  check("GET /lineage 不含 fork 出来的会话", !kids.includes(forked));
  check("GET /lineage 也不穿过 fork 去收它的子代理", !kids.includes(forkedChild));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: parentId });
  check("父会话删除 → 200", res.status === 200 && res.payload.ok === true);
  check("级联删除了 3 个子代理会话", res.payload.result.cascadeRemoved === 3);
  check("父会话工件已删除", !existsSync(join(sessionsDir, parentId)));
  check("子代理 childA 工件已删除", !existsSync(join(sessionsDir, childA)));
  check("子代理 childB 工件已删除", !existsSync(join(sessionsDir, childB)));
  check("孙代理（多层委派）工件已删除", !existsSync(join(sessionsDir, grandchild)));
  check("三个子代理的投影缓存也清了",
    !existsSync(join(cacheDir, `${childA}.json`)) && !existsSync(join(cacheDir, `${childB}.json`))
    && !existsSync(join(cacheDir, `${grandchild}.json`)));
  check("fork 出来的会话被保留（关键安全边界）", existsSync(join(sessionsDir, forked)));
  check("fork 的投影缓存也保留", existsSync(join(cacheDir, `${forked}.json`)));
  check("fork 会话自己的子代理也保留（级联不穿过 fork）",
    existsSync(join(sessionsDir, forkedChild)) && existsSync(join(cacheDir, `${forkedChild}.json`)));
  check("每个被删的冷会话都派发了 api-session/removed",
    [parentId, childA, childB, grandchild].every((id) => emitted.some(([event, payload]) => event === "api-session/removed" && payload === id)));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: forked, cascade: false });
  check("cascade:false 单独删除该 fork 会话（不级联）", res.status === 200 && res.payload.result.cascadeRemoved === 0);
  check("fork 会话此时才被删除", !existsSync(join(sessionsDir, forked)));
  check("cascade:false 时它的子代理被留下（预期语义）", existsSync(join(sessionsDir, forkedChild)));

  const res2 = await request("POST", "/session-menu-delete/api/delete", { sessionId: forkedChild });
  check("随后单独删该子代理 → 200", res2.status === 200 && res2.payload.ok === true);
  check("子代理此时才被删除", !existsSync(join(sessionsDir, forkedChild)));
}

// ---- 附件孤儿清理用例 -----------------------------------------------------
{
  const res = await request("GET", "/session-menu-delete/api/attachments/orphans");
  const r = res.payload.result;
  check("GET /attachments/orphans → 200", res.status === 200 && res.payload.ok === true);
  check("默认只预览（dryRun=true）", r.dryRun === true);
  check("识别出 2 个孤儿（老的 + 刚生成的都算）",
    r.orphanCount === 2
    && r.orphans.some((o) => o.hash === hashOrphanOld)
    && r.orphans.some((o) => o.hash === hashOrphanFresh));
  check("tool/result 里的引用也算引用（结构化解析，非文本匹配）",
    !r.orphans.some((o) => o.hash === hashInToolResult));
  check("user/message 里的引用同样算数", !r.orphans.some((o) => o.hash === hashReferenced));
  check("预览不动任何文件", existsSync(join(objectsRoot, hashOrphanOld.slice(0, 2), hashOrphanOld)));
}

{
  const res = await request("POST", "/session-menu-delete/api/attachments/clean", {});
  check("POST 不带 confirm 仍然只预览（不会误删）",
    res.payload.result.dryRun === true && res.payload.result.removed.length === 0);
}

{
  const res = await request("POST", "/session-menu-delete/api/attachments/clean", { confirm: true });
  const r = res.payload.result;
  check("带 confirm 才真正执行（dryRun=false）", r.dryRun === false);
  check("两个孤儿都删掉了（老的 + 刚生成的，直删、没有回收站）",
    r.removed.length === 2
    && r.removed.includes(hashOrphanOld) && r.removed.includes(hashOrphanFresh));
  check("孤儿已从磁盘上消失",
    !existsSync(join(objectsRoot, hashOrphanOld.slice(0, 2), hashOrphanOld))
    && !existsSync(join(objectsRoot, hashOrphanFresh.slice(0, 2), hashOrphanFresh)));
  check("被引用的对象仍在原地",
    existsSync(join(objectsRoot, hashInToolResult.slice(0, 2), hashInToolResult)));
  check("独立清理也会收掉腾空的分片目录（不留空文件夹）",
    !existsSync(join(objectsRoot, hashOrphanOld.slice(0, 2))));
}

{
  // 回收站机制已整体移除：端点下线，且不该被偷偷建出目录
  const res = await request("GET", "/session-menu-delete/api/attachments/trash");
  check("回收站端点已下线（404）", res.status === 404);
  check("没有偷偷建出 attachments/trash 目录",
    !existsSync(join(home, "attachments", "trash")));
}

// ---- 删会话时顺手清理"独享附件" -------------------------------------------
const hashOwned = "e".repeat(64);       // 只被一个会话引用 -> 该会话删掉后应被清走
const hashShared = "f".repeat(64);      // 两个会话共享 -> 删其中一个不许动
const hashOwnedFresh = "1".repeat(64);  // 独享且刚生成 -> 照样要清走（主人没了就删，不看年龄）
const hashFamily = "2".repeat(64);      // 父会话 + 它的子代理共同引用 -> 级联删时应清走
const hashNoTouch = "3".repeat(64);     // 用来验证 attachments:false 开关
const hashSharedFresh = "4".repeat(64); // 刚生成 + 两个会话共享 -> 删其中一个绝不许动
await putObject(hashOwned);
await putObject(hashShared);
await putObject(hashOwnedFresh, 0);
await putObject(hashFamily);
await putObject(hashNoTouch);
await putObject(hashSharedFresh, 0);

const attachEvent = (hash, name) => ({
  type: "user/message", seq: 2, time: Date.now(), data: {
    content: [{ type: "image", attachment: { attachmentId: `sha256:${hash}`, bytes: 24, name } }]
  }
});

await writeArtifact("session-owned", { id: "session-owned", delegationDepth: 0 }, [attachEvent(hashOwned, "owned.png")]);
await writeArtifact("session-share-x", { id: "session-share-x", delegationDepth: 0 }, [attachEvent(hashShared, "shared.png")]);
await writeArtifact("session-share-y", { id: "session-share-y", delegationDepth: 0 }, [attachEvent(hashShared, "shared.png")]);
await writeArtifact("session-owned-fresh", { id: "session-owned-fresh", delegationDepth: 0 }, [attachEvent(hashOwnedFresh, "fresh.png")]);
await writeArtifact("session-fam-parent", { id: "session-fam-parent", delegationDepth: 0 }, [attachEvent(hashFamily, "family.png")]);
await writeArtifact("family-fam-child", {
  id: "family-fam-child", parentSession: "session-fam-parent", origin: "subagent", delegationDepth: 1
}, [attachEvent(hashFamily, "family.png")]);
await writeArtifact("session-notouch", { id: "session-notouch", delegationDepth: 0 }, [attachEvent(hashNoTouch, "notouch.png")]);
await writeArtifact("session-share-p", { id: "session-share-p", delegationDepth: 0 }, [attachEvent(hashSharedFresh, "shared-fresh.png")]);
await writeArtifact("session-share-q", { id: "session-share-q", delegationDepth: 0 }, [attachEvent(hashSharedFresh, "shared-fresh.png")]);

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-owned" });
  check("删会话时顺手删掉它独享的附件", res.payload.result.attachmentsRemoved === 1);
  check("独享附件已从磁盘上消失",
    !existsSync(join(objectsRoot, hashOwned.slice(0, 2), hashOwned)));
  check("腾空的分片目录也被删掉（不留空文件夹）",
    !existsSync(join(objectsRoot, hashOwned.slice(0, 2))));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-share-x" });
  check("共享附件不被顺手清理（removed=0）", res.payload.result.attachmentsRemoved === 0);
  check("共享附件仍在原地（另一个会话还要用）",
    existsSync(join(objectsRoot, hashShared.slice(0, 2), hashShared)));
}

{
  // 独享即删 —— 不看对象年龄，"刚生成"不是豁免理由。
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-owned-fresh" });
  const result = res.payload.result;
  check("独享即删：刚生成的独享附件当场删掉（不看对象年龄）", result.attachmentsRemoved === 1);
  check("它已从磁盘上消失",
    !existsSync(join(objectsRoot, hashOwnedFresh.slice(0, 2), hashOwnedFresh)));
}

{
  // 反向对照：刚生成 + 两个会话共享。"还有别人在用"这条必须守住 ——
  // 注意删掉最后一个引用者时它就该走（那才是独享），所以这里只删两个引用者之一。
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-share-p" });
  check("被别的会话共享 -> 一律不动（removed=0）", res.payload.result.attachmentsRemoved === 0);
  check("共享的附件仍在原地",
    existsSync(join(objectsRoot, hashSharedFresh.slice(0, 2), hashSharedFresh)));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-fam-parent" });
  check("级联删除时，父与子代理共同引用的附件一并删掉", res.payload.result.attachmentsRemoved === 1);
  check("家族附件已从磁盘上消失",
    !existsSync(join(objectsRoot, hashFamily.slice(0, 2), hashFamily)));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-notouch", attachments: false });
  check("attachments:false 时完全不碰附件",
    res.payload.result.attachmentsRemoved === 0
    && existsSync(join(objectsRoot, hashNoTouch.slice(0, 2), hashNoTouch)));
}

// ---- 已下线端点 / 未知路径 -------------------------------------------------
{
  for (const [method, path] of [
    ["POST", "/attachments/restore"],
    ["POST", "/attachments/trash/purge"],
    ["GET", "/attachments/trash"]
  ]) {
    const res = await request(method, `/session-menu-delete/api${path}`);
    check(`回收站相关端点 ${method} ${path} 已下线（404）`, res.status === 404);
  }
}

{
  const res = await request("GET", "/session-menu-delete/api/unknown");
  check("未知路径 → 404", res.status === 404);
}

// ---- 访问控制（新增）------------------------------------------------------
{
  const res = await request("GET", "/session-menu-delete/api/health", undefined, {});
  check("缺 x-dsh-plugin-call 头 -> 403（网页因此发不出这个请求）",
    res.status === 403 && res.payload.code === "forbidden");
}
{
  const res = await request("GET", "/session-menu-delete/api/health");
  check("带上自定义头即正常放行（本机脚本零成本）", res.status === 200 && res.payload.ok === true);
}
{
  // connection.requestRejection 的**无条件**调用（P0 修复的回归钉）：
  // 403（Host/Origin 围栏失败）一律执行；401（浏览器会话未认证）只对带 Origin 的请求执行。
  let probeRoute;
  let connectionCalls = 0;
  const stubRejection = (req) => {
    connectionCalls += 1;
    const host = String(req.headers.host ?? "");
    // 围栏：Host 必须回环（模拟 DSH 的 isTrustedApiRequest）
    if (!/^(127\.|localhost|\[::1\])/.test(host)) return 403;
    return 401; // 回环但没带会话 cookie
  };
  host.apply({
    ...ctx,
    get: (key) => (key === "connection" ? { requestRejection: stubRejection } : ctx.get(key)),
    webServer: { register: (registered) => { probeRoute = registered; return () => {}; } }
  });
  const call = async (headers) => {
    const req = Readable.from([]);
    req.method = "GET";
    req.url = "/session-menu-delete/api/health";
    req.headers = headers;
    const captured = {};
    await probeRoute.handler(req, {
      writeHead: (status) => { captured.status = status; },
      end: (text) => { captured.payload = JSON.parse(text); }
    });
    return captured;
  };

  const local = await call({ "x-dsh-plugin-call": "1", host: "127.0.0.1:19387" });
  check("围栏对**每个**请求都执行（不再只对带 Origin 的）", connectionCalls === 1);
  check("本机脚本（无 Origin、回环 Host）不被 401 误伤 -> 200", local.status === 200);

  const browser = await call({
    "x-dsh-plugin-call": "1", host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387"
  });
  check("带 Origin 的浏览器请求未认证 -> 401", browser.status === 401);

  // P0 回归：DNS-rebinding 页面与目标同源 -> 不预检、可带自定义头、同源 GET 又不带 Origin。
  // 只有"无条件跑围栏"才拦得住这一路（Host 是攻击者域名）。
  const rebinding = await call({ "x-dsh-plugin-call": "1", host: "evil.example" });
  check("DNS-rebinding（异源 Host、**无 Origin**）被 403 拦下 —— 这就是 P0 修的那条",
    rebinding.status === 403 && connectionCalls === 3);
}

// ---- retire 失败必须中止删除（新增）--------------------------------------
{
  await writeArtifact(stuckId, { id: stuckId, delegationDepth: 0 });
  await writeFile(join(cacheDir, `${stuckId}.json`), JSON.stringify({ version: 7, record: {} }));
  const before = detached.length;
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: stuckId });
  check("whenIdle 被拒绝 -> 409 busy（报的是「收尾失败」而不是「超时」）",
    res.status === 409 && res.payload.code === "busy" && res.payload.error.includes("收尾失败"));
  check("工件原封不动（绝不留半死状态）", existsSync(join(sessionsDir, stuckId)));
  check("投影缓存也没被清", existsSync(join(cacheDir, `${stuckId}.json`)));
  check("账本未摘除", !detached.slice(before).includes(stuckId));
  check("没有宣告该会话消失（api-session/removed 未发出）",
    !emitted.some(([event, payload]) => event === "api-session/removed" && payload === stuckId));
}

// ---- 级联里失败的子代理必须被报出（新增）----------------------------------
{
  const parent = "session-cascade-parent-01";
  await writeArtifact(parent, { id: parent, delegationDepth: 0 });
  await writeArtifact(stuckChildId, {
    id: stuckChildId, parentSession: parent, origin: "subagent", delegationDepth: 1
  });
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: parent });
  const result = res.payload.result;
  check("子代理 retire 失败 -> 父仍删除，但失败项被如实报出（不再静默）",
    res.status === 200 && result.cascadeRemoved === 0
    && Array.isArray(result.cascadeFailed) && result.cascadeFailed.length === 1
    && result.cascadeFailed[0].sessionId === stuckChildId);
  check("失败的子代理工件留在原地（是无主孤儿，但可见、可重试）",
    existsSync(join(sessionsDir, stuckChildId)));
}

// ---- 真超时分支：whenIdle 挂住不返回（新增）------------------------------
// 上面那条走的是"拒绝"路径；生产里更常见的是"还在收尾、迟迟不 idle"，
// 走的是 settleWithin 的定时器 + IDLE_TIMEOUT_MS。这里用可配置的超时把它压到 60ms。
{
  const hangId = "session-hang-0001";
  const hangAgent = {
    id: hangId,
    cancel: () => {},
    whenIdle: () => new Promise(() => {}), // 永不 settle
    scope: { dispose: async () => {} }
  };
  let hangRoute;
  const hangStore = new Map([[hangId, { id: hangId, agent: hangAgent, announced: true }]]);
  host.apply({
    ...ctx,
    get: (key) => (key === "agents"
      ? { get: (id) => (id === hangId ? hangAgent : undefined), store: hangStore }
      : ctx.get(key)),
    webServer: { register: (registered) => { hangRoute = registered; return () => {}; } }
  }, { idleTimeoutMs: 60 });

  await writeArtifact(hangId, { id: hangId, delegationDepth: 0 });
  const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: hangId }))]);
  req.method = "POST";
  req.url = "/session-menu-delete/api/delete";
  req.headers = { "x-dsh-plugin-call": "1" };
  const captured = {};
  await hangRoute.handler(req, {
    writeHead: (status) => { captured.status = status; },
    end: (text) => { captured.payload = JSON.parse(text); }
  });
  check("whenIdle 真挂住 -> 走超时分支并中止（409，报的是「超时」）",
    captured.status === 409 && captured.payload.code === "busy"
    && captured.payload.error.includes("超时"));
  check("超时后工件原封不动", existsSync(join(sessionsDir, hangId)));
}

// ---- 一个目录多个格式世代：取最高版本（新增）------------------------------
{
  const genId = "session-gen-multi-01";
  const genParent = "session-gen-parent-01";
  await writeArtifact(genParent, { id: genParent, delegationDepth: 0 });
  const dir = join(sessionsDir, genId);
  await mkdir(dir, { recursive: true });
  // v0 世代：血缘指向一个不存在的假父会话
  await writeFile(join(dir, "session.jsonl"), `${JSON.stringify({
    type: "session", version: 1, id: genId, createdAt: Date.now(), cwd: "C:\\Users\\demo\\fake-project",
    isSeeded: false, delegationDepth: 1, origin: "subagent", parentSession: "session-gen-ghost-99"
  })}\n`);
  // v4 世代：真正的血缘指向 genParent
  await writeFile(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: "session", version: 4, id: genId, createdAt: Date.now(), cwd: "C:\\Users\\demo\\fake-project",
    isSeeded: false, delegationDepth: 1, origin: "subagent", parentSession: genParent
  })}\n`, "utf8")));

  const res = await request("GET", `/session-menu-delete/api/lineage?sessionId=${genParent}`);
  check("同一目录含 v0 + v4 两个世代时读到 v4（DSH 规则是取最高版本，不是 readdir 第一个）",
    res.payload.result.descendants.includes(genId));
}

// ---- 分片里还有别的对象时不许删分片（新增）--------------------------------
{
  const keepHash = "5".repeat(64);
  const goneHash = "56" + "7".repeat(62); // 同分片（前两位都是 "56"）
  await putObject(keepHash);
  await putObject(goneHash);
  await writeArtifact("session-shard-probe", { id: "session-shard-probe", delegationDepth: 0 },
    [attachEvent(goneHash, "gone.png")]);
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-shard-probe" });
  check("删掉同分片里的一个对象后，分片里还有别的对象 -> 分片必须保留（rmdir 非空即失败）",
    res.payload.result.attachmentsRemoved === 1
    && !existsSync(join(objectsRoot, goneHash.slice(0, 2), goneHash))
    && existsSync(join(objectsRoot, keepHash.slice(0, 2))));
}

// ---- 活会话内存里未落盘的引用必须算数 -------------------------------------
// 只看磁盘日志会有结构性盲区：一个仍存活、刚看过这张图、引用还没 flush 的会话
// 在磁盘上不可见，于是"引用者全在被删集合内"会被误判。这个用例把它钉住。
{
  const hashBlind = "7".repeat(64);
  const hashControl = "8".repeat(64);
  await putObject(hashBlind);
  await putObject(hashControl);

  // 会话 A（磁盘上）引用 hashBlind；会话 B 是**活会话**，只在内存里引用它
  await writeArtifact("session-blind-a", { id: "session-blind-a", delegationDepth: 0 },
    [attachEvent(hashBlind, "blind.png")]);
  liveSessions.push({
    id: "session-blind-b",
    ownEvents: () => [{
      type: "user/message", seq: 1, time: Date.now(),
      data: {
        content: [{
          type: "image",
          attachment: { attachmentId: `sha256:${hashBlind}`, bytes: 10, name: "blind.png" }
        }]
      }
    }]
  });

  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-blind-a" });
  check("活会话内存里的引用算数：删 A 不动 B 还要用的图（只有内存来源能看见它）",
    res.payload.result.attachmentsRemoved === 0
    && existsSync(join(objectsRoot, hashBlind.slice(0, 2), hashBlind)));
  liveSessions.length = 0;

  // 正向对照：没人引用（磁盘与内存都没有）的对象照样被清走 —— 内存来源没有过度保护
  await writeArtifact("session-control-c", { id: "session-control-c", delegationDepth: 0 },
    [attachEvent(hashControl, "control.png")]);
  const res2 = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-control-c" });
  check("正向对照：没有任何引用者的对象照样被清走（内存来源没有过度保护）",
    res2.payload.result.attachmentsRemoved === 1
    && !existsSync(join(objectsRoot, hashControl.slice(0, 2), hashControl)));
}

// ---- DSH_HOME 展开（新增）------------------------------------------------
{
  const original = process.env.DSH_HOME;
  let expandRoute;
  process.env.DSH_HOME = "~/dsh-home-expand-probe";
  host.apply({ ...ctx, webServer: { register: (registered) => { expandRoute = registered; return () => {}; } } });
  const req = Readable.from([]);
  req.method = "GET";
  req.url = "/session-menu-delete/api/health";
  req.headers = { "x-dsh-plugin-call": "1" };
  let payload;
  await expandRoute.handler(req, { writeHead: () => {}, end: (text) => { payload = JSON.parse(text); } });
  const expected = join(homedir(), "dsh-home-expand-probe");
  check("DSH_HOME='~/x' 被展开成绝对路径（与 DSH 的 expandHomePath 同语义，早先会拼出相对路径）",
    payload.result.home === expected);
  process.env.DSH_HOME = original;
}

// ---- 真 HTTP 服务器下的访问控制（新增）------------------------------------
// 上面的用例用的是手造 req/res；这一节走真实 node:http + fetch，
// 证明 headerOf/requestRejection 在真实 IncomingMessage.headers 上同样成立。
{
  const { createServer, request: httpRequest } = await import("node:http");
  let serverRoute;
  host.apply({
    ...ctx,
    get: (key) => (key === "connection"
      ? {
        // 模拟 DSH 的围栏：Host 必须回环；带 Origin 时必须与 Host 同源（同源视为已认证，
        // 因为真实实现读的是会话 cookie）；无 Origin 的按"本机脚本"处理 -> 401。
        requestRejection: (req) => {
          const host = String(req.headers.host ?? "");
          if (!/^(127\.|localhost|\[::1\])/.test(host)) return 403;
          const origin = req.headers.origin;
          if (origin === undefined) return 401;
          try { return new URL(origin).host === host ? undefined : 403; }
          catch { return 403; }
        }
      }
      : ctx.get(key)),
    webServer: { register: (registered) => { serverRoute = registered; return () => {}; } }
  });
  const server = createServer((req, res) => { void serverRoute.handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/session-menu-delete/api`;
  try {
    const noHeader = await fetch(`${base}/health`);
    check("真 HTTP：缺 x-dsh-plugin-call -> 403", noHeader.status === 403);

    const withHeader = await fetch(`${base}/health`, { headers: { "x-dsh-plugin-call": "1" } });
    check("真 HTTP：带头 -> 200", withHeader.status === 200 && (await withHeader.json()).ok === true);

    const localPost = await fetch(`${base}/delete`, {
      method: "POST",
      headers: { "x-dsh-plugin-call": "1", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "../../etc" })
    });
    check("真 HTTP：本机脚本（无 Origin）照常放行，由业务校验拦非法 id -> 400", localPost.status === 400);

    const evil = await fetch(`${base}/health`, {
      headers: { "x-dsh-plugin-call": "1", origin: "https://evil.example" }
    });
    check("真 HTTP：异源 Origin 被 connection.requestRejection 拦下 -> 403", evil.status === 403);

    const sameOrigin = await fetch(`${base}/health`, {
      headers: { "x-dsh-plugin-call": "1", origin: `http://127.0.0.1:${server.address().port}` }
    });
    check("真 HTTP：同源 Origin 放行 -> 200", sameOrigin.status === 200);

    // P0 回归（真 HTTP）：伪造 Host、且**不带 Origin** —— DNS-rebinding 的形态。
    // 注意不能用 fetch：undici 把 Host 当禁改头，会按 URL 重写；必须用裸 http.request。
    const rebindingStatus = await new Promise((resolve, reject) => {
      const probe = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        path: "/session-menu-delete/api/health",
        method: "GET",
        headers: { "x-dsh-plugin-call": "1", host: "evil.example" }
      }, (res) => { res.resume(); resolve(res.statusCode); });
      probe.on("error", reject);
      probe.end();
    });
    check("真 HTTP：伪造 Host 且无 Origin 被 403 拦下（围栏无条件执行）", rebindingStatus === 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---- 汇总 -----------------------------------------------------------------
console.log("\n" + CONTRACT.join("\n"));
const failed = CONTRACT.filter((line) => line.startsWith("FAIL"));
console.log(`\n${CONTRACT.length - failed.length}/${CONTRACT.length} 通过`);
console.log(`临时 DSH_HOME: ${home}`);
process.exitCode = failed.length === 0 ? 0 : 1;
