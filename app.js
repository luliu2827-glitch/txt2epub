/* app.js —— TXT→EPUB 前端交互（依赖 EpubCore 与 JSZip 全局） */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  const state = {
    text: '',
    entries: [],
    meta: { title: '', author: '' },
    cover: null
  };

  /* ----------------------------- 设置记忆 ----------------------------- */

  const SETTINGS_KEY = 'txt2epub.settings.v1';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s.encoding === 'string') $('encoding').value = s.encoding;
      if (s && typeof s.separators === 'boolean') $('separators').checked = s.separators;
      if (s && typeof s.numbered === 'boolean') $('numbered').checked = s.numbered;
    } catch (e) { /* 存储损坏则忽略，用默认值 */ }
  }

  function saveSettings() {
    try {
      const s = {
        encoding: $('encoding').value,
        separators: $('separators').checked,
        numbered: $('numbered').checked
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) { /* 隐私模式等场景 storage 不可用，静默跳过 */ }
  }

  /* ----------------------------- 读取与编码 ----------------------------- */

  // 编码友好名（用于显示识别结果）
  const ENC_LABEL = {
    'utf-8': 'UTF-8',
    'gb18030': 'GB18030 / GBK',
    'utf-16': 'UTF-16（含 BOM）',
    'utf-16le': 'UTF-16',
    'shift_jis': 'Shift_JIS'
  };
  // 把解码结果映射到下拉框已有的 option 值
  function normalizeEnc(enc) {
    if (enc === 'utf-16le') return 'utf-16';
    return enc;
  }

  async function loadFile(file) {
    const buf = await file.arrayBuffer();
    const sel = $('encoding').value;
    const res = EpubCore.decodeBuffer(buf, sel);
    state.text = res.text;
    // 自动模式下把识别到的编码显示出来并同步下拉框，用户一眼可知、也可手动改
    if (sel === 'auto') {
      $('encoding').value = normalizeEnc(res.encoding);
      $('detectedEncoding').textContent = '识别编码：' + (ENC_LABEL[res.encoding] || res.encoding);
    }
    $('title').value = (file.name || 'book').replace(/\.txt$/i, '');
    clearCoverState(); // 换了源文本，旧封面不再匹配
    runDetect();
  }

  function loadPaste() {
    const v = $('paste').value;
    if (!v.trim()) { setStatus('粘贴内容为空', false); return; }
    state.text = v;
    $('detectedEncoding').textContent = '粘贴文本（已是 Unicode）';
    clearCoverState();
    runDetect();
  }

  /* ----------------------------- 检测与渲染 ----------------------------- */

  function runDetect() {
    if (!state.text) { setStatus('请先导入文本', false); return; }
    state.entries = EpubCore.detect(state.text, {
      useSeparators: $('separators').checked,
      useNumbered: $('numbered').checked
    });
    renderToc();
    renderPreview();
    $('generate').disabled = false;
    const n = state.entries.length;
    const bits = [];
    bits.push('第X章 / Chapter / Markdown（默认开启）');
    bits.push('分隔线模式：' + ($('separators').checked ? '开' : '关'));
    bits.push('数字编号：' + ($('numbered').checked ? '开' : '关'));
    $('detectInfo').textContent = n
      ? '检测到 ' + n + ' 个候选标题。识别规则：' + bits.join('；') + '。'
      : '未检测到明显标题，将按单章节处理（整本为一个章节）。';
    setStatus('', true);
  }

  function renderToc() {
    const box = $('tocList');
    if (!state.entries.length) {
      box.innerHTML = '<p class="empty">未检测到标题，将生成单章节 EPUB。</p>';
      return;
    }
    let html = '';
    state.entries.forEach(function (e) {
      const indent = Math.max(0, e.level - 1) * 22;
      html +=
        '<div class="toc-item" style="margin-left:' + indent + 'px" data-id="' + e.id + '">' +
        '<input type="checkbox" ' + (e.include ? 'checked' : '') + ' data-act="toggle"/>' +
        '<button data-act="lvl-up" title="升一级">▲</button>' +
        '<span class="lvl">L' + e.level + '</span>' +
        '<button data-act="lvl-down" title="降一级">▼</button>' +
        '<input type="text" value="' + escapeAttr(e.text) + '" data-act="text"/>' +
        '<span class="src">' + e.source + '</span>' +
        '<button data-act="del" title="删除">✕</button>' +
        '</div>';
    });
    box.innerHTML = html;
  }

  function renderPreview() {
    const chapters = EpubCore.buildChapters(state.text, state.entries, meta());
    const tree = EpubCore.buildTocTree(chapters);
    const box = $('preview');
    box.innerHTML = tree.length ? '<ul>' + renderPreviewOl(tree) + '</ul>' : '<p class="empty">—</p>';
  }

  function renderPreviewOl(nodes) {
    let s = '';
    for (const n of nodes) {
      s += '<li>' + escapeHtml(n.title);
      if (n.children && n.children.length) s += '<ul>' + renderPreviewOl(n.children) + '</ul>';
      s += '</li>';
    }
    return s;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function meta() {
    return {
      title: $('title').value.trim() || '未命名',
      author: $('author').value.trim() || '佚名',
      language: 'zh'
    };
  }

  /* ----------------------------- 事件委托 ----------------------------- */

  $('tocList').addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const item = ev.target.closest('.toc-item');
    const id = item.getAttribute('data-id');
    const e = state.entries.find(function (x) { return x.id === id; });
    if (!e) return;
    const act = btn.getAttribute('data-act');
    if (act === 'lvl-up') e.level = Math.min(6, e.level + 1);
    else if (act === 'lvl-down') e.level = Math.max(1, e.level - 1);
    else if (act === 'del') state.entries = state.entries.filter(function (x) { return x.id !== id; });
    renderToc();
    renderPreview();
  });

  $('tocList').addEventListener('change', function (ev) {
    const t = ev.target;
    if (t.matches('input[type=checkbox][data-act="toggle"]')) {
      const item = t.closest('.toc-item');
      const e = state.entries.find(function (x) { return x.id === item.getAttribute('data-id'); });
      if (e) { e.include = t.checked; renderPreview(); }
    }
  });

  $('tocList').addEventListener('input', function (ev) {
    const t = ev.target;
    if (t.matches('input[type=text][data-act="text"]')) {
      const item = t.closest('.toc-item');
      const e = state.entries.find(function (x) { return x.id === item.getAttribute('data-id'); });
      if (e) { e.text = t.value; renderPreview(); }
    }
  });

  $('selectAll').addEventListener('click', function () {
    state.entries.forEach(function (e) { e.include = true; });
    renderToc(); renderPreview();
  });
  $('selectNone').addEventListener('click', function () {
    state.entries.forEach(function (e) { e.include = false; });
    renderToc(); renderPreview();
  });

  $('separators').addEventListener('change', function () {
    saveSettings();
    if (state.text) runDetect();
  });

  $('numbered').addEventListener('change', function () {
    saveSettings();
    if (state.text) runDetect();
  });

  $('encoding').addEventListener('change', function () {
    saveSettings();
  });

  /* ----------------------------- 生成下载 ----------------------------- */

  function setStatus(msg, ok) {
    const s = $('status');
    s.textContent = msg || '';
    s.style.color = ok === false ? '#dc2626' : 'var(--ok)';
  }

  $('generate').addEventListener('click', function () {
    if (!state.text) { setStatus('请先导入文本', false); return; }
    const m = meta();
    try {
      const zip = EpubCore.assembleEpub(JSZip, { text: state.text, entries: state.entries, meta: m, cover: state.cover });
      zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' }).then(function (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (m.title || 'book') + '.epub';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        setStatus('已生成并下载：' + a.download + '（' + (blob.size / 1024).toFixed(1) + ' KB）', true);
      }).catch(function (err) {
        setStatus('生成失败：' + err.message, false);
      });
    } catch (err) {
      setStatus('生成失败：' + err.message, false);
    }
  });

  /* ----------------------------- 文件/拖拽绑定 ----------------------------- */

  $('file').addEventListener('change', function (ev) {
    if (ev.target.files && ev.target.files[0]) loadFile(ev.target.files[0]);
  });
  $('usePaste').addEventListener('click', loadPaste);

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* ----------------------------- 自定义封面 ----------------------------- */

  function clearCoverState() {
    state.cover = null;
    $('coverPreview').src = '';
    $('coverPreviewWrap').style.display = 'none';
    $('coverName').textContent = '';
    $('clearCover').style.display = 'none';
  }

  $('cover').addEventListener('change', function (ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function () {
      state.cover = {
        data: new Uint8Array(reader.result),
        type: f.type,
        name: f.name
      };
      $('coverPreview').src = URL.createObjectURL(f);
      $('coverPreviewWrap').style.display = 'block';
      $('coverName').textContent = f.name;
      $('clearCover').style.display = 'inline-block';
    };
    reader.readAsArrayBuffer(f);
  });

  $('clearCover').addEventListener('click', function () {
    clearCoverState();
    $('cover').value = '';
  });

  // 启动时恢复上次设置（编码偏好、分隔线、数字编号开关）
  loadSettings();
})();
