# dsh-web-search-searxng

DSH（DeepSeek Harness）的 web-search provider：走**自建 SearXNG** 的 JSON API
（`/search?format=json`），在 `ctx.web` 能力接缝上以 `searxng` 这个 id 注册。

## 为什么是插件而不是配置

DSH 自带的搜索 provider 只有 `deepseek` / `exa` / `perplexity`。`ctx.web` 是
provider 注册表，后端换一家就是多一行插件——就是这个文件。

可达性由使用者负责：本 provider 只需要一个能说 SearXNG JSON API 的 base URL。
打包好的方案把它指向新服务器（`c20261025912211`）的 Tailscale IP
（`http://100.72.234.100:8080`，其 searxng 直接监听在 Tailscale 接口上），
因此不暴露公网，也不需要 Basic-Auth 凭据。

> 历史：2026-10-25 迁移前指向首尔机（`100.73.103.73`）的原生 searxng 实例
> （经 127.0.0.1:8080 + SSH 隧道 8082）。首尔机服务已停、2026-11-05 到期下线，
> 新机 searxng 直接监听 Tailscale IP，故不再需要 SSH 隧道。

## 行配置（都可省略）

| 键 | 类型 | 说明 |
|---|---|---|
| `baseURL` | string | SearXNG 基址（默认读环境变量 `DSH_WEB_SEARXNG_BASE_URL`，再退回 `http://127.0.0.1:8082`） |
| `timeoutMs` | number | 单次搜索超时（默认 30000，只认正整数） |
| `language` | string | 例如 `zh-CN` / `all` |
| `categories` | string | 例如 `general,news`（缺省 `web`） |
| `engines` | string | 例如 `bing,google cse,wikipedia` |
| `safeSearch` | number | `0` / `1` / `2` |
| `extraParams` | object | 追加到 `/search` 的任意查询参数 |

## 装到运行时

插件以 **junction** 接线（`node_modules/dsh-web-search-searxng` 指回本目录），
不是拷贝——拷贝会漂移，改了代码不生效。

```powershell
# 1. 接线
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-web-search-searxng" `
  -Target "C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-web-search-searxng"

# 2. ⚠️ 插件目录下要有 node_modules —— 见下面「为什么需要它」
New-Item -ItemType Junction `
  -Path "C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-web-search-searxng\node_modules" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules"
```

### 为什么需要插件目录下的 node_modules

`index.mjs` 顶部 `import { WebError } from '@deepseek-ai/dsh-web'`——这个包由
DSH 宿主提供（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web`），本插件不自带。

Node 的 ESM 解析**跟随真实路径**：junction 指向仓库目录后，从 `index.mjs` 往上找
`node_modules` 会走到仓库根，找不到宿主包，于是报
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-web'`。

所以插件目录下要有一个 `node_modules` junction 指回宿主目录，让解析从插件真实路径
出发也能命中。这个 junction 是机器特定的，已在 `.gitignore` 里。

## 门禁

```powershell
npm test        # node test/smoke.mjs
```

19 个用例，只测 `lib/normalize.mjs` 的纯函数，不碰网络、不依赖宿主。

之所以把纯逻辑单独放一个文件：`index.mjs` 依赖宿主包，独立仓里裸 import 会失败，
而门禁必须能在任何机器上独立跑。测的正是最容易悄悄坏的一层——

- 结果按 url 去重、缺 url 的行跳过
- `snippet` 取 `content` 并回落 `snippet`；`publishedDate` / `pubdate` 都认
- `answers` 拼成 content；`infoboxes` 的正文进 content、里面的链接并入 sources
- `answers` 优先于 infobox 正文
- **引擎全挂起时必须报出来**：SearXNG 可能 HTTP 200 但零结果、引擎全挂，
  这种「静默的空成功」会骗模型说"没搜到"，所以要显式报错
- `resolveOptions`：baseURL 去尾斜杠、配置优先于环境变量、timeoutMs 只认正整数、
  categories 缺省补 `web`、extraParams 非对象时丢弃

## 目录结构

```
index.mjs          插件主体（注册 provider、发请求、错误映射）
lib/normalize.mjs  纯逻辑：配置投影 + 结果归一化 + 引擎挂起识别（零宿主依赖）
test/smoke.mjs     门禁
cordis.patch.yml   bundle patch：把这一行 insert 放进 profile 即启用
docs/              修复记录（环境代理把 tailnet 请求丢给死代理那类问题的完整证据链）
```

## 启用

`cordis.patch.yml` 里那行 insert 就是「启用」本身：只有当本包被列进 profile 的
`dsh.profile.bundles` 时才会应用，所以开关归插件清单，profile 侧不用再写条目。

## 排障

**每次搜索都 `TypeError: fetch failed`，但插件是好的** —— 见
[docs/2026-10-27-proxy-no-proxy-fix.md](docs/2026-10-27-proxy-no-proxy-fix.md)。
一句话版：`baseURL` 是 Tailscale 地址，若 `HTTP_PROXY` 指向一个没监听的 loopback 端口、
而 `NO_PROXY` 又没列这个地址，请求就会被丢给死代理；且 `NO_PROXY` **不认 CIDR**
（`100.64.0.0/10` 无效，必须写精确 IP），改完要重启宿主才生效。

判据：失败若发生在十几毫秒内，就不是超时，是连接被拒 —— 先看代理，别查接线。
另外那句报错本身不足以定位：真因在 `error.cause.code` 里，插件目前把它丢掉了（见上文文档「遗留改进」）。

## License

MIT
