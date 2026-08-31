# 考研数学一对一辅导智能体

这是一个直接读取现有 Obsidian 数学知识库的本地单用户 MVP。它把课程 OCR、知识点候选页和方法候选页组织成可检索证据，提供三级提示、来源引用、学习档案、掌握度、错题和七日计划。

项目默认运行在 `127.0.0.1`，不修改 Obsidian 仓库。未配置模型密钥时，应用仍可在纯本地检索模式下工作。

## 运行要求

- Node.js 24 或更高版本
- 默认知识库位于项目相邻目录 `../shuxue`
- Windows 可直接运行 `start.cmd`，它不受 PowerShell 脚本执行策略影响，并会尝试使用 Codex 自带的 Node.js 24

项目没有第三方运行时依赖，不需要执行 `npm install`。

## 快速启动

在 PowerShell 中进入本目录：

```powershell
Copy-Item .env.example .env
npm start
```

推荐直接使用：

```powershell
.\start.cmd
```

如果不想使用启动脚本，也可以运行 `node .\src\server.mjs`。`start.ps1` 仅适用于允许执行本地 PowerShell 脚本的系统。

浏览器访问 `http://127.0.0.1:3210`。

### 纯本地检索模式

让 `.env` 中的 `DEEPSEEK_API_KEY` 保持为空即可。此时：

- 知识库扫描、检索、引用和学习数据都在本机完成
- 聊天接口不会请求模型服务
- 回答以检索定位和分级引导为主，不会在证据不足时编造完整答案

### 模型辅导模式

在 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-pro
```

密钥只由 Node.js 服务端读取，不会发送到浏览器或写入 SQLite。启用后，学生问题、最近 12 条对话以及检索到的教材摘录会发送给 DeepSeek，请据此评估隐私需求。模型调用使用 DeepSeek 官方 `/chat/completions` 接口；该接口本身无状态，因此应用从本地记录中拼接最近对话，实现连续辅导。参见 [Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) 和 [多轮对话](https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/)。

默认模型是 `deepseek-v4-pro`。旧名称 `deepseek-chat` 已进入停用流程，因此项目不再把它作为默认值；参见 [DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)。

## 配置

`.env.example` 包含全部常用配置：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `TUTOR_VAULT_PATH` | `../shuxue` | Obsidian 知识库路径 |
| `TUTOR_DATA_DIR` | `./data` | 学生数据目录 |
| `TUTOR_HOST` | `127.0.0.1` | 监听地址 |
| `TUTOR_PORT` | `3210` | 监听端口 |
| `DEEPSEEK_API_KEY` | 空 | 留空即纯本地检索模式 |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | DeepSeek 模型辅导使用的模型 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | 单次模型请求超时毫秒数 |

建议保留 `127.0.0.1`。当前 MVP 没有账号、鉴权或多用户隔离，不应直接暴露到局域网或公网。

## 数据边界

### Obsidian 知识库

应用只读扫描 `TUTOR_VAULT_PATH` 下的 Markdown 和关联图片，不在仓库内创建、修改或删除文件。课程正文按 `pdf-page-N` 页锚切块，引用会保留笔记路径、PDF 页码、页锚和内容哈希。

当前验收基线为：

- 95 个 Markdown 文件
- 32 份课程 OCR 笔记，共 752 个 PDF 页锚
- 38 个知识点候选页
- 16 个方法候选页
- 86 份进入检索索引的文档

### 学生数据

学习档案、掌握度、错题、会话和聊天记录保存在 `data/tutor.db`。切换模型提供方不会重建或清空这个数据库；所有历史消息仍保存在本机，并可从辅导室恢复和继续对话。该目录已被 Git 忽略。备份或迁移时，在应用停止后复制这个数据库文件即可。

## 证据与提示规则

- 课程 OCR 页的证据级别为 `ocr_source`，可以作为最终教材定位
- 知识点和方法候选页的证据级别为 `graph_candidate`，只负责关联与导航，不能伪装成教材原文
- 检索回答至少包含一条课程 OCR 证据；若没有课程证据，离线回答会明确拒绝猜测
- 一级提示只给方向和第一步，二级提示加入关键公式或中间步骤，三级提示给出完整核查路径
- OCR 初稿可能有公式、上下标和表格识别错误，关键结论必须结合引用页和原图核对

## 校验与测试

```powershell
npm test
npm run check
npm run smoke
```

- `npm test`：运行知识库、提示分级、路径安全、学习逻辑和 SQLite 存储测试
- `npm run check`：核对当前知识库统计、课程页锚、证据分级和代表性检索
- `npm run smoke`：在随机本地端口启动临时应用，验证 health、bootstrap、search、chat 和路径越界；它注入离线 provider，并断言模型调用次数为 0

Smoke 使用系统临时目录存放 SQLite 文件，完成后删除，不会碰触正式 `data/tutor.db`。

## HTTP 接口

主要接口包括：

- `GET /api/health`：运行模式与索引状态
- `GET /api/bootstrap`：前端初始化数据
- `GET /api/search?q=...`：知识库检索
- `POST /api/chat`：三级提示聊天
- `GET /api/sessions/:id/messages`：读取本机保存的会话记录并继续辅导
- `PUT /api/profile`：学生档案
- `POST /api/mastery/review`：记录练习并更新掌握度
- `POST /api/mistakes`、`PATCH /api/mistakes/:id`：错题闭环
- `GET /api/plan`：七日学习计划
- `GET /api/vault-file?path=...`：只读返回知识库内允许的图片

## 当前局限

- 检索是本地词法与知识链接混合排序，尚未加入向量嵌入和重排模型
- 课程正文状态是 `OCR初稿`，候选知识页和方法页状态是 `待人工校验`
- 纯本地模式擅长定位材料和递进提示，不等同于完整的数学推理模型
- 索引在服务启动时构建，知识库变化后需要重启应用
- 当前仅面向本机单用户，没有登录、云同步、多人班级和教师后台
- DeepSeek 接口无状态；本地保存完整记录，每次模型请求只携带最近 12 条消息及本轮教材证据
