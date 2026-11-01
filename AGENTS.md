# MaoPu（火大猫谱）— 项目记忆

> DSH 每个新会话自动加载本文件。`.workbuddy/memory/` 是旧工具 WorkBuddy 的目录，**DSH 完全不读**，别再往那里写新记忆。

## 一句话定位

中山大学校园流浪猫谱系微信小程序「火大猫谱」，fork 自 `sysucats/zhongdamaopu`，品牌化为绿色 `#0C5F03`。
没有服务器、没有云开发：数据是 Git 仓库里的 `data/*.json`，同步到腾讯云 COS 当 CDN，小程序端拉 JSON 在内存里查询。

## 技术栈与目录

- 微信原生小程序，无框架。`miniprogramRoot: miniprogram/`，appid `wx5d52c6c8f098ed5e`，`libVersion: 2.24.7`，`nodeModules: false`
- 页面：`app.json` 注册 **30 页 + 分包 `pages/packageA` 1 页**（v4.0.17 删徽章 38→34；v4.0.23 删用户档案页 34→30）
- `miniprogram/utils/datasource.js`（1321 行）：自研的 mpserverless 兼容层，实现 `createJsonServerless({baseUrl})`
- `miniprogram/utils/writeback.js`：COS inbox 写入通道（客户端零密钥）
- `data/`：19 个 JSON，即"数据库"（删徽章三件套后从 22 降下来）
- `scripts/`：Actions 专用脚本，**独立 `package.json`**（只依赖 `cos-nodejs-sdk-v5 ^3.0.0`）
- `tests/`：`datasource` / `cache` / `process-inbox` 三个测试文件，共 **46 例**
- `.github/workflows/`：7 个（aggregate、bundle-size、process-inbox、review、set-inbox-policy、sync-assets、sync-data）
- `functionsEMAS/`、`initDatabase/`、`initStorage/`：上游遗留，EMAS 空间已删，**基本是死代码**

## 常用命令

**本机 node 不在 PATH**，用 HBuilderX 自带的 v22：
```bash
NODE="C:/Users/yzx49/Program/HBuilderX/plugins/node/node.exe"
```
- 单测（46 例）：`"$NODE" --test tests/datasource.test.js tests/cache.test.js tests/process-inbox.test.js`
  - **必须显式列文件**；`node --test tests/` 会把目录当单个测试文件跑并报 fail
  - 用 `plugins/node18/node.exe`（v18.20.0）会挂 1 例：`mock.timers.enable` 不支持 `Date` → `ERR_INVALID_ARG_VALUE`
- 数据端到端校验（65 项，真实数据不变量口径）：`"$NODE" scripts/verify-demo-data.js`
- 重新生成演示数据：`"$NODE" scripts/gen-demo-data.js [--dry-run]`（固定种子、幂等）
- 颜色硬编码 → token：`"$NODE" scripts/recolor-tokens.js [--dry-run]`
- inbox 聚合自测：`DRY_RUN=1 REVIEW_PASSCODE=xxx "$NODE" scripts/process-inbox.js`
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
`project.config.json` 有 **18 项**打包忽略。启用任何页面，**除了 `app.json` 注册，还必须从 ignore 名单移除**：
`pages/manage/photoManagement`、`pages/manage/medicalManage`、`pages/info/myFootprint`、`pages/info/myAchievement`、`pages/genealogy/applyMapAccess`、`pages/genealogy/detailCat/relationGraph`、`pages/tools/updateUserRole`、`pages/tools/inviteUser`、`pages/debug`、`pages/map`、`pages/manage/addCat`、`pages/manage/addRelations`、`pages/manage/managers`、`pages/manage/checkComment`、`pages/manage/rewards`、`components/achievementRank`、`images/markers`、`packages/tencentcloud`
- 反例：领养三页当年就是被 ignore 掉的"死代码"，注册后立刻编译失败

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
`app.json` **没有**全局设 `navigationStyle`，只有 7 页单独设 custom：`followFeed`、`gallery`、`detailCat`、`genealogy`、`info`、`news`、`leaderboard`。
这些页要调 `utils/nav.js` 的 `applyNav(page)`，否则内容被刘海/灵动岛遮住。新增自绘头部页面记得一起处理。

### 10. tabBar 有历史缓存别名
`custom-tab-bar/index.js:55`：`const alias = { leaderboard: 'gallery' }`，兼容客户端 7 天的 pageSetting 缓存。4 个 tab 键（v4.0.23 起）：`genealogy`(猫谱) / `gallery`(猫图) / `news`(猫抓板) / `info`(关于)。「喵友圈」`followFeed` 已从 `tab.js` 与 `data/setting.json` 的 `fullTab` 下线（页面本身仍在 `app.json` 注册，可被直接跳转）。图库 tab 文案由「图库」改为「猫图」，**v4.0.29 再改为「猫片」**（仅 `tab.js` 的 `text`；页面 `navigationBarTitleText`、分享标题、`config` 的 `share_tip` 仍是「猫图」）。
`custom-tab-bar/index.js` 另有 `RETIRED_TAB_KEYS = [followFeed, recognize, leaderboard, map]` 兜底：旧客户端缓存里的 `fullTab` 只要含这些已下线 key，就丢弃其顺序、改按 `tab.js` 的 `Object.keys` 重排（权限过滤照旧）。改 tab 结构时记得同步这个数组。
`pages/leaderboard/` 目录还在磁盘但**未在 `app.json` 注册**，是图库改造后的遗留死页。

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
- fork 仓库的 scheduled workflow 默认禁用，需在 Actions 页手动 Enable
- `concurrency.cancel-in-progress: false` 不能改成 true：上传中途被杀会留下传了一半的数据
- Actions secrets 只有 4 个 COS 变量 + `REVIEW_PASSCODE`；口令**不进小程序包**，客户端校验只管 UX

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
以 `miniprogram/config.js` 的 `app_version` 为准（当前 `v4.0.31`），commit message 末尾带版本号。
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

### 当前状态（2026-11-01）
- `config.demo_mode: false`、`writeback_enabled: true`、`photo_upload_enabled: **true**`（2026-11-01 改为匿名直传 COS，见"已知限制"）、`app_version: v4.0.31`
- **v5.4 主题色强化：首页 + tabBar 加大绿色面积与对比度（2026-11-01，未单独占版本号，代码已随 `e9689bf` 上库）**
  - **用户原始诉求（2026-11-01）：「主题色不够突出」**。澄清后用户拍板走 **「绿色存在感不够：不改色值，加大绿色面积和对比」**——`#0C5F03` 品牌色号**一个字都不许改**（呼应本文件「坑 7」）。手段只有三条：①加大绿色面积；②大面积填充改用**已存在**的亮绿 `--dk-accent-2: #14801F`；③提高对比度/阴影。
  - **只改了 2 个文件，都走「末尾追加覆盖块」范式，旧样式一行未回改**：`miniprogram/pages/genealogy/genealogy.wxss`（1201→1260 行，v5.4 块从 **第 1204 行**起）+ `miniprogram/custom-tab-bar/index.wxss`（66→84 行，v5.4 块从 **第 69 行**起）。**没碰 `app.wxss` token、没碰任何 js/wxml/json、没用 `!important`、没加图片**。
  - `genealogy.wxss` 的改动点：`.nav-k` 灰字→亮绿 700（`opacity:1`）；`#search .input-block` 边框 `--dk-accent-line` + `0 2rpx 12rpx rgba(12,95,3,.08)` 阴影；`#search .filter-btn.on` 白底→**亮绿实心** + `0 6rpx 16rpx rgba(20,128,31,.32)`；`.hero` 渐变 `rgba(20,128,31,.18→.06 52%→.02 78%)`、边框 `rgba(20,128,31,.20)`；`.hero-k::after` 短横线 **56×4rpx → 84×6rpx**；`.hero-link`（数据看板胶囊）**实心亮绿底 + 白字白箭头**；三格 `.hero-n` 全亮绿；`.row` 边框 `rgba(20,128,31,.14)`、`.row-adopt` 实心亮绿白字、`.row-bar`/`.row-bar-fill` 高 **10rpx** 填充 `linear-gradient(90deg, var(--dk-accent-2), #1FA34A)`；`.tips` 底 `rgba(20,128,31,.09)`；筛选抽屉 `.frow-k` 亮绿 700、`.fpill` 白底 + `rgba(20,128,31,.16)` 边、`.fpill.on` 亮绿实心 + `0 6rpx 18rpx rgba(20,128,31,.34)`、`.buttons .btn.active` 亮绿实心。
  - **hero 选中格的画法变了（重要）**：v4.0.25 的 `.hero-cell.on::after` **34×4rpx 短横线**在 v5.4 里用 `height:0; opacity:0; background-color:transparent` **归零**（⚠️ 没用 `display`，规避 v4.0.27 记的 `hidden` 被 `display` 顶掉那个坑），改成**整格浅绿胶囊底** `rgba(20,128,31,.12)` + `border-radius:18rpx` + `padding:10rpx 0 12rpx`，格内数字/标签回 `--dk-accent` 加粗。以后再加回短横线要同时放开这三条归零规则。
  - `custom-tab-bar/index.wxss`：`.tab-bar-item.active::before` 画**整块浅绿胶囊底** `rgba(20,128,31,.12)`（left/right 8rpx、top/bottom 10rpx、`border-radius:999rpx`），图标与文字 `z-index:1` 压在上面；`.tab-bar-item.active .tab-bar-title` 由旧 `#0C5F03` 覆盖为 `#14801F` + 700。
  - **对比度依据（已算过，别再重算）**：`#0C5F03` 对白 7.26:1、白字反色 7.91:1；`#14801F` 对白 4.66:1、白字反色 5.08:1 —— 两者都过 WCAG AA 4.5:1，所以**大面积填充换亮绿是安全的**，深绿留给小字号文字。
  - 自检口径：花括号平衡 `{197/}197`（genealogy）、`{12/}12`（tabbar）；`var(--color-var(` / `paper-var(` / `!important` 残留 **0**；`git diff -- miniprogram/app.wxss` **空**；全文件只出现 `#0C5F03`/`#14801F`/`#1FA34A`/`rgba(12,95,3,x)`/`rgba(20,128,31,x)`。
  - 行尾：`genealogy.wxss` 是 **CRLF**（与 HEAD 一致），`custom-tab-bar/index.wxss` 原本 LF、保持 LF。
  - ⚠️ **`e9689bf` 的 commit message 没提主题色强化**（并行会话 `git add -A` 顺带扫进去的），但代码确实在里面：`grep -n 'v5.4'` 在 `genealogy.wxss:1204`、`custom-tab-bar/index.wxss:69` 都能查到。**别再重复提交这两个文件。**
  - 改前/改后可视图：`C:/Users/yzx49/tmp/maopu-preview/compare.png`（1800×1116，DPR=2）+ 同目录自包含 `compare.html`。截图用无头 Edge：`msedge.exe --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=900,558 --screenshot=... file:///...`（900×558 是刚好不裁 tabBar 的窗口尺寸）。
- **v4.0.31：管理后台拆成三个独立入口（去掉页内 tab）**
  - **用户要求（2026-11-01）「不单独做管理后台按钮，把功能直接加在现有的管理后台列表里」，并补充「入口和审核队列并列，猫资料编辑 / 照片审核 / 友情链接三个都拿出来」**。→ 「关于 → 管理后台」网格里的单独「管理后台」项**已删除**，换成三项并排：`猫资料编辑`（`icon-edit`）/ `照片审核`（`icon-photo-o`）/ `友情链接`（`icon-cluster-o`），紧跟在「审核队列」后面。原来的「照片审核」项原本 `disabled: true` 指向未注册死页 `pages/manage/checkPhotos`，现已换成能跑的管理页。
  - **同一个页面复用三种形态**：`pages/manage/admin/admin` 靠 query `?tab=cat|photo|link` 决定显示哪一块；`onLoad(options)` 里 `const tab = TAB_META[(options && options.tab) || ""] ? options.tab : "cat";` 兜底（`TAB_META = {cat:"猫资料编辑", photo:"照片审核", link:"友情链接"}`），**同时 `wx.setNavigationBarTitle({title: TAB_META[tab]})`**，页内标题与口令门标题都改成 `{{pageTitle}}`。**页面内已没有 tab 栏**：`admin.wxml` 的 `.tabs` 块、`admin.js` 的 `switchTab()`、`admin.wxss` 的 `.tabs/.tab/.tab-active` 三组样式全部删除（当前残留检查为 0）。
  - **首次加载改为 `afterUnlock()`**：`if (tab === "link") loadLinks(); else loadCats();`。`unlock()` 里原来写死的 `this.loadCats()` 改为调 `afterUnlock()`——否则从「友情链接」入口进来解锁后猫列表白拉一次、链接反而不加载。照片 tab 仍需用户先选猫再 `loadPhotos(idx)`，不做自动加载。
  - **`info.js` 的 `clickbtn`** 只做 `wx.navigateTo({url: to})`，query 参数原样透传，无需改跳转逻辑。⚠️ 该函数有 `actionMap`（`clearCache`/`guide`）优先匹配，路径里带 `?` 不会影响匹配。
- **v4.0.30：友情链接改为可手动增删（管理后台入口）**
  - 入口在 `pages/manage/admin/admin`（原有口令门内），tab 从 `cat | photo` 扩成 **`cat | photo | link`**。数据仍存在 `data/setting.json` 的 `_id='friendLink'` 记录里，schema 不变：`{_id:'friendLink', apps:[{appid, name, logo}]}`。
  - **写入链路**：客户端 `saveLinks()` → `putInbox('manage', {action:'saveFriendLinks', token:this.getToken(), apps})` → `scripts/process-inbox.js` 的 `handleManage` 新分支 `manageSaveFriendLinks(data)`；服务端 `tokenOk()` 校验 `REVIEW_PASSCODE`，整体**替换** `apps` 数组（不是增量），`markTouched('setting')` 让 `data/setting.json` 被写回并随 `sync-data.yml` 上 COS。客户端 `datasource` 的 updateOne **不能用来改这里**——它只写本地覆盖层，不回传远端。
  - **服务端校验（`normalizeFriendApp`）**：`APPID_RE = /^wx[0-9a-zA-Z]{16}$/`、`name` 非空且 ≤20 字、`logo` ≤300 字符且可空、按 appid 去重、上限 `FRIEND_LINK_MAX = 20`。失败返回 `drop:no-apps` / `drop:bad-friend-app` / `drop:too-many-links`；成功 `ok:friend-links`。
  - **admin 页新增**：`data.links/linkLoading/linkSaving/linkDirty/draft{appid,name,logo}`；方法 `loadLinks()`（`linkDirty` 时不覆盖，避免冲掉未保存编辑）、`onDraftInput`、`addLink`（同样的正则与去重前校验，纯本地）、`deleteLink`（`wx.showModal` 二次确认）、`moveLink`（↑↓ 调序）、`saveLinks`。`switchTab` 切到 link 时才懒加载。
  - **展示端改了缓存策略**：`pages/info/info.js` 把原来写在 `onLoad` 里的 friendLink 查询抽成 `loadFriendLinks()`，`onShow` 调用，5 分钟节流（`this.jsData.linkFetchedAt`）——否则改完后台要重进小程序才看得到。`info.wxml` 整块包 `wx:if="{{friendApps.length}}"`（空列表不再显示空标题），无 logo 时用首字占位 `.friend-link-ph`。
  - `data/setting.json` **没有本地改动**，线上靠 Actions 聚合写回；自测用 `DRY_RUN=1 REVIEW_PASSCODE=xxx node scripts/process-inbox.js`，`selftestObjects()` 里已有 offset 21（合法）/22（非法 appid）两条 manage 用例，`snapshot()` 会打印 `friendLinks` 名称数组。
- **v4.0.30：提交后「延迟生效」提示（用户需求：数据/照片走 Actions，小程序不能实时显示）**
  - **根因三段延迟**：① `utils/writeback.js:75` `putInbox(kind, data)` 匿名 PUT 到 COS `inbox/`，`WRITEBACK_TIMEOUT = 8000`，**永远不 reject**，失败只 `console.warn` 返回 false；② `process-inbox.yml` cron `*/5 * * * *` 聚合成 `data/*.json`，`sync-data.yml` 再推 COS；③ `datasource` SWR 的 `CACHE_TTL` 10 分钟。→ 提交后只有当前页乐观更新，重进页面/他人最长等 5~15 分钟，照片留言还要人工审核。旧文案（`'张贴成功~'` / `'提交成功'` / `'审核后就会展示出来啦'`）让用户以为失败而反复提交。
  - **新增 `miniprogram/utils/syncTip.js`（157 行，唯一新增文件）**：`module.exports = { markPending, getPending, getPendingCount, clearPending, submittedModal, pendingText }`。`STORAGE_KEY = "pending_sync"`、`MAX_ITEMS = 20`、`TTL = 2*60*60*1000`；存 `[{kind, cat_id, label, ts}]`，**同 kind+cat_id 覆盖 ts 不重复追加**，读时清理过期并写回。**所有函数同步、异常全吞、绝不 throw**，不影响提交主流程。`submittedModal(content, title)` 是对 `wx.showModal` 的封装（`showCancel:false`、`confirmText:"知道了"`）。
  - **`config.js:120-132` 新增 `text.sync` 七键**：`submitted_title:"已提交"`、`delay_tip:"后台会在几分钟内自动汇总，稍后刷新就能看到"`、`review_tip:"照片和留言需要审核通过后才会展示"`、`offline_tip:"网络不太好，这次可能没提交成功"`、`pending_title:"等待同步"`、`pending_tip:"你还有 {n} 条内容正在等待同步 · 约 5~15 分钟后生效"`、`pending_close:"关闭提示"`。
  - **六个提交点接入**：`addPhoto.js:148-153`（单张）/`:197-202`（批量）、`commentBoard.js:318` + toast `'已提交，审核后展示'`、`ratingDetail.js:178` + toast `'已提交，稍后自动汇总'`、`feedbackDetail.js:155` + toast `'已收到，审核后展示'`、`admin.js` 的 submitToast、`review.js` 的 decide（`'已通过/已拒绝，后台几分钟内汇总生效'`）。`addPhoto.uploadImg` 改为 **`return !!ok`**，单张/批量按 ok 分支：成功 → `delay_tip + "\n" + review_tip`，失败（含任一张网络失败）→ `offline_tip`。⚠️ 这是**行为收敛**：旧 `uploadAllClick` 无论成败都弹成功，属修 bug。
  - **detailCat 顶部可关闭提示条**（这是用户能持续看到的唯一入口）：`detailCat.js:30` import，`:99-101` 三个 data 字段 `pendingCount / pendingText / syncTipHidden`，`onShow`（`:168-181`）读 `getPendingCount(this.jsData.cat_id)` 并 `pendingText(n)`，try/catch 包裹；`:184-186` `dismissSyncTip()` **只 setData 隐藏，不清本机记录**。`detailCat.wxml:18-24` 用 **`wx:if="{{pendingCount > 0 && !syncTipHidden}}"`**（不是 `hidden`，避开 v4.0.27 记的那个坑），右侧 `×`。`detailCat.wxss:1046-1083` 的 `.sync-tip` 系列用 `--dk-accent-soft` 底 / `--dk-accent-line` 边 / 20rpx 圆角 / margin 24rpx。
  - **刻意不做的**：detailCat 的点赞/关注不弹窗、不 markPending（交互太频繁）；没新增页面，没碰 `app.json` / `project.config.json` / `app.wxss` token。
- **v4.0.29：四页标题字号统一 + tab 改名「猫片」+ 猫抓板两篇示例**
  - **标题字号**：猫谱页 `.nav-t` 在 v5.2 精修里被放大到 **52rpx**（`genealogy.wxss:1144`），而猫抓板/关于页仍用 `app.wxss:345` 的全局 `.nav-title` **46rpx** → 三页标题大小不一。修法是在 `news.wxss`、`info.wxss` **各自尾部追加 `.nav-title` 覆盖**（52rpx / line-height 56rpx / 800 / letter-spacing -1.6rpx / margin-top 10rpx），**不动 `app.wxss`**。猫图页没有大标题（全屏漂流墙，顶部只有 `.hud-kicker` 22rpx 的「CAT GALLERY」标识），属刻意设计，不要强行补。
  - **tabBar 文案「猫图」→「猫片」**：只改 `custom-tab-bar/tab.js:12` 的 `text`。`gallery.json` 的 `navigationBarTitleText`、`gallery.js:94` 分享标题、`config.js` 的 `share_tip: "猫图墙"`、`catInfoTab`/`addCat` 的「加载更多猫图」**全部保持「猫图」不动**（用户只要求改 tab 文案，别顺手全局替换）。
  - **猫抓板两篇示例新闻**（`data/news.json` 空表 → 2 条）：`news-xiaobai-northgate`（小白出没｜北门花坛的独行侠，class=其他，cover=小白 001，photosPath 3 张，`setNewsModal: true` 会推首页弹窗）、`news-feed-guide`（投喂指南｜别让好心办坏事，class=活动，cover=奶盖 001，photosPath 4 张，`setNewsModal: false`）。⚠️ **`coverPath`/`photosPath` 必须写完整 COS URL**——`signCosUrl` 是直通函数、`datasource._merged` 不拼前缀，写 `photos/xxx.jpg` 这种相对路径会 404（旧 demo 数据就是错的，别照抄）。
- **v4.0.27：全站「校区」文案改「位置」+ 配置缓存版本失效 + 抽屉骨架回退原版**
  - **抽屉骨架必须沿用原版**（用户三次纠正："抽屉还是和原来一样，下拉，只改里面的三行，你在乱动什么"；v5.3 曾把它改成底部弹层，用户截图骂"我说了筛选要做成向下摊开的抽屉"）：`#filter-block` 用 `style='height: {{heights.windowHeight - heights.filters}}px'` + 半透明黑遮罩，内容**贴顶**（`display:flex; flex-direction:column; justify-content:flex-start;`），`.fsheet` 是**向下摊开**的卡片（`border-radius: 0 0 36rpx 36rpx`，阴影朝下，可加 `@keyframes sheetDown` 从上滑落），内部依次 `.filters`（三行胶囊）/ `.divider` / `.buttons`（左「重 置」`fRowReset`、右「完 成」`fHide`，`filters_legal` 时右侧变主色）。**绝不能再做成 `justify-content:flex-end` + `border-radius:36rpx 36rpx 0 0` 的底部弹层**，也不要自创 `.fpanel` / `.fbar-head` / 绿色 `.fbar-done`，这几套都已被明确否掉。
  - ⚠️ **`hidden` 属性会被 CSS `display` 覆盖**（2026-11-01 踩坑，表现是"编译完抽屉就自己开着、关不掉、页面像卡住"）：`hidden` 只是 UA 的 `[hidden]{display:none}`，作者样式 `#filter-block{display:flex}`（id 选择器优先级更高）直接把它顶掉，`filters_show` 一直是 false 但抽屉常显。修复：开关一律用 **`wx:if='{{filters_show}}'`**，不要用 `hidden`。（同理，别给可能被 hidden 的元素写 `display:flex/block` 除非配 `[hidden]{display:none!important}`。）
  - `.frow-k` 行标签宽度必须 ≥ 80rpx 且 `white-space: nowrap`：v5.3 写的 `width:44rpx` 装不下「位置/花色/状态」两个字，被压成竖排并裁掉半个字。
  - **全站「校区」→「位置」**：`miniprogram/` 下 20 个文件、36 处文案已批量替换（`catInfoTab`、`addCat`、`checkComment`、`checkPhotos`、`dashboard`「位置分布」、`filters`「位置选项/新增位置」、`managers` 权限说明、`map`、`recognize`「所有位置」、`info`「位置/区域/花色」、`utils/cache.js` 注释）。`data/news.json` 的「我们在南校园设置了 6 个保暖猫窝」改为「我们在校园里设置了」，`miniprogram/utils/demo.js` 的 MOCK_CATS 11 条 `campus` 与 `MOCK_SETTINGS.filter` 同步改成校内/校外/其它。**复查 `grep -rn 校区 miniprogram/ --include=*.js --include=*.wxml --include=*.json` 必须为 0**。
  - **猫卡位置拼接要留空格**：`campus` 从「南校园」变「校内」后，`campus + area` 会粘成「校内北门花坛」，两处已改成 `campus + ' ' + area`（`genealogy.wxml:106`、`detailCat.wxml:82`）。
  - **配置缓存的版本失效机制（本次踩坑的根因）**：`utils/page.js` 的 `_getSetting` 用 `cacheTime.pageSetting = 24*7` 小时写 storage，**发版改 campus/colour/fullTab 后老用户最长 7 天看不到新值**——这就是用户真机上仍显示「南校园」的原因。两处修复：① `loadFilter()` / `getGlobalSettings()` 默认强制 `nocache: true`（只借 datasource 的 10 分钟 SWR 缓存），且 nocache 时**不落盘**；② `app.js` 新增 `_migrateConfigCache()`，在 `checkCacheValidity()` 开头用 `app_version` 当哨兵，版本变化就删掉 `setting-*` / `ds_cache_setting` / `genealogy-fcampus` 三类键（猫数据缓存不动，避免断网空列表）。⚠️ `tests/cache.test.js` 里直接种 storage 的用例**不带 epoch 字段**，所以 `cache.js` 内部**不能**加版本字段校验，哨兵只能放在 `app.js` 这层，否则挂 2 例。

- **筛选抽屉改三行胶囊 + 位置三分类 + 花色精简（v4.0.26）**：首页导航栏右侧保留原筛选按钮（`<view class='filter-btn' bindtap='fToggle'>`，`filters_active` 时换 `filter_y.png`），点开的**抽屉里**改成用户给的三行样板（顶部 `{{catsMax}} 只猫猫` + 右侧「重置」，三行胶囊，每行首颗「全部」高亮，底部绿色「完成」）。
  - ⚠️ 曾误把三行做成常驻栏并删掉筛选按钮，被用户否掉（"保留筛选按钮啊，只是弹出来的抽屉做成这三行"）——筛选按钮必须在，三行只在抽屉里。
  - 数据模型从"两级 category 联选"改成**每行一维 options**：`filters = [{key, name, all_active, options:[{name, cond, active, count}]}]`，三行依次 `campus`(位置) / `colour`(花色) / `state`(状态)。`loadFilters()` 在 `genealogy.js:249-308` 重建。
  - 第三行「状态」7 个值（用户定的）：已领养 `{adopt:1}` / 寻找领养中 `{adopt:2}` / 待绝育 `{sterilized:false}` / 已绝育 `{sterilized:true}` / 未失踪 `{missing:false}` / 已失踪 `{missing:true}` / 去往喵星 `{to_star:true}`。**状态互斥**，`_rowConditions()` 里多选要包成 `{$or: [...]}`，不能像位置/花色那样用 `$in`（那三个 cat 字段是数组/字符串单值）。
  - 关键函数：`fCheckLegal` / `_rowConditions` / `_conditionsOf(filters, skipRowIndex, onlyIndex)` / `fGet` / `updateCounts`（每颗胶囊按"其他行条件 + 本行该选项"算 count）/ `applyFilters` / `fRowAll` / `fRowOpt` / `fRowReset` / `_nextHeroMode`。旧的两级联选函数（`fShow`/`fClickMain`/`fClickCategory`/`fClickSub`/`fComfirm`/`fReset`/`fClickCampus`）已全部删除。
  - `hero_mode` 联动：`_nextHeroMode(filters)` = 所有行都 `all_active` 时回 `''`（第一格高亮），否则 `'custom'`；`heroFilter()` 也已改写到新模型（点「待领养」= 把 state 行的「寻找领养中」置 active）。
  - **位置 = 校内 / 校外 / 其它**（原只有「南校园」一个校区值）：`cat.campus` 按 area 映射重写（北门花坛/法学院边草坪/荣光堂/图书馆广场/英东体育场/园东湖/逸夫楼→校内；第一教学楼/怀士堂→校外；东门/惺亭→其它）。`data/filter.json` 与 **`data/setting.json` 内嵌的那份 `_id='filter'`** 都要改——`utils/page.js:27` 的 `loadFilter()` 读的是后者，`filter.json` 只是历史副本。
  - **花色精简为 7 类**（用户给清单）：橘色 / 黑色 / 白色 / 狸花 / 三花 / 玳瑁 / 重点色。映射：橘、橘白→橘色；黑、奶牛、黑白、黑灰→黑色；白→白色；狸花、彩狸、狸白、棕→狸花；其余直通。同步改了 `data/cat.json`、`data/setting.json`、`data/filter.json`、`miniprogram/utils/demo.js` 的 MOCK_CATS。
  - 首页每页条数 `pages.genealogy.catsStep` 由 3 改为 **10**（`data/setting.json`）；代码默认值仍是 12，以远端配置为准。
- **COS 上传踩坑（2026-11-01 定位，务必按此操作）**：`C:\Users\yzx49\tmp\cosprobe\putpub.js` 的 `put(key, body, acl)` 实测可用，但**必须用 `node -e` 内联调用**（`require('./putpub').put('/data/x.json', fs.readFileSync(...), 'public-read')`）。走命令行 `node putpub.js <key> <file> public-read` 会稳定返回 **nginx 400 Bad Request**（`<html>…<center>400 Bad Request</center>…nginx`），**即使 key 已带前导斜杠**，成因未明（与 shell 传参/编码有关），别再在这上面耗时间。`cos.js` 的 `request('PUT', '/path', {}, body)` 可写但**不能带 ACL**（会变私有）。上传后必须 `curl -s -o /dev/null -w "%{http_code}"` 验证匿名 200。
- **首页 hero 数据卡：三格指标 + 点击筛选（v4.0.25）**：`pages/genealogy/genealogy.wxml` 的 `.hero-row` 三格改为 **在册 / 待领养 / 本月新增**（原「在册猫猫 / 待领养 / 当前结果」），每格 `catchtap='heroFilter' data-type='all'|'adopt'|'new'`（**必须 catchtap，bindtap 会冒泡触发整卡 `toDashboard` 跳看板**）。
  - `genealogy.js` 状态机 `hero_mode: '' | 'all' | 'adopt' | 'new' | 'custom'`：`''`=初始全部态（第一格高亮）、`heroFilter` 按 type 重设 filters 后 `reloadCats()`、`fGet()` 在 `hero_mode==='new'` 时 push `{ create_time: { $gte: this.getMonthStartISO() } }`、`fReset` 回 `''`、`fComfirm` 手动筛选后置 `'custom'`（三格都不高亮）。
  - 计数：`countTotalCats()` 的 `count({})`→`total_count`、`countNewCats()`→`new_count`、原 `countWaitingAdopt()`→`adopt_count`；三者并入 `reloadCats()` 的 `Promise.all`（现 5 项）。`getMonthStartISO()` = `new Date(now.getFullYear(), now.getMonth(), 1).toISOString()`（本地时区本月 1 日）。
  - 选中态样式在 `genealogy.wxss` 末尾：`.hero-cell.on .hero-n`/`.hero-cell.on .hero-k2` 变 `--dk-accent`，`.hero-cell.on::after` 画 34rpx×4rpx 圆角短横线（`:first-child` 左对齐）。
  - **右下角漂浮「找领养」按钮已整块删除**：wxml 的 `#find-adopt`、`.adopt-filter-tip`；wxss 的 `#find-adopt*`、`.adopt-filter-tip*`（含深色化块）、`.shake` + `@keyframes upAnimation`；js 的 `clickAdoptBtn()` / `showFilterTip()` / `newUserTip()` 与 `const tipInterval`、`onLoad` 里的 `this.newUserTip()`；`config.js` 的 `text.genealogy.filter_tip` 与 `adopt_btn`。`#back-to-firstpage` 保留。
  - 实测（本地 `data/cat.json`）：在册 11 / 待领养 2（小白 demo-cat-4、汤圆 demo-cat-10）/ 本月新增 0（猫的 `create_time` 都在 2026-05~10）。`_compareValues` 对 ISO 字符串按字典序比较等价于时间序，所以 `$gte` 直接比字符串即可。
- **数据看板已从管理后台提到首页入口（v4.0.24）**：`pages/genealogy/genealogy.wxml` 顶部的**整张 hero 数据卡**改成 `bindtap='toDashboard'`，卡内 `.hero-head` 一行放左侧 `.hero-k` 标题 + 右侧 `.hero-link`（「数据看板 ›」绿色胶囊，静态胶囊不是独立按钮，跟着整卡一起点）。`genealogy.js` 新增 `toDashboard()` → `wx.navigateTo({url: "/pages/manage/dashboard/dashboard"})`；样式 `.hero-head`(flex space-between，`align-items: flex-start`)、`.hero-link`(999rpx 圆角、`--dk-accent-soft` 底 + `--dk-accent-line` 边)、`.hero-link-t`、`.hero-link-arrow` 加在 `.hero-k` 之后。同时从 `pages/info/info.js` 的 `menuList` 管理后台分组里删掉原本的「数据看板」项（`icon-bar-chart-o`）。
  - ⚠️ 早期方案（已废弃）是在 `.nav-row` 右侧加 `.nav-dash` 独立胶囊，用户看图后否掉了，改成整卡点击。`nav-dash` 相关 wxml/wxss 已全部清除（残留检查为 0）。
  - `--dk-soft` 不是有效 token（有效的是 `--dk-accent-soft` / `--dk-accent-line`），别再误用。
  - dashboard 页面本身**没有任何管理员校验**（`dashboard.json` 只有 popup 组件，`dashboard.js` 无 `isManager`），所以放宽到首页后普通用户可直接看，数据全部来自 `datasource._getCatStats()` 本地重算，不额外消耗流量。
  - 注意 `.hero-k::after` 那条绿色短横线是首页 hero 卡专属，别复用到别处。
- **用户档案体系已整体放弃（v4.0.23）**：根因是 `utils/datasource.js:27` 的 `OPENID_STORAGE_KEY = 'fake_openid'` + `_getOrCreateOpenid()`（`:1229-1237`）生成 `guest_xxxxxxxx` 存本地，**与微信账号完全无关**，换设备/清缓存/重装就是新人；而 `data/user.json` 从没有 nickname 字段、`scripts/process-inbox.js` 里一次 `loadData('user')` 都没有，用户昵称压根不上传。要做真跨设备只能接 `wx.login` → 服务端 code2session，和「月成本 ≤5 元、不引服务器」的红线冲突 → 用户拍板：**不做档案，每个提交场景当场自己填昵称，不填就是匿名用户**。
  - 删掉的 4 个页面（共 20 文件）：`pages/info/userInfo/`（个人主页，含子目录 `modifyUserInfo/`）、`pages/info/myFollowCats/`、`pages/info/myAdoption/`、`pages/info/feedback/myFeedback/`。连带 `app.json` 34→30 页、`packOptions.ignore` 19→18 项、`info.js` 的 `data.cards` 5→2（只剩投喂罐头 / 程序开发）、`info/feedback/feedback.js` 的 `toMyFeedback()`、`utils/user.js` 的 `toSetUserInfo()`、`utils/msg.js:130` 订阅消息跳转页改 `pages/info/info`。
  - **`components/modifyUserInfo/` 整目录已删除**，全仓 0 引用。v4.0.19–v4.0.21 那套「json 注册组件 + 点此设置头像昵称」的旧范式**已作废，别再照着抄**。
  - 就地填昵称范式（5 页统一）：`data.nickname: ''` → `onShow`/`onLoad` 用 `wx.getStorageSync('last_nickname') || ''` 预填 → `<input>` 就地输入（`maxlength=20`）→ 提交前 `wx.setStorageSync('last_nickname', this.data.nickname)` → 空值一律兜底 `'匿名猫友'`。落地位置：`commentBoard`（悬浮输入区顶部，textarea 上方）、`feedbackDetail`（表单最上方，标题「正在为「猫名」反馈信息」下；`.adminEntry` 管理员「添加猫际关系」入口保留不动）、`modifyNews`（表单第一项）、`addPhoto`（删掉 `!isAuth` 等待授权层，上传表单常显，只留「正在为「猫名」添加照片」提示；摄影师仍走原有 `inputPher`，匿名直传 COS 链路一字未动）、`ratingDetail`（**不加**昵称框，评分本就匿名；`putInbox('rating', {cat_id, score, dims})` 保持无 nickname 字段，否则会破坏 `process-inbox.js` 的聚合 schema）。
  - 昵称只在本机记忆（`last_nickname`），换设备自然丢失——这是已接受的取舍，别再提"恢复码/微信登录"方案。
  - 遗留死代码（不影响运行）：`components/photoRank/` 仍留着 `bindtap='getUInfo'` 与 `setData({showEdit:true})`，但该组件只被未注册死页 `pages/leaderboard` 引用且组件已无从打开；`utils/user.js` 的 `getPageUserInfo()` 也还在，现存调用点只剩 `applyMapAccess.js:34`（ignore 死页）与 `photoRank.js:31`（上述死组件）。以后新增页面用 `getUser()`，别调 `getPageUserInfo`（它在无 `userInfo` 时直接 `return false`，不设 `isAuth`/`user`，会让 `wx:else` 分支永不渲染 = 空白页）。
- 数据源：`https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com`，微信后台已加 request 合法域名
- **2026-11-01 起 `data/` 已是真实数据（演示数据全清）**：`cat` **21 只真猫**、`photo` **278 张**，`comment`/`rating`/`feedback`/`news`/`adoption`/`inter`/`achievement`/`reward`/`photo_rank`/`inbox_log`/`review_queue`/`user` **共 12 张表已清空为 `items: []`**。旧的 demo 数据备份在 `C:/Users/yzx49/tmp/catid/data-bak-demo/`（仓库外），要回滚从那里取。
  - `cat._id` = `cat-<拼音>`（如 `cat-naigai`），`campus` = 校外/其它/校内，`area` 全为 `""`，`colour` 是看代表图人工判的（**未经用户确认，可能要改**），`rating` 全零对象、`photo_count_total` = 真实张数、`mphoto` 从 2026-10-01 起每猫 +1 天。
  - `photo._id` = `photo-<拼音>-<nnn>`，三个 URL 同源指向 `catimg/<area-slug>/<cat-slug>/<nnn>.<ext>`；`best` 只给每猫第 1 张；`shooting_date` 只有 **8 张** 有 EXIF 真日期，其余兜底 `2026-01-01`（278 个文件 mtime 全是同一天，无法区分）。
  - `user` 表清空后，`datasource._userOp('get')` 的 `remoteConfirmedEmpty` 分支生效：**首个访客自动拿 `manager=99`**（这是原有语义，不是 bug）。
  - 猫的 `birthday` / `gender` / `area` **全部是空串**（真实数据里没有这些信息）。详情页靠 `wx:if` 隐藏，不会显示空行；「拍摄时约 X 月龄」在没有生日时不出现。
  - ⚠️ **`area` 为空是刻意设计，别再按「campus && area」判位置**：位置只到「区域」这一级。展示的地方一律写成 `cat.area ? cat.campus + ' ' + cat.area : cat.campus`（`genealogy.wxml:106`、`detailCat.wxml:82`、`catInfoTab.wxml:29`、`addCat.wxml:8`），保存校验只校验 `campus`（`catInfoTab.js` 的 `saveCat` 与 `addCat.js` 的 `upload`）。旧代码用 `&&` 判存在会让详情页显示 `-`、编辑猫存不进去。
  - 筛选 picker 的第二列（细分地点）在 `filter.area` 为空时会是空数组 → 两个 `loadPickers()` 都补了 `if (!area_category[campus].length) area_category[campus] = [''];` 占位，否则多列 picker 越界。
  - `data/setting.json` 内嵌的 `_id='filter'` 与 `data/filter.json` **已同步**（2026-11-01，脚本 `C:/Users/yzx49/tmp/catid/sync_setting_filter.py`）。以后改花色/位置仍要两处一起改：`loadFilter()`（`utils/page.js:27`）读的是 setting。当前 `colour` = 橘色/黑色/白色/狸花/三花/玳瑁/重点色，`campuses` = 校内/校外/其它，`area` = `[]`。
  - ✅ 数据校验脚本已改成真实数据口径（2026-11-01）：`scripts/verify-demo-data.js` 从「demo 断言 50 项」改为 **65 项不变量**（引用完整、`photo_count_*` 与实况自洽、每猫最多 1 张 best、`shooting_date` 合法且不早于生日、`colour`/`campus` 必须落在 `filter` 枚举内、`photo_compressed` 必须是 `catimg/<拼音>/<拼音>/<3位序号>.<ext>`、12 张空表查询不抛异常…）。**文件名沿用旧名**，别再改成 verify-real-data.js。
  - ⚠️ **本地改了 `data/` 不会自动上 COS**：要 push `cos` 触发 `sync-data.yml`。2026-11-01 14:12 复查：远端 `data/photo.json` 已是修正后的 11 条、无非法日期，说明 `sync-data.yml` 已跑通。
  - COS 上曾出现过一条 `relink-photo-1`（指向 `photos/demo-cat-12/0001.jpg`，猫 `demo-cat-12 奶盖`），是误把 `photos/demo-cat-1/cover.jpg` 复制过来当新照片的假数据。**2026-11-01 已彻底清除**（远端只剩 11 条 photo、11 只 cat，孤儿对象 `photos/demo-cat-12/0001.jpg` 已删）。
- 其余演示规模：comment 48 / rating 48 / user 9 / news 8 …
- UI 已全站统一白底大圆角（v5.2），图库是横向漂流墙（8 行宽窄交替 marquee）
- 审核/管理走口令门（本地 storage `manage_passcode` 24h），真正校验在 `process-inbox.js` 的 `REVIEW_PASSCODE`
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
- 一批已注册但写操作静默 no-op 的页面：`catManage` / `checkPhotos` / `replyFeedback`
- 遗留死代码：`news.js:149 clickScience()` 跳 `/pages/science/science`（页面不存在，wxml 未绑定不触发）；`pages/leaderboard/` 整目录
- 首页封面/榜单/地图的照片查询**没有**过滤 `hidden`（只有 `detailCat` 相册过滤了），下架照片仍可能在其他位置露出
- `--color-comment-paper-white` 这类被误伤的命名残留已还原，但 `packages/weui/weui-wxss/dist/style/weui.wxss` 也曾被批量替换过（等价改动，未回滚）

## 照片归属重建工具（2026-11-01 建）

背景：桶里 `compressed/` 298 张真实猫照私有读且猫↔照片归属随 EMAS 空间删除永久丢失，靠人肉眼认照片重建映射。三步：

1. **`scripts/relink-scan.js`**（本地跑，需密钥）：`getBucket` 列 `compressed/` 前缀图片 → `putObjectCopy` 到 `photos/relink/001.jpg`（public-read）→ 生成项目根 `relink-workbench.html`（内联 11 只猫 + 照片 URL 数组）。**先复制第 1 张验证 CopySource 编码，失败打印原始错误中止**；`CopySource` 按 `/` 分段 `encodeURIComponent`，报 NoSuchKey 回退整 key 编码。`DRY_RUN=1` 用现有 11 张 cover.jpg 生成演示 html。
2. **`relink-workbench.html`**（用户认猫，零密钥）：自包含单文件，CSS columns 瀑布流，点卡片弹猫名按钮组 +「跳过(不是猫)」，进度存 localStorage（key `relink-workbench-v1`），导出 `relink-result.json`。
3. **`scripts/relink-apply.js`**（本地跑，需密钥）：读 `relink-result.json`（结构 `{exported_at, photos:[{src,cat_id,action:assign|skip}]}`）→ 对 assign 照片 `putObjectCopy` 到 `photos/<cat_id>/<4位序号>.jpg` → 追加 `data/photo.json` 记录（`_id=relink-photo-<n>`、`marker_type` 复用该猫现有值、`best:false`、三 URL 同源）→ 累加 `data/cat.json` 的 `photo_count_total` → 写回 data/ 并 `putObject` 上传两份 JSON（public-read）。

**关键实现点（改这里前必读）**：
- 密钥读取顺序：`process.env` → 手写解析项目根 `.env`（无 dotenv 依赖；`scripts/package.json` 仍只依赖 `cos-nodejs-sdk-v5`）。`.env.example` 是模板，真实 `.env` 已进 `.gitignore`。
- **同一只猫认领多张时序号必须递增**：`nextSeqByCat` 初始值 = 现有最大序号，每分配一张 +1（初版 bug 是 `nextSeqForCat` 每次都基于复制前固定列表算，同猫第 2 张会覆盖第 1 张，已修）。
- `relink-workbench.html` / `relink-result.json` / `.env` 均在 `.gitignore`，不进版本控制。
- 本地跑 scan/apply 前需先在 `scripts/` 下 `npm install`（`cos-nodejs-sdk-v5` 未随仓库装）；dsh 运行时 node 可用 `C:/Users/yzx49/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`。

## 改动前的检查清单

1. 改了什么数据？→ 是否需要同步 `data/` + 推 `cos`（触发 `sync-data.yml`）
2. 新页面/组件？→ `app.json` 注册 **且** 从 `packOptions.ignore` 移除
3. 改样式？→ 只动 hex，别动颜色关键字；`app.wxss` 排除
4. 改完跑：单测 46 例 + `verify-demo-data.js` 65 项（真实数据不变量口径；一次就够，不要来回验）
5. 升 `config.js` 的 `app_version`，commit message 带版本号
6. 有持久价值的新结论 → 追加到本文件（不要写 `.workbuddy/memory/`）
