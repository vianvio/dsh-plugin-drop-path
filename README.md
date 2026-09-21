# dsh-plugin-drop-path

文件夹拖进来，输入框里是它的**路径**（DSH / DeepSeek Harness 客户端插件）。

```bash
dsh plugin --profile desktop add github:vianvio/dsh-plugin-drop-path
# 装完重启 DSH（客户端半是启动时加载的）
```

把一个**文件夹**从访达（Finder）/ 资源管理器拖进 DSH，输入框里出现的不是"又一条传不上去的附件"，
而是这个文件夹的**本机绝对路径**——作为一个 `@路径/` 引用块插进去，可以直接接着打字发送。

```
拖入：/Users/vian/research/dsh-pet        →      输入框里：@ /Users/vian/research/dsh-pet/
                                                  （folder 形状的引用块，模型收到 @/Users/vian/research/dsh-pet/）
```

## 它抢的是什么，不抢什么

| 你拖进来的东西 | 结果 |
| --- | --- |
| **一个文件夹** | 抢下这次拖放，把它的绝对路径插进输入框（本插件） |
| 一个普通文件 | 不碰，照旧走上游附件流程（图片/文件上传） |
| 同时拖多个 | 不碰，照旧走上游附件流程（多选里有文件夹也不猜） |

理由很直接：文件夹在上游的附件流程里没有出路——目录不是文件，上传拿不到东西，用户看到的是
"拖进来了，但什么也没发生"。而文件夹的**路径**恰恰是最有用的东西（"看看这个目录"）。

## 怎么做到的（三件事）

1. **在 window 的捕获阶段接管，而不是在 document 上抢位置。**
   上游的附件插件在 `document` 上（冒泡阶段）挂了 `drop`。捕获从 window 走到目标、冒泡从目标走到
   window，两个方向都经过 document，但 **window 捕获永远排在 document 冒泡前面**——所以"谁先拿到"
   不取决于哪个插件先注册（在同一个 target 上就只能靠 `stopImmediatePropagation` 赌注册顺序）。
   抢下来之后 `preventDefault` + `stopImmediatePropagation`，附件流程拿不到这次事件。

2. **路径来自桌面端的窄口桥。**
   浏览器的 `File.name` 只有末段名字，拿不到绝对路径（这是浏览器的安全模型，不是 bug）。DSH 桌面端的
   preload 挂了一个只做一件事的桥：`window.__DSH_DESKTOP_FILE_PATH__.getPathForFile(file)`
   （内部就是 Electron 的 `webUtils.getPathForFile`）。拖进来的**文件夹**同样是一个磁盘上的 File，
   这个调用返回它的绝对路径。
   桥不在时（比如在普通浏览器里打开同一个 GUI）**明说读不到**，而不是插一个 `@名字` 这种点了等于没点的东西。

3. **用上游的引用插入通道写进草稿，而不是整篇替换。**
   输入框的内容不是字符串，是一棵 Lexical 文档：正文 + 引用块。`setDraft(text)` 是整篇替换，会把已有的
   引用块降级成纯文本、还会丢光标。所以走作用域事件 `slash/input-insert-reference`（上游 `@文件/文件夹`
   补全用的就是它）：它把指定选区替换成一个**引用块**，文档结构不丢、光标留在后面、发出去时按
   `@路径` 序列化。事件没人接（会话输入机还没起来）时才退回纯文本兜底。

## 真机上踩出来的四个坑（都已修，写在这里因为别人很容易复刻错）

1. **客户端半必须 `exports.inject = ['slots', 'sessions']`。**
   cordis 客户端按插件导出的 `inject` 数组**等服务就绪再调 `apply`**。漏了它，`apply` 会在
   services 还没装上时就被调用，`ctx.get('slots')` 是 `undefined`，插件在第一道门静默 return——
   界面上的表现是"拖文件夹**什么都不会发生**"，而 console 里一条线索都没有。
   （对照：能正常工作的插件都在包内 `dsh.client.inject` 与模块导出里各写了一次。）

2. **`props.useInput` 是真 React 钩子，只能在渲染期调用。**
   它是 `SnapshotSelectorHook<InputState>`，实现就是 `useSyncExternalStore`。在拖放回调里调它
   会当场抛 **React #321（Invalid hook call）**，被 `catch` 吞掉之后只剩一句"路径插入失败"。
   正确做法：**渲染期**读好草稿快照放进 ref，回调只从 ref 取 `{text, rev, draftRev}`
   （上游用 `draftRev` 做 CAS，过期就会被拒）。

3. **组件只挂载一次，闭包里的快照会过期。**
   `installFolderDrop` 在挂载时安装一次监听；如果把草稿快照放进闭包，它会永远停在第一帧。
   所以每次渲染都把新快照写进 `useRef`（见 `live.current`）。

4. **拖动过程中不要弹提示。**
   一开始的版本在 hover 时显示"松开，插入文件夹路径"、插入成功后显示"已插入文件夹路径"。
   两条都被去掉了：它们盖住输入框卡片上沿（节点/供给那一行），而且说的就是即将出现在输入框里的
   同一件事。**唯一的反馈是输入框里那个引用块本身**；只有失败才说话。

另外顺手覆盖了两条上游样式，让长路径**看得全**（只改显示，不改插入的文本）：
`ReferenceChip.module.css` 给 `.chip` 定了 `max-width:240px`、给 `.label` 定了
`text-overflow:ellipsis; white-space:nowrap`，于是长路径在输入框里被截成 `/Users/…`。
本插件注入一小段 CSS（按 `[class*="_chip"]` / `[class*="_label"]` 选，不用上游的哈希类名）。

## 怎么装

```bash
# 方式一：直接从这个仓库装（无需 npm 发布）
dsh plugin --profile desktop add github:vianvio/dsh-plugin-drop-path

# 方式二：clone 下来按本地目录装（改代码即时生效）
git clone https://github.com/vianvio/dsh-plugin-drop-path.git ~/code/dsh-plugin-drop-path
dsh plugin --profile desktop add ~/code/dsh-plugin-drop-path
```

装完 profile 的 `package.json` 里会有两处（`dsh plugin add` 自己写，不用手改）：

```jsonc
{
  "dependencies": { "dsh-plugin-drop-path": "…" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-plugin-drop-path" ] } }
}
```

**装完重启 DSH**（客户端半是启动时加载的）。卸载：`dsh plugin --profile desktop remove dsh-plugin-drop-path`。

## 在本仓开发

包名 `dsh-plugin-drop-path`，**产物就在仓根、没有构建步骤**：`client.js` 是手写的经典脚本，
页面按 `<script src>` 加载它；`index.js` 是宿主半（空 apply，只为让这个包在 Loader 里有一个条目，
客户端 bundle 才会被编进 `__DSH_BOOT__`）。

用目录方式装（方式二）之后改 `client.js` 刷新页面就能看到效果；`cordis.patch.yml` 里的条目
本身不热更新，改它要重启。

## 怎么验证

```bash
cd desktop && npm run test:drop-path     # 15 项：产物本身被加载并驱动
cd desktop && npm test                   # 全量（含 test/drop-path-bundle.test.ts）
```

两条路各自钉住一件事：

- `npm run test:drop-path` 把 `client.js` 丢进一个装着 `window.__ModuleLoader__` 的 jsdom 里**加载它**，
  再用**真的事件派发**驱动：拖文件夹 → 输入框里出现绝对路径；拖文件/多选 → 一概不碰；桥不在 → 明说读不到；
  重复投递的 drop → 只插一次；组件卸载（会话关掉）→ 不再抢。其中一条**挂真 React 组件**，
  验的是"组件在 → 监听在"这条接线（只测函数不测接线，正是"单测全绿而界面毫无反应"的空档）。
- `test/drop-path-bundle.test.ts` 按 DSH 的加载方式验声明：`dsh.client.platform: 'web'` 与
  `exports["./client"]` 缺一个，产物就不会进 `__DSH_BOOT__`（缺后者还会让整个 profile 起不来）。

想端到端看一眼产物进没进图，用**临时 home**（不要拿正在用的 App 做实验）：

```bash
# 建一个 profile，bundles 里放 @deepseek-ai/dsh-web-app + dsh-plugin-drop-path
DSH_HOME=/tmp/dsh-drop-path-home dsh --profile <你的 profile> --no-open --port 4399
# 打开它打印的那个 ?token=… 地址，然后在 index.html 里找 "dsh-plugin-drop-path"：
#   在 /plugins/??… 那条 combo URL 里出现 = 宿主已经把它编进 __DSH_BOOT__，
#   说明 package.json 的声明、exports["./client"]、产物文件三者都对上了。
```

## 边界（说清楚，免得当成 bug）

- **只在 DSH Desktop 里能拿到路径。** 在普通浏览器打开同一个 GUI 时，浏览器不给绝对路径，
  覆盖层会明说"这个界面读不到本机路径"。这不是插件偷懒，是能力边界。
- **只认"恰好一个文件夹"。** 多选（哪怕是若干个文件夹）一律放行给附件流程——猜错一次就会把文件吞掉，
  而"拖错了"的代价比"少一个便利"大得多。
- **路径原样插入，不做存在性校验、不做相对化。** 参照上游 `@file` 语法的写法：目录补尾斜杠，
  含空白的路径写 `@"…`（与上游 `formatFileMention` 一致）。家目录不做 `~` 缩写：
  插进去的是**给模型看的真路径**，缩写会让它在另一侧解释错。
