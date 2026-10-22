# 分席

一份 Grok 网页，分给几个人用。容器里的浏览器只登录一次。每个人在外面有自己的一页，写下去的话只送进自己的标签，网页上的回复再实时传回来。别人看不到这一页。不用 API key。

这不是 xAI 的官方接口，只是把你已经登录的 [grok.com](https://grok.com) 网页包了一层。请只分给信任的人，并遵守网站的使用条款。额度和风控都算在这一个账号上。账号主人在容器桌面里看得到所有标签，因为浏览器本来就是你的。朋友只连外面的页面，拿不到登录态，也收不到别人的文字。

```text
朋友的浏览器
    │  口令 + 自己的连接
    ▼
分席（8080）  每个连接只订阅自己的标签
    │
    ▼
容器里的 Chromium（登录一次，记在 volume 里）
    ├── 标签甲
    ├── 标签乙
    └── 登录用的那一页（/desktop，地址可改）
```

跑容器的那台机器自己要能打开 `https://grok.com`。打不开的网络上，登录和回复都不会发生。

## 需要什么

- 一台装了 Docker 和 Docker Compose 的 Linux（建议 2 GB 内存以上）
- 这台机器能访问 grok.com
- 一个你自己的 Grok 账号，第一次用容器桌面登录

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

只需要做一次。登录态写在名为 `profile` 的 volume 里，重启容器还在。删掉这个 volume 才要重新登录。

在你自己的电脑上打开分席的地址，后面加上 `/desktop`：

```text
http://服务器:8080/desktop
```

服务器地址和端口会按你打开这一页的主机填好。机器在远处时，把地址改成那台机器的公网 IP 或域名。两种接法：

- **跟分席同一个地址**：端口用 8080（或你反代之后的端口）。防火墙只放行这一个口就行。
- **桌面端口**：选 6080。适合 8080 和 6080 都能从外面访问的时候。

然后打开容器里的浏览器，密码是 `NOVNC_PASSWORD` 的前 8 位。登录 Grok，直到能看到输入框。这一页能看到所有人的标签，不要把 `/desktop` 发给朋友。

外面的页面顶部会从「网页还没登录」变成「网页已登录」。

如果 6080 不想对公网开放，把 [docker-compose.yml](docker-compose.yml) 里的 `6080:6080` 改回 `127.0.0.1:6080:6080`，登录仍用 `http://服务器:8080/desktop`。

## 朋友怎么用

把 `http://服务器:8080` 和入场口令发给他们。每个人填自己的称呼和口令，进入之后就是自己的一页：

- 写的话只送进自己的标签
- 回复随着网页往外长，实时出现
- 生成中可以按「停止」
- 「新的一页」会换一个新标签上的新对话，旧对话还留在账号里，但别人的页面上看不到
- 「离开」关掉他的标签，把席位让出来

刷新页面还是同一页。席位默认 8 个，在 `.env` 里改 `MAX_TABS`。

## 数据放在哪

| 卷 | 里面是什么 |
| --- | --- |
| `profile` | 浏览器登录态。等于账号的钥匙 |
| `state` | 每个人的称呼、口令和这一页上的对话副本 |

不要把这两个卷提交进 git，也不要拷给不信任的人。`state` 里有对话内容。

换口令：改 `.env` 里的 `ACCESS_CODE`，然后 `docker compose up -d`。已经进来的人仍然能用，直到他们离开或你清掉席位。

清掉所有席位，但保留登录：

```bash
docker compose exec fenxi rm -f /data/state/sessions.json
docker compose restart
```

## 更新

```bash
cd fenxi
git pull
docker compose up -d --build
```

登录态和对话副本都在卷里，更新不会清掉。

## 常见问题

**外面一直显示还没登录。**  
在桌面里刷新 grok.com，确认这个账号已经能看到输入框，而不是登录按钮。然后回到外面刷新。

**发送后说找不到输入框，或没有回复。**  
网站改版了。选择器在 [server/browser.js](server/browser.js) 开头的 `COMPOSER`、`SEND_BUTTON`、`STOP_BUTTON`。容器日志：

```bash
docker compose logs -f fenxi
```

日志里只有席位编号和字数，不写对话内容。

**容器一启动就退出，提示 ACCESS_CODE。**  
没有 `.env`，或口令短于 4 位。

**浏览器崩溃、标签打不开。**  
内存不够时给 Docker 多留一点，compose 里已经把 `/dev/shm` 设成 1 GB。

**重启之后又要登录。**  
`profile` 卷没有挂上，或被删了。`docker compose down` 不会删卷。`docker compose down -v` 会删，登录态就没了。

**VNC 密码怎么对都不对。**  
只认前 8 位。远程打开时用的是 `/desktop` 里填的那台服务器，不是你自己电脑的 localhost。

**登录页显示「验证失败，请刷新页面并重试」。**  
这是 Cloudflare 的验证。以前容器一启动就把浏览器接成自动化，验证会直接失败。现在要等你在桌面里登录成功，外面才会接管。更新后在桌面里刷新登录页再试一次。若刷新后仍失败，看容器日志里有没有「到不了 Cloudflare 验证服务器」——那就是这台机器访问不了 `challenges.cloudflare.com`。

**朋友能看到别人的话。**  
这是缺陷，不是设计。每个 WebSocket 只按自己的席位推送，请提 issue。账号主人在 noVNC 里能看到全部标签，这是预期。

## 本地开发

```bash
cd fenxi
npm install
npx playwright install chromium
cp .env.example .env
# 改 ACCESS_CODE。没有桌面时可以 HEADLESS=true，但那样你没法亲手登录。
ACCESS_CODE=你的口令 npm test
ACCESS_CODE=你的口令 npm start
```

正式环境不要设置 `DEMO_HINT=1`。那个开关会把口令写在首页上，只给本地预览用。

## 许可

MIT，见 [LICENSE](LICENSE)。
