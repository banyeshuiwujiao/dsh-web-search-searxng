# 修复记录：SearXNG 搜索「fetch failed」—— 元凶是环境代理，不是插件

> 日期：2026-10-27（Asia/Shanghai）
> 现象：dsh web 上每次 `web_search` 都返回 `SearXNG search request failed: TypeError: fetch failed`
> 结论：**插件无恙**。坏的是宿主进程的出网链路 —— `HTTP_PROXY` 指向一个没人监听的 loopback 端口，
> 而 `NO_PROXY` 里没有 Tailscale 网段，于是「本应内网直连」的 SearXNG 请求被丢给死代理。
> 修复：给 `NO_PROXY` 补 `100.72.234.100`（精确 IP），重启 DSH 宿主。

---

## 一、为什么先怀疑错了对象

排查时最容易做的三件事（接线、patch、profile 清单）全部是对的，而且**故障信息本身就已经证明了这点**：

| 检查项 | 实测 |
|---|---|
| bundle 状态 | `enabled: true` / `installed: true`，row `web-search-searxng`，`overrides: ["web"]` |
| profile 清单 | `dsh.profile.bundles` 里有 `dsh-web-search-searxng` |
| 接线 | `profiles/web/node_modules/dsh-web-search-searxng` 在，`README.md` 担心的 `ERR_MODULE_NOT_FOUND` 没出现 |
| 服务端可达 | `100.72.234.100:8080` TCP 握手 356ms 通 |

关键在于：那句报错来自 [index.mjs:133](../index.mjs) 里包住 `fetch` 的 `catch`。**这条代码路径只有在 provider 已成功注册、且 `web` 行的 `searchProvider: searxng` 确实选中了它之后才可能被触发** —— 也就是说加载、注入、选择三关全过了。

再加一条：失败耗时 **15ms**。配置里 `timeoutMs: 30000`，15ms 挂掉说明连接根本没发出去，不是超时，是被拒绝。

## 二、真凶

```
HKCU\Environment:
  HTTP_PROXY  = http://127.0.0.1:10808     ← v2rayN 的 mixed 端口，当时 v2rayN 没开
  HTTPS_PROXY = http://127.0.0.1:10808
  NO_PROXY    = localhost,127.0.0.1,::1    ← 没有 tailnet 地址
```

10808 上零监听（`Get-NetTCPConnection -State Listen` 无结果，进程表里也没有 v2rayN）。

DSH 启动器给进程设了 `NODE_USE_ENV_PROXY=1`（见 `@deepseek-ai/dsh-http-proxy` 的 `lib/index.js:495`），
Node 24 因此让**内置 `fetch` 真的去连那个代理**。SearXNG 的 base 是 Tailscale CGNAT 地址
`100.72.234.100`，不在 `NO_PROXY` 里 → 走代理 → `ECONNREFUSED 127.0.0.1:10808`。

复现（用插件自己的类，不碰宿主）：

```
A) 复刻当时宿主的环境                          B) 去掉代理变量
   id = searxng | available() = true             id = searxng | available() = true
   FAIL 15ms WEB_PROVIDER_ERROR                  OK 1808ms sources=44
        SearXNG search request failed:                 - https://github.com/deepseek-ai/deepseek-harness
        TypeError: fetch failed                        ...
```

A 那行与 `web_search` 工具吐给用户的原文逐字一致。

## 三、为什么只有搜索坏，模型却照常答题

LLM 走的是回环网关（`127.0.0.1:8788`），而 loopback 在任何解析顺序下都被无条件绕过。所以宿主里
**凡是真要出公网的调用全废，凡是走本机端口的全部正常** —— Agent 看起来完全健康，只有
`web_search` / `web_fetch` / `fetch_json` 静默死在代理上。同一时刻实测：

```
FAIL https://api.deepseek.com/models    ECONNREFUSED 16ms
FAIL https://registry.npmjs.org/-/ping  ECONNREFUSED 4ms
FAIL http://100.72.234.100:8080/search  ECONNREFUSED 15ms
```

## 四、修复（选了 A：保留代理，只放行 tailnet）

```powershell
# 用 setx：写注册表 + 广播 WM_SETTINGCHANGE，新开的终端才拿得到
setx NO_PROXY "localhost,127.0.0.1,::1,100.72.234.100"
```

`HTTP_PROXY` / `HTTPS_PROXY` **原样保留**（v2rayN 以后开不开都不影响搜索）。

然后**必须重启 DSH 宿主**：代理策略在启动时一次性快照，页面刷新与配置热重载都不会重读环境变量。

> 别指望往 `~/.dsh/.env` 写 `no_proxy` —— 启动器快照的优先级是「导出的环境变量 > `$DSH_HOME/.env`」，
> HKCU 已有值，`.env` 会被压掉。

### 三个坑（都实测过）

| 写法 | 结果 | 说明 |
|---|---|---|
| `100.64.0.0/10` | **FAIL** | CIDR 不被匹配 |
| `100.72.234.100` | OK | 精确主机名 |
| 只写小写 `no_proxy` | **FAIL** | Node 这条路径只认大写 `NO_PROXY` |

CIDR 不认**不是 Node 的怪癖**，DSH 自己的匹配器语义完全一致 —— `dsh-http-proxy/lib/index.js:212`
的注释原文：「CIDR notation is not matched — an operating system's bypass list often carries
`10.0.0.0/8`, which must be rewritten as suffixes」。所以写精确 IP 是两边都认的唯一形态。

## 五、验证记录

重启后（新宿主 PID 14056）三条出网路径：`web_search` 返回 8 条带 URL 的结果、`web_fetch` 200、
`fetch_json` 打 tailnet 200/1254ms。

**再往后单独测了「v2rayN 开着」这一形态**（这才是这套配置真正的考点）：12:04 v2rayN 起来、10808 恢复监听，
再打 `web_search`：

```
第一次：SearXNG 搜索引擎异常或挂起: bing (timeout), brave (timeout), duckduckgo (timeout), ...
第二次：✅ 8 条结果
```

注意第一次的**错误串变了** —— 从 `fetch failed` 变成引擎挂起，说明请求已经打到 SearXNG 并拿到了 JSON，
只是上游引擎集体超时（新机是数据中心 IP，bing/duckduckgo 间歇挂起属既有常态，见
`C:\AITask\migrate\迁移操作手册.md` §12.4）。拆开验证过：直连 `200/5288ms results=39`、
经代理 `200/2211ms results=41`，两边都通 —— 是网络抖动，不是代理回归。
顺带证明了插件那条「零结果 + 引擎挂起必须显式报错」的防线确实在工作（见 README「门禁」）。

**结论：修复在 v2rayN 开与关两种形态下都成立。**

## 六、决策留痕

- **不采用 Tailscale MagicDNS 主机名**（用户 2026-10-27 明确否决），继续钉死 `100.72.234.100`。
  代价要知道：这台新机若被注销重注册，tailnet IP 会变，届时 `NO_PROXY` 与本文件（及 profile patch）
  的 `baseURL` **会同时失效**，复现的还是那句含糊的 `fetch failed`。IP 变更时两处一起改。
- 方案 B（直接摘掉 `HTTP_PROXY`）未采用：本机对 GitHub 等公网长连接仍需 v2rayN，摘掉会牵连别的出网路径。

## 七、遗留改进（未做）

[index.mjs:133](../index.mjs) 把 `TypeError: fetch failed` 原样抛出，丢掉了 `error.cause.code`。
本次真因就藏在 cause 里（`ECONNREFUSED` + 指向 `127.0.0.1:10808`，一眼可辨是代理而非 SearXNG）。
建议把 `cause.code` 拼进消息，并在「代理指向 loopback 且被拒绝」时提示"疑似本机代理未运行"，
让同类问题能自解释。

另：`package.json` 的 `exports` 只暴露 `.` 与 `./package.json`，子路径 `lib/normalize.mjs` 从外部 import 会
`ERR_PACKAGE_PATH_NOT_EXPORTED`。不影响宿主加载，但若想让别处复用纯函数，需要补进 `exports`。
