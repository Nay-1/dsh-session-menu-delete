# 附件清理机制

> 这份文档解释 `dsh-session-menu-delete` **为什么**以及**怎么**删除附件。
> 想直接看命令，跳到最后一节「速查」。

---

## 0. 一句话总览

附件是**内容寻址**的独立对象，会话日志里只留一句引用。所以「删会话」和「删附件」是两件事：
删会话只摘掉引用，实体留在磁盘上，于是会攒下**没人引用的孤儿**。

本插件的全部设计目标只有一个：

> **在「确定没有任何会话还会用到它」之前，一个字节都不删。**

当前版本的判据是：

> **引用者集合（活会话内存事件 ∪ 磁盘日志）非空、且全部落在本次被删集合内 ⟹ 立刻删。**

判定为独享就当场删掉 —— 立即生效，不留尾巴。

---

## 1. 附件在磁盘上的位置

`<DSH_HOME>` 默认是 `~/.dsh`（或 `$DSH_HOME`，与 DSH 的 `resolve(expandHomePath(...))` 同语义）。

| 路径 | 是什么 | 本插件 |
|---|---|---|
| `attachments/v1/objects/<前2位>/<sha256>` | **图片对象**。文件名就是内容的 sha256，无扩展名 | ✅ 管 |
| `attachments/v1/file-objects/<前2位>/<sha256>` | **文件类**附件的实体 | ❌ 不管 |
| `attachments/v1/files/<前2位>/<sha256>/<原名>` | **文件类**附件的带名副本 | ❌ 不管 |
| `attachments/v1/tmp` | 写入暂存区 | ❌ 不碰 |
| `cache/attachments/request-images/<前2位>/<hash>` | DSH 给**模型请求**生成的派生图（缩放/重编码后缓存） | ❌ 不碰（DSH 自己会重建） |

**内容寻址的含义**：同一张图无论被多少个会话用过，磁盘上只有一份。这带来去重的好处，
也带来一个陷阱 —— **删掉它就等于同时删掉了所有引用者的那张图**。

> ⚠️ 文件类附件（`file-objects/`、`files/`）本插件**不清理**，会无界堆积。
> 这是**漏删，不是误删**。`/health` 的 `attachmentKinds: ["image-objects"]` 如实回显了这一点。

---

## 2. 判据：什么叫「没人用了」

### 2.1 引用长什么样

会话日志里，一条引用是长这样的 JSON 片段（`user/message`、`tool/result`、`agent/inbox/spliced` 里都有）：

```json
{ "type": "image",
  "attachment": { "attachmentId": "sha256:2ae346c0…c8e4", "mediaType": "image/png",
                  "bytes": 2118, "width": 800, "height": 300, "name": "button-zoom.png" } }
```

采集方式是**递归遍历事件 JSON，找 `attachmentId` 字段**（剥掉 `sha256:` 前缀、小写归一）。

### 2.2 为什么必须结构化解析，不能文本搜哈希

**实测教训**：曾经用一个临时探针脚本打印哈希来排查问题，探针的输出被写进了会话日志，
于是之后用「文本搜 64 位十六进制串」判断引用时，**11 个对象 11 个假命中**，全部被误判为「还有人用」。

文本匹配还会把日志里任何偶然的长十六进制串当成引用。所以只能解析 JSON。

### 2.3 为什么需要**两个**引用来源

| 来源 | 覆盖什么 | 代价 |
|---|---|---|
| **活会话的内存事件**（`sessions.list()` → `session.ownEvents()`） | **还没落盘**的引用 | 极低（纯对象遍历，不解压、不解析 JSON） |
| **磁盘上的会话日志** | 已经落盘的引用（含 fork 的 `seed` 历史） | 高（要解压全部多帧 zstd 日志） |

**只看磁盘会有一个结构性盲区**：一个「仍然存活、刚看过这张图、但引用还没 flush」的会话，
在磁盘上**根本不可见** —— 于是对象看起来"没人要了"，被判成孤儿删掉，
之后那个活会话组装模型请求时报 `Attachment object is missing.`（**真踩过**）。

两个来源对同一 `(hash, 会话)` 取并集，天然幂等。

### 2.4 「看一眼」就等于「引用一次」

用 `read_image` 读一张图，DSH 会把它登记成该会话的图片附件并写进事件流。
也就是说**引用随时可能因为一次查看而产生**，不只在发送消息时。这直接决定了：

- 不能复用**陈旧的结论**（每次删除/预览都要重新判定）；
- 不能假设"这个会话没发过带图的消息，所以它不引用图"。

> 注意区分「复用结论」和「缓存单份工件的解压结果」：后者按
> `(size, mtimeNs, ctimeNs, ino)` 判定工件变没变，四者全等则内容必然没变、
> 引用集合也就必然没变 —— 这是确定性判定，不是陈旧结论。详见 §5 与 README
> 的「为什么缓存是安全的」。

---

## 3. 删除路径

| 路径 | 触发 | 范围 | 闸门 |
|---|---|---|---|
| **随会话删除顺手清**（默认开启） | 点菜单「删除会话」 | 只清**引用者全部落在本次被删集合内**的（含级联的子代理） | 无（跟着删除走） |
| **独立清理** | `POST /attachments/clean` | **全库**所有孤儿 | 要 `{"confirm":true}`，否则只预览 |

顺手清理可用请求体 `{"attachments": false}` 关掉。

### 3.1 为什么顺手清是「引用者全部落在被删集合内」，而不是「这个会话引用过哪些图」

因为附件是**共享**的：fork 会复制历史，历史里的图片引用也跟着复制。
若照着"这个会话引用过哪些图"去删，**副本里的图会集体变裂图**。

### 3.2 为什么顺手清**跳过零引用对象**

`owners.size === 0` 的对象（全库孤儿）**不归顺手清理管** —— 它只处理「因为这次删除才失去最后引用」的那些。
零引用的交给独立清理，因为那是一个明确、需要 `confirm` 的动作。

### 3.3 删除顺序

```
① 算（在动任何文件之前）
     递归收集本次要删的会话集合 doomed = {自身} ∪ 全部子代理后代
     解析两个来源的引用 → hash → Set(引用它的会话)
     挑出「引用者非空 且 ⊆ doomed」的对象 → 这些是"独享"的

② 删会话（先后代、再自己）
     每个会话：摘活体 → flush → 停活清集合 → 删工件 → 清投影缓存 → 摘账本

③ 删附件
     stat 确认存在 → rm → 回头 rmdir 空分片目录
```

**为什么①必须在②之前**：会话日志一没，"谁引用过什么"就无从得知了。

**分片收尾为什么用 `rmdir` 而不是 `rm -r`**：早先是「readdir 判空 → `rm -r`」，
两步之间若有别的会话往这个分片写入了新对象，`rm -r` 会把它一起删掉。
`rmdir` 对非空目录直接失败（`ENOTEMPTY`），没有这个窗口。

---

## 4. 一个常见的误解：草稿里的图**不需要**保护

「贴进输入框、还没发送的图，会不会被误删？」—— **不会，而且那一刻磁盘上根本没有这个对象。**

**图片是「发送时」才入库的，不是贴图时：**

- `SessionPromptRequest.content` 里的 image part 带的是**原始字节**
  （`SaveImageAttachment { data: Uint8Array; mediaType; name? }`）；
- 发送时 `attachments.admitPromptContent()` 把它换成持久引用 ——
  输出类型 `AdmittedPromptContentPart` 里才是 `{ type: 'image'; attachment: ImageAttachmentRef }`；
- DSH 的注释写得很直白：*"Admit one Host prompt and **replace each uploaded image with its
  durable reference**. Text and durable file references pass through unchanged.
  A prompt **without image parts performs no storage operation**."*

所以：

```
你贴图            → 客户端只把字节留在本地草稿里，磁盘上没有对象、也没有引用
你删别的会话      → 与这张图无关（它压根不存在于 objects/）
你点发送          → 字节随提示词上去 → saveImage 入库（link 目标不存在 → 成功）
                  → 引用有效，正常显示
```

**文件类**附件确实是贴图时就上传（拿 receipt，`fileUploads.upload` → `admitEncodedFile`），
但它们的实体在 `file-objects/`、`files/` —— **本插件根本不碰那两个目录**。

**结论：本插件不可能弄裂任何一个草稿。**

---

## 5. 判据的演进史（每一版都是踩坑换来的）

| 版本 | 做法 | 代价 / 结论 |
|---|---|---|
| v1 | 有**回收站** | 救不了真正想救的：删错会话时**日志本身不可恢复**，还原附件也没人引用。**去掉后判据反而更硬** |
| v2 | 顺手清，引用集合只看**磁盘日志** | 结构性盲区 → 误删活会话还要用的对象（`Attachment object is missing.`） |
| **v3（现在）** | 引用集合改为**内存 + 磁盘两个来源** —— 独享即删 | 盲区关闭，判据成立 |

**核心结论**：判据能否成立，全看**引用集合完不完整**。两个来源缺一不可。

---

## 6. 失败模式与边界

**已处理的**

- 判据有盲区 → 内存来源关闭了「已 append 未落盘」那一段；
- 分片误删 → `rmdir`；
- 虚报删除成功 → 删除前 `stat` 确认（`rm` 带 `force` 对不存在的路径不报错）；
- 旧结论复用 → 每次删除/预览都**重新判定**；单份工件的解压结果按
  `(size, mtimeNs, ctimeNs, ino)` 缓存（确定性失效，见 §2.4 的注）；
- 全量扫描太慢 → 分两阶段：先只问「待删的这批引用过什么」（只读它们自己的工件），
  候选为空就直接收工；候选非空才去证明「集合外没人还在用」。
  第一阶段判断错了也只会**少删**（留下孤儿），不会误删。

**边界（明确声明）**

- **文件类附件**（`file-objects/`、`files/`）不清理 —— 漏删，不是误删；
- **`request-images` 缓存**不清理（DSH 自己会重建，删了也无害，但本插件不碰）。

---

## 7. 速查

所有端点都要请求头 `x-dsh-plugin-call: 1`（自定义头触发 CORS 预检，网页因此发不出去）。

```powershell
$h = @{ "x-dsh-plugin-call" = "1" }
$api = "http://127.0.0.1:19387/session-menu-delete/api"

# 看现状：总对象数 / 被引用 / 孤儿（含明细）
Invoke-RestMethod "$api/attachments/orphans" -Headers $h | ConvertTo-Json -Depth 5

# 独立清理：不带 confirm 只预览，带了才真删（全库孤儿）
Invoke-RestMethod -Method Post "$api/attachments/clean" -Headers $h `
  -ContentType "application/json" -Body '{"confirm":true}' | ConvertTo-Json -Depth 5

# 删会话（响应里带 attachmentsRemoved / cascadeRemoved / cascadeIds / cascadeFailed）
Invoke-RestMethod -Method Post "$api/delete" -Headers $h `
  -ContentType "application/json" -Body '{"sessionId":"<会话id>"}' | ConvertTo-Json -Depth 5

# 会级联删掉哪些子代理（只读预演）
Invoke-RestMethod "$api/lineage?sessionId=<会话id>" -Headers $h | ConvertTo-Json -Depth 5

# 能力标记与路径回显
Invoke-RestMethod "$api/health" -Headers $h | ConvertTo-Json -Depth 5
```

可调项（bundle patch 的 `config:`）：

```yaml
- insert:
    - id: dsh-session-menu-delete
      name: 'dsh-session-menu-delete'
      config:
        idleTimeoutMs: 8000          # 等 agent.whenIdle() 的上限
        disposeTimeoutMs: 8000       # 等 agent.scope.dispose() 的上限
```

---

## 8. 一句话记住

- **防误删活会话还在用的图** → 靠**内存 + 磁盘两个引用来源**；
- **删什么** → 只删「引用者非空且全部落在本次被删集合内」的，以及独立清理时的全库孤儿；
- **不删什么** → 还有别人在用的、零引用的（顺手清理路径）、文件类附件。

> 两条容易搞错的边界：
> **草稿里的图不需要保护**（图片是发送时才入库的，草稿阶段磁盘上没有对象，见 §4）；
> **文件类附件本插件不管**（实体在 `file-objects/`、`files/`，见 §1）。
