/**
 * dsh-session-menu-delete — Client half.
 *
 * 往侧栏会话行 “...” 菜单（`sidebar.workspaces.session.menu.item`）注册一项
 * 「删除会话」。内置条目的 order 是 pin=100 / rename=200 / fork=300 /
 * archive=400，本项取 500，紧跟在「归档会话」下方（不加分组分隔线）。
 *
 * 条目只拿到行身份（sessionId、displayTitle），其余自己负责：调用 host 半的
 * 删除 API、刷新会话与工作区列表。按用户要求不做二次确认 —— 点击即删除。
 *
 * 删掉的若是「正在看的那个会话」，**界面就留在那儿**（有意如此）：主视图仍钉在
 * 那个 id 上，对话面板显示「会话不可用」，直到你自己点开另一个会话。插件不碰
 * uiWorkspace、不自动开新会话 —— 删除不该顺带改变你正在看的东西。
 *
 * 打包形态：DSH 的 Module Loader 包（factory(require)），无构建步骤。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-menu-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 内置宿主样式按钮；若 primitives 版本里没有它，退回等价的自绘按钮，
     *  绝不让 undefined 流进 createElement 把整个侧栏渲染搞崩。 */
    const FallbackMenuItemButton = function FallbackMenuItemButton(props) {
      const onSelect = props?.onSelect;
      const parts = [];
      if (props?.icon !== undefined && props?.icon !== null) {
        parts.push(React.createElement("span", { key: "icon", className: "smd-fallback-icon" }, props.icon));
      }
      parts.push(React.createElement("span", { key: "label" }, props?.children));
      return React.createElement("button", {
        type: "button",
        role: "menuitem",
        className: "smd-fallback-menuitem",
        onClick: () => { try { if (typeof onSelect === "function") onSelect(); } catch { /* ignore */ } }
      }, parts);
    };
    const MenuItemButton = (primitives && typeof primitives.MenuItemButton === "function")
      ? primitives.MenuItemButton
      : FallbackMenuItemButton;

    /** 与内置菜单项同一套图标（置顶项用的是 IconPinOutlineRegular 那种）。
     *  取不到就不传 icon —— 菜单项照常渲染，只是前面空一格。 */
    const TrashIcon = (primitives === undefined || primitives === null)
      ? undefined
      : primitives.IconTrashOutlineRegular;

    const NS = "session-menu-delete";
    const API = "/session-menu-delete/api";

    const zh = {
      "menu.delete": "删除会话",
      "error.delete": "删除失败：{message}",
      "error.noapi": "删除接口没有响应，host 半可能未加载"
    };
    const en = {
      "menu.delete": "Delete session",
      "error.delete": "Delete failed: {message}",
      "error.noapi": "Delete endpoint did not respond; the host half may not be loaded"
    };

    const alertFn = (message) => {
      try {
        if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(message);
      } catch { /* ignore */ }
    };

    function DeleteMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t, requestDelete } = props;
      const menuState = typeof useMenuOpenState === "function" ? useMenuOpenState() : undefined;
      const setMenuOpen = Array.isArray(menuState) ? menuState[1] : undefined;
      const label = typeof t === "function" ? t("menu.delete") : zh["menu.delete"];
      const itemProps = {
        // 破坏性操作：用 primitives 给危险行准备的样式（与「删除工作区」同一套）
        danger: true,
        onSelect: () => {
          try { if (typeof setMenuOpen === "function") setMenuOpen(false); } catch { /* ignore */ }
          requestDelete(sessionId, displayTitle);
        }
      };
      if (TrashIcon !== undefined && TrashIcon !== null) {
        itemProps.icon = React.createElement(TrashIcon, {});
      }
      return React.createElement(MenuItemButton, itemProps, label);
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      const translate = (key, params) => {
        try {
          const bound = ctx.locale?.bind?.(NS);
          if (typeof bound === "function") return bound(key, params);
        } catch { /* 回落到内置中文 */ }
        const template = zh[key] ?? key;
        if (params === undefined) return template;
        return Object.keys(params).reduce(
          (text, name) => text.split(`{${name}}`).join(String(params[name])),
          template
        );
      };

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-menu-delete: dictionaries");

      /*
       * 删掉「正在看的那个会话」之后**不做任何跳转** —— 界面留在那个已经不存在的会话上，
       * 对话面板显示「会话不可用」，直到你手动点开别的会话。这是 DSH 的原生表现：
       * 主视图（ui-workspace 的 uiWorkspace 服务持有 mainReference）只在会话被「归档」时
       * 自动让位（clearArchivedCurrent），被彻底删除时不会。
       *
       * 早先版本在这里"补救"过：发现删的是当前会话就调 uiWorkspace.startSession() 开一个
       * 新会话，开不起来再 clearMain() 退到空态（还配了 4 秒兜底定时器）。那套已经移除：
       * 删除不该顺带改变你正在看的东西 —— 想要新会话，点侧栏的「新会话」按钮。
       * 代价是删掉当前会话后要自己点一下别处；换来的是行为可预期（不再有意外的跳转与空态）。
       *
       * 因此 client 半完全不碰 uiWorkspace：连 `ctx.get("uiWorkspace")` 那套探测取值也删了。
       */
      const requestDelete = (sessionId) => {
        fetch(`${API}/delete`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // host 半要求这个自定义头：自定义头必然触发 CORS 预检，而服务端不返回
            // 任何 CORS 响应头 -> 预检失败 -> 网页根本发不出删除请求。
            "x-dsh-plugin-call": "1"
          },
          body: JSON.stringify({ sessionId })
        })
          .then((res) => res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })))
          .then(async (data) => {
            if (data === null || typeof data !== "object" || data.ok !== true) {
              throw new Error((data && data.error) || translate("error.noapi"));
            }
            // 会话行的消失由 host 侧推送完成（host 发 `api-session/removed`，
            // 客户端 handleSessionRemoved 接住并摘掉那一行）；这里再拉一次
            // 权威 baseline 兜底。`sessions.refresh()` 是真实存在的
            // （ClientSessions.refresh -> refreshList）。
            try { await ctx.sessions.refresh(); } catch { /* 列表刷新失败不影响删除结果 */ }
            // 早先这里还有 `ctx.workspaces?.refresh?.()` —— 已删除：client 的 workspaces
            // 服务根本没有 refresh 方法（可选链会静默短路），而且工作区快照
            // （buildSnapshot -> { items, archivedSessionIds, pinnedSessionIds, ... }）
            // 不携带会话成员，删会话本来就不需要刷新工作区。
          })
          .catch((error) => {
            alertFn(translate("error.delete", { message: (error && error.message) || String(error) }));
          });
      };

      slots.inject("sidebar.workspaces.session.menu.item", () => slots.register({
        name: "sidebar.workspaces.session.menu.item",
        id: "session-menu-delete",
        order: 500,
        locale: NS,
        inject: () => ({ requestDelete })
      }, DeleteMenuItem));
    }

    const inject = ["slots", "sessions", "workspaces", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
