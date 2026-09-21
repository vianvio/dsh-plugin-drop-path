/**
 * 文件夹拖拽插件的单测。
 *
 * 立的规矩：**测的是产物 `client.js` 本身**，不是另写一份等价的函数。
 * 这个仓库有过一次教训——替身按实现者的想象造形状，代码照着替身读，两边一起错、一起绿。
 * 所以这里把 `client.js` 丢进一个装着 `window.__ModuleLoader__` 的 jsdom 里加载，
 * 拿到它注册的 factory 的导出，再**用真的事件派发**驱动它（`window.dispatchEvent`，
 * 走的就是浏览器里那条捕获路径，不是自己调回调）。
 *
 * 覆盖的是「用户能感知的结果」：
 *   · 拖一个文件夹 → 输入框里出现这个文件夹的绝对路径；
 *   · 拖一个普通文件 / 拖多个 → 不碰，原样交给上游附件流程；
 *   · 桌面路径桥不在 → 明确说读不到，而不是插一个假的；
 *   · 路径里带空格 → 按上游 `@file` 语法加引号；
 *   · 引用事件没人接 → 退回纯文本兜底，而不是静默丢。
 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import vm from 'node:vm'

const HERE = import.meta.dirname
const REPO = resolve(HERE, '..')
const CLIENT_BUNDLE = resolve(REPO, 'client.js')

// jsdom 没装在 desktop 根上，装在桌面 App 自己的树里（跑界面 e2e 用的就是这一份）。
const appRequire = createRequire(resolve(REPO, '..', 'upstream', 'dsh-plugin-desktop', 'package.json'))
const {JSDOM} = appRequire('jsdom')
const desktopRequire = createRequire(resolve(REPO, '..', 'package.json'))

/**
 * 给「只驱动纯逻辑」的用例用的惰性 react 替身。
 *
 * 产物的 factory 顶层就 `require('react')`（覆盖层组件要用），所以加载它就绕不开这一项。
 * 这些用例**不会渲染任何东西**，所以这里只提供形状；真正渲染组件的那条用例会把仓库里
 * 真的那份 react 传进来——替身只留在最外面那层，测试的主体仍然是产物本身。
 */
const lazyReact = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({current: initial}),
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/**
 * 在一个干净的 jsdom 全局里加载 `client.js`，返回它的导出。
 *
 * `client.js` 是**经典脚本**（`window.__ModuleLoader__.load({id, factory})`）——客户端产物
 * 只能这样：页面用 `<script src>` 加载它，走不了 ESM。所以测试也照浏览器的样子来：
 * 先摆好 `window`，让脚本自己注册 factory，再 materialize 它的导出。
 *
 * @param {object} [options]
 * @param {object} [options.react] 注入给 factory 的 react（覆盖层组件要用）。
 * @returns {{win: object, exports: object, test: object}} 加载结果。
 */
function loadBundle({react = lazyReact} = {}) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="composer"></div></body></html>', {
    url: 'http://127.0.0.1:43120/',
  })
  const win = dom.window
  let registration
  win.__ModuleLoader__ = {load: (handoff) => { registration = handoff }}
  const sandbox = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    console,
  }
  const require = (specifier) => {
    if (specifier === 'react') return react
    throw new Error(`没有提供模块: ${specifier}`)
  }
  vm.runInNewContext(readFileSync(CLIENT_BUNDLE, 'utf8'), sandbox, {filename: CLIENT_BUNDLE})

  assert.ok(registration, 'client.js 必须通过 window.__ModuleLoader__.load 注册自己的 factory')
  assert.equal(registration.id, 'dsh-plugin-drop-path', 'factory 的 id 必须是包名（图行走的键）')
  const exports = registration.factory(require)
  assert.equal(typeof exports.apply, 'function', '客户端半必须导出 apply(ctx)')
  return {win, dom, exports, test: exports.__test__}
}

/** 一个假会话：记下作用域事件的投递，并暴露一份可读的输入状态。 */
function fakeSession({draft = '', draftRev = 3, acceptEvent = true} = {}) {
  const session = {
    sessionId: 'session-1',
    ctx: {
      bail: (ctx, name, request) => {
        session.emitted.push({name, request})
        return acceptEvent ? true : undefined
      },
    },
    actions: {setDraft: (text) => { session.drafted = text }},
    // 拖放回调里读到的那份东西：**组件在渲染期用 useInput 取好的草稿快照**。
    // 不是 useInput 钩子本身（钩子在回调里调用会抛 React #321），也不是带 getSnapshot 的 store
    // ——线上两个 bug 都是"测试里造了插件以为的形状"，所以这里按真形状钉住。
    input: {text: draft, rev: draftRev, ready: true},
    emitted: [],
    drafted: undefined,
  }
  return session
}

/** 一个 DataTransfer 替身：只做上游真事件里被用到的那些形状。 */
function transfer({entries = [], files} = {}) {
  return {
    types: ['Files'],
    files: files ?? entries.map((entry) => entry.file).filter(Boolean),
    items: entries.map((entry) => ({
      kind: 'file',
      type: entry.type ?? '',
      webkitGetAsEntry: () => (entry.isDirectory === undefined ? null : {isDirectory: entry.isDirectory}),
      getAsFile: () => entry.file ?? null,
    })),
  }
}

/** 收集一次拖放里覆盖层说了什么。 */
function recorder() {
  const events = []
  return {
    events,
    ui: {
      // 拖动过程中不再有任何提示（用户要求：不要跟输入框重复的那条浮层）。
      // 这里保留 setBusy/dismiss 的**空实现**，是为了钉住"插件不许在拖动期要求 UI 做事"。
      setBusy: (busy) => { if (busy) events.push('busy') },
      succeed: (path) => events.push(`done:${path}`),
      fail: (reason) => events.push(`error:${reason}`),
      dismiss: () => events.push('dismiss'),
    },
  }
}

/**
 * 在真 window 上派发一次拖放事件（捕获阶段照样走到 window 上，跟浏览器一致）。
 * @param {object} win jsdom window。
 * @param {string} type 事件名。
 * @param {object} dataTransfer 事件载荷。
 * @returns {object} 派发过的事件（可以读 defaultPrevented）。
 */
function dispatch(win, type, dataTransfer) {
  const event = new win.Event(type, {bubbles: true, cancelable: true})
  Object.defineProperty(event, 'dataTransfer', {value: dataTransfer, configurable: true})
  Object.defineProperty(event, 'clientX', {value: 5, configurable: true})
  Object.defineProperty(event, 'clientY', {value: 5, configurable: true})
  win.dispatchEvent(event)
  return event
}

/** 装一次监听（走产物自己的 installFolderDrop），返回驱动句柄。 */
function install(win, test, session, ui) {
  const uninstall = test.installFolderDrop(() => session, ui)
  return {
    uninstall,
    dragenter: (dataTransfer) => dispatch(win, 'dragenter', dataTransfer),
    drop: (dataTransfer) => dispatch(win, 'drop', dataTransfer),
  }
}

test('folderMention：目录补尾斜杠，带空格的路径按上游 @file 语法加引号', () => {
  const {test} = loadBundle()
  assert.equal(test.folderMention('/Users/vian/research/dsh-pet'), '@/Users/vian/research/dsh-pet/')
  assert.equal(test.folderMention('/Users/vian/My Research'), '@"/Users/vian/My Research/')
  assert.equal(test.folderMention('/Users/vian/research/'), '@/Users/vian/research/')
  assert.equal(test.folderMention('C:\\Users\\vian\\项目'), '@C:\\Users\\vian\\项目\\')
  assert.equal(test.folderMention('   '), undefined)
  assert.equal(test.folderMention('/tmp/有"引号'), undefined, '语法表达不了的路径不硬写')
  assert.equal(test.displayPath('/Users/vian/research'), '/Users/vian/research/')
})

test('拖一个文件夹：抢占这次拖放，并把它的绝对路径作为引用块插进输入框', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  const folderFile = {name: 'dsh-pet'}
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: (file) => (file === folderFile ? '/Users/vian/research/dsh-pet' : '')}
  const {events, ui} = recorder()
  const driver = install(win, test, session, ui)
  const dataTransfer = transfer({entries: [{isDirectory: true, file: folderFile}]})

  // 用户真实的一次拖放：进窗口 → 悬停 → 松手。
  driver.dragenter(dataTransfer)
  const dragover = dispatch(win, 'dragover', dataTransfer)
  assert.equal(dragover.defaultPrevented, true, '悬停就要拦下来，否则上游会显示「松开以添加附件」')
  assert.equal(dataTransfer.dropEffect, 'copy')

  const drop = driver.drop(dataTransfer)
  assert.equal(drop.defaultPrevented, true, '文件夹不能落到上游的附件流程里')

  await until(() => session.emitted.length === 1)
  const {name, request} = session.emitted[0]
  assert.equal(name, 'slash/input-insert-reference', '引用块要走上游的引用插入事件，不是整篇替换草稿')
  assert.equal(request.reference.source, 'reference')
  assert.equal(request.reference.ref, '@/Users/vian/research/dsh-pet/')
  assert.equal(request.reference.label, '/Users/vian/research/dsh-pet/')
  assert.equal(request.reference.appearance, 'folder')
  // 逐个比字段：这个对象是在 vm 的 realm 里造出来的，跨 realm 的 deepStrictEqual 会因为
  // 原型不同而报「看起来一样但不相等」，那种失败读起来毫不讲理。
  assert.deepEqual(
    {start: request.span.start, end: request.span.end, draftRev: request.span.draftRev},
    {start: 0, end: 0, draftRev: 3},
    '插在草稿末尾，用当前 draftRev 做 CAS',
  )
  assert.deepEqual(events, ['done:/Users/vian/research/dsh-pet/'], '拖动期零提示；只有插完那一条确认')
  driver.uninstall()
})

test('stopImmediatePropagation：上游附件插件挂在 document 冒泡上，必须拿不到这次事件', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: () => '/tmp/folder'}
  const {ui} = recorder()
  const driver = install(win, test, session, ui)

  // 上游的形状：document 冒泡阶段上挂一个 drop（附件就这么接的）。
  const seenByUpstream = []
  win.document.addEventListener('drop', () => { seenByUpstream.push('drop') })
  win.document.addEventListener('dragover', () => { seenByUpstream.push('dragover') })

  const dataTransfer = transfer({entries: [{isDirectory: true, file: {}}]})
  dispatch(win, 'dragover', dataTransfer)
  dispatch(win, 'drop', dataTransfer)
  await until(() => session.emitted.length === 1)

  assert.deepEqual(seenByUpstream, [], 'window 捕获阶段抢占之后，document 冒泡阶段不该再收到')
  driver.uninstall()
})

test('拖普通文件：完全不碰（用户要的是附件，不是路径）', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: () => '/Users/vian/notes.md'}
  const {events, ui} = recorder()
  const driver = install(win, test, session, ui)
  const dataTransfer = transfer({entries: [{isDirectory: false, type: 'text/markdown', file: {name: 'notes.md'}}]})

  const drop = driver.drop(dataTransfer)
  await tick()
  assert.equal(drop.defaultPrevented, false, '文件拖放不能被拦，否则附件功能就没了')
  assert.deepEqual(session.emitted, [])
  assert.equal(session.drafted, undefined)
  assert.deepEqual(events, [])
  driver.uninstall()
})

test('拖多个项目：同样放行（多选里有文件夹也不猜）', () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  const {ui} = recorder()
  const driver = install(win, test, session, ui)
  const dataTransfer = transfer({
    entries: [{isDirectory: true, file: {name: 'a'}}, {isDirectory: false, file: {name: 'b'}}],
  })
  const drop = driver.drop(dataTransfer)
  assert.equal(drop.defaultPrevented, false)
  assert.deepEqual(session.emitted, [])
  driver.uninstall()
})

test('桌面路径桥缺席：明说读不到，不会插一个假路径', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  const {events, ui} = recorder()
  const driver = install(win, test, session, ui)
  driver.drop(transfer({entries: [{isDirectory: true, file: {name: 'x'}}]}))
  await until(() => events.some((event) => String(event).startsWith('error:')))
  assert.deepEqual(session.emitted, [], '拿不到路径就不插')
  // 覆盖层先说「在插了」，再改口说读不到——两句话都得出现，用户才知道这事被尝试过。
  assert.deepEqual(events, [`error:${test.COPY.zh.noBridge}`], '桥不在时也要明确报错（这是唯一必须说话的场合）')
  driver.uninstall()
})

test('引用事件没人接：退回纯文本兜底（不静默丢）', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession({draft: '看看这个', acceptEvent: false})
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: () => '/Users/vian/research/dsh-pet'}
  const {events, ui} = recorder()
  const driver = install(win, test, session, ui)
  driver.drop(transfer({entries: [{isDirectory: true, file: {}}]}))
  await until(() => events.length > 0)
  assert.equal(session.emitted.length, 1, '先试引用事件')
  assert.equal(session.drafted, '看看这个 @/Users/vian/research/dsh-pet/', '事件没接住就退回整篇写回')
  assert.deepEqual(events, ['done:/Users/vian/research/dsh-pet/'])
  driver.uninstall()
})

test('一次拖放只插一次（重复投递的 drop 不能插两遍路径）', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: () => '/tmp/folder'}
  const {ui} = recorder()
  const driver = install(win, test, session, ui)
  const dataTransfer = transfer({entries: [{isDirectory: true, file: {}}]})
  driver.dragenter(dataTransfer)
  driver.drop(dataTransfer)
  driver.drop(dataTransfer)
  await until(() => session.emitted.length === 1)
  await tick()
  assert.equal(session.emitted.length, 1)
  driver.uninstall()
})

test('卸载后不再接管（会话关掉就不该抢拖放）', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: () => '/tmp/folder'}
  const {ui} = recorder()
  const driver = install(win, test, session, ui)
  driver.uninstall()
  const drop = driver.drop(transfer({entries: [{isDirectory: true, file: {}}]}))
  await tick()
  assert.equal(drop.defaultPrevented, false)
  assert.deepEqual(session.emitted, [])
})

test('普通文件的进出不影响文件夹拖放的深度（覆盖层不会因此提前消失）', async () => {
  const {win, test} = loadBundle()
  const session = fakeSession()
  win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: () => '/tmp/folder'}
  const {events, ui} = recorder()
  const driver = install(win, test, session, ui)

  // 先拖一个普通文件进来又出去：这一进一出我们一个字都不该记。
  const fileTransfer = transfer({entries: [{isDirectory: false, file: {name: 'a.txt'}, type: 'text/plain'}]})
  dispatch(win, 'dragenter', fileTransfer)
  dispatch(win, 'dragleave', fileTransfer)
  assert.deepEqual(events, [], '不认领的拖放不改变覆盖层')

  // 再拖文件夹进来：提示必须出现（如果深度被上面那次拖放弄脏，这里就静默不提示了）。
  const folderTransfer = transfer({entries: [{isDirectory: true, file: {}}]})
  dispatch(win, 'dragenter', folderTransfer)
  await tick()
  assert.deepEqual(events, [], '普通文件的进出不该产生任何提示（更不该让我们去抢/提示）')

  // 文件夹离开窗口：提示收回。
  const leave = new win.Event('dragleave', {bubbles: true, cancelable: true})
  Object.defineProperty(leave, 'dataTransfer', {value: folderTransfer, configurable: true})
  Object.defineProperty(leave, 'clientX', {value: 0, configurable: true})
  Object.defineProperty(leave, 'clientY', {value: 0, configurable: true})
  win.dispatchEvent(leave)
  assert.equal(events[events.length - 1], 'dismiss')
  driver.uninstall()
})

test('apply：注册进输入框覆盖层插槽，并把会话作用域 ctx 递给组件', () => {
  const {exports} = loadBundle()
  const registered = []
  const scopeCalls = []
  const ctx = {
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (key, callback) => {
            assert.equal(key, 'conversation.input.overlay', '覆盖层插进输入框卡片内部那条浮动层')
            return callback()
          },
          register: (options, component) => {
            registered.push({options, component})
            return () => {}
          },
        }
      }
      if (name === 'sessions') return {scope: (id) => { scopeCalls.push(id); return {id} }}
      return undefined
    },
    effect: (setup) => { setup(); return () => {} },
    logger: {warn: () => {}},
  }
  exports.apply(ctx)

  assert.equal(registered.length, 1)
  const {options, component} = registered[0]
  assert.equal(options.name, 'conversation.input.overlay')
  assert.equal(options.id, 'drop-path')
  assert.equal(typeof component, 'function')
  const injected = options.inject('session-9')
  assert.equal(injected.sessionId, 'session-9')
  assert.deepEqual(injected.sessionCtx, {id: 'session-9'})
  assert.deepEqual(scopeCalls, ['session-9'])
})

test('apply：服务缺席时不抛异常（少一个插件不该让界面起不来）', () => {
  const {exports} = loadBundle()
  const warnings = []
  exports.apply({get: () => undefined, effect: () => {}, logger: {warn: (message) => warnings.push(message)}})
  assert.equal(warnings.length, 1)
})

/* ------------------------------------------------------------------ 挂真组件：接线也要被验 */

/**
 * 把覆盖层组件真的挂起来（真 React + react-dom + jsdom），验证**接线**：
 * 「组件在 → 监听在」「组件在 → 拖进来会去读这台会话的草稿」。
 *
 * 为什么非要有这一条：前面那些用例直接调 `installFolderDrop`，证明不了组件真的把它装上了。
 * 单测全绿而界面毫无反应，正是这种"只验了函数不验接线"的空档。
 */
async function mountOverlay(bundle, session) {
  globalThis.window = bundle.win
  globalThis.document = bundle.win.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = desktopRequire('react')
  const ReactDOM = desktopRequire('react-dom/client')
  // act 从 react 本体取（react-dom/test-utils 那份已经废弃，会打一行弃用告警）。
  const {act} = desktopRequire('react')
  const container = bundle.win.document.getElementById('composer')
  const root = ReactDOM.createRoot(container)
  const component = bundle.registered[0].component
  /**
   * 这个替身**自己就是一个真钩子**（内部用 React.useRef）。
   *
   * 效果：插件只要在渲染期之外调用它（线上那个 bug：在拖放回调里调 useInput），
   * React 立刻抛 #321 —— 不需要我在外面手工标"现在是渲染期"，也就不会因为我标的窗口
   * 跟 React 的真实调度错位而误报。渲染期之外的一次调用 = 一个红灯。
   */
  const hookCalls = []
  // 初始快照取自这条假会话（真应用里第一次渲染读到的就是输入机刚发布的那份）。
  // 注意这里是**上游真快照的形状**（InputState：draft/draftRev）——插件的选择器按它读。
  // 之前写成插件内部的 {text, rev} 就出现"看起来通了其实读的是 undefined"。
  let snapshot = {draft: session.input?.text ?? '', draftRev: session.input?.rev}
  const useInput = (selector) => {
    React.useRef(null)
    hookCalls.push('render')
    const current = snapshot
    return selector === undefined ? current : selector(current)
  }
  const props = {
    sessionId: session.sessionId,
    sessionCtx: session.ctx,
    useInput,
    inputActions: session.actions,
  }
  await act(async () => { root.render(React.createElement(component, props)) })
  /**
   * 挂载之后**不再用 act 驱动**，改回浏览器里那条真实路径。
   *
   * 为什么：`act` 的作用域一出栈，React 会把作用域内攒下的更新留在 lane 上等下一次 act；
   * 而拖放处理是异步的（拿路径 → 投引用事件 → setState 都在微任务里），于是断言落在 act 里
   * 读到的是上一帧、落在 act 外又永远等不到渲染。两条路都指向同一个结论：
   * **拖放之后的断言用真实时间等，而不是用 act 逼渲染**——浏览器里本来就没有 act。
   * 挂载这一次仍然走 act，因为「首帧必须由我们主动 flush」只有它做得到。
   */
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  return {
    container,
    act,
    /** 钩子被调用了几次（每次渲染一次；拖放回调里绝不该再多出来）。 */
    hookCalls: () => hookCalls.length,
    /** 改草稿 + 重新渲染（真应用里是用户打字触发发布）。 */
    setDraft: async (next) => {
      snapshot = next
      await act(async () => { root.render(React.createElement(component, props)) })
    },
    /** 用真实时间等一个条件（拖放全链路是异步的）。失败信息带上当前帧，省得再猜。 */
    waitUntil: async (predicate, timeout = 2000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolveTick) => { setTimeout(resolveTick, 5) })
      }
      throw new Error(`等待条件超时，界面停在：${JSON.stringify(container.textContent ?? '')}`)
    },
    unmount: async () => {
      // 卸载不再包 act：act 环境在挂载之后就关掉了（见上），这里再包一层只会得到
      // "not configured to support act" 的告警，而 `root.unmount()` 本身是同步的。
      root.unmount()
    },
  }
}

/** 走 apply 装一遍的产物：既拿到注册面，也让组件能挂。 */
function appliedBundle({react = lazyReact} = {}) {
  const bundle = loadBundle({react})
  bundle.registered = []
  bundle.detached = []
  const ctx = {
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (key, callback) => { bundle.slotKey = key; return callback() },
          register: (options, component) => {
            bundle.registered.push({options, component})
            return () => { bundle.detached.push(options.id) }
          },
        }
      }
      if (name === 'sessions') return {scope: () => undefined}
      return undefined
    },
    effect: (setup) => { setup() },
    logger: {warn: () => {}},
  }
  bundle.exports.apply(ctx)
  assert.equal(bundle.registered.length, 1, 'apply 必须注册一个覆盖层条目')
  assert.equal(bundle.slotKey, 'conversation.input.overlay')
  return bundle
}

test('挂上真组件：拖动期与插入成功都**不出任何提示**（反馈只有输入框里的引用块）；卸载后不再接管', async () => {
  const bundle = appliedBundle({react: desktopRequire('react')})
  const session = fakeSession({draft: '', draftRev: 7})
  const folderFile = {name: 'dsh-pet'}
  bundle.win.__DSH_DESKTOP_FILE_PATH__ = {getPathForFile: (file) => (file === folderFile ? '/Users/vian/research/dsh-pet' : '')}
  const mounted = await mountOverlay(bundle, session)

  const dataTransfer = transfer({entries: [{isDirectory: true, file: folderFile}]})
  dispatch(bundle.win, 'dragenter', dataTransfer)
  dispatch(bundle.win, 'dragover', dataTransfer)
  await tick()
  // 拖动过程中不显示路径浮层：那条浮层跟输入框里将要出现的引用块是同一份信息，
  // 而且会盖住卡片上沿（节点/供给那一行）。用户要的是"不要它"。
  assert.equal(
    mounted.container.textContent.trim(),
    '',
    `拖动过程中不该出现任何提示文字；当前：${JSON.stringify(mounted.container.textContent)}`,
  )

  const drop = dispatch(bundle.win, 'drop', dataTransfer)
  assert.equal(drop.defaultPrevented, true, '这一格证明监听真的装在 window 上了')
  await mounted.waitUntil(() => session.emitted.length === 1)
  assert.deepEqual(
    {start: session.emitted[0].request.span.start, rev: session.emitted[0].request.span.draftRev},
    {start: 0, rev: 7},
    '组件走的是这台会话的草稿快照（useInput），不是某个过期缓存',
  )
  // 插完之后**界面里也不许出现任何浮层**：唯一的反馈是输入框里那个引用块（本用例由
  // session.emitted 代表）。这条是用户连着打回来两次的诉求，钉死它。
  await tick()
  await tick()
  assert.equal(
    mounted.container.textContent.trim(),
    '',
    `插入成功时不该有任何提示文字；当前：${JSON.stringify(mounted.container.textContent)}`,
  )
  assert.ok(
    !mounted.container.textContent.includes('读不到'),
    `路径读到了就不该报「读不到」；当前界面：${mounted.container.textContent}`,
  )

  await mounted.unmount()
  const late = dispatch(bundle.win, 'drop', transfer({entries: [{isDirectory: true, file: folderFile}]}))
  assert.equal(late.defaultPrevented, false, '组件卸载（会话关掉）之后不该再抢拖放')
})

/* ------------------------------------------------------------------ 契约回归 */

test('客户端半必须声明 inject（slots/sessions）——否则 apply 会在服务就绪前就被调用，静默不接管', () => {
  const {exports} = loadBundle()
  const declared = Array.from(exports.inject ?? [])
  // 这个数组来自 vm 里的 realm，跨 realm 的 deepStrictEqual 会因原型不同而报"看起来一样但不相等"。
  assert.equal(
    declared.join(','),
    'slots,sessions',
    'cordis 客户端按这个数组等服务；漏了它 apply 里 ctx.get("slots") 就是 undefined，'
    + '插件会在第一道门静默 return —— 线上表现是"拖文件夹什么都不会发生"',
  )
})

test('insertReference 读的是**渲染期取好的**草稿快照（useInput 是真 React 钩子，回调里调不得）', () => {
  const {test} = loadBundle()
  const session = fakeSession({draft: '看下这个目录 ', draftRev: 11})
  // 组件渲染期读到的形状：{text, rev, ready}
  const rendered = {text: '看下这个目录 ', rev: 11, ready: true}
  assert.equal(
    test.insertReference({ctx: session.ctx, actions: session.actions, input: rendered}, '@/tmp/a/', '/tmp/a/'),
    true,
    '有渲染期快照时应当读得到草稿并插进引用',
  )
  assert.equal(session.emitted.length, 1)
  assert.equal(session.emitted[0].request.span.draftRev, 11, 'draftRev 要来自快照（上游拿它做 CAS）')
  assert.equal(session.emitted[0].request.span.start, '看下这个目录 '.length, '插在草稿末尾')

  // 反面 1：没拿到快照（组件没渲染 / useInput 缺席）→ 明确失败，界面提示重试
  const missing = fakeSession()
  assert.equal(
    test.insertReference({ctx: missing.ctx, actions: missing.actions, input: undefined}, '@/tmp/a/', '/tmp/a/'),
    false,
    '没有快照时不能瞎插（会写出一个 draftRev 对不上的引用）',
  )

  // 反面 2：把 useInput 这个**函数**当草稿对象塞进来（老实现的形状）→ 同样明确失败
  assert.equal(
    test.insertReference({ctx: missing.ctx, actions: missing.actions, input: (selector) => selector({draft: '', draftRev: 3})}, '@/tmp/a/', '/tmp/a/'),
    false,
    '函数形状不是快照；读到 undefined 就失败，而不是把函数当草稿',
  )
})

/* ------------------------------------------------------------------ 小工具 */

function tick() {
  return new Promise((resolveTick) => { setTimeout(resolveTick, 0) })
}
/**
 * 等一个条件成立（插路径是异步的：先拿路径再投事件）。
 * @param {() => boolean} predicate 条件。
 * @param {number} [tries] 轮数上限。
 */
async function until(predicate, tries = 50) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return
    await tick()
  }
  throw new Error('等待条件超时')
}
