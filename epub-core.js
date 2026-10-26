/*
 * epub-core.js —— txt2epub 纯逻辑核心（无 DOM 依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.EpubCore，Node 下 module.exports。
 *
 * 职责：
 *   - 标题检测（默认模式 + 可选分隔线模式）
 *   - 章节切分（按检测到的标题行把正文切成章节）
 *   - 多级目录树构建
 *   - EPUB 打包（JSZip：mimetype 首位且不压缩、nav.xhtml + toc.ncx + content.opf）
 */
(function (global) {
  'use strict';

  /* ----------------------------- 工具函数 ----------------------------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeXmlAttr(s) {
    return escapeHtml(s).replace(/\n/g, ' ');
  }

  /* --------------------------- 编码检测与解码 --------------------------- */

  // 统计替换字符（U+FFFD）数量：fatal 解码失败的字符会以 U+FFFD 填充
  function countReplacement(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n++;
    return n;
  }

  // 统计「看起来像中文/日文」的加权得分：平假名/片假名权重高（强日文言号），
  // 半角片假名（0xFF61–0xFF9F）不计入（避免 Shift_JIS 单字节假名虚高）。
  function cjkScore(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x3040 && c <= 0x309F) n += 3;      // 平假名（强日本信号）
      else if (c >= 0x30A0 && c <= 0x30FF) n += 3; // 片假名（强日本信号）
      else if (
        (c >= 0x3000 && c <= 0x303F) || // CJK 符号和标点
        (c >= 0x3400 && c <= 0x4DBF) || // 扩展 A
        (c >= 0x4E00 && c <= 0x9FFF) || // 基本汉字
        (c >= 0xF900 && c <= 0xFAFF) || // 兼容汉字
        (c >= 0xFF01 && c <= 0xFF60)    // 全角标点/字母（不含半角片假名）
      ) n += 1;
    }
    return n;
  }

  // 自动模式候选顺序：分数相同时优先靠前的编码。
  // 不含 utf-16le：无 BOM 的 UTF-16 字节模糊且常被误读为 CJK 扩展区，交给 BOM 探测即可。
  const AUTO_CANDIDATES = ['utf-8', 'gb18030', 'shift_jis'];

  /**
   * 解码 buffer 为字符串。
   * @param {ArrayBuffer|Uint8Array} buf 原始字节
   * @param {string} enc 'auto' 或具体编码标签（utf-8 / gb18030 / utf-16 / utf-16le / shift_jis …）
   * @returns {{text: string, encoding: string}}
   */
  function decodeBuffer(buf, enc) {
    const bytes = new Uint8Array(buf);

    // 1) BOM 优先：能直接确定编码（覆盖 Windows 记事本「UTF-8 / Unicode」导出）
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: new TextDecoder('utf-16').decode(bytes), encoding: 'utf-16' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return { text: new TextDecoder('utf-16').decode(bytes), encoding: 'utf-16' };
    }

    // 2) 指定编码：直接解，失败兜底 utf-8
    if (enc && enc !== 'auto') {
      try {
        return { text: new TextDecoder(enc, { fatal: false }).decode(bytes), encoding: enc };
      } catch (e) {
        return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), encoding: 'utf-8' };
      }
    }

    // 3) 自动模式：评分制。
    //    对每个候选做 fatal 解码，分数 = 替换符数 * 100000 - CJK 数，越小越好。
    //    → 能解码且「看起来像中文/日文」的编码胜出，避免把 GBK 文件静默误当 UTF-8。
    let best = null;
    for (const name of AUTO_CANDIDATES) {
      let text;
      try {
        text = new TextDecoder(name, { fatal: true }).decode(bytes);
      } catch (e) {
        continue; // 该编码无法表示这些字节，跳过
      }
      const score = countReplacement(text) * 100000 - cjkScore(text);
      if (best === null || score < best.score) {
        best = { text: text, encoding: name, score: score };
      }
    }
    if (best) return { text: best.text, encoding: best.encoding };
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), encoding: 'utf-8' };
  }

  function genUuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* ignore */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* --------------------------- 标题检测规则 --------------------------- */

  // 分隔线：连续 3 个以上相同的 = - * _ （用户可选项，非默认）
  function isSeparator(line) {
    return /^\s*([=\-*_])\s*(\1\s*){2,}$/.test(line);
  }

  // 匹配一个标题行，返回 { level, text, source } 或 null
  // useNumbered: 是否启用「数字编号」识别（P1，默认关闭，需用户勾选）
  function matchHeading(line, useNumbered) {
    // 1) Markdown：# / ## / ### ...
    let m = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      return { level: m[1].length, text: m[2].trim(), source: 'markdown' };
    }
    // 2) 数字编号 —— 仅当用户开启；且标题文字过长（>30 字）不当标题，避免误切。
    //    形式 A：数字(可含点) + 标点分隔符(. 、 ) ）) + 文字，如「1. 标题」「1、标题」「1) 标题」
    //    形式 B：多级十进制编号 + 空格 + 文字，如「2.1 标题」「1.2.3 标题」
    if (useNumbered) {
      m = /^\s*(\d+(?:\.\d+)*)[.、)）]\s+(.+?)\s*$/.exec(line);
      if (!m) {
        m = /^\s*(\d+\.\d+(?:\.\d+)*)\s+(.+?)\s*$/.exec(line);
      }
      if (m) {
        const titleText = m[2].trim();
        if (titleText.length <= 30) {
          const level = m[1].split('.').length; // 1 -> 1, 1.1 -> 2, 1.1.1 -> 3
          return { level: level, text: titleText, source: 'numbered' };
        }
      }
    }
    // 3) 第X章/回/节/卷/部/篇/集（默认核心规则）
    //    章/节后需有分隔符（空格/：:/、/-/—）或行尾，避免把"第二章内容。"误判为正文标题
    m = /^\s*第\s*([0-9零一二三四五六七八九十百千XVI]+)\s*[章回节卷部篇集](?:[\s：:、\-—]+(.+))?\s*$/i.exec(line);
    if (m) {
      return { level: 1, text: line.trim(), source: 'cnchapter' };
    }
    // 4) Chapter N（默认核心规则），保留整行作为标题
    m = /^\s*chapter\s+([0-9]+)(?:\.?\s*(.*))?\s*$/i.exec(line);
    if (m) {
      return { level: 1, text: line.trim(), source: 'enchapter' };
    }
    return null;
  }

  /**
   * 检测标题。返回条目数组（含 include=true 初始值）。
   * @param {string} text 全文
   * @param {object} opts { useSeparators: boolean }
   */
  function detect(text, opts) {
    opts = opts || {};
    const useSep = !!opts.useSeparators;
    const useNum = !!opts.useNumbered;
    const customRules = Array.isArray(opts.customRules) ? opts.customRules : [];
    const lines = text.split(/\r?\n/);
    const consumed = new Set();
    const headings = [];
    let idCounter = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (useSep && isSeparator(line)) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && !consumed.has(j)) {
          consumed.add(j);
          headings.push({
            id: 'h' + (idCounter++),
            lineIndex: j,
            raw: lines[j],
            level: 1,
            text: lines[j].trim(),
            source: 'separator',
            include: true
          });
        }
        continue;
      }
      if (consumed.has(i)) continue;
      const m = matchHeading(line, useNum);
      if (m) {
        headings.push({
          id: 'h' + (idCounter++),
          lineIndex: i,
          raw: line,
          level: m.level,
          text: m.text,
          source: m.source,
          include: true
        });
        continue;
      }
      // 自定义规则（叠加，不替换默认）：命中则作为标题
      for (const rule of customRules) {
        if (rule && typeof rule.test === 'function' && rule.test(line)) {
          headings.push({
            id: 'h' + (idCounter++),
            lineIndex: i,
            raw: line,
            level: 1,
            text: line.trim(),
            source: 'custom',
            include: true
          });
          break;
        }
      }
    }
    return headings;
  }

  /* --------------------------- 章节切分 --------------------------- */

  /**
   * 根据（已编辑/过滤的）条目把正文切成章节。
   * @param {string} text 全文
   * @param {Array} entries 检测到的条目（可被 UI 改过 text/level/include）
   * @param {object} meta { title, author, language }
   */
  function buildChapters(text, entries, meta, mode) {
    meta = meta || {};
    // auto 在整书级别解析一次，得到确定的 line/block；其余模式原样透传
    const resolvedMode = (mode === 'auto' || !mode) ? resolveParagraphMode(text) : mode;
    const lines = text.split(/\r?\n/);
    const inc = entries
      .filter(function (e) { return e.include; })
      .sort(function (a, b) { return a.lineIndex - b.lineIndex; });

    const chapters = [];
    function pushChapter(title, level, body) {
      const idx = chapters.length;
      chapters.push({
        index: idx,
        file: 'chap' + (idx + 1) + '.xhtml',
        title: title,
        level: level,
        body: body,
        mode: resolvedMode
      });
    }

    // 正文开头到第一个标题之间的前置内容 → 识别为「序言」
    // 自动识别 楔子/引子/前言/序章/序言 等；找不到则用「序言」，直接以第一章开头则不建空序言
    if (inc.length && inc[0].lineIndex > 0) {
      const preLines = lines.slice(0, inc[0].lineIndex);
      const preText = preLines.join('\n');
      if (preText.trim() !== '') {
        const headingHint = preLines.find(function (l) {
          return /^\s*(楔子|引子|前言|序言|序章|序|后记|尾声|外传)\s*$/.test(l);
        });
        const preTitle = headingHint ? headingHint.trim() : (meta.title || '序言');
        pushChapter(preTitle, 1, preText);
      }
    }

    inc.forEach(function (e, k) {
      const start = e.lineIndex + 1;
      const end = (k + 1 < inc.length) ? inc[k + 1].lineIndex : lines.length;
      const body = lines.slice(start, end).join('\n');
      pushChapter(e.text, e.level, body);
    });

    return chapters;
  }

  /* --------------------------- 多级目录树 --------------------------- */

  function buildTocTree(chapters) {
    const root = { children: [] };
    const stack = [{ level: 0, node: root }];
    for (const ch of chapters) {
      const node = { title: ch.title, file: ch.file, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].level >= ch.level) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ level: ch.level, node: node });
    }
    return root.children;
  }

  /* --------------------------- XML 渲染 --------------------------- */

  // 段落切分模式：
  //  'block'  按空行分块（默认旧行为，适合"空行分段"的文件）
  //  'line'   每行一段（适合"每行一段、段间无空行"的网文）
  //  'auto'   启发式：空行极少时按行，否则按块 —— 对用户现有文件零副作用
  function bodyToHtml(body, mode) {
    const lines = body.split(/\r?\n/);
    let paras;
    if (mode === 'line') {
      // 去掉行首缩进（全角/半角空格、Tab），避免与 CSS 的 text-indent:2em 叠加成双缩进
      paras = lines.map(function (l) { return l.replace(/^[\u3000 \t]+/, ''); });
    } else if (mode === 'block') {
      paras = body.split(/\r?\n\s*\r?\n/);
    } else { // auto（兜底：理论上 buildChapters 已先解析为 line/block）
      let blank = 0;
      for (const ln of lines) if (ln.trim() === '') blank++;
      const useLine = blank === 0 || (lines.length > 3 && (blank / lines.length) < 0.04);
      paras = useLine ? lines : body.split(/\r?\n\s*\r?\n/);
    }
    const out = [];
    for (const p of paras) {
      const t = (typeof p === 'string') ? p.trim() : '';
      if (!t) continue;
      // 段内换行合并为连续文字（不注入 <br/>），让阅读器按屏幕宽度自由重排 → 铺满页面
      out.push('<p>' + escapeHtml(t).replace(/\r?\n/g, '') + '</p>');
    }
    return out.join('\n');
  }

  // 自动判定分段模式（整书级别，一次判定，避免逐章抖动）
  // 返回 'line'（每行一段）或 'block'（空行分块）。
  // 设计目标：
  //   - 网文「每行一段、段间无空行，空行只出现在标题/小节边界」→ line
  //   - 普通书「段落之间用空行分隔」→ block
  //   - 硬换行排版书（每行被折到固定字宽）→ block，避免把折行误判成段落
  function resolveParagraphMode(text) {
    const lines = String(text || '').split(/\r?\n/);
    let blank = 0;
    for (const ln of lines) if (ln.trim() === '') blank++;
    const ratio = lines.length ? blank / lines.length : 0;
    // 几乎没有空行 → 直接按行（原有行为，覆盖纯网文）
    if (blank === 0 || (lines.length > 3 && ratio < 0.04)) return 'line';
    // blankGapRatio：相邻非空行之间“夹着空行”的间隙占比
    const idx = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') idx.push(i);
    let gaps = 0, bgaps = 0;
    for (let k = 1; k < idx.length; k++) {
      gaps++;
      let hasBlank = false;
      for (let j = idx[k - 1] + 1; j < idx[k]; j++) {
        if (lines[j].trim() === '') { hasBlank = true; break; }
      }
      if (hasBlank) bgaps++;
    }
    const bgr = gaps ? bgaps / gaps : 0;
    // 空行确实用于分隔段落 → 按块
    if (bgr >= 0.4) return 'block';
    // 疑似被排版折行（大量行卡在 55~95 字宽）→ 按块，避免把折行当段落
    let n = 0, w = 0;
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      n++;
      if (t.length >= 55 && t.length <= 95) w++;
    }
    if (n && (w / n) >= 0.5) return 'block';
    // 否则：空行未用于分隔段落（只出现在边界）→ 每行一段
    return 'line';
  }

  function renderNavOl(nodes) {
    let s = '<ol>\n';
    for (const n of nodes) {
      s += '    <li><a href="' + n.file + '">' + escapeHtml(n.title) + '</a>';
      if (n.children && n.children.length) {
        s += '\n' + renderNavOl(n.children);
      }
      s += '</li>\n';
    }
    s += '</ol>\n';
    return s;
  }

  function renderNav(tree, meta) {
    const title = escapeHtml(meta && meta.title ? meta.title : '目录');
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
      '<head><meta charset="utf-8"/><title>' + title + '</title></head>\n' +
      '<body>\n' +
      '<nav epub:type="toc" id="toc" role="doc-toc">\n' +
      '  <h1>' + title + '</h1>\n' +
      renderNavOl(tree) +
      '</nav>\n' +
      '</body>\n</html>\n';
  }

  function renderNcx(chapters, meta) {
    let play = 1;
    let id = 1;
    function np(nodes) {
      let s = '';
      for (const n of nodes) {
        const pid = 'navPoint-' + (id++);
        s += '    <navPoint id="' + pid + '" playOrder="' + (play++) + '">\n';
        s += '      <navLabel><text>' + escapeHtml(n.title) + '</text></navLabel>\n';
        s += '      <content src="' + n.file + '"/>\n';
        if (n.children && n.children.length) s += np(n.children);
        s += '    </navPoint>\n';
      }
      return s;
    }
    const tree = buildTocTree(chapters);
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '  <head>\n' +
      '    <meta name="dtb:uid" content="' + escapeXmlAttr((meta && meta.uuid) || '') + '"/>\n' +
      '    <meta name="dtb:depth" content="2"/>\n' +
      '    <meta name="dtb:totalPageCount" content="0"/>\n' +
      '    <meta name="dtb:maxPageNumber" content="0"/>\n' +
      '  </head>\n' +
      '  <docTitle><text>' + escapeHtml(meta && meta.title ? meta.title : '未命名') + '</text></docTitle>\n' +
      '  <navMap>\n' +
      np(tree) +
      '  </navMap>\n' +
      '</ncx>\n';
  }

  function renderOpf(chapters, meta, cover) {
    const uuid = (meta && meta.uuid) || genUuid();
    const title = escapeXmlAttr(meta && meta.title ? meta.title : '未命名');
    const author = escapeXmlAttr(meta && meta.author ? meta.author : '佚名');
    const lang = (meta && meta.language) || 'zh';
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    let manifest = '';
    manifest += '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';
    manifest += '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n';
    manifest += '    <item id="css" href="style.css" media-type="text/css"/>\n';
    let spine = '';
    let coverMeta = '';
    if (cover) {
      // EPUB3 标准：manifest 项带 properties="cover-image"；
      // 同时写 EPUB2 兼容的 <meta name="cover">，微信读书等阅读器都认。
      manifest += '    <item id="cover-image" href="images/cover.' + cover.ext + '" media-type="' + cover.mime + '" properties="cover-image"/>\n';
      manifest += '    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>\n';
      // 封面页作为书的第一页
      spine += '    <itemref idref="cover-page"/>\n';
      coverMeta = '    <meta name="cover" content="cover-image"/>\n';
    }
    chapters.forEach(function (c) {
      const cid = 'chap' + (c.index + 1);
      manifest += '    <item id="' + cid + '" href="' + c.file + '" media-type="application/xhtml+xml"/>\n';
      spine += '    <itemref idref="' + cid + '"/>\n';
    });

    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' + lang + '">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '    <dc:identifier id="bookid">urn:uuid:' + uuid + '</dc:identifier>\n' +
      '    <dc:title>' + title + '</dc:title>\n' +
      '    <dc:language>' + lang + '</dc:language>\n' +
      '    <dc:creator>' + author + '</dc:creator>\n' +
      coverMeta +
      '    <meta property="dcterms:modified">' + modified + '</meta>\n' +
      '  </metadata>\n' +
      '  <manifest>\n' + manifest + '  </manifest>\n' +
      '  <spine toc="ncx">\n' + spine + '  </spine>\n' +
      '</package>\n';
  }

  // 由上传文件推断封面扩展名与 MIME（支持 jpg/jpeg/png/webp/gif）
  function coverInfo(cover) {
    const byType = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'
    };
    let ext = byType[cover.type];
    if (!ext && cover.name) {
      const m = /\.(jpe?g|png|webp|gif)$/i.exec(cover.name);
      if (m) ext = m[1].toLowerCase();
    }
    if (!ext) ext = 'jpg';
    const byExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const mime = (cover.type && byType[cover.type]) ? cover.type : (byExt[ext] || 'image/jpeg');
    return { ext: ext, mime: mime };
  }

  // 封面页（书的第一页），图片铺满
  function renderCoverPage(cover) {
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">\n' +
      '<head><meta charset="utf-8"/><title>封面</title>\n' +
      '<style>\n' +
      'body{margin:0;padding:0;}\n' +
      'section{margin:0;padding:0;}\n' +
      '.cover-img{width:100%;height:auto;display:block;}\n' +
      '</style>\n' +
      '</head>\n' +
      '<body>\n' +
      '<section epub:type="cover">\n' +
      '<img class="cover-img" src="images/cover.' + cover.ext + '" alt="封面"/>\n' +
      '</section>\n' +
      '</body>\n</html>\n';
  }

  function renderChapter(ch, meta) {
    const title = escapeHtml(ch.title);
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' +
      ((meta && meta.language) || 'zh') + '">\n' +
      '<head><meta charset="utf-8"/><title>' + title + '</title>' +
      '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
      '<body>\n' +
      '<section epub:type="chapter">\n' +
      '<h1>' + title + '</h1>\n' +
      bodyToHtml(ch.body, ch.mode) + '\n' +
      '</section>\n' +
      '</body>\n</html>\n';
  }

  const CONTAINER_XML =
    '<?xml version="1.0"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles>\n' +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
    '  </rootfiles>\n' +
    '</container>\n';

  const STYLE_CSS =
    'body{margin:0;padding:0;line-height:1.8;color:#222;}\n' +
    'section{padding:0.8em 0;}\n' +
    'h1{font-size:1.4em;border-bottom:1px solid #ddd;padding-bottom:.3em;margin:.4em 0 .8em;}\n' +
    // 图书精排风：首行缩进 2em（段落连成一片，消除稀疏感），不用两端对齐，章首段不缩进
    'p{margin:0;text-indent:2em;text-align:left;}\n' +
    'p:first-of-type{text-indent:0;}\n';

  /* --------------------------- 打包装配 --------------------------- */

  /**
   * 装配 EPUB（不触发下载，返回已填充的 JSZip 实例）。
   * @param {Function} JSZip JSZip 构造器
   * @param {object} opts { text, entries, meta }
   */
  function assembleEpub(JSZip, opts) {
    const text = opts.text || '';
    const meta = Object.assign({ title: '未命名', author: '佚名', language: 'zh' }, opts.meta || {});
    if (!meta.uuid) meta.uuid = genUuid();

    const chapters = (opts.chapters && opts.chapters.length)
      ? opts.chapters
      : buildChapters(text, opts.entries || [], meta, opts.paragraphMode || 'auto');
    const tree = buildTocTree(chapters);

    let cover = null;
    if (opts.cover && opts.cover.data) {
      cover = coverInfo(opts.cover);
    }

    const zip = new JSZip();
    // mimetype 必须第一个且不被压缩
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.folder('META-INF').file('container.xml', CONTAINER_XML);

    const oebps = zip.folder('OEBPS');
    oebps.file('content.opf', renderOpf(chapters, meta, cover));
    oebps.file('nav.xhtml', renderNav(tree, meta));
    oebps.file('toc.ncx', renderNcx(chapters, meta));
    oebps.file('style.css', STYLE_CSS);
    if (cover) {
      oebps.folder('images').file('cover.' + cover.ext, opts.cover.data);
      oebps.file('cover.xhtml', renderCoverPage(cover));
    }
    chapters.forEach(function (c) {
      oebps.file(c.file, renderChapter(c, meta));
    });

    return zip;
  }

  /* --------------------------- 自定义规则：示例→解析 --------------------------- */

  // 从用户给的「示例标题」反推匹配规则（叠加到默认识别，不替换默认）。
  // 启发式：示例含数字编号即可泛化 —— 前缀字面 + 编号(.+?) + 后缀（末尾标题词泛化为 .*）。
  // 例：「第一章 风起云涌」→ /^第(.+?)章 (.*)$/，匹配所有「第X章 …」
  function parseCustomRule(example) {
    const s = String(example || '').trim();
    if (!s) return null;
    const numRe = /[0-9]+|[零一二三四五六七八九十百千万〇]+/;
    const idx = s.search(numRe);
    if (idx < 0) return null; // 无数字则无法泛化编号
    const prefix = s.slice(0, idx).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numMatch = s.slice(idx).match(numRe)[0];
    const suffixRaw = s.slice(idx + numMatch.length);
    // 后缀里：若末尾存在标题词且前面有分隔符/空格，则把标题词泛化为 (.*)
    let sepIdx = -1;
    for (let k = suffixRaw.length - 1; k >= 0; k--) {
      if (/[\s：:、，。.,\-—]/.test(suffixRaw[k])) { sepIdx = k; break; }
    }
    let fixed, tail;
    if (sepIdx >= 0) {
      fixed = suffixRaw.slice(0, sepIdx + 1);
      tail = '(.*)';
    } else {
      fixed = suffixRaw;
      tail = '';
    }
    const pattern = '^' + prefix + '(.+?)' + fixed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + tail + '$';
    let rx;
    try { rx = new RegExp(pattern); } catch (e) { return null; }
    return {
      source: 'custom',
      example: s,
      pattern: pattern,
      test: function (line) { return rx.test(String(line)); }
    };
  }

  /* --------------------------- 长文档拆分 --------------------------- */

  // 把整本书章节按策略切分为多本。返回数组，每项为该本的 chapters 子数组。
  function splitBooks(chapters, opts) {
    opts = opts || {};
    const mode = opts.mode || 'volume';
    if ((mode === 'count' || mode === 'size') && opts.count > 1) {
      const n = Math.max(1, opts.count | 0);
      const books = [];
      for (let i = 0; i < chapters.length; i += n) books.push(chapters.slice(i, i + n));
      return books;
    }
    if (mode === 'volume') {
      const books = [];
      let cur = [];
      chapters.forEach(function (ch) {
        const isVol = /^(卷|部|第.+?[卷部])/.test(ch.title);
        if (isVol && cur.length) { books.push(cur); cur = []; }
        cur.push(ch);
      });
      if (cur.length) books.push(cur);
      return books.length > 1 ? books : [chapters];
    }
    return [chapters];
  }

  /* --------------------------- 批量改写标题 --------------------------- */

  // 中文/阿拉伯数字互转（覆盖 零~九十九，足够网文章节编号使用）
  const CN_DIGITS = {零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,百:100,千:1000};
  function cnToNum(s) {
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    const map = CN_DIGITS;
    if (s === '十') return 10;
    if (s.length === 2) {
      if (s[0] === '十') return 10 + (map[s[1]] || 0);
      if (s[1] === '十') return (map[s[0]] || 0) * 10;
      return (map[s[0]] || 0) * 10 + (map[s[1]] || 0);
    }
    if (s.length === 3 && s[1] === '十') return (map[s[0]] || 0) * 10 + (map[s[2]] || 0);
    return map[s] !== undefined ? map[s] : NaN;
  }
  function numToCn(n) {
    const d = ['零','一','二','三','四','五','六','七','八','九'];
    if (n <= 0) return String(n);
    if (n < 10) return d[n];
    if (n < 20) return '十' + (n > 10 ? d[n % 10] : '');
    if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
    return String(n);
  }

  // 是否为「某卷的起始章节」：第X章/回/节… 且 X 解析为 1（每卷从第一章重新开始即卷边界）
  function isStartChapter(text) {
    const m = /第\s*([0-9零一二三四五六七八九十百千两]+)\s*[章回节]/i.exec(String(text || ''));
    if (!m) return false;
    return cnToNum(m[1]) === 1;
  }

  // 去掉标题开头的「第X卷 」前缀（兼容空格/标点变体）
  function stripVolumePrefix(text) {
    return String(text || '').replace(/^第\s*[0-9零一二三四五六七八九十百千两]+\s*卷\s*[,，。、:：\s]*/, '');
  }
  function addVolumePrefix(text, volNum) {
    return '第' + numToCn(volNum) + '卷 ' + stripVolumePrefix(text);
  }

  // 分析：是否存在多卷重置（起始章出现 ≥2 次即判定为分卷书）
  function analyzeVolumes(entries) {
    let resets = 0;
    entries.forEach(function (e) {
      if (e.include !== false && isStartChapter(e.text)) resets++;
    });
    return { resets: resets, needsVolumeFix: resets >= 2 };
  }

  // 批量改写标题：按顺序应用 ops，返回新的 entries 数组（仅复制并改写 text 字段，原数组不变）
  // op 类型：
  //   {type:'removeVolumePrefix'}                  去除每条标题开头的「第X卷 」
  //   {type:'autoAddVolume'}                       自动检测起始章重置点，按卷加 「第X卷 」前缀
  //   {type:'manualVolume', markers:[id,...]}      指定 id 为卷起点，按标记顺序加前缀（兜底：连续编号书）
  //   {type:'replace', find, replace, regex}       查找替换（字面或正则）
  function transformTitles(entries, ops) {
    const out = entries.map(function (e) { return Object.assign({}, e, { text: e.text }); });
    (ops || []).forEach(function (op) {
      if (!op) return;
      if (op.type === 'removeVolumePrefix') {
        out.forEach(function (e) { e.text = stripVolumePrefix(e.text); });
      } else if (op.type === 'autoAddVolume') {
        let vol = 0, started = false;
        out.forEach(function (e) {
          if (e.include !== false && isStartChapter(e.text)) { vol++; started = true; }
          if (started) e.text = addVolumePrefix(e.text, vol);
        });
      } else if (op.type === 'manualVolume') {
        const set = new Set(op.markers || []);
        let vol = 0;
        out.forEach(function (e) {
          if (set.has(e.id)) vol++;
          if (vol > 0) e.text = addVolumePrefix(e.text, vol);
        });
      } else if (op.type === 'replace') {
        if (op.regex) {
          let rx;
          try { rx = new RegExp(op.find, 'g'); } catch (e) { return; }
          out.forEach(function (e) {
            try { e.text = e.text.replace(rx, op.replace || ''); } catch (e2) { /* ignore */ }
          });
        } else {
          out.forEach(function (e) {
            if (op.find != null && op.find !== '') e.text = e.text.split(op.find).join(op.replace || '');
          });
        }
      }
    });
    return out;
  }

  /* --------------------------- 导出 --------------------------- */

  const api = {
    escapeHtml: escapeHtml,
    isSeparator: isSeparator,
    bodyToHtml: bodyToHtml,
    resolveParagraphMode: resolveParagraphMode,
    matchHeading: matchHeading,
    detect: detect,
    buildChapters: buildChapters,
    buildTocTree: buildTocTree,
    assembleEpub: assembleEpub,
    decodeBuffer: decodeBuffer,
    countReplacement: countReplacement,
    cjkScore: cjkScore,
    parseCustomRule: parseCustomRule,
    splitBooks: splitBooks,
    analyzeVolumes: analyzeVolumes,
    transformTitles: transformTitles,
    cnToNum: cnToNum,
    numToCn: numToCn,
    isStartChapter: isStartChapter
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.EpubCore = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
