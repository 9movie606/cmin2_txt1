const CF_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
const TEMPLATE_UUID = '00000000-0000-4000-8000-000000000000';
const TEMPLATE_HOST = 'example.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 後台管理介面 (/admin)
    if (path === '/admin') {
      return new Response(renderAdminHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 2. 後台 API：驗證密碼並讀取 env.KV 原始資料（不設快取，確保編輯時讀取最新資料）
    if (path === '/api/load' && request.method === 'POST') {
      const { password } = await request.json().catch(() => ({}));
      if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: '密碼錯誤或未設定環境變數 ADMIN_PASSWORD' }, 401);
      }
      const rawData = (await env.KV.get('raw_iplist')) || '';
      return jsonResponse({ data: rawData });
    }

    // 3. 後台 API：驗證密碼並寫入 env.KV
    if (path === '/api/save' && request.method === 'POST') {
      const { password, data } = await request.json().catch(() => ({}));
      if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: '密碼錯誤，拒絕寫入' }, 401);
      }
      await env.KV.put('raw_iplist', data || '');
      return jsonResponse({ success: true });
    }

    // 4. 明文列表接口 (/ 或 /all_list.txt)：僅當 SHOW_LIST === '1' 時開放檢視
    if (path === '/' || path === '/all_list.txt') {
      if (String(env.SHOW_LIST ?? '0') !== '1') {
        return new Response('Not Found', { status: 404 });
      }

      const rawData = await env.KV.get('raw_iplist', { cacheTtl: 3600 });
      if (!rawData) {
        return new Response('# 資料庫為空，請先前往 /admin 寫入 IP 列表\n', {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      }

      const items = generateSelectedItems(rawData, env);
      const plainText = items.map(formatPlainItem).join('\n') + (items.length ? '\n' : '');

      return new Response(plainText, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    // 5. 外部 sub:// 優選訂閱生成器接口 (/sub)
    // 預設無條件接受外部 sub:// 請求（相容 sub://域名 與 sub://域名/sub）
    if (path === '/sub') {
      const rawData = await env.KV.get('raw_iplist', { cacheTtl: 3600 });
      if (!rawData) {
        return new Response(encodeBase64UTF8(''), {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      }

      const items = generateSelectedItems(rawData, env);
      const nodeLinks = items.map(formatSubTemplateLink).filter(Boolean);
      const encodedSub = encodeBase64UTF8(nodeLinks.join('\n'));

      return new Response(encodedSub, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * 解析 KV 原始列表並執行：
 * 1. 識別頂部或獨立的「地址#備註」（含 HEADER_NOTE）
 * 2. 按地區分組、Fisher-Yates 隨機抽樣、全局去重與多地區合併備註
 * 3. 依 RANDOM_CF_PORT 為純 IP 隨機附加 Cloudflare 6 個常用端口（已有端口則保留）
 */
function generateSelectedItems(rawText, env) {
  const perRegionCount = Math.max(1, parseInt(env.PER_REGION_COUNT || '5', 10) || 5);
  const headerNote = (env.HEADER_NOTE || '').trim();
  const randomCfPort = ['1', 'true'].includes(String(env.RANDOM_CF_PORT || '').toLowerCase());

  const combinedText = headerNote ? `${headerNote}\n${rawText}` : rawText;
  const lines = combinedText.split(/\r?\n/);

  let currentRegion = null;
  const standaloneItems = [];
  const regionIps = {};
  const ipRegionsMap = {};
  const ipCustomRemarkMap = {};

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;

    const hashIdx = line.indexOf('#');
    const addrPart = hashIdx > -1 ? line.slice(0, hashIdx).trim() : line;
    const inlineRemark = hashIdx > -1 ? line.slice(hashIdx + 1).trim() : '';

    // 不含點與冒號且無 # 備註的行，視為地區標頭
    if (!addrPart.includes('.') && !addrPart.includes(':') && hashIdx === -1) {
      currentRegion = addrPart;
      if (!regionIps[currentRegion]) {
        regionIps[currentRegion] = [];
      }
      continue;
    }

    if (!addrPart) continue;

    // 尚未進入任何地區區塊前的地址（如 HEADER_NOTE 中的 cmin2.cc.cd#移動專用...）
    if (!currentRegion) {
      standaloneItems.push({
        address: addrPart,
        remark: inlineRemark || addrPart,
      });
      continue;
    }

    if (!regionIps[currentRegion].includes(addrPart)) {
      regionIps[currentRegion].push(addrPart);
    }
    if (!ipRegionsMap[addrPart]) {
      ipRegionsMap[addrPart] = [];
    }
    if (!ipRegionsMap[addrPart].includes(currentRegion)) {
      ipRegionsMap[addrPart].push(currentRegion);
    }
    if (inlineRemark && !ipCustomRemarkMap[addrPart]) {
      ipCustomRemarkMap[addrPart] = inlineRemark;
    }
  }

  const selectedList = [];
  const seenAddresses = new Set();

  // 先加入獨立頂部項目（例如 HEADER_NOTE）
  for (const item of standaloneItems) {
    if (!seenAddresses.has(item.address)) {
      seenAddresses.add(item.address);
      selectedList.push({
        address: applyPortRule(item.address, randomCfPort),
        remark: item.remark,
      });
    }
  }

  // 遍歷每個地區，隨機洗牌後抽取最多 perRegionCount 個不重複地址
  for (const region of Object.keys(regionIps)) {
    const shuffled = shuffleArray([...regionIps[region]]);
    let picked = 0;

    for (const addr of shuffled) {
      if (picked >= perRegionCount) break;
      if (!seenAddresses.has(addr)) {
        seenAddresses.add(addr);
        const regionsTag = ipRegionsMap[addr].join('-');
        const customTag = ipCustomRemarkMap[addr];
        const finalRemark = customTag ? `${regionsTag} ${customTag}` : regionsTag;

        selectedList.push({
          address: applyPortRule(addr, randomCfPort),
          remark: finalRemark,
        });
        picked++;
      }
    }
  }

  return selectedList;
}

/**
 * 埠號處理規則：
 * - 已有端口（ip:port 或 [ipv6]:port）-> 原樣保留
 * - 純 IPv4 / 純 IPv6 -> 若啟用 randomCfPort，隨機加 CF 6 端口之一；否則保持純 IP
 * - 域名（無端口）-> 保持原樣不補端口
 */
function applyPortRule(address, randomCfPort) {
  const addr = address.trim();
  if (!addr) return addr;

  // 檢查是否已包含端口
  if (addr.startsWith('[')) {
    if (/\]:\d+$/.test(addr)) return addr;
  } else {
    const colonIdx = addr.lastIndexOf(':');
    if (colonIdx > -1 && /^\d+$/.test(addr.slice(colonIdx + 1))) {
      return addr;
    }
  }

  if (!randomCfPort) return addr;

  // 判斷是否為純 IPv4 或純 IPv6（不含端口）
  const pureIPv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(addr);
  const bareIPv6 = addr.startsWith('[') && addr.endsWith(']') && addr.includes(':');
  const unbracketedIPv6 = !addr.startsWith('[') && (addr.match(/:/g) || []).length >= 2;

  if (pureIPv4 || bareIPv6 || unbracketedIPv6) {
    const port = CF_PORTS[Math.floor(Math.random() * CF_PORTS.length)];
    const host = unbracketedIPv6 ? `[${addr}]` : addr;
    return `${host}:${port}`;
  }

  return addr;
}

/**
 * 明文格式輸出：地址#備註
 */
function formatPlainItem(item) {
  return item.remark ? `${item.address}#${item.remark}` : item.address;
}

/**
 * 轉為上游 sub:// 聚合器可識別的佔位模板連結
 * 若外部項目解析 /:\/\/[^@]+@([^?]+)/，無端口時仍可正常提取純 IP / 域名
 */
function formatSubTemplateLink(item) {
  if (!item?.address) return '';
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(item.address)) {
    return item.address;
  }
  const remark = encodeURIComponent(item.remark || item.address);
  return `vless://${TEMPLATE_UUID}@${item.address}?security=tls&type=ws&host=${TEMPLATE_HOST}&sni=${TEMPLATE_HOST}&path=%2F#${remark}`;
}

/**
 * 支援 UTF-8 字元（中文備註）的 Base64 編碼
 */
function encodeBase64UTF8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Fisher-Yates 真隨機洗牌演算法
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 後台管理網頁 HTML
function renderAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IP 列表 KV 管理後台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a; color: #f8fafc;
      display: flex; justify-content: center; padding: 20px;
    }
    .box {
      width: 100%; max-width: 760px; background: #1e293b;
      border: 1px solid #334155; border-radius: 12px; padding: 20px;
    }
    h2 { font-size: 1.15rem; margin-bottom: 16px; }
    .row { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
    input[type="password"] {
      flex: 1; min-width: 200px; height: 42px; padding: 0 12px;
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      color: #fff; font-size: 15px; outline: none;
    }
    input[type="password"]:focus { border-color: #38bdf8; }
    button {
      height: 42px; padding: 0 18px; border: none; border-radius: 8px;
      font-weight: 600; font-size: 14px; cursor: pointer;
    }
    .btn-load { background: #334155; color: #f8fafc; }
    .btn-load:hover { background: #475569; }
    .btn-save { background: #38bdf8; color: #000; }
    .btn-save:hover { background: #0284c7; color: #fff; }
    textarea {
      width: 100%; height: 460px; background: #020617; color: #4ade80;
      border: 1px solid #334155; border-radius: 8px; padding: 12px;
      font-family: ui-monospace, monospace; font-size: 13px; line-height: 1.5;
      resize: vertical; outline: none;
    }
    .status { margin-top: 10px; font-size: 14px; color: #94a3b8; min-height: 20px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>CMIN2 原始 IP 列表編輯器 (KV)</h2>
    <div class="row">
      <input type="password" id="pwd" placeholder="請輸入管理密碼 (ADMIN_PASSWORD)" />
      <button class="btn-load" onclick="loadData()">讀取列表</button>
      <button class="btn-save" onclick="saveData()">保存寫入 KV</button>
    </div>
    <textarea id="editor" placeholder="點擊「讀取列表」載入現有資料，或直接貼上各地區 IP 列表後點擊保存..."></textarea>
    <div class="status" id="status"></div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const editorEl = document.getElementById('editor');
    const pwdEl = document.getElementById('pwd');

    async function loadData() {
      const password = pwdEl.value;
      if (!password) return showStatus('請先輸入管理密碼', '#f87171');
      showStatus('讀取中...', '#38bdf8');
      try {
        const res = await fetch('/api/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const json = await res.json();
        if (!res.ok) return showStatus(json.error || '讀取失敗', '#f87171');
        editorEl.value = json.data;
        showStatus('讀取成功！共 ' + json.data.split('\\n').length + ' 行', '#4ade80');
      } catch (e) {
        showStatus('網路請求錯誤', '#f87171');
      }
    }

    async function saveData() {
      const password = pwdEl.value;
      if (!password) return showStatus('請先輸入管理密碼', '#f87171');
      showStatus('正在寫入 KV...', '#38bdf8');
      try {
        const res = await fetch('/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, data: editorEl.value })
        });
        const json = await res.json();
        if (!res.ok) return showStatus(json.error || '保存失敗', '#f87171');
        showStatus('保存成功！（主訂閱因設有1小時快取，最遲1小時內全網同步生效）', '#4ade80');
      } catch (e) {
        showStatus('網路請求錯誤', '#f87171');
      }
    }

    function showStatus(msg, color) {
      statusEl.textContent = msg;
      statusEl.style.color = color;
    }
  </script>
</body>
</html>`;
}
