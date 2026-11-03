// *** 修改指引 *** //
// 只修改双引号内部的文字，不要修改没有双引号包裹的文字，否则会导致程序出错！
// 不要删除设置项，例如识猫页，删除会导致编译出错！
// 修改时频繁保存、频繁编译，发现改错了立马撤销

// 敏感配置从 appSecret.js 加载（已在 .gitignore 中）
const secrets = require('./appSecret.js');

module.exports = {
  // 版本号
  app_version: "v4.0.70",
  // 【离线 Demo 模式】
  // true  = 不连任何后端，使用 utils/demo.js 里的假数据（11 只猫 + 照片 + 设置）
  // false = 走下面的 data_base_url（COS 上的静态 JSON）
  // 注意：如果 data_base_url 拉不到数据，页面会是空列表（不是白屏），
  //       把这里改回 true 就能看到假数据，方便排查是小程序的问题还是数据的问题。
  demo_mode: false,
  // 【COS 数据文件根地址】末尾不带斜杠。
  // 小程序会去 GET {data_base_url}/data/cat.json、data/photo.json ……
  // 留空则退回 demo_mode 的本地假数据
  data_base_url: "https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com",
  // 【inbox 写入通道开关】
  // true  = 写操作（人气/关注/点赞/评分/审核决定）会 PUT 到 COS 的 inbox/ 前缀，
  //         由 GitHub Actions 每小时聚合成 data/*.json（客户端不放密钥，桶只开放 inbox/* 匿名写）
  // false = 一键关掉写通道，只保留本地覆盖层（离线可用，但换设备就丢）
  writeback_enabled: true,
  // 【管理口令】已移出小程序包：管理员在小程序内手动输入，只存手机本地 storage，
  // 真正的校验在 GitHub Actions 端（REVIEW_PASSCODE），口令不对的提交会被丢弃
  // v4.0.33 起不再有锁屏口令门，右上角「口令」按钮输一次永久保存
  // 【照片上传开关】v4.0 暂时关闭
  // 原因：原来靠云函数 unionOp/getURL 签发 COS 临时密钥，现在没有云函数了，
  //       小程序端拿不到上传凭证，一点上传就报错。
  // 恢复上传有两条路：① 内置只授权 pending/* 的受限密钥 ② 接一个签发服务。
  // 定下来之后把这里改成 true 即可，页面代码不用动。
  photo_upload_enabled: true,
  // 小程序appid（从敏感配置文件加载）
  app_id: secrets.app_id,
  // EMAS空间ID（从敏感配置文件加载）
  space_id: secrets.space_id,
  // 服务空间 secret key（从敏感配置文件加载）
  space_secret: secrets.space_secret,
  // 服务空间地址Api Endpoint
  space_endpoint: "https://api.next.bspapp.com",
  use_private_tencent_cos: true,
  // 私有的腾讯云cos签名过期时间（秒）
  sign_expires_tencent_cos: 3600 * 2,

  // 科普页图片
  science_imgs: [
    `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/科普1.png`,
    `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/科普2.png`,
    `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/科普3.png`,
    `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/科普4.png`,
    `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/科普5.png`
  ],

  // 赞赏码图片
  reward_img: `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/赞赏码.jpg`,
  // 新猫问卷图片
  feedback_wj_img: `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/新猫问卷.png`,
  // 小程序菊花码图片
  mpcode_img: `https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/菊花码.jpg`,

  // 猫猫领养状态字符串，对应数据库cat.adopt中的数字下标
  cat_status_adopt: ["未领养", "已领养", "寻找领养中"],
  // 首页漂浮的领养Logo对应的状态
  cat_status_adopt_target: "寻找领养中",

  // 各种文字内容
  text: {
    // 小程序名
    app_name: "火大猫谱",
    // 首页，pages/genealogy/genealogy
    genealogy: {
      share_tip: "发现身边校园猫咪",
      search_tip: "搜索猫猫名字或昵称",
      new_photo_tip: "有新相片！",
      no_photo_tip: "暂无封面照片...",
      photo_by_tip: "Photo by ",
      photo_by_unknow_tip: "匿名猫友",
      photo_loading_tip: "加载照片ing",
      to_star_tip: "返回喵星",
      traits_empty_tip: "未登记",
    },
    // 关于页，pages/info/info
    info: {
      share_tip: "关于",
      slogan: "猫不提供服务，猫只提供它本身。",
      // 分节标题
      friends: "友情链接",
      about: "关于",
      // 「关于」竖列表行（前两条是功能入口，后两条是信息行）
      row_reward: "投喂罐头",
      row_reward_value: "去投喂",
      row_dev: "程序开发",
      row_dev_value: "去了解",
      row_version: "版本",
      row_contact: "联系作者",
      row_contact_value: "发消息",
    },
    // 猫猫详情页，pages/genealogy/detailCat/detailCat
    detail_cat: {
      bottom_text_loading: "LOADING...",
      bottom_text_end: "- THE END -",
      popularity_tip: "猫咪点赞数",
      comment_tip: "猫猫留言数",
      button_feedback: "猫咪信息纠错",
      label_nickname: "昵称",
      label_location: "常驻地",
      label_birthday: "生日",
      label_father: "爸爸",
      label_mother: "妈妈",
      label_friend: "好友",
      label_character: "性格及特点",
      label_tutorial: "撸猫指南",
      label_tutorial_empty: "暂时还没有",
      label_comment_board: "便利贴墙",
      sterilized_true: "已绝育",
      sterilized_false: "待绝育",
      slogan1: "它们的点点滴滴，由你来记录",
      slogan2: "扫右方小程序码了解更多~",
    },
    // 提交反馈页，pages/genealogy/feedbackDetail/feedbackDetail
    feedback_detail: {
      feedback_title: "反馈内容",
      feedback_tip: "猫猫信息纠错、照片归属权、功能改进等~",
      input_length_tip: "字数",
      contract_title: "你的联系方式",
      contract_tip: "（选填）微信/QQ/邮箱",
      submit_button: "提交反馈",
      submit_tip: "*反馈内容仅后台工作人员可见",
    },
    // 提交后「延迟生效」的统一提示，utils/syncTip.js 与各提交点共用
    // 小程序没有服务器：提交只是 PUT 到 COS 的 inbox/，
    // 由 GitHub Actions 每 5 分钟聚合成 data/*.json 再推回 COS，
    // 所以重新进页面 / 其他用户最长要等 5~15 分钟才看得到，照片和留言还要人工审核。
    sync: {
      // 所有提交成功提示统一用这一句，改文案只改这里
      received_tip: "已收到，审核后就会展示出来啦",
      submitted_title: "已收到",
      offline_tip: "网络不太好，这次可能没提交成功",
      pending_title: "等待同步",
      pending_tip: "你还有 {n} 条内容正在等待同步 · 约 5~15 分钟后生效",
      pending_close: "关闭提示",
    },
    // 提交留言页，pages/genealogy/commentBoard/commentBoard
    comment_board: {
      ban_tip: "如有误封请在\"关于-信息反馈\"中留言~",
      auth_tip: "请先设置头像昵称~",
      comment_tip: "给猫咪留张便利贴吧~"
    },
    // 添加照片，pages/genealogy/addPhoto/addPhoto
    add_photo: {
      auth_tip: "设置头像昵称后上传~",
      uploading_tip: "正在上传...",
      unfinished_tip_title: "提示",
      unfinished_tip_content: "填写信息后再上传哦！",
    },
    // 赞赏页，pages/info/reward/reward
    reward: {
      share_tip: "投喂罐头",
      ad_success_tip: "多谢喵(ฅ'ω'ฅ)!",
      ad_fail_tip: "没播完喵...",
      reward_tip_title: "投喂罐头",
      // reward_tip: "您的投喂及广告收入将用作猫猫救助，每月的收支都会在小程序进行公开，感谢您对火大流浪猫的帮助与支持！\n喵(^･ｪ･^)",
      reward_tip: "暂时无需投喂！感谢您的帮助与支持！\n喵(^･ｪ･^)",
      // reward_count_tip: "* 每月统计一次，在小程序公示，多谢晒（鞠躬）",
      reward_title: "爱心捐款",
    },
    // 排行页，pages/info/photoRank/photoRank
    photo_rank: {
      share_tip: "拍照月榜",
      auth_tip_title: "请授权查看自己的排名",
      auth_tip: "点击授权",
      count_tip: "* 定期自动更新"
    },
    // 反馈页，pages/info/feedback/feedback
    feedback: {
      share_tip: "信息反馈",
      feedback_tip_title: "留下反馈",
      feedback_tip: "每一条反馈我们都会认真看滴",
      new_cat_tip_title: "新的猫猫",
      new_cat_tip: "提交猫谱中没有的猫猫信息，给猫猫上户口~",
      contract_tip_title: "更多联系",
      contract_tip: "有关猫猫信息添加、小程序的建议、照片维权、猫猫领养咨询等事项，请联系Pao_Leo",
    },
    // 开发团队页，pages/info/devTeam/devTeam
    dev_team: {
      share_tip: "开发团队",
      team: "非常欢迎新朋友加入设计开发哇~！",
    },
    // 识猫页，pages/recognize/recognize
    recognize: {
      share_tip: "拍照识猫",
      select_tip: "你可以从相册选择猫猫照片\n或点击下方启用相机权限后直接拍照\n",
      select_btn: "启用相机权限",
      reselect_btn: "重新选图",
      no_cat_tip: "照片里好像没有猫猫",
      multi_cat_tip: "照片里可能有多只猫猫，下面按相似度从高到低排好了",
      no_cat_rec_tip: "看起来，整张照片更像...",
      single_cat_rec_tip: "看起来，这张照片里的猫猫更像...",
      multi_cat_rec_tip: "看起来，这张照片里的猫猫们更像...",
      bottom_tip: "*目前仅拥有十张以上靓照（清晰正面、仅含一只）的猫猫才能被认到哦！多多上传帮忙改进识别效果吧~",
      ad_tip: "识别累了，帮忙点下广告喵（揉眼睛 ( '-ωก̀ )",
      // 以下为 MeowID 接入新增
      no_config_tip: "识猫功能还没配置好，去关于页→管理后台填一下吧",
      unrecognized_tip: "这张照片里的猫猫还没录入猫谱，或者角度太刁钻啦",
      project_mismatch_tip: "项目 ID 和 API Key 对不上，请检查后台设置",
      key_invalid_tip: "API Key 无效，请检查后台设置",
      key_expired_tip: "API Key 已失效或权限不足",
      too_large_tip: "照片太大啦，换一张试试",
      rate_limit_tip: "识别太频繁啦，歇一会儿再试",
      network_tip: "网络不太好，稍后再试试",
    },
    // 科普页，pages/news/sciDetail
    science: {
      share_tip: "科普",
    },
    // 猫图，pages/gallery/gallery
    gallery: {
      share_tip: "猫图墙",
    },
  }
}