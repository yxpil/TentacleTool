'use strict';
/**
 * 统一的错误结果构造：把异常转成 { _text, isError, ... } 结构
 */
function errorResult(err) {
  const e = err || new Error('未知错误');
  const ssrf = e.code === 'SSRF_BLOCKED';
  const text = (ssrf ? '⛔ SSRF 拦截：' : '❌ 请求失败：') + e.message;
  return {
    _text: text,
    isError: true,
    ssrfBlocked: ssrf,
    error: e.message,
    errorCode: e.code || null
  };
}

module.exports = { errorResult };
