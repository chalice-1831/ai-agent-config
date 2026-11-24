# ContextForge Docker Compose

这个目录维护个人自用的 MCP 转发网关模板，可供 OpenCode、Codex 或其他 MCP 客户端连接。上游凭证由网关保管，客户端只持有权限受限、可撤销的网关调用 Token；客户端 Token 不等于上游 Token。

## 文件与服务

- `docker-compose.yaml`：ContextForge 网关、新版 Web UI（BFF）和专用 Redis 会话存储。
- `.env.example`：初始化变量清单，密钥留空；按下方命令生成本机 `.env`，不要直接使用空密钥启动。
- `.gitignore`：排除真实 `.env`、编辑器临时文件及备份目录。

网关固定为 `v1.1.1`，Web UI 固定为 `0.3.1`，两者锁定镜像 digest；Redis 使用 `7.4-alpine`。网关使用单 worker、SQLite 和数据库缓存，Redis 仅存储 Web UI 会话，不承担网关缓存。

| 入口    | 本机地址                          | 用途                                |
| ------- | --------------------------------- | ----------------------------------- |
| Web UI  | <http://127.0.0.1:3001/app/login> | 管理上游、virtual server 和访问凭证 |
| Gateway | `http://127.0.0.1:4444`           | MCP/API；不是 Web UI 的代理地址     |
| Redis   | 不发布宿主机端口                  | BFF 会话存储，包含网关访问 Token    |

旧内置 UI 在 <http://127.0.0.1:4444/admin/login>，仅作兼容备用；官方计划于 **2027-01-27** 结束旧 UI 支持。

## 首次部署

建议把本目录复制到自己的运行目录再启动，以便将版本化模板和本机秘密分开：

```bash
mkdir -p ~/docker_compose/contextforge
cp -R support-files/contextforge/docker-compose/. ~/docker_compose/contextforge/
cd ~/docker_compose/contextforge
```

以上复制命令从仓库根目录执行，**只适用于首次部署到空目录**。如果已有 ContextForge 实例，不要覆盖其配置、重新初始化密钥或另起一套同名服务；按下方维护说明更新。

在运行目录生成随机密钥及初始密码。命令拒绝覆盖已有 `.env`（包括符号链接），创建权限为 `0600`，不输出秘密：

```bash
python3 - <<'PY'
import os
from pathlib import Path
import secrets

text = Path('.env.example').read_text()
for key in ('JWT_SECRET_KEY', 'AUTH_ENCRYPTION_SECRET',
            'PLATFORM_ADMIN_PASSWORD', 'DEFAULT_USER_PASSWORD'):
    placeholder = f'{key}=\n'
    if text.count(placeholder) != 1:
        raise SystemExit(f'Expected one empty placeholder: {key}')
    value = 'Aa1!' + secrets.token_hex(32)
    text = text.replace(placeholder, f'{key}={value}\n', 1)
fd = os.open('.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(text)
print('Created .env; secrets were not printed.')
PY
```

在自己的私密编辑器中调整 `.env` 的管理员邮箱和姓名。初始登录密码来自 `PLATFORM_ADMIN_PASSWORD`，不要粘贴到 Agent 对话。首次登录后建议修改密码；修改后的密码保存在数据库，`.env` 中仍是初始化值。

拉取镜像，并为**新建的空数据卷**设置镜像运行用户所需的目录所有权，再启动服务：

```bash
docker compose pull
docker compose run --rm --no-deps --user 0:0 --cap-add CHOWN --entrypoint python3 contextforge -c 'import os; os.chown("/data", 10001, 10001)'
docker compose config --quiet
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:4444/health
curl --fail http://127.0.0.1:3001/healthz
```

目录所有权命令仅用于首次初始化：网关镜像默认以 `10001:10001` 运行，而新建 `/data` 挂载目录可能属于 root。它不递归修改文件；不要用它替代对既有数据卷权限问题的检查。

Compose project 固定为 `contextforge`，容器名为 `contextforge`，两个持久卷默认为 `contextforge_contextforge_data` 和 `contextforge_web_ui_redis_data`。不要在另一目录同时启动本模板管理同一实例。

## 注册上游和签发调用 Token

1. 登录 Web UI，注册上游 MCP，将其认证 header、API Key 或 OAuth 凭证保存在网关侧。不要把上游秘密写入客户端配置。
2. 创建 virtual server，只关联需要向客户端提供的工具；复制它的 MCP 地址，通常为 `http://127.0.0.1:4444/servers/<server_id>/mcp/`，以管理界面提供的地址为准。
3. 建立非管理员调用身份，按资源可见性及 team 规则授予访问权限。仅调用 MCP 时使用 `servers.read`、`servers.use`、`tools.read`、`tools.execute`，不要授予上游配置管理或凭证导出能力。
4. 为该身份签发限定 virtual server 和上述权限的 Token，并设置有效期，例如 30 天。身份角色与 Token scope 都必须允许目标操作；不要直接使用管理员登录 Token。
5. 在客户端执行 `initialize`、`tools/list` 和一次工具调用，确认功能正常；同时确认该调用 Token 不能访问管理接口或其他未授权 virtual server。

virtual server 用来提供工具集合，客户端 Token 用来限制调用权限。上游鉴权由网关单独配置，不应将客户端的 `Authorization` 无差别透传到上游。工具可访问的业务数据仍由上游身份权限决定。

## OpenCode 项目级接入（可选）

ContextForge 用于有敏感 MCP 需求的项目，不加入本仓库的 `opencode/opencode.jsonc` 全局配置，也不自动迁移现有直连 MCP。每个项目按需选择自己的 virtual server 和受限调用 Token；网关服务本身可以共用，项目之间无需共享调用身份或工具集合。

先完成上一步，在目标项目根目录的 `opencode.jsonc` 中添加以下配置；将 `<server_id>` 替换为实际 ID，`<project>` 替换为项目标识。已有配置时仅合并对应字段，不要覆盖整个文件。server ID 来自网关数据库，**新部署不会自动创建相同 ID、账号或工具集合**：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "contextforge": {
        "type": "remote",
        "disabled": false,
        "url": "http://127.0.0.1:4444/servers/<server_id>/mcp/",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {file:~/.local/share/opencode/credentials/contextforge-<project>-token}",
        },
      },
    },
  },
}
```

在本机创建私有凭证目录，使用自己的编辑器将调用 Token 单独保存到 `~/.local/share/opencode/credentials/contextforge-<project>-token`（仅 Token，不加 `Bearer ` 前缀），并将文件权限设为 `0600`：

```bash
install -d -m 700 ~/.local/share/opencode/credentials
# 用自己的编辑器保存 Token 后执行：
chmod 600 "$HOME/.local/share/opencode/credentials/contextforge-<project>-token"
```

Token 文件不得提交仓库。到期、撤销或重新签发后替换该文件，使用 `/reload` 重新加载，再检查：

```bash
opencode mcp list
```

也可以在 OpenCode 中通过 `/mcps` 查看连接状态。`connected` 只代表连接成功，还应实际列出并调用一次目标工具。新接入网关后工具名称可能带上游前缀；若将来替换直连入口，要同步检查指令、权限规则和调用方，不要直接删除原连接。

`./opencode.sh link` 仍只链接配置，不启动 Docker 服务、不签发 Token、不复制秘密。Codex 共享 MCP 清单此次不作变更；其他客户端也应连接 virtual server，而不是把上游凭证重新配置一遍。

## 维护与备份

在实际运行目录执行服务管理：

```bash
docker compose ps
docker compose up -d --wait
docker compose stop
```

更新仓库模板后，先审查配置差异，再将所需非秘密文件同步到运行目录；不要覆盖既有 `.env`，不要改变 Compose project 或数据卷名称。当前模板固定的镜像版本不会因 `pull` 自动升级；版本升级应同时审查上游迁移说明和 Web UI 兼容性。

备份需保留 SQLite 数据卷与 `.env`，尤其是 `AUTH_ENCRYPTION_SECRET`；丢失它会导致已保存的上游凭证无法解密。离线备份 SQLite 时应先停止整个 stack，再备份完整网关卷；不要只在运行中复制单个 `mcp.db` 而漏掉 SQLite 日志文件。Redis 会话卷也包含访问 Token，任何会话备份都按秘密保管；若选择不恢复会话，需要重新登录 Web UI。

不要执行 `docker compose down -v`，不要让两个网关同时写入同一 SQLite 卷。恢复或回滚前保留当前完整备份，确认镜像版本、数据库和加密密钥相互匹配。

## 安全边界

- 本模板只将 `3001`、`4444` 绑定到 loopback，Redis 不发布端口。从其他机器访问时优先使用 SSH 隧道；不要直接改为公网明文 HTTP。
- 如需通过 HTTPS 反向代理提供服务，必须同步配置 Web UI 的 `COOKIE_SECURE=true`、正确的 `PUBLIC_ORIGIN` 以及网关的 `SECURE_COOKIES=true`，并检查可信代理与访问控制；这些固定配置在 Compose 的 `environment` 中，单改 `.env` 不会覆盖它们。
- 按个人自用需求，模板设置 `RATE_LIMITING_ENABLED=false`，关闭网关分档请求限流及对应超限锁定；保留登录鉴权和调用权限，上游服务限流不受影响。对外或多人使用前重新评估限流和资源约束。
- 网关调用 Token 可以交给 Agent，但泄露后仍可调用其授权的工具，必须限制资源、权限、有效期并支持撤销。隐藏上游 Token 不会自动隐藏工具能读取的数据。
- 本机部署**不提供宿主机用户隔离**：能读取运行目录 `.env`、数据库、Redis 会话或操作 Docker 的 Agent 仍可能取得上游秘密。若要求 Agent 无法取得这些秘密，应将网关部署在独立主机或不同权限域，禁止其访问配置、数据卷和 Docker 管理接口。管理面凭证不要交给 Agent。

## 参考

- [ContextForge v1.1.1](https://github.com/IBM/mcp-context-forge/tree/v1.1.1)
- [官方 Compose 配置](https://github.com/IBM/mcp-context-forge/blob/v1.1.1/docker-compose.yml)
- [Web UI v0.3.1 部署说明](https://github.com/contextforge-org/contextforge-web-ui/blob/v0.3.1/docs/DOCKER.md)
- [OpenCode MCP 配置](https://opencode.ai/docs/mcp-servers)
- [OpenCode 文件变量替换](https://opencode.ai/docs/config#files)
