/**
 * client 半的离线冒烟测试：mock Module Loader / React / primitives / fetch，
 * 验证注册到正确的 slot、参数正确、点击到删除请求的整条链路。
 */
const CONTRACT = [];
const check = (label, condition) => {
  CONTRACT.push(`${condition ? "PASS" : "FAIL"}  ${label}`);
  return condition;
};

let loaderSpec;
let capturedElement;
let menuClosed = false;
let confirmCalls = 0;
const fetchCalls = [];
const alerts = [];
const refreshed = [];
const localeRegistrations = [];
const registered = [];
const injectedSlots = [];

globalThis.window = {
  __ModuleLoader__: { load: (spec) => { loaderSpec = spec; } },
  confirm: () => { confirmCalls += 1; return true; },
  alert: (message) => { alerts.push(message); }
};
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return { status: 200, json: async () => ({ ok: true, result: { sessionId: "session-x" } }) };
};

const React = {
  createElement: (type, props, ...children) => {
    capturedElement = { type, props, children };
    return capturedElement;
  }
};
const MenuItemButton = function MenuItemButton() {};
const IconTrashOutlineRegular = function IconTrashOutlineRegular() {};

const requireShim = (name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return { MenuItemButton, IconTrashOutlineRegular };
  throw new Error(`unexpected require: ${name}`);
};

// ---- 加载 client 半 -------------------------------------------------------
await import(new URL("./lib/client.js", import.meta.url).href);
check("Module Loader 收到注册调用", loaderSpec !== undefined);
check("loader id 与包名一致", loaderSpec?.id === "dsh-session-menu-delete");

const mod = loaderSpec.factory(requireShim);
check("导出 apply", typeof mod.apply === "function");
check("导出 inject（含 slots/locale/sessions/workspaces）",
  Array.isArray(mod.inject) && ["slots", "locale", "sessions", "workspaces"].every((key) => mod.inject.includes(key)));

// ---- 应用 -----------------------------------------------------------------
const ctx = {
  effect: (fn) => { fn(); },
  locale: {
    register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); },
    bind: (ns) => (key, params) => {
      const template = localeRegistrations.at(-1)?.dicts?.zh?.[key] ?? key;
      if (params === undefined) return template;
      return Object.keys(params).reduce((text, name) => text.split(`{${name}}`).join(String(params[name])), template);
    }
  },
  slots: {
    inject: (name, install) => { injectedSlots.push(name); install(); },
    register: (spec, Component) => { registered.push({ spec, Component }); }
  },
  sessions: { refresh: async () => { refreshed.push("sessions"); } },
  workspaces: { refresh: async () => { refreshed.push("workspaces"); } }
};

mod.apply(ctx);

check("注册了 zh/en 字典", localeRegistrations.length === 1 && localeRegistrations[0].ns === "session-menu-delete"
  && localeRegistrations[0].dicts.zh["menu.delete"] === "删除会话");
check("向 sidebar.workspaces.session.menu.item 注入了插槽", injectedSlots.includes("sidebar.workspaces.session.menu.item"));
check("只注册了一个菜单条目", registered.length === 1);

const entry = registered[0];
check("slot 名正确", entry.spec.name === "sidebar.workspaces.session.menu.item");
check("order=500（落在内置 archive=400 之后）", entry.spec.order === 500);
check("id 稳定", entry.spec.id === "session-menu-delete");
check("locale 命名空间正确", entry.spec.locale === "session-menu-delete");

// ---- 渲染与点击 -----------------------------------------------------------
const face = entry.spec.inject();
check("inject face 暴露 requestDelete", typeof face.requestDelete === "function");

const element = entry.Component({
  sessionId: "session-x",
  displayTitle: "测试会话",
  useMenuOpenState: () => [true, () => { menuClosed = true; }],
  t: (key) => (key === "menu.delete" ? "删除会话" : key),
  requestDelete: face.requestDelete
});
check("渲染的是 MenuItemButton", element.type === MenuItemButton);
check("不带分组分隔线", element.props.separatorBefore === undefined);
check("前面带了垃圾桶图标", element.props.icon !== undefined && element.props.icon.type === IconTrashOutlineRegular);
check("标记为危险操作（danger，红字）", element.props.danger === true);
check("文案为「删除会话」", element.children[0] === "删除会话");

element.props.onSelect();
check("点击后菜单被关闭", menuClosed === true);
check("不弹二次确认（点击即删）", confirmCalls === 0);
await new Promise((resolve) => setTimeout(resolve, 20));
check("点击后发出 POST /session-menu-delete/api/delete",
  fetchCalls.length === 1 && fetchCalls[0].url === "/session-menu-delete/api/delete" && fetchCalls[0].init.method === "POST");
check("请求体包含 sessionId",
  JSON.parse(fetchCalls[0].init.body).sessionId === "session-x");
check("成功后刷新了会话列表", refreshed.includes("sessions"));
check("成功后刷新了工作区列表", refreshed.includes("workspaces"));
check("没有弹出错误", alerts.length === 0);

// ---- 失败路径 -------------------------------------------------------------
globalThis.fetch = async () => ({ status: 500, json: async () => ({ ok: false, error: "会话正在运行" }) });
face.requestDelete("session-y", "另一个会话");
await new Promise((resolve) => setTimeout(resolve, 20));
check("失败时弹出错误提示", alerts.length === 1 && alerts[0].includes("会话正在运行"));

// ---- 删掉「正在看的会话」→ 界面留在那儿（有意如此）-------------------------
// 回归：早先版本会在这种情况下自动开新会话（uiWorkspace.startSession），开不起来再
// clearMain 退到空态，还配了 4 秒兜底定时器。现在整段移除：删除不该顺带改变你正在
// 看的东西。这里按 cordis 的真实形状把 uiWorkspace 打桩成"一碰就会记一笔"，
// 断言它**一次都没被碰过** —— 代码若退回去，这些记录就会非空。
const realSetTimeout = globalThis.setTimeout;
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 20));

const navCalls = [];
const nav = {
  mainReference: { sessionId: "session-current" },
  startSession: (workspaceId) => { navCalls.push(["startSession", workspaceId]); nav.mainReference = { sessionId: "session-fresh" }; },
  clearMain: () => { navCalls.push(["clearMain"]); nav.mainReference = undefined; }
};
ctx.get = (name) => (name === "uiWorkspace" ? nav : undefined);
// 旧版还会去读工作区快照（找被删会话的所属工作区）；照旧打桩，用来证明现在也不再读它。
let snapshotReads = 0;
ctx.workspaces.list = {
  getSnapshot: () => {
    snapshotReads += 1;
    return { items: [{ workspaceId: "ws-a", sessionIds: ["session-current", "session-other"] }] };
  }
};
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return { status: 200, json: async () => ({ ok: true }) };
};

const beforeNav = fetchCalls.length;
face.requestDelete("session-current");
await tick();
check("删掉当前会话后照常删除（请求已发出）", fetchCalls.length === beforeNav + 1);
check("不自动开新会话（uiWorkspace.startSession 一次都没调）",
  !navCalls.some(([name]) => name === "startSession"));
check("不主动清空主视图（clearMain 一次都没调）", !navCalls.some(([name]) => name === "clearMain"));
check("完全不碰 uiWorkspace", navCalls.length === 0);
check("也不再读工作区快照找所属工作区", snapshotReads === 0);
check("主视图仍钉在已被删除的会话上（就是原来的死界面，有意保留）",
  nav.mainReference?.sessionId === "session-current");

// 删的不是当前会话：同样什么都不做
const beforeOther = fetchCalls.length;
face.requestDelete("session-other");
await tick();
check("删别的会话时也不跳转", fetchCalls.length === beforeOther + 1 && navCalls.length === 0);

// 延长观察窗口：旧版那个 4 秒兜底定时器若还在，这里会露出来
await new Promise((resolve) => realSetTimeout(resolve, 60));
check("没有任何延迟兜底动作（旧版 4 秒定时器已移除）", navCalls.length === 0);
check("删除成功路径不弹错误", alerts.length === 1);

// ---- 汇总 -----------------------------------------------------------------
console.log("\n" + CONTRACT.join("\n"));
const failed = CONTRACT.filter((line) => line.startsWith("FAIL"));
console.log(`\n${CONTRACT.length - failed.length}/${CONTRACT.length} 通过`);
process.exitCode = failed.length === 0 ? 0 : 1;
