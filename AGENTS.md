# MaoPu（火大猫谱）— 项目记忆

> **回复格式硬规矩（用户 2026-11-03 明确要求，m00131）**：任何回答的**第一句话必须是结论**，不许先铺垫、先报进度、先解释过程。分析类请求尤其如此——用户已经因此不满两次。
>
> DSH 每个新会话自动加载本文件。`.workbuddy/memory/` 是旧工具 WorkBuddy 的目录，**DSH 完全不读**，别再往那里写新记忆。
> ⚠️ **本文件有 65536 字节的 workspace instruction budget**，超出部分会被截断丢内容。2026-11-04 三次精简：64.5KB → **~42KB**，v4.0.15–v4.0.71 的版本条目正文全部搬进项目根的 `AGENTS-archive.md`（主文件只留一行索引，`v4.0.72+` 仍在正文）。**新增内容前先看这个预算**；要写长文就写进 `AGENTS-archive.md` 并在本文件留一行索引。

## 工作方式硬规矩（用户 2026-11-04 明确不满，m01813/m01827）

> 起因：用户问「为什么反复思考，为什么反复调用工具」。我为了改 4 个文件，读了 60+ 次文件、翻了整个 SpaceLaunch 源码、反复验证，还触发多次上下文压缩。

1. **一次取证，立刻动手**。同一个事实只查一次；本文件已有结论的，不再重读源码。
2. **改完只验一次**：`node --check` + 单测一次 + `verify-demo-data.js` 一次，通过就提交。禁止「改一行→跑一次」的循环。
3. **不许为了「确保正确」反复重读同一批文件**。写之前读一次、写完 `--check` 即可。
4. **用户催促（「墨迹」「你再思考就滚」）出现时，立即停止所有工具调用，只输出结论。**
5. 需要的结论本题答不出，直接问用户一句话，别自己探。

## 一句话定位

中山大学校园流浪猫谱系微信小程序「火大猫谱」，fork 自 `sysucats/zhongdamaopu`，品牌化为绿色 `#0C5F03`。
没有服务器、没有云开发：数据是 Git 仓库里的 `data/*.json`，同步到腾讯云 COS 当 CDN，小程序端拉 JSON 在内存里查询。

## 技术栈与目录

- 微信原生小程序，无框架。`miniprogramRoot: miniprogram/`，appid `wx5d52c6c8f098ed5e`，`libVersion: 2.24.7`，`nodeModules: false`
- 页面：`app.json` 注册 **28 页 + 分包 `pages/packageA` 1 页**（v4.0.76 加 versionLog 27→28）（v4.0.67 加回「审核队列」review 页，26→28）（v4.0.65 删 review 页，27→26）（v4.0.63 管理后台重构删 4 页：imProcess/checkPhotos/checkAdoption/pageSettings，31→27）（v4.0.35 加 newsAdmin，30→31）（v4.0.17 删徽章 38→34；v4.0.23 删用户档案页 34→30）
- `miniprogram/utils/datasource.js`（1321 行）：自研的 mpserverless 兼容层，实现 `createJsonServerless({baseUrl})`
- `miniprogram/utils/writeback.js`：COS inbox 写入通道（客户端零密钥）
- `data/`：19 个 JSON，即"数据库"（删徽章三件套后从 22 降下来）
- `scripts/`：Actions 专用脚本，**独立 `package.json`**（只依赖 `cos-nodejs-sdk-v5 ^3.0.0`）
- `tests/`：`datasource` / `cache` / `process-inbox` / `review` 四个测试文件，共 **65 例**
- `.github/workflows/`：7 个（aggregate、bundle-size、process-inbox、review、set-inbox-policy、sync-assets、sync-data）
- `functionsEMAS/`、`initDatabase/`、`initStorage/`：上游遗留，EMAS 空间已删，**基本是死代码**

## 常用命令

**本机 node 不在 PATH**，用 HBuilderX 自带的 v22：
```bash
NODE="C:/Users/yzx49/Program/HBuilderX/plugins/node/node.exe"
```
- 单测（65 例）：`"$NODE" --test tests/datasource.test.js tests/cache.test.js tests/process-inbox.test.js tests/review.test.js`
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
`scripts/upload-data.js:38`：`const UPLOAD_DENYLIST = new Set(['inbox_log.json', 'review_queue.json', 'app-config.json']);`
→ 本地生成审核数据后线上审核页仍为空态，**这是安全设计，别当 bug 修**。真实数据只能走 提交 → inbox → Actions 聚合。
→ `app-config.json`（v4.0.74 起）同样被排除，因为它要在 COS 上直接手改、不能被 CI 覆盖，见「v4.0.74」条目。

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
以 `miniprogram/config.js` 的 `app_version` 为准（当前 `v4.0.77`），commit message 末尾带版本号。⚠️ 本文件历史段落里的版本号（v4.0.42 等）是当时写入时的快照，实际版本号一律看 `config.js`。
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
- `config.demo_mode: false`、`writeback_enabled: true`、`photo_upload_enabled: **true**`（2026-11-01 改为匿名直传 COS，见"已知限制"）、`app_version: v4.0.77`
- **v4.0.80：补 4 个 TS 组件的 JS 实现，修便利贴墙空白（2026-11-04）** — 现象：详情页显示「便利贴 1」但便利贴墙只有输入框、列表全空。根因不是数据/查询，而是 `project.config.json` 的 `setting.useCompilerPlugins` 为 `false`（没开 TS 编译插件），`components/{comment-list,cat-card,star-rating,genealogy-tree}` 只有 `.ts` 没有编译产物 → 组件不存在，列表项与顶部猫卡都渲染不出来。修法：给这 4 个组件各补一份等价 `.js`（`.js` 优先于 `.ts`），逻辑与原 TS 完全一致（`comment-list` 的 `onDelete` 触发 `delete` 事件；`cat-card` 的 `cat,title` observer 算 `cover/metaShow/displayName`；`star-rating` 的 `value,max` observer 生成 `stars`；`genealogy-tree` 的 `cat,parents,children` observer 算 `hasData` + `onTapNode`）。⚠️ **以后新增 `.ts` 组件必须同时给 `.js`**，否则编译后组件不存在；`pages/manage/` 下 3 个 `.ts` 页面已有 `.js` 双胞胎，不用管。
- **v4.0.77：身份只有「用户 / 管理员」两种，修便利贴被关（2026-11-04）** — 用户指出「没有游客这种身份」。`utils/user.js` 的 `UserTypes` 由 `{manager, invited, guest}` 改为 `{manager, invited, user}`；`_checkFuncEnable()` 里人群判定改为 `ctrlList`（trim + 去空 + `guest` 兼容旧配置当普通用户），`hitUser = !isManager && !isInvited && (ctrlList.includes('user') || ctrlList.includes('guest'))`。`data/setting.json` 的 `accessCtrl` 改 `{ctrlUser:"user", ctrlVersion:"*", disabledFunc:"", limitedFunc:""}`（原 `ctrlUser:"guest"` + `limitedFunc:"reward,feedback,comment"` 导致所有人发不了便利贴），`version` 同步递增。⚠️ `limitedFunc` 现在为空，要再限制就填 `reward`/`feedback`/`comment`；`ctrlUser` 填 `user` 表示普通用户、`manager` 表示管理员。
- **v4.0.76：版本记录独立成页（2026-11-04）** — 更新日志从「程序开发」页搬进新页 `pages/info/versionLog/`（4 文件，wxss `@import '../reward/reward.wxss'` 复用 `.block/.title`），`update_log` 置顶新增 `v4.0.0 / 2026/11/04`；`app.json` 27→**28 页**；关于页「版本」行改成 `bindtap='clickbtn' data-to='/pages/info/versionLog/versionLog'`；`devTeam.js` 删 `update_log`（-81 行）、`devTeam.wxml` 删「更新日志」块。
- **v4.0.75：详情页去掉「分享喵ID」（2026-11-04）** — 用户要求删掉相册区的分享海报入口。改动：`detailCat.wxml` 删 `.album-tools` 里的第二个 `.tool`（`bindtap="showPoster"` + `shareMeowId.svg` + 文案「分享喵ID」）与文件末尾的 `<poster id="posterComponent" ...>`；`.album-tools` 整体加 `wx:if='{{canUpload}}'`（否则只剩一个按钮时仍会渲染出一条空工具条），内层 `.tool` 的 `wx:if` 去掉（外层已判）；`detailCat.js` 删 `showPoster()`；`detailCat.json` 的 `usingComponents` 删 `"poster": "/components/poster/poster"`。**`components/poster/` 组件本身保留**，`packages/weui/gallery/gallery.wxml:28` 仍在用它（图库大图页的海报），别整目录删。`shareMeowId.svg` 已无引用但文件保留。
- **v4.0.74：审核开关改成「直接改 COS」，不再走仓库（2026-11-04）** — 起因：用户指出「spacelaunch 我是直接改 cos 里的就行了」，而 v4.0.73 的开关放在 `data/app-config.json`，会被 `sync-data.yml` 每次覆盖。
  - **`scripts/upload-data.js` 的 `UPLOAD_DENYLIST` 加 `app-config.json`**（现三条：`inbox_log.json` / `review_queue.json` / `app-config.json`）。这是让「直接改 COS」成立的关键：聚合 job 每 5 分钟就可能写 `data/*.json` 触发上传，若开关也在上传列表里，线上手改的值会被刷回仓库旧值。
  - **`utils/review.js` 的 `request()` 改走 `wx.request` GET `{config.data_base_url}/data/app-config.json`**，不再经 `datasource` 集合层。**同时兼容两种格式**：裸对象 `{"reviewVersions":[]}`（SpaceLaunch 写法，COS 上现在就是这种）与 `{version, items:[{_id:'app-config'}]}` 信封（取 `items` 里 `_id==='app-config'` 那条）。所以 COS 上直接手改不会因格式不符而失效。
  - **去掉了 `db` 参数**：`fetchOnce/loadRaw/refreshRemote/resolveConfig/getConfig` 都不再传 `db`，`getConfig(opts)` 只认 `{force}`。`app.js` 的 `refreshReviewMode()` 从 `isReview({db: this.mpServerless.db})` 改为 `isReview()`。
  - **COS 上手改的姿势**：控制台 → 桶 `maopu-1258113633`（地域 ap-guangzhou）→ `data/app-config.json` → 编辑 → 存。对象 `Cache-Control: max-age=60`，客户端还有 5 分钟内存/本地缓存，**最迟 5 分钟生效**。仓库里 `data/app-config.json` 只作留档。
  - `scripts/put-app-config.js`（新增，一次性用）：把 COS 上的开关对象改写成裸对象格式并打 `public-read` + `max-age=60`，从项目根 `.env` 读密钥。
  - 验证：65 例单测全过、`verify-demo-data.js` 70 项过 69（唯一失败是既有脏数据 `shooting_date=2026-02`）；实测 COS 回读 `{"reviewVersions": []}` 且 `Cache-Control: max-age=60`，CI 跑完后**未被覆盖**。
- **v4.0.73：审核态照搬 SpaceLaunch 的 `reviewVersions`（2026-11-04）** — 用户「把 spacelaunch 这套逻辑一模一样的弄过来」，v4.0.72 自创的 `normalVersions` 反转门禁已整体废弃。
  - **语义**：**`reviewVersions` 非空 = 审核中；空数组 = 正常期。** 与版本号对不对得上无关，它就是审核期总开关。
  - **判定口径（`applyVersionRule(raw, simulated)`）**：给了 `simulated` → 用它当版本号；否则 `envName()==='devtools'` → `review=false`；`reviewVersions` 不是数组 → 回落 `Boolean(cfg.review)`；空数组 → `false`；否则 `v = sim || runtimeVersion()`，`review = v ? list.indexOf(v) !== -1 : true`（**拿不到版本号 = 审核态**）。审核员跑 develop、`version` 恒为空 → 白名单非空时命中兜底。**请求失败一律按正常态兜底**。
  - **`utils/review.js` 必须 `const config = require("../config")` 而非 `import`** —— `tests/review.test.js` 直接 require 它。缓存三键：`appReviewConfig`（`{ts,data}` 只存原文，判定每次现算）、`appReviewResolved`（`{review,ts}` 给同步读者）、`appReviewConfigOverride`（本机覆盖）。
  - **本机覆盖暗门** `readOverride/setOverride`：`'4.0.73'` 模拟版本号 / `true` 强制审核态 / `false` 强制完整态 / `null` 清除。只影响本机 —— 这是开发者工具看审核态的唯一办法（devtools 永远放行）。
  - **审核态表现**：① `custom-tab-bar/index.wxml` 根节点 `wx:if="{{!review}}"`（整条不渲染）；② 其 `index.js` 的 `lifetimes.attached()` 三级回退（resolved → `getConfig()` 异步校正），量高度前 `review` 为真直接 return；③ `utils/page.js` 的 `showTab()` 用 `isReviewSync() ? 0 : (wx.getStorageSync('tabBarHeight') || 80)`（原 `|| 80` 会把 0 吞掉）；④ 首页隐藏 hero 看板入口与识猫入口；⑤ 详情页 4 个 UGC 入口 `wx:if='{{!reviewMode}}'`（便利贴数/申请领养/信息纠错/我要评分）+ 上传喵照靠 `canUpload`，5 个 UGC 页 `onLoad` 首行 `if (await blockInReview(tip)) return;` 防深链。
  - ⚠️ **`attached()` 量 tabBar 高度必须判 `rect && rect.height > 0`**：审核态量不到高度，0 写进 `tabBarHeight` 会让清除覆盖后底部占位永远是 0。
  - **暗门面板（首页 `genealogy.wxml` 末尾）**：连击「火大猫谱」5 次（`TAP_WINDOW=800`）→ **直接开面板不弹口令**；两行 `input` + 各自按钮（版本号+「模拟」、口令+「确定」）。**只有「去管理后台」要口令**（`data/gate.json` 的 code，当前 `0000`）。`.dbg-mask` z-index **8800**（口令弹层 9000）。
  - **关于页的连击/口令已整体删除**：`info.js` 只剩 `isUnlocked()`，`info.wxml` 的 `.title` 无事件、`<passcode-modal />` 已删。全站唯一挂载点是 `genealogy.wxml` 末尾。
  - 测试：`tests/review.test.js` 18 例，**单测合计 65 例**；`verify-demo-data.js` 段名「【审核期开关 / app-config】」4 项，**70 项**。
- **v4.0.71**：反馈链路打通（2026-11-03）
- **v4.0.70**：审核队列 UI 重排（2026-11-03）
- **v4.0.69**：审核队列白图的最后一层兜底（2026-11-03）
- **v4.0.68**：待审照片改用公开预览副本（2026-11-03）
- **v4.0.67**：小程序端审核能力恢复（2026-11-03）
- **v4.0.66**：去掉「操作手册」菜单（2026-11-03）
- **v4.0.65**：管理后台按「一个对象一个入口」重组（2026-11-03）
- **v4.0.64**：提交后自动返回，防重复提交（2026-11-03）
- **v4.0.63**：管理后台重构，删掉 19 个无用目录（2026-11-03）
- **v4.0.62**：口令全站只输一次（2026-11-03）
- **v4.0.56**：拍照识猫改接 MeowID 开放平台（2026-11-02，v4.0.58 已上线）
- **v4.0.53**：全量代码审计优化落地（2026-11-01）
- **v4.0.54**：五维评分雷达图（2026-11-02）
- **v4.0.55**：数据看板加「近半年趋势」+「成长时间轴」（2026-11-02）
- **更早的已上线条目（原文全在 `AGENTS-archive.md`，按节名查；这里只留当前仍生效的结论）**：
  - **v4.0.42 管理口令收敛为 `data/gate.json` 一处**：`process-inbox.js` 的 `currentGateCode()` 读 `data/gate.json` 的 `code`，`tokenOk()` = `currentGateCode() || REVIEW_PASSCODE || ''`；**`REVIEW_PASSCODE` 降级为兜底**，新部署完全不用配 secret；自测用 `SELFTEST_TOKEN`。改 gate code 一处同时决定「界面能不能进」和「提交能不能过」，口令不对仍是 `drop:bad-token` 静默丢弃。提交 `9d11c92`。
  - **v4.0.36 关于页按参考图重构**：只改 `info.wxml`/`info.wxss`/`config.js`（**`info.js` 一字未动**）；连击位置从 `.nav-title` 迁到 `.title`（「火大猫谱」），**必须 `catchtap` 不是 `bindtap`**（防冒泡）；`showCond[menu.show]` 在 wxml 里**必须是 2 处**（工具组 + 管理后台组，别合并）；**故意不加「清理缓存」行**——`info.js` 里 `this.clearCache()` 根本不存在，调用必报错，别去实现。提交 `090bb1b`。
  - **v4.0.35 公告管理独立入口 + 普通页零权限判断**：新建 `pages/manage/newsAdmin/`，公告写入改走 `putInbox('manage',{action:'manageNews',op:add|update|remove})` → `process-inbox.js` 的 `manageNews()`（**永不 throw**，`markTouched('news')`）；`detailNews` 退化为纯展示页（删「删除/修改」按钮，那曾是「公告谁都能改」的病根）；`passcode.js` 扩到 6 个导出（加 `UNLOCK_KEY/isUnlocked/setUnlocked`）；`isManagerAsync` 必须先判 `passcode.isUnlocked()`（否则 `remoteConfirmedEmpty` 分支让人人 manager=99）。⚠️ `MAX_OBJECT_BYTES` 从 4096 放宽到 `16384`（公告正文 + 9 图 URL 会顶破），`pending/*` 的 512KB 闸门不变。提交 `42556b6`。
  - **v4.0.34 连击 5 次 + 口令解锁**：口令**明文**存 `data/gate.json` 的 `code`（**废弃 SHA-256 哈希版**），`TAP_TO_UNLOCK=5`、`TAP_WINDOW=800`（超时重新计数，「连击」不是「累计」）；`loadGateCode()` **故意不缓存**，改完 gate.json 下次连击即生效；⚠️ `data/` 是公开 CDN → 口令等于公开，只是「别让普通用户误入」的 UX 门；`data/gate.json` 必须真传到 COS，否则「管理入口未启用」（`datasource` 对 404 有 10 分钟冷却）。提交 `34d1634` + `2908f0f`。
  - 其余：v5.4 主题色强化（`#0C5F03` 不改、大面积填充换 `#14801F`；`e9689bf` 的 commit message 没提它，**别再重复提交那 2 个文件**）｜v4.0.31 管理后台拆 `?tab=cat|photo|link`｜v4.0.30 友情链接可增删｜v4.0.30+32 提交后「延迟生效」提示（`utils/syncTip.js`）｜v4.0.29 四页标题 52rpx + tab 改名「猫片」｜v4.0.27「校区」→「位置」+ `_migrateConfigCache()`（抽屉**绝不能做成底部弹层**；开关一律 `wx:if`）｜v4.0.26 筛选抽屉三行胶囊 + 位置三分类 + 花色七类｜v4.0.24+25 首页 hero 数据卡（**必须 `catchtap`**）｜v4.0.23 用户档案体系整体放弃（每个提交场景当场填昵称）
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
- **详情页「+」悬浮弹窗已移除**（v4.0.15 移除，v4.0.16 起改为就地挂载）：`detailCat` 的 7 个操作不再集中成卡片，而是**逐个挂到页面本来就对应的位置**——便利贴数 count → `toComment`；粉丝量 count → `followCat`（已关注时 `.tap-on` 变绿）；档案卡（`icon-newspaper-o`）header 右上「猫咪信息纠错」→ `bindTapFeedback`；评分行右侧「我要评分」→ `bindRating`（与「展开详情」并列）；相册 `.big-header` 右侧 `.album-tools`（`上传喵照` `bindAddPhoto` 受 `canUpload` 控制；`分享喵ID` `showPoster` **v4.0.75 已删**）；领养状态 tag（`cat.adopt == 1`）→ 文案改成「{状态} · 申请领养」并 `bindtap="bindApplyAdoption"`。`showFunction`/`closeFunction`/`showFunc` 与 `.action-card/.action-grid/.action-item` 样式已彻底删除

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
4. 改完跑：单测 65 例 + `verify-demo-data.js` 70 项（真实数据不变量口径；一次就够，不要来回验）
5. 升 `config.js` 的 `app_version`，commit message 带版本号
6. 有持久价值的新结论 → 追加到本文件（不要写 `.workbuddy/memory/`）
