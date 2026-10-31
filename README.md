# :pencil:火大猫谱
*——拍照记录校园内猫猫的成长轨迹* :cat::smiley_cat::heart_eyes_cat:
## 主要功能
**猫猫档案**：创建校园猫猫资料档案，猫猫相册，精选瀑布流。

**用户交互**：用户可以上传照片，发表留言，点赞照片或反馈信息。

**丰富功能**：包括拍照识猫，查看科普信息、公告文章等丰富功能。

**管理后台**：部署完成后，资料管理、照片审核等操作均在小程序端完成。

## 体验一下
打开微信，扫码体验：

<img src="./readme/qrcode1.png" height = "150" alt="火大猫谱二维码" />


部署过程中遇到任何问题，可以：
* 加入猫谱技术交流QQ群：956808218
* 在GitHub页面提issue
## 项目结构
```
├── miniprogram/           # 小程序前端代码
│   ├── pages/            # 页面目录
│   │   ├── genealogy/    # 猫谱主页面
│   │   ├── info/         # 个人中心
│   │   ├── news/         # 新闻科普
│   │   ├── leaderboard/  # 排行榜
│   │   ├── followFeed/   # 关注动态
│   │   ├── manage/       # 管理后台
│   │   └── tools/        # 工具页面
│   ├── components/       # 自定义组件
│   ├── packages/         # 第三方包
│   └── custom-tab-bar/   # 自定义底部导航
├── functionsEMAS/        # EMAS云函数
│   ├── unionOp/          # 通用操作函数
│   ├── timeTrigger/      # 定时任务
│   └── temp/             # 临时迁移脚本
└── package.json          # 项目配置
```
## 技术栈
- **前端框架**: 微信小程序原生开发
- **云服务**: 阿里云 EMAS 云开发
- **数据库**: MongoDB
- **云存储**: 阿里云 OSS
## 部署说明
本项目已迁移至阿里云 EMAS 云开发平台。部署前请确保已完成：
1. 注册阿里云 EMAS 账号
2. 创建小程序云开发环境
3. 配置数据库和存储资源
## 资料整理
|资料名|类型|链接|
|:----:|:----:|:----:|
|猫谱-部署文档|文档|https://docs.qq.com/doc/DSGFvWGF4UnVrQ3VN|
|猫谱-管理员手册|文档|https://docs.qq.com/doc/DSEl0aENOSEx5cmtE|
## 开发团队
本项目的开发工作100%用爱发电，特别感谢每一位为此付出的小伙伴。
:computer:代码开发：[Zing22](https://github.com/Zing22)、[Jazon](https://github.com/jxzhn)、[Junius](https://github.com/JunDeer)、[yw](https://github.com/WondrousWisdomcard)、[Lauzeyu](https://github.com/parsifal486)
:black_nib:UI设计：蓝卷、[Junius](https://github.com/JunDeer)、[yw](https://github.com/WondrousWisdomcard)
:notebook:资料整理：笃行志愿服务队及各校区小伙伴
如果你有新的想法或建议，非常欢迎你在QQ群/issue板块发起讨论，或者提交代码PR。
## 开源协议
本项目遵循MPL-2.0开源协议。在此基础上，如果你发布了一份新的猫谱，我们希望你能保留中大猫谱的友情链接。待你的线上版本稳定使用一段时间后，请留言告诉我们将你的友链加到中大猫谱小程序中。