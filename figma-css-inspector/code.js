// CSS Inspector — reads the current selection and emits CSS text to copy.
// Direction is the opposite of the HTML-import plugin: Figma node -> CSS.

figma.showUI(__html__, { width: 440, height: 600, themeColors: true });

// Hard cap so selecting a whole screen frame can't dump thousands of rules.
var MAX_NODES = 400;

var state = {
  includeChildren: true
};

// Push CSS for the current selection whenever it changes (and once on launch).
figma.on('selectionchange', sendSelection);
sendSelection();

figma.ui.onmessage = function (msg) {
  if (msg.type === 'options') {
    state.includeChildren = !!msg.includeChildren;
    sendSelection();
  }
  if (msg.type === 'refresh') sendSelection();
  if (msg.type === 'close') figma.closePlugin();
};

function sendSelection() {
  var nodes = figma.currentPage.selection;
  if (!nodes || nodes.length === 0) {
    figma.ui.postMessage({ type: 'selection', blocks: [], includeChildren: state.includeChildren });
    return;
  }

  var used = {};               // keeps every selector unique within one render
  var counter = { n: 0 };      // total nodes visited, for the MAX_NODES cap
  var blocks = [];

  // Walk each selected root in order, sharing the unique-name + counter state.
  var chain = Promise.resolve();
  for (var i = 0; i < nodes.length; i++) {
    (function (root) {
      chain = chain.then(function () {
        return walkNode(root, 0, '', used, counter, blocks);
      });
    })(nodes[i]);
  }

  chain.then(function () {
    figma.ui.postMessage({
      type: 'selection',
      blocks: blocks,
      includeChildren: state.includeChildren,
      truncated: counter.n >= MAX_NODES
    });
  });
}

// Depth-first walk: emit a block for `node`, then recurse into its children.
function walkNode(node, depth, parentPath, used, counter, blocks) {
  if (!node || node.visible === false) return Promise.resolve();
  if (counter.n >= MAX_NODES) return Promise.resolve();
  counter.n++;

  var selector = '.' + uniqueName(node.name || node.type, used);
  var path = parentPath ? parentPath + ' / ' + node.name : node.name;

  return cssForNode(node).then(function (props) {
    blocks.push({
      header: node.name + '  (' + node.type + ')',
      path: path,
      selector: selector,
      props: props,
      depth: depth
    });

    if (!state.includeChildren) return;
    var kids = node.children;
    if (!kids || !kids.length) return;

    var chain = Promise.resolve();
    for (var i = 0; i < kids.length; i++) {
      (function (child) {
        chain = chain.then(function () {
          return walkNode(child, depth + 1, path, used, counter, blocks);
        });
      })(kids[i]);
    }
    return chain;
  });
}

// Figma's own engine produces the most accurate CSS (same as Dev Mode).
// Fall back to a manual extractor if the API method is unavailable.
function cssForNode(node) {
  if (typeof node.getCSSAsync === 'function') {
    return node.getCSSAsync().then(function (cssObj) {
      return cssObjectToLines(cssObj);
    }).catch(function () {
      return extractManual(node);
    });
  }
  return Promise.resolve(extractManual(node));
}

function uniqueName(name, used) {
  var base = sanitizeSelector(name);
  var out = base;
  var n = 2;
  while (used[out]) { out = base + '-' + n; n++; }
  used[out] = true;
  return out;
}

// ---- Format helpers --------------------------------------------------------

function cssObjectToLines(cssObj) {
  var lines = [];
  for (var key in cssObj) {
    if (Object.prototype.hasOwnProperty.call(cssObj, key)) {
      var value = String(cssObj[key]).replace(/;\s*$/, '');
      lines.push(key + ': ' + value + ';');
    }
  }
  return lines;
}

function sanitizeSelector(name) {
  var s = String(name).trim().toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'element';
  if (/^[0-9]/.test(s)) s = 'el-' + s;
  return s;
}

// ---- Manual fallback extractor --------------------------------------------

function round(n) {
  return Math.round(n * 100) / 100;
}

function px(n) {
  return round(n) + 'px';
}

function hex2(n) {
  var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
  return h.length === 1 ? '0' + h : h;
}

function colorToCss(color, opacity) {
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = opacity === undefined ? (color.a === undefined ? 1 : color.a) : opacity;
  if (a >= 1) return '#' + hex2(r) + hex2(g) + hex2(b);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + round(a) + ')';
}

function gradientToCss(fill) {
  var stops = fill.gradientStops || [];
  var parts = [];
  for (var i = 0; i < stops.length; i++) {
    var s = stops[i];
    parts.push(colorToCss(s.color, s.color.a) + ' ' + Math.round(s.position * 100) + '%');
  }
  var fn = fill.type === 'GRADIENT_RADIAL' ? 'radial-gradient' : 'linear-gradient';
  return fn + '(' + parts.join(', ') + ')';
}

function extractManual(node) {
  var props = [];

  if ('width' in node && 'height' in node) {
    props.push('width: ' + px(node.width) + ';');
    props.push('height: ' + px(node.height) + ';');
  }

  if (node.opacity !== undefined && node.opacity < 1) {
    props.push('opacity: ' + round(node.opacity) + ';');
  }

  // Auto layout -> flexbox
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    props.push('display: flex;');
    props.push('flex-direction: ' + (node.layoutMode === 'HORIZONTAL' ? 'row' : 'column') + ';');
    if (node.itemSpacing) props.push('gap: ' + px(node.itemSpacing) + ';');
    var pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
    if (pad[0] || pad[1] || pad[2] || pad[3]) {
      props.push('padding: ' + pad.map(px).join(' ') + ';');
    }
    var justifyMap = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
    var alignMap = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
    if (node.primaryAxisAlignItems) props.push('justify-content: ' + (justifyMap[node.primaryAxisAlignItems] || 'flex-start') + ';');
    if (node.counterAxisAlignItems) props.push('align-items: ' + (alignMap[node.counterAxisAlignItems] || 'flex-start') + ';');
  }

  // Fills -> background / color
  var fills = node.fills;
  if (fills && fills !== figma.mixed && fills.length) {
    var visible = [];
    for (var i = 0; i < fills.length; i++) {
      var f = fills[i];
      if (f.visible === false) continue;
      if (f.type === 'SOLID') visible.push(colorToCss(f.color, f.opacity));
      else if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') visible.push(gradientToCss(f));
      else if (f.type === 'IMAGE') visible.push('url(<image>)');
    }
    if (visible.length) {
      var prop = node.type === 'TEXT' ? 'color' : 'background';
      props.push(prop + ': ' + visible.join(', ') + ';');
    }
  }

  // Strokes -> border
  if (node.strokes && node.strokes.length) {
    var sw = (node.strokeWeight && node.strokeWeight !== figma.mixed) ? node.strokeWeight : 1;
    var sc = node.strokes[0].type === 'SOLID' ? colorToCss(node.strokes[0].color, node.strokes[0].opacity) : '#000';
    props.push('border: ' + px(sw) + ' solid ' + sc + ';');
  }

  // Corner radius
  if (node.cornerRadius !== undefined && node.cornerRadius !== figma.mixed) {
    if (node.cornerRadius) props.push('border-radius: ' + px(node.cornerRadius) + ';');
  } else if (node.topLeftRadius !== undefined) {
    var radii = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
    if (radii[0] || radii[1] || radii[2] || radii[3]) {
      props.push('border-radius: ' + radii.map(px).join(' ') + ';');
    }
  }

  // Effects -> box-shadow / filter
  if (node.effects && node.effects.length) {
    var shadows = [];
    for (var e = 0; e < node.effects.length; e++) {
      var ef = node.effects[e];
      if (ef.visible === false) continue;
      if (ef.type === 'DROP_SHADOW' || ef.type === 'INNER_SHADOW') {
        var inset = ef.type === 'INNER_SHADOW' ? 'inset ' : '';
        shadows.push(inset + px(ef.offset.x) + ' ' + px(ef.offset.y) + ' ' + px(ef.radius) +
          ' ' + px(ef.spread || 0) + ' ' + colorToCss(ef.color, ef.color.a));
      } else if (ef.type === 'LAYER_BLUR') {
        props.push('filter: blur(' + px(ef.radius) + ');');
      } else if (ef.type === 'BACKGROUND_BLUR') {
        props.push('backdrop-filter: blur(' + px(ef.radius) + ');');
      }
    }
    if (shadows.length) props.push('box-shadow: ' + shadows.join(', ') + ';');
  }

  // Rotation
  if (node.rotation) props.push('transform: rotate(' + round(-node.rotation) + 'deg);');

  // Text properties
  if (node.type === 'TEXT') {
    if (node.fontName && node.fontName !== figma.mixed) {
      props.push('font-family: "' + node.fontName.family + '";');
      props.push('font-style: ' + styleToCss(node.fontName.style) + ';');
    }
    if (node.fontSize && node.fontSize !== figma.mixed) props.push('font-size: ' + px(node.fontSize) + ';');
    if (node.fontWeight && node.fontWeight !== figma.mixed) props.push('font-weight: ' + node.fontWeight + ';');
    if (node.lineHeight && node.lineHeight !== figma.mixed && node.lineHeight.unit !== 'AUTO') {
      props.push('line-height: ' + (node.lineHeight.unit === 'PERCENT' ? node.lineHeight.value + '%' : px(node.lineHeight.value)) + ';');
    }
    if (node.letterSpacing && node.letterSpacing !== figma.mixed && node.letterSpacing.value) {
      props.push('letter-spacing: ' + (node.letterSpacing.unit === 'PERCENT' ? round(node.letterSpacing.value / 100 * (node.fontSize || 16)) + 'px' : px(node.letterSpacing.value)) + ';');
    }
    if (node.textAlignHorizontal) {
      props.push('text-align: ' + node.textAlignHorizontal.toLowerCase() + ';');
    }
    if (node.textCase && node.textCase !== 'ORIGINAL') {
      var caseMap = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
      if (caseMap[node.textCase]) props.push('text-transform: ' + caseMap[node.textCase] + ';');
    }
    if (node.textDecoration === 'UNDERLINE') props.push('text-decoration: underline;');
    if (node.textDecoration === 'STRIKETHROUGH') props.push('text-decoration: line-through;');
  }

  return props;
}

function styleToCss(style) {
  return /italic/i.test(style) ? 'italic' : 'normal';
}
