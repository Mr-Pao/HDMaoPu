# MaoPu（火大猫谱）— 项目记忆

> DSH 每个新会话自动加载本文件。`.workbuddy/memory/` 是旧工具 WorkBuddy 的目录，**DSH 完全不读**，别再往那里写新记忆。
> ⚠️ **本文件有 65536 字节的 workspace instruction budget**，超出部分会被截断丢内容。2026-11-01 已从 72KB 精简到 ~51KB，v4.0.17–v4.0.33 的历史条目完整原文搬进了项目根的 `AGENTS-archive.md`。**新增内容前先看这个预算**；要写长文就写进 `AGENTS-archive.md` 并在本文件留一行索引。

## 一句话定位

中山大学校园流浪猫谱系微信小程序「火大猫谱」，fork 自 `sysucats/zhongdamaopu`，品牌化为绿色 `#0C5F03`。
没有服务器、没有云开发：数据是 Git 仓库里的 `data/*.json`，同步到腾讯云 COS 当 CDN，小程序端拉 JSON 在内存里查询。

## 技术栈与目录

- 微信原生小程序，无框架。`miniprogramRoot: miniprogram/`，appid `wx5d52c6c8f098ed5e`，`libVersion: 2.24.7`，`nodeModules: false`
- 页面：`app.json` 注册 **31 页 + 分包 `pages/packageA` 1 页**（v4.0.35 加 newsAdmin，30→31）（v4.0.17 删徽章 38→34；v4.0.23 删用户档案页 34→30）
- `miniprogram/utils/datasource.js`（1321 行）：自研的 mpserverless 兼容层，实现 `createJsonServerless({baseUrl})`
- `miniprogram/utils/writeback.js`：COS inbox 写入通道（客户端零密钥）
- `data/`：19 个 JSON，即"数据库"（删徽章三件套后从 22 降下来）
- `scripts/`：Actions 专用脚本，**独立 `package.json`**（只依赖 `cos-nodejs-sdk-v5 ^3.0.0`）
- `tests/`：`datasource` / `cache` / `process-inbox` 三个测试文件，共 **47 例**
- `.github/workflows/`：7 个（aggregate、bundle-size、process-inbox、review、set-inbox-policy、sync-assets、sync-data）
- `functionsEMAS/`、`initDatabase/`、`initStorage/`：上游遗留，EMAS 空间已删，**基本是死代码**

## 常用命令

**本机 node 不在 PATH**，用 HBuilderX 自带的 v22：
```bash
NODE="C:/Users/yzx49/Program/HBuilderX/plugins/node/node.exe"
```
- 单测（47 例）：`"$NODE" --test tests/datasource.test.js tests/cache.test.js tests/process-inbox.test.js`
  - **必须显式列文件**；`node --test tests/` 会把目录当单个测试文件跑并报 fail
  - 用 `plugins/node18/node.exe`（v18.20.0）会挂 1 例：`mock.timers.enable` 不支持 `Date` → `ERR_INVALID_ARG_VALUE`
- 数据端到端校验（66 项，真实数据不变量口径）：`"$NODE" scripts/verify-demo-data.js`
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
`project.config.json` 有 **18 项**打包忽略。启用任何页面，**除了 `app.json` 注册，还必须从 ignore 名单移除**：
`pages/manage/photoManagement`、`pages/manage/medicalManage`、`pages/info/myFootprint`、`pages/info/myAchievement`、`pages/genealogy/applyMapAccess`、`pages/genealogy/detailCat/relationGraph`、`pages/tools/updateUserRole`、`pages/tools/inviteUser`、`pages/debug`、`pages/map`、`pages/manage/addCat`、`pages/manage/addRelations`、`pages/manage/managers`、`pages/manage/checkComment`、`pages/manage/rewards`、`images/markers`、`packages/tencentcloud`（⚠️ `components/achievementRank` 整目录已在 v4.0.53 审计中删除，勿再列出）
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
以 `miniprogram/config.js` 的 `app_version` 为准（当前 `v4.0.58`），commit message 末尾带版本号。⚠️ 本文件历史段落里的版本号（v4.0.42 等）是当时写入时的快照，实际版本号一律看 `config.js`。
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
- `config.demo_mode: false`、`writeback_enabled: true`、`photo_upload_enabled: **true**`（2026-11-01 改为匿名直传 COS，见"已知限制"）、`app_version: v4.0.58`
- **v4.0.56：拍照识猫改接 MeowID 开放平台（2026-11-02）** — 用户指令（m00001）「https://platform.meowid.net/?lang=zh-CN 做猫咪拍照或上传照片识别功能」。**完整要点见 `AGENTS-archive.md` 的「v4.0.56」一节**，这里只留必须记住的：
  - **project_id 不可推导，必须用户给**：API key 形如 `mk_live_<16位十六进制>_<secret>`，但那 16 位**不是** project UUID；用各种变体/前缀/数字/穿越探 21 次全返 `403 project_mismatch`，且服务端**只比对 key 绑定项目、不查存在性**（不存在的 pid 也是同一个 403）→ 枚举不可行。假 key 返 `401 invalid_api_key`（可判真伪）。`/v1/projects` 等是登录 session 端点（带 key 也 401）。鉴权头**只认 `Authorization: Bearer <key>`**。
  - **识猫端点** `POST {apiBase}/v1/projects/{projectId}/search?top_k=N&threshold=T`，multipart 单字段 **`image`**（`wx.uploadFile` 的 `name:'image'`，微信自造 boundary，不能自定义 Content-Type）。响应 `{candidates:[{index,route,face_detected,unknown,matches:[{cat_id,cat_name,score,support}]}]}`，单猫可能退化为扁平对象；**`matches[].score` 才是相似度**（`candidates[].score` 是检测分）；**响应无 bbox/face_box** → 旧的「画框+点框切猫」已整体删除。
  - **改动 8 个文件**：`recognize.js` 整体重写（502→576 行，删 `hex_sha256/catBoxList/catIdx/tapCatBox/calculateSoftmaxProb`，`canvasSideLen` 500→720，`getCatInfo` 三级匹配 `meowid_id→_id→name`，概率直接用 `score` 不做 softmax）；`recognize.wxml`（删 `.catBox` 循环，`.title` 用 `resultTitle`，位置行改 `{{item.campus}}{{item.area ? ' ' + item.area : ''}}`）；`recognize.wxss`（删 `.catBox` 两段）；`desc.js`（`interfaceURL+secretKey` → `apiBase/projectId/apiKey/topK`，**该文件是 CRLF 行尾，替换时要按 CRLF 写入**）；`data/setting.json` 的 `pages.recognize`；`genealogy.js`（`loadRecognize()` 改判 `projectId && apiKey`）；`genealogy.wxml/.wxss`（首页加「识别」胶囊入口——`clickRecognize` 方法早就有但**从没被任何 wxml 绑定过**）；`config.js`（`v4.0.55→v4.0.56`，`text.recognize` 17 键）。
  - **顺手修的两处旧 bug**：`recognize.wxml` 两个 `<picker>` 原来都写 `value="{{index}}"`（`index` 从未定义 → picker 永远显示第 0 项、与 `campusIndex/colourIndex` 不同步），改成绑对应 index；`catFilter()` 里 `res.detail.value` 是**字符串**，`parseInt` 后再写进 data，否则筛选与回滚索引类型不一致。`recognizeChatImage()` 里 `launchOptions.forwardMaterials[0].path` 缺空数组保护（scene 1173 但无素材时抛 TypeError），已加 `materials && materials.length` 判断。
  - **新建 `scripts/meowid-enroll.js`**：把 21 只猫 + 每只≤12 张照注册进 MeowID。密钥读 `process.env` → 项目根 `.env`（`MEOWID_PROJECT_ID`/`MEOWID_API_KEY`），支持 `DRY_RUN=1`、**`CHECK_ONLY=1`（只验 key↔project 配对后退出，不写盘不传图）**、`MAX_PER_CAT`、`ONLY_CAT`。建档 → 回写 `cat.meowid_id` + `saveJson('data/cat.json')` → 传图（**202 也算成功**，异步抽向量）→ `.meowid-enroll-state.json` 防重复（已进 `.gitignore`）。
  - **计费**：按「猫咪向量提取」计次（注册+识别都算）；没检测到猫不计费；**一次多猫识别只扣 1 次**。图片上限 15 MiB。
  - **当前状态（v4.0.58 已上线，2026-11-02）**：UUID `0627e727-c9c1-4194-a896-545c5106b676` 已验通；**21 只猫全部灌库完成（212 张参考图，向量已提取）**，`data/cat.json` 21 条 `meowid_id` 齐全；`data/setting.json` 的 `recognize` 块已填 `apiBase/projectId/apiKey/topK=3`。**平台原有「奶盖」`326496d1-9402-489e-b9e3-fedc5df70282`（22 图 / meta demo-cat-12）经真实照片 search 命中 score=0.35、support=19，确认为本地 `cat-naigai` 同一只，已复用而非重复建档**。端到端实测：小白照片 → `小白 score=1.0 support=18`。**灌库脚本可重跑补漏**（平台偶发 `fetch failed`/超时/HTTP 000，state 文件不保证全持久化，以平台计数为权威）。剩余：**真机自测**。
  - **首页入口（v4.0.58）**：在 `search-row` 内、筛选钮**左侧**；`.nav-recognize` 与 `#search .filter-btn` **完全同规格**（80rpx 方形、`--dk-card` 白底、`--dk-accent-line` 描边、`margin-left:18rpx`、`display:flex` 居中），只保留**一处**定义。图标 `images/button/recognize.png`（200×200 深绿描边相机，`density=27.7%`；用 Pillow 生成，脚本 `C:/Users/yzx49/tmp/make_cam.py` 非仓库文件，PowerShell GDI+ 画不出镜头/凸起）。**旧的 `button/addPhoto.png` 是纯白图片框（`opaque-dark=0`），放浅绿底上等于隐形，别再换回去**。
  - **入口隐藏第二个坑**：`genealogy.js:286` 原 `__wxConfig.envVersion === 'release' ? 'recognize' : 'recognize_test'`——开发者工具里是 `'develop'`，读不存在的 `recognize_test` → `settings` 空 → `showRecognize=false`。已改 `=== 'release' || === 'develop'`。
- **v4.0.53：全量代码审计优化落地（2026-11-01）** — 用户指令「除六（可加功能）其余全做」。改动：①B1 下架照片露出——`cat.js`(getBestPhoto/getLatestPhoto)、`datasource.js`(_getCatLocations)、`gallery.js`、`detailCat.js` 相册均过滤 `hidden`/`deleted`；②B2 `detailCat.js` likeCat/likeCountChanged 改 async + `await putInbox('like',...)`；③B3 服务端新增 `deleteComment` kind + `handleDeleteComment`（仅作者删/幂等/软删），客户端 `commentBoard.js` 真 putInbox；④B4 `handleDecision` 新增 `approvePhoto` 真复制 pending→catimg 并 append `photo.json`、cat.photo_count_total+1；⑤二 6 处 `api.curdOp` 假写→真 putInbox：`inter`(图库点赞)/`relationTab`/`checkFeedbacks`/`replyFeedback`/`pageSettings`/`filters`/`catInfoTab`(movePhoto)，服务端补 `manageFeedback`/`managePageSettings`/`saveFilter`/`movePhoto` action（白名单+永不throw+markTouched）；⑥三 删 `leaderboard`/`components/photoRank`/`components/achievementRank` 死页与孤儿组件 + `news.js` clickScience + `info.js` clearCache + `cloudApi.getMpCode`；⑦四 `gallery` PER_ROW 12→8、genealogy 并发池5、删 `common.js` convertToWebP/getOptimizedImageUrl 死代码；⑧五 删 252 处调试 console.log；⑨七 新建 `utils/nickname.js`（NICKNAME_MAX=20）应用到 commentBoard/feedbackDetail/modifyNews（3 页非 4 页，addPhoto 已匿名直传无昵称）；管理页口令壳评估后不抽（`promptToken` 已是共享 API）；`datasource.js` 不拆。验收：47 单测 + 66 verify + DRY_RUN 自测全过；提交 `1e48b71`。⚠️ 用户自有改动 `app_logo.png`/`图片.pptx` 未纳入审计提交。

- **v4.0.54：五维评分雷达图（2026-11-02）** — 用户从审计「六·可加功能」里选了「五维评分可视化」（m00339）。在详情页「猫友评价」卡**展开详情**里，原本的 5 行 `star-rating` 替换为 **canvas-2d 五维雷达图**：`detailCat.js` 新增 `drawRatingRadar()`（用 `wx.createSelectorQuery().select('#rating-radar').fields({node:true,size:true})`，按 `cat.rating.catRatings` 的 `{name,score}` 画五边形，`#0C5F03` 描点、`#14801F` 描边、`rgba(20,128,31,0.18)` 填充，4 圈同心网格+维度标签；dpr 取 `wx.getWindowInfo().pixelRatio`，兜底 2），`bindDetailRating` 展开时与 `onShow`（`showDetailRating` 为真时）各重绘一次；`detailCat.wxml` 用 `<canvas type="2d" id="rating-radar">` + `count===0` 时显示「暂无评分，快来当第一个～」；`detailCat.wxss` 新增 `.rating-radar`(高440rpx)/`.rating-radar-empty`。设计依据：五维 = `utils/rating.js` 的 `ratingMap`（r1猫德/r2颜值/r3社交/r4干饭/r5活力），值来自 `cat.rating.dimAvg`（已由 `process-inbox` 的 `handleRating` 重算）。**只动视觉、不碰数据结构、不引依赖、主题色不变**。验收：47 单测 + 66 verify 全过（canvas 渲染只能在微信开发者工具里目测，node 测试不覆盖）。提交见 v4.0.54 commit。
- **v4.0.55：数据看板加「近半年趋势」+「成长时间轴」（2026-11-02）** — `_getCatStats()` 扩 `trend/trendMax/timeline`；`dashboard` 新增趋势柱状卡与时间轴卡。⚠️ 「为什么不用 `stats.events`」「`mphoto` 是毫秒时间戳」等要点见 `AGENTS-archive.md` 的「v4.0.55」一节。
- **v4.0.42：管理口令收敛为 `data/gate.json` 一处（2026-11-01）**
  - **用户原话（m01906）：「我只是想在小程序端加一个密码，输入了之后就能进入管理界面管理数据，怎么搞得这么麻烦啊，一定要搞什么REVIEW_PASSCODE吗」**——此前口令分两处：界面进不进认 `data/gate.json` 的 `code`，提交能不能过认 Actions secret `REVIEW_PASSCODE`，两处不一致就表现为「进去了但提交没反应」，而 secret 在手机上根本看不到。
  - **`scripts/process-inbox.js` 新增 `currentGateCode()`**：`loadData('gate').items.find(it => it._id === 'gate')` 取 `code` 并 trim，读失败 `console.warn` 后返回空串；`tokenOk(token)` 改为 `const expect = currentGateCode() || REVIEW_PASSCODE || ''`。**`REVIEW_PASSCODE` 降级为兜底**（gate.json 缺失或 code 为空时才用），老部署可继续留着，新部署完全不用配。
  - `selftestObjects()` 里 14 处 `REVIEW_PASSCODE || 'wrong'` 改为 `SELFTEST_TOKEN`（函数开头 `const SELFTEST_TOKEN = currentGateCode() || REVIEW_PASSCODE || 'wrong'`），自测不再依赖环境变量；末尾警告改判 `!currentGateCode() && !REVIEW_PASSCODE`。
  - `.github/workflows/process-inbox.yml` 给 `REVIEW_PASSCODE` 那行加注释说明只作兜底；`data/gate.json` 的 `note` 改成「全站只有这一处口令」并说明服务端也读它；`miniprogram/utils/passcode.js` 顶部口诀同步修正。
  - 验证：`DRY_RUN=1` **不带 REVIEW_PASSCODE** 跑 30 条自测，manage 生效 6 条；临时把 gate code 改成 `zzz-temp` → manage 全部 `drop:bad-token`，改回 `0000` → 恢复生效，**证明服务端确实读 gate.json**；单测 47/47、verify 66/66。
  - 提交 `9d11c92`（7 files）。⚠️ 当时本地领先 `origin/cos` 11 个提交，push 被拒（远端 Actions 提交了 `130eeab chore(data): 聚合 inbox 写入`），用 `git rebase origin/cos`（带 `rebase.autoStash=true` 避开用户自己改的 `app_logo.png`/`图片.pptx`）后才推上去。
- **v4.0.36：关于页按参考图重构布局（2026-11-01）**
  - **用户原话（m01124）：「能再派一个子智能体改关于界面么，风格不变，布局参考这张图，连击五次可以改到火大猫谱字上，管理后台卡片可以放在关于上方，如果不是管理员就隐藏」**。参考图是一款叫 SpaceLaunch 的 App 的「我的」页：居中圆 logo → 大标题 → 灰字副标语 → 三格数据条（竖分隔）→ 淡色提示卡 → 分节标题「探索」→ 2 列卡片 → 分节标题「关于」→ 竖列表行组 → 底部小字。
  - **改动 3 个文件，`info.js` 一字未动**：`info.wxml` 104→**133 行**（+43 −14）、`info.wxss` 465→**621 行**（**纯追加 156 行，0 删除**，v5.5 块从 **:468** 起）、`config.js`（`app_version` v4.0.35→**v4.0.36**，`text.info` 新增 **11 键**）。
  - **分节顺序（自上而下）**：`.nav`（保留 `padding-top: {{statusBarHeight}}px`）→ ① `.mina-info` 白卡（圆 logo + `.title` + `.dev` 灰字标语）→ ② 两行 × 三格数据条（6 个数全保留）→ ③ `.tip-card` 淡色提示卡 → ④ 「探索」`.card-container` 两列卡片 → ⑤ 友情链接 → ⑥ **管理后台 3 列宫格 15 项** → ⑦ 「关于」`.about-list` 竖列表 3 行 → ⑧ `.foot-note` 底部小字 → `.plus` 客服悬浮按钮 → tabBar 占位。
  - **连击位置迁移（用户明确要求）**：`info.wxml:8` 的 `.nav-title`（「关于」）**去掉 `catchtap`**；`info.wxml:16` 的 `.title`（`{{text_cfg.app_name}}`，即「火大猫谱」）**加 `catchtap="onTitleTap"`** + `hover-class="tap-dim"`。**`info.js` 的 `TAP_TO_UNLOCK=5` / `TAP_WINDOW=800` / `onTitleTap` / `askAdminPasscode` / `loadGateCode` 全部原样未动**。必须用 `catchtap` 不是 `bindtap`（防冒泡）。
  - **管理后台卡上移到「关于」分节之前**；显隐仍靠 `showCond[menu.show]`（`showCond.manager` 由 `isUnlocked()` 控制，非管理员恒 false → 整块隐藏）。⚠️ `showCond[menu.show]` 在 wxml 里**必须是 2 处**（第 81 行工具组、第 93 行管理后台组），别合并——两组用 `menu.title != '管理后台'` / `== '管理后台'` 分流。
  - **`text.info` 新增 11 键**：`explore:"探索"`、`friends:"友情链接"`、`about:"关于"`、`tip_title:"照片和便利贴会在审核后展示"`、`tip_desc:"后台每几分钟自动汇总一次，稍后刷新就能看到啦"`、`row_version:"版本"`、`row_feedback:"信息反馈"`、`row_feedback_value:"去反馈"`、`row_contact:"联系作者"`、`row_contact_value:"发消息"`、`footer:"火大猫谱 · 中山大学校园流浪猫谱系"`。原有 `share_tip`、`slogan` 保留。wxml 里只剩 6 个统计标签（只猫猫/张照片/张便利贴/现存猫猫/领养率/绝育率）和导航栏「关于」是硬编码中文（均为原有内容）。
  - **版本号从 slogan 行挪进「关于→版本」行**：原 `{{version ? version + "\n" : ""}} {{slogan}}` 改成 `.dev` 只放 `text_cfg.info.slogan`，`.about-row` 里 `{{version || '-'}}` 显示版本。想改回头部就在 `info.wxml:17`。
  - **「联系作者」用 `<button class="about-row about-row-btn" open-type="contact">` 包整行**：`.about-row-btn` 清微信默认外观（`width:100%;margin:0;background:transparent;border:none;border-radius:0;line-height:inherit;text-align:left;font-size:inherit;color:inherit`）+ `::after{border:none;display:none}` 去掉伪元素边框；行间分隔靠 `.about-row + .about-row { border-top: 1rpx solid var(--dk-line) }`。
  - **故意没加「清理缓存」行**：`info.js` 的 `clickbtn` 里 `actionMap = { clearCache: () => this.clearCache(), guide: () => this.guide(e) }`，但 **`this.clearCache()` 方法根本不存在**（历史遗留，调用必报错）。别去实现，也别加这一行行入口。
  - **样式零新增 hex**：唯一色值字面量是 `.about-list` 阴影 `rgba(12,95,3,0.035)`（与同文件 v5.2 块 `.block` 既有阴影写法一致）；圆角走 `var(--dk-radius)`（26rpx 是对齐 `.block`/`.card` 的既有值）。触感反馈 `.tap-dim`（标题按下变 `--dk-accent-soft`）、`.row-hover`（行按下变 `--dk-accent-soft`）。
  - **分节标题沿用 `.block-name`（19rpx / 3rpx 字距 / uppercase / 灰）**，没改成参考图的中等加粗字号——理由是「风格不变」优先于「像素级还原参考图」。想放大就在 wxss 末尾追加 `.block-name{font-size:24rpx;letter-spacing:0;text-transform:none;color:var(--dk-text)}`。
  - 验证：`node --check info.js/config.js` 通过、`info.json` 解析通过、`node --test` **47 例全过**（基线保持）、wxml 标签平衡 view 59/59 block 3/3 button 2/2 image 4/4 text 12/12、wxss 花括号 86/86、`hidden` 0 处、`<svg>` 0 处。
  - 提交 `090bb1b`（3 files, +215 −15）。**`app.wxss` / `app.json` / `data/` / `scripts/` / `tests/` 零改动。**

- **v4.0.35：公告管理独立入口 + 普通页零权限判断（2026-11-01）**
  - **用户原话（m00650）：「把公告管理也单独做一个入口放在管理后台吧」；（m00684）：「还有哪些需要管理的都在管理后台做个单独入口，这样普通页面就不用做判断了」**。
  - **新建 `miniprogram/pages/manage/newsAdmin/`（4 文件）**：`newsAdmin.js`（`putInbox` + `text_cfg` + `passcode`；`EXCERPT_LEN=60`；`formatDate(iso)`→`YYYY-MM-DD`；data `{hasToken, loading, items}`；方法 `onLoad/onShow/onPullDownRefresh/editToken/ensureToken/loadList/preview/createNews/modifyNews/removeNews`；`loadList` 用 `app.mpServerless.db.collection("news").find({}, {sort:{date:-1}})` 映射 `{_id,title,class,dateText,excerpt}`；`removeNews` 走 `putInbox("manage",{action:"manageNews",op:"remove",token:passcode.getToken(),news_id:id})`）。`newsAdmin.wxml` 结构照 `review.wxml`（`.head`+`.head-lock` bindtap=editToken / `.head-tip` / `.token-tip` `wx:if="{{!hasToken}}"` / `.toolbar>.btn-add` / `.card` 循环含 `.tag/.time/.title/.excerpt/.actions`）。`newsAdmin.wxss` 照抄 `review.wxss` + `.toolbar`/`.btn-add`/`.excerpt`(-webkit-line-clamp:2)。`newsAdmin.json` = `{"navigationBarTitleText":"猫抓板公告","backgroundColor":"#F7F7FA","enablePullDownRefresh":true}`。
  - **接入**：`miniprogram/app.json:32` 注册 `"pages/manage/newsAdmin/newsAdmin",`（在 `pages/manage/admin/admin` 与 `pages/manage/dashboard/dashboard` 之间）；`project.config.json` 的 `packOptions.ignore` **没有**它（能打包）。`miniprogram/pages/info/info.js:104-107` 「猫抓板公告」菜单 `path` 由 `/pages/news/createNews/createNews` 改为 `/pages/manage/newsAdmin/newsAdmin`。
  - **公告写入链路改走 inbox 聚合**（原来是只写本地覆盖层的假写）：`scripts/process-inbox.js` 的 `handleManage`（`:695`）加 `if (data.action === 'manageNews') return manageNews(data);`；`:776-1008` 新增公告段（`NEWS_CLASSES=['领养','救助','活动','其他']`、标题≤30/正文≤5000/昵称≤30/图≤9/路径≤400、`NEWS_UPDATE_FIELDS` 十键**不含** `_id`/`date`/`show`、`newsString/newsPath/newsPathList/normalizeNewsFields/genNewsId/manageNews`）。`manageNews(data)` **永不 throw**：op 非 add/update/remove → `drop:bad-op`；add → `_id=genNewsId(title)`（ASCII slug ≤24 → `news-<slug>`，否则 `news-<ts36>`，撞号加 -2/-3）、`date` 用**服务端时间**、昵称空兜底 `'猫谱管理员'`、`show:true` → `ok:news-add`；update → `news_id` 校验 + 白名单过滤 + `dateLastModify` 补服务端时间 → `ok:news-update`；remove → `ok:news-remove`；三种都 `markTouched('news')`。
  - ⚠️ **`MAX_OBJECT_BYTES` 从 4096 放宽到 `16384`**（`scripts/process-inbox.js:59-64`）：800 字中文正文 UTF-8 约 2400B + 9 张图两组 COS URL 约 1700B 会顶破 4096 被误杀。`pending/*` 的 512KB 闸门**不变**。`tests/process-inbox.test.js:33/:36/:38` 同步改阈值 + body `'x'.repeat(20000)`；`:41-57` 新增回归「公告正文接近上限仍可通过」。
  - **`createNews.js` / `modifyNews.js`**：`api.curdOp` → `putInbox("manage",{action:"manageNews",op:"add"|"update",token:passcode.getToken(),news:data})`；`createNews.js` 的口令检查**提到上传图片之前**（`:317-318`），`date: new Date().toISOString()`（`:339`）；成功用 `received_tip` 2000ms + `setTimeout(wx.navigateBack,1200)`，失败用 `offline_tip` 2500ms 不返回。两页 `data.auth` 由 `false` 改 **`auth: true`**、`onLoad` **删掉 `checkAuth(this,2)`**（口令门已在 `newsAdmin` 那一页把过，本页不再重复判）——两页 wxml 的 `<form wx:if="{{auth}}">` 保留，`{{tipText}}/{{tipBtn}}` 兜底块成为死保护（未删）。
  - **普通页权限判断全清**：
    - `detailNews.js/wxml` **退化为纯展示页**：删 `isManagerAsync`/`api`/`sleep` 引入、data `showManager`、`modifyNews()/_doRemove()/removeNews()` 三方法；`detailNews.wxml:33-36` 删「删除/修改」按钮块（**这是「公告谁都能改」的直接病根**）。
    - `news.js`：删 `import { checkAuth }`、data `auth:false`、`onLoad` 里 `await checkAuth(this, 2)`——`news.wxml` 里 **0 处**用 `auth`，纯死调用。
    - `genealogy.js`：删 `bindManageCat`（长按猫卡跳 `catManage`）+ `genealogy.wxml:86` 的 `bindlongpress`。
    - `commentBoard.js`：删 `isManagerAsync` 与 `onLoad` 里 `var manager = await isManagerAsync(1)` 整段、data `is_manager`；`commentBoard.wxml:15` 改 `can-delete="{{item.user_openid === user.openid}}"`（仅本人可删）。
    - `feedbackDetail.js/wxml/wxss`：删 `.adminEntry` 整块（管理员「添加猫际关系」入口）、`toAddRelation()`、data `isManager`、import；wxss 删 4 段样式后留一行注释说明。
    - `detailCat.js`：删 `isManagerAsync` import 与 `onLoad` 里 `is_manager` setData（wxml 本无引用，死字段）。
  - **`miniprogram/utils/passcode.js` 扩到 6 个导出**：新增 `UNLOCK_KEY="admin_unlocked"`、`isUnlocked()`、`setUnlocked(v)`（原 `KEY="manage_passcode"` 与 `getToken/hasToken/setToken/promptToken` 不变）。
  - **`miniprogram/utils/user.js` 的 `isManagerAsync` 加了前提**：先 `if (!passcode.isUnlocked()) return false;`，再查 `user.manager >= req`——因为 `datasource._userOp('get')` 的 `remoteConfirmedEmpty` 分支会给**每个新访客** `manager=99`（`data/user.json` 空表时恒真），单看 `user.manager` 等于人人管理员。
  - 自检口径：`miniprogram/pages/` 下**非 manage 页**已无 `isManagerAsync` 调用（只剩 `tools/inviteUser`，该页在 `packOptions.ignore` 里未启用）；非 manage 页已无 `checkAuth(`（只剩 `packageA/pages/recognize` 的 `this.checkAuth()`，那是相机授权，同名无关）。管理页保留 `checkAuth` 是**正确的**（本就该有）。
  - 验证：14 个改动 .js `node --check` 全过；`node --test` **47 例全过**；`verify-demo-data.js` **66/66**；`DRY_RUN=1 REVIEW_PASSCODE=test node scripts/process-inbox.js` exit 0，逐条 `ok:news-add/ok:news-update/ok:news-remove/drop:bad-news/drop:no-news/drop:bad-token`。
  - 提交 `42556b6`（25 files, +870 −218）。
  - ⚠️ **遗留未修**：另 16 处 `api.curdOp`（catInfoTab/relationTab/commentBoard/ratingDetail/feedbackDetail/addCat/addRelations/checkComment/checkFeedbacks/filters/managers/pageSettings/replyFeedback/rewards/achievement.js/inter.js）**同样是只写本地覆盖层的假写**，包括 `commentBoard.js` 的 `deleteComment`。`scripts/process-inbox.js:576 handleDecision` 里照片审核通过只 `console.log` 不落库（`:605-609`，注释还写着「上传入口目前关闭」，但 v4.0.18 起已开放）。

- **v4.0.34：管理后台改为「关于页连击 5 次 + 口令」解锁（2026-11-01）**
  - **用户原话（m00416）：「openid 也不好 / 改成关于页面，连击关于5次，输入管理密码，然后显示管理后台」**。此前评估过的 A（去掉 `remoteConfirmedEmpty` 分支）与 B（`data/user.json` 白名单 openid）两个方案**全部作废**——B 要求用户真实 openid，而 `datasource.js:27` 的 `OPENID_STORAGE_KEY='fake_openid'` 是 `guest_xxxxxxxx`，换设备/清缓存就变，不可靠。
  - **口令明文存 `data/gate.json` 的 `code` 字段**（用户要求「密码可以存在cos，我能直接后台修改就行」，所以**废弃 SHA-256 哈希版**，也不需要任何计算脚本）。文件结构：`{"version":"<ts>","items":[{"_id":"gate","code":"0000","note":"..."}]}`。留空 = 管理入口不可解锁。
  - **`miniprogram/pages/info/info.js`**：常量 `TAP_TO_UNLOCK = 5`、`TAP_WINDOW = 800`（超时就重新计数，「连击」不是「累计」）、`UNLOCK_KEY = 'admin_unlocked'`；`jsData` 加 `tapCount/tapAt`；`onShow` 里 `this.setData({ "showCond.manager": this.isUnlocked() })`；新增 `isUnlocked()`/`setUnlocked(v)`/`loadGateCode()`/`onTitleTap()`/`askAdminPasscode()`/`refreshManagerNums()`。
  - ⚠️ **`loadGateCode()` 故意不缓存**：每次连击都现拉 `gate` 集合 `_id='gate'` 的 `code`，这样改完 `data/gate.json` 下次连击就生效，不用发版也不用重启（`2908f0f` 就是修这个）。
  - ⚠️ **`data/` 是公开 CDN，口令等于公开**——它只是「别让普通用户误入」的 UX 门。**v4.0.42 起服务端 `tokenOk()` 也读同一个 `data/gate.json` 的 `code`**（原先读 Actions secret `REVIEW_PASSCODE`），所以改这一处就同时决定「界面能不能进」和「提交能不能过」，不用配 secret；口令不对的提交仍是 `drop:bad-token` 静默丢弃。
  - `miniprogram/pages/info/info.wxml:8` `.nav-title` 加 `catchtap="onTitleTap"`（v4.0.36 已迁到「火大猫谱」标题）；`scripts/set-admin-passcode.js` 曾建后**已删除**。
  - ⚠️ **`data/gate.json` 必须真的传到 COS**：只在本地会出现「管理入口未启用」——`datasource` 对 404 有 `NOT_FOUND_COOLDOWN = CACHE_TTL`（10 分钟）冷却，改完要等冷却或重开小程序。上传方法见「COS 上传踩坑」一节。
  - 提交 `34d1634` + `2908f0f`。
- **v4.0.33 去掉管理口令锁屏门**：用户要「可以去掉口令」→ 只去掉**客户端输入门**，页面不再锁屏；**提交仍带口令**，服务端 `process-inbox.js` 的 `tokenOk()` 与 `REVIEW_PASSCODE` 一字未动（唯一真权限边界）。明确否决：口令写死进 `config.js`（小程序包可解）、服务端也去掉校验。**新增 `miniprogram/utils/passcode.js`**：`KEY=\"manage_passcode\"`，导出 `getToken/hasToken/setToken/promptToken`；`promptToken` 用 `wx.showModal({editable:true})` 且**绝不能传 `content`**，输入在 `res.content`，回调 `options.onSaved`；口令**永久有效**（已删 24h TTL 与 `hasValidPasscode`）。`admin.js`/`review.js` 删掉 gate 整块，`.head-lock` 由「退出管理/锁定」改成「口令」，新增 `editToken()`/`ensureToken(token)`；三个提交点 `saveCat`/`togglePhoto`/`saveLinks` 都是 `const token = this.getToken()` → `ensureToken` → `putInbox` **复用同一 token 变量**。⚠️ `review.wxml` 从 65 行缩到 18 行（gate 块占大头），别以为被截断。
- **v5.4 主题色强化（随 `e9689bf` 上库，未单占版本号）**：品牌绿 `#0C5F03` 不许改（见「坑 7」），只在 `genealogy.wxss`（v5.4 块从 `:1204` 起）与 `custom-tab-bar/index.wxss`（`:69` 起）末尾追加覆盖块，旧样式一行未回改。手段：加大绿色面积、大面积填充换已存在的 `--dk-accent-2: #14801F`、加阴影对比。**hero 选中格**原 34×4rpx 短横线被 `height:0;opacity:0;background-color:transparent` 归零（用这三条而非 `display`，规避 hidden 坑），改为整格浅绿胶囊底。对比度 `#0C5F03` 7.26:1 / `#14801F` 4.66:1 都过 AA，别再重算。⚠️ commit message 未提它，**别重复提交这两个文件**。
- **v4.0.31 管理后台拆成三个独立入口（去掉页内 tab）**：用户要求「不单独做管理后台按钮，把功能直接加在现有的管理后台列表里」→「关于→管理后台」网格里删掉单独的「管理后台」项，换成并排的 `猫资料编辑`/`照片审核`/`友情链接`（紧跟审核队列）。同一页 `pages/manage/admin/admin` 靠 query `?tab=cat|photo|link` 复用时，`onLoad` 用 `TAB_META` 兜底 + `wx.setNavigationBarTitle({title: TAB_META[tab]})`。页内 `.tabs`/`switchTab()`/`.tab-active` 全部删除；首次加载走 `afterUnlock()`（`link→loadLinks()`，否则 `loadCats()`），**别再写死 `loadCats()`**。
- **v4.0.30 友情链接可手动增删（管理后台 `?tab=link`）**：数据仍存 `data/setting.json` 的 `_id='friendLink'` 记录，schema `{_id,apps:[{appid,name,logo}]}` 不变。写入走 `putInbox('manage',{action:'saveFriendLinks',token,apps})` → `process-inbox.js` 的 `manageSaveFriendLinks`（`tokenOk()` 校验，**整体替换**数组，`markTouched('setting')`）。⚠️ 不能走客户端 `datasource.updateOne`——它只写本地覆盖层不回传。服务端 `normalizeFriendApp`：`APPID_RE=/^wx[0-9a-zA-Z]{16}$/`、name ≤20、logo ≤300、按 appid 去重、上限 `FRIEND_LINK_MAX=20`；失败 `drop:no-apps`/`drop:bad-friend-app`/`drop:too-many-links`，成功 `ok:friend-links`。展示端 `info.js` 的 `loadFriendLinks()` 在 `onShow` 调、5 分钟节流（`jsData.linkFetchedAt`），`info.wxml` 整块 `wx:if=\"{{friendApps.length}}\"`。
- **v4.0.30 + v4.0.32 提交后「延迟生效」提示**：三段延迟根因——`writeback.js` 的 `putInbox` 永远不 reject；`process-inbox.yml` cron `*/5`；`datasource` SWR `CACHE_TTL` 10 分钟。→ 提交后只有本页乐观更新，重进/他人要等 5~15 分钟。**新增 `miniprogram/utils/syncTip.js`**：`{markPending,getPending,getPendingCount,clearPending,submittedModal,pendingText}`，`STORAGE_KEY=\"pending_sync\"`、`MAX_ITEMS=20`、`TTL=2h`，同 kind+cat_id 覆盖不追加，**同步、异常全吞、绝不 throw**。`config.text.sync` **6 键**：`received_tip`（所有成功提示的唯一来源）/`submitted_title`/`offline_tip`/`pending_title`/`pending_tip`/`pending_close`。提交点：`addPhoto.js:150`/`:199`、`commentBoard.js:320`、`ratingDetail.js:180`、`feedbackDetail.js:166`、`applyAdoption.js:166-167`。⚠️ **`commentBoard.js` 没有 `text_cfg` 变量，只有 `import config`**，写 `text_cfg.sync.*` 会 ReferenceError。detailCat 顶部提示条 `detailCat.wxml:18-24` 用 `wx:if=\"{{pendingCount > 0 && !syncTipHidden}}\"`（不是 hidden），`dismissSyncTip()` 只 setData 不清本机记录。点赞/关注**刻意不提示**。
- **v4.0.29 四页标题字号统一 + tab 改名「猫片」**：猫谱页 `.nav-t` 52rpx，猫抓板/关于页在各自 wxss 尾部追加 `.nav-title` 覆盖（52rpx/800/-1.6rpx）**不动 `app.wxss`**；猫图页无大标题是刻意设计，别硬补。tabBar 文案只改 `custom-tab-bar/tab.js:12`，其余「猫图」字样保持不动。
- **v4.0.27 全站「校区」→「位置」+ 配置缓存版本失效 + 抽屉骨架回退原版**：
  - ⚠️ **抽屉骨架必须沿用原版**（用户三次纠正。原 v5.3 曾把它改成底部弹层并被否）：`#filter-block` 用 `style='height: {{heights.windowHeight - heights.filters}}px'` + 半透明黑遮罩，内容贴顶，`.fsheet` 是**向下摊开**的卡片（`border-radius: 0 0 36rpx 36rpx`，阴影朝下）。**绝不能做成 `justify-content:flex-end` + `36rpx 36rpx 0 0` 的底部弹层**，`.fpanel`/`.fbar-head`/绿色 `.fbar-done` 三套都已被否。`.frow-k` 宽 ≥80rpx 且 `white-space:nowrap`（44rpx 会把「位置」压成竖排并裁字）。
  - ⚠️ **`hidden` 属性会被 CSS `display` 覆盖**（表现：编译完抽屉自己开着、关不掉）：`hidden` 只是 UA 的 `[hidden]{display:none}`，被 `#filter-block{display:flex}`（id 优先级）顶掉。**开关一律用 `wx:if`**，别用 `hidden`。
  - 「校区」→「位置」：`miniprogram/` 下 20 文件 36 处已批量替换，复查 `grep -rn 校区 miniprogram/ --include=*.js --include=*.wxml --include=*.json` 必须为 0。`campus` 变「校内」后 `campus + area` 要留空格（`genealogy.wxml:106`、`detailCat.wxml:82`）。
  - **配置缓存版本失效**：`utils/page.js` 的 `_getSetting` 缓存 7 天 → 发版改 campus/colour/fullTab 后老用户最长 7 天看不到新值。修法：① `loadFilter()`/`getGlobalSettings()` 默认 `nocache:true` 且不落盘；② `app.js` 新增 `_migrateConfigCache()`，在 `checkCacheValidity()` 开头用 `app_version` 当哨兵删 `setting-*`/`ds_cache_setting`/`genealogy-fcampus`（猫数据缓存不动，避免断网空列表）。⚠️ `tests/cache.test.js` 种 storage 不带 epoch 字段，**`cache.js` 内部不能加版本校验**，否则挂 2 例。
- **v4.0.26 筛选抽屉三行胶囊 + 位置三分类 + 花色七类**：首页导航栏右侧**保留原筛选按钮**（`<view class='filter-btn' bindtap='fToggle'>`，`filters_active` 时换 `filter_y.png`），三行只在点开的抽屉里——曾误做成常驻栏并删掉筛选按钮，被用户否掉。数据模型 `filters = [{key,name,all_active,options:[{name,cond,active,count}]}]`，三行 `campus`/`colour`/`state`。**状态 7 值互斥**（已领养`{adopt:1}`/寻找领养中`{adopt:2}`/待绝育`{sterilized:false}`/已绝育/未失踪`{missing:false}`/已失踪/去往喵星`{to_star:true}`），多选要包 `{$or:[...]}`，不能像位置/花色用 `$in`。关键函数 `fCheckLegal`/`_rowConditions`/`_conditionsOf`/`fGet`/`updateCounts`/`applyFilters`/`fRowAll`/`fRowOpt`/`fRowReset`/`_nextHeroMode`。位置=校内/校外/其它，花色=橘色/黑色/白色/狸花/三花/玳瑁/重点色；`data/filter.json` 与**`data/setting.json` 内嵌的 `_id='filter'` 都要改**（`loadFilter()` 读后者）。`setting.json` 的 `pages.genealogy.catsStep` = 10。
- **COS 上传踩坑（2026-11-01 定位，务必按此操作）**：`C:\Users\yzx49\tmp\cosprobe\putpub.js` 的 `put(key, body, acl)` 实测可用，但**必须用 `node -e` 内联调用**（`require('./putpub').put('/data/x.json', fs.readFileSync(...), 'public-read')`）。走命令行 `node putpub.js <key> <file> public-read` 会稳定返回 **nginx 400 Bad Request**（`<html>…<center>400 Bad Request</center>…nginx`），**即使 key 已带前导斜杠**，成因未明（与 shell 传参/编码有关），别再在这上面耗时间。`cos.js` 的 `request('PUT', '/path', {}, body)` 可写但**不能带 ACL**（会变私有）。上传后必须 `curl -s -o /dev/null -w "%{http_code}"` 验证匿名 200。
- **v4.0.24 + v4.0.25 首页 hero 数据卡**：整卡 `bindtap='toDashboard'` 跳数据看板（早期 `.nav-dash` 独立胶囊方案已废弃，残留检查为 0）；`.hero-row` 三格 = 在册/待领养/本月新增，每格 `catchtap='heroFilter' data-type='all'|'adopt'|'new'`（**必须 catchtap，bindtap 会冒泡跳看板**）。`hero_mode` 状态机 `''|'all'|'adopt'|'new'|'custom'`：`heroFilter` 重设 filters 后 `reloadCats()`，`fGet()` 在 `'new'` 时 push `{create_time:{$gte:this.getMonthStartISO()}}`，`fReset` 回 `''`，`fComfirm` 置 `'custom'`。`.hero-k::after` 绿短横线是首页专属，别复用。⚠️ dashboard 页**无任何管理员校验**，放宽到首页后普通用户可直接看（数据本地重算，不耗流量）。`--dk-soft` 不是有效 token（有效的是 `--dk-accent-soft`/`--dk-accent-line`）。右下角漂浮「找领养」按钮 v4.0.25 已整块删除。
- **用户档案体系已整体放弃（v4.0.23）**：`datasource.js:27` 的 `OPENID_STORAGE_KEY='fake_openid'` 生成 `guest_xxxxxxxx` 存本地，**与微信账号完全无关**，换设备/清缓存/重装就是新人；`data/user.json` 也从没有 nickname 字段。要跨设备只能接 `wx.login`→code2session，与「月成本 ≤5 元、不引服务器」红线冲突 → **不做档案，每个提交场景当场填昵称，不填就是匿名用户**，昵称只存本机 `last_nickname`。删掉的 4 页（20 文件）：`pages/info/userInfo/`（含 `modifyUserInfo/`）、`myFollowCats/`、`myAdoption/`、`feedback/myFeedback/`；`components/modifyUserInfo/` 整目录删除、全仓 0 引用，v4.0.19–21 那套「json 注册组件 + 点此设置头像昵称」**已作废**。就地填昵称范式（5 页统一）：`onShow/onLoad` 用 `wx.getStorageSync('last_nickname')` 预填 → `maxlength=20` → 提交前 `setStorageSync` → 空值兜底 `'匿名猫友'`；落地 `commentBoard`/`feedbackDetail`/`modifyNews`/`addPhoto`，**`ratingDetail` 不加**（评分匿名，加了会破坏 `process-inbox` 的 rating schema）。新增页面用 `getUser()`，**别调 `getPageUserInfo()`**（无 `userInfo` 时直接 return false，`wx:else` 永不渲染 = 空白页）。
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
- 审核/管理**已无口令锁屏门**（v4.0.33）：关于页连击「火大猫谱」5 次 → 输口令 → 解锁并顺手存本地 storage `manage_passcode`（`utils/passcode.js` 统一读写，解锁标记 `admin_unlocked`）；真正校验在 `process-inbox.js` 的 `tokenOk()`，**读 `data/gate.json` 的 `code`**（v4.0.42 起；`REVIEW_PASSCODE` 仅兜底），token 不对的提交直接 `drop:bad-token` 静默丢弃
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
- 一批已注册但写操作静默 no-op 的页面：`catManage` / `checkPhotos`（`replyFeedback`/`checkFeedbacks` 已在 v4.0.53 审计中改为真实 `putInbox('manage',{action:'manageFeedback'})` 写入链路）
- 遗留死代码：`news.js:149 clickScience()` 跳 `/pages/science/science`（页面不存在，wxml 未绑定不触发）。（注：`pages/leaderboard/`、`components/photoRank`、`components/achievementRank` 已在 v4.0.53 审计中删除）
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
4. 改完跑：单测 47 例 + `verify-demo-data.js` 66 项（真实数据不变量口径；一次就够，不要来回验）
5. 升 `config.js` 的 `app_version`，commit message 带版本号
6. 有持久价值的新结论 → 追加到本文件（不要写 `.workbuddy/memory/`）
