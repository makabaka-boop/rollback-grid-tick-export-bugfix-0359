/*!
 * replay-worker.js — Worker 入口。
 *
 * 两种用法：
 *   - 浏览器（通过 http(s) 服务打开 index.html 时）：
 *       new Worker('replay-worker.js')
 *   - Node 测试（worker_threads）：
 *       new Worker(new URL('./replay-worker.js', import.meta.url))
 *
 * 通过 file:// 直接双击 index.html 时，页面不加载本文件，
 * 而是把 replay-core 内的 FACTORY 序列化进 Blob Worker（见 index.html）。
 * 计算逻辑无论哪种方式都来自同一份 replay-core.js。
 */
(function boot() {
  const isNode =
    typeof self === 'undefined' &&
    typeof require === 'function' &&
    typeof module === 'object';

  if (isNode) {
    const { parentPort } = require('worker_threads');
    const core = require('./replay-core.js');
    core.serveWorker(parentPort);
  } else {
    // 浏览器 hosted worker（http(s)）。Blob 方式启动时页面会直接把
    // ReplayCore 注入 worker 作用域并提前标记，见 index.html。
    if (!self.ReplayCore) {
      self.importScripts(new URL('replay-core.js', self.location.href).href);
    }
    self.ReplayCore.serveWorker(self);
  }
})();
