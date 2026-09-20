/**
 * electron-vite 主进程资源导入类型。
 *
 * `?asset` 后缀是 electron-vite 的约定：构建时把资源文件复制进产物，
 * 导入值为运行时可用的**绝对文件路径**（dev 与打包后均正确）。
 * 主进程用它给 BrowserWindow 传图标路径（渲染层的图片另有 vite 原生处理）。
 */
declare module '*.png?asset' {
  const src: string
  export default src
}
