# 更新日志

本文档是发布流程提取 Release Notes 的唯一数据源（`.github/workflows/release.yml` 会自动读取，请在每次发版前更新本文件）。

## v0.1.5

- 增加 Hugging Face Token 授权
- 优化模型下载的任务管理

## v0.1.4

- 预设参数新增 推测解码（MTP）与 MoE 专家卸载（ncmoe）
- 图像识别（mmproj）路径选择改为统一边框容器，支持点击文本框直接选择文件
- 修复旧版预设加载后 MTP 被误判为外部挂载的问题
