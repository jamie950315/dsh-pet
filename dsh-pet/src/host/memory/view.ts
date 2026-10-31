/**
 * 記憶瀏覽器的靜態 HTML：由宿主半側寫成檔案、以 text/html 提供。
 *
 * 頁面用相對路徑推導路由前綴，因此不需要知道 DSH 的連接埠。
 * @module dsh-pet/src/host/memory/view
 */
export const MEMORY_VIEW_HTML = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>哦鯨鯨的記憶</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", sans-serif; background:#0b1736; color:#e8f3ff; }
  header { padding:18px 22px 12px; border-bottom:1px solid rgba(255,255,255,.08); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; letter-spacing:.02em; }
  .sub { font-size:11px; color:rgba(232,243,255,.5); }
  .grow { flex:1; }
  select, input, button { font:inherit; color:inherit; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); border-radius:9px; padding:7px 10px; }
  button { cursor:pointer; }
  button:hover { background:rgba(111,214,255,.18); }
  main { padding:18px 22px 40px; max-width:1080px; margin:0 auto; }
  .chips { display:flex; flex-wrap:wrap; gap:7px; margin:8px 0 18px; }
  .chip { font-size:11px; padding:5px 9px; border-radius:999px; background:rgba(111,214,255,.12); border:1px solid rgba(111,214,255,.2); }
  .chip b { color:#6fd6ff; font-weight:600; margin-right:5px; }
  .card { background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.07); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
  .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .badge { font-size:10px; font-weight:700; padding:3px 7px; border-radius:999px; background:rgba(111,214,255,.12); color:#6fd6ff; }
  .stars { color:#f4c86a; font-size:11px; }
  .muted { color:rgba(232,243,255,.45); font-size:11px; }
  .content { margin:8px 0 6px; line-height:1.55; font-size:13px; white-space:pre-wrap; }
  .kw { color:rgba(111,214,255,.7); font-size:11px; }
  .empty { color:rgba(232,243,255,.4); text-align:center; padding:60px 0; }
  .actions { display:flex; gap:6px; }
  .actions button { padding:4px 8px; font-size:11px; }
  .danger { color:#e05a6b; }
  .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:rgba(11,23,54,.96); border:1px solid rgba(111,214,255,.3); padding:9px 14px; border-radius:10px; font-size:12px; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.on { opacity:1; }
</style>
</head>
<body>
<header>
  <div>
    <h1>哦鯨鯨的記憶</h1>
    <div class="sub">長期記憶、使用者檔案與對話摘要</div>
  </div>
  <div class="grow"></div>
  <select id="pet"></select>
  <span id="stats" class="sub"></span>
  <button id="feed">餵白飯</button>
  <button id="pat">摸摸頭</button>
  <input id="q" placeholder="搜尋記憶…" style="width:170px">
  <button id="consolidate">重整</button>
  <button id="export">匯出</button>
  <button id="clear" class="danger">清空</button>
</header>
<main>
  <div id="profile" class="chips"></div>
  <div id="list"></div>
</main>
<div id="toast" class="toast"></div>
<script>
(function () {
  var BASE = location.pathname.replace(/\/memory\/view$/, '');
  var petId = '';
  function api(path, opts) { return fetch(BASE + path, opts).then(function (r) { return r.json(); }); }
  function toast(text) {
    var el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('on');
    setTimeout(function () { el.classList.remove('on'); }, 1800);
  }
  function esc(text) { return String(text).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function stars(importance) {
    var n = Math.max(1, Math.min(3, Math.ceil(Number(importance || 0) * 3)));
    return '★★★'.slice(0, n);
  }
  function kindLabel(kind) {
    return { fact: '事實', preference: '偏好', episode: '經歷', relationship: '關係', reflection: '想法' }[kind] || kind;
  }
  function profileLabel(key) {
    return { name: '名字', birthday: '生日', occupation: '工作', timezone: '時區', likes: '喜歡', dislikes: '不喜歡', projects: '專案', goals: '目標', communication_style: '溝通偏好' }[key] || key;
  }
  function render(data) {
    var chips = document.getElementById('profile');
    var keys = Object.keys(data.profile || {});
    chips.innerHTML = keys.length
      ? keys.map(function (k) { return '<span class="chip"><b>' + esc(profileLabel(k)) + '</b>' + esc(data.profile[k].value) + '</span>'; }).join('')
      : '<span class="muted">還沒有使用者檔案。</span>';
    var list = document.getElementById('list');
    var memories = data.memories || [];
    if (!memories.length) {
      list.innerHTML = '<div class="empty">還沒有長期記憶。跟哦鯨鯨多聊幾句吧。</div>';
      return;
    }
    list.innerHTML = memories.map(function (m) {
      var keywords = (m.keywords || []).map(function (k) { return '#' + esc(k); }).join(' ');
      var date = new Date(m.updatedAt || m.createdAt).toLocaleDateString('zh-TW');
      return '<div class="card">' +
        '<div class="row"><span class="badge">' + esc(kindLabel(m.kind)) + '</span>' +
        '<span class="stars">' + stars(m.importance) + '</span>' +
        (m.pinned ? '<span class="badge">釘選</span>' : '') +
        '<span class="grow"></span><span class="muted">' + date + '</span>' +
        '<span class="actions"><button data-pin="' + esc(m.id) + '">' + (m.pinned ? '取消釘選' : '釘選') + '</button>' +
        '<button data-del="' + esc(m.id) + '" class="danger">刪除</button></span></div>' +
        '<div class="content">' + esc(m.content) + '</div>' +
        (keywords ? '<div class="kw">' + keywords + '</div>' : '') +
        '<div class="muted">存取 ' + (m.accessCount || 0) + ' 次</div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-pin]'), function (btn) {
      btn.onclick = function () { patch(btn.getAttribute('data-pin'), { pinned: true }); };
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-del]'), function (btn) {
      btn.onclick = function () { remove(btn.getAttribute('data-del')); };
    });
  }
  function loadStats() {
    if (!petId) return;
    api('/stats?pet=' + encodeURIComponent(petId)).then(function (data) {
      if (!data || data.ok === false) return;
      var el = document.getElementById('stats');
      el.textContent = '親密度 ' + Math.round(data.stats.affinity) + '（' + data.affinityLabel + '）· 飽足 ' + Math.round(data.stats.hunger) + '（' + data.hungerLabel + '）';
    });
  }
  function load() {
    if (!petId) return;
    var q = document.getElementById('q').value.trim();
    var path = '/memory?pet=' + encodeURIComponent(petId) + (q ? '&q=' + encodeURIComponent(q) : '');
    api(path).then(function (data) {
      if (data && data.ok === false) { toast(data.message || '讀取失敗'); return; }
      render(data);
    });
  }
  function patch(id, body) {
    api('/memory?pet=' + encodeURIComponent(petId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ id: id }, body)),
    }).then(function () { toast('已更新'); load(); });
  }
  function remove(id) {
    api('/memory?pet=' + encodeURIComponent(petId) + '&id=' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () { toast('已刪除'); load(); });
  }
  function boot() {
    api('/state').then(function (state) {
      var pets = state && state.pets ? Object.keys(state.pets) : [];
      var select = document.getElementById('pet');
      if (!pets.length) { document.getElementById('list').innerHTML = '<div class="empty">目前沒有桌寵。</div>'; return; }
      petId = pets[0];
      select.innerHTML = pets.map(function (id) { return '<option value="' + esc(id) + '">' + esc(id) + '</option>'; }).join('');
      select.value = petId;
      select.onchange = function () { petId = select.value; load(); loadStats(); };
      load();
      loadStats();
    });
  }
  document.getElementById('q').oninput = load;
  document.getElementById('feed').onclick = function () {
    api('/feed?pet=' + encodeURIComponent(petId), { method: 'POST' }).then(function (r) { toast(r && r.line ? r.line : '餵食完成'); loadStats(); });
  };
  document.getElementById('pat').onclick = function () {
    api('/pat?pet=' + encodeURIComponent(petId), { method: 'POST' }).then(function (r) { toast(r && r.line ? r.line : '摸摸完成'); loadStats(); });
  };
  document.getElementById('consolidate').onclick = function () {
    api('/memory/consolidate?pet=' + encodeURIComponent(petId), { method: 'POST' })
      .then(function (r) { toast(r && r.merged ? ('合併 ' + r.merged + ' 條') : '已重整'); load(); });
  };
  document.getElementById('export').onclick = function () {
    window.open(BASE + '/memory/export?pet=' + encodeURIComponent(petId), '_blank');
  };
  document.getElementById('clear').onclick = function () {
    if (!confirm('清空這隻寵物的全部長期記憶？')) return;
    api('/memory?pet=' + encodeURIComponent(petId) + '&all=1', { method: 'DELETE' })
      .then(function () { toast('已清空'); load(); });
  };
  boot();
})();
</script>
</body>
</html>
`;
