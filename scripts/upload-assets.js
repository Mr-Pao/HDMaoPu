'use strict';

/**
 * 把 initStorage/系统/ 下的系统素材图上传到 COS，key 为「系统/<原文件名>」。
 *
 * 小程序端 config.js 里直接写死了这些图片的对象地址，例如
 *   https://maopu-1258113633.cos.ap-guangzhou.myqcloud.com/系统/科普1.png
 * 所以 key 必须保留中文目录名和中文文件名，不能改名也不能做 URL 编码。
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx COS_BUCKET=xx COS_REGION=xx node scripts/upload-assets.js
 *   加 DRY_RUN=1 只做校验和打印，不发起网络请求，也不需要密钥。
 */

const fs = require('fs');
const path = require('path');

const {
  COS_SECRET_ID,
  COS_SECRET_KEY,
  COS_BUCKET,
  COS_REGION,
  DRY_RUN,
} = process.env;

const ASSET_DIR = path.resolve(__dirname, '..', 'initStorage', '系统');
const KEY_PREFIX = '系统/';
const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

// 7 天：素材图几乎不换，让客户端和 CDN 少回源
const CACHE_CONTROL = 'max-age=604800';

// 桶是私有读，桶策略对匿名访问不生效（实测过，见 upload-data.js）。
// 小程序是匿名 GET，只能靠对象级 ACL，否则科普图、赞赏码全是裂图。
const OBJECT_ACL = 'public-read';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

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
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// 扫描 initStorage/系统/ 下的图片；扩展名不认识的文件直接报错，避免漏传
function collectFiles() {
  if (!fs.existsSync(ASSET_DIR)) {
    console.error('找不到素材目录：' + ASSET_DIR);
    process.exit(1);
  }

  const names = fs.readdirSync(ASSET_DIR)
    .filter(name => !name.startsWith('.'))
    .sort();

  if (!names.length) {
    console.error('系统素材目录下没有任何文件');
    process.exit(1);
  }

  const files = [];
  const errors = [];

  for (const name of names) {
    const ext = path.extname(name).toLowerCase();

    if (IMAGE_EXTS.indexOf(ext) === -1) {
      errors.push(`${name}: 不支持的扩展名 ${ext || '(无)'}`);
      continue;
    }

    const file = path.join(ASSET_DIR, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      errors.push(`${name}: 读取失败 —— ${err.message}`);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!stat.size) {
      errors.push(`${name}: 空文件`);
      continue;
    }

    files.push({
      name,
      key: KEY_PREFIX + name,
      file,
      size: stat.size,
      contentType: CONTENT_TYPES[ext],
    });
  }

  if (errors.length) {
    console.error('素材校验未通过，已中止上传：');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  if (!files.length) {
    console.error('系统素材目录下没有可上传的图片');
    process.exit(1);
  }

  return files;
}

function createClient() {
  if (DRY) return null;
  // 只有真正上传时才 require，DRY_RUN 不需要装依赖
  const COS = require('cos-nodejs-sdk-v5');
  return new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
}

function putObject(cos, file) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: file.key,
        Body: fs.readFileSync(file.file),
        ContentType: file.contentType,
        CacheControl: CACHE_CONTROL,
        // 私有桶 + 匿名 GET，必须逐个对象打 public-read
        ACL: OBJECT_ACL,
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

async function main() {
  const files = collectFiles();

  console.log(`共 ${files.length} 个文件，前缀 ${KEY_PREFIX}，ACL ${OBJECT_ACL}，缓存 ${CACHE_CONTROL}`);
  console.log('----------------------------------------');
  for (const f of files) {
    console.log(`${f.key}  ${formatSize(f.size)}  ${f.contentType}`);
  }
  console.log('----------------------------------------');

  if (DRY) {
    console.log('DRY_RUN=1，只校验不上传。全部素材通过校验。');
    return;
  }

  assertEnv();
  const cos = createClient();

  let ok = 0;
  const failed = [];

  // 串行上传：10 个文件，没必要为并发引入额外的错误聚合复杂度
  for (const f of files) {
    try {
      const res = await putObject(cos, f);
      const etag = res && res.ETag ? String(res.ETag).replace(/"/g, '') : '-';
      console.log(`✔ ${f.key}  ${formatSize(f.size)}  上传成功（etag ${etag}）`);
      ok++;
    } catch (err) {
      console.error(`✘ ${f.key}  上传失败：${err && err.message ? err.message : err}`);
      failed.push(f.key);
    }
  }

  console.log('----------------------------------------');
  console.log(`完成：成功 ${ok} 个，失败 ${failed.length} 个`);
  if (failed.length) {
    console.error('失败列表：' + failed.join(', '));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('上传脚本异常：', err);
  process.exit(1);
});
