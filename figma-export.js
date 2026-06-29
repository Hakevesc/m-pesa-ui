/**
 * Figma Export — DOM-to-Figma serializer + export button injection.
 * Include this script in any HTML page to add an "Export to Figma" button.
 * Pairs with the companion Figma plugin in /figma-plugin/ to import designs.
 */
(function () {
  'use strict';

  // ── Color parsing ──
  var colorProbe = null;
  function parseCssColor(raw) {
    if (!raw || raw === 'transparent' || raw === 'rgba(0, 0, 0, 0)') return null;
    var m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) {
      if (!colorProbe) {
        colorProbe = document.createElement('div');
        colorProbe.style.display = 'none';
        document.body.appendChild(colorProbe);
      }
      colorProbe.style.color = '';
      colorProbe.style.color = raw;
      m = getComputedStyle(colorProbe).color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) return null;
    }
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] !== undefined ? +m[4] : 1 };
  }

  function parseGradient(bg) {
    var m = bg.match(/linear-gradient\(([^)]+)\)/);
    if (!m) return null;
    var parts = m[1].split(/,(?![^(]*\))/);
    var angleDeg = 180;
    var colorStops = parts;
    var angleMatch = parts[0].trim().match(/^([\d.]+)deg$/);
    if (angleMatch) { angleDeg = parseFloat(angleMatch[1]); colorStops = parts.slice(1); }
    else if (parts[0].trim().indexOf('to ') === 0) { colorStops = parts.slice(1); }
    var stops = [];
    colorStops.forEach(function (s, i) {
      var t = s.trim();
      var posMatch = t.match(/([\d.]+)%\s*$/);
      var colorStr = posMatch ? t.slice(0, t.length - posMatch[0].length).trim() : t;
      var position = posMatch ? parseFloat(posMatch[1]) / 100 : i / Math.max(colorStops.length - 1, 1);
      var c = parseCssColor(colorStr);
      if (c) stops.push({ color: c, position: position });
    });
    if (stops.length < 2) return null;
    var rad = (angleDeg - 90) * Math.PI / 180;
    return {
      type: 'GRADIENT_LINEAR',
      gradientHandlePositions: [
        { x: 0.5 - Math.cos(rad) * 0.5, y: 0.5 - Math.sin(rad) * 0.5 },
        { x: 0.5 + Math.cos(rad) * 0.5, y: 0.5 + Math.sin(rad) * 0.5 }
      ],
      gradientStops: stops
    };
  }

  function parseBoxShadow(raw) {
    if (!raw || raw === 'none') return [];
    var effects = [];
    // Computed style puts the color FIRST: "rgba(0,0,0,.07) 0px 2px 10px 0px"
    var parts = raw.split(/,(?![^(]*\))/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      var inset = p.indexOf('inset') !== -1;
      var colorMatch = p.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
      var nums = p.replace(/rgba?\([^)]+\)/, '').match(/(-?[\d.]+)px/g);
      if (!colorMatch || !nums || nums.length < 2) continue;
      var c = parseCssColor(colorMatch[0]);
      if (!c) continue;
      effects.push({
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: c,
        offset: { x: parseFloat(nums[0]), y: parseFloat(nums[1]) },
        radius: nums[2] ? parseFloat(nums[2]) : 0,
        spread: nums[3] ? parseFloat(nums[3]) : 0,
        visible: true
      });
    }
    return effects;
  }

  function mapFontWeight(w) {
    var n = parseInt(w, 10);
    if (!isNaN(n)) return n;
    var map = { normal: 400, bold: 700, lighter: 300, bolder: 700 };
    return map[w] || 400;
  }

  // ── Component manifest: CSS class → Figma component + variant ──
  //   Lets the importer build a master once and place instances afterward.
  //   Sibling classes (cta / cta-sec…) map to one component with different
  //   variant values; `modifiers` refine the value from a second class
  //   (e.g. tx-icon + "out", toggle + "on").
  var COMPONENT_MANIFEST = {
    'cta':        { name: 'Button', variantProp: 'Style', value: 'Primary' },
    'cta-sec':    { name: 'Button', variantProp: 'Style', value: 'Secondary' },
    'cta-ghost':  { name: 'Button', variantProp: 'Style', value: 'Ghost' },
    'cta-danger': { name: 'Button', variantProp: 'Style', value: 'Danger' },
    'tx-icon':    { name: 'TxIcon', variantProp: 'Direction', value: 'In', modifiers: { out: 'Out' } },
    'toggle':     { name: 'Toggle', variantProp: 'State', value: 'Off', modifiers: { on: 'On' } },
    'check':      { name: 'Check',  variantProp: 'State', value: 'Unchecked', modifiers: { checked: 'Checked' } },
    'field-box':  { name: 'Field',  variantProp: 'State', value: 'Default', modifiers: { focus: 'Focused' } },
    'pill':       { name: 'Pill',   variantProp: 'Tone',  value: 'Neutral' }
  };

  function classListOf(el) {
    if (!el.className || typeof el.className !== 'string') return [];
    return el.className.split(/\s+/).filter(Boolean);
  }

  // First Tabler icon glyph (<i class="ti ti-*">) or 'svg' inside the element.
  function detectIcon(el) {
    var i = el.querySelector('i[class*="ti-"]');
    if (i) {
      var m = i.className.match(/ti-([\w-]+)/);
      return m ? m[1] : 'glyph';
    }
    if (el.querySelector('svg')) return 'svg';
    return null;
  }

  // Visible text label (icon glyphs use ::before content, so textContent skips
  // them) — applied as the editable Label override on an instance.
  function detectLabel(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t || null;
  }

  // Resolve an element to a component descriptor, or null. `data-component`
  // wins over the manifest so any element can be tagged explicitly in HTML.
  function matchComponent(el) {
    var name, variantProp, value;
    if (el.dataset && el.dataset.component) {
      name = el.dataset.component;
      variantProp = el.dataset.variantProp || 'Variant';
      value = el.dataset.variant || 'Default';
    } else {
      var classes = classListOf(el);
      var base = null, baseClass = null;
      for (var i = 0; i < classes.length; i++) {
        if (COMPONENT_MANIFEST[classes[i]]) { base = COMPONENT_MANIFEST[classes[i]]; baseClass = classes[i]; break; }
      }
      if (!base) return null;
      name = base.name;
      variantProp = base.variantProp;
      value = base.value;
      if (base.modifiers) {
        for (var j = 0; j < classes.length; j++) {
          if (classes[j] !== baseClass && base.modifiers[classes[j]]) { value = base.modifiers[classes[j]]; break; }
        }
      }
    }
    return { name: name, variantProp: variantProp, value: value, key: name + '/' + value };
  }

  // ── Design tokens: resolve :root --color-* custom properties to RGBA so the
  //    plugin (which has no DOM) can create Figma colour variables from them. ──
  function collectColorTokens() {
    var tokens = [];
    var seen = {};
    try {
      var sheets = document.styleSheets;
      for (var s = 0; s < sheets.length; s++) {
        var rules;
        try { rules = sheets[s].cssRules; } catch (e) { continue; } // cross-origin
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (!rule.style || !rule.selectorText) continue;
          if (!/(^|,)\s*:root\s*($|,)/.test(rule.selectorText)) continue;
          for (var k = 0; k < rule.style.length; k++) {
            var prop = rule.style[k];
            if (!prop || prop.indexOf('--') !== 0 || seen[prop]) continue;
            var val = rule.style.getPropertyValue(prop).trim();
            var c = parseCssColor(val);
            if (c) { tokens.push({ name: prop, value: val, color: c }); seen[prop] = 1; }
          }
        }
      }
    } catch (e) { /* tokens are optional */ }
    return tokens;
  }

  // ── Auto layout detection (CSS flexbox → Figma Auto Layout) ──
  function extractAutoLayout(style) {
    var disp = style.display;
    if (disp !== 'flex' && disp !== 'inline-flex') return null;
    var horizontal = (style.flexDirection || 'row').indexOf('row') === 0;
    var gap = parseFloat(horizontal ? style.columnGap : style.rowGap);
    if (isNaN(gap)) gap = 0;
    var primaryMap = {
      'flex-start': 'MIN', 'start': 'MIN', 'left': 'MIN', 'normal': 'MIN',
      'center': 'CENTER', 'flex-end': 'MAX', 'end': 'MAX', 'right': 'MAX',
      'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN'
    };
    var counterMap = {
      'flex-start': 'MIN', 'start': 'MIN', 'normal': 'MIN', 'stretch': 'MIN',
      'center': 'CENTER', 'flex-end': 'MAX', 'end': 'MAX', 'baseline': 'BASELINE'
    };
    return {
      direction: horizontal ? 'HORIZONTAL' : 'VERTICAL',
      itemSpacing: gap,
      paddingTop: parseFloat(style.paddingTop) || 0,
      paddingRight: parseFloat(style.paddingRight) || 0,
      paddingBottom: parseFloat(style.paddingBottom) || 0,
      paddingLeft: parseFloat(style.paddingLeft) || 0,
      primaryAlign: primaryMap[style.justifyContent] || 'MIN',
      counterAlign: counterMap[style.alignItems] || 'MIN',
      wrap: horizontal && style.flexWrap === 'wrap'
    };
  }

  // ── Animation freeze (entrance animations shift positions during capture) ──
  function freezeAnimations() {
    var s = document.createElement('style');
    s.id = 'figma-noanim';
    s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
    document.head.appendChild(s);
    return s;
  }
  function unfreezeAnimations(s) {
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }
  function nextFrame() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { requestAnimationFrame(r); });
    });
  }

  // ── The phone to export: every screen holds its own phone mockup, so always
  //    resolve the one inside the ACTIVE screen, not the first in the page.
  //    The group-saving flow uses .sc/.ph instead of .screen/.phone ──
  var SCREEN_SEL = '.screen, .sc';
  var PHONE_SEL = '.phone, .ph, .phone-frame';
  function getActivePhone() {
    return document.querySelector('.screen.active .phone, .sc.active .ph') ||
           document.querySelector(PHONE_SEL);
  }

  function screenDisplayName(phoneOrScreen, fallback) {
    var t = phoneOrScreen.querySelector('.apphead-title, .hd-title, .pp-title, .header-title, .header-subtitle');
    if (t && t.textContent.trim()) return t.textContent.trim();
    return fallback;
  }

  // ── Rasterizers: icons, SVGs and images become PNG data so Figma shows them ──
  function iconToPng(el, style, rect) {
    try {
      var pseudo = getComputedStyle(el, '::before');
      var content = pseudo.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal') return null;
      var glyph = content.replace(/^["']|["']$/g, '');
      if (!glyph) return null;
      var fs = parseFloat(pseudo.fontSize || style.fontSize) || 16;
      var fam = pseudo.fontFamily || style.fontFamily;
      var c = document.createElement('canvas');
      var w = Math.max(2, Math.round(rect.width * 2));
      var h = Math.max(2, Math.round(rect.height * 2));
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.font = (pseudo.fontWeight || '400') + ' ' + (fs * 2) + 'px ' + fam;
      ctx.fillStyle = style.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, w / 2, h / 2);
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  }

  function imgToPng(el, rect) {
    try {
      var c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(rect.width * 2));
      c.height = Math.max(2, Math.round(rect.height * 2));
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch (e) { return null; } // CORS-tainted images can't be read
  }

  function rasterizeSvg(svgEl) {
    return new Promise(function (resolve) {
      try {
        var rect = svgEl.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return resolve(null);
        var clone = svgEl.cloneNode(true);
        clone.setAttribute('width', rect.width);
        clone.setAttribute('height', rect.height);
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        // resolve currentColor strokes/fills (lucide icons)
        clone.setAttribute('style', 'color:' + getComputedStyle(svgEl).color);
        var xml = new XMLSerializer().serializeToString(clone);
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = Math.max(2, Math.round(rect.width * 2));
            c.height = Math.max(2, Math.round(rect.height * 2));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/png'));
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      } catch (e) { resolve(null); }
    });
  }

  function rasterizeVisibleSvgs(root) {
    var svgs = root.querySelectorAll('svg');
    var map = new Map();
    var jobs = [];
    svgs.forEach(function (svg) {
      var rect = svg.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      jobs.push(rasterizeSvg(svg).then(function (data) {
        if (data) map.set(svg, data);
      }));
    });
    return Promise.all(jobs).then(function () { return map; });
  }

  // ── Text measurement: exact glyph boxes via DOM ranges ──
  function measureTextNode(textNode, elRect, style) {
    var raw = textNode.textContent;
    if (!raw || !raw.replace(/\s+/g, '')) return null;
    var range = document.createRange();
    range.selectNode(textNode);
    var r = range.getBoundingClientRect();
    if (range.detach) range.detach();
    if (r.width < 1 || r.height < 1) return null;
    return {
      type: 'TEXT',
      name: 'text',
      text: raw.replace(/\s+/g, ' ').trim(),
      x: Math.round(r.left - elRect.left),
      y: Math.round(r.top - elRect.top),
      w: Math.ceil(r.width) + 1,
      h: Math.ceil(r.height),
      fontSize: parseFloat(style.fontSize) || 14,
      fontWeight: mapFontWeight(style.fontWeight),
      fontFamily: style.fontFamily.split(',')[0].replace(/['"]/g, '').trim() || 'Inter',
      color: parseCssColor(style.color) || { r: 0, g: 0, b: 0, a: 1 },
      lineHeight: style.lineHeight === 'normal' ? null : parseFloat(style.lineHeight),
      textAlign: style.textAlign === 'center' ? 'CENTER' : style.textAlign === 'right' ? 'RIGHT' : 'LEFT',
      letterSpacing: parseFloat(style.letterSpacing) || 0
    };
  }

  // ── DOM Serializer ──
  function serializeElement(el, containerRect, depth, svgMap) {
    if (depth > 24) return null;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;

    var style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    if (parseFloat(style.opacity) === 0) return null;

    var tag = el.tagName.toLowerCase();
    var cls = el.className && typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '';
    var name = cls || tag;

    var node = {
      type: 'FRAME',
      name: name,
      x: Math.round(rect.left - containerRect.left),
      y: Math.round(rect.top - containerRect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: [
        parseFloat(style.borderTopLeftRadius) || 0,
        parseFloat(style.borderTopRightRadius) || 0,
        parseFloat(style.borderBottomRightRadius) || 0,
        parseFloat(style.borderBottomLeftRadius) || 0
      ],
      opacity: parseFloat(style.opacity),
      clipsContent: style.overflow === 'hidden' || style.overflow === 'clip' ||
                     style.overflowX === 'hidden' || style.overflowY === 'hidden',
      // flagged so the plugin can pin this child when its parent is auto layout
      absolute: style.position === 'absolute' || style.position === 'fixed',
      autoLayout: extractAutoLayout(style),
      children: []
    };

    // Component tagging: mark reusable elements so the importer can instance
    // a master instead of rebuilding raw frames. Children are still serialized
    // (the library build and the no-match fallback both need the full subtree).
    var comp = matchComponent(el);
    if (comp) {
      node.component = comp;
      var icon = detectIcon(el);
      node.overrides = { label: detectLabel(el), icon: icon, hasIcon: !!icon };
    }

    // Background
    var bgColor = style.backgroundColor;
    if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
      var c = parseCssColor(bgColor);
      if (c) node.fills.push({ type: 'SOLID', color: c });
    }
    var bgImage = style.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      var grad = parseGradient(bgImage);
      if (grad) node.fills.push(grad);
    }

    // Border
    var bw = parseFloat(style.borderTopWidth);
    if (bw > 0 && style.borderTopStyle !== 'none') {
      var bc = parseCssColor(style.borderTopColor);
      if (bc) node.strokes.push({ type: 'SOLID', color: bc, weight: bw });
    }

    // Shadow
    node.effects = parseBoxShadow(style.boxShadow);

    // Icon fonts (Tabler <i class="ti ti-*">) → rasterized glyph
    if (tag === 'i') {
      var png = iconToPng(el, style, rect);
      if (png) {
        node.name = 'icon-' + ((el.className.match(/ti-([^\s]+)/) || ['', 'glyph'])[1]);
        node.imageData = png;
        node.fills = [];
        node.autoLayout = null;
        return node;
      }
    }

    // Inline SVG (lucide etc.) → rasterized
    if (tag === 'svg') {
      node.name = 'icon-svg';
      if (svgMap && svgMap.get(el)) node.imageData = svgMap.get(el);
      node.fills = [];
      node.autoLayout = null;
      return node;
    }

    // <img> → rasterized
    if (tag === 'img') {
      node.name = 'image';
      var imgPng = imgToPng(el, rect);
      if (imgPng) node.imageData = imgPng;
      node.autoLayout = null;
      return node;
    }

    // Walk childNodes in DOM order so auto-layout keeps icon/text sequence
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) {
        var textChild = measureTextNode(n, rect, style);
        if (textChild) node.children.push(textChild);
      } else if (n.nodeType === 1) {
        var child = serializeElement(n, containerRect, depth + 1, svgMap);
        if (child) {
          // child coords are container-relative; convert to parent-relative
          child.x -= node.x;
          child.y -= node.y;
          node.children.push(child);
        }
      }
    }

    return node;
  }

  function serializeRoot(rootEl, containerRect, svgMap) {
    return serializeElement(rootEl, containerRect, 0, svgMap);
  }

  // ── Screenshot via html2canvas (loaded on demand) ──
  function loadHtml2Canvas() {
    return new Promise(function (resolve, reject) {
      if (window.html2canvas) return resolve(window.html2canvas);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = function () { resolve(window.html2canvas); };
      s.onerror = function () { reject(new Error('Failed to load html2canvas')); };
      document.head.appendChild(s);
    });
  }

  function captureScreenshot(h2c, phone) {
    if (!h2c) return Promise.resolve(null);
    return h2c(phone, {
      scale: 2,
      useCORS: true,
      allowTaint: false,
      backgroundColor: null,
      width: phone.offsetWidth,
      height: phone.offsetHeight
    }).then(function (canvas) {
      return canvas.toDataURL('image/png');
    }).catch(function () { return null; });
  }

  function downloadJson(obj, filename) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function setButtonState(html, done) {
    var btn = document.getElementById('figma-export-btn');
    if (!btn) return;
    btn.innerHTML = html;
    btn.disabled = !done;
  }
  function resetButton(delay) {
    setTimeout(function () {
      var btn = document.getElementById('figma-export-btn');
      if (!btn) return;
      btn.innerHTML = '<i class="ti ti-brand-figma" aria-hidden="true"></i> <span>Export to Figma</span> <i class="ti ti-chevron-down" style="font-size:14px;color:#8fa397" aria-hidden="true"></i>';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.disabled = false;
    }, delay || 2200);
  }

  // ── Export current screen ──
  async function exportToFigma() {
    setButtonState('<i class="ti ti-loader-2 figma-spin" aria-hidden="true"></i> Exporting…', false);
    var noanim = freezeAnimations();
    try {
      var phone = getActivePhone();
      if (!phone) { alert('No .phone element found on this page.'); return; }

      await nextFrame();

      var fallbackName = 'Screen';
      var activeBtn = document.querySelector('.snb.active');
      if (activeBtn) fallbackName = activeBtn.textContent.trim();
      var screenName = screenDisplayName(phone, fallbackName);
      var pageTitle = document.title || 'M-PESA Screen';
      var containerRect = phone.getBoundingClientRect();

      var svgMap = await rasterizeVisibleSvgs(phone);
      var tree = serializeRoot(phone, containerRect, svgMap);

      var h2c = null;
      try { h2c = await loadHtml2Canvas(); } catch (e) { /* screenshot optional */ }
      var screenshot = await captureScreenshot(h2c, phone);

      downloadJson({
        version: 3,
        name: pageTitle + ' — ' + screenName,
        width: Math.round(containerRect.width),
        height: Math.round(containerRect.height),
        screenshot: screenshot,
        tokens: collectColorTokens(),
        tree: tree,
        exportedAt: new Date().toISOString(),
        sourceUrl: window.location.href
      }, (screenName.replace(/[^a-zA-Z0-9]/g, '_') || 'screen') + '.figma-export.json');

      setButtonState('<i class="ti ti-check" aria-hidden="true"></i> Exported!', true);
      var btn = document.getElementById('figma-export-btn');
      if (btn) { btn.style.borderColor = '#00A650'; btn.style.color = '#00A650'; }
      resetButton();
    } catch (err) {
      console.error('Figma export failed:', err);
      alert('Export failed: ' + err.message);
      resetButton(0);
    } finally {
      unfreezeAnimations(noanim);
    }
  }

  // ── Export ALL screens ──
  async function exportAllScreens() {
    setButtonState('<i class="ti ti-loader-2 figma-spin" aria-hidden="true"></i> Exporting all…', false);
    var noanim = freezeAnimations();
    var originalActive = null;
    var screens = null;
    try {
      screens = document.querySelectorAll(SCREEN_SEL);
      if (screens.length === 0) { await exportToFigma(); return; }

      var allNavBtns = document.querySelectorAll('.snb');
      var allExports = [];
      var pageTitle = document.title || 'M-PESA';
      var h2c = null;
      try { h2c = await loadHtml2Canvas(); } catch (e) { /* screenshot optional */ }

      originalActive = document.querySelector('.screen.active, .sc.active');

      for (var i = 0; i < screens.length; i++) {
        // every screen carries its own phone mockup — skip placeholders without one
        var phone = screens[i].querySelector(PHONE_SEL);
        if (!phone) continue;

        screens.forEach(function (s) { s.classList.remove('active'); });
        screens[i].classList.add('active');

        await nextFrame();

        var fallbackName = allNavBtns[i] ? allNavBtns[i].textContent.trim() : 'Screen ' + (i + 1);
        var screenName = screenDisplayName(phone, fallbackName);
        var containerRect = phone.getBoundingClientRect();

        var svgMap = await rasterizeVisibleSvgs(phone);
        var tree = serializeRoot(phone, containerRect, svgMap);
        var screenshot = await captureScreenshot(h2c, phone);

        allExports.push({
          name: screenName,
          width: Math.round(containerRect.width),
          height: Math.round(containerRect.height),
          screenshot: screenshot,
          tree: tree
        });

        setButtonState('<i class="ti ti-loader-2 figma-spin" aria-hidden="true"></i> ' + (i + 1) + '/' + screens.length + '…', false);
      }

      downloadJson({
        version: 3,
        type: 'multi-screen',
        name: pageTitle,
        tokens: collectColorTokens(),
        screens: allExports,
        exportedAt: new Date().toISOString(),
        sourceUrl: window.location.href
      }, pageTitle.replace(/[^a-zA-Z0-9]/g, '_') + '_all.figma-export.json');

      setButtonState('<i class="ti ti-check" aria-hidden="true"></i> ' + allExports.length + ' screens exported!', true);
      var btn = document.getElementById('figma-export-btn');
      if (btn) { btn.style.borderColor = '#00A650'; btn.style.color = '#00A650'; }
      resetButton(2500);
    } catch (err) {
      console.error('Export all failed:', err);
      alert('Export failed: ' + err.message);
      resetButton(0);
    } finally {
      if (originalActive && screens) {
        screens.forEach(function (s) { s.classList.remove('active'); });
        originalActive.classList.add('active');
      }
      unfreezeAnimations(noanim);
    }
  }

  // ── Inject button + styles ──
  function injectExportButton() {
    // The button's icons are Tabler glyphs — load the webfont on pages that
    // don't already include it (e.g. the Lehulum screens, which use Lucide).
    if (!document.querySelector('link[href*="tabler-icons"]')) {
      var tl = document.createElement('link');
      tl.rel = 'stylesheet';
      tl.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css';
      document.head.appendChild(tl);
    }

    var style = document.createElement('style');
    style.textContent = [
      '.figma-export-wrap{position:fixed;top:18px;right:340px;z-index:80;font-family:var(--font-sans,Barlow,sans-serif);display:flex;gap:6px}',
      '.figma-export-btn{display:flex;align-items:center;gap:6px;background:#fff;border:0.5px solid #e2e8e4;border-radius:10px;padding:8px 12px;font-size:12px;font-weight:600;color:#2a3530;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.07);transition:border-color .14s,color .14s;font-family:inherit;white-space:nowrap}',
      '.figma-export-btn:hover{border-color:#a259ff;color:#a259ff}',
      '.figma-export-btn:disabled{opacity:.7;cursor:wait}',
      '.figma-export-btn>i:first-child{font-size:15px;color:#a259ff}',
      '.figma-export-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:200px;background:#fff;border:0.5px solid #e2e8e4;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);overflow:hidden;opacity:0;transform:scale(.96) translateY(-6px);transform-origin:top right;transition:opacity .15s,transform .15s;pointer-events:none}',
      '.figma-export-wrap.open .figma-export-menu{opacity:1;transform:scale(1) translateY(0);pointer-events:all}',
      '.figma-export-option{display:flex;align-items:center;gap:10px;padding:11px 14px;font-size:13px;color:#2a3530;cursor:pointer;text-decoration:none;transition:background .12s;border:none;background:none;width:100%;font-family:inherit;font-weight:500}',
      '.figma-export-option:hover{background:#f4f6f5}',
      '.figma-export-option+.figma-export-option{border-top:0.5px solid #eef1ef}',
      '.figma-export-option i{font-size:16px;color:#5b6e62}',
      '@keyframes figma-spin{to{transform:rotate(360deg)}}',
      '.figma-spin{animation:figma-spin .8s linear infinite !important}'
    ].join('\n');
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'figma-export-wrap';
    // Lehulum screens are a centered phone with no side panel — pin the button
    // to the true top-right instead of the main app's 340px offset.
    if (document.querySelector('.phone-frame')) {
      wrap.style.top = '20px';
      wrap.style.right = '20px';
    }
    wrap.innerHTML = [
      '<button class="figma-export-btn" id="figma-export-btn" onclick="this.parentNode.classList.toggle(\'open\')">',
      '  <i class="ti ti-brand-figma" aria-hidden="true"></i>',
      '  <span>Export to Figma</span>',
      '  <i class="ti ti-chevron-down" style="font-size:14px;color:#8fa397;transition:transform .15s" aria-hidden="true"></i>',
      '</button>',
      '<div class="figma-export-menu">',
      '  <button class="figma-export-option" id="figma-export-current"><i class="ti ti-artboard" aria-hidden="true"></i> Current screen</button>',
      '  <button class="figma-export-option" id="figma-export-all"><i class="ti ti-layers-intersect" aria-hidden="true"></i> All screens</button>',
      '</div>'
    ].join('\n');
    document.body.appendChild(wrap);

    document.getElementById('figma-export-current').addEventListener('click', function () {
      wrap.classList.remove('open');
      exportToFigma();
    });
    document.getElementById('figma-export-all').addEventListener('click', function () {
      wrap.classList.remove('open');
      exportAllScreens();
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) wrap.classList.remove('open');
    });

    // debug hook (used by automated verification)
    window.__figmaSerializeDebug = function (screenIndex) {
      var phone;
      if (typeof screenIndex === 'number') {
        var screens = document.querySelectorAll(SCREEN_SEL);
        if (screens[screenIndex]) phone = screens[screenIndex].querySelector(PHONE_SEL);
      }
      if (!phone) phone = getActivePhone();
      if (!phone) return null;
      var noanim = freezeAnimations();
      var tree = serializeRoot(phone, phone.getBoundingClientRect(), null);
      unfreezeAnimations(noanim);
      return tree;
    };
  }

  // Init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectExportButton);
  } else {
    injectExportButton();
  }
})();
