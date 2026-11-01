# AGENTS 归档：历史版本条目原文

> 从项目根 `AGENTS.md` 搬出的历史版本条目完整原文（2026-11-01）。`AGENTS.md` 有 65536 字节的 workspace instruction budget，主文件只保留当前有效要点，完整细节看这里。

---

## v4.0.33 去掉管理口令锁屏门（原 AGENTS.md 行 207–216）

- **v4.0.33：去掉管理口令锁屏门（2026-11-01）**
  - **用户要求（m00463）：「可以去掉口令吗」**，追问后用户选择**「只去掉客户端的口令输入」**——页面不再有锁屏门，进页面直接可用；**提交仍带口令**，服务端 `scripts/process-inbox.js` 的 `tokenOk()` 与 `REVIEW_PASSCODE` 一字未动（那是唯一真权限边界）。**明确否决的方案**：把口令写死进 `config.js`（小程序包可解，等于公开管理权）、服务端也去掉校验。
  - **新增 `miniprogram/utils/passcode.js`（76 行，CommonJS）**：`KEY = "manage_passcode"`；导出 `getToken() / hasToken() / setToken(v) / promptToken(options)`。`setToken` 传空串 = `wx.removeStorageSync`。`promptToken` 用 `wx.showModal({ editable: true, ... })`，**绝不能传 `content`**（editable 模式下 content 会变成弹窗说明文字且输入框无法预填），用户输入在 `res.content`；确认后非空保存、空串清除，两种都回调 `options.onSaved`；全程 try/catch 不 throw。
  - **口令改为永久有效**：删掉了 `PASSCODE_TS_KEY = "manage_passcode_ts"` / `PASSCODE_TTL = 24*60*60*1000` 与 `hasValidPasscode()`，不再有 24 小时过期。storage key 仍是 `manage_passcode`（与 review 页共用）。
  - **`miniprogram/pages/manage/admin/admin.js`（457 行）**：删 `PASSCODE_KEY/TS_KEY/TTL`、`hasValidPasscode/onPasscodeInput/unlock/lock`、`data.unlocked/passcode`；改 `const passcode = require("../../../utils/passcode");`（:18）。`onLoad:93` 设完 tab 后**无条件** `this.loadCurrentTab()`（:110，原 `afterUnlock` 改名）；新增 `onShow:103` 只同步 `hasToken` 不重载数据；`getToken:162` → `passcode.getToken()`；新增 `editToken:121`（右上角按钮，成功 toast「口令已保存」/「已清除口令」）与 `ensureToken(token):133`（无口令时弹「还没设置管理口令 / 提交需要管理口令，否则后台会直接丢弃。现在设置吗？」confirmText「去设置」）。三个提交点 `saveCat:231`/`togglePhoto:308`/`saveLinks:431` 都是先 `const token = this.getToken();` → `if (!this.ensureToken(token)) return;` → `putInbox` **复用同一 token 变量**（不再二次 getToken）。`saveCat` 的检查放在「请先选择猫猫」之后，保持原提示优先级。
  - **`miniprogram/pages/manage/admin/admin.wxml`（170 行）**：`.gate` 整块删掉、`<block wx:else>` 拆包；`.head-lock:7` 由 `bindtap="lock"`「退出管理」改成 `bindtap="editToken"`「口令」；`.head-tip:9` 换新文案；新增 `.token-tip:10`（`wx:if="{{!hasToken}}"`，bindtap=editToken）。`admin.wxss`（296 行）删 `.gate` 整组（原 :11–68 含 `.gate-btn::after`），新增 `.token-tip:39`（`--dk-accent-soft` 底 / `--dk-accent` 字，无新增 hex）。
  - **`miniprogram/pages/manage/review/review.js`（159 行）与 `.wxml`（18 行）**同样处理：`onLoad:45` 直接 `loadQueue()`，`onShow:50`，`onPullDownRefresh:55` 去掉 unlocked 判断，`editToken:60`，`ensureToken:114`，`decide:127` 前置检查 + `passcode.getToken():131`。`.head-lock:7` 文案「锁定」→「口令」。`review.wxss` 删 `.gate` 整组（含 `.gate-error`）。
  - ⚠️ **`review.wxml` 从 65 行缩到 18 行**（gate 块占了大头），别以为文件被截断了。
  - 自检口径：`grep -E 'hasValidPasscode|onPasscodeInput|PASSCODE_TS_KEY|PASSCODE_TTL|PASSCODE_KEY|gate-|afterUnlock|unlocked'` 在 `miniprogram/pages/manage/` 下 **0 命中**；`hidden` 属性 **0 处**（全部 wx:if/wx:elif/wx:else，避开 v4.0.27 记的坑）；wxml 标签平衡 admin 49/49 view、4/4 block、6/6 picker，review 21/21 view；wxss 花括号 41/41、25/25。
  - `scripts/`、`.github/`、`data/`、`app.json`、`project.config.json`、`miniprogram/app.wxss` **零改动**。

---

## v5.4 主题色强化（原 AGENTS.md 行 217–227）

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

---

## v4.0.31 管理后台拆成三个独立入口（原 AGENTS.md 行 228–232）

- **v4.0.31：管理后台拆成三个独立入口（去掉页内 tab）**
  - **用户要求（2026-11-01）「不单独做管理后台按钮，把功能直接加在现有的管理后台列表里」，并补充「入口和审核队列并列，猫资料编辑 / 照片审核 / 友情链接三个都拿出来」**。→ 「关于 → 管理后台」网格里的单独「管理后台」项**已删除**，换成三项并排：`猫资料编辑`（`icon-edit`）/ `照片审核`（`icon-photo-o`）/ `友情链接`（`icon-cluster-o`），紧跟在「审核队列」后面。原来的「照片审核」项原本 `disabled: true` 指向未注册死页 `pages/manage/checkPhotos`，现已换成能跑的管理页。
  - **同一个页面复用三种形态**：`pages/manage/admin/admin` 靠 query `?tab=cat|photo|link` 决定显示哪一块；`onLoad(options)` 里 `const tab = TAB_META[(options && options.tab) || ""] ? options.tab : "cat";` 兜底（`TAB_META = {cat:"猫资料编辑", photo:"照片审核", link:"友情链接"}`），**同时 `wx.setNavigationBarTitle({title: TAB_META[tab]})`**，页内标题与口令门标题都改成 `{{pageTitle}}`。**页面内已没有 tab 栏**：`admin.wxml` 的 `.tabs` 块、`admin.js` 的 `switchTab()`、`admin.wxss` 的 `.tabs/.tab/.tab-active` 三组样式全部删除（当前残留检查为 0）。
  - **首次加载改为 `afterUnlock()`**：`if (tab === "link") loadLinks(); else loadCats();`。`unlock()` 里原来写死的 `this.loadCats()` 改为调 `afterUnlock()`——否则从「友情链接」入口进来解锁后猫列表白拉一次、链接反而不加载。照片 tab 仍需用户先选猫再 `loadPhotos(idx)`，不做自动加载。
  - **`info.js` 的 `clickbtn`** 只做 `wx.navigateTo({url: to})`，query 参数原样透传，无需改跳转逻辑。⚠️ 该函数有 `actionMap`（`clearCache`/`guide`）优先匹配，路径里带 `?` 不会影响匹配。

---

## v4.0.30 友情链接可手动增删（原 AGENTS.md 行 233–239）

- **v4.0.30：友情链接改为可手动增删（管理后台入口）**
  - 入口在 `pages/manage/admin/admin`（原有口令门内），tab 从 `cat | photo` 扩成 **`cat | photo | link`**。数据仍存在 `data/setting.json` 的 `_id='friendLink'` 记录里，schema 不变：`{_id:'friendLink', apps:[{appid, name, logo}]}`。
  - **写入链路**：客户端 `saveLinks()` → `putInbox('manage', {action:'saveFriendLinks', token:this.getToken(), apps})` → `scripts/process-inbox.js` 的 `handleManage` 新分支 `manageSaveFriendLinks(data)`；服务端 `tokenOk()` 校验 `REVIEW_PASSCODE`，整体**替换** `apps` 数组（不是增量），`markTouched('setting')` 让 `data/setting.json` 被写回并随 `sync-data.yml` 上 COS。客户端 `datasource` 的 updateOne **不能用来改这里**——它只写本地覆盖层，不回传远端。
  - **服务端校验（`normalizeFriendApp`）**：`APPID_RE = /^wx[0-9a-zA-Z]{16}$/`、`name` 非空且 ≤20 字、`logo` ≤300 字符且可空、按 appid 去重、上限 `FRIEND_LINK_MAX = 20`。失败返回 `drop:no-apps` / `drop:bad-friend-app` / `drop:too-many-links`；成功 `ok:friend-links`。
  - **admin 页新增**：`data.links/linkLoading/linkSaving/linkDirty/draft{appid,name,logo}`；方法 `loadLinks()`（`linkDirty` 时不覆盖，避免冲掉未保存编辑）、`onDraftInput`、`addLink`（同样的正则与去重前校验，纯本地）、`deleteLink`（`wx.showModal` 二次确认）、`moveLink`（↑↓ 调序）、`saveLinks`。`switchTab` 切到 link 时才懒加载。
  - **展示端改了缓存策略**：`pages/info/info.js` 把原来写在 `onLoad` 里的 friendLink 查询抽成 `loadFriendLinks()`，`onShow` 调用，5 分钟节流（`this.jsData.linkFetchedAt`）——否则改完后台要重进小程序才看得到。`info.wxml` 整块包 `wx:if="{{friendApps.length}}"`（空列表不再显示空标题），无 logo 时用首字占位 `.friend-link-ph`。
  - `data/setting.json` **没有本地改动**，线上靠 Actions 聚合写回；自测用 `DRY_RUN=1 REVIEW_PASSCODE=xxx node scripts/process-inbox.js`，`selftestObjects()` 里已有 offset 21（合法）/22（非法 appid）两条 manage 用例，`snapshot()` 会打印 `friendLinks` 名称数组。

---

## v4.0.30/32 提交后延迟生效提示（原 AGENTS.md 行 240–247）

- **v4.0.30：提交后「延迟生效」提示（用户需求：数据/照片走 Actions，小程序不能实时显示）**
  - **根因三段延迟**：① `utils/writeback.js:75` `putInbox(kind, data)` 匿名 PUT 到 COS `inbox/`，`WRITEBACK_TIMEOUT = 8000`，**永远不 reject**，失败只 `console.warn` 返回 false；② `process-inbox.yml` cron `*/5 * * * *` 聚合成 `data/*.json`，`sync-data.yml` 再推 COS；③ `datasource` SWR 的 `CACHE_TTL` 10 分钟。→ 提交后只有当前页乐观更新，重进页面/他人最长等 5~15 分钟，照片留言还要人工审核。旧文案（`'张贴成功~'` / `'提交成功'` / `'审核后就会展示出来啦'`）让用户以为失败而反复提交。
  - **新增 `miniprogram/utils/syncTip.js`（157 行，唯一新增文件）**：`module.exports = { markPending, getPending, getPendingCount, clearPending, submittedModal, pendingText }`。`STORAGE_KEY = "pending_sync"`、`MAX_ITEMS = 20`、`TTL = 2*60*60*1000`；存 `[{kind, cat_id, label, ts}]`，**同 kind+cat_id 覆盖 ts 不重复追加**，读时清理过期并写回。**所有函数同步、异常全吞、绝不 throw**，不影响提交主流程。`submittedModal(content, title)` 是对 `wx.showModal` 的封装（`showCancel:false`、`confirmText:"知道了"`）。
  - **`config.js:124-132` 的 `text.sync` 键（v4.0.32 收敛后 6 个）**：**`received_tip:"已收到，审核后就会展示出来啦"`（所有提交成功提示的唯一来源，改文案只改这一句）**、`submitted_title:"已收到"`、`offline_tip:"网络不太好，这次可能没提交成功"`、`pending_title:"等待同步"`、`pending_tip:"你还有 {n} 条内容正在等待同步 · 约 5~15 分钟后生效"`、`pending_close:"关闭提示"`。⚠️ 原 `delay_tip` / `review_tip` 已删（合并进 `received_tip`）；`add_photo.success_tip_title` / `success_tip_content` 也已删。
  - **提交点接入（v4.0.32 统一文案）**：`addPhoto.js:148-153`（单张）/`:197-202`（批量）、`commentBoard.js:320`、`ratingDetail.js:180`、`feedbackDetail.js:166`（`ok ? text_cfg.sync.received_tip : text_cfg.sync.offline_tip`）、`applyAdoption.js` 提交成功弹窗（v4.0.32 新增 `import config`，`title: config.text.sync.submitted_title` / `content: config.text.sync.received_tip`）。⚠️ **`commentBoard.js` 没有 `text_cfg` 变量，只有 `import config`**，写 `text_cfg.sync.*` 会 ReferenceError。`addPhoto.uploadImg` 改为 **`return !!ok`**，单张/批量按 ok 分支：成功 → `received_tip`，失败（含任一张网络失败）→ `offline_tip`。⚠️ 这是**行为收敛**：旧 `uploadAllClick` 无论成败都弹成功，属修 bug。
  - ⚠️ **`addPhoto.js:133` 的 loading 文案曾是 `success_tip_title`（“上传成功！”）**——上传过程中菜单显示“上传成功”是旧 bug，v4.0.32 已改为 `uploading_tip`（“正在上传...”）。
  - **detailCat 顶部可关闭提示条**（这是用户能持续看到的唯一入口）：`detailCat.js:30` import，`:99-101` 三个 data 字段 `pendingCount / pendingText / syncTipHidden`，`onShow`（`:168-181`）读 `getPendingCount(this.jsData.cat_id)` 并 `pendingText(n)`，try/catch 包裹；`:184-186` `dismissSyncTip()` **只 setData 隐藏，不清本机记录**。`detailCat.wxml:18-24` 用 **`wx:if="{{pendingCount > 0 && !syncTipHidden}}"`**（不是 `hidden`，避开 v4.0.27 记的那个坑），右侧 `×`。`detailCat.wxss:1046-1083` 的 `.sync-tip` 系列用 `--dk-accent-soft` 底 / `--dk-accent-line` 边 / 20rpx 圆角 / margin 24rpx。
  - **刻意不做的**：detailCat 的点赞/关注不弹窗、不 markPending（交互太频繁）；没新增页面，没碰 `app.json` / `project.config.json` / `app.wxss` token。

---

## v4.0.29 标题字号 + tab 改名（原 AGENTS.md 行 248–251）

- **v4.0.29：四页标题字号统一 + tab 改名「猫片」+ 猫抓板两篇示例**
  - **标题字号**：猫谱页 `.nav-t` 在 v5.2 精修里被放大到 **52rpx**（`genealogy.wxss:1144`），而猫抓板/关于页仍用 `app.wxss:345` 的全局 `.nav-title` **46rpx** → 三页标题大小不一。修法是在 `news.wxss`、`info.wxss` **各自尾部追加 `.nav-title` 覆盖**（52rpx / line-height 56rpx / 800 / letter-spacing -1.6rpx / margin-top 10rpx），**不动 `app.wxss`**。猫图页没有大标题（全屏漂流墙，顶部只有 `.hud-kicker` 22rpx 的「CAT GALLERY」标识），属刻意设计，不要强行补。
  - **tabBar 文案「猫图」→「猫片」**：只改 `custom-tab-bar/tab.js:12` 的 `text`。`gallery.json` 的 `navigationBarTitleText`、`gallery.js:94` 分享标题、`config.js` 的 `share_tip: "猫图墙"`、`catInfoTab`/`addCat` 的「加载更多猫图」**全部保持「猫图」不动**（用户只要求改 tab 文案，别顺手全局替换）。
  - **猫抓板两篇示例新闻**（`data/news.json` 空表 → 2 条）：`news-xiaobai-northgate`（小白出没｜北门花坛的独行侠，class=其他，cover=小白 001，photosPath 3 张，`setNewsModal: true` 会推首页弹窗）、`news-feed-guide`（投喂指南｜别让好心办坏事，class=活动，cover=奶盖 001，photosPath 4 张，`setNewsModal: false`）。⚠️ **`coverPath`/`photosPath` 必须写完整 COS URL**——`signCosUrl` 是直通函数、`datasource._merged` 不拼前缀，写 `photos/xxx.jpg` 这种相对路径会 404（旧 demo 数据就是错的，别照抄）。

---

## v4.0.27 位置文案 + 缓存失效 + 抽屉回退（原 AGENTS.md 行 252–259）

- **v4.0.27：全站「校区」文案改「位置」+ 配置缓存版本失效 + 抽屉骨架回退原版**
  - **抽屉骨架必须沿用原版**（用户三次纠正："抽屉还是和原来一样，下拉，只改里面的三行，你在乱动什么"；v5.3 曾把它改成底部弹层，用户截图骂"我说了筛选要做成向下摊开的抽屉"）：`#filter-block` 用 `style='height: {{heights.windowHeight - heights.filters}}px'` + 半透明黑遮罩，内容**贴顶**（`display:flex; flex-direction:column; justify-content:flex-start;`），`.fsheet` 是**向下摊开**的卡片（`border-radius: 0 0 36rpx 36rpx`，阴影朝下，可加 `@keyframes sheetDown` 从上滑落），内部依次 `.filters`（三行胶囊）/ `.divider` / `.buttons`（左「重 置」`fRowReset`、右「完 成」`fHide`，`filters_legal` 时右侧变主色）。**绝不能再做成 `justify-content:flex-end` + `border-radius:36rpx 36rpx 0 0` 的底部弹层**，也不要自创 `.fpanel` / `.fbar-head` / 绿色 `.fbar-done`，这几套都已被明确否掉。
  - ⚠️ **`hidden` 属性会被 CSS `display` 覆盖**（2026-11-01 踩坑，表现是"编译完抽屉就自己开着、关不掉、页面像卡住"）：`hidden` 只是 UA 的 `[hidden]{display:none}`，作者样式 `#filter-block{display:flex}`（id 选择器优先级更高）直接把它顶掉，`filters_show` 一直是 false 但抽屉常显。修复：开关一律用 **`wx:if='{{filters_show}}'`**，不要用 `hidden`。（同理，别给可能被 hidden 的元素写 `display:flex/block` 除非配 `[hidden]{display:none!important}`。）
  - `.frow-k` 行标签宽度必须 ≥ 80rpx 且 `white-space: nowrap`：v5.3 写的 `width:44rpx` 装不下「位置/花色/状态」两个字，被压成竖排并裁掉半个字。
  - **全站「校区」→「位置」**：`miniprogram/` 下 20 个文件、36 处文案已批量替换（`catInfoTab`、`addCat`、`checkComment`、`checkPhotos`、`dashboard`「位置分布」、`filters`「位置选项/新增位置」、`managers` 权限说明、`map`、`recognize`「所有位置」、`info`「位置/区域/花色」、`utils/cache.js` 注释）。`data/news.json` 的「我们在南校园设置了 6 个保暖猫窝」改为「我们在校园里设置了」，`miniprogram/utils/demo.js` 的 MOCK_CATS 11 条 `campus` 与 `MOCK_SETTINGS.filter` 同步改成校内/校外/其它。**复查 `grep -rn 校区 miniprogram/ --include=*.js --include=*.wxml --include=*.json` 必须为 0**。
  - **猫卡位置拼接要留空格**：`campus` 从「南校园」变「校内」后，`campus + area` 会粘成「校内北门花坛」，两处已改成 `campus + ' ' + area`（`genealogy.wxml:106`、`detailCat.wxml:82`）。
  - **配置缓存的版本失效机制（本次踩坑的根因）**：`utils/page.js` 的 `_getSetting` 用 `cacheTime.pageSetting = 24*7` 小时写 storage，**发版改 campus/colour/fullTab 后老用户最长 7 天看不到新值**——这就是用户真机上仍显示「南校园」的原因。两处修复：① `loadFilter()` / `getGlobalSettings()` 默认强制 `nocache: true`（只借 datasource 的 10 分钟 SWR 缓存），且 nocache 时**不落盘**；② `app.js` 新增 `_migrateConfigCache()`，在 `checkCacheValidity()` 开头用 `app_version` 当哨兵，版本变化就删掉 `setting-*` / `ds_cache_setting` / `genealogy-fcampus` 三类键（猫数据缓存不动，避免断网空列表）。⚠️ `tests/cache.test.js` 里直接种 storage 的用例**不带 epoch 字段**，所以 `cache.js` 内部**不能**加版本字段校验，哨兵只能放在 `app.js` 这层，否则挂 2 例。


---

## v4.0.26 筛选抽屉三行胶囊（原 AGENTS.md 行 260–268）

- **筛选抽屉改三行胶囊 + 位置三分类 + 花色精简（v4.0.26）**：首页导航栏右侧保留原筛选按钮（`<view class='filter-btn' bindtap='fToggle'>`，`filters_active` 时换 `filter_y.png`），点开的**抽屉里**改成用户给的三行样板（顶部 `{{catsMax}} 只猫猫` + 右侧「重置」，三行胶囊，每行首颗「全部」高亮，底部绿色「完成」）。
  - ⚠️ 曾误把三行做成常驻栏并删掉筛选按钮，被用户否掉（"保留筛选按钮啊，只是弹出来的抽屉做成这三行"）——筛选按钮必须在，三行只在抽屉里。
  - 数据模型从"两级 category 联选"改成**每行一维 options**：`filters = [{key, name, all_active, options:[{name, cond, active, count}]}]`，三行依次 `campus`(位置) / `colour`(花色) / `state`(状态)。`loadFilters()` 在 `genealogy.js:249-308` 重建。
  - 第三行「状态」7 个值（用户定的）：已领养 `{adopt:1}` / 寻找领养中 `{adopt:2}` / 待绝育 `{sterilized:false}` / 已绝育 `{sterilized:true}` / 未失踪 `{missing:false}` / 已失踪 `{missing:true}` / 去往喵星 `{to_star:true}`。**状态互斥**，`_rowConditions()` 里多选要包成 `{$or: [...]}`，不能像位置/花色那样用 `$in`（那三个 cat 字段是数组/字符串单值）。
  - 关键函数：`fCheckLegal` / `_rowConditions` / `_conditionsOf(filters, skipRowIndex, onlyIndex)` / `fGet` / `updateCounts`（每颗胶囊按"其他行条件 + 本行该选项"算 count）/ `applyFilters` / `fRowAll` / `fRowOpt` / `fRowReset` / `_nextHeroMode`。旧的两级联选函数（`fShow`/`fClickMain`/`fClickCategory`/`fClickSub`/`fComfirm`/`fReset`/`fClickCampus`）已全部删除。
  - `hero_mode` 联动：`_nextHeroMode(filters)` = 所有行都 `all_active` 时回 `''`（第一格高亮），否则 `'custom'`；`heroFilter()` 也已改写到新模型（点「待领养」= 把 state 行的「寻找领养中」置 active）。
  - **位置 = 校内 / 校外 / 其它**（原只有「南校园」一个校区值）：`cat.campus` 按 area 映射重写（北门花坛/法学院边草坪/荣光堂/图书馆广场/英东体育场/园东湖/逸夫楼→校内；第一教学楼/怀士堂→校外；东门/惺亭→其它）。`data/filter.json` 与 **`data/setting.json` 内嵌的那份 `_id='filter'`** 都要改——`utils/page.js:27` 的 `loadFilter()` 读的是后者，`filter.json` 只是历史副本。
  - **花色精简为 7 类**（用户给清单）：橘色 / 黑色 / 白色 / 狸花 / 三花 / 玳瑁 / 重点色。映射：橘、橘白→橘色；黑、奶牛、黑白、黑灰→黑色；白→白色；狸花、彩狸、狸白、棕→狸花；其余直通。同步改了 `data/cat.json`、`data/setting.json`、`data/filter.json`、`miniprogram/utils/demo.js` 的 MOCK_CATS。
  - 首页每页条数 `pages.genealogy.catsStep` 由 3 改为 **10**（`data/setting.json`）；代码默认值仍是 12，以远端配置为准。

---

## v4.0.24/25 首页 hero 数据卡（原 AGENTS.md 行 270–280）

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

---

## v4.0.23 用户档案体系放弃（原 AGENTS.md 行 281–286）

- **用户档案体系已整体放弃（v4.0.23）**：根因是 `utils/datasource.js:27` 的 `OPENID_STORAGE_KEY = 'fake_openid'` + `_getOrCreateOpenid()`（`:1229-1237`）生成 `guest_xxxxxxxx` 存本地，**与微信账号完全无关**，换设备/清缓存/重装就是新人；而 `data/user.json` 从没有 nickname 字段、`scripts/process-inbox.js` 里一次 `loadData('user')` 都没有，用户昵称压根不上传。要做真跨设备只能接 `wx.login` → 服务端 code2session，和「月成本 ≤5 元、不引服务器」的红线冲突 → 用户拍板：**不做档案，每个提交场景当场自己填昵称，不填就是匿名用户**。
  - 删掉的 4 个页面（共 20 文件）：`pages/info/userInfo/`（个人主页，含子目录 `modifyUserInfo/`）、`pages/info/myFollowCats/`、`pages/info/myAdoption/`、`pages/info/feedback/myFeedback/`。连带 `app.json` 34→30 页、`packOptions.ignore` 19→18 项、`info.js` 的 `data.cards` 5→2（只剩投喂罐头 / 程序开发）、`info/feedback/feedback.js` 的 `toMyFeedback()`、`utils/user.js` 的 `toSetUserInfo()`、`utils/msg.js:130` 订阅消息跳转页改 `pages/info/info`。
  - **`components/modifyUserInfo/` 整目录已删除**，全仓 0 引用。v4.0.19–v4.0.21 那套「json 注册组件 + 点此设置头像昵称」的旧范式**已作废，别再照着抄**。
  - 就地填昵称范式（5 页统一）：`data.nickname: ''` → `onShow`/`onLoad` 用 `wx.getStorageSync('last_nickname') || ''` 预填 → `<input>` 就地输入（`maxlength=20`）→ 提交前 `wx.setStorageSync('last_nickname', this.data.nickname)` → 空值一律兜底 `'匿名猫友'`。落地位置：`commentBoard`（悬浮输入区顶部，textarea 上方）、`feedbackDetail`（表单最上方，标题「正在为「猫名」反馈信息」下；`.adminEntry` 管理员「添加猫际关系」入口保留不动）、`modifyNews`（表单第一项）、`addPhoto`（删掉 `!isAuth` 等待授权层，上传表单常显，只留「正在为「猫名」添加照片」提示；摄影师仍走原有 `inputPher`，匿名直传 COS 链路一字未动）、`ratingDetail`（**不加**昵称框，评分本就匿名；`putInbox('rating', {cat_id, score, dims})` 保持无 nickname 字段，否则会破坏 `process-inbox.js` 的聚合 schema）。
  - 昵称只在本机记忆（`last_nickname`），换设备自然丢失——这是已接受的取舍，别再提"恢复码/微信登录"方案。
  - 遗留死代码（不影响运行）：`components/photoRank/` 仍留着 `bindtap='getUInfo'` 与 `setData({showEdit:true})`，但该组件只被未注册死页 `pages/leaderboard` 引用且组件已无从打开；`utils/user.js` 的 `getPageUserInfo()` 也还在，现存调用点只剩 `applyMapAccess.js:34`（ignore 死页）与 `photoRank.js:31`（上述死组件）。以后新增页面用 `getUser()`，别调 `getPageUserInfo`（它在无 `userInfo` 时直接 `return false`，不设 `isAuth`/`user`，会让 `wx:else` 分支永不渲染 = 空白页）。

---

## 照片归属重建工具（2026-11-01 建）（原 AGENTS.md 行 319–331）

背景：桶里 `compressed/` 298 张真实猫照私有读且猫↔照片归属随 EMAS 空间删除永久丢失，靠人肉眼认照片重建映射。三步：

1. **`scripts/relink-scan.js`**（本地跑，需密钥）：`getBucket` 列 `compressed/` 前缀图片 → `putObjectCopy` 到 `photos/relink/001.jpg`（public-read）→ 生成项目根 `relink-workbench.html`（内联 11 只猫 + 照片 URL 数组）。**先复制第 1 张验证 CopySource 编码，失败打印原始错误中止**；`CopySource` 按 `/` 分段 `encodeURIComponent`，报 NoSuchKey 回退整 key 编码。`DRY_RUN=1` 用现有 11 张 cover.jpg 生成演示 html。
2. **`relink-workbench.html`**（用户认猫，零密钥）：自包含单文件，CSS columns 瀑布流，点卡片弹猫名按钮组 +「跳过(不是猫)」，进度存 localStorage（key `relink-workbench-v1`），导出 `relink-result.json`。
3. **`scripts/relink-apply.js`**（本地跑，需密钥）：读 `relink-result.json`（结构 `{exported_at, photos:[{src,cat_id,action:assign|skip}]}`）→ 对 assign 照片 `putObjectCopy` 到 `photos/<cat_id>/<4位序号>.jpg` → 追加 `data/photo.json` 记录（`_id=relink-photo-<n>`、`marker_type` 复用该猫现有值、`best:false`、三 URL 同源）→ 累加 `data/cat.json` 的 `photo_count_total` → 写回 data/ 并 `putObject` 上传两份 JSON（public-read）。

**关键实现点（改这里前必读）**：
- 密钥读取顺序：`process.env` → 手写解析项目根 `.env`（无 dotenv 依赖；`scripts/package.json` 仍只依赖 `cos-nodejs-sdk-v5`）。`.env.example` 是模板，真实 `.env` 已进 `.gitignore`。
- **同一只猫认领多张时序号必须递增**：`nextSeqByCat` 初始值 = 现有最大序号，每分配一张 +1（初版 bug 是 `nextSeqForCat` 每次都基于复制前固定列表算，同猫第 2 张会覆盖第 1 张，已修）。
- `relink-workbench.html` / `relink-result.json` / `.env` 均在 `.gitignore`，不进版本控制。
- 本地跑 scan/apply 前需先在 `scripts/` 下 `npm install`（`cos-nodejs-sdk-v5` 未随仓库装）；dsh 运行时 node 可用 `C:/Users/yzx49/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`。
