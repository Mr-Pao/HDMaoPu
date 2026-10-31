# 数据分片方案设计（守 5 元完美版 · 仅设计，不实施）

> 状态：**评估结论 = 暂不实施**。当前规模下分片收益极小，强行改动风险 > 收益。
> 本文档只交付「未来规模上来时如何分片」的设计，不做任何破坏性数据/读取迁移。

## 0. 评估结论（为什么现在不做）

- 当前 `data/` 下各集合单文件都是 **几 KB 量级**（猫仅 11 只，`cat.json` 体量极小）。
- COS 按「请求数 + 出流量」计费，前端读一个几 KB 的 JSON 与读多个几 KB 的 JSON 的出流量几乎相同；分片后请求数反而 **增加**（每个 shard 一次 GET），对「每月 ≤5 元」红线无正向贡献。
- 小程序端 `datasource.js` 的查询/过滤/排序/本地覆盖层都是「整集合全量载入内存」模型，分片会牵动核心读取链路，回归成本高。
- **结论**：保持现状（单文件集合）。等单集合体量逼近「首屏需拉取的列表明显变慢 / COS 出流量成为主要成本」时，再按本文档落地分片。

---

## 1. 触发条件（何时才值得分片）

满足以下任意一条，启动分片：

1. 单集合（如 `photo.json`、`cat.json`）体积 > **500KB**，且首屏或列表页需要全量载入。
2. 某集合写操作（inbox 聚合回写）开始频繁整文件重写，导致 `sync-data.yml` 上传带宽/耗时明显上升。
3. 前端需要按 ID 随机访问单条记录（如详情页）且列表视图不需要全部字段。

---

## 2. 分片结构

以一个需要分片的集合（示例 `cat`）为例：

```
data/
  cat-index.json        # 清单/轻量索引（始终保留，体积小）
  cat-<id1>.json        # 单只猫的完整记录
  cat-<id2>.json
  ...
```

### 2.1 `cat-index.json`（清单）

保留「列表视图要用的轻量字段」+ 全量 `_id` 列表，避免为列表页拉取所有 shard：

```json
{
  "version": "2026-...Z",
  "items": [
    { "_id": "cat-1", "name": "大橘", "avatar": "...", "campus": "...", "popularity": 12, "follow_count": 3 },
    { "_id": "cat-2", "name": "...", "...": "..." }
  ]
}
```

- index 只含卡片/列表渲染所需字段；完整字段在 `cat-<id>.json` 里。
- 详情页按需 `GET data/cat-<id>.json`，不再拉全量 `cat.json`。

### 2.2 `cat-<id>.json`（单条完整记录）

```json
{ "version": "2026-...Z", "item": { "_id": "cat-1", "name": "大橘", "rating": {...}, "habit": "...", "...": "..." } }
```

单 shard 体积可控（一只猫的完整资料几 KB），写回时 **只重写这一个 shard**。

---

## 3. `scripts/process-inbox.js` 聚合写分片适配

当前聚合逻辑直接 `loadData('cat')` / `markTouched('cat')` 整文件读写。分片后改为：

1. **加载**：聚合需要某只猫时，先读 `cat-index.json` 拿到 `_id` 与轻量字段；完整字段按需读 `cat-<id>.json`（带内存缓存，避免重复读）。
2. **改写**：`handleLike/handleFollow/handlePop/handleRating/handleManage` 等命中某只猫时，只重写对应的 `cat-<id>.json`（先写 `.tmp` 再 `rename`，沿用现有原子写）。
3. **回写 index**：任何影响「列表轻量字段」的变更（人气、关注数等）在改写 shard 的同时，同步更新 `cat-index.json` 里对应 `_id` 的轻量字段，并 `markTouched('cat-index')`。
4. **去重/限频不变**：`inbox_log` 跨天去重、`pop` 12h 限频、`MAX_PER_OPENID` 运行内限频全部保留（它们与分片正交）。
5. **防刷增强不变**：`parseObject` 的 openid 格式 / kind 白名单 / body schema / ts 窗口校验照常生效（见 `scripts/process-inbox.js` 顶部注释）。

> 聚合层是唯一写 `data/` 的地方（Actions 算力，零成本），分片只是把「整文件写」降级为「单 shard 写 + index 同步写」，不引入任何服务器。

---

## 4. `miniprogram/utils/datasource.js` 分片加载适配

核心原则：**对外接口不变**，页面代码 `.collection('cat').where(...).get()` 仍拿到「合并后的整集合数组」。

新增一个「分片集合加载器」，在 `_load('cat')` 时：

1. **先取 index**：`GET data/cat-index.json`，得到 `_id` 列表与轻量字段 map。
2. **并发拉 shard**：对 index 中的每个 `_id`，`GET data/cat-<id>.json`，**限制并发**（如 `Promise` 池，上限 6~8 并发）以防首屏瞬间打爆请求数。
3. **合并去重**：把 index 的轻量字段与 shard 的完整记录按 `_id` 合并成一条；**前端并发去重**——以 `_id` 为唯一键，index 与 shard 出现同一 `_id` 时以 shard 完整记录为准，避免重复计数。
4. **喂给现有管线**：合并后的数组照常走 `_merged`（本地覆盖层）、`_applyQuery`（过滤/排序/分页/投影），页面代码零改动。
5. **本地覆盖层适配**：`_insertOne/_updateOne/_deleteOne` 对分片集合写入本地覆盖层时，按 `_id` 定位到具体 shard 的改动；读取时 `_merged` 把覆盖层合并到「index + 各 shard」之上（同 `_id` 覆盖、新 `_id` 追加到 index 与新建 shard、删除标记剔除）。

非分片集合（`photo`、`comment`、`review_queue` 等）走原 `_requestCollection`，完全不受影响。

---

## 5. 前端并发去重维持

- 详情页与列表页可能同时拉取：列表用 `cat-index.json` 的轻量字段，详情用 `cat-<id>.json` 完整记录。
- 去重规则：全局以 `_id` 为权威键。任何合并点遇到重复 `_id`，保留「更完整」的一份（shard > index 轻量字段），不重复计入统计/列表长度。
- 缓存：沿用现有 `ds_cache_<name>` 的 stale-while-revalidate 策略；分片后每个 shard 独立缓存（key 形如 `ds_cache_cat-<id>`），index 单独缓存，互不拖累。

---

## 6. 迁移策略（真要实施时）

1. 先在 `process-inbox.js` 增加「`cat.json` → `cat-index.json` + `cat-<id>.json`」的一次性导出脚本（手动触发，跑一次即可）。
2. 切换 `datasource.js` 的 `cat` 集合到分片加载器，其余集合保持原样（灰度：只切 `cat`，验证后再切 `photo`）。
3. 验证首屏/列表/详情全链路，再移除旧的整文件 `cat.json` 读取路径。
4. 全程不破坏 5 元红线、不引入服务器/SCF。

> 本步骤为「未来可选」，本次（v4.0.2）**不执行**。
