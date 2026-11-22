const CF_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
const MAX_CUSTOM_REGION_COUNT = 10;
const TEMPLATE_UUID = '00000000-0000-4000-8000-000000000000';
const TEMPLATE_HOST = 'example.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 首頁 (/)：節點訂閱拼接生成器（無需密碼，打開即用）
    if (path === '/') {
      const rawData = (await env.KV.get('raw_iplist', { cacheTtl: 60 })) || '';
      const parsed = parseRawIPList(rawData, '');
      const regions = Object.keys(parsed.regionIps);
      return new Response(renderGeneratorHTML(regions), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 2. 後台管理介面 (/admin)
    if (path === '/admin') {
      return new Response(renderAdminHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 3. 後台 API：驗證密碼並讀取 env.KV 原始資料
    if (path === '/api/load' && request.method === 'POST') {
      const { password } = await request.json().catch(() => ({}));
      if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: '密碼錯誤或未設定環境變數 ADMIN_PASSWORD' }, 401);
      }
      const rawData = (await env.KV.get('raw_iplist')) || '';
      return jsonResponse({ data: rawData });
    }

    // 4. 後台 API：驗證密碼並寫入 env.KV
    if (path === '/api/save' && request.method === 'POST') {
      const { password, data } = await request.json().catch(() => ({}));
      if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: '密碼錯誤，拒絕寫入' }, 401);
      }
      await env.KV.put('raw_iplist', data || '');
      return jsonResponse({ success: true });
    }

    // 5. 原明文列表接口 (/all 與 /all_list.txt)：僅當 SHOW_LIST === '1' 時開放檢視
    if (path === '/all' || path === '/all_list.txt') {
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

    // 6. 自訂地區節點拼接訂閱接口 (/custom_sub)
    // 每次客戶端更新訂閱時即時洗牌抽樣，若原鏈接有 port 則套用隨機 CF 6 端口之一
    if (path === '/custom_sub') {
      const rawData = await env.KV.get('raw_iplist', { cacheTtl: 60 });
      if (!rawData) {
        return new Response(encodeBase64UTF8(''), {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      }

      const tplParam = url.searchParams.get('tpl') || '';
      const templateLink = decodeURIComponentSafe(tplParam).trim();
      const selectedRegions = (url.searchParams.get('regions') || '')
        .split(',')
        .map((s) => decodeURIComponentSafe(s).trim())
        .filter(Boolean);

      const rawCount = parseInt(url.searchParams.get('count') || env.CUSTOM_REGION_COUNT || '5', 10);
      const perCount = clampCustomCount(rawCount);
      const tplHasPort = templateHasPort(templateLink);

      if (!templateLink || selectedRegions.length === 0) {
        return new Response('Missing tpl or regions', { status: 400 });
      }

      const items = generateCustomRegionItems(rawData, selectedRegions, perCount);
      const links = items
        .map((item) => {
          const addrWithPort = tplHasPort ? assignRandomCFPort(item.address) : item.address;
          return buildNodeFromTemplate(templateLink, addrWithPort, item.remark);
        })
        .filter(Boolean);

      return new Response(encodeBase64UTF8(links.join('\n')), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    // 7. 外部 sub:// 優選訂閱生成器接口 (/sub)
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

function clampCustomCount(val) {
  if (!Number.isFinite(val) || val < 1) return 5;
  return Math.min(MAX_CUSTOM_REGION_COUNT, Math.max(1, Math.floor(val)));
}

/**
 * 檢查輸入的原始節點鏈接是否包含端口
 */
function templateHasPort(templateStr) {
  const raw = String(templateStr || '').trim();
  if (!raw) return false;
  const hashIdx = raw.indexOf('#');
  const withoutHash = hashIdx > -1 ? raw.slice(0, hashIdx) : raw;
  const match = withoutHash.match(/^[a-z][a-z0-9+\-.]*:\/\/(?:[^@/?#]+@)?([^/?#]+)/i);
  if (!match) return false;

  const hostPort = match[1].trim();
  if (hostPort.startsWith('[')) {
    return /\]:\d+$/.test(hostPort);
  }
  const colonIdx = hostPort.lastIndexOf(':');
  return colonIdx > -1 && /^\d+$/.test(hostPort.slice(colonIdx + 1));
}

/**
 * 將地址的端口替換或附加為 CF 6 端口中的隨機一種
 */
function assignRandomCFPort(address) {
  const addr = String(address || '').trim();
  if (!addr) return addr;

  const port = CF_PORTS[Math.floor(Math.random() * CF_PORTS.length)];
  const bareAddr = stripExistingPort(addr);
  const unbracketedIPv6 = !bareAddr.startsWith('[') && (bareAddr.match(/:/g) || []).length >= 2;
  const host = unbracketedIPv6 ? `[${bareAddr}]` : bareAddr;

  return `${host}:${port}`;
}

function stripExistingPort(addr) {
  if (addr.startsWith('[')) {
    const m = addr.match(/^(\[[^\]]+\])(?::\d+)?$/);
    return m ? m[1] : addr;
  }
  const colonIdx = addr.lastIndexOf(':');
  if (colonIdx > -1 && /^\d+$/.test(addr.slice(colonIdx + 1))) {
    return addr.slice(0, colonIdx);
  }
  return addr;
}

/**
 * 解析 KV 原始資料結構
 */
function parseRawIPList(rawText, headerNote = '') {
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

    if (!addrPart.includes('.') && !addrPart.includes(':') && hashIdx === -1) {
      currentRegion = addrPart;
      if (!regionIps[currentRegion]) {
        regionIps[currentRegion] = [];
      }
      continue;
    }

    if (!addrPart) continue;

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

  return { standaloneItems, regionIps, ipRegionsMap, ipCustomRemarkMap };
}

/**
 * 全區抽樣（供 /all 與 /sub 使用）
 */
function generateSelectedItems(rawText, env) {
  const perRegionCount = Math.max(1, parseInt(env.PER_REGION_COUNT || '5', 10) || 5);
  const headerNote = (env.HEADER_NOTE || '').trim();
  const randomCfPort = ['1', 'true'].includes(String(env.RANDOM_CF_PORT || '').toLowerCase());

  const { standaloneItems, regionIps, ipRegionsMap, ipCustomRemarkMap } = parseRawIPList(rawText, headerNote);

  const selectedList = [];
  const seenAddresses = new Set();

  for (const item of standaloneItems) {
    if (!seenAddresses.has(item.address)) {
      seenAddresses.add(item.address);
      selectedList.push({
        address: applyPortRule(item.address, randomCfPort),
        remark: item.remark,
      });
    }
  }

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
 * 依指定地區與每區數量抽樣（供 /custom_sub 使用），備註為所屬地區名稱（多區合併以 - 連接）
 */
function generateCustomRegionItems(rawText, targetRegions, perCount) {
  const { regionIps, ipRegionsMap } = parseRawIPList(rawText, '');
  const selectedList = [];
  const seenAddresses = new Set();

  for (const region of targetRegions) {
    const pool = regionIps[region];
    if (!pool || !pool.length) continue;

    const shuffled = shuffleArray([...pool]);
    let picked = 0;

    for (const addr of shuffled) {
      if (picked >= perCount) break;
      if (!seenAddresses.has(addr)) {
        seenAddresses.add(addr);
        const matchedInSelected = (ipRegionsMap[addr] || []).filter((r) => targetRegions.includes(r));
        const regionRemark = (matchedInSelected.length ? matchedInSelected : [region]).join('-');

        selectedList.push({
          address: addr,
          remark: regionRemark,
        });
        picked++;
      }
    }
  }

  return selectedList;
}

/**
 * 將輸入節點鏈接中的主機/端口替換為新地址，並將 # 後備註替換為地區名稱
 */
function buildNodeFromTemplate(templateStr, newAddress, regionRemark) {
  const raw = templateStr.trim();
  if (!raw || !newAddress) return '';

  const hashIdx = raw.indexOf('#');
  const withoutHash = hashIdx > -1 ? raw.slice(0, hashIdx) : raw;

  const match = withoutHash.match(/^([a-z][a-z0-9+\-.]*:\/\/)(?:([^@/?#]+)@)?([^/?#]+)(.*)$/i);
  if (!match) return '';

  const [, scheme, userInfo, , rest] = match;
  const authPrefix = userInfo ? `${userInfo}@` : '';
  const encodedRemark = encodeURIComponent(regionRemark);

  return `${scheme}${authPrefix}${newAddress}${rest}#${encodedRemark}`;
}

/**
 * 埠號處理規則（供 /all 與 /sub 使用）
 */
function applyPortRule(address, randomCfPort) {
  const addr = address.trim();
  if (!addr) return addr;

  if (addr.startsWith('[')) {
    if (/\]:\d+$/.test(addr)) return addr;
  } else {
    const colonIdx = addr.lastIndexOf(':');
    if (colonIdx > -1 && /^\d+$/.test(addr.slice(colonIdx + 1))) {
      return addr;
    }
  }

  if (!randomCfPort) return addr;

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

function formatPlainItem(item) {
  return item.remark ? `${item.address}#${item.remark}` : item.address;
}

function formatSubTemplateLink(item) {
  if (!item?.address) return '';
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(item.address)) {
    return item.address;
  }
  const remark = encodeURIComponent(item.remark || item.address);
  return `vless://${TEMPLATE_UUID}@${item.address}?security=tls&type=ws&host=${TEMPLATE_HOST}&sni=${TEMPLATE_HOST}&path=%2F#${remark}`;
}

function decodeURIComponentSafe(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function encodeBase64UTF8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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

// 首頁：節點訂閱拼接生成器
function renderGeneratorHTML(regions) {
  const safeRegions = regions.map((r) => escapeHTML(r));
  const checkboxesHTML = safeRegions.length
    ? safeRegions
        .map(
          (r) =>
            `<label class="chk"><input type="checkbox" name="region" value="${r}" /><span>${r}</span></label>`
        )
        .join('')
    : `<div class="empty">目前 KV 中尚無地區資料，請先至 /admin 維護 raw_iplist</div>`;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>地區節點訂閱生成器</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a; color: #f8fafc;
      display: flex; justify-content: center; padding: 24px 16px;
    }
    .box {
      width: 100%; max-width: 780px; background: #1e293b;
      border: 1px solid #334155; border-radius: 12px; padding: 22px;
    }
    h2 { font-size: 1.2rem; margin-bottom: 16px; }
    label.field-title { display: block; font-size: 14px; color: #cbd5e1; margin-bottom: 8px; }
    textarea.tpl-input {
      width: 100%; height: 110px; background: #020617; color: #38bdf8;
      border: 1px solid #334155; border-radius: 8px; padding: 10px 12px;
      font-family: ui-monospace, monospace; font-size: 12.5px; line-height: 1.45;
      resize: vertical; outline: none; margin-bottom: 16px;
    }
    textarea.tpl-input:focus { border-color: #38bdf8; }
    .regions-wrap {
      display: flex; flex-wrap: wrap; gap: 10px;
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      padding: 12px; margin-bottom: 16px;
    }
    .chk {
      display: inline-flex; align-items: center; gap: 6px;
      background: #1e293b; border: 1px solid #334155; border-radius: 6px;
      padding: 6px 10px; cursor: pointer; font-size: 13.5px; user-select: none;
    }
    .chk input { accent-color: #38bdf8; cursor: pointer; }
    .empty { font-size: 13px; color: #94a3b8; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
    .count-box { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #cbd5e1; }
    input[type="number"] {
      width: 90px; height: 40px; padding: 0 10px;
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      color: #fff; font-size: 14px; outline: none;
    }
    button.btn-gen {
      height: 40px; padding: 0 20px; border: none; border-radius: 8px;
      background: #38bdf8; color: #020617; font-weight: 700; font-size: 14px;
      cursor: pointer;
    }
    button.btn-gen:hover { background: #0284c7; color: #fff; }
    .sub-out {
      display: none; width: 100%; background: #020617; color: #4ade80;
      border: 1px dashed #38bdf8; border-radius: 8px; padding: 12px 14px;
      font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all;
      cursor: pointer; line-height: 1.5;
    }
    .tip { margin-top: 8px; font-size: 13px; color: #94a3b8; min-height: 20px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>節點訂閱連結生成器</h2>

    <label class="field-title" for="tpl">原始節點鏈接</label>
    <textarea id="tpl" class="tpl-input" placeholder="貼上 vless://... 節點鏈接"></textarea>

    <label class="field-title">選擇地區</label>
    <div class="regions-wrap" id="regions">${checkboxesHTML}</div>

    <div class="row">
      <div class="count-box">
        <label for="count">各地區抽取數量（最多 10）：</label>
        <input type="number" id="count" min="1" max="10" value="5" />
      </div>
      <button class="btn-gen" onclick="generateSubURL()">生成訂閱</button>
    </div>

    <div id="subResult" class="sub-out" onclick="copySubURL()" title="點擊複製訂閱連結"></div>
    <div id="tip" class="tip"></div>
  </div>

  <script>
    function generateSubURL() {
      const tpl = document.getElementById('tpl').value.trim();
      const rawCount = parseInt(document.getElementById('count').value || '5', 10);
      const count = Number.isFinite(rawCount) ? Math.min(10, Math.max(1, rawCount)) : 5;
      document.getElementById('count').value = String(count);

      const checked = Array.from(document.querySelectorAll('input[name="region"]:checked')).map((el) => el.value);
      const outEl = document.getElementById('subResult');
      const tipEl = document.getElementById('tip');

      if (!tpl) {
        outEl.style.display = 'none';
        tipEl.style.color = '#f87171';
        tipEl.textContent = '請先輸入原始節點鏈接';
        return;
      }
      if (!checked.length) {
        outEl.style.display = 'none';
        tipEl.style.color = '#f87171';
        tipEl.textContent = '請至少勾選一個地區';
        return;
      }

      const u = new URL(window.location.origin + '/custom_sub');
      u.searchParams.set('regions', checked.join(','));
      u.searchParams.set('count', String(count));
      u.searchParams.set('tpl', tpl);

      outEl.textContent = u.toString();
      outEl.style.display = 'block';
      tipEl.style.color = '#94a3b8';
      tipEl.textContent = '點擊上方訂閱連結即可複製';
    }

    async function copySubURL() {
      const outEl = document.getElementById('subResult');
      const tipEl = document.getElementById('tip');
      const text = outEl.textContent.trim();
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        tipEl.style.color = '#4ade80';
        tipEl.textContent = '已複製訂閱連結到剪貼簿';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(outEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        tipEl.style.color = '#4ade80';
        tipEl.textContent = '已複製訂閱連結到剪貼簿';
      }
    }
  </script>
</body>
</html>`;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
