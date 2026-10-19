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
  function buildChapters(text, entries, meta) {
    meta = meta || {};
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
        body: body
      });
    }

    // 正文开头到第一个标题之间的前置内容
    if (inc.length && inc[0].lineIndex > 0) {
      const pre = lines.slice(0, inc[0].lineIndex).join('\n');
      if (pre.trim() !== '') {
        pushChapter(meta.title || '正文', 1, pre);
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

  function bodyToHtml(body) {
    const blocks = body.split(/\r?\n\s*\r?\n/);
    const out = [];
    for (const b of blocks) {
      const t = b.trim();
      if (!t) continue;
      out.push('<p>' + escapeHtml(t).replace(/\r?\n/g, '<br/>') + '</p>');
    }
    return out.join('\n');
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

  function renderOpf(chapters, meta) {
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
      '    <meta property="dcterms:modified">' + modified + '</meta>\n' +
      '  </metadata>\n' +
      '  <manifest>\n' + manifest + '  </manifest>\n' +
      '  <spine toc="ncx">\n' + spine + '  </spine>\n' +
      '</package>\n';
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
      bodyToHtml(ch.body) + '\n' +
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
    'body{font-family:"Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;' +
    'margin:0;padding:0;line-height:1.8;color:#222;}\n' +
    'section{padding:1.2em 1.4em;}\n' +
    'h1{font-size:1.4em;border-bottom:1px solid #ddd;padding-bottom:.3em;margin-top:0;}\n' +
    'p{margin:0 0 1em 0;text-align:justify;}\n';

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

    const chapters = buildChapters(text, opts.entries || [], meta);
    const tree = buildTocTree(chapters);

    const zip = new JSZip();
    // mimetype 必须第一个且不被压缩
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.folder('META-INF').file('container.xml', CONTAINER_XML);

    const oebps = zip.folder('OEBPS');
    oebps.file('content.opf', renderOpf(chapters, meta));
    oebps.file('nav.xhtml', renderNav(tree, meta));
    oebps.file('toc.ncx', renderNcx(chapters, meta));
    oebps.file('style.css', STYLE_CSS);
    chapters.forEach(function (c) {
      oebps.file(c.file, renderChapter(c, meta));
    });

    return zip;
  }

  /* --------------------------- 导出 --------------------------- */

  const api = {
    escapeHtml: escapeHtml,
    isSeparator: isSeparator,
    matchHeading: matchHeading,
    detect: detect,
    buildChapters: buildChapters,
    buildTocTree: buildTocTree,
    assembleEpub: assembleEpub,
    decodeBuffer: decodeBuffer,
    countReplacement: countReplacement,
    cjkScore: cjkScore
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.EpubCore = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
