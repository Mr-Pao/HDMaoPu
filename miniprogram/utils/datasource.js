// COS 静态 JSON 数据源
//
// 后端从 EMAS Serverless 换成「COS 上的 data/<collection>.json」后，
// 页面代码里那 130+ 处 app.mpServerless.db.collection(...) 一行都不改，
// 由这里提供一份接口完全兼容的内存查询实现：
//
//   GET {baseUrl}/data/cat.json
//   { "version": "2026-10-31T13:00:00Z", "items": [ {...} ] }
//
// 缓存策略：stale-while-revalidate
//   - 启动时先用 wx.setStorageSync('ds_cache_<name>') 的旧缓存同步返回，页面立刻有内容
//   - 缓存超过 10 分钟则在后台静默刷新，下次读取就是新数据
//   - 拉取失败用旧缓存兜底；连缓存都没有就返回空数组，绝不让页面卡在 await 上
//
// 写入策略：COS 上的 JSON 是只读的，所有写操作落到本地覆盖层
//   - wx.setStorageSync('ds_local_<name>') 存新增/修改/删除标记
//   - 读取时把覆盖层合并到远程数据之上（同 _id 覆盖，新 _id 追加，删除标记剔除）
//   - 换设备就没了，这是「每月 ≤5 元、不用数据库」的取舍

const CACHE_TTL = 10 * 60 * 1000;      // 缓存有效期：10 分钟
const REQUEST_TIMEOUT = 8000;          // 单次请求超时：8 秒
const RETRY_COOLDOWN = 60 * 1000;      // 网络失败后 60 秒内不再重试，避免疯狂重试
const NOT_FOUND_COOLDOWN = CACHE_TTL;  // 404 说明这个集合本来就没有 JSON，longer

const COLLECTION_CACHE_PREFIX = 'ds_cache_';
const COLLECTION_LOCAL_PREFIX = 'ds_local_';
const OPENID_STORAGE_KEY = 'fake_openid';

// ---------- 本地存储（任何异常都不能往上抛，storage 满/损坏都要能跑） ----------

function _safeGet(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    if (value === '' || value === undefined || value === null) return fallback;
    return value;
  } catch (e) {
    console.warn('[datasource] getStorageSync 失败', key, e && e.message);
    return fallback;
  }
}

function _safeSet(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    console.warn('[datasource] setStorageSync 失败', key, e && e.message);
  }
}

function _randomHex(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

// ---------- 取值 / 比较 ----------

// 支持 'mapAccess.status' 这种点路径（页面里有 4 处在用）
function _getPath(obj, path) {
  if (obj === null || obj === undefined) return undefined;
  if (path.indexOf('.') === -1) return obj[path];
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function _compareValues(a, b) {
  const aEmpty = (a === null || a === undefined);
  const bEmpty = (b === null || b === undefined);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return -1;   // 空值当最小值
  if (bEmpty) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;  // 日期字符串按字典序比较即正确
}

// 单个字段的匹配：cond 可以是字面值，也可以是 { $ne: ... } 这类操作符对象
function _matchValue(value, cond) {
  if (cond instanceof RegExp) return cond.test(String(value));

  const isOperatorObject = cond !== null && typeof cond === 'object'
    && !Array.isArray(cond) && !(cond instanceof Date)
    && Object.keys(cond).some(k => k.charAt(0) === '$');

  if (!isOperatorObject) {
    // 普通对象 / 数组 / 标量：按等值处理
    if (cond !== null && typeof cond === 'object') {
      return JSON.stringify(value) === JSON.stringify(cond);
    }
    return value === cond;
  }

  const keys = Object.keys(cond);
  for (let i = 0; i < keys.length; i++) {
    const op = keys[i];
    const arg = cond[op];
    switch (op) {
      case '$eq':
        if (value !== arg) return false;
        break;
      case '$ne':
        if (value === arg) return false;
        break;
      case '$in':
        if (!Array.isArray(arg) || arg.indexOf(value) === -1) return false;
        break;
      case '$nin':
        if (Array.isArray(arg) && arg.indexOf(value) !== -1) return false;
        break;
      case '$gt':
        if (!(_compareValues(value, arg) > 0)) return false;
        break;
      case '$gte':
        if (!(_compareValues(value, arg) >= 0)) return false;
        break;
      case '$lt':
        if (!(_compareValues(value, arg) < 0)) return false;
        break;
      case '$lte':
        if (!(_compareValues(value, arg) <= 0)) return false;
        break;
      case '$exists': {
        const exists = value !== undefined;
        if (!!arg !== exists) return false;
        break;
      }
      case '$regex': {
        let re = arg;
        if (!(re instanceof RegExp)) {
          try {
            re = new RegExp(String(arg), cond.$options || '');
          } catch (e) {
            return false;  // 非法正则按不匹配处理，别让整条查询炸掉
          }
        }
        if (!re.test(String(value))) return false;
        break;
      }
      default:
        // 不认识的操作符（例如 $elemMatch）放行，宁可多返回也别把列表整个清空
        break;
    }
  }
  return true;
}

function _matchFilter(item, whereFilter) {
  if (!whereFilter) return true;
  const keys = Object.keys(whereFilter);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const cond = whereFilter[key];

    if (key === '$or') {
      if (!Array.isArray(cond)) continue;
      let hit = false;
      for (let j = 0; j < cond.length; j++) {
        if (_matchFilter(item, cond[j])) { hit = true; break; }
      }
      if (!hit) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(cond)) continue;
      for (let j = 0; j < cond.length; j++) {
        if (!_matchFilter(item, cond[j])) return false;
      }
      continue;
    }
    if (key === '$nor') {
      if (!Array.isArray(cond)) continue;
      for (let j = 0; j < cond.length; j++) {
        if (_matchFilter(item, cond[j])) return false;
      }
      continue;
    }

    if (!_matchValue(_getPath(item, key), cond)) return false;
  }
  return true;
}

// ---------- 排序 / 投影 / 分页 ----------

function _sortItems(items, sort) {
  if (!sort) return items;
  const fields = Object.keys(sort);
  if (!fields.length) return items;

  const sorted = items.slice();
  sorted.sort((a, b) => {
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const dir = (sort[field] === -1 || sort[field] === 'desc') ? -1 : 1;
      const cmp = _compareValues(_getPath(a, field), _getPath(b, field));
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
  return sorted;
}

// 支持 fields: ['_id', 'name']（mpserverless 风格）和 projection: { name: 1 }（mongo 风格）
function _projectItems(items, opts) {
  if (!opts) return items;
  const proj = opts.projection || opts.fields;
  if (!proj) return items;

  let include = null;
  let exclude = null;
  if (Array.isArray(proj)) {
    include = proj.slice();
  } else if (typeof proj === 'object') {
    const inc = [];
    const exc = [];
    Object.keys(proj).forEach(k => { (proj[k] ? inc : exc).push(k); });
    if (inc.length) include = inc; else exclude = exc;
  }
  if (!include && !exclude) return items;

  return items.map(item => {
    if (!item) return item;
    const out = {};
    if (include) {
      // _id 默认保留，除非显式写了 _id: 0
      const fields = include.indexOf('_id') === -1 && proj._id !== 0 ? include.concat('_id') : include;
      fields.forEach(k => { if (item[k] !== undefined) out[k] = item[k]; });
      return out;
    }
    Object.keys(item).forEach(k => { if (exclude.indexOf(k) === -1) out[k] = item[k]; });
    return out;
  });
}

// 一次性走完 筛选 → 排序 → 跳过 → 截断 → 投影，对齐 mpserverless 的 find(query, options)
function _applyQuery(items, filter, opts) {
  const list = Array.isArray(items) ? items : [];

  let data = filter ? list.filter(item => _matchFilter(item, filter)) : list.slice();

  if (opts && opts.sort) data = _sortItems(data, opts.sort);

  if (opts) {
    if (typeof opts.skip === 'number' && opts.skip > 0) data = data.slice(opts.skip);
    if (typeof opts.limit === 'number' && opts.limit >= 0) data = data.slice(0, opts.limit);
  }

  return _projectItems(data, opts);
}

// ---------- 写入数据补丁 ----------

// mpserverless 的 updateOne 第二个参数是「要改的字段平铺对象」，
// 这里额外兼容 $set / $inc 两种写法。
function _applyUpdatePatch(target, data) {
  if (!data) return {};
  const keys = Object.keys(data);
  const hasOperator = keys.some(k => k.charAt(0) === '$');
  if (!hasOperator) return Object.assign({}, data);

  const patch = {};
  keys.forEach(k => {
    if (k === '$set') {
      Object.assign(patch, data.$set);
    } else if (k === '$inc') {
      Object.keys(data.$inc).forEach(f => {
        patch[f] = (Number(target[f]) || 0) + Number(data.$inc[f]);
      });
    } else if (k !== '$unset') {
      patch[k] = data[k];
    }
  });
  return patch;
}

function createJsonServerless(options) {
  options = options || {};
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const states = {};   // collectionName -> { remote, version, fetchedAt, failedAt, failedStatus, inflight }

  function _state(name) {
    if (!states[name]) {
      states[name] = {
        remote: null,
        version: '',
        fetchedAt: 0,
        failedAt: 0,
        failedStatus: 0,
        inflight: null,
      };
    }
    return states[name];
  }

  function _cacheKey(name) { return COLLECTION_CACHE_PREFIX + name; }
  function _localKey(name) { return COLLECTION_LOCAL_PREFIX + name; }

  function _readCache(name) {
    const cached = _safeGet(_cacheKey(name), null);
    if (cached && Array.isArray(cached.items)) return cached;
    return null;
  }

  function _writeCache(name, version, items) {
    _safeSet(_cacheKey(name), { version: version || '', items: items, fetchedAt: Date.now() });
  }

  function _readLocal(name) {
    const local = _safeGet(_localKey(name), null);
    return Array.isArray(local) ? local : [];
  }

  function _writeLocal(name, list) {
    _safeSet(_localKey(name), list);
  }

  // 远程数据 + 本地覆盖层
  function _merged(name) {
    const st = _state(name);
    const remote = Array.isArray(st.remote) ? st.remote : [];
    const local = _readLocal(name);
    if (!local.length) return remote.slice();

    const overrides = {};
    const appends = [];
    const deleted = {};
    const remoteIds = {};

    remote.forEach(item => {
      if (item && item._id !== undefined && item._id !== null) remoteIds[item._id] = true;
    });

    local.forEach(item => {
      if (!item || item._id === undefined || item._id === null) return;
      if (item.__ds_deleted) { deleted[item._id] = true; return; }
      if (remoteIds[item._id]) overrides[item._id] = item;
      else appends.push(item);
    });

    const result = [];
    remote.forEach(item => {
      if (!item) return;
      const id = item._id;
      if (id !== undefined && id !== null) {
        if (deleted[id]) return;
        if (overrides[id]) { result.push(Object.assign({}, item, overrides[id])); return; }
      }
      result.push(item);
    });

    return result.concat(appends);
  }

  // ---------- 网络 ----------

  function _requestCollection(name) {
    return new Promise(resolve => {
      if (!baseUrl) {
        resolve({ ok: false, reason: 'baseUrl 未配置', status: 0 });
        return;
      }

      let settled = false;
      const finish = res => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };
      // wx.request 自带的 timeout 在低版本基础库上不生效，这里再兜一层
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', status: 0 }), REQUEST_TIMEOUT);

      const url = `${baseUrl}/data/${name}.json`;
      try {
        wx.request({
          url: url,
          method: 'GET',
          timeout: REQUEST_TIMEOUT,
          dataType: 'json',
          success(res) {
            const status = res && res.statusCode;
            const body = res && res.data;
            if (status === 200 && body && Array.isArray(body.items)) {
              finish({ ok: true, items: body.items, version: body.version || '' , status: status });
              return;
            }
            console.warn('[datasource] ' + url + ' 响应格式不符，期望 {version, items:[]}', status);
            finish({ ok: false, reason: 'bad-response', status: status || 0 });
          },
          fail(err) {
            finish({ ok: false, reason: (err && err.errMsg) || 'request-fail', status: 0 });
          },
        });
      } catch (e) {
        finish({ ok: false, reason: (e && e.message) || 'request-throw', status: 0 });
      }
    });
  }

  function _refresh(name) {
    const st = _state(name);
    if (st.inflight) return st.inflight;

    st.inflight = _requestCollection(name).then(res => {
      st.inflight = null;
      if (res.ok) {
        st.remote = res.items;
        st.version = res.version;
        st.fetchedAt = Date.now();
        st.failedAt = 0;
        st.failedStatus = 0;
        _writeCache(name, res.version, res.items);
      } else {
        st.failedAt = Date.now();
        st.failedStatus = res.status;
        console.warn(
          `[datasource] data/${name}.json 拉取失败（${res.reason}），` +
          (st.remote ? '继续使用旧缓存 ' + st.remote.length + ' 条' : '无缓存可用，返回空列表')
        );
      }
      return _merged(name);
    }).catch(e => {
      // 理论上到不了这里，兜一层保证永远 resolve
      st.inflight = null;
      st.failedAt = Date.now();
      console.warn('[datasource] data/' + name + '.json 异常', e && e.message);
      return _merged(name);
    });

    return st.inflight;
  }

  // 拿到某集合的完整数据（远程 + 本地覆盖层）。
  // 有缓存立刻返回、后台刷新；没缓存才等网络，且最多等 REQUEST_TIMEOUT。
  function _load(name) {
    const st = _state(name);

    if (!st.remote) {
      const cached = _readCache(name);
      if (cached) {
        st.remote = cached.items;
        st.version = cached.version || '';
        st.fetchedAt = cached.fetchedAt || 0;
      }
    }

    const now = Date.now();
    if (st.remote) {
      const stale = !st.fetchedAt || (now - st.fetchedAt > CACHE_TTL);
      if (stale && !_isCoolingDown(st, now)) _refresh(name);  // 后台刷新，不 await
      return Promise.resolve(_merged(name));
    }

    if (_isCoolingDown(st, now)) return Promise.resolve([]);
    return _refresh(name);
  }

  function _isCoolingDown(st, now) {
    if (!st.failedAt) return false;
    const cooldown = st.failedStatus === 404 ? NOT_FOUND_COOLDOWN : RETRY_COOLDOWN;
    return (now - st.failedAt) < cooldown;
  }

  // ---------- 写操作：本地覆盖层 ----------

  async function _insertOne(name, data) {
    const doc = Object.assign({}, data);
    if (doc._id === undefined || doc._id === null) {
      doc._id = 'local_' + Date.now().toString(36) + _randomHex(6);
    }
    const local = _readLocal(name).filter(x => !(x && x._id === doc._id));
    local.push(doc);
    _writeLocal(name, local);
    console.log('[datasource] insertOne 写入本地覆盖层', name, doc._id);
    return { result: { _id: doc._id }, id: doc._id };
  }

  async function _updateOne(name, filter, data) {
    const items = await _load(name);
    const target = items.filter(item => _matchFilter(item, filter))[0];
    if (!target) {
      console.log('[datasource] updateOne 未命中，忽略', name, filter);
      return { result: { updated: 0 } };
    }

    const patch = _applyUpdatePatch(target, data);
    const local = _readLocal(name).filter(x => !(x && x._id === target._id && x.__ds_deleted));
    const idx = local.findIndex(x => x && x._id === target._id);
    if (idx >= 0) local[idx] = Object.assign({}, local[idx], patch);
    else local.push(Object.assign({}, target, patch));

    _writeLocal(name, local);
    return { result: { updated: 1 } };
  }

  async function _deleteOne(name, filter) {
    const items = await _load(name);
    const target = items.filter(item => _matchFilter(item, filter))[0];
    if (!target) return { result: { deleted: 0 } };

    const local = _readLocal(name).filter(x => !(x && x._id === target._id));
    local.push({ _id: target._id, __ds_deleted: true });
    _writeLocal(name, local);
    return { result: { deleted: 1 } };
  }

  // ---------- 云函数兼容层 ----------
  // 原来有几个 unionOp 动作本质是「读几个集合 + 算一下」，没有写库也没有第三方调用，
  // 这里在本地重算一遍，页面代码不用改。
  // 其他动作（getURL / getTempCOS / getMpCode / getCatStats ...）真的需要服务端能力，
  // 统一走下面的兜底日志 + 返回 null。

  // 对应 unionOp/getCatLocations：每只猫最新带定位的过审照片 + 轨迹点数 + 猫信息
  async function _getCatLocations() {
    const photos = await _load('photo');
    const valid = photos.filter(p => p
      && p.verified === true
      && p.deleted !== 1
      && p.latitude !== null && p.latitude !== undefined
      && p.longitude !== null && p.longitude !== undefined);

    const latest = {};
    const seenKeys = {};
    const countMap = {};

    valid.forEach(p => {
      const cid = p.cat_id;
      if (!cid) return;

      // 取 shooting_date 最新的一条（相同则 _id 大的优先，和原聚合的 $sort 一致）
      const cur = latest[cid];
      if (!cur) {
        latest[cid] = p;
      } else {
        const cmp = _compareValues(p.shooting_date, cur.shooting_date);
        if (cmp > 0 || (cmp === 0 && _compareValues(p._id, cur._id) > 0)) latest[cid] = p;
      }

      // 轨迹点数：同一天同一坐标（5 位小数≈1 米）算一个点
      const key = cid
        + '|' + String(p.shooting_date || '').substring(0, 10)
        + '|' + Math.round((p.latitude || 0) * 100000)
        + '|' + Math.round((p.longitude || 0) * 100000);
      if (!seenKeys[key]) {
        seenKeys[key] = true;
        countMap[cid] = (countMap[cid] || 0) + 1;
      }
    });

    const cats = await _load('cat');
    const catMap = {};
    cats.forEach(c => { if (c && c._id) catMap[c._id] = c; });

    function _catFields(cat) {
      cat = cat || {};
      return {
        name: cat.name || '',
        avatar: cat.avatar || '',
        campus: cat.campus || '',
        area: cat.area || '',
        gender: cat.gender || '',
        characteristics: cat.characteristics || '',
        habit: cat.habit || '',
        tutorial: cat.tutorial || '',
        adopt: cat.adopt || '0',
        to_star: cat.to_star || false,
        haunts: cat.haunts || [],
      };
    }

    const result = Object.keys(latest).map(cid => {
      const loc = latest[cid];
      return Object.assign({
        cat_id: cid,
        latitude: loc.latitude,
        longitude: loc.longitude,
        location_time: loc.shooting_date || '',
        uid: loc.user_id || loc._openid || '',
        trajectory_count: countMap[cid] || 0,
      }, _catFields(catMap[cid]));
    });

    // 有常出没地点、但没有定位照片的猫也上图（锚点取第一个地点）
    const existed = {};
    result.forEach(r => { existed[r.cat_id] = true; });
    cats.forEach(c => {
      if (!c || !c._id || existed[c._id] || c.deleted === 1) return;
      const haunts = (c.haunts || []).filter(h => h && h.latitude != null && h.longitude != null);
      if (!haunts.length) return;
      result.push(Object.assign({
        cat_id: c._id,
        latitude: haunts[0].latitude,
        longitude: haunts[0].longitude,
        location_time: '',
        uid: '',
        trajectory_count: 0,
      }, _catFields(c)));
    });

    return { success: true, data: result };
  }

  // 对应 unionOp/getCatTrajectory：某只猫所有带定位的过审照片，按天+坐标去重
  async function _getCatTrajectory(catId) {
    if (!catId) return { success: false, errMsg: 'missing cat_id' };

    const photos = await _load('photo');
    const points = photos.filter(p => p
      && p.cat_id === catId
      && p.verified === true
      && p.deleted !== 1
      && p.latitude !== null && p.latitude !== undefined
      && p.longitude !== null && p.longitude !== undefined);

    points.sort((a, b) => {
      const cmp = _compareValues(a.shooting_date, b.shooting_date);
      return cmp !== 0 ? cmp : _compareValues(a._id, b._id);
    });

    const seen = {};
    const data = [];
    points.forEach(p => {
      const key = String(p.shooting_date || '').substring(0, 10)
        + '|' + Math.round((p.latitude || 0) * 100000)
        + '|' + Math.round((p.longitude || 0) * 100000);
      if (seen[key]) return;
      seen[key] = true;
      data.push({
        latitude: p.latitude,
        longitude: p.longitude,
        location_time: p.shooting_date || '',
        uid: p.user_id || p._openid || '',
        photo_id: p.photo_id || '',
        photo_compressed: p.photo_compressed || '',
        photographer: p.photographer || '',
      });
    });

    return { success: true, data: data };
  }

  // 对应 unionOp/curdOp：add / update / remove / set / inc / read
  // 原来的权限校验（manager 等级）在这里没有服务端可依托，直接不做 —— 数据本来只落本地。
  async function _curdOp(params) {
    const name = params.collection;
    const operation = params.operation;
    if (!name) return { ok: false, errMsg: 'no collection name.' };

    if (operation === 'add') {
      const doc = Object.assign({}, params.data || {});
      if (!doc._openid) doc._openid = _getOrCreateOpenid();
      const now = new Date().toISOString();
      if (!doc.create_date) doc.create_date = now;
      if (!doc.mdate) doc.mdate = now;
      const res = await _insertOne(name, doc);
      return { ok: true, insertedId: res.result._id, result: res.result };
    }

    if (operation === 'update') {
      if (!params.item_id) return { ok: false, errMsg: 'missing item_id' };
      const patch = Object.assign({}, params.data || {}, { mdate: new Date().toISOString() });
      const res = await _updateOne(name, { _id: params.item_id }, patch);
      return { ok: res.result.updated > 0, updated: res.result.updated };
    }

    if (operation === 'remove') {
      if (!params.item_id) return { ok: false, errMsg: 'missing item_id' };
      const res = await _deleteOne(name, { _id: params.item_id });
      return { ok: res.result.deleted > 0, deleted: res.result.deleted };
    }

    if (operation === 'set') {
      if (!params.item_id) return { ok: false, errMsg: 'missing item_id' };
      const patch = params.data || {};
      const items = await _load(name);
      const existing = items.filter(i => i && i._id === params.item_id)[0];
      if (existing) await _updateOne(name, { _id: params.item_id }, patch);
      else await _insertOne(name, Object.assign({ _id: params.item_id }, patch));
      return { ok: true, result: Object.assign({}, existing, patch) };
    }

    if (operation === 'inc') {
      const field = params.type === 'pop' ? 'popularity'
        : params.type === 'like' ? 'like_count' : null;
      if (!field) return { ok: false, errMsg: 'unk type ' + params.type };
      if (!params.item_id) return { ok: false, errMsg: 'missing item_id' };
      const inc = {};
      inc[field] = 1;
      const res = await _updateOne(name, { _id: params.item_id }, { $inc: inc });
      return { ok: res.result.updated > 0, updated: res.result.updated };
    }

    if (operation === 'read') {
      const items = await _load(name);
      return _applyQuery(items, {}, {
        sort: { genTime: -1 },   // 与原云函数一致
        skip: params.skip,
        limit: params.limit,
        projection: params.projection,
      });
    }

    return { ok: false, errMsg: 'unk operation ' + operation };
  }

  // 对应 userOp：get / update / updateRole
  // 原云函数在用户不存在时会新建，本地照做；不补这一步首屏永远拿不到用户信息
  async function _userOp(params) {
    const args = params || {};
    const op = args.op;
    const openid = args.openid || _getOrCreateOpenid();

    async function findUser(oid) {
      const items = await _load('user');
      return items.filter(u => u && u.openid === oid)[0] || null;
    }

    if (op === 'get') {
      const existing = await findUser(openid);
      if (existing) return existing;

      // 第一个用户自动拿到 manager = 99，与 functionsEMAS/unionOp/userOp.js 一致
      const all = await _load('user');
      const newUser = { openid: openid };
      if (all.length === 0) newUser.manager = 99;
      const res = await _insertOne('user', newUser);
      console.log('[datasource] 新建用户 ' + openid + (newUser.manager ? '（首个用户，超级管理员）' : ''));
      return Object.assign({ _id: res.result._id }, newUser);
    }

    if (op === 'update') {
      const self = await findUser(openid);
      if (!self) return 'Err, user not found.';
      const patch = Object.assign({}, args.user || {});
      delete patch._id;
      delete patch.openid;
      delete patch.manager;   // 不允许自己提权，与云函数一致
      await _updateOne('user', { openid: openid }, patch);
      return await findUser(openid);
    }

    if (op === 'updateRole') {
      // 云函数原实现拿调用者 openid 当条件（会改错人），这里按 user.openid 指向的目标改
      const target = (args.user && args.user.openid) || openid;
      const patch = Object.assign({}, args.user || {});
      delete patch._id;
      await _updateOne('user', { openid: target }, patch);
      return await findUser(target);
    }

    return 'unknown op: ' + op;
  }

  // 对应 unionOp/getAllSci：科普页的问答列表（data/science.json）
  // 原云函数按 MAX_LIMIT 分页拉完整集合再拼接；静态源一次 _load 全量载入，
  // 沿用它的返回口径：直接给数组。页面（pages/news/sciDetail）拿到后原样 setData 成 qnas。
  async function _getAllSci() {
    const items = await _load('science');
    return items.slice();
  }

  // 对应 unionOp/getCatStats：数据看板统计
  // 原云函数对每个指标单独 count，静态数据源一次 _load 全量载入内存算，
  // 省掉十几次往返；口径与 functionsEMAS/unionOp/getCatStats.js 保持一致
  async function _getCatStats() {
    const cats = await _load('cat');
    const settings = await _load('setting');

    const filterSetting = settings.filter(s => s && s._id === 'filter')[0] || {};
    const campuses = filterSetting.campuses || [];
    const colours = filterSetting.colour || [];
    const areaDefs = filterSetting.area || [];

    const alive = cats.filter(c => c && c.deleted !== 1);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTs = monthStart.getTime();

    const pct = (n, d) => (d > 0 ? parseFloat((n / d * 100).toFixed(1)) : 0);
    const isCurrent = c => c.adopt !== 1 && !c.missing && !c.to_star;
    const inMonth = t => t && new Date(t).getTime() >= monthTs;

    const total = alive.length;
    const sterilized = alive.filter(c => c.sterilized === true).length;
    const adopted = alive.filter(c => c.adopt === 1).length;
    const missing = alive.filter(c => c.missing === true).length;
    const deceased = alive.filter(c => c.to_star === true).length;
    const currentList = alive.filter(isCurrent);
    const current = currentList.length;
    const currentSterilized = currentList.filter(c => c.sterilized === true).length;

    const male = alive.filter(c => c.gender === '公').length;
    const female = alive.filter(c => c.gender === '母').length;
    const unknownList = alive.filter(c => c.gender !== '公' && c.gender !== '母');
    const genderTotal = male + female + unknownList.length;

    const campus = campuses.map(name => {
      const inCampus = alive.filter(c => c.campus === name);
      const campusSterilized = inCampus.filter(c => c.sterilized === true).length;
      const areas = areaDefs.filter(a => a.campus === name).map(def => {
        const list = alive.filter(c => c.campus === name && c.area === def.name);
        const sterList = list.filter(c => c.sterilized === true);
        const tnr = _tnrIndex(list, sterList, monthTs);
        return {
          area: def.name,
          count: list.length,
          gender: {
            male: list.filter(c => c.gender === '公').length,
            female: list.filter(c => c.gender === '母').length,
            unknown: list.filter(c => c.gender === '未知').length,
          },
          sterilized: sterList.length,
          sterilizationRate: pct(sterList.length, list.length),
          tnrIndex: tnr.index,
          tnrDetail: tnr.detail,
        };
      });
      return {
        campus: name,
        count: inCampus.length,
        sterilized: campusSterilized,
        sterilizationRate: pct(campusSterilized, inCampus.length),
        areas: areas,
      };
    });

    const colourStats = colours.map(name => ({
      colour: name,
      count: alive.filter(c => c.colour === name).length,
    }));

    // 全站评分汇总：基于各猫 rating.scores 的 r1..r5 票数做加权平均
    let ratingSum = 0;
    let ratingCount = 0;
    alive.forEach(c => {
      const scores = c.rating && c.rating.scores;
      if (!scores) return;
      for (let i = 1; i <= 5; i++) {
        const n = Number(scores['r' + i]) || 0;
        ratingSum += i * n;
        ratingCount += n;
      }
    });
    const ratingAvg = ratingCount > 0 ? parseFloat((ratingSum / ratingCount).toFixed(1)) : 0;

    // 本月事件：新猫 / 绝育 / 领养 / 失踪 / 喵星
    const eventTypes = [
      ['新猫', 'create_time', c => true, 'newCats'],
      ['绝育', 'sterilized_time', c => c.sterilized === true, 'sterilized'],
      ['领养', 'adopt_time', c => c.adopt === 1, 'adopted'],
      ['失踪', 'missing_time', c => c.missing === true, 'missing'],
      ['喵星', 'deceased_time', c => c.to_star === true, 'deceased'],
    ];
    const month = { newCats: 0, sterilized: 0, adopted: 0, missing: 0, deceased: 0 };
    let events = [];

    eventTypes.forEach(function (def) {
      const type = def[0], field = def[1], cond = def[2], key = def[3];
      const hit = alive.filter(c => cond(c) && inMonth(c[field]));
      month[key] = hit.length;
      hit.forEach(c => events.push({
        type: type,
        date: _relativeDate(c[field]),
        timestamp: c[field],
        name: c.name,
        id: c._id,
      }));
    });
    events = events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      success: true,
      data: {
        basic: {
          total: total,
          sterilized: sterilized,
          missing: missing,
          adopted: adopted,
          deceased: deceased,
          current: current,
          currentSterilized: currentSterilized,
        },
        rates: {
          sterilization: pct(sterilized, total),
          currentSterilization: pct(currentSterilized, current),
          adoption: pct(adopted, total),
        },
        gender: {
          male: { count: male, rate: pct(male, genderTotal) },
          female: { count: female, rate: pct(female, genderTotal) },
          unknown: {
            count: unknownList.length,
            rate: pct(unknownList.length, genderTotal),
            cats: unknownList.map(c => c.name || '未命名'),
          },
        },
        month: month,
        campus: campus,
        colour: colourStats,
        events: events,
        ratingAvg: ratingAvg,
        ratingCount: ratingCount,
      },
    };
  }

  // TNR 指数，算法逐项照搬云函数，只把 monthStart 换成毫秒时间戳
  function _tnrIndex(allCats, sterilizedCats, monthTs) {
    const W = { BASE: 0.4, GROWTH: 0.4, ADOPTION: 0.3, SURVIVAL: 0.2, REG: 0.1 };
    const pct = (n, d) => (d > 0 ? parseFloat((n / d * 100).toFixed(1)) : 0);

    const aliveSter = sterilizedCats.filter(c => c.adopt !== 1 && !c.missing && !c.to_star);
    const aliveNonAdopted = allCats.filter(c => c.adopt !== 1 && !c.missing && !c.to_star);
    const N = allCats.filter(c => c.create_time && new Date(c.create_time).getTime() >= monthTs).length;

    let D = 0, M = 0, totalD = 0, totalM = 0;
    const nonAdopted = allCats.filter(c => c.adopt !== 1);
    nonAdopted.forEach(c => {
      if (c.to_star === true) {
        totalD++;
        if (c.deceased_time && new Date(c.deceased_time).getTime() >= monthTs) D++;
      } else if (c.missing === true) {
        totalM++;
        if (c.missing_time && new Date(c.missing_time).getTime() >= monthTs) M++;
      }
    });

    const totalCats = Math.max(allCats.length, 1);
    const totalNonAdopted = Math.max(nonAdopted.length, 1);

    const sterilizationRate = pct(sterilizedCats.length, totalCats);
    const netSterilizationRate = aliveNonAdopted.length > 0 ? pct(aliveSter.length, aliveNonAdopted.length) : 100;
    const initialCats = nonAdopted.length - N;
    const growthRate = initialCats > 0 ? pct(N - (D + M), initialCats) : 0;
    const survivalRate = 100 - pct(totalD, totalNonAdopted);
    const registrationRate = totalNonAdopted - totalD > 0 ? 100 - pct(totalM, totalNonAdopted - totalD) : 0;
    const adoptionRate = 100 - pct(nonAdopted.length, totalCats);

    const baseScore = adoptionRate === 100 ? 100 * W.BASE : netSterilizationRate * W.BASE;
    const qualityScore = (
      Math.max(0, 100 - growthRate) * W.GROWTH +
      adoptionRate * W.ADOPTION +
      survivalRate * W.SURVIVAL +
      registrationRate * W.REG
    ) * (1 - W.BASE);

    return {
      index: Math.min(Math.round(baseScore + qualityScore), 100),
      detail: {
        sterilization_rate: sterilizationRate.toFixed(1),
        net_sterilization_rate: netSterilizationRate.toFixed(1),
        growth_rate: growthRate.toFixed(1),
        adoption_rate: adoptionRate.toFixed(1),
        survival_rate: survivalRate.toFixed(1),
        registration_rate: registrationRate.toFixed(1),
        base_score: baseScore.toFixed(1),
        quality_score: qualityScore.toFixed(1),
      },
    };
  }

  function _relativeDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (isNaN(date.getTime())) return '';
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (mins < 60) return mins + '分钟前';
    if (hours < 24) return hours + '小时前';
    if (days < 7) return days + '天前';
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  // ---------- 链式查询（.where(...) 后面跟 .get()/.find()） ----------

  function _chain(name) {
    const ctx = { filter: null, sort: null, skip: 0, limit: null, fields: null };
    const api = {
      where(f) { ctx.filter = f; return api; },
      orderBy(field, dir) {
        ctx.sort = ctx.sort || {};
        ctx.sort[field] = dir === 'desc' || dir === -1 ? -1 : 1;
        return api;
      },
      skip(n) { ctx.skip = n; return api; },
      limit(n) { ctx.limit = n; return api; },
      field(f) { ctx.fields = f; return api; },
      async get() {
        const items = await _load(name);
        return {
          result: _applyQuery(items, ctx.filter, {
            sort: ctx.sort, skip: ctx.skip, limit: ctx.limit, fields: ctx.fields,
          }),
        };
      },
      async count() {
        const items = await _load(name);
        return { result: (ctx.filter ? items.filter(i => _matchFilter(i, ctx.filter)) : items).length };
      },
    };
    return api;
  }

  function _collection(name) {
    return {
      where(filter) { return _chain(name).where(filter); },

      async find(filter, opts) {
        const items = await _load(name);
        return { result: _applyQuery(items, filter, opts) };
      },

      async findOne(filter, opts) {
        const items = await _load(name);
        const merged = Object.assign({}, opts, { limit: 1 });
        const res = _applyQuery(items, filter, merged);
        return { result: res.length ? res[0] : null };
      },

      async count(filter) {
        const items = await _load(name);
        if (!filter || !Object.keys(filter).length) return { result: items.length };
        return { result: items.filter(item => _matchFilter(item, filter)).length };
      },

      insertOne(data) { return _insertOne(name, data); },
      updateOne(filter, data) { return _updateOne(name, filter, data); },
      deleteOne(filter) { return _deleteOne(name, filter); },

      async findOneAndUpdate(filter, data) {
        const res = await _updateOne(name, filter, data);
        if (!res.result.updated) return { result: null };
        const items = await _load(name);
        const target = items.filter(item => _matchFilter(item, filter))[0];
        return { result: target || null };
      },
    };
  }

  // ---------- openid ----------

  function _getOrCreateOpenid() {
    let openid = _safeGet(OPENID_STORAGE_KEY, '');
    if (!openid || typeof openid !== 'string') {
      openid = 'guest_' + _randomHex(8);
      _safeSet(OPENID_STORAGE_KEY, openid);
      console.log('[datasource] 生成访客 openid', openid);
    }
    return openid;
  }

  const db = {
    command: {
      eq: v => ({ $eq: v }),
      neq: v => ({ $ne: v }),
      in: arr => ({ $in: arr }),
      nin: arr => ({ $nin: arr }),
      gt: v => ({ $gt: v }),
      gte: v => ({ $gte: v }),
      lt: v => ({ $lt: v }),
      lte: v => ({ $lte: v }),
      exists: v => ({ $exists: !!v }),
    },
    collection(name) { return _collection(name); },
  };

  return {
    db,
    user: {
      async getInfo() {
        return { success: true, result: { user: { oAuthUserId: _getOrCreateOpenid() } } };
      },
    },
    function: {
      // 云函数已经没了。纯读的几个动作在本地重算，其余（写库以外还需要服务端能力的）
      // 返回 ok + null，页面拿到结果不会崩，同时留日志方便以后补。
      async invoke(name, params) {
        const action = (params && (params.unionAction || params.action)) || '(unknown)';

        if (name === 'userOp') {
          try {
            return { result: await _userOp(params) };
          } catch (e) {
            console.warn('[datasource] userOp 失败，返回 null', e && e.message);
            return { result: null };
          }
        }

        if (name === 'unionOp' && params) {
          try {
            if (action === 'curdOp') return { result: await _curdOp(params) };
            if (action === 'getCatLocations') return { result: await _getCatLocations() };
            if (action === 'getCatTrajectory') return { result: await _getCatTrajectory(params.cat_id) };
            if (action === 'getCatStats') return { result: await _getCatStats() };
            if (action === 'getAllSci') return { result: await _getAllSci() };
          } catch (e) {
            console.warn('[datasource] 本地模拟 ' + action + ' 失败，返回空结果', e && e.message);
            return { result: { ok: false, success: false, data: null } };
          }
        }

        console.log('[datasource] 忽略云函数调用 ' + name + ':' + action + '（静态数据源无法完成）', params);
        return { result: { ok: true, data: null } };
      },
    },
    file: {
      async uploadFile(opts) {
        console.warn(
          '[datasource] file.uploadFile 不可用（没有后端签发 COS 凭证），' +
          '请改用 wx.uploadFile 直传', opts && opts.cloudPath
        );
        return { fileUrl: '', fileId: '' };
      },
    },
    // cloudApi.catFace 会读 transport.timeoutOption / setTimeout，给个空实现免得报错
    transport: {
      timeoutOption: REQUEST_TIMEOUT,
      setTimeout(ms) { this.timeoutOption = ms; },
    },
    init() {},
  };
}

module.exports = {
  createJsonServerless,
  // 下面几个导出给本地自测脚本用，业务代码不需要
  _matchFilter,
  _applyQuery,
  _sortItems,
  CACHE_TTL,
  REQUEST_TIMEOUT,
};
