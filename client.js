/**
 * dsh-plugin-drop-path — 浏览器半体
 *
 * 一句话：**把一个文件夹拖进 DSH，输入框里出现的是这个文件夹的路径。**
 *
 * # 它抢的是什么，不抢什么
 *
 * 上游的附件插件在 `document` 上（冒泡阶段）挂了一个 `drop`：任何带 Files 的拖放都会变成
 * 草稿附件。文件夹在这个流程里没有出路——目录不是文件，上传拿不到东西，用户看到的是
 * 「拖进来了，但什么也没发生」。
 *
 * 所以这里挂在**更外层**：`window` 的**捕获**阶段。捕获从 window 往目标走，冒泡从目标往
 * window 走，两个方向都经过 document，但 window 捕获在每一次事件里都排在 document 冒泡之前
 * ——所以「谁先拿到」不取决于哪个插件先注册（这一点是踩过的：同在 document 上，
 * `stopImmediatePropagation` 只能挡住排在后面的那个）。
 *
 * 抢的**只有文件夹**，而且只有「恰好一个文件夹」：
 *   · 拖普通文件   → 原样放行，走上游附件流程（这是绝大多数拖放，不能被我们改掉语义）；
 *   · 拖多个文件   → 放行；
 *   · 一个文件夹   → 抢占：不进附件草稿，路径写进输入框。
 *
 * # 路径从哪来
 *
 * 浏览器给的 `File.name` 只有末段名字，**拿不到绝对路径**——这是浏览器的安全模型，不是 bug。
 * 桌面端的 preload 挂了一个窄口桥（`window.__DSH_DESKTOP_FILE_PATH__`，见
 * `dsh-plugin-desktop/src/file-path-bridge-contract.ts`），唯一的成员是
 * `getPathForFile(file)`（内部就是 Electron 的 `webUtils.getPathForFile`）。
 * 在桌面上，拖进来的**文件夹**同样是一个磁盘上的 File，这个调用能返回它的绝对路径。
 * 桥不在（比如在普通浏览器里打开同一个 GUI）时，明确说「路径读不到」，而不是插一个
 * `@名字` 这种点了等于没点的东西。
 *
 * # 为什么先 emit 事件、而不是直接写草稿
 *
 * 输入框里的内容不是字符串，是一棵 Lexical 文档：正文 + 引用块（chip）。`setDraft(text)`
 * 是**整篇替换**，在有引用块的草稿上用它会把引用块降级成纯文本（`@foo` 的字面量），
 * 而且丢掉光标位置。
 *
 * 正确的那条路是上游给引用源留的通道：作用域事件 `slash/input-insert-reference`
 * （`ui-reference` 的 `@文件/文件夹` 补全用的就是它）。它做的是「把指定选区替换成**一个
 * 引用块**」，所以：
 *   · 文档结构不丢，光标留在后面；
 *   · 引用块有序号身份，序列化（发给模型）用 `codec.serialize` → `@路径`；
 *   · 显示上就是一个 folder 形状的引用，跟用 `@` 补全选中一个文件夹完全同形。
 *
 * 事件是**按会话作用域**投递的：`sessions.scope(sessionId)` 拿到的那个 ctx 上才挂着这台
 * 输入机的监听器。所以拿不到作用域时（会话正在切换/已销毁）退回 `setDraft` 纯文本兜底，
 * 而不是静默失败。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-drop-path',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React

    /** 插槽键：输入框卡片内部的浮动层（会话作用域，随会话挂载/卸载）。 */
    const SLOT = 'conversation.input.overlay'
    /** 本插件在 list 型插槽里的条目 id。 */
    const ENTRY_ID = 'drop-path'
    /** 桌面端文件路径桥的全局键（与 dsh-plugin-desktop 的 contract 同名）。 */
    const BRIDGE_KEY = '__DSH_DESKTOP_FILE_PATH__'
    /** 插进草稿里的引用源名：上游 `ui-reference` 就是这个名字，序列化器按它路由。 */
    const REFERENCE_SOURCE = 'reference'

    const COPY = {
      zh: {
        noBridge: '这个界面读不到本机路径（只有在 DSH Desktop 里拖文件夹才拿得到）',
        noPath: '读不到这个文件夹的路径',
        failed: '路径插入失败，输入框状态可能已变化，请重试',
      },
      en: {
        noBridge: 'This surface cannot read local paths (drag a folder inside DSH Desktop)',
        noPath: 'Could not read that folder path',
        failed: 'Could not insert the path — the composer changed, please retry',
      },
    }

    /** 判定语言：与上游一致（html lang 优先，其次 navigator.language）。 */
    function copy() {
      const language = (typeof document !== 'undefined' && document.documentElement.lang)
        || (typeof navigator === 'undefined' ? '' : navigator.language)
        || ''
      return String(language).toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    }

    /**
     * 把本机绝对路径写成 `@路径` 引用文本。
     *
     * 规则照抄 `@deepseek-ai/dsh-file-reference/grammar`：目录补尾斜杠；路径里有空白就整体
     * 加引号（未闭合的 `@"…` 是「这个目录之后还能继续往下钻」的写法）。带控制字符或引号的
     * 路径返回 undefined——那种路径写进这个语法就是不安全的，而不是「将就一下」。
     *
     * @param {string} path 本机绝对路径（POSIX 或 Windows 分隔符都可）。
     * @returns {string|undefined} 形如 `@/a/b/` 或 `@"/a b/"` 的引用文本。
     */
    function folderMention(path) {
      const raw = String(path).trim()
      if (raw.length === 0) return undefined
      // Windows 的反斜杠路径照原样保留（它是这台机器上的真路径），只按平台语义判断尾斜杠。
      const isWindows = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')
      const separator = isWindows ? '\\' : '/'
      const withSlash = raw.endsWith('/') || raw.endsWith('\\') ? raw : raw + separator
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(withSlash)) return undefined
      return /\s/u.test(withSlash) ? `@"${withSlash}` : `@${withSlash}`
    }

    /** 显示用的路径：加尾斜杠（引用块上的 label）。 */
    function displayPath(path) {
      const raw = String(path).trim()
      if (raw.length === 0) return raw
      return raw.endsWith('/') || raw.endsWith('\\') ? raw : raw + '/'
    }

    /** 这次拖放带的是不是「恰好一个文件夹」。 */
    function isSingleDraggedFolder(transfer) {
      if (!transfer) return { folder: false, file: undefined }
      const files = Array.from(transfer.files || [])
      const items = Array.from(transfer.items || []).filter((item) => item.kind === 'file')
      if (files.length > 1 || items.length > 1) return { folder: false, file: undefined }
      const item = items[0]
      let entry = null
      try {
        entry = item?.webkitGetAsEntry?.() ?? null
      } catch {
        entry = null
      }
      if (entry !== null && entry !== undefined) {
        return entry.isDirectory === true ? { folder: true, file: item.getAsFile() } : { folder: false, file: undefined }
      }
      // Chromium 在悬停阶段可能还没把 entry/File 交出来；目录项此时没有 MIME 类型，
      // 这是悬停时能拿到的最好信号（照抄上游桌面端早先那版 workspace 拖放的判定）。
      if (files.length === 0 && item !== undefined && item.type === '') return { folder: true, file: item.getAsFile() }
      return { folder: false, file: undefined }
    }

    /** 桌面端文件路径桥，取不到返回 undefined（普通浏览器 / 桥被移除）。 */
    function pathBridge() {
      if (typeof window === 'undefined') return undefined
      const bridge = window[BRIDGE_KEY]
      return bridge && typeof bridge.getPathForFile === 'function' ? bridge : undefined
    }

    /**
     * 在 window 捕获阶段接管「一个文件夹」的拖放。
     *
     * @param {() => object} session 取当前会话的 `{ ctx, sessionId }`（每次拖放现取，不信缓存）。
     * @param {{ setBusy: Function, succeed: Function, fail: Function }} ui 覆盖层的状态出口。
     * @returns {() => void} 卸载函数。
     */
    function installFolderDrop(session, ui) {
      let dragDepth = 0
      /** 一次拖放只处理一次：捕获期 stopImmediatePropagation 之后，冒泡期理论上不会再叫我们，
       *  但 Windows / 触控板上有重复投递的实例，重复插两次路径比不插更糟。 */
      let settled = false

      const claim = (event) => {
        const transfer = event.dataTransfer
        if (transfer === null || transfer === undefined) return undefined
        const types = Array.from(transfer.types || [])
        if (!types.includes('Files')) return undefined
        const verdict = isSingleDraggedFolder(transfer)
        if (!verdict.folder) return undefined
        event.preventDefault()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        else if (typeof event.stopPropagation === 'function') event.stopPropagation()
        return { transfer, file: verdict.file }
      }

      const onDragEnter = (event) => {
        const owned = claim(event)
        if (owned === undefined) return
        dragDepth += 1
        settled = false
      }

      const onDragOver = (event) => {
        const owned = claim(event)
        if (owned === undefined) return
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      }

      const onDragLeave = (event) => {
        const transfer = event.dataTransfer
        if (transfer === null || transfer === undefined) return
        // 只处理**我们认领过的那种**拖放（恰好一个文件夹）。不这么分，一次普通文件的拖放离开窗口
        // 也会把深度减一，深度就和 enter 的次数对不上了——之后真拖文件夹进来，覆盖层会提前消失。
        if (!isSingleDraggedFolder(transfer).folder) return
        dragDepth = Math.max(0, dragDepth - 1)
        const leftViewport = event.clientX <= 0 || event.clientY <= 0
          || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
        if (dragDepth === 0 || leftViewport) ui.dismiss()
      }

      const onDrop = (event) => {
        const owned = claim(event)
        if (owned === undefined) return
        if (settled) return
        settled = true
        dragDepth = 0
        void deliver(owned.file, owned.transfer)
      }

      const onDragEnd = () => {
        dragDepth = 0
        ui.dismiss()
      }

      /**
       * 拿到路径 → 写成引用块（或纯文本兜底）→ 回报覆盖层。
       * @param {File|undefined} file 目录对应的 File（可能为 null）。
       */
      async function deliver(file, transfer) {
        const text = copy()
        let path = ''
        try {
          const candidate = file ?? Array.from(transfer.files || [])[0]
          if (candidate !== undefined && candidate !== null) {
            const bridge = pathBridge()
            if (bridge !== undefined) path = String(bridge.getPathForFile(candidate) || '').trim()
          }
        } catch {
          path = ''
        }
        if (path.length === 0) {
          ui.fail(pathBridge() === undefined ? text.noBridge : text.noPath)
          return
        }
        const mention = folderMention(path)
        if (mention === undefined) {
          ui.fail(text.noPath)
          return
        }
        const inserted = insertReference(session(), mention, displayPath(path))
        if (inserted) ui.succeed(displayPath(path))
        else ui.fail(text.failed)
      }

      window.addEventListener('dragenter', onDragEnter, true)
      window.addEventListener('dragover', onDragOver, true)
      window.addEventListener('dragleave', onDragLeave, true)
      window.addEventListener('drop', onDrop, true)
      window.addEventListener('dragend', onDragEnd, true)
      return () => {
        window.removeEventListener('dragenter', onDragEnter, true)
        window.removeEventListener('dragover', onDragOver, true)
        window.removeEventListener('dragleave', onDragLeave, true)
        window.removeEventListener('drop', onDrop, true)
        window.removeEventListener('dragend', onDragEnd, true)
      }
    }

    /**
     * 把 `@路径` 插入当前会话的草稿。
     *
     * @param {{ctx: object, sessionId: string}|undefined} target 当前会话。
     * @param {string} mention 引用文本（`@/a/b/` / `@"/a b/"`）。
     * @param {string} label 引用块上显示的路径。
     * @returns {boolean} 是否插进去了。
     */
    function insertReference(target, mention, label) {
      if (target === undefined || target.ctx === undefined) return false
      const draft = readDraft(target)
      if (draft === undefined) return false
      const request = {
        reference: {
          source: REFERENCE_SOURCE,
          ref: mention,
          label,
          appearance: 'folder',
          clipboardText: mention,
        },
        // 插在草稿末尾：引用块替换的是一个零长选区，`insertReference` 自己会在后面补空格。
        span: { start: draft.text.length, end: draft.text.length, draftRev: draft.rev },
      }
      try {
        if (target.ctx.bail(target.ctx, 'slash/input-insert-reference', request) === true) return true
      } catch {
        /* 事件没有监听器（这台会话的输入机还没起来）时落到下面的纯文本兜底。 */
      }
      try {
        const actions = target.actions
        if (actions === undefined || draft.text === undefined) return false
        const joined = draft.text.length === 0 ? mention : `${draft.text}${/\s$/u.test(draft.text) ? '' : ' '}${mention}`
        actions.setDraft(joined)
        return true
      } catch {
        return false
      }
    }

    /**
     * 读当前草稿投影。
     *
     * `props.useInput` 是**真 React 钩子**（`SnapshotSelectorHook<InputState>` 的实现里就是
     * `useSyncExternalStore`，见 `@deepseek-ai/dsh-client-store` / `ui-session` 的注入面）：
     * 只能在**渲染期**调用，在拖放回调里调用会当场抛 React #321（Invalid hook call）。
     *
     * 所以草稿快照由组件在渲染期读好塞进 target.input（见 FolderDropOverlay 里的
     * `const draft = useInput(...)`），这里只负责从它取字段，不再自己调钩子。
     *
     * @param {{input?: {text: string, rev: unknown, ready?: boolean}}} target 当前会话。
     * @returns {{text: string, rev: unknown}|undefined} 草稿文本与它的 revision。
     */
    function readDraft(target) {
      const snapshot = target.input
      if (snapshot === undefined || snapshot === null || snapshot.ready !== true) return undefined
      if (typeof snapshot.text !== 'string') return undefined
      return { text: snapshot.text, rev: snapshot.rev }
    }

    /**
     * 输入框卡片里的浮动层：**它在，拖放监听就在**。
     *
     * 监听器随这个组件的挂载安装、随卸载移除，所以「有没有当前会话」与「要不要接管拖放」
     * 是同一条生命周期——没有会话时不该有人抢这次拖放（没有输入框可以接收路径）。
     *
     * @param {object} props 插槽注入面 + 会话标准座（`sessionId` / `useInput` / `inputActions`）。
     */
    function FolderDropOverlay(props) {
      const { sessionId, sessionCtx, useInput, inputActions } = props
      const [state, setState] = useState('idle')
      const [message, setMessage] = useState('')
      const timer = useRef(undefined)
      /** 这一层自己的可见高度：挂载后量一次，用来把自己顶到输入框卡片的**上方**。 */
      const self = useRef(null)
      const [lift, setLift] = useState(0)

      const clearTimer = useCallback(() => {
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = undefined
      }, [])
      useEffect(() => clearTimer, [clearTimer])

      // 只有错误态需要自动收起：失败提示挂 6 秒。成功没有任何提示，自然也没有计时器。
      useEffect(() => {
        if (state !== 'error') return undefined
        const handle = setTimeout(() => { setState('idle'); setMessage('') }, 6000)
        return () => clearTimeout(handle)
      }, [state])

      // 引用块（chip）默认是**截断**显示：上游 `ReferenceChip.module.css` 给 `.chip` 定了
      // `max-width:240px`、给 `.label` 定了 `text-overflow:ellipsis; white-space:nowrap`。
      // 于是拖进来的长路径在输入框里变成 `/Users/…/plugin…`，而这条路径恰恰是你要看的东西。
      //
      // 这里只放宽"显示"两件事：允许换行、去掉 240px 上限。**插入的文本一个字都没改**
      // ——发出去的仍然只有 `@/完整/路径/` 一个引用，没有多出任何字符。
      // 顺序上我们后插入，同特异性下后来的赢；所以不用 !important。
      useEffect(() => {
        const STYLE_ID = 'dsh-drop-path-chip-css'
        if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-drop-path'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = [
          '[class*="_chip"]{max-width:none!important;height:auto!important}',
          '[class*="_chip"], [class*="_chip"] *{line-height:22px}',
          '[class*="_label"]{white-space:normal!important;overflow:visible!important;overflow-wrap:anywhere;text-overflow:clip!important}',
        ].join('')
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, [])

      // 落脚点是输入框卡片内部的 `.overlayAnchor`：`position:absolute; inset:0 0 auto; height:0`
      // ——它**不占布局高度**，所以直接渲染会压在正文上。量自身高度、用负的外边距把自己顶上去，
      // 提示就落在卡片上沿之上，而不是盖住用户正在打的字。
      //
      // 高度是**会变的**：路径整条展开后可能换行成一两行。所以用 ResizeObserver 跟着量，
      // 而不是只量第一次——只量一次的话，换行之后负外边距偏小，提示会压回正文。
      useLayoutEffect(() => {
        const node = self.current
        if (node === null || node === undefined) return undefined
        const measure = () => {
          const height = typeof node.offsetHeight === 'number' ? node.offsetHeight : 0
          if (height > 0) setLift((previous) => (Math.abs(previous - height) < 1 ? previous : height))
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [state])

      // 草稿快照**在渲染期读**：`useInput` 是真 React 钩子，放到拖放回调里调用会抛
      // React #321（Invalid hook call）——这正是线上"路径插入失败"的直接原因。
      // 这个组件常驻挂载（提示条只在拖放时可见），每次草稿变化都会被 selector 唤醒，
      // 所以下一次拖放能读到刚写下的那份快照。`ready: true` 用来区分「读到空草稿」与「还没读到」。
      const draft = typeof useInput === 'function'
        ? useInput((snapshot) => ({ text: snapshot.draft, rev: snapshot.draftRev, ready: true }), (left, right) => left.text === right.text && left.rev === right.rev)
        : undefined

      // 每次拖放现取：缓存一份快照会在「用户一边打字一边拖文件夹」时用旧的 draftRev 去 CAS。
      // 草稿走 ref 而不是闭包：`installFolderDrop` 只在挂载时装一次，闭包里的 draft 会停在
      // 第一次渲染那一帧（之后打字只改 props，不会重装监听）。
      const live = useRef({ sessionId, sessionCtx, inputActions, draft })
      live.current = { sessionId, sessionCtx, inputActions, draft }

      useEffect(() => {
        const current = () => {
          const snapshot = live.current
          const latest = snapshot.draft
          return {
            ctx: snapshot.sessionCtx,
            sessionId: snapshot.sessionId,
            actions: snapshot.inputActions,
            // 渲染期读到的草稿 + 一个 ready 标记：用它区分「读到空草稿」和「还没读到」。
            input: latest === undefined ? undefined : { text: latest.text, rev: latest.rev, ready: true },
          }
        }
        const ui = {
          // 拖动期、以及**插入成功时**，都不显示任何东西：用户要的反馈就是输入框里那个引用块本身。
          // 一条"已插入文件夹路径"既是重复信息，又会盖住卡片上沿——已经被打回来两次了。
          // 只有失败才说话：那时用户需要知道为什么什么都没发生。
          setBusy: () => {},
          succeed: () => {},
          fail: (reason) => {
            setMessage(reason)
            setState('error')
          },
          dismiss: () => { clearTimer() },
        }
        return installFolderDrop(current, ui)
      }, [clearTimer])

      if (state === 'idle') return null
      const text = copy()
      const tone = state === 'error' ? '#b23' : 'var(--dsw-alias-label-primary, inherit)'
      return React.createElement(
        'div',
        {
          ref: self,
          role: state === 'error' ? 'alert' : 'status',
          'aria-live': state === 'error' ? 'assertive' : 'polite',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            // 占满输入框卡片那一行的宽度：路径要在这一行里**整条展开**，不是被截成省略号。
            maxWidth: '100%',
            width: '100%',
            boxSizing: 'border-box',
            // 顶到卡片上沿之上（`lift` 是自己的可见高度，挂载后量得）；没量到就先不顶。
            // 高度会随路径换行变，所以每次高度变了都重新量（见下面的 effect）。
            marginTop: lift === 0 ? 0 : -lift,
            marginBottom: lift === 0 ? 0 : 6,
            padding: '5px 10px',
            borderRadius: 8,
            // 不做虚线框：拖放时那圈框会跟卡片自己的高亮抢注意力，而这条只是在告诉你
            // 「松手会把哪个路径写进输入框」。颜色只留给错误态。
            border: state === 'error' ? '1px solid #b23' : '1px solid transparent',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2, #fff) 92%, transparent)',
            color: tone,
            fontSize: 12,
            lineHeight: '16px',
            pointerEvents: 'none',
          },
        },
        React.createElement('span', { 'aria-hidden': true }, '📁'),
        React.createElement(
          'span',
          {
            style: {
              // 不省略、不 nowrap：长路径整条换行显示完（`anywhere` 让没有空格的长路径也能断行）。
              flex: '1 1 auto',
              minWidth: 0,
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            },
          },
          message,
        ),
      )
    }

    /**
     * 客户端插件入口。
     *
     * @param {object} ctx 客户端根上下文。
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      const sessions = ctx.get('sessions')
      if (slots === undefined || sessions === undefined) {
        // 服务缺席时什么都不做：拖放照旧走上游的附件流程，不会因为少一个插件而报错。
        // 只有 inject 声明漏了才会走到这里（见文件末尾的 exports.inject）。
        ctx.logger?.warn?.('dsh-plugin-drop-path: 缺少 slots/sessions 服务，本次不接管文件夹拖放')
        return
      }
      ctx.effect(
        () => slots.inject(SLOT, () => slots.register({
          name: SLOT,
          id: ENTRY_ID,
          order: 10,
          registrant: 'dsh-plugin-drop-path',
          inject: (sessionId) => {
            const sessionCtx = sessions.scope(sessionId)
            if (sessionCtx === undefined) return { sessionId }
            return { sessionId, sessionCtx }
          },
        }, FolderDropOverlay)),
        'dsh-plugin-drop-path: 文件夹拖放覆盖层',
      )
    }

    exports.apply = apply
    // 客户端插件的服务门：cordis 读到这个数组会**等服务就绪再调 apply**。
    // 不声明它，apply 会立刻被调用——那时 slots/sessions 还没装上，插件就在 ctx.get 那里
    // 静默退出（实测：拖文件夹什么都不会发生，且 console 里一条线索都没有）。
    exports.inject = ['slots', 'sessions']
    // 测试用的纯函数出口：单测直接 load 这份产物，验的是**真正上线的那份逻辑**，
    // 不是另写一遍的替身（替身按实现者的想象造形状，是最容易一起错的地方）。
    exports.__test__ = { folderMention, displayPath, isSingleDraggedFolder, installFolderDrop, insertReference, COPY }
    return module.exports
  },
})
