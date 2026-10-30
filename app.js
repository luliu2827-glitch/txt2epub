/* app.js —— TXT→EPUB 前端交互（依赖 EpubCore 与 JSZip 全局） */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  const state = {
    text: '',
    entries: [],
    meta: { title: '', author: '' },
    cover: null,
    customRules: [],
    manualVolMarkers: [],
    files: []
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
      if (s && typeof s.paragraphMode === 'string') $('paragraphMode').value = s.paragraphMode;
    } catch (e) { /* 存储损坏则忽略，用默认值 */ }
  }

  function saveSettings() {
    try {
      const s = {
        encoding: $('encoding').value,
        separators: $('separators').checked,
        numbered: $('numbered').checked,
        paragraphMode: $('paragraphMode').value
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

  // 从文件名自动取书名/作者（仅在输入框为空时填入，保留用户手动修改）
  function autoFillMetaFromName(name) {
    const base = String(name || '').replace(/\.txt$/i, '').trim();
    if (!base) return;
    let title = base, author = '';
    let m = base.match(/^(.*?)[\s（(\[]+([^）)\]]{1,40})[\s）)\]]\s*$/);
    if (m) { title = m[1].trim(); author = m[2].trim(); }
    else {
      m = base.match(/^(.*?)\s*[-—–]\s*(.+)$/);
      if (m) { title = m[1].trim(); author = m[2].trim(); }
    }
    if (!$('title').value.trim()) $('title').value = title;
    if (!$('author').value.trim()) $('author').value = author || '佚名';
  }

  // 拼接所有已添加文件为一段文本（按列表顺序，文件间留两个换行）
  function rebuildMergedText() {
    if (!state.files.length) {
      state.text = '';
      $('detectedEncoding').textContent = '';
      renderFiles();
      renderToc();
      renderPreview();
      $('generate').disabled = true;
      $('generateSplit').disabled = true;
      return;
    }
    state.text = state.files.map(function (f) { return f.text; }).join('\n\n');
    if (state.files.length === 1) autoFillMetaFromName(state.files[0].name);
    else if (!$('title').value.trim()) $('title').value = state.files[0].name.replace(/\.txt$/i, '');
    renderFiles();
    clearCoverState(); // 换了源文本，旧封面不再匹配
    runDetect();
  }

  async function addFiles(fileList) {
    if (!fileList || !fileList.length) return;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const buf = await file.arrayBuffer();
      const sel = $('encoding').value;
      const res = EpubCore.decodeBuffer(buf, sel);
      state.files.push({ name: file.name, text: res.text, encoding: res.encoding });
    }
    rebuildMergedText();
  }

  function removeFile(idx) {
    state.files.splice(idx, 1);
    rebuildMergedText();
  }

  function moveFile(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= state.files.length) return;
    const t = state.files[idx]; state.files[idx] = state.files[j]; state.files[j] = t;
    rebuildMergedText();
  }

  function renderFiles() {
    const box = $('fileList');
    if (!state.files.length) { box.innerHTML = ''; return; }
    let html = '';
    state.files.forEach(function (f, i) {
      html += '<div class="file-item" data-i="' + i + '">'
        + '<span class="fi-name">' + escapeHtml(f.name) + '</span>'
        + '<span class="fi-enc">' + (ENC_LABEL[f.encoding] || f.encoding) + '</span>'
        + '<button class="fi-btn" data-act="up" ' + (i === 0 ? 'disabled' : '') + ' title="上移">▲</button>'
        + '<button class="fi-btn" data-act="down" ' + (i === state.files.length - 1 ? 'disabled' : '') + ' title="下移">▼</button>'
        + '<button class="fi-btn" data-act="del" title="移除">✕</button>'
        + '</div>';
    });
    box.innerHTML = html;
  }

  function loadPaste() {
    const v = $('paste').value;
    if (!v.trim()) { setStatus('粘贴内容为空', false); return; }
    state.files = [];
    state.text = v;
    $('detectedEncoding').textContent = '粘贴文本（已是 Unicode）';
    clearCoverState();
    runDetect();
    renderFiles();
  }

  /* ----------------------------- 检测与渲染 ----------------------------- */

  function runDetect() {
    if (!state.text) { setStatus('请先导入文本', false); return; }
    state.manualVolMarkers = [];
    state.entries = EpubCore.detect(state.text, {
      useSeparators: $('separators').checked,
      useNumbered: $('numbered').checked,
      customRules: state.customRules
    });
    renderToc();
    renderPreview();
    renderStylePreview();
    $('generate').disabled = false;
    $('generateSplit').disabled = false;
    const n = state.entries.length;
    const bits = [];
    bits.push('第X章 / Chapter / Markdown（默认开启）');
    bits.push('分隔线模式：' + ($('separators').checked ? '开' : '关'));
    bits.push('数字编号：' + ($('numbered').checked ? '开' : '关'));
    $('detectInfo').textContent = n
      ? '检测到 ' + n + ' 个候选标题。识别规则：' + bits.join('；') + '。'
      : '未检测到明显标题，将按单章节处理（整本为一个章节）。';
    // 卷分析提示
    const vol = EpubCore.analyzeVolumes(state.entries);
    $('volHint').textContent = vol.resets >= 2
      ? '检测到 ' + vol.resets + ' 处卷重置（每卷从第一章开始），可一键统一卷前缀。'
      : '';
    setStatus('', true);
  }

  function renderToc() {
    const box = $('tocList');
    if (!state.entries.length) {
      box.innerHTML = '<p class="empty">未检测到标题，将生成单章节 EPUB。</p>';
      return;
    }
    let html = '';
    const markers = state.manualVolMarkers || [];
    state.entries.forEach(function (e) {
      const indent = Math.max(0, e.level - 1) * 22;
      const isVol = markers.indexOf(e.id) >= 0;
      html +=
        '<div class="toc-item" style="margin-left:' + indent + 'px" data-id="' + e.id + '">' +
        '<input type="checkbox" ' + (e.include ? 'checked' : '') + ' data-act="toggle"/>' +
        '<button data-act="lvl-up" title="升一级">▲</button>' +
        '<span class="lvl">L' + e.level + '</span>' +
        '<button data-act="lvl-down" title="降一级">▼</button>' +
        '<input type="text" value="' + escapeAttr(e.text) + '" data-act="text"/>' +
        '<span class="src">' + e.source + '</span>' +
        '<button data-act="vol-start" title="标记为卷起点（手动分卷用）" class="' + (isVol ? 'vol-on' : '') + '">卷</button>' +
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

  /* ----------------------------- 排版样式 ----------------------------- */

  // 读取样式面板当前值（默认值与 buildStyleCss 的 DEFAULT_STYLE 一致 → 不调即旧版效果）
  function styleConfig() {
    return {
      indent: $('indent').value,
      lineHeight: $('lineHeight').value,
      align: $('align').value,
      paraSpacing: $('paraSpacing').value,
      sectionPadV: $('sectionPadV').value
    };
  }

  function applyPreset(name) {
    const p = EpubCore.STYLE_PRESETS[name];
    if (!p) return;
    $('indent').value = p.indent;
    $('lineHeight').value = p.lineHeight;
    $('align').value = p.align;
    $('paraSpacing').value = p.paraSpacing;
    $('sectionPadV').value = p.sectionPadV;
    renderStylePreview();
  }

  // 用首章内容（或占位示例）渲染排版预览，样式实时跟随控件
  function renderStylePreview() {
    const box = $('stylePreview');
    if (!box) return;
    const css = EpubCore.buildStyleCss(styleConfig(), 'styleprev');
    let sample = '';
    if (state.text) {
      try {
        const chs = EpubCore.buildChapters(state.text, state.entries, meta(), $('paragraphMode').value);
        if (chs.length) sample = '<h1>' + escapeHtml(chs[0].title) + '</h1>' + EpubCore.bodyToHtml(chs[0].body, chs[0].mode);
      } catch (e) { /* 预览失败不影响主流程 */ }
    }
    const placeholder = '<h1>第一章 示例标题</h1><p>这是一段示例文字，用来预览你设置的排版效果。首行应当有缩进，行与行之间保持一定的距离，读起来舒服。</p><p>这是另一段文字。当你调整上方的缩进、行距、对齐或段间距时，这里的预览会实时更新，方便你决定最终导出成什么样子。</p>';
    box.innerHTML = '<style>' + css + '</style>' + (sample || placeholder);
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
    else if (act === 'vol-start') {
      const i = state.manualVolMarkers.indexOf(id);
      if (i >= 0) state.manualVolMarkers.splice(i, 1);
      else state.manualVolMarkers.push(id);
      renderToc();
      return; // 仅切换标记，无需刷新预览
    }
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

  // 段落切分模式记忆
  $('paragraphMode').addEventListener('change', function () {
    saveSettings();
    if (state.text) renderStylePreview();
  });

  /* ----------------------------- 排版样式绑定 ----------------------------- */

  ['presetCompact', 'presetStandard', 'presetLoose'].forEach(function (id) {
    $(id).addEventListener('click', function () {
      const name = id === 'presetCompact' ? 'compact' : (id === 'presetLoose' ? 'loose' : 'standard');
      applyPreset(name);
    });
  });
  ['indent', 'lineHeight', 'align', 'paraSpacing', 'sectionPadV'].forEach(function (id) {
    $(id).addEventListener('change', renderStylePreview);
  });

  /* ----------------------------- 自定义规则 ----------------------------- */

  function renderCustomRules() {
    const box = $('customRules');
    if (!state.customRules.length) { box.innerHTML = ''; return; }
    let html = '';
    state.customRules.forEach(function (r, i) {
      let n = 0;
      if (state.text) {
        state.text.split(/\r?\n/).forEach(function (ln) { if (r.test(ln)) n++; });
      }
      html += '<div class="rule-item" data-i="' + i + '">'
        + '<code>' + escapeHtml(r.pattern) + '</code>'
        + '<span class="rule-hint">命中 ' + n + ' 行</span>'
        + '<button data-act="del-rule" title="删除">✕</button>'
        + '</div>';
    });
    box.innerHTML = html;
  }

  $('addRule').addEventListener('click', function () {
    const ex = $('customExample').value.trim();
    if (!ex) { setStatus('请先粘贴一行示例标题', false); return; }
    const rule = EpubCore.parseCustomRule(ex);
    if (!rule) { setStatus('示例需包含数字编号（如「第一章 标题」），纯文字标题无需自定义', false); return; }
    state.customRules.push(rule);
    $('customExample').value = '';
    if (state.text) runDetect();
    renderCustomRules();
    setStatus('已添加规则：' + rule.pattern, true);
  });

  $('customRules').addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-act="del-rule"]');
    if (!btn) return;
    const item = btn.closest('.rule-item');
    const i = parseInt(item.getAttribute('data-i'), 10);
    state.customRules.splice(i, 1);
    if (state.text) runDetect();
    renderCustomRules();
  });

  /* ----------------------------- 批量改写标题 ----------------------------- */

  // 一键去除所有「第X卷」前缀（解决"只有第二卷带前缀"的不一致）
  $('volRemove').addEventListener('click', function () {
    if (!state.entries.length) { setStatus('请先检测标题', false); return; }
    state.entries = EpubCore.transformTitles(state.entries, [{ type: 'removeVolumePrefix' }]);
    renderToc(); renderPreview();
    setStatus('已去除所有「第X卷」前缀', true);
  });

  // 一键为各卷自动加「第X卷」前缀（基于"每卷从第一章开始"自动判定卷边界）
  $('volAdd').addEventListener('click', function () {
    if (!state.entries.length) { setStatus('请先检测标题', false); return; }
    const vol = EpubCore.analyzeVolumes(state.entries);
    if (vol.resets < 2) {
      setStatus('未检测到多卷重置（每卷都从第一章开始），无需自动加卷。如需仍可强制添加，请用查找替换。', false);
      return;
    }
    state.entries = EpubCore.transformTitles(state.entries, [{ type: 'autoAddVolume' }]);
    renderToc(); renderPreview();
    setStatus('已为 ' + vol.resets + ' 卷自动加「第X卷」前缀', true);
  });

  // 按手动标记加卷前缀（兜底：连续编号、无法自动判定卷边界的书）
  $('applyManualVol').addEventListener('click', function () {
    if (!state.manualVolMarkers.length) { setStatus('请先在标题前点「卷」标记卷起点', false); return; }
    state.entries = EpubCore.transformTitles(state.entries, [{ type: 'manualVolume', markers: state.manualVolMarkers.slice() }]);
    renderToc(); renderPreview();
    setStatus('已按 ' + state.manualVolMarkers.length + ' 个标记加卷前缀', true);
  });

  // 勾选「正则」时显示正则用法提示
  $('findRegex').addEventListener('change', function () {
    $('regexHint').style.display = this.checked ? 'block' : 'none';
  });

  // 查找替换：字面或正则，作用于所有已识别标题文本
  $('applyReplace').addEventListener('click', function () {
    if (!state.entries.length) { setStatus('请先检测标题', false); return; }
    const f = $('findText').value;
    if (f === '') { setStatus('请填写查找内容', false); return; }
    const op = { type: 'replace', find: f, replace: $('replaceText').value, regex: $('findRegex').checked };
    try {
      state.entries = EpubCore.transformTitles(state.entries, [op]);
      renderToc(); renderPreview();
      setStatus('已应用替换：' + f + ' → ' + ($('replaceText').value || '（空）'), true);
    } catch (e) {
      setStatus('替换失败：' + e.message, false);
    }
  });

  /* ----------------------------- 长文档拆分下载 ----------------------------- */

  $('generateSplit').addEventListener('click', function () {
    if (!state.text) { setStatus('请先导入文本', false); return; }
    const m = meta();
    const pmode = $('paragraphMode').value;
    const style = styleConfig();
    const mode = $('splitMode').value;
    const allChapters = EpubCore.buildChapters(state.text, state.entries, m, pmode);
    const books = EpubCore.splitBooks(allChapters, {
      mode: mode,
      count: parseInt($('splitCount').value, 10) || 50
    });
    const outer = new JSZip();
    const prefix = ($('splitPrefix').value.trim() || m.title || 'book');
    let done = 0;
    const total = books.length;
    books.forEach(function (bk, bi) {
      const bMeta = Object.assign({}, m, {
        title: total > 1 ? (m.title + '（' + (bi + 1) + '/' + total + '）') : m.title
      });
      const zip = EpubCore.assembleEpub(JSZip, {
        chapters: bk, meta: bMeta, cover: state.cover, paragraphMode: pmode, style: style
      });
      zip.generateAsync({ type: 'uint8array' }).then(function (bytes) {
        outer.file(prefix + '-' + String(bi + 1).padStart(2, '0') + '.epub', bytes);
        done++;
        if (done === total) {
          outer.generateAsync({ type: 'blob', mimeType: 'application/zip' }).then(function (blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = prefix + '.zip';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
            setStatus('已生成 ' + total + ' 本并打包：' + a.download + '（' + (blob.size / 1024).toFixed(1) + ' KB）', true);
          });
        }
      }).catch(function (err) {
        setStatus('拆分生成失败：' + err.message, false);
      });
    });
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
      const zip = EpubCore.assembleEpub(JSZip, { text: state.text, entries: state.entries, meta: m, cover: state.cover, paragraphMode: $('paragraphMode').value, style: styleConfig() });
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
    if (ev.target.files && ev.target.files.length) addFiles(ev.target.files);
    ev.target.value = ''; // 允许重复选同一文件
  });
  $('usePaste').addEventListener('click', loadPaste);
  $('detect').addEventListener('click', function () { if (state.text) runDetect(); });

  // 文件列表：上移/下移/移除
  $('fileList').addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const item = btn.closest('.file-item');
    const i = parseInt(item.getAttribute('data-i'), 10);
    const act = btn.getAttribute('data-act');
    if (act === 'up') moveFile(i, -1);
    else if (act === 'down') moveFile(i, 1);
    else if (act === 'del') removeFile(i);
  });

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });

  /* ----------------------------- 自定义封面 ----------------------------- */

  function clearCoverState() {
    state.cover = null;
    $('coverPreview').src = '';
    $('coverPreviewWrap').style.display = 'none';
    $('coverName').textContent = '';
    $('clearCover').style.display = 'none';
  }

  // 上传图自动压缩：等比缩到最长边 ≤1000px，导出 jpeg(q0.85)，防止 epub 体积膨胀
  function fileToCompressedCover(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const MAX = 1000;
        let width = img.naturalWidth, height = img.naturalHeight;
        if (width > MAX || height > MAX) {
          const s = Math.min(MAX / width, MAX / height);
          width = Math.round(width * s);
          height = Math.round(height * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(function (blob) {
          if (!blob) { URL.revokeObjectURL(url); reject(new Error('编码失败')); return; }
          blob.arrayBuffer().then(function (ab) {
            URL.revokeObjectURL(url);
            resolve({ data: new Uint8Array(ab), type: blob.type, name: file.name });
          }).catch(reject);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
      img.src = url;
    });
  }

  function wrapText(ctx, text, x, y, maxW, lh) {
    const chars = Array.from(text || '');
    let line = '', yy = y;
    for (const ch of chars) {
      if (ctx.measureText(line + ch).width > maxW && line) {
        ctx.fillText(line, x, yy);
        line = ch; yy += lh;
      } else { line += ch; }
    }
    if (line) ctx.fillText(line, x, yy);
  }

  // 纯前端文字封面：深蓝渐变底 + 书名（自动换行）+ 作者
  function generateTextCover(title, author) {
    return new Promise(function (resolve) {
      const w = 600, h = 800;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#1e3a8a');
      g.addColorStop(1, '#0f172a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 46px serif';
      wrapText(ctx, title || '未命名', w / 2, h / 2 - 30, w - 90, 58);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '24px serif';
      ctx.fillText(author || '佚名', w / 2, h / 2 + 70);
      canvas.toBlob(function (b) {
        b.arrayBuffer().then(function (ab) {
          resolve({ data: new Uint8Array(ab), type: 'image/png', name: 'auto-cover.png' });
        });
      }, 'image/png');
    });
  }

  $('cover').addEventListener('change', function (ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    fileToCompressedCover(f).then(function (cov) {
      state.cover = cov;
      const url = URL.createObjectURL(new Blob([cov.data], { type: cov.type }));
      $('coverPreview').src = url;
      $('coverPreviewWrap').style.display = 'block';
      $('coverName').textContent = f.name + '（已压缩至 ' + cov.data.length + ' 字节）';
      $('clearCover').style.display = 'inline-block';
    }).catch(function (err) {
      setStatus('封面处理失败：' + err.message, false);
    });
  });

  // 自动生成文字封面（无图时）：书名+作者画到 Canvas 导出 PNG
  $('autoCover').addEventListener('click', function () {
    generateTextCover(meta().title, meta().author).then(function (cov) {
      state.cover = cov;
      const url = URL.createObjectURL(new Blob([cov.data], { type: cov.type }));
      $('coverPreview').src = url;
      $('coverPreviewWrap').style.display = 'block';
      $('coverName').textContent = '自动文字封面';
      $('clearCover').style.display = 'inline-block';
    });
  });

  $('clearCover').addEventListener('click', function () {
    clearCoverState();
    $('cover').value = '';
  });

  // 启动时恢复上次设置（编码偏好、分隔线、数字编号开关）
  loadSettings();
})();
