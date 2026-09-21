/**
 * dsh-plugin-drop-path — 宿主半体
 *
 * 这个插件的全部行为都在浏览器半（`client.js`）。宿主侧不需要注册工具、不需要 RPC 通道、
 * 也不需要往提示词里注入任何东西，所以这里只留一个**空 apply**。
 *
 * 那为什么还要有这一半：客户端 bundle 的发布是按 **Loader 条目**组图的（`client-modules`
 * 遍历 `ctx.loader.entries()`，逐个读各自的 package.json，遇到 `dsh.client.platform === 'web'`
 * 才把 `exports["./client"]` 的产物挂进 `__DSH_BOOT__`）。没有宿主条目，就没有图行，
 * 浏览器端那份 `client.js` 永远不会被加载。
 */
export const name = 'dsh-plugin-drop-path'
export const inject = []

export function apply() {
  /* 无宿主侧行为：文件夹路径的解析走的是浏览器半 + Electron preload 的文件路径桥。 */
}
