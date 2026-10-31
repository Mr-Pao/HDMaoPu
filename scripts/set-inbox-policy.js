'use strict';

/**
 * 给 COS 桶设置「匿名可写 inbox/ 前缀」的桶策略。
 *
 * 为什么需要：
 *   小程序要上报点赞、关注、人气这类高频写入，但客户端不能存任何密钥
 *   （小程序包可反编译，密钥一定会泄露）。所以只开放一个「只能写、不能读、
 *   不能删、不能列举」的投递口，写进去的内容由 GitHub Actions 每小时聚合。
 *
 * 权限边界（最小化）：
 *   Allow  匿名 PutObject  -> inbox/*
 *   其余全部拒绝（策略只写这一条 Allow，默认全 deny）
 *   不能读 inbox（读不到别人的 openid）
 *   不能删除（删不掉数据）
 *   不能列举（不知道有哪些对象）
 *   不能写 inbox 以外的任何前缀
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx COS_BUCKET=xx COS_REGION=xx node scripts/set-inbox-policy.js
 *   DRY_RUN=1 只打印策略，不发请求
 *
 * 注意：putBucketPolicy 会覆盖整个桶策略。脚本会先打印现有策略再覆盖。
 */

const https = require('https');

const {
  COS_SECRET_ID,
  COS_SECRET_KEY,
  COS_BUCKET,
  COS_REGION,
  DRY_RUN,
} = process.env;

const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

// 桶名形如 maopu-1258113633，末段就是 APPID
function parseAppId(bucket) {
  const m = /-(\d+)$/.exec(bucket || '');
  return m ? m[1] : '';
}

function assertEnv() {
  const missing = [];
  if (!COS_SECRET_ID) missing.push('COS_SECRET_ID');
  if (!COS_SECRET_KEY) missing.push('COS_SECRET_KEY');
  if (!COS_BUCKET) missing.push('COS_BUCKET');
  if (!COS_REGION) missing.push('COS_REGION');
  if (missing.length) {
    console.error('缺少环境变量：' + missing.join(', '));
    process.exit(1);
  }
  if (!parseAppId(COS_BUCKET)) {
    console.error('无法从桶名解析 APPID，桶名应形如 maopu-1258113633，实际：' + COS_BUCKET);
    process.exit(1);
  }
}

function buildPolicy() {
  const appId = parseAppId(COS_BUCKET);
  // Resource 格式固定为 qcs::cos:<region>:uid/<APPID>:<bucket>/<path>
  const inboxResource = `qcs::cos:${COS_REGION}:uid/${appId}:${COS_BUCKET}/inbox/*`;
  return {
    version: '2.0',
    Statement: [
      {
        Principal: { qcs: ['qcs::cam::anyone:anyone'] },
        Effect: 'Allow',
        Action: ['name/cos:PutObject'],
        Resource: [inboxResource],
      },
    ],
  };
}

function createClient() {
  const COS = require('cos-nodejs-sdk-v5');
  return new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
}

function getPolicy(cos) {
  return new Promise(resolve => {
    cos.getBucketPolicy(
      { Bucket: COS_BUCKET, Region: COS_REGION },
      (err, data) => {
        if (err) return resolve({ ok: false, err: err.message || String(err) });
        resolve({ ok: true, policy: data && data.Policy ? data.Policy : '(空)' });
      }
    );
  });
}

function putPolicy(cos, policy) {
  return new Promise((resolve, reject) => {
    cos.putBucketPolicy(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Policy: JSON.stringify(policy),
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

// 不带任何签名的 PUT，用来验证策略是否真的对匿名请求生效
function anonymousPut(key, body) {
  return new Promise(resolve => {
    const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
    const payload = Buffer.from(body, 'utf8');
    const req = https.request(
      {
        hostname: host,
        path: '/' + key,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: 15000,
      },
      res => {
        let text = '';
        res.on('data', d => (text += d));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: text.slice(0, 400) })
        );
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '请求超时' });
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(payload);
    req.end();
  });
}

function anonymousGet(key) {
  return new Promise(resolve => {
    const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
    const req = https.request(
      {
        hostname: host,
        path: '/' + key,
        method: 'GET',
        timeout: 15000,
      },
      res => {
        let text = '';
        res.on('data', d => (text += d));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: text.slice(0, 400) })
        );
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '请求超时' });
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

function deleteObject(cos, key) {  return new Promise(resolve => {
    cos.deleteObject(
      { Bucket: COS_BUCKET, Region: COS_REGION, Key: key },
      () => resolve()
    );
  });
}

async function main() {
  const policy = buildPolicy();

  console.log('桶：' + COS_BUCKET + '  地域：' + COS_REGION);
  console.log('将要设置的策略：');
  console.log(JSON.stringify(policy, null, 2));
  console.log('----------------------------------------');

  if (DRY) {
    console.log('DRY_RUN=1，只打印策略，不发请求。');
    return;
  }

  assertEnv();
  const cos = createClient();

  const before = await getPolicy(cos);
  if (before.ok) {
    console.log('现有策略：' + String(before.policy).slice(0, 300));
  } else {
    console.log('读取现有策略失败（可能本来就没有策略）：' + before.err);
  }
  console.log('----------------------------------------');

  try {
    await putPolicy(cos, policy);
    console.log('✔ 桶策略已设置');
  } catch (err) {
    console.error('✘ 设置桶策略失败：' + (err && err.message ? err.message : err));
    console.error('  如果是权限不足，说明这对密钥没有 PutBucketPolicy 权限，');
    console.error('  需要到腾讯云控制台 → COS → 存储桶 → 权限管理 → 存储桶访问权限 手动添加。');
    process.exit(1);
  }

  // 策略生效有秒级延迟，等一会儿再测
  await new Promise(r => setTimeout(r, 5000));

  console.log('----------------------------------------');
  console.log('开始匿名自测（不带任何签名）：');

  const ts = Date.now();
  const inboxKey = `inbox/_selftest/${ts}.json`;
  const outsideKey = `_selftest/${ts}.json`;
  const probe = JSON.stringify({ v: 1, kind: 'pop', openid: 'selftest', ts, data: { cat_id: 'c0' } });

  const r1 = await anonymousPut(inboxKey, probe);
  console.log(`  写 inbox/          -> HTTP ${r1.status}  ${r1.status === 200 ? '成功' : '失败'}`);
  if (r1.status !== 200) console.log('    响应：' + r1.body.replace(/\s+/g, ' ').slice(0, 200));

  const r2 = await anonymousPut(outsideKey, probe);
  const outsideBlocked = r2.status === 403 || r2.status === 401;
  console.log(`  写 inbox/ 以外的路径 -> HTTP ${r2.status}  ${outsideBlocked ? '被拒绝（符合预期）' : '未被拒绝（策略有漏洞！）'}`);

  // 匿名读 inbox 也必须失败
  const r3 = await anonymousGet(inboxKey);
  const readBlocked = r3.status === 403 || r3.status === 401;
  console.log(`  匿名读 inbox/      -> HTTP ${r3.status}  ${readBlocked ? '被拒绝（符合预期）' : '未被拒绝（策略有漏洞！）'}`);

  // 清理测试对象（用签名请求删，匿名删不掉是正常的）
  await deleteObject(cos, inboxKey);
  await deleteObject(cos, outsideKey);

  console.log('----------------------------------------');
  const writeOk = r1.status === 200;
  console.log('结论：');
  console.log('  匿名写 inbox：' + (writeOk ? '可用 ✔' : '不可用 ✘'));
  console.log('  越权写其他前缀：' + (outsideBlocked ? '已阻止 ✔' : '未阻止 ✘'));
  console.log('  匿名读 inbox：' + (readBlocked ? '已阻止 ✔' : '未阻止 ✘'));

  if (!writeOk) {
    console.log('');
    console.log('匿名写不可用时，改走备选方案：小程序内置一把只授权 inbox/* 的子账号密钥。');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('脚本异常：', err);
  process.exit(1);
});
