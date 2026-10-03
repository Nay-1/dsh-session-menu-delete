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
import { tmpdir } from "node:os";
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
const hashOrphanFresh = "c".repeat(64);   // 孤儿 + 刚生成 -> 应被新鲜度保护

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
const stateWrites = [];
const emitted = [];
const cancelled = [];

const fakeAgent = {
  cancel: (options) => cancelled.push(options),
  scope: { dispose: async () => { cancelled.push("dispose"); } }
};

const ctx = {
  logger: { info: () => {}, warn: (message) => console.log("[host warn]", message) },
  get: (key) => (key === "agents" ? { get: (id) => (id === liveId ? fakeAgent : undefined), store: { delete: () => {} } } : undefined),
  webServer: { register: (registered) => { route = registered; return () => {}; } },
  workspaceRegistry: {
    list: () => [{
      id: "ws-1",
      sessionIds: [liveId, coldId, parentId, childA, childB, grandchild, forked, forkedChild],
      detachSession: async (id) => { detached.push(id); }
    }],
    enqueueOperation: async (fn) => fn(),
    requireState: () => ({ archivedSessionIds: [coldId], pinnedSessionIds: [liveId] }),
    setState: async (next) => { stateWrites.push(next); }
  },
  effect: (fn) => { fn(); },
  emit: (event, payload) => emitted.push([event, payload])
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
const request = async (method, url, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
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
  check("GET /health → 200 ok 且标记 cascade", res.status === 200 && res.payload.ok === true
    && res.payload.result.cascade === true);
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
  check("归档集合已移除该 id",
    stateWrites.length > 0 && !stateWrites.at(-1).archivedSessionIds.includes(coldId));
  check("派发了 session/disposed", emitted.some(([event, payload]) => event === "session/disposed" && payload.id === coldId));
}

{
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: liveId });
  check("活会话删除 → 200（先摘除 agent）", res.status === 200 && res.payload.ok === true);
  check("返回值标记 wasLive", res.payload.result.wasLive === true);
  check("agent 被 cancel({kind:'disposed'})", cancelled.some((item) => item && item.kind === "disposed"));
  check("agent scope 被 dispose", cancelled.includes("dispose"));
  check("活会话工件也已删除", !existsSync(join(sessionsDir, liveId)));
  check("置顶集合已移除该 id",
    stateWrites.length > 0 && !stateWrites.at(-1).pinnedSessionIds.includes(liveId));
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
  check("每个被删会话都派发了 session/disposed",
    [parentId, childA, childB, grandchild].every((id) => emitted.some(([event, payload]) => event === "session/disposed" && payload.id === id)));
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
  check("识别出 1 个可清理孤儿（老的、无引用）", r.orphanCount === 1 && r.orphans[0].hash === hashOrphanOld);
  check("刚生成的孤儿被新鲜度保护（15 分钟窗口）",
    r.protectedFresh.some((o) => o.hash === hashOrphanFresh));
  check("tool/result 里的引用也算引用（结构化解析，非文本匹配）",
    !r.orphans.some((o) => o.hash === hashInToolResult)
    && !r.protectedFresh.some((o) => o.hash === hashInToolResult));
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
  check("删掉了 1 个孤儿（直删，没有回收站）", r.removed.length === 1 && r.removed[0] === hashOrphanOld);
  check("孤儿已从磁盘上消失",
    !existsSync(join(objectsRoot, hashOrphanOld.slice(0, 2), hashOrphanOld)));
  check("新鲜孤儿仍在原地（受保护）",
    existsSync(join(objectsRoot, hashOrphanFresh.slice(0, 2), hashOrphanFresh)));
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
const hashOwnedFresh = "1".repeat(64);  // 独享且刚生成 -> 照样要清走（主人没了，新鲜度窗口不适用）
const hashFamily = "2".repeat(64);      // 父会话 + 它的子代理共同引用 -> 级联删时应清走
const hashNoTouch = "3".repeat(64);     // 用来验证 attachments:false 开关
const hashSharedFresh = "4".repeat(64); // 新鲜 + 两个会话共享 -> 删其中一个绝不许动
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
  // 回归：曾经这里套了新鲜度窗口，导致"删掉刚读过图的会话"会把图静默留下（真踩过，一次 11 张）。
  // 独享 = 引用者全在 doomed 集合里 = 主人马上消失，窗口防的"引用没落盘"根本不适用。
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-owned-fresh" });
  check("独享的附件即使刚生成也要一并删掉（新鲜度窗口不适用于级联）",
    res.payload.result.attachmentsRemoved === 1);
  check("它已从磁盘上消失",
    !existsSync(join(objectsRoot, hashOwnedFresh.slice(0, 2), hashOwnedFresh)));
}

{
  // 反向对照：新鲜 + 共享。新鲜度不再是保护伞了，但"还有别人在用"这条必须守住 ——
  // 注意删掉最后一个引用者时它就该走（那才是独享），所以这里只删两个引用者之一。
  const res = await request("POST", "/session-menu-delete/api/delete", { sessionId: "session-share-p" });
  check("新鲜但被别的会话共享 -> 一律不动（removed=0）", res.payload.result.attachmentsRemoved === 0);
  check("共享的新鲜附件仍在原地",
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

// ---- 汇总 -----------------------------------------------------------------
console.log("\n" + CONTRACT.join("\n"));
const failed = CONTRACT.filter((line) => line.startsWith("FAIL"));
console.log(`\n${CONTRACT.length - failed.length}/${CONTRACT.length} 通过`);
console.log(`临时 DSH_HOME: ${home}`);
process.exitCode = failed.length === 0 ? 0 : 1;
