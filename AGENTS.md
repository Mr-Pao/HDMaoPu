# MaoPu（火大猫谱）— 项目记忆

> **回复格式硬规矩（用户 2026-11-03 明确要求，m00131）**：任何回答的**第一句话必须是结论**，不许先铺垫、先报进度、先解释过程。分析类请求尤其如此——用户已经因此不满两次。
>
> DSH 每个新会话自动加载本文件。`.workbuddy/memory/` 是旧工具 WorkBuddy 的目录，**DSH 完全不读**，别再往那里写新记忆。
> ⚠️ **本文件有 65536 字节的 workspace instruction budget**，超出部分会被截断丢内容。2026-11-02 二次精简：72KB → 51KB → **当前 ~35.7KB**，v4.0.15–v4.0.56 的历史版本条目完整原文全部搬进项目根的 `AGENTS-archive.md`（主文件只留「当前仍生效的结论」索引）。**新增内容前先看这个预算**；要写长文就写进 `AGENTS-archive.md` 并在本文件留一行索引。

## 一句话定位

中山大学校园流浪猫谱系微信小程序「火大猫谱」，fork 自 `sysucats/zhongdamaopu`，品牌化为绿色 `#0C5F03`。
没有服务器、没有云开发：数据是 Git 仓库里的 `data/*.json`，同步到腾讯云 COS 当 CDN，小程序端拉 JSON 在内存里查询。

## 技术栈与目录

- 微信原生小程序，无框架。`miniprogramRoot: miniprogram/`，appid `wx5d52c6c8f098ed5e`，`libVersion: 2.24.7`，`nodeModules: false`
- 页面：`app.json` 注册 **28 页 + 分包 `pages/packageA` 1 页**（v4.0.67 加回「审核队列」review 页，26→28）（v4.0.65 删 review 页，27→26）（v4.0.63 管理后台重构删 4 页：imProcess/checkPhotos/checkAdoption/pageSettings，31→27）（v4.0.35 加 newsAdmin，30→31）（v4.0.17 删徽章 38→34；v4.0.23 删用户档案页 34→30）
- `miniprogram/utils/datasource.js`（1321 行）：自研的 mpserverless 兼容层，实现 `createJsonServerless({baseUrl})`
- `miniprogram/utils/writeback.js`：COS inbox 写入通道（客户端零密钥）
- `data/`：19 个 JSON，即"数据库"（删徽章三件套后从 22 降下来）
- `scripts/`：Actions 专用脚本，**独立 `package.json`**（只依赖 `cos-nodejs-sdk-v5 ^3.0.0`）
- `tests/`：`datasource` / `cache` / `process-inbox` / `review` 四个测试文件，共 **62 例**
- `.github/workflows/`：7 个（aggregate、bundle-size、process-inbox、review、set-inbox-policy、sync-assets、sync-data）
- `functionsEMAS/`、`initDatabase/`、`initStorage/`：上游遗留，EMAS 空间已删，**基本是死代码**

## 常用命令

**本机 node 不在 PATH**，用 HBuilderX 自带的 v22：
```bash
NODE="C:/Users/yzx49/Program/HBuilderX/plugins/node/node.exe"
```
- 单测（62 例）：`"$NODE" --test tests/datasource.test.js tests/cache.test.js tests/process-inbox.test.js tests/review.test.js`
  - **必须显式列文件**；`node --test tests/` 会把目录当单个测试文件跑并报 fail
  - 用 `plugins/node18/node.exe`（v18.20.0）会挂 1 例：`mock.timers.enable` 不支持 `Date` → `ERR_INVALID_ARG_VALUE`
- 数据端到端校验（70 项，真实数据不变量口径）：`"$NODE" scripts/verify-demo-data.js`
- 重新生成演示数据：`"$NODE" scripts/gen-demo-data.js [--dry-run]`（固定种子、幂等）
- 颜色硬编码 → token：`"$NODE" scripts/recolor-tokens.js [--dry-run]`
- inbox 聚合自测：`DRY_RUN=1 "$NODE" scripts/process-inbox.js`（管理口令读 `data/gate.json` 的 `code`，不需要环境变量）
- 上传数据到 COS：`COS_SECRET_ID=.. COS_SECRET_KEY=.. COS_BUCKET=.. COS_REGION=.. "$NODE" scripts/upload-data.js`（加 `DRY_RUN=1` 只校验）
- git 命令**一律加** `-c core.preindex=false`（见"坑"第 1 条）
- **猫↔照片归属重建工具**（2026-11-01 建，见下方「照片归属重建工具」一节）：密钥读 process.env → 项目根 `.env`；三步 `relink-scan.js` → 网页认猫 → `relink-apply.js`

## 踩过的坑 / 硬约束

### 1. OneDrive 目录会毁掉工具链
项目**必须留在 OneDrive**（用户依赖实时同步，别再建议搬走）。
- git 偶发 `mmap failed: Invalid argument` → `git -c core.preindex=false -c core.fscache=false <cmd>`
- 命令被中断会残留 `.git/index.lock`，确认无 git 进程后 `rm .git/index.lock`
- `miniprogram/node_modules` 里约 239 个文件是「仅联机」占位（全是 `.d.ts` + eslint 链），**grep 会刷一堆 Permission denied，但不影响编译**。真正致命的只有运行时 `.js`（`@alicloud/mpserverless-sdk/dist`、`wx-canvas-2d/miniprogram_dist`），这些已本地化
- 再遇 `UNKNOWN: unknown error, read`：先 `git pull`，再从完好副本 robocopy `/IS` 覆盖 `node_modules` 与 `miniprogram_npm`，不要重建整个项目

### 2. 批量替换颜色：只替换 hex 字面量，绝不替换颜色关键字
`scripts/recolor-tokens.js` 的正则必须带 `(?![0-9a-fA-F])`，且**只能匹配 `#rrggbb`/`#rgb`**。
- 曾错误地把单词 `white` 也当替换目标，导致 5 个文件畸形：`--color-comment-paper-white` → `var(--color-comment-paper-var(--color-surface))`、`var(--color-white)` → `var(--color-var(--color-surface))`、选择器 `.comment.white` → `.comment.var(--color-surface)`
- 受影响：`comment-list.wxss`、`commentBoard.wxss`（两处）、`addPhoto.wxss`、`ratingDetail.wxss`、`myFootprint.wxss`
- **`miniprogram/app.wxss` 是 token 定义处，必须排除出替换范围**，否则 `--color-gray-light: #f7f7fa` 会变成自引用
- 校验手段：改完查 `var(--color-var(` / `paper-var(` 残留 + 花括号平衡

### 3. `packOptions.ignore` 会让"文件在磁盘上"的页面报 `WXML file not found`
`project.config.json` 的 `packOptions.ignore` **v4.0.63 起只剩 `images/markers` 一条**（18 条里 17 条指向的目录已随管理后台重构删除）。
- 启用任何页面，**除了 `app.json` 注册，还必须从 ignore 名单移除**；反例：领养三页当年就是被 ignore 掉的"死代码"，注册后立刻编译失败
- 记住历史坑：`pages/manage/photoManagement`、`medicalManage`、`addCat`、`addRelations`、`managers`、`checkComment`、`checkPhotos`、`checkAdoption`、`imProcess`、`rewards`、`pageSettings`、`pages/info/myFootprint`、`myAchievement`、`pages/genealogy/applyMapAccess`、`detailCat/relationGraph`、`pages/tools/updateUserRole`、`inviteUser`、`pages/map`、`packages/tencentcloud` 这些目录**已在 v4.0.63 整目录删除**，别再按旧名单去找它们

### 4. `rating` 与 `cat.rating.scores` 同名反义（最容易读错的一处）
- `rating` 集合每条的 `r1..r5` = **用户打的分数**（1–5）
- `cat.rating.scores.r1..r5` = **得票计数**（打 N 分的人有几个），`count` 总票数，`avgScore` 加权平均，`avgScoreDisp` 是 `toFixed(1)`
- 五维（猫德/颜值/社交/干饭/活力）与 r1..r5 原本撞车，现走 `dimSums/dimCounts/dimAvg`（`process-inbox.js` 的 `handleRating` 为准），详情页读 `dimAvg`

### 5. `review_queue.json` / `inbox_log.json` 永不上传 COS
`scripts/upload-data.js:38`：`const UPLOAD_DENYLIST = new Set(['inbox_log.json', 'review_queue.json']);`
→ 本地生成审核数据后线上审核页仍为空态，**这是安全设计，别当 bug 修**。真实数据只能走 提交 → inbox → Actions 聚合。

### 6. COS 权限只有一条路：对象级 ACL
- 桶 `maopu-1258113633` 私有读；`putBucketPolicy` 授予匿名读**不生效**（试过，已撤销），匿名 GET 仍 403
- 唯一有效方式：`putObject` / `putObjectCopy` 带 `ACL: 'public-read'`
- 规则：`data/*`、`photos/*` 公开；`pending/*`、`rejected/*`、`admin/*` 保持私有（未审核照片不泄露）
- 客户端不放任何密钥；桶策略只允许匿名 `PutObject` 到 `inbox/*` 和 `pending/*`（`pending/*` 额外带 `cos:content-length ≤ 524288` 条件挡大文件；不能读/删/枚举/写其他前缀）
- **改桶策略后必须在 Actions 手动跑一次 `set-inbox-policy.yml`**（`workflow_dispatch`），否则线上策略不变
- **旧域名不可用**：`cos.ap-guangzhou.myqcloud.com/maopu-1258113633/<path>` 无论 ACL 都访问不了，必须 `maopu-1258113633.cos.ap-guangzhou.myqcloud.com/<path>`
- `cos-nodejs-sdk-v5` 的 `CopySource` 格式是 `<bucket>-<appid>.cos.<region>.myqcloud.com/<URL编码后的key>`，SDK 内只 decode 不 encode，key 要按 `/` 分段 `encodeURIComponent`

### 7. 主题色不能改
`--color-primary: #0C5F03` 是品牌绿，用户明确要求不变。做视觉改造只能在梯度/语义色/圆角/阴影/间距上动。

### 8. 上传入口是全局开关 `photo_upload_enabled`（2026-11-01 已放开为 true）
原状态是 `false`：dataMode 下 `utils/common.js` 的 `uploadFile` 依赖云函数签发 COS 临时密钥，而 EMAS 空间已删 → 必然失败；三处拦截 `genealogy.js clickUploadBtn`、`detailCat.js bindAddPhoto`、`addPhoto.js onLoad`。
**现状（v4.0.18）**：`photo_upload_enabled: true`，`addPhoto.js` 改成**匿名直传 COS**——`readFile` 成 ArrayBuffer → `wx.request` PUT 到 `pending/${openid}-${ts}.${ext}` → `putInbox("photo", {photo_key, cat_id, photographer, shooting_date})`，import 从 `curdOp/uploadFile` 换成 `getCurrentUserOpenid` + `putInbox`。所以上传不再需要临时密钥，但**必须有桶策略允许匿名 PutObject 到 `pending/*`**；照片审核仍走 `process-inbox.js` 聚合。
若某天要关上传，只改这个开关即可，别再单独放开某一页。

### 9. `navigationStyle: custom` 的页面要自己留状态栏高度
`app.json` **没有**全局设 `navigationStyle`，只有 6 页单独设 custom：`followFeed`、`gallery`、`detailCat`、`genealogy`、`info`、`news`（`leaderboard` 整目录已在 v4.0.53 审计中删除，见「已知限制」）。
这些页要调 `utils/nav.js` 的 `applyNav(page)`，否则内容被刘海/灵动岛遮住。新增自绘头部页面记得一起处理。

### 10. tabBar 有历史缓存别名
`custom-tab-bar/index.js:55`：`const alias = { leaderboard: 'gallery' }`，兼容客户端 7 天的 pageSetting 缓存。4 个 tab 键（v4.0.23 起）：`genealogy`(猫谱) / `gallery`(猫图) / `news`(猫抓板) / `info`(关于)。「喵友圈」`followFeed` 已从 `tab.js` 与 `data/setting.json` 的 `fullTab` 下线（页面本身仍在 `app.json` 注册，可被直接跳转）。图库 tab 文案由「图库」改为「猫图」，**v4.0.29 再改为「猫片」**（仅 `tab.js` 的 `text`；页面 `navigationBarTitleText`、分享标题、`config` 的 `share_tip` 仍是「猫图」）。
`custom-tab-bar/index.js` 另有 `RETIRED_TAB_KEYS = [followFeed, recognize, leaderboard, map]` 兜底：旧客户端缓存里的 `fullTab` 只要含这些已下线 key，就丢弃其顺序、改按 `tab.js` 的 `Object.keys` 重排（权限过滤照旧）。改 tab 结构时记得同步这个数组。
`pages/leaderboard/` 整目录**已在 v4.0.53 审计中删除**（连同 `components/photoRank`、`components/achievementRank` 两个孤儿组件），不再是死页遗留。

### 11. 字段语义陷阱（填假数据/改数据前必看）
- `feedback` 记录带 `openid`（管理端 `fillUserInfo` 按它查用户）；历史数据里还有 `_openid`，原为「我的反馈」页过滤用，**2026-11-01 该页已随用户档案功能一起删除**，`_openid` 仅作历史字段保留，新代码无须再写
- `reward.records` 必须是 `#` 分隔的**字符串**，页面执行 `records.replace(/^#+|#+$/g,'').split('#')`，传数组会崩
- `news` 必须带 `photosPath` **数组**（detailNews 直接 `.map` 无保护）、`show` 布尔、`date`
- `inter` 的 `TYPE_LIKE = 10000`，`uid`=openid，`item_id`=photo._id
- `inbox_log` 每条必须有 `_id`（= `kind|openid|target`），否则 upload 校验会让整批中止

### 12. 管理员权限有个演示数据引导分支
`datasource._userOp('get')`：`user` 表**全部**记录 `_id` 以 `demo-user-` 开头时，新访客给 `manager=99`。一旦出现任意非 demo 用户，分支自动失效。改动 `data/user.json` 种子要留意这个逻辑，否则管理入口会消失。

### 13. git 与 CI 的约束
- **不要 force push**；push 失败就报告，不重试、不 `pull` 硬合并
- `issue_comment` 事件**只读默认分支**（`master`）的 workflow；`schedule` 同理。所以 `process-inbox` 的 cron 定义在 `master`，但 job 内 checkout `cos` 运行并回写 `cos`
- `sync-data.yml` 的 `branches` 必须是 `cos`，`paths` 是 `data/**`（曾因分支改名未跟改，导致 COS 数据停在旧版）
- ⚠️ **`GITHUB_TOKEN` 推送产生的 commit 不会触发其他 workflow**（GitHub 防递归的既定行为）。所以「聚合 job 提交 data/ → 靠 sync-data.yml 上传 COS」这条链路**根本不存在**，`sync-data.yml` 实际上只对**人**手工 push 的 `data/**` 生效。**任何会写 `data/` 的 workflow 必须自己调 `scripts/upload-data.js` 直传 COS**。2026-11-03 的「管理页加了位置、小程序看不到」事故就是这个原因（聚合提交 `613bd56` 改了 `data/setting.json` 但 COS 停在 11-02 版本）。已修：`process-inbox.yml` 与 `review.yml` 的 **`cos` 和 `master` 两份**都补了 `- name: Upload data to COS`（`if: always() && steps.xxx.outputs.flush_ok/ok == '1'`），并实测通过（run `41576091873` 该 step `success`，COS `Last-Modified` 立刻更新）。`review.yml` 的 master 版原来还是**旧版**：`permissions.contents: read`、`checkout` 没写 `ref`（默认 master）、且**整段 commit 步骤缺失** → 审核通过的照片记录从来上不了线，已整份对齐 cos 版
- fork 仓库的 scheduled workflow 默认禁用，需在 Actions 页手动 Enable
- `concurrency.cancel-in-progress: false` 不能改成 true：上传中途被杀会留下传了一半的数据
- Actions secrets 只需 4 个 COS 变量；管理口令统一读 `data/gate.json` 的 `code`（v4.0.42 起），`REVIEW_PASSCODE` 只作老部署兜底、可不配

### 14. 测试与验收的盲区
E2E（`scripts/e2e/`，miniprogram-automator）只查 console error，**抓不到 catch 吞掉的 TypeError**。UI 断言（`flow-test.js`）是必要补充。当前环境跑不了 E2E（沙箱拦 reg.exe），只有本地装了微信开发者工具才能跑。

## 关键架构决策与现状

### 分支布局（并列，不互相 merge）
```
upstream/master (sysucats/zhongdamaopu)
  └── 86e4633  火大猫谱
        ├── master            上游同步线，CI workflow 都在这
        ├── dev               旧 EMAS 云开发线，已实用停止
        └── cos   ← 当前工作线  COS 静态数据架构，HEAD
cos-version  从上游错误派生，废弃
```
- origin = `Mr-Pao/HDMaoPu`（真 fork，可用 GitHub Sync fork），upstream = `sysucats/zhongdamaopu`
- **当前分支 `cos`**，HEAD `cca08b5`（v4.0.22 docs），工作区有 v4.0.23 的未提交改动（放弃用户档案体系：删 4 页 + 删 `components/modifyUserInfo` + 5 页就地填昵称 + tabBar 改 4 tab）
- 从 `13f0f6a`（v4.1.4 设计系统重构）到 HEAD 共 21 个提交 / 100 文件 / +3496 −321，全是 UI 迭代

### 数据流
```
改 data/*.json → push cos → sync-data.yml → COS data/*.json (public-read)
                                                    ↓ wx.request
                                              小程序内存查询
写操作：小程序 PUT → COS inbox/<kind>/ → process-inbox.yml（cron */5 * * * *）→ 聚合写回 data/ → COS
```
- 读：`utils/datasource.js` 的 SWR（有缓存先渲染、超 10 分钟后台刷新、失败永不 reject、8 秒超时）
- 写：`utils/writeback.js`，`config.writeback_enabled: true`，永远不 reject
- 本地覆盖层：`_merged(name)` = 远端 JSON + 本地 `ds_local_*`，按 `_id` 覆盖，写操作只写本地不回传
- `data/` 之外没有数据库；`_id` 缺失会让 upload 整批中止

### 版本号制度
以 `miniprogram/config.js` 的 `app_version` 为准（当前 `v4.0.72`），commit message 末尾带版本号。⚠️ 本文件历史段落里的版本号（v4.0.42 等）是当时写入时的快照，实际版本号一律看 `config.js`。
历史上出现过 v4.x 与 v5.x 并存（v5.0.0 改版后回退命名为 v4.7.1 / v4.0.8），**别信 commit message 里的 v5.x，只信 `app_version`**。

### 设计系统（`miniprogram/app.wxss`，376 行）
两套 token 并存，都还在用：
- **v4 `--color-*`**（全项目 1177 处引用）：`--color-primary: #0C5F03`、`-bright: #17803C`、`-soft: #E8F3EA`、`-softer: #F3F8F4`；text `#1F2421` / secondary `#55605A` / tertiary `#8A948E` / placeholder `#B4BCB7`；bg `#F5F7F5`、surface `#FFFFFF`、border `#ECEFEC`；`--color-text-onPrimary: #FFFFFF`（补的历史 bug）；圆角 10/18/26/999rpx；阴影带绿色调 `rgba(12,95,3,…)`
- **v5.0 `--dk-*` 块**（第 235 行起，352 处引用）：`--dk-bg: #F5F7F5`、`--dk-card: #FFFFFF`、`--dk-line: rgba(12,95,3,0.10)`、`--dk-text: #10160F`、`--dk-accent: #0C5F03`、`--dk-accent-2: #14801F`、`--dk-radius: 28rpx` / `-lg: 36rpx` / `-pill: 999rpx`、`--dk-gap: 24rpx`；公共类 `.dk-card` `.dk-pill` `.nav` `.nav-sub` `.nav-title` `.nav-flex` `.nav-num`
  - ⚠️ 该块注释写着"沉浸式**深色**主题"，但值已经是白底（v5.0 白底改版后注释没更新）——**看值，别看注释**
- **56 个二级页 wxss 尾部**追加了同一段 `/* v5.1 全站统一外观（二级页自动套用） */` 块（白底、细描边、20rpx 圆角）；`devTeam.wxss`、`feedback.wxss` 直接 `@import '../reward/reward.wxss'` 复用
- 组件：`components/` 18 个目录，其中 `cat-card` / `comment-list` / `genealogy-tree` / `star-rating` 是 **`.ts` 组件**（原生 Component 构造器）；`miniprogram/types/domain.ts` 是唯一的类型文件。**存量页面全保持 `.js`**，走渐进式 TS，不要全量改写
- WXML **不支持内联 `<svg>`**，`genealogy-tree` 用 view 布局实现

### 成本红线
月成本 ≤ 5 元。所以：不引服务器/SCF/CloudBase，不用 PAYG 服务，Actions 用公开仓库免费额度。
`bundle-size.yml` 用 3MB 主包预算做回归护栏（平台硬上限 2MB，3MB 只是粗筛）。

### 当前状态（2026-11-03）
- `config.demo_mode: false`、`writeback_enabled: true`、`photo_upload_enabled: **true**`（2026-11-01 改为匿名直传 COS，见"已知限制"）、`app_version: v4.0.72`
- **v4.0.72：审核态开关（版本号白名单）+ 管理暗门迁到首页（2026-11-03）** — 照搬 SpaceLaunch 的「通过版本号规避审核」做法，另把连击口令入口从关于页搬到首页标题。
  - **开关文件 `data/app-config.json`**（新）：`{"version":"1793700000000","items":[{"_id":"app-config","reviewVersions":[]}]}`。**必须是 `{version, items:[]}` 信封**（`datasource._requestCollection` 只认这个格式），不能照抄 SpaceLaunch 的裸对象。`scripts/upload-data.js` 自动扫 `data/*.json`，不用改白名单。语义：`reviewVersions` **非空 = 审核中**，`[]` = 正常期。提审前写 `["v4.0.72"]`，过审发布后清回 `[]`。
  - **判定模块 `miniprogram/utils/review.js`**（新，267 行）：导出 `envName/runtimeVersion/applyVersionRule/readOverride/setOverride/getDebugInfo/getConfig/isReview/isReviewSync/blockInReview`。⚠️ **文件里必须写 `const config = require("../config")` 而不是 `import`** —— 它被 `tests/review.test.js` 直接 `require` 做单测，ESM import 会 `ERR_MODULE_NOT_FOUND`。
  - **判定口径**（`applyVersionRule(raw, override)`，纯函数）：布尔覆盖最优先 → 有模拟版本号时不走 devtools 放行 → 无 `reviewVersions` 数组则退回 `Boolean(cfg.review)` → 空列表 = 正常 → `develop`/`trial` 且白名单非空 = 审核态（**审核员跑开发版，拿不到版本号**，这是真正起作用的那条）→ `release` 按 `sim || app_version` 匹配白名单，拿不到版本号兜底审核态。远端拉不到 → 正常态兜底。
  - **缓存三键**：`appReviewConfig`（`{ts,data}` 远端原文，TTL 5 分钟）、`appReviewResolved`（`{review,ts}` 判定结论，给 tabBar/showTab 这类**同步**读者用）、`appReviewConfigOverride`（`{version}` 或 `{review}` 本机覆盖）。
  - **审核态表现**：① `custom-tab-bar` 加 `reviewMode`，`index.wxml` 根节点多一个 `review-hidden`，wxss 用 `display:none`（**不是 `.hidden` 的 opacity**，否则透明按钮还能点到跳 tab）；② `utils/page.js` 的 `showTab(page)` 改 `isReviewSync() ? 0 : (wx.getStorageSync('tabBarHeight') || 80)` —— 原来 `|| 80` 会把 0 吞掉；③ 首页隐藏「数据看板」hero 入口与识猫入口；④ 详情页 5 个 UGC 入口全部 `wx:if='{{!reviewMode}}'`（便利贴数 / 申请领养 tag / 信息纠错 / 我要评分 / 上传喵照）；⑤ 5 个 UGC 页 `onLoad` 首行 `if (await blockInReview(tip)) return;`（addPhoto/commentBoard/ratingDetail/feedbackDetail/applyAdoption），防深链与历史栈。
  - ⚠️ **`attached()` 量 tabBar 高度必须判 `rect && rect.height > 0` 再写缓存**：审核态 DOM 是 `display:none`，高度 0 一旦写进 `tabBarHeight`，之后「清除覆盖」回到正常态，所有页底部占位会永远变 0，直到重启小程序。
  - **暗门迁到首页**：`genealogy.wxml:9` 的 `.nav-t` 加 `catchtap='onTitleTap'`（**catchtap 不是 bindtap**，防冒泡）；连击 5 次（`TAP_WINDOW=800` 超时重置）→ 已解锁直接开面板，否则读 `data/gate.json` 的 code 弹口令 → 通过后开「版本切换」面板（`genealogy.wxml` 末尾 `.dbg-mask` z-index **8800**，口令弹层是 9000）。面板四件事：模拟版本号 `setOverride(v)` / 强制审核态 `setOverride(true)` / 强制正常态 `setOverride(false)` / 清除覆盖 `setOverride(null)`，每次改完 `wx.reLaunch` 重载。
  - **关于页那套已整体删除**：`info.js` 删掉 `TAP_TO_UNLOCK`/`TAP_WINDOW`/`setUnlocked`/`loadGateCode`/`onTitleTap`/`askAdminPasscode`/`refreshManagerNums`（105 行），只留 `isUnlocked()`；`info.wxml` 的 `.title` 去掉 `catchtap`，末尾 `<passcode-modal />` 删除。**现在 `<passcode-modal />` 全站唯一挂载点是 `genealogy.wxml` 末尾**。
  - 文案同步：`utils/user.js:204` 与 `utils/passcode.js`、`pages/manage/admin/admin.js` 注释里的「关于页连击」统一改成「首页连击『火大猫谱』标题」。
  - 测试：新建 `tests/review.test.js`（15 例，覆盖 devtools/develop/trial/release/命中/不命中/空白名单/布尔覆盖/老配置/非法 raw/数字版本号/`getAccountInfoSync` 抛错），**单测 47 → 62 例**；`package.json` 的 `scripts.test` 已加该文件；`scripts/verify-demo-data.js` 新增「【审核态开关 / app-config】」4 项，**66 → 70 项**。
  - 本机验证方式：首页标题连击 5 次 → 输入口令（`data/gate.json` 的 code，当前 `0000`）→ 面板点「强制审核态」→ 应只剩首页、无 tabBar、详情页无 UGC 入口 → 再连击点「清除覆盖」恢复正常。
- **v4.0.71：反馈链路打通（2026-11-03）** — 起因：用户问「反馈处理还有用吗」，实测答案是**没用，那个页面永远 0 条**。根因不是没提交，而是提交走错了通道：
  - `pages/genealogy/feedbackDetail/feedbackDetail.js` 原来先 `api.curdOp add feedback`（写本地覆盖层，假写，永不落 `data/feedback.json`），真正发出去的是 `putInbox('comment',{...,type:'feedback'})` —— 走**评论**通道。
  - 而 `scripts/process-inbox.js` 的 `handleComment` 只取 `cat_id`/`content`/`nickname`，**`type:'feedback'` 被直接丢弃**，入队 `kind:'comment'`；`handleDecision` 对 comment approve 只落 `data/comment.json`。所以反馈内容要么被当便利贴，要么石沉大海，`feedback.json` 永远是 `items: []`。
  - 修法（反馈独立成一个 kind）：
    - `VALID_KINDS`（`:76`）加 `'feedback'`（现 10 个）；新增 `handleFeedback(p)`：`feedbackInfo` trim 后为空 → `drop:no-content`，否则入 `review_queue`（`kind:'feedback'`，字段 `cat_id/cat_name/feedbackInfo/contactInfo/nickname/repliable`，字符串各自限长），**不要求 cat_id**（关于页的信息反馈没有关联猫）。
    - `handleDecision` 的 approve 分支新增 `else if (item.kind === 'feedback')`：落 `data/feedback.json`（`_id=genId('fb',item.ts)`、`openid` 与 `_openid` 都写、`openDate`、`repliable` 布尔、`dealed:false`），回写 `item.applied_feedback_id`。字段形状对齐 `verify-demo-data.js` 的三条校验。
    - `FEEDBACK_PATCH_FIELDS` 由 `['status','handled_by']` 扩为 **`['status','handled_by','replyInfo','replyDate']`** —— 原来 `replyFeedback` 一次提交带的 `replyInfo`/`replyDate` 会被整条 `drop:bad-patch-field` 丢掉，回复永远存不上。
    - `manageFeedback` 里 `patch.status` 赋值后同步 `item.dealed = patch.status === 'done'`（`checkFeedbacks` 用 `find({dealed:false})` 拉列表，不同步会导致标了已处理还留在列表）；新增 `replyInfo`（≤500）与 `replyDate`（ISO 字符串，非法则 `drop:bad-patch-type`）。
    - `feedbackDetail.js` 删掉假写分支与整个 `askNotice()`，改为 `putInbox('feedback', {...})`，订阅意愿在 `wx.showLoading` 之后立刻 `await requestNotice('feedback')` 问（必须用户手势后）。
    - 审核队列支持新 kind：`review.js` 的 `KIND_LABEL` 加 `feedback:"信息纠错"`，映射 `contactInfo`/`repliable`，`content` 回落 `feedbackInfo`，无 `cat_id` 时猫名显示「信息反馈」；`review.wxml` 多一行「联系方式」与「可回复/无法回复」；`review.wxss` 加 `.tag-feedback`、`.content.sub`。
  - ⚠️ **顺带修的坑**：`checkFeedbacks.js` 的 `total` 原来写 `fbRes.total`，但 `datasource` 的 `count()` 返回的是**数字** `{ result: n }`（不是 mpserverless 的 `{ total }`），所以页头「共有 N 条」一直是空的。现改 `typeof fbRes === 'number' ? fbRes : (fbRes && fbRes.total) || 0`。
- **v4.0.70：审核队列 UI 重排（2026-11-03）** — 用户真机截图反馈「UI 布局调羹一下」，实测有三处硬伤：
  - **页面被压成中间一条**：`app.wxss:211` 有个全局 `.container{display:flex;flex-direction:column;align-items:center}`，`review.wxml` 的根节点就叫 `.container`，于是卡片被压成内容宽度并居中。本页 wxss 必须显式 `display:block;width:100%` 覆盖（**以后任何新页用 `.container` 作根节点都要检查这条**）。
  - 头部只有一行「待审核 4 条」，改成「待审核 + 大号计数」+ 右上「刷新」胶囊（新增 `onRefreshTap()`）。
  - 照片 `mode="aspectFill"` 会裁掉横图两侧（年会背景那类横幅图最明显）→ 改 `aspectFit` 并加 `.photo-wrap` 容器；新增点图 `wx.previewImage` 看大图（`previewPhoto`）。
  - 信息区合并成单行 `.info`（评论显示「来自 X」，照片显示「摄影师 / 拍摄」），不再出现空行；按钮等高 76rpx 胶囊，提交中通过 `decidingId` 让两个按钮同时 `opacity:0.5` 置灰防连点。
  - 顺带修 `decide()` 里的锁：原来用 `this.deciding`（非 data，无法驱动 UI），改 `this.decidingId` + `data.decidingId` 双写。
- **v4.0.69：审核队列白图的最后一层兜底（2026-11-03）** — v4.0.68 上线后用户真机截图仍是白图，原因不是服务端没写 `preview_url`（线上 `data/pending.json` 已带），而是**小程序端 `datasource` 是 SWR**：`_load(name)` 先返回 `ds_cache_pending` 旧快照（那时还没有 `preview_url` 字段），10 分钟内不会重新拉，`photoUrlOf` 拿到的 `previewUrl` 是 `undefined` → 退回拼 `pending/` 地址 → 403。
  - 修法：`miniprogram/pages/manage/review/review.js` 的 `photoUrlOf` 加中间一级兜底——`previewUrl` 缺失时**按确定性规则自己推** `preview/pending/<photo_key 的 basename>`（常量 `PREVIEW_PREFIX = "preview/pending/"`），不再退回 `pending/` 原地址。因为 `process-inbox.js` 的 `previewKeyOf()` 就是取 basename，两边规则一致，所以缓存还没刷到也能拼对。
  - 三级顺序：`preview_url` → 自推 `preview/pending/<basename>` → 原始 `photo_key`（理论上到不了）。单测四种输入全对（实测两条推导 URL 均 GET 200 / 61935B、127155B）。
  - 另一个好处：以后即使快照里 `preview_url` 缺字段（例如聚合失败只 warn），页面也不会白图。
- **v4.0.68：待审照片改用公开预览副本（2026-11-03）** — v4.0.67 上线后实测发现审核队列里**照片会白图**：`pending/*` 被**桶策略显式 Deny 匿名 GetObject**（`Deny` 语句 `deny-anon-read-private-prefixes`，Resource 覆盖 `inbox/*`、`pending/*`、`rejected/*`），所以拼公开 URL 的 `<image src>` 必然 403。
  - ⚠️ **踩坑记录**：用 `curl -I` / `Invoke-WebRequest -Method Head` 测 `pending/xxx.png` 会返回 **200**，但 `GET` 返回 **403** —— COS 的 Deny 只拦 `GetObject`，`HeadObject` 不在其中，**以后判断"能不能访问"必须用 GET，不能信 HEAD**。
  - 修法（**改了两版，第一版被 GitHub 拒收**，务必记住）：v1 打算给待审图签 7 天临时链写进快照 —— `cos.getObjectUrl({Sign:true})` 的 URL 里带 `q-ak=<SecretId>`，`git push` 被 **GH013 push protection** 判成「泄露腾讯云 Secret ID」直接拒收（报错定位到 `data/pending.json:21` / `:46`）。**任何写进仓库 JSON 的 URL 都不许带签名参数**。
  - v2 最终方案：聚合时把待审图**复制一份到 `preview/pending/<basename>` 并给对象级 `public-read`**（`PENDING_PREVIEW_PREFIX = 'preview/pending/'`），快照里 `preview_url` 只写 `publicUrlOf(toKey)` —— 不带任何密钥。新增 `ensurePendingPreview(cos, photoKey)`（源存在才复制、幂等、失败只 warn 返回空串）与 `prunePendingPreviews(cos, keepKeys)`（列出 `preview/pending/` 下已不再待审的副本并删掉，审核完的图不会继续公开挂着）。`writePendingSnapshot` 因此改成 **async 且必须传 cos**（`main()` 两处调用都改成 `await`），DRY 时仍直接 `return 0`。
  - ⚠️ `preview/pending/` 是**新增公开前缀**（需对象级 ACL `public-read`，桶策略没动），只放「正在待审」的副本，审核完即删。
  - `module.exports` 增加 `writePendingSnapshot`（便于本地 `require` 单跑重签快照，不必等 cron）。
- **v4.0.67：小程序端审核能力恢复（2026-11-03）** — 起因：用户问「小程序端不能审核吗」，实测发现小程序审核页读的 `review_queue.json` 永不传 COS，而 COS 又不允许匿名列举 `pending/`，所以「看不到有哪些要审」。方案是聚合端另发一份**脱敏待审快照**。
  - `scripts/process-inbox.js` 新增 `writePendingSnapshot()`：把 `review_queue.items` 里 `status === 'pending'` 的项按 `ts` 倒序导出成 `data/pending.json`（只留 `{_id, kind, ts, create_time, data}`，**剥掉 openid / status / applied_comment_id**），tmp+rename 原子写。`main()` 里两处调用（正常分支 `flushData()` 之后、以及「本轮没有新提交」的早退分支——上一轮被通过/驳回的项也要从审核页消失）。DRY 时直接返回 0 不写文件。
  - **`data/pending.json` 会被正常公开上传**（`scripts/upload-data.js:38` 的 `UPLOAD_DENYLIST` 只有 `inbox_log.json`/`review_queue.json`）——这正是设计：审核页要读它。
  - 重建 `miniprogram/pages/manage/review/`（4 文件）：读 `collection("pending").get()`，照片用 `data.photo_key` 拼 `${data_base_url}/${key}` 预览，便利贴显示 `content`/`nickname`；通过/驳回发 `putInbox("decision",{item_id,action,token})`并本地移除该项。`deciding` 锁防重复点。**旧版（v4.0.65 删掉的那份）把 `data.url` 当图片地址，而 photo 的 `data` 里其实叫 `photo_key`，所以旧页照片永远不显示**——这是重写的理由之一。
  - `miniprogram/app.json` 重新注册 -> **28 页**；`info.js` menuList 首项加回「审核队列」（`num:"numPending"`，两处统计各加 `collection('pending').count({})`）。管理菜单现为 **6 项**。
  - **修 `approvePhoto` 的序号覆盖 bug**：原来 `const nnn = '000';` 硬编码，同一只猫通过多张会全部写到 `catimg/<区域>/<猫>/000.<ext>` 互相覆盖。新增 `nextPhotoSeq(catId, areaSlug, catSlug)`：从 `loadData('photo')` 里扫该猫已有 URL，取 `catimg/<area>/<cat>/` 之后 `^(\d+)\.` 的最大编号 +1，3 位补零。纯内存推导，不请求 COS。
  - 验证：`node --check` 全过、`app.json` 注册 28 页 × 4 文件 `missing=0`、47 单测全过、66 项数据校验全过、`DRY_RUN=1` 输出符合预期。
- **v4.0.66：去掉「操作手册」菜单（2026-11-03）** — 该项只是 `info.js` 的 `guide()` 弹一个「文档请查看 github 仓库文档链接」的 modal，没有任何实际功能，用户要求去掉。已删 `menuList` 里的条目、`clickbtn()` 的 `actionMap`（原本只有 guide 一个分支，整块删掉，直接 `wx.navigateTo`）、`guide()` 方法；`info.wxml:72` 的 `{{item.dot}}` 小红点节点与 `info.wxss` 的 `.dot` 规则一并删除（只有操作手册用过 `dot:true`）。管理菜单现为 **5 项**：猫猫管理 / 反馈处理 / 猫抓板公告 / 位置区域花色 / 友情链接。
- **v4.0.65：管理后台按「一个对象一个入口」重组（2026-11-03）** — 起因：用户问「猫资料编辑和猫猫管理不重复吗」。结论是**确实重复**，且照片操作有一半是假写。判据：**一个对象只留一个入口；凡服务端没有 action 的按钮一律删掉，不再假装能点**。
  - 删 `pages/manage/admin` 的 cat tab（与 catManage 改同一批 cat 字段，且 patch 只覆盖 14/19 白名单字段）和 photo tab（下架/恢复搬进 catInfoTab 照片卡）。`admin` 现在**只剩友情链接**：`admin.js` 552→约 300 行，`admin.wxml` 170→约 62 行，`TAB_META`/`data.tab`/`loadCurrentTab`/`loadCats`/`submitToast`/`GENDER_OPTIONS`/`ADOPT_OPTIONS`/`formatDate` 与 wxss 的 `.picker-row`/`.photo-*` 段全部删除；`onLoad()` 改无参、标题固定「友情链接」。菜单路径同步去掉 `?tab=link`。
  - **删 `pages/manage/review/` 整个目录**（页面+app.json 注册+`utils/msg.js` 引用）。原因：`review_queue.json` 永不传 COS（`upload-data.js:38` 的 `UPLOAD_DENYLIST`），小程序端读到的恒为空 → 这条「审核队列」入口名不副实。真实审核在 GitHub Issue 里评论 `/ok`。⚠️ 以后要恢复审核能力，必须先改上传白名单（会公开未审数据）或另做服务端接口。
  - `catInfoTab` 照片按钮重做：删 `deletePhoto`/`doDelectPhoto`（`api.managePhoto({type:'delete'})` 假写）/`inputPher`/`updatePher`（假写且 wxml 无绑定）。新增 `photoMore(e)`（ActionSheet：下架/恢复 + 移动到其他猫猫）与 `togglePhotoHidden()`（真写 `managePhoto`），`reverseBest()` 改真写 `setBestPhoto` 并在成功后 `reloadPhotos()` 整表刷新（否则同猫另一张的精选角标残留）。wxml 加 `.hidden-badge`「已下架」角标，按钮文案「删除/转移」→「下架/转移」。
  - **服务端新增 `setBestPhoto` action**（`scripts/process-inbox.js` 的 `handleManage` 现支持 9 个 action）：`manageSetBestPhoto()` 会先把同猫其它 `best` 置 false、再置这一张，并调 `recalcPhotoCountBest()` 重算 `cat.photo_count_best` —— 否则破 `scripts/verify-demo-data.js` 的「每猫最多 1 张 best」「photo_count_best 与 best 张数一致」两条不变量。自测已补 3 条用例（正常/错 token/照片不存在）。
  - `catManage` 修正：`activeTab` 默认 `'relation'` → **`'info'`**；删 `handleCreateNewCat`/`onCatCreated`/`onInfoTabModeChange`/`isNewMode`/`hasShownInfoModal`（聚合端没有新建猫 action，点了也是死路）；`onLoad` 不再在 `wx:if` 未渲染时 `selectComponent('#catInfoTab')`（原来恒 null）；无选中猫时统一 toast「先搜索并选择一只猫猫」。位置展示改 `area ? campus + ' ' + area : campus`（真实数据 area 全空串）。
  - `info.js` 管理菜单 **9 项 → 6 项**：操作手册 / 猫猫管理（新增 `num:"numChkPhotos"` 角标）/ 反馈处理 / 猫抓板公告 / 位置区域花色 / 友情链接。
  - 验证：改动 JS 全过 `node --check`、`app.json` 注册 26 页 × 4 文件齐全、47 单测全过、66 项数据校验全过、`DRY_RUN=1 node scripts/process-inbox.js` 输出含 `ok:photo-best-set` 且各项 drop 原因符合预期。
- **v4.0.64：提交后自动返回，防重复提交（2026-11-03）** — 新增统一收尾函数 `utils/syncTip.js` 的 `backAfterSubmit(content, opts)`：`wx.showToast` + `setTimeout(wx.navigateBack, delay)`，模块级 `backing` 布尔防重入（`navigateBack` 的 `complete` 里复位，避免旧锁让下一次提交毫无反应）。
  - 表单型页提交成功即返回：`pages/news/createNews`（另加 `data.submitting` 锁 + 按钮 `disabled="{{submitting}}"`）、`pages/genealogy/detailCat/ratingDetail`、`pages/genealogy/feedbackDetail`（成功返回、失败留在页上）、`pages/genealogy/addPhoto`（只在待上传列表清空时返回）、`components/catInfoTab`、`components/relationTab`、`pages/manage/admin` 的 cat/link 两个 tab。
  - **列表型/容器型不返回**，只加防重锁：`pages/manage/review`（靠 `showLoading mask`）、`pages/manage/checkFeedbacks`（新增 `this.checking`）、`pages/manage/newsAdmin`（新增 `this.removing`）、`pages/manage/replyFeedback`（新增 `this.replying`）、`pages/genealogy/commentBoard`、`pages/manage/admin` 的 photo tab。
  - `pages/manage/filters` 的 `uploadFilters(e)` 用 `isFinal = !!(e && e.currentTarget)` 区分「页面内静默保存」与「底部确定上传」（后者才返回）；并补上原来缺失的 `putInbox` 返回值判断、失败 toast 与 `wx.hideLoading()`；`doUploadCampus` 只 toast 不返回（页内中间步骤）。
  - **修真实 bug**：`pages/manage/replyFeedback` 原来 `bindReply` 提交后再调 `bindCheck()` 又发一次 `manageFeedback`（只带 `status`），等于同一件事提交两遍 —— 已删 `bindCheck`，改为一次 patch 带 `status+replyInfo+replyDate`。
  - **catInfoTab 假写转真写**：`saveCat()` 原来走 `api.updateCat` → `datasource.function.invoke` 未实现 → `{ok:true,data:null}` 假成功；现改 `passcode.ensureToken()` + `putInbox('manage',{action:'updateCat',patch})`，`patch` 只收 `MANAGE_CAT_PATCH_FIELDS` 白名单 19 字段（聚合端白名单外的键会让整条 drop）。**聚合端没有新建猫的 action**，所以无 `cat_id` 时直接提示「暂时只能修改已有猫猫，新建暂未开放」。
  - 验证：14 个改动 JS `node --check` 全过、47 单测全过、66 项数据校验全过。
- **v4.0.63：管理后台重构，删掉 19 个无用目录（2026-11-03）** — 判据：页面是否有真实 `putInbox` 写链路（走 `api.curdOp`/`api.adoptionOp`/`api.vaccineOp` 的全是**本地假写**，因为 `datasource.js:1332-1360` 的 `function.invoke` 只实现 6 个 action，其余返回 `{result:{ok:true,data:null}}`）。
  - 已删目录：`pages/manage/{addCat,addRelations,checkComment,checkPhotos,checkAdoption,imProcess,managers,medicalManage,photoManagement,rewards,pageSettings}`、`pages/tools/{inviteUser,updateUserRole}`（`pages/tools` 空目录一并删）、`pages/info/{myFootprint,myAchievement}`、`pages/genealogy/applyMapAccess`、`pages/genealogy/detailCat/relationGraph`、`pages/map`、`packages/tencentcloud`、`components/vaccineTab`；文件：`utils/achievement.js`、`utils/cloudAccess.js`（`cloudAccess`+`tencentcloud`+`addCat`/`addRelations` 曾是闭环引用，一起删）。
  - `info.js` 管理菜单 15 项 → **9 项**：操作手册(guide)/审核队列/猫资料编辑(?tab=cat)/照片审核(?tab=photo)/友情链接(?tab=link)/反馈处理(**去掉 disabled，已可用**)/猫抓板公告/位置区域花色/猫猫管理(catManage，新增入口)。`loadAdminNums` 与 `refreshManagerNums` 同步删掉 `numChkComments`/`numImProcess` 统计。
  - `catManage` 去掉疫苗 tab（`.json` 删 `vaccine-tab` 组件声明、`.wxml` 删 tab 按钮 + `<vaccine-tab>` + `.vaccine-options` 浮层、`.js` 删 6 个 handler、`.wxss` 删 `.vaccine-*`/`.option-*` 块）。
  - `project.config.json`：`packOptions.ignore` 18 条 → **只剩 `images/markers`**；`condition.miniprogram.list` 清掉 9 个已删页，`pages/science/sciDetail` 路径修正为现存 `pages/news/sciDetail/sciDetail`。
  - `config.js` 删 `inviteUser` 配置块；`utils/page.js` 的 `toSettings()` 改 toast（目标页已删，该函数零调用者）；`utils/msg.js` 两处订阅消息 page 从 `checkPhotos` 改指 `admin?tab=photo` 与 `review`。
  - **修真实 bug**：`scripts/process-inbox.js` 的 `MANAGE_CAT_PATCH_TYPES` 少了 `relations: 'array'`，导致 `patchValueOk()` 首行 `if (!type) return false` 直接拒 → `relationTab.js` 保存猫际关系**永远 `drop:bad-patch-type` 静默失败**。已补。
  - 验证：27×4 页面文件齐全 missing:0、`node --check` 全过、47 单测全过、66 项数据校验全过、22 个已删关键词全仓扫描零命中。
- **v4.0.62：口令全站只输一次（2026-11-03）** — 原来是「解锁（连击 5 次）输一次 + 每个管理页提交前再 ensureToken 各输一次」，共 12 处 `promptToken` + 5 份重复 `ensureToken` + 15 页 `checkAuth(level)` 二次拦人。现统一为：**只在关于页连击输一次**（`info.js` `askAdminPasscode()` 校验 `data/gate.json` 的 code 后同时写 `passcode.setToken` 与 `setUnlocked(true)`），下游一律 `passcode.ensureToken()` 直接读已存 token（取不到只弹「回关于页重新解锁」提示，绝不弹输入框）。
  - `utils/passcode.js` 新增导出 `ensureToken()`；`utils/user.js` 的 `isManagerAsync()` 简化为 `return passcode.isUnlocked();`（**不再比对 `user.manager` 等级**），`checkAuth(page, level)` 只看解锁标记，失败文案改为提示回关于页解锁。
  - 删掉 admin / review / newsAdmin 三页的「口令」按钮（`.head-lock`）、`.token-tip` 提示条及对应 wxss；`<passcode-modal />` 只保留 `info.wxml:104` 一处（其余 5 页删除）。
  - 修 bug：`replyFeedback.js:25` 的 `if (checkAuth(this, 1))` 漏 `await`（Promise 恒真 → 权限判断失效）已补上。
  - ⚠️ 语义变化：**解锁即管理员**，`user.manager` 等级不再参与门禁；`data/user.json` 空表时首个访客仍是 `manager=99`，但已不影响入口。真正提交校验仍在服务端 `scripts/process-inbox.js` 的 `tokenOk()`。
- **v4.0.56：拍照识猫改接 MeowID 开放平台（2026-11-02，v4.0.58 已上线）** — 完整细节见 `AGENTS-archive.md` 的「v4.0.56」一节，这里只留当前仍生效的事实：
  - **project_id 不可推导，必须用户给**：API key 形如 `mk_live_<16位十六进制>_<secret>`，但那 16 位**不是** project UUID；用各种变体/前缀/数字/穿越探 21 次全返 `403 project_mismatch`，且服务端**只比对 key 绑定项目、不查存在性**（不存在的 pid 也是同一个 403）→ 枚举不可行。假 key 返 `401 invalid_api_key`（可判真伪）。鉴权头**只认 `Authorization: Bearer <key>`**。
  - **识猫端点** `POST {apiBase}/v1/projects/{projectId}/search?top_k=N&threshold=T`，multipart 单字段 **`image`**（`wx.uploadFile` 的 `name:'image'`，微信自造 boundary，不能自定义 Content-Type）；响应 `{candidates:[{index,route,face_detected,unknown,matches:[{cat_id,cat_name,score,support}]}]}`，单猫可能退化为扁平对象；**`matches[].score` 才是相似度**（`candidates[].score` 是检测分）；**响应无 bbox/face_box** → 旧的「画框+点框切猫」已整体删除。
  - **已灌库（v4.0.58）**：UUID `0627e727-c9c1-4194-a896-545c5106b676` 已验通；**21 只猫 212 张参考图全部入库**（向量已提取），`data/cat.json` 21 条 `meowid_id` 齐全；`data/setting.json` 的 `recognize` 块已填 `apiBase/projectId/apiKey/topK=3`；平台原有「奶盖」`326496d1-9402-489e-b9e3-fedc5df70282`（22 图 / meta demo-cat-12）经真实照片 search 命中 score=0.35、support=19，确认为本地 `cat-naigai` 同一只，**已复用未重复建档**。灌库脚本 `scripts/meowid-enroll.js` 可重跑补漏（state 文件不保证全持久化，以平台计数为权威）。**剩余：真机自测**。
  - **计费**：按「猫咪向量提取」计次（注册+识别都算），没检测到猫不计费；一次多猫识别只扣 1 次；图片上限 15 MiB。
  - **入口隐藏的坑（必记）**：`genealogy.js` 里 `__wxConfig.envVersion === 'release'` 在开发者工具里是 `'develop'`，读不存在的 `recognize_test` → `settings` 空 → `showRecognize=false`，入口不显示。已改成 `=== 'release' || === 'develop'`。
- **v4.0.53：全量代码审计优化落地（2026-11-01）** — 9 类改动，逐条清单见 `AGENTS-archive.md` 的「v4.0.53」一节。要点：
  - 下架照片露出面全站清理（B1）：`cat.js`(getBestPhoto/getLatestPhoto)、`datasource.js`(_getCatLocations)、`gallery.js`、`detailCat.js` 相册均过滤 `hidden`/`deleted`；`detailCat.js` 点赞改 async + `await putInbox('like',…)`；服务端照片审核通过改为真复制 pending→catimg 并 append `photo.json`（`approvePhoto`，`photo_count_total+1`）。
  - 6 处 `api.curdOp` 假写改真 `putInbox`（inter / relationTab / checkFeedbacks / replyFeedback / pageSettings / filters / catInfoTab 的 movePhoto），服务端新增 `deleteComment`/`approvePhoto`/`manageFeedback`/`managePageSettings`/`saveFilter`/`movePhoto` 等 action（白名单 + 永不 throw + `markTouched`）。
  - 删 `pages/leaderboard/`、`components/photoRank`、`components/achievementRank` 死页与孤儿组件；删 252 处调试 `console.log`；新建 `utils/nickname.js`（`NICKNAME_MAX=20`）应用到 commentBoard/feedbackDetail/modifyNews 3 页（addPhoto 已匿名直传无昵称）。验收 47 单测 + 66 verify + DRY_RUN 全过，提交 `1e48b71`。⚠️ 用户自有改动 `app_logo.png`/`图片.pptx` 未纳入审计提交。
- **v4.0.54：五维评分雷达图（2026-11-02）** — 详情页「猫友评价」**展开详情**里，原 5 行 `star-rating` 换成 canvas-2d 五维雷达图：`detailCat.js` 新增 `drawRatingRadar()`（按 `cat.rating.dimAvg` 的 `{name,score}` 画五边形，`#0C5F03` 描点 / `#14801F` 描边 / `rgba(20,128,31,0.18)` 填充、4 圈同心网格 + 维度标签），`bindDetailRating` 展开时与 `onShow` 各重绘一次，`count===0` 显示「暂无评分，快来当第一个～」。**只动视觉、不碰数据结构、不引依赖、主题色不变**。完整原文见 `AGENTS-archive.md` 的「v4.0.54」一节。
- **v4.0.55：数据看板加「近半年趋势」+「成长时间轴」（2026-11-02）** — `_getCatStats()` 扩 `trend/trendMax/timeline`；`dashboard` 新增趋势柱状卡与时间轴卡。⚠️ 「为什么不用 `stats.events`」「`mphoto` 是毫秒时间戳」等要点见 `AGENTS-archive.md` 的「v4.0.55」一节。
- **更早的已上线条目（原文全在 `AGENTS-archive.md`，按节名查；这里只留当前仍生效的结论）**：
  - **v4.0.42 管理口令收敛为 `data/gate.json` 一处**：`process-inbox.js` 的 `currentGateCode()` 读 `data/gate.json` 的 `code`，`tokenOk()` = `currentGateCode() || REVIEW_PASSCODE || ''`；**`REVIEW_PASSCODE` 降级为兜底**，新部署完全不用配 secret；自测用 `SELFTEST_TOKEN`。改 gate code 一处同时决定「界面能不能进」和「提交能不能过」，口令不对仍是 `drop:bad-token` 静默丢弃。提交 `9d11c92`。
  - **v4.0.36 关于页按参考图重构**：只改 `info.wxml`/`info.wxss`/`config.js`（**`info.js` 一字未动**）；连击位置从 `.nav-title` 迁到 `.title`（「火大猫谱」），**必须 `catchtap` 不是 `bindtap`**（防冒泡）；`showCond[menu.show]` 在 wxml 里**必须是 2 处**（工具组 + 管理后台组，别合并）；**故意不加「清理缓存」行**——`info.js` 里 `this.clearCache()` 根本不存在，调用必报错，别去实现。提交 `090bb1b`。
  - **v4.0.35 公告管理独立入口 + 普通页零权限判断**：新建 `pages/manage/newsAdmin/`，公告写入改走 `putInbox('manage',{action:'manageNews',op:add|update|remove})` → `process-inbox.js` 的 `manageNews()`（**永不 throw**，`markTouched('news')`）；`detailNews` 退化为纯展示页（删「删除/修改」按钮，那曾是「公告谁都能改」的病根）；`passcode.js` 扩到 6 个导出（加 `UNLOCK_KEY/isUnlocked/setUnlocked`）；`isManagerAsync` 必须先判 `passcode.isUnlocked()`（否则 `remoteConfirmedEmpty` 分支让人人 manager=99）。⚠️ `MAX_OBJECT_BYTES` 从 4096 放宽到 `16384`（公告正文 + 9 图 URL 会顶破），`pending/*` 的 512KB 闸门不变。提交 `42556b6`。
  - **v4.0.34 连击 5 次 + 口令解锁**：口令**明文**存 `data/gate.json` 的 `code`（**废弃 SHA-256 哈希版**），`TAP_TO_UNLOCK=5`、`TAP_WINDOW=800`（超时重新计数，「连击」不是「累计」）；`loadGateCode()` **故意不缓存**，改完 gate.json 下次连击即生效；⚠️ `data/` 是公开 CDN → 口令等于公开，只是「别让普通用户误入」的 UX 门；`data/gate.json` 必须真传到 COS，否则「管理入口未启用」（`datasource` 对 404 有 10 分钟冷却）。提交 `34d1634` + `2908f0f`。
  - 其余：v5.4 主题色强化（`#0C5F03` 不改、大面积填充换 `#14801F`；hero 选中格改整格浅绿胶囊；`e9689bf` 的 commit message 没提它，**别再重复提交那 2 个文件**）｜v4.0.31 管理后台拆 `?tab=cat|photo|link` 三入口（无页内 tab）｜v4.0.30 友情链接可增删（`saveFriendLinks` 整体替换，`APPID_RE=/^wx[0-9a-zA-Z]{16}$/`）｜v4.0.30+32 提交后「延迟生效」提示（`utils/syncTip.js` + `text.sync` 6 键，`received_tip` 是唯一成功文案）｜v4.0.29 四页标题 52rpx + tab 改名「猫片」（只改 `custom-tab-bar/tab.js:12`）｜v4.0.27 「校区」→「位置」+ 配置缓存版本失效（`_migrateConfigCache()`）+ 抽屉骨架回退原版（**绝不能做成底部弹层**；`hidden` 会被 CSS `display` 顶掉，开关一律用 `wx:if`）｜v4.0.26 筛选抽屉三行胶囊 + 位置三分类 + 花色七类（状态 7 值互斥，多选要包 `$or`）｜v4.0.24+25 首页 hero 数据卡（**必须 `catchtap`**，`bindtap` 会冒泡跳看板）｜v4.0.23 用户档案体系整体放弃（`fake_openid` 与微信账号无关；**每个提交场景当场填昵称**，`ratingDetail` 不加昵称框）
- **COS 上传踩坑（2026-11-01 定位，务必按此操作）**：`C:\Users\yzx49\tmp\cosprobe\putpub.js` 的 `put(key, body, acl)` 实测可用，但**必须用 `node -e` 内联调用**（`require('./putpub').put('/data/x.json', fs.readFileSync(...), 'public-read')`）。走命令行 `node putpub.js <key> <file> public-read` 会稳定返回 **nginx 400 Bad Request**（`<html>…<center>400 Bad Request</center>…nginx`），**即使 key 已带前导斜杠**，成因未明（与 shell 传参/编码有关），别再在这上面耗时间。`cos.js` 的 `request('PUT', '/path', {}, body)` 可写但**不能带 ACL**（会变私有）。上传后必须 `curl -s -o /dev/null -w "%{http_code}"` 验证匿名 200。
- 数据源：`https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com`，微信后台已加 request 合法域名
- **2026-11-01 起 `data/` 已是真实数据（演示数据全清）**：`cat` **21 只真猫**、`photo` **278 张**，`comment`/`rating`/`feedback`/`news`/`adoption`/`inter`/`achievement`/`reward`/`photo_rank`/`inbox_log`/`review_queue`/`user` **共 12 张表已清空为 `items: []`**。旧的 demo 数据备份在 `C:/Users/yzx49/tmp/catid/data-bak-demo/`（仓库外），要回滚从那里取。
  - `cat._id` = `cat-<拼音>`（如 `cat-naigai`），`campus` = 校外/其它/校内，`area` 全为 `""`，`colour` 是看代表图人工判的（**未经用户确认，可能要改**），`rating` 全零对象、`photo_count_total` = 真实张数、`mphoto` 从 2026-10-01 起每猫 +1 天。
  - `photo._id` = `photo-<拼音>-<nnn>`，三个 URL 同源指向 `catimg/<area-slug>/<cat-slug>/<nnn>.<ext>`；`best` 只给每猫第 1 张；`shooting_date` 只有 **8 张** 有 EXIF 真日期，其余兜底 `2026-01-01`（278 个文件 mtime 全是同一天，无法区分）。
  - `user` 表清空后，`datasource._userOp('get')` 的 `remoteConfirmedEmpty` 分支生效：**首个访客自动拿 `manager=99`**（这是原有语义，不是 bug）。
  - 猫的 `birthday` / `gender` / `area` **全部是空串**（真实数据里没有这些信息）。详情页靠 `wx:if` 隐藏，不会显示空行；「拍摄时约 X 月龄」在没有生日时不出现。
  - ⚠️ **`area` 为空是刻意设计，别再按「campus && area」判位置**：位置只到「区域」这一级。展示的地方一律写成 `cat.area ? cat.campus + ' ' + cat.area : cat.campus`（`genealogy.wxml:106`、`detailCat.wxml:82`、`catInfoTab.wxml:29`、`addCat.wxml:8`），保存校验只校验 `campus`（`catInfoTab.js` 的 `saveCat` 与 `addCat.js` 的 `upload`）。旧代码用 `&&` 判存在会让详情页显示 `-`、编辑猫存不进去。
  - 筛选 picker 的第二列（细分地点）在 `filter.area` 为空时会是空数组 → 两个 `loadPickers()` 都补了 `if (!area_category[campus].length) area_category[campus] = [''];` 占位，否则多列 picker 越界。
  - `data/setting.json` 内嵌的 `_id='filter'` 与 `data/filter.json` **已同步**（2026-11-01，脚本 `C:/Users/yzx49/tmp/catid/sync_setting_filter.py`）。以后改花色/位置仍要两处一起改：`loadFilter()`（`utils/page.js:27`）读的是 setting。当前 `colour` = 橘色/黑色/白色/狸花/三花/玳瑁/重点色，`campuses` = 校内/校外/其它，`area` = `[]`。
  - ✅ 数据校验脚本已改成真实数据口径（2026-11-01）：`scripts/verify-demo-data.js` 从「demo 断言 50 项」改为 **66 项不变量**（引用完整、`photo_count_*` 与实况自洽、每猫最多 1 张 best、`shooting_date` 合法且不早于生日、`colour`/`campus` 必须落在 `filter` 枚举内、`photo_compressed` 必须是 `catimg/<拼音>/<拼音>/<3位序号>.<ext>`、12 张空表查询不抛异常…）。**文件名沿用旧名**，别再改成 verify-real-data.js。
  - ⚠️ **本地改了 `data/` 不会自动上 COS**：要 push `cos` 触发 `sync-data.yml`。2026-11-01 14:12 复查：远端 `data/photo.json` 已是修正后的 11 条、无非法日期，说明 `sync-data.yml` 已跑通。
  - COS 上曾出现过一条 `relink-photo-1`（指向 `photos/demo-cat-12/0001.jpg`，猫 `demo-cat-12 奶盖`），是误把 `photos/demo-cat-1/cover.jpg` 复制过来当新照片的假数据。**2026-11-01 已彻底清除**（远端只剩 11 条 photo、11 只 cat，孤儿对象 `photos/demo-cat-12/0001.jpg` 已删）。
- 其余演示规模：comment 48 / rating 48 / user 9 / news 8 …
- UI 已全站统一白底大圆角（v5.2），图库是横向漂流墙（8 行宽窄交替 marquee）
- 审核/管理**已无口令锁屏门**（v4.0.33）：**首页**（v4.0.72 从关于页迁来）连击「火大猫谱」标题 5 次 → 输口令 → 解锁并顺手存本地 storage `manage_passcode`（`utils/passcode.js` 统一读写，解锁标记 `admin_unlocked`）；真正校验在 `process-inbox.js` 的 `tokenOk()`，**读 `data/gate.json` 的 `code`**（v4.0.42 起；`REVIEW_PASSCODE` 仅兜底），token 不对的提交直接 `drop:bad-token` 静默丢弃
- **徽章（勋章）功能已全站删除**（v4.0.17）：10 个页面 40 个文件、`components/badgeModal`、`components/badgeRank`（只有死页 leaderboard 引用）、`utils/badge.js`、`cloudApi.js` 的 `getBadge/giveBadge/genBadgeCode/loadBadgeCode`、`data/{badge,badge_def,badge_rank}.json`、11 张图片、`config.badge_rank_*_img` 常量、`gen-demo-data.js` 的 BADGE_DEFS 段、`verify-demo-data.js` 的 8 个校验项全部清除。`app.json` 页面 38→34、分包 3→1。`info` 页删「徽章口袋」card 与「徽章管理」菜单。`ratingDetail.wxss` 原有 `@import "../badgeDetail/badgeDetail.wxss"`，已内联所需的 `.bd-block`/`.bd-title`；`app.wxss` 里零引用的 `--color-badge-A/B/C` 三个 token 也已删（文件其余 token 不动）
- **「猫际关系」卡按数据显隐**（v4.0.18）：外层条件改为 `{{cat.relations && cat.relations.length}}`（不再对管理员单向开放），没有关系时整张卡不显示；卡内「+ 添加关系」入口删除，`detailCat.js` 的 `toAddRelation()` 一并删除，**改到「猫咪信息纠错」页**（`feedbackDetail`）——仅管理员可见（`isManagerAsync(3)`），`.adminEntry` 块在 `.userInfo` 之后
- 详情页整体信息架构（v4.0.17 重构）：猫猫档案卡（去绿条 label-block、扁平两列）→ 猫友评价卡 → 疫苗卡 → 猫际关系卡 → 相册；卡片间距统一 24rpx
- **详情页「+」悬浮弹窗已移除**（v4.0.15 移除，v4.0.16 起改为就地挂载）：`detailCat` 的 7 个操作不再集中成卡片，而是**逐个挂到页面本来就对应的位置**——便利贴数 count → `toComment`；粉丝量 count → `followCat`（已关注时 `.tap-on` 变绿）；档案卡（`icon-newspaper-o`）header 右上「猫咪信息纠错」→ `bindTapFeedback`；评分行右侧「我要评分」→ `bindRating`（与「展开详情」并列）；相册 `.big-header` 右侧 `.album-tools`（`上传喵照` `bindAddPhoto` 受 `canUpload` 控制 + `分享喵ID` `showPoster`）；领养状态 tag（`cat.adopt == 1`）→ 文案改成「{状态} · 申请领养」并 `bindtap="bindApplyAdoption"`。`showFunction`/`closeFunction`/`showFunc` 与 `.action-card/.action-grid/.action-item` 样式已彻底删除

## 已知限制

- **node 不在 PATH**；`npx tsc` 用不了（`miniprogram-api-typings` 也没装进 node_modules），所以 TS 类型检查跑不起来
- **跑不了 E2E**：需要微信开发者工具 + `cli.bat auto --auto-port 9420`，当前沙箱拦 `reg.exe`
- `README.md` 是上游原文，写着"阿里云 EMAS + MongoDB + OSS"，**完全过时**，别据此判断架构；以本文件为准
- `functionsEMAS/unionOp/node_modules` 残缺（源目录 3866 个占位丢约 400 个），`dev` 线要用得重装
- 桶里 962 个对象 / 239.9 MB（2026-11-01 清理后实测）。其中 `东苑/`(136) `校外/`(113) `其它/`(42) `校内/`(2) `undefined/`(5) `compressed/`(298) `watermark/`(298) 都是 EMAS 时代的历史猫照，**无归属关系可恢复**——EMAS 里的 photo 表已随空间删除，别承诺恢复。容量大头是 `watermark/` 139.1 MB（原图带水印）与 `校外/` 41.5 MB，两者都只有对象读权限（私有，匿名 GET 403），不占对外流量
- **已无「注册但静默 no-op」的页面**（v4.0.63 已把这类页全部删除）。`catManage` 现在是真能写：`<cat-info-tab>` 的 `saveCat()`（v4.0.64 起改 `putInbox('manage',{action:'updateCat',patch})`，白名单 19 字段）、`putInbox('manage',{action:'movePhoto'})`、`<relation-tab>` 的 `putInbox('manage',{action:'updateCat',patch:{relations}})`（v4.0.63 修了服务端缺 `relations` 类型的 bug）。⚠️ `datasource.function.invoke` 对 `unionOp` 仍未实现 `updateCat`/`managePhoto`/`vaccineOp` 等，走 `api.xxx` 的调用依旧返回 `{result:{ok:true,data:null}}` 假成功 —— **新增写操作一律用 `putInbox`，不要用 `api.*`**。
- 遗留死代码：`news.js:149 clickScience()` 跳 `/pages/science/science`（页面不存在，wxml 未绑定不触发）；`packages/tencentcloud/` 内还留着 `miniprogram/packages` 下别的包，别整体扫。（注：`pages/leaderboard/`、`components/photoRank`、`components/achievementRank` 已在 v4.0.53 删除；19 个管理/工具死页已在 v4.0.63 删除）
- 首页封面/榜单/地图的照片查询过滤问题已在 v4.0.53 审计中修复（B1）：`cat.js` 的 `getBestPhoto/getLatestPhoto`、`datasource.js` 的 `_getCatLocations`、`gallery.js` 查询、`detailCat.js` 相册均已过滤 `hidden`/`deleted`，下架照片不再在其他位置露出
- `--color-comment-paper-white` 这类被误伤的命名残留已还原，但 `packages/weui/weui-wxss/dist/style/weui.wxss` 也曾被批量替换过（等价改动，未回滚）

## 照片归属重建工具（2026-11-01 建）

背景：桶里 `compressed/` 298 张真实猫照私有读，猫↔照片归属随 EMAS 空间删除永久丢失，靠人肉眼认照片重建。三步：

1. **`scripts/relink-scan.js`**（本地跑，需密钥）：`getBucket` 列 `compressed/` 前缀 → `putObjectCopy` 到 `photos/relink/001.jpg`（public-read）→ 生成项目根 `relink-workbench.html`（内联 11 只猫 + 照片 URL）。`CopySource` 按 `/` 分段 `encodeURIComponent`，报 NoSuchKey 回退整 key 编码。`DRY_RUN=1` 用现有 cover.jpg 生成演示 html。
2. **`relink-workbench.html`**（用户认猫，零密钥）：自包含单文件，CSS columns 瀑布流，点卡片弹猫名按钮组 +「跳过(不是猫)」，进度存 localStorage（key `relink-workbench-v1`），导出 `relink-result.json`。
3. **`scripts/relink-apply.js`**（本地跑，需密钥）：读 `relink-result.json`（`{exported_at, photos:[{src,cat_id,action:assign|skip}]}`）→ `putObjectCopy` 到 `photos/<cat_id>/<4位序号>.jpg` → 追加 `data/photo.json`（`_id=relink-photo-<n>`、`marker_type` 复用该猫现有值、`best:false`、三 URL 同源）→ 累加 `data/cat.json` 的 `photo_count_total` → 上传两份 JSON（public-read）。

要点：密钥读 `process.env` → 手写解析项目根 `.env`（无 dotenv 依赖）；**同一只猫认领多张时 `nextSeqByCat` 必须递增**（初版 bug 是同猫第 2 张覆盖第 1 张）；`relink-workbench.html`/`relink-result.json`/`.env` 均在 `.gitignore`；跑前先在 `scripts/` 下 `npm install`（`cos-nodejs-sdk-v5` 未随仓库装）。完整原文见 `AGENTS-archive.md`。

## 改动前的检查清单

1. 改了什么数据？→ 是否需要同步 `data/` + 推 `cos`（触发 `sync-data.yml`）
2. 新页面/组件？→ `app.json` 注册 **且** 从 `packOptions.ignore` 移除
3. 改样式？→ 只动 hex，别动颜色关键字；`app.wxss` 排除
4. 改完跑：单测 62 例 + `verify-demo-data.js` 70 项（真实数据不变量口径；一次就够，不要来回验）
5. 升 `config.js` 的 `app_version`，commit message 带版本号
6. 有持久价值的新结论 → 追加到本文件（不要写 `.workbuddy/memory/`）
