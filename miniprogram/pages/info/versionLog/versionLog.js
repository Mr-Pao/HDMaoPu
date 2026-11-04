import {
  text as text_cfg
} from "../../../config";

const share_text = text_cfg.app_name + ' - ' + text_cfg.info.row_version;

Page({
  data: {
    text_cfg: text_cfg,
    update_log: [
      {
        version: "v4.0.0",
        content: [
          "品牌化为「火大猫谱」，启用全站绿色主题",
          "数据层改为 Git 仓库 JSON + 腾讯云 COS 静态分发，去掉云开发依赖",
          "新增猫猫数据看板、五维评分、猫际关系、拍照识猫",
          "管理后台按「一个对象一个入口」重组",
          "新增审核期开关与首页管理暗门"
        ],
        time: "2026/11/04"
      }, {
        version: "v3.1.0",
        content: [
          "整合EMAS函数，节省部署费用",
          "提升性能"
        ],
        time: "2026/6/27"
      }, {
        version: "v3.0.0",
        content: [
          "迁移到EMAS",
          "新增喵ID海报生成功能",
          "新增关注猫猫功能",
          "新增管理员数据看板",
          "更新个人主页",
          "修复部分BUG"
        ],
        time: "2025/10/6"
      }, {
        version: "v2.2.2",
        content: [
          "修复评分bug"
        ],
        time: "2024/5/23"
      }, {
        version: "v2.2.1",
        content: [
          "修复猫猫部分UI问题",
          "修复重复评分bug"
        ],
        time: "2024/5/22"
      }, {
        version: "v2.2.0",
        content: [
          "新增猫猫评分",
          "修改关于页统计数和文档链接",
          "优化首页白屏提示",
          "优化徽章榜单的统计效率",
          "优化图像处理功能"
        ],
        time: "2024/5/22"
      }, {
        version: "v2.1.1",
        content: [
          "修复点赞榜单"
        ],
        time: "2023/7/25"
      }, {
        version: "v2.1.0",
        content: [
          "徽章系统上线啦~",
          "新增徽章兑换码系统&徽章赠送记录",
          "修改精选Tab为榜单",
          "修改留言板为便利贴墙",
          "修复科普页图片等问题",
          "修复关于页数字不显示的问题",
          "修复首页空白问题"
        ],
        time: "2023/7/24"
      }, {
        version: "v2.0.2",
        content: [
          "首页添加Tips"
        ],
        time: "2023/7/20"
      }, {
        version: "v2.0.1",
        content: [
          "主题色调改为绿色"
        ],
        time: "2023/7/14"
      }, {
        version: "v2.0.0",
        content: [
          "小程序重新部署上线啦"
        ],
        time: "2023/7/13"
      }
    ]
  },

  onShareAppMessage: function () {
    return {
      title: share_text
    };
  }
});
