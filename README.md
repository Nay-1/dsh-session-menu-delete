# dsh-session-menu-delete

给 [DeepSeek Harness](https://github.com/) 侧栏「会话行 ⋯ 菜单」加一项 **删除会话** —— 位置紧跟在「归档会话」下方，带垃圾桶图标，红色破坏性样式。

DSH 原生只有「归档」，没有删除；这个插件把它补上，并且**连带清理子代理会话**（不留孤儿），同时**保护 fork 出来的会话**。

## 它加在哪

那个菜单就是插槽 `sidebar.workspaces.session.menu.item`，内置四项的 `order` 是：

| 条目 | 来源 | order |
|---|---|---|
| 置顶会话 | 内置 | 100 |
| 重命名 | 内置 | 200 |
| 分叉会话 | 内置 | 300 |
| 归档会话 | 内置 | 400 |
| **删除会话** | **本插件** | **500** |

图标用 primitives 的 `IconTrashOutlineRegular`（与内置菜单项同一套），并以 `danger: true` 渲染成破坏性操作的红字。

## 点了会删什么

**点击即删，没有二次确认。** client 半发 `POST /session-menu-delete/api/delete`，host 半依次处理：

1. **会话工件目录** `<DSH_HOME>/sessions/<slug>/<sessionId>/`
2. **投影缓存记录** `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`
3. **工作区账本归属** —— 走 `workspaceRegistry` 服务的 `entity.detachSession()`，而不是直接改 `workspace.json`（否则 DSH 的内存态会在下次写盘时把手改的内容覆盖回去）
4. **归档 / 置顶集合**里的该 id
5. **它派生出的子代理会话**（级联，见下）
6. **它独享的附件对象**（顺手清理，见下 —— 被别的会话共享的一律不动）

会话仍在运行时，先按 DSH 自己的 dispose 顺序摘除：`agent.cancel({kind:'disposed'})` → **`await agent.whenIdle()`** → `agent.scope.dispose()`，**各自带超时、任一超时就中止整个删除**（绝不在 loop 还在收尾、句柄还没关的时候动文件），然后 `sessions.flush()` + 摘 sessions 条目（这一步会发出 DSH 原生的 `session/disposed`）。

摘 agent 时会**补发配对的 `agent/disposed`**：`agents.enter()` 返回的正规 detach 闭包只交给 owner fiber，插件拿不到，而 `detachEntered` 开头的 `if (this.store.get(entry.id) !== entry) return;` 会让这条边**永久**发不出去（下游 goal-round-driver / schedule / subagent / file-reference / agent-team 会一直收不到）。补发的 payload 形状与 DSH 一致（`{ agent }`），只对已 announce 的条目发；已知不精确之处是构造不出 DSH 的 scope carrier，因此这次补发会到达所有 scope 的监听者。

> ⚠️ **全部不可恢复**：会话工件没有回收站，附件也没有 —— 删掉就是删掉（早期版本给附件配过回收站，后来去掉了，理由见「附件孤儿清理」一节）。

## 删掉「正在看的那个会话」：界面就留在那儿

主视图（右侧对话面板）由 ui-workspace 的 `uiWorkspace` 服务持有，钉在一个 `mainReference` 上。DSH 只在会话被**归档**时让它自动让位（`clearArchivedCurrent`）—— 会话被**彻底删除**时不会，引用还指着已经不存在的 id，输入框就退化成「会话不可用」。

**本插件不再干预这件事**：删掉当前会话后，界面就留在那个已经不存在的会话上（「会话不可用」），直到你自己点开另一个会话。想要新会话，点侧栏的「新会话」按钮。

| 删的是 | 行为 |
|---|---|
| 当前正在看的会话 | **什么都不做** —— 界面停在已删会话上（有意如此） |
| 其它会话 | 什么都不做，你正在看的不受影响 |

> 早期版本会"补救"：发现删的是当前会话，就调 `uiWorkspace.startSession(workspaceId)` 开一个新会话（`ctx.workspaces.list.getSnapshot()` 找所属工作区，工作区没了就传 `undefined`），4 秒后若主视图仍钉在已删 id 上再 `clearMain()` 退到空态。那套已经**整段移除** —— 理由：
>
> - **删除不该顺带改变你正在看的东西**：一次点击同时"删掉会话 + 切走界面"是两个动作，而另一个动作并不是你要求的；顺带切走还会把新会话插进列表、改变你的上下文。
> - **可预期**：跳转依赖三个软依赖（`uiWorkspace.startSession`、`clearMain`、工作区快照），任一个拿不到就静默降级成"开不出来 / 退空态"，行为随环境变化。
> - 代价是删完要自己点一下别处（或按侧栏的「新会话」）；换来的是"点了什么就发生什么"。
>
> 因此 client 半**完全不碰 `uiWorkspace`**：连 `ctx.get("uiWorkspace")` 那套探测取值也删了。测试里把 uiWorkspace 打桩成"一碰就记一笔"，断言它一次都没被调用（代码若退回去，断言立刻失败）。

## 级联删除：只链子代理，绝不碰分叉

子代理会话是**独立落盘的会话工件**（与父会话平级放在同一个 slug 目录里），header 长这样：

```json
{ "id": "<child-id>", "parentSession": "<parent-id>", "origin": "subagent", "delegationDepth": 1 }
```

不做级联就会留下孤儿：父会话没了、子代理却还在磁盘上，甚至继续作为独立会话行出现在侧栏。所以删除时会：

1. 扫全部会话工件的首行 header —— zstd 只解压到**第一个换行**就停，不展开整份日志；
2. 只把 `origin === 'subagent'` 的会话放进血缘图，顺着 `parentSession` **递归**收集后代（子代理还能再起子代理，深度 2、3…）；
3. **先删后代、再删自己**。

```
主会话 ─┬─ 子代理           → 一起删 ✓
        └─ fork 出来的副本   → 保留 🔒
             └─ 它的子代理    → 也保留 🔒（级联不穿过 fork）
```

> 🔒 **分叉会话受保护**：用户主动 fork 出来的会话同样带 `parentSession`，但**没有** `origin` 标记 ——
> 它们永远不进血缘图，删父会话时**一律保留**。这条边界有专门的测试用例守着。

fork 出来的会话是**自包含**的：分叉那一刻，历史以数据形式（`seed`）写进新工件，`seedLength` 只是水位计数、不是指向父文件的引用。所以删掉父会话，副本的内容完整、可以继续对话；唯一的残留是它 header 里的 `parentSession` 变成悬空血缘（仅元数据，不影响使用）。

想只删目标会话、不动它的子代理，请求体加 `{"cascade": false}`。
想先看看会连带删掉谁，`GET /session-menu-delete/api/lineage?sessionId=<id>` 会列出全部后代。

## 附件孤儿清理：看一眼就等于引用一次

> 📖 **机制详解见 [ATTACHMENT-CLEANUP.md](ATTACHMENT-CLEANUP.md)** —— 那一份讲清楚了判据的两个引用来源、判据的演进、以及草稿为什么不需要保护。
> 本节是速览。

附件不塞在会话日志里，而是**内容寻址**的独立对象：

```
<DSH_HOME>/attachments/v1/objects/<前2位>/<内容的 sha256>
```

日志里只留一句引用。好处是同一张图只存一份（去重）；代价是**删会话只摘引用、不动物件**，于是攒下没人引用的孤儿。

图片在磁盘上有**两个**位置，别搞混（只有第一个是本插件管的）：

| 位置 | 是什么 | 能删吗 |
|---|---|---|
| `attachments/v1/objects/<前2位>/<sha256>` | **持久**附件，一份原始图，会话历史按哈希引用它 | 删了会话就裂图，只能按下面的规则清 |
| `cache/attachments/request-images/<变体哈希>` | DSH 自己给**模型请求**生成的图片版本（按路由缩放/重新编码后缓存，跨轮复用）——不是本插件写的 | **随便删**，下次读取自动重建 |

> ⚠️ 还有 `attachments/v1/file-objects/` 与 `attachments/v1/files/`（**文件类**附件），本插件**不清理** —— 漏删，不是误删。`/health` 的 `attachmentKinds` 如实回显。

> `objects/<前2位>/` 这层分片目录**不会自己消失**：早期版本只搬走文件、留下空壳，在文件管理器里看着就是"一堆空文件夹"。现在删完对象会回头检查动过的分片、空了就删（有测试守着）。

> ⚠️ **删除不可撤销 —— 本插件没有回收站。**（早期版本有一个，后来去掉了：见下方"为什么不要回收站"。）
> 所以 `--clean` / `POST /attachments/clean` 是**真删**，删之前先用只读预览看清楚。

清理有**两个**入口，共用同一套判据：

| 入口 | 触发方式 | 清理范围 |
|---|---|---|
| **随会话删除顺手清**（默认开启） | 点菜单里的「删除会话」 | 只清**引用者全部落在本次被删集合内**的附件（含级联的子代理）；被 fork 副本或其它会话共享的一律不动；**零引用**的也不归它管 |
| **独立清理** | `POST /attachments/clean` | **全库**范围内所有孤儿 |

两者都是**直接删除、立即生效**：判定为独享（或独立清理判定为零引用）就当场删。顺手清理可用请求体 `{"attachments": false}` 关掉。

> **引用集合有两个来源，缺一不可：**
> 1. **活会话的内存事件**（`sessions.list()` → `session.ownEvents()`）—— 未落盘的引用在这里可见，几乎零成本（纯对象遍历，不解压、不解析 JSON）；
> 2. **磁盘上的会话日志** —— 已经落盘的引用（含 fork 的 seed 历史）。
>
> 只看磁盘会有一个**结构性盲区**：一个「仍然存活、刚看过这张图、但引用还没落盘」的会话在磁盘上**根本不可见**，于是对象看起来"没人要了" —— 这正是 README 里记的那次 `Attachment object is missing.`。**补上内存来源之后盲区就关闭了**，这才是真正的修复。

> ⚠️ **草稿里的图不需要保护**：图片是**发送时**才入库的（`admitPromptContent` → `saveImage`），贴进输入框时客户端只留字节、磁盘上**没有对象**。所以「删别的会话会不会弄裂我的草稿」—— **不会**。文件类附件倒是贴图时就上传，但它们的实体在 `file-objects/`、`files/`，**本插件不碰那两个目录**。

> **为什么不要回收站？** 它救不了真正想救的东西：**删错会话时，会话日志本身不可恢复**，把附件还原出来也没有任何会话引用它们，等于一堆没主的图片躺在磁盘上。而它能救的唯一场景（误判"没人引用"→ 活会话裂图）代价换不来一个看不见、不会过期、只有 CLI 才能操作的目录。去掉之后判据反而更硬：**进不了"确定没人再用"这一步，就一个字节都不删。**

> 为什么删会话不干脆"把它引用过的图全清掉"？因为附件是**共享**的：fork 会复制历史，历史里的图片引用也跟着复制。若照着"这个会话引用过哪些图"去删，副本里的图会集体变裂图。判据必须是**引用者是否全部落在此次被删的集合内**，而不是"这个会话引用过它"。

清理这件事有个反直觉的坑：**"看一眼"就等于"引用一次"**。用 `read_image` 读一张图，DSH 会把它登记成该会话的图片附件并写进事件流 —— 若删除依据是一次**陈旧的扫描**，就会删掉一个其实已被引用的对象，之后组装模型请求时报 `Attachment object is missing.`（真踩过，当时靠一个临时探针文件才手工救回来）。同理，**别用文本搜哈希来判断"有没有人引用"**：探针自己打印的哈希被写进日志后，会造成 100% 的假命中。所以清理走三条规则：

1. **删除瞬间重算**引用，绝不复用上一次的扫描结果；
2. **结构化解析** `attachmentId`（递归遍历事件 JSON，含 `tool/result` 里的图片），不做文本匹配 —— 文本搜 64 位 hex 会把日志里任何偶然的长十六进制串都当成引用（实测：探针自己打印的哈希写进日志后，11/11 全部假命中）；
3. **内存 + 磁盘两个来源都算**：活会话的 `ownEvents()` 覆盖「还没落盘」的引用，磁盘日志覆盖「已经落盘」的（含 fork 的 seed 历史）。只看磁盘就是那个会误删的盲区。

没有回收站之后，这三条规则就是全部的防线，所以一条都不能省。

```powershell
# 所有端点都要求自定义头 x-dsh-plugin-call: 1（见「HTTP 端点」一节的说明）
$h = @{ "x-dsh-plugin-call" = "1" }

# 1. 先看会删谁（只读，不动文件）
Invoke-RestMethod "http://127.0.0.1:19387/session-menu-delete/api/attachments/orphans" -Headers $h | ConvertTo-Json -Depth 5

# 2. 确认后删除（不带 confirm 同样只预览）
Invoke-RestMethod -Method Post "http://127.0.0.1:19387/session-menu-delete/api/attachments/clean" `
  -Headers $h -ContentType "application/json" -Body '{"confirm":true}' | ConvertTo-Json -Depth 5
```

## 安装

把本仓库放到本地任意目录，然后用它的**绝对路径**安装：

```powershell
dsh plugin --profile desktop add "file:<本仓库所在目录的绝对路径>"
```

`dsh plugin --profile <name> <args>` 会把参数**转发给 pnpm**，所以包由 pnpm 管理（`nodeLinker: hoisted`）。

装完还必须让 DSH 知道要加载它，二选一：

- 在 DSH 的 **「插件」页面**里启用（会写 `dsh.profile.bundles`）；
- 或手工把 `"dsh-session-menu-delete"` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组。

**改动怎么生效：两半不一样。**

| 改的是 | 生效方式 |
|---|---|
| `lib/client.js`（client 半） | **热更新**：不重启 DSH，也不用刷新页面 |
| `lib/index.js`（host 半） | **必须重启 DSH**（Node 侧模块不会被热替换） |
| `cordis.patch.yml`（bundle 层） | 必须重启 DSH（启动时才读插件树） |

client 半之所以能热更，是因为 DSH 的 `dsh-client-modules` 一直在**看着**插件工件：它给每个条目留一份 `artifactBaseline`（mtime/ctime/size），文件一变就用新 revision 重打 bundle，客户端那侧的 HMR receiver 收到就把模块换掉（菜单项的 slot 注册随之 dispose + 重新 register）。实测：改完 `lib/client.js` 直接点菜单就是新行为（DSH Desktop 里既不用重启也不用刷新）。

> ⚠️ **注意"副本"这件事**：DSH 加载的是 profile 里的 `node_modules/dsh-session-menu-delete`，热更看的也是**那一份** —— 所以改完源码得确认副本跟着变了。
>
> **`file:` 依赖在 profile 里的落地形态，实测可能是「硬链接」而不是拷贝。**（`nodeLinker: hoisted`，实测 pnpm 11.7.0）
> 本机实测：`lib/client.js`、`cordis.patch.yml`、`package.json` 与源文件是**同一个 inode**（`fsutil hardlink list` 会列出两个路径），此时改源码即等于改副本，连同步都省了；而 `lib/index.js`、`README.md` 则是各自独立的文件。
> 别依赖这个差别 —— 一次 `git checkout` / `revert` 就会把源文件换成新 inode，链接静默断掉。
>
> 而 `add` / `install` / `install --force` 都会回一句 `Already up to date` 并留下**旧副本**；
> 把 `node_modules/dsh-session-menu-delete` 删掉再 `install` 也不会重建（随后 DSH 启动会报
> `cannot resolve profile bundle`）。可靠的做法是删掉旧目录后**手动同步一次**：
>
> ```powershell
> $src = "<本仓库绝对路径>"; $dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-menu-delete"
> Remove-Item -Recurse -Force $dst
> Copy-Item -Recurse -Force $src $dst
> Remove-Item -Recurse -Force "$dst\.git"
> ```
>
> 校验是否同步到位（两边哈希应一致）：
>
> ```powershell
> (Get-FileHash "$src\lib\client.js").Hash; (Get-FileHash "$dst\lib\client.js").Hash
> ```

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-session-menu-delete
```

再从 `dsh.profile.bundles` 里删掉 `"dsh-session-menu-delete"` 这一行，重启 DSH 即完全还原。

## HTTP 端点

> 🔒 **所有端点都要求请求头 `x-dsh-plugin-call: 1`。** 自定义头必然触发 CORS 预检，而本服务端不返回任何 CORS 响应头 → 预检失败 → **网页根本发不出这个请求**。本机脚本/命令行补一个头即可（零成本）。
> 另外，**带 `Origin` 的浏览器请求**还会走 DSH 自己的 Host/Origin 围栏 + 会话 cookie 校验（`connection.requestRejection`：跨站/异源 403、未认证 401）；本机脚本不带 `Origin`，不受影响。

| 方法与路径 | 作用 |
|---|---|
| `POST /session-menu-delete/api/delete` | 删除会话（默认级联子代理）；body `{ sessionId, cascade?, attachments? }` |
| `GET /session-menu-delete/api/lineage?sessionId=<id>` | 预演级联：列出该会话全部子代理后代 |
| `GET /session-menu-delete/api/attachments/orphans` | 预览附件孤儿（只读，不动文件） |
| `POST /session-menu-delete/api/attachments/clean` | 删除孤儿；body `{ confirm: true }` |
| `GET /session-menu-delete/api/health` | 存活检查，回显各根目录与能力标记 |

`/delete` 的响应里带 `attachmentsRemoved`（本次顺手清掉的独享附件数）、`cascadeRemoved` / `cascadeIds`、**`cascadeFailed`**（级联里没删掉的子代理 —— 它们现在是无主孤儿，静默会让调用方以为级联完整）。

`/attachments/orphans` 与 `/attachments/clean` 的响应里带 `totalObjects` / `referenced` / `orphanCount` / `orphanBytes` / `orphans`（含 hash、大小、年龄）/ `removed`。

`/health` 里三个刻意回显的能力标记：

- `attachmentsRecoverable: false` —— **删掉的附件捡不回来**；
- `attachmentKinds: ["image-objects"]` —— 只管 `attachments/v1/objects`（图片对象）。**`file-objects/` 与 `files/` 下的文件类附件本插件不清理**，如实回显，别以为"附件都管了"。

### 可调项

bundle patch 的 `config:` 支持两个可选项（默认都是 8000ms）：

```yaml
- insert:
    - id: dsh-session-menu-delete
      name: 'dsh-session-menu-delete'
      config:
        idleTimeoutMs: 8000          # 等 agent.whenIdle() 的上限
        disposeTimeoutMs: 8000       # 等 agent.scope.dispose() 的上限
```

任一超时都会**中止删除**并回 409 `busy`，响应里的 `error` 会区分「超时」与「被拒绝」。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 半：cordis 插件，会话删除 + 血缘扫描 + 附件孤儿清理 + HTTP 端点 |
| `lib/client.js` | client 半：Module Loader 包（`factory(require)`，无构建步骤），注册菜单项 |
| `cordis.patch.yml` | bundle 层 patch：往插件树里 insert 一行 |
| `test-host.mjs` | host 半离线冒烟测试（106 项：级联 / fork 保护 / 附件清理 / 顺手清理 / **内存引用盲区** / 分片收尾 / 访问控制（含 DNS-rebinding）/ 真 HTTP 服务器 / retire 中止（拒绝与超时两条路径）/ 级联失败回报 / 多世代选件 / DSH_HOME 展开） |
| `test-client.mjs` | client 半离线冒烟测试（35 项：菜单注册 / 点击链路 / 请求头 / 删当前会话后不跳转 / 各种兜底） |

测试用**临时 `DSH_HOME` + mock 服务**跑，工件用真实的多帧 zstd 写（header 帧 + 正文帧），
级联血缘走的是与线上完全相同的解压路径；全程不碰真实会话数据：

```powershell
node test-host.mjs
node test-client.mjs
```

## 已知边界

- **点击即删**：没有二次确认，误点无法撤回（仅在删除失败时 `alert` 报错）。
- **附件也是直删**：没有回收站、没有 undo。误判的代价不可恢复 —— 所以先跑只读预览（`GET /attachments/orphans`）再动手，永远不会错。
- 删掉当前正在看的会话后，**界面就留在那个已删会话上**（对话面板显示「会话不可用」），插件不跳转、不开新会话、也不清空主视图 —— 想要新会话点侧栏的「新会话」（详见上文）。
- 级联只认 `origin === 'subagent'`；fork 出来的会话（有 `parentSession`、无 `origin`）一律不删。
- 附件清理只动 `attachments/v1/objects` 下的对象，判据是**引用集合**（活会话的 `ownEvents()` **并上**磁盘日志的结构化 `attachmentId`）；独享即删、零引用即孤儿。给出「孤儿」结论时，别只用文本搜哈希：探针自己打印的哈希写进日志会 100% 假命中，必须解析 JSON 里的 `attachmentId`。
- 运行时若 `node:zlib` 没有 zstd 支持，血缘扫描读不到 header，级联会**退化为只删目标会话**；附件清理同样读不到引用，此时会**一个都不删**（保守方向，不会误删）。
- 对内部服务的访问一律**窄化取值**：拿不到 `workspaceRegistry` 就跳过"账本摘除"这一步，而不是让整个删除失败（比如服务还没注册好、或在其它宿主里被加载）。代价是这种情形下账本不会更新 —— 实时运行时有 `inject` 保证服务存在，正常不会走到这里。
- 删除回报的 `filesRemoved` / `cacheRemoved` 是**如实**的：`rm(..., {force: true})` 对不存在的路径不报错，所以这两项都不能拿"没抛异常"当"删掉了"（投影缓存那条先 `stat` 确认；工件那条本来就走 `locateSessionDir` 定位）。
- ✅ **端点来源校验（已修）。** `/session-menu-delete/api/*` 是插件自己的前缀路由，**不经 DSH 的鉴权网关** —— 那层闸门写在 `client-connection` 自己的 `/api` 路由**内部**（`requestRejection`：跨站/异源 403、未认证 401），而 `dsh-host-webserver` 本身零鉴权，所以插件路由天然绕过它。实测确认：DSH 自身路由 `GET /` → 401，插件路由 `GET /…/api/health` → **200（无任何凭据）**。
  **现在两层都补上了**：① 所有端点要求 `x-dsh-plugin-call: 1`（自定义头必然触发 CORS 预检，服务端不返回 CORS 头 → 预检失败 → 网页发不出来）；② **Host/Origin 围栏对每个请求都执行**（`connection.requestRejection`）—— 403 一律拦下，401 只对带 `Origin` 的浏览器请求拦下，本机脚本不带 `Origin` 照常可用。
  ⚠️ ②必须**无条件**执行：自定义头只挡得住**跨源**请求，而 DNS-rebinding 页面与目标**同源** —— 不预检、可自由设置自定义头，同源 GET 又不带 `Origin`。只有无条件跑围栏（Host 必须回环/受信）才拦得住这一路。
  **仍然保留的风险**：本机同用户的其它进程不受限制 —— 但那在桌面应用里本来就不是安全边界（它们能直接读写 `~/.dsh`）。服务端只绑 `127.0.0.1`（DSH 也硬拒 `--host 0.0.0.0`），不是局域网暴露。
- client 半优先用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton`；该组件缺失时退回自绘 `role="menuitem"` 按钮，不会让侧栏渲染崩掉。
- **DSH 侧没有任何会话删除 API。** 全包搜索确认：`removeSession` / `deleteArtifact` 零命中，`workspaceRegistry.delete(id)` 明确写着「保留目录与全部会话日志」，Remote 方法表里也没有 delete/remove。所以本插件是在**填一个真实的空白**，代价是必须用不受支持的拆解方式（裸 `rm` + 摘私有 Map）。已尽量对齐 DSH 自己的 dispose 顺序，但它**不是官方支持的删除路径** —— 升级 DSH 后建议重跑两个测试套件。
- **路径根是配置项，不是常量。** `sessions` / `storages` / `attachments/v1` 三处都由配置注入（`dsh-base` 的 patch 里是 `dshHomePath(...)`）。本插件按默认组合硬编码这三条路径；`DSH_HOME` 已按 DSH 的 `resolve(expandHomePath(...))` 语义处理（`~/x` 会正确展开成绝对路径），但**若有 overlay / profile 改写了这三个根**，插件就会对不上。
- **一个会话目录可能有多个格式世代。** DSH 明确保留历史格式世代（迁移只发布新世代，从不删被取代的那份），所以同目录可能同时有 `session.jsonl` 与 `session.v4.jsonl.zstd`。选件规则照抄 DSH 的「取最高版本」，不再是 readdir 顺序（NTFS 上 v0 会排在 v4 前面）。
- **客户端行消失走 `api-session/removed`，不再自己发 `session/disposed`。** `session/disposed` 声明为 `this: Scoped<Session>`，必须带 scope carrier，而 carrier 是 `dsh-session` 的内部函数产物、插件拿不到；无 carrier 派发会被 `dsh-scope` 的 invariant 直接 `fail`（一个监听者都收不到）。活会话由 `entry.detach()` 发出**正确**的那一个；冷会话则发 `api-session/removed`（该事件**没有** scoped 声明，无需 carrier），它正是客户端 `handleSessionRemoved` 的输入。
- **补发 `agent/disposed` 时同样带 carrier**（取自 `agents.enter()` 存在 store 条目上的 `scopeTarget(agent, agent)`），并照抄 DSH 的逐监听者 try/catch —— 否则一个监听者抛错会吃掉后面所有。
- **附件只清 `attachments/v1/objects`（图片对象）。** `file-objects/` 与 `files/` 下的文件类附件**不清理**（`/health` 的 `attachmentKinds` 如实回显）—— 这是漏删，不是误删。
- **不可逆的账本变更放在文件删除之后**：`rm` 失败时会话账本未动、会话照常可见可重试；retire 超时（`whenIdle` / `scope.dispose`）则**整个删除中止**并回 409 `busy`，绝不留"文件删了一半 / 账本摘了文件还在"的半死状态。
- **删除失败会恢复归档 / 置顶状态**：`archiveSession` 在同一次写入里会摘掉 pin（DSH 的"归档即摘 pin"语义），若随后 `rm` 失败，插件按删前状态把 pin / 归档恢复回去 —— 删除失败不该顺手改掉用户偏好。
- **停活走 DSH 自己的 `workspace/session-stop`**（`archiveSession(id, { stopActivity: true })` 触发），覆盖 jobs / schedule / subagent / workspace / desktop-host。已归档的会话不会重复发停活信号，此时 `stopped` 如实报 `false`。
- `file:` 依赖指向本目录。**移动或删除这个源目录后**，需要重新 `dsh plugin add` 才能再安装/更新；平时改源码则按上文「安装」一节的同步步骤手动刷新副本。

## License

MIT
