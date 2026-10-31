// COS inbox 写入通道
//
// 客户端不放任何 COS 密钥：桶策略只允许匿名 PutObject 到 inbox/ 前缀，
// 小程序把写请求 PUT 成一个 JSON 小文件，GitHub Actions 每小时聚合后回写 data/*.json。
//
//   PUT {base_url}/inbox/<kind>/<ts>-<openid前8位>-<rand4>.json
//   { "v": 1, "kind": "like", "openid": "xxx", "ts": 1793428992225, "data": { ... } }
//
// 约定：这里永远不 reject。写通道挂了只是这次同步丢了，本地覆盖层还在，UI 不该被卡住。

import config from "../config";
import { getCurrentUserOpenid } from "./common";

const WRITEBACK_TIMEOUT = 8000;
const RAND_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function rand4() {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += RAND_CHARS.charAt(Math.floor(Math.random() * RAND_CHARS.length));
  }
  return out;
}

// 发一个 PUT，成功（2xx）返回 true，任何异常都吞掉返回 false
function requestPut(url, body) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // wx.request 自带的 timeout 在低版本基础库上不生效，这里再兜一层
    const timer = setTimeout(() => {
      console.warn("[writeback] PUT 超时", url);
      finish(false);
    }, WRITEBACK_TIMEOUT);

    try {
      wx.request({
        url: url,
        method: "PUT",
        data: body,
        header: { "Content-Type": "application/json" },
        timeout: WRITEBACK_TIMEOUT,
        success(res) {
          const status = (res && res.statusCode) || 0;
          if (status >= 200 && status < 300) {
            finish(true);
            return;
          }
          console.warn("[writeback] PUT 返回非 2xx", status, url);
          finish(false);
        },
        fail(err) {
          console.warn("[writeback] PUT 失败", (err && err.errMsg) || "request-fail", url);
          finish(false);
        },
      });
    } catch (e) {
      console.warn("[writeback] PUT 异常", (e && e.message) || "request-throw", url);
      finish(false);
    }
  });
}

/**
 * 往 COS 的 inbox/ 前缀写一条待聚合的记录
 * @param {string} kind like / follow / pop / rating / comment / decision
 * @param {object} data 见各调用点
 * @returns {Promise<boolean>} 是否成功写进 inbox
 */
async function putInbox(kind, data) {
  if (!config.writeback_enabled) {
    return false;
  }
  const baseUrl = String(config.data_base_url || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return false;
  }

  try {
    const openid = (await getCurrentUserOpenid()) || "anon";
    const ts = Date.now();
    const key = `inbox/${kind}/${ts}-${openid.slice(0, 8)}-${rand4()}.json`;
    const body = JSON.stringify({
      v: 1,
      kind: kind,
      openid: openid,
      ts: ts,
      data: data || {},
    });
    return await requestPut(`${baseUrl}/${key}`, body);
  } catch (e) {
    console.warn("[writeback] putInbox 异常", kind, (e && e.message) || e);
    return false;
  }
}

module.exports = {
  putInbox,
};
