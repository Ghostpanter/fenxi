# 分席

一份 Grok 网页，分给几个人用。容器里的浏览器只登录一次。每个人在外面有自己的一页，写下去的话和图片只送进自己的标签，网页上的文字和图片再实时传回来。别人看不到这一页。不用 API key。

同一台机器也可以同时跑多个互相隔离的租户。每个租户有自己的口令、席位、对话和 Chrome 登录态。甲租户的朋友收不到乙租户的消息、图片、席位或 cookie。

这不是 xAI 的官方接口，只是把你已经登录的 [grok.com](https://grok.com) 网页包了一层。请只分给信任的人，并遵守网站的使用条款。额度和风控都算在这一个账号上。账号主人在自己租户的容器桌面里看得到这个租户的所有标签，因为浏览器本来就是你的。看不到其他租户的浏览器。朋友只连外面的页面，拿不到登录态，也收不到别人的文字或图片。

```text
朋友的浏览器
    │  该租户的口令 + 自己的连接
    ▼
分席（8080）  实时中继按「租户 + 席位」投递，文字和图片双向都能走
    │
    ▼
该租户自己的 Google Chrome（独立 profile，登录一次，记在外接硬盘上）
    ├── 标签甲
    ├── 标签乙
    └── 登录用的那一页（/desktop/<租户>，地址可改）
```

跑容器的那台机器自己要能打开 `https://grok.com`。打不开的网络上，登录和回复都不会发生。

## 需要什么

- 一台装了 Docker 和 Docker Compose 的 Linux（一个租户建议 2 GB 内存以上；每多一个租户再预备一份浏览器的内存）
- 这台机器能访问 grok.com
- 每个租户一个你自己的 Grok 账号，第一次用这个租户的容器桌面登录

镜像在你自己的机器上构建，不使用别人打好的应用镜像，也不使用 API key。

## 部署

在这台机器上：

```bash
git clone https://github.com/Ghostpanter/fenxi.git
cd fenxi
cp .env.example .env
```

编辑 `.env`：

- `ACCESS_CODE`：朋友进入外面这一层时要填的口令，换成一长串随机字符
- `NOVNC_PASSWORD`：容器桌面的密码。经典 VNC 只认前 8 位，写 8 位随机字符就行

然后自己构建并启动：

```bash
docker compose up -d --build
```

第一次构建会下载 Chromium，比较慢。看到 `healthy` 之后再做登录。

```bash
docker compose ps
```

朋友用的地址是 `http://服务器:8080`，域名或公网 IP 都可以。登录桌面走同一个地址，不必先做 SSH 隧道。

## 第一次登录

只需要做一次。登录态写在外接硬盘上这个租户的 `profile` 目录里，不在容器里面。重建、删除容器都还在。拔掉或删掉这个目录才要重新登录。

只跑一个租户时，在你自己的电脑上打开分席的地址，后面加上 `/desktop`：

```text
http://服务器:8080/desktop
```

多个租户时，打开属于你的那一个，例如 `http://服务器:8080/desktop/shop-a` 或 `http://服务器:8080/t/shop-a/desktop`。这一页只能进入该租户的浏览器。

服务器地址和端口会按你打开这一页的主机填好。机器在远处时，把地址改成那台机器的公网 IP 或域名。两种接法：

- **跟分席同一个地址**：端口用 8080（或你反代之后的端口）。防火墙只放行这一个口就行。
- **桌面端口**：选 6080。适合 8080 和 6080 都能从外面访问的时候。

然后打开容器里的浏览器。单租户时密码是 `NOVNC_PASSWORD` 的前 8 位；多租户时用创建这个租户时设的桌面密码前 8 位。登录 Grok，直到能看到输入框。这一页能看到这个租户里所有人的标签，看不到其他租户，不要把 `/desktop` 发给朋友。

外面的页面顶部会从「网页还没登录」变成「网页已登录」。

如果 6080 不想对公网开放，把 [docker-compose.yml](docker-compose.yml) 里的 `6080:6080` 改回 `127.0.0.1:6080:6080`，登录仍用 `http://服务器:8080/desktop`。

## 朋友怎么用

把 `http://服务器:8080`（或多个租户时的 `http://服务器:8080/t/shop-a`）和这个租户的入场口令发给他们。每个人填自己的称呼和口令，进入之后就是自己的一页：

- 写的话和图片只送进自己的标签
- 回复里的文字和图片随着网页往外长，实时出现
- 生成中可以按「停止」
- 「新的一页」会换一个新标签上的新对话，旧对话还留在账号里，但别人的页面上看不到
- 「离开」关掉他的标签，把席位让出来

刷新页面还是同一页。席位默认 8 个，在 `.env` 里改 `MAX_TABS`。

## 数据放在哪

登录态不放在容器里，也不放在 Docker 自己的卷里。`.env` 里的 `DATA_DIR` 指到外接硬盘的挂载点，例如 `/mnt/fenxi`。启动后这块盘上会有：

| 路径 | 里面是什么 |
| --- | --- |
| `$DATA_DIR/tenants.json` | 租户名单和口令。权限 600，不要提交到 git |
| `$DATA_DIR/tenants/<id>/profile` | 这个租户自己的浏览器登录态。等于该账号的钥匙 |
| `$DATA_DIR/tenants/<id>/state` | 这个租户里每个人的称呼、席位和对话副本 |

只设置了 `ACCESS_CODE`、还没添加其他租户时，会自动使用 id 为 `default` 的那一个租户。若盘上还有旧版的 `$DATA_DIR/profile` 和 `$DATA_DIR/state`，第一次启动会把它们迁到 `tenants/default/` 下面。

硬盘请格式化成 ext4 再挂上。exFAT 和 NTFS 不能改文件所有者，Chrome 会起不来。

```bash
lsblk
sudo mkdir -p /mnt/fenxi
sudo mount /dev/sdb1 /mnt/fenxi
```

想开机自动挂上，把对应一行写进 `/etc/fstab`。然后在 `.env` 里写 `DATA_DIR=/mnt/fenxi`。

已经用旧版 Docker 卷登录过的，先把钥匙拷出来，免得再登一次：

```bash
mkdir -p /mnt/fenxi/tenants/default/profile /mnt/fenxi/tenants/default/state
docker run --rm \
  -v fenxi_profile:/from \
  -v /mnt/fenxi/tenants/default/profile:/to \
  alpine cp -a /from/. /to/
docker run --rm \
  -v fenxi_state:/from \
  -v /mnt/fenxi/tenants/default/state:/to \
  alpine cp -a /from/. /to/
```

不要把这些目录或 `tenants.json` 提交进 git，也不要拷给不信任的人。`state` 里有对话内容，`profile` 里有登录 cookie。

换 default 租户的口令：改 `.env` 里的 `ACCESS_CODE`，然后 `docker compose up -d`。已经进来的人仍然能用，直到他们离开或你清掉席位。其他租户用 `scripts/tenants.js` 管理。

清掉某个租户的所有席位，但保留登录：

```bash
docker compose exec fenxi rm -f /data/tenants/default/state/sessions.json
docker compose restart
```

## 多租户

一台部署可以同时服务多个互不相通的租户。中间的实时中继严格按「租户 + 席位」转发。底层每个租户使用单独的 Chrome 用户目录（`DATA_DIR` 下的 `tenants/<id>/profile`）和单独的显示桌面，所以 Grok 登录态不会串到别的租户。`/desktop` 也按租户分开，主人只能看见并登录自己那个租户的浏览器。

只设置 `ACCESS_CODE` 时，行为与以前相同：自动使用 `default` 这一个租户。多租户是一等能力，用下面的命令添加。

```bash
# 在仓库目录，或在已经启动的容器里
node scripts/tenants.js create shop-a --code '换成一条很长的随机口令' --seats 8 --desktop-password 'abcd1234'
node scripts/tenants.js create shop-b --code '另一条很长的随机口令' --seats 4 --desktop-password 'efgh5678'
node scripts/tenants.js list
node scripts/tenants.js remove shop-b
# 连 profile 和对话一起删掉（收不回来）：
# node scripts/tenants.js remove shop-b --purge
```

容器里：

```bash
docker compose exec fenxi node scripts/tenants.js list
```

创建后若服务已经在跑，它会读到 `$DATA_DIR/tenants.json` 的变化并拉起这个租户的浏览器。朋友用这个租户的口令从 `http://服务器:8080` 进入，也可以把地址写成 `http://服务器:8080/t/shop-a`。主人登录用：

```text
http://服务器:8080/desktop/shop-a
http://服务器:8080/t/shop-a/desktop
```

「桌面端口 6080」只接 `default` 租户。其他租户请选「跟分席同一个地址」，走 8080。

每个租户的口令必须互不相同。名单在 `$DATA_DIR/tenants.json`，权限 600。不要把这份文件提交进 git。

## 更新

```bash
cd fenxi
git pull
docker compose up -d --build
```

登录态和对话副本都在 `DATA_DIR` 那块盘上（`tenants/<id>/`），更新不会清掉。

## 常见问题

**外面一直显示还没登录。**  
在桌面里刷新 grok.com，确认这个账号已经能看到输入框，而不是登录按钮。然后回到外面刷新。

**发送后说找不到输入框，或没有回复。**  
网站改版了。选择器在 [server/browser.js](server/browser.js) 开头的 `COMPOSER`、`SEND_BUTTON`、`STOP_BUTTON`。容器日志：

```bash
docker compose logs -f fenxi
```

日志里只有席位编号和字数，不写对话内容。

**容器一启动就退出，提示 ACCESS_CODE 或没有租户。**  
没有 `.env`，口令短于 4 位，也还没有用 `scripts/tenants.js` 创建过租户。

**浏览器崩溃、标签打不开。**  
内存不够时给 Docker 多留一点，compose 里已经把 `/dev/shm` 设成 1 GB。

**重启之后又要登录。**  
外接硬盘没有挂上，或 `DATA_DIR` 指错了目录。`docker compose down` 不会删这块盘上的文件。

**VNC 密码怎么对都不对。**  
只认前 8 位。远程打开时用的是 `/desktop` 里填的那台服务器，不是你自己电脑的 localhost。

**顶上写着 Chrome for Testing，页面是 Something went wrong。**  
那是自动化测试版浏览器，Grok 会直接拒绝。现在镜像里装的是正式版 Google Chrome，并以普通用户启动，不再带那行 `--no-sandbox` 提示。重建时要能下载 Google 的安装包：

```bash
docker compose up -d --build
```

打开桌面后刷新页面。若日志里是「正式版沙箱没起来，改用 --no-sandbox」，页面能开，只是顶上可能还留着那一行提示，关掉即可。

**登录页显示「验证失败，请刷新页面并重试」。**  
这是 Cloudflare 的验证。以前容器一启动就把浏览器接成自动化，验证会直接失败。现在要等你在桌面里登录成功，外面才会接管。更新后在桌面里刷新登录页再试一次。若刷新后仍失败，看容器日志里有没有「到不了 Cloudflare 验证服务器」——那就是这台机器访问不了 `challenges.cloudflare.com`。

**朋友能看到别人的话，或看到另一个租户的内容。**  
这是缺陷，不是设计。实时中继必须按租户加席位投递，请提 issue。账号主人在自己租户的 noVNC 里能看到该租户的全部标签，这是预期；他不应该能看到其他租户的浏览器。

## 本地开发

```bash
cd fenxi
npm install
npx playwright install chromium
cp .env.example .env
# 改 ACCESS_CODE。没有桌面时可以 HEADLESS=true，但那样你没法亲手登录。
ACCESS_CODE=你的口令 npm test
ACCESS_CODE=你的口令 npm start
# 管理租户：npm run tenant -- list
```

正式环境不要设置 `DEMO_HINT=1`。那个开关会把口令写在首页上，只给本地预览用。

## 许可

MIT，见 [LICENSE](LICENSE)。
