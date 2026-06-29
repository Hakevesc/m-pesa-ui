figma.showUI(__html__, { width: 440, height: 640, themeColors: true });

// ── Per-import run state (reset on each import) ──
var RUN = freshRun();
function freshRun() {
  return {
    mode: 'design',        // 'library' | 'design'
    autoRegister: true,    // build + register a master when no match is found
    bindVariables: false,  // Tier 3: bind matching fills to colour variables
    builtThisRun: {},      // key -> ComponentNode (within-run dedup)
    libraryBuilt: [],      // { key, name, variantProp, value, overrides, component }
    pendingMasters: [],    // auto-registered masters waiting to be filed
    tokens: null,          // [{ name, value, color }]
    varMap: null           // hex -> Variable (Tier 3)
  };
}
function resetRun(msg) {
  var o = msg.options || {};
  RUN = freshRun();
  RUN.mode = msg.mode === 'library' ? 'library' : 'design';
  RUN.autoRegister = o.autoRegister !== false;
  RUN.bindVariables = !!o.bindVariables;
  RUN.tokens = (msg.data && msg.data.tokens) || null;
}

// ── Persistent component registry: key ("Button/Primary") -> master node id ──
var REGISTRY_KEY = 'mpesaComponents';
function loadRegistry() {
  try { return JSON.parse(figma.root.getPluginData(REGISTRY_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveRegistry(map) {
  figma.root.setPluginData(REGISTRY_KEY, JSON.stringify(map));
}
// Resolve a key to a live master, preferring masters built earlier this run.
function resolveMaster(key) {
  if (RUN.builtThisRun[key]) return Promise.resolve(RUN.builtThisRun[key]);
  var id = loadRegistry()[key];
  if (!id) return Promise.resolve(null);
  return figma.getNodeByIdAsync(id).then(function (node) {
    if (!node || node.removed) return null;
    return (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') ? node : null;
  }).catch(function () { return null; });
}
function sendRegistryCount() {
  var map = loadRegistry();
  var ids = {}, keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) ids[map[keys[i]]] = 1;
  figma.ui.postMessage({ type: 'registry', masters: Object.keys(ids).length, entries: keys.length });
}

sendRegistryCount();

figma.ui.onmessage = function (msg) {
  if (msg.type === 'getRegistry') { sendRegistryCount(); return; }
  if (msg.type === 'clearRegistry') {
    saveRegistry({});
    sendRegistryCount();
    figma.notify('Component registry cleared');
    return;
  }
  if (msg.type === 'cancel') { figma.closePlugin(); return; }
  if (msg.type !== 'import') return;

  resetRun(msg);
  var data = msg.data;
  // Build the colour-variable map first (when enabled) so masters in either
  // mode can bind their fills as they're created.
  var setup = RUN.bindVariables ? ensureTokenCollection() : Promise.resolve();
  var promise = setup.then(function () {
    if (RUN.mode === 'library') return buildLibrary(data);
    if (data.type === 'multi-screen' && data.screens) return importMultipleScreens(data).then(finalizeDesignMasters);
    return importSingleScreen(data).then(finalizeDesignMasters);
  });

  promise.then(function (result) {
    var note = RUN.mode === 'library'
      ? ('Library built — ' + ((result && result.count) || 0) + ' components')
      : 'Import complete!';
    figma.notify(note, { timeout: 3000 });
    sendRegistryCount();
    figma.ui.postMessage({ type: 'done', mode: RUN.mode, summary: result || null });
  }).catch(function (err) {
    figma.notify('Failed: ' + err.message, { error: true });
    figma.ui.postMessage({ type: 'error', message: err.message });
  });
};

function importMultipleScreens(data) {
  var spacing = 80;
  var xOffset = 0;
  var chain = Promise.resolve();
  var screenCount = data.screens.length;
  for (var i = 0; i < screenCount; i++) {
    (function (screen, x) {
      chain = chain.then(function () {
        return buildScreenFrame(screen, x).then(function (frame) {
          figma.currentPage.appendChild(frame);
        });
      });
    })(data.screens[i], xOffset);
    xOffset += (data.screens[i].width || 375) + spacing;
  }
  return chain.then(function () {
    var children = figma.currentPage.children;
    var allFrames = children.slice(children.length - screenCount);
    figma.viewport.scrollAndZoomIntoView(allFrames);
  });
}

function importSingleScreen(data) {
  return buildScreenFrame(data, 0).then(function (frame) {
    figma.currentPage.appendChild(frame);
    figma.viewport.scrollAndZoomIntoView([frame]);
  });
}

function buildScreenFrame(screenData, xPos) {
  var frame = figma.createFrame();
  frame.name = screenData.name || 'Imported Screen';
  frame.resize(screenData.width || 375, screenData.height || 812);
  frame.x = xPos;
  frame.y = 0;
  frame.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.98 } }];
  frame.clipsContent = true;
  frame.cornerRadius = 40;

  if (screenData.screenshot) {
    var refFrame = figma.createFrame();
    refFrame.name = 'Screenshot Reference';
    refFrame.resize(screenData.width, screenData.height);
    refFrame.x = 0;
    refFrame.y = 0;
    refFrame.opacity = 0.15;
    refFrame.locked = true;
    try {
      var base64Data = screenData.screenshot.split(',')[1];
      var imgBytes = figma.base64Decode(base64Data);
      var img = figma.createImage(imgBytes);
      refFrame.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
    } catch (e) { /* skip screenshot layer */ }
    frame.appendChild(refFrame);
  }

  if (screenData.tree) {
    return renderNode(screenData.tree, frame).then(function () {
      return frame;
    });
  }

  return Promise.resolve(frame);
}

var loadedFonts = {};
function ensureFont(family, style) {
  var key = family + '::' + style;
  if (loadedFonts[key]) return Promise.resolve(true);
  return figma.loadFontAsync({ family: family, style: style }).then(function () {
    loadedFonts[key] = true;
    return true;
  }).catch(function () {
    if (family !== 'Inter') {
      return figma.loadFontAsync({ family: 'Inter', style: style }).then(function () {
        loadedFonts['Inter::' + style] = true;
        return true;
      }).catch(function () {
        return figma.loadFontAsync({ family: 'Inter', style: 'Regular' }).then(function () {
          loadedFonts['Inter::Regular'] = true;
          return true;
        });
      });
    }
    return false;
  });
}

function figmaColor(c) {
  if (!c) return { r: 0, g: 0, b: 0 };
  return {
    r: Math.max(0, Math.min(1, c.r)),
    g: Math.max(0, Math.min(1, c.g)),
    b: Math.max(0, Math.min(1, c.b))
  };
}

function figmaRGBA(c) {
  var rgb = figmaColor(c);
  var a = (c && c.a !== undefined) ? c.a : 1;
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: a };
}

function figmaOpacity(c) {
  return (c && c.a !== undefined) ? c.a : 1;
}

function mapWeightToStyle(weight) {
  if (weight >= 800) return 'ExtraBold';
  if (weight >= 700) return 'Bold';
  if (weight >= 600) return 'SemiBold';
  if (weight >= 500) return 'Medium';
  if (weight >= 300) return 'Light';
  return 'Regular';
}

function buildFills(nodeData) {
  var fills = [];
  var rawFills = nodeData.fills || [];
  for (var i = 0; i < rawFills.length; i++) {
    var f = rawFills[i];
    if (f.type === 'SOLID' && f.color) {
      fills.push({
        type: 'SOLID',
        color: figmaColor(f.color),
        opacity: figmaOpacity(f.color)
      });
    } else if (f.type === 'GRADIENT_LINEAR' && f.gradientStops) {
      var stops = [];
      for (var j = 0; j < f.gradientStops.length; j++) {
        var s = f.gradientStops[j];
        stops.push({
          position: s.position,
          color: figmaRGBA(s.color)
        });
      }
      fills.push({
        type: 'GRADIENT_LINEAR',
        gradientTransform: gradientTransformFromHandles(f.gradientHandlePositions),
        gradientStops: stops
      });
    }
  }
  return fills;
}

function gradientTransformFromHandles(handles) {
  // Figma's gradientTransform maps normalized object space to gradient space:
  // t = (T * p).x must be 0 at the start handle and 1 at the end handle.
  if (!handles || handles.length < 2) return [[1, 0, 0], [0, 1, 0]];
  var a = handles[0], b = handles[1];
  var dx = b.x - a.x, dy = b.y - a.y;
  var L2 = dx * dx + dy * dy;
  if (L2 < 1e-6) return [[1, 0, 0], [0, 1, 0]];
  return [
    [dx / L2, dy / L2, -(a.x * dx + a.y * dy) / L2],
    [-dy / L2, dx / L2, (a.x * dy - a.y * dx) / L2]
  ];
}

function buildStrokes(nodeData) {
  var strokes = [];
  var rawStrokes = nodeData.strokes || [];
  for (var i = 0; i < rawStrokes.length; i++) {
    var s = rawStrokes[i];
    if (s.color) {
      strokes.push({
        type: 'SOLID',
        color: figmaColor(s.color),
        opacity: figmaOpacity(s.color)
      });
    }
  }
  return strokes;
}

function buildEffects(nodeData) {
  var effects = [];
  var rawEffects = nodeData.effects || [];
  for (var i = 0; i < rawEffects.length; i++) {
    var e = rawEffects[i];
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      var offset = e.offset || {};
      effects.push({
        type: e.type,
        color: figmaRGBA(e.color),
        offset: { x: offset.x || 0, y: offset.y || 0 },
        radius: e.radius || 0,
        spread: e.spread || 0,
        visible: true,
        blendMode: 'NORMAL'
      });
    }
  }
  return effects;
}

function applyAutoLayout(frame, al) {
  frame.layoutMode = al.direction === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
  frame.itemSpacing = al.itemSpacing || 0;
  frame.paddingTop = al.paddingTop || 0;
  frame.paddingRight = al.paddingRight || 0;
  frame.paddingBottom = al.paddingBottom || 0;
  frame.paddingLeft = al.paddingLeft || 0;
  frame.primaryAxisAlignItems = al.primaryAlign || 'MIN';
  frame.counterAxisAlignItems = al.counterAlign || 'MIN';
  if (al.wrap && frame.layoutMode === 'HORIZONTAL') {
    frame.layoutWrap = 'WRAP';
    frame.counterAxisSpacing = al.itemSpacing || 0;
  }
}

// Apply every visual property (auto layout, size, fills, strokes, effects,
// radius, opacity, clip) to a container. Works for both FrameNode and
// ComponentNode. Returns the auto-layout config (or null) so the caller knows
// whether children flow. Does NOT set x/y or append — the caller owns that.
function decorateContainer(container, nodeData) {
  var al = nodeData.autoLayout;
  if (al) {
    try { applyAutoLayout(container, al); } catch (e) { al = null; }
  }

  container.resize(Math.max(1, nodeData.w || 1), Math.max(1, nodeData.h || 1));

  var fills = buildFills(nodeData);
  container.fills = fills.length ? fills : [];

  if (nodeData.imageData) {
    try {
      var imgBytes = figma.base64Decode(nodeData.imageData.split(',')[1]);
      var img = figma.createImage(imgBytes);
      container.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FIT' }];
    } catch (e) { /* keep plain fills */ }
  }

  var strokes = buildStrokes(nodeData);
  if (strokes.length) {
    container.strokes = strokes;
    container.strokeWeight = (nodeData.strokes && nodeData.strokes[0]) ? nodeData.strokes[0].weight || 1 : 1;
    container.strokeAlign = 'INSIDE'; // CSS borders draw inside the border-box
  }

  var effects = buildEffects(nodeData);
  if (effects.length) container.effects = effects;

  if (nodeData.cornerRadius) {
    var cr = nodeData.cornerRadius;
    if (Array.isArray(cr)) {
      container.topLeftRadius = cr[0] || 0;
      container.topRightRadius = cr[1] || 0;
      container.bottomRightRadius = cr[2] || 0;
      container.bottomLeftRadius = cr[3] || 0;
    } else {
      container.cornerRadius = cr;
    }
  }

  if (nodeData.opacity !== undefined && nodeData.opacity < 1) {
    container.opacity = nodeData.opacity;
  }
  container.clipsContent = !!nodeData.clipsContent;

  return al;
}

// children flagged absolute (CSS position:absolute/fixed) stay pinned at their
// coordinates instead of flowing in the parent's auto layout
function positionAbsolute(node, nodeData, parentIsAutoLayout) {
  if (parentIsAutoLayout && nodeData.absolute) {
    try {
      node.layoutPositioning = 'ABSOLUTE';
      node.x = nodeData.x || 0;
      node.y = nodeData.y || 0;
    } catch (e) { /* parent may not support it */ }
  }
}

function renderChildren(container, children, hasAutoLayout, plain) {
  children = children || [];
  var chain = Promise.resolve();
  for (var i = 0; i < children.length; i++) {
    (function (child) {
      chain = chain.then(function () {
        return plain ? renderPlainNode(child, container, hasAutoLayout)
                     : renderNode(child, container, hasAutoLayout);
      });
    })(children[i]);
  }
  return chain;
}

// Build a node as a plain frame, ignoring any component tag (used for component
// internals and for the no-match fallback).
function renderPlainFrame(nodeData, parent, parentIsAutoLayout, plain) {
  var frame = figma.createFrame();
  frame.name = nodeData.name || 'frame';
  var al = decorateContainer(frame, nodeData);
  frame.x = nodeData.x || 0;
  frame.y = nodeData.y || 0;
  parent.appendChild(frame);
  positionAbsolute(frame, nodeData, parentIsAutoLayout);
  return renderChildren(frame, nodeData.children, !!al, plain);
}

function renderPlainNode(nodeData, parent, parentIsAutoLayout) {
  if (!nodeData) return Promise.resolve();
  if (nodeData.type === 'TEXT') return renderTextNode(nodeData, parent);
  return renderPlainFrame(nodeData, parent, parentIsAutoLayout, true);
}

// Top-level renderer used for design imports. Component-tagged nodes become
// instances of a matching master (or a fallback frame); everything else is a
// plain frame whose children may themselves be components.
function renderNode(nodeData, parent, parentIsAutoLayout) {
  if (!nodeData) return Promise.resolve();
  if (nodeData.type === 'TEXT') return renderTextNode(nodeData, parent);
  if (nodeData.component) return renderComponentInDesign(nodeData, parent, parentIsAutoLayout);
  return renderPlainFrame(nodeData, parent, parentIsAutoLayout, false);
}

// ── Component building & instancing ──────────────────────────────────────────

// Build a component master from a serialized subtree. Internals are plain
// frames so nested components aren't separately instanced inside a master.
function buildComponent(nodeData) {
  var component = figma.createComponent();
  component.name = (nodeData.component && nodeData.component.name) || nodeData.name || 'Component';
  var al = decorateContainer(component, nodeData);
  return renderChildren(component, nodeData.children, !!al, true).then(function () {
    if (RUN.bindVariables) { try { bindFillsToVariables(component); } catch (e) { /* optional */ } }
    return component;
  });
}

// Design-mode handler for a component-tagged node.
function renderComponentInDesign(nodeData, parent, parentIsAutoLayout) {
  var comp = nodeData.component;
  return resolveMaster(comp.key).then(function (master) {
    if (master) return placeInstance(master, nodeData, parent, parentIsAutoLayout);

    // No match → first occurrence renders as a plain frame...
    return renderPlainFrame(nodeData, parent, parentIsAutoLayout, false).then(function () {
      if (!RUN.autoRegister) return;
      // ...and we build a master so later occurrences (this run or future runs)
      // become instances.
      return buildComponent(nodeData).then(function (master2) {
        RUN.builtThisRun[comp.key] = master2;
        RUN.pendingMasters.push({
          key: comp.key, name: comp.name, variantProp: comp.variantProp,
          value: comp.value, overrides: nodeData.overrides, component: master2
        });
      });
    });
  });
}

function pickVariant(set, prop, value) {
  var want = (prop + '=' + value).toLowerCase();
  var kids = set.children;
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].type !== 'COMPONENT') continue;
    var nm = (kids[i].name || '').toLowerCase();
    if (nm === want || nm.indexOf(prop.toLowerCase() + '=' + value.toLowerCase()) !== -1) return kids[i];
  }
  return null;
}

function placeInstance(master, nodeData, parent, parentIsAutoLayout) {
  var comp = nodeData.component;
  var instance;
  if (master.type === 'COMPONENT_SET') {
    var target = pickVariant(master, comp.variantProp, comp.value) || master.defaultVariant;
    instance = target.createInstance();
  } else {
    instance = master.createInstance();
  }
  instance.name = comp.name;
  try {
    instance.resize(Math.max(1, nodeData.w || instance.width), Math.max(1, nodeData.h || instance.height));
  } catch (e) { /* hug-sized instances may refuse a resize */ }
  instance.x = nodeData.x || 0;
  instance.y = nodeData.y || 0;
  parent.appendChild(instance);
  positionAbsolute(instance, nodeData, parentIsAutoLayout);
  return applyInstanceOverrides(instance, nodeData);
}

function findPropName(defs, base) {
  var keys = Object.keys(defs || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].split('#')[0] === base) return keys[i];
  }
  return null;
}

function applyInstanceOverrides(instance, nodeData) {
  var ov = nodeData.overrides;
  if (!ov) return Promise.resolve();

  var defs = instance.componentProperties || {};
  var labelProp = findPropName(defs, 'Label');
  var iconProp = findPropName(defs, 'hasIcon');
  var props = {};
  if (labelProp && ov.label != null) props[labelProp] = String(ov.label);
  if (iconProp) props[iconProp] = !!ov.hasIcon;
  if (Object.keys(props).length) {
    try { instance.setProperties(props); } catch (e) { /* ignore */ }
  }

  // No Label property (e.g. variant set) → write the first text node directly.
  if (ov.label != null && !labelProp) return setFirstText(instance, ov.label);
  return Promise.resolve();
}

function setFirstText(node, text) {
  var t = node.findOne ? node.findOne(function (n) { return n.type === 'TEXT'; }) : null;
  if (!t || t.fontName === figma.mixed) return Promise.resolve();
  return figma.loadFontAsync(t.fontName).then(function () { t.characters = String(text); }).catch(function () {});
}

// Expose editable Label (text) and hasIcon (visibility) properties on a
// standalone master. Skipped for variant sets to keep combineAsVariants happy.
function addElementProps(component, overrides) {
  if (!overrides) return;
  try {
    if (overrides.label != null) {
      var textNode = component.findOne(function (n) { return n.type === 'TEXT'; });
      if (textNode) {
        var pid = component.addComponentProperty('Label', 'TEXT', String(overrides.label));
        textNode.componentPropertyReferences = { characters: pid };
      }
    }
  } catch (e) { /* property may already exist */ }
  try {
    var iconNode = component.findOne(function (n) { return /^icon/i.test(n.name || ''); });
    if (iconNode) {
      var bid = component.addComponentProperty('hasIcon', 'BOOLEAN', true);
      iconNode.componentPropertyReferences = { visible: bid };
    }
  } catch (e) { /* ignore */ }
}

// ── Library build (mode: 'library') ──────────────────────────────────────────

function buildLibrary(data) {
  var trees = [];
  if (data.type === 'multi-screen' && data.screens) {
    for (var i = 0; i < data.screens.length; i++) if (data.screens[i].tree) trees.push(data.screens[i].tree);
  } else if (data.tree) {
    trees.push(data.tree);
  }

  var chain = Promise.resolve();
  trees.forEach(function (tree) {
    chain = chain.then(function () { return collectComponents(tree); });
  });
  return chain.then(finalizeLibrary);
}

// DFS that builds a master for every component-tagged node (first variant wins),
// without rebuilding the surrounding showcase.
function collectComponents(nodeData) {
  if (!nodeData) return Promise.resolve();
  if (nodeData.component) {
    var key = nodeData.component.key;
    if (RUN.builtThisRun[key]) return Promise.resolve();
    return buildComponent(nodeData).then(function (component) {
      RUN.builtThisRun[key] = component;
      RUN.libraryBuilt.push({
        key: key, name: nodeData.component.name, variantProp: nodeData.component.variantProp,
        value: nodeData.component.value, overrides: nodeData.overrides, component: component
      });
    });
  }
  if (nodeData.type === 'TEXT') return Promise.resolve();
  var children = nodeData.children || [];
  var chain = Promise.resolve();
  for (var i = 0; i < children.length; i++) {
    (function (child) { chain = chain.then(function () { return collectComponents(child); }); })(children[i]);
  }
  return chain;
}

function finalizeLibrary() {
  return ensureComponentsPage().then(function (page) {
    var groups = {};
    RUN.libraryBuilt.forEach(function (item) {
      (groups[item.name] = groups[item.name] || []).push(item);
    });

    var registry = loadRegistry();
    var grid = newGrid(page);
    var names = Object.keys(groups);
    var placedNodes = [];

    for (var gi = 0; gi < names.length; gi++) {
      var items = groups[names[gi]];
      var placed;
      if (items.length > 1) {
        // Name each member "<Prop>=<Value>" and combine into a variant set.
        items.forEach(function (it) { it.component.name = it.variantProp + '=' + it.value; });
        var comps = items.map(function (it) { return it.component; });
        var set = figma.combineAsVariants(comps, figma.currentPage);
        set.name = names[gi];
        page.appendChild(set);
        items.forEach(function (it) { registry[it.key] = set.id; });
        placed = set;
      } else {
        var only = items[0];
        only.component.name = names[gi];
        addElementProps(only.component, only.overrides);
        page.appendChild(only.component);
        registry[only.key] = only.component.id;
        placed = only.component;
      }
      placeInGrid(grid, placed);
      placedNodes.push(placed);
    }

    saveRegistry(registry);

    // Surface the result: switch to the Components page and frame everything.
    return figma.setCurrentPageAsync(page).then(function () {
      try {
        if (placedNodes.length) {
          figma.currentPage.selection = placedNodes;
          figma.viewport.scrollAndZoomIntoView(placedNodes);
        }
      } catch (e) { /* viewport is best-effort */ }
      return { count: RUN.libraryBuilt.length, sets: names.length, page: page.name };
    });
  });
}

// Move auto-registered masters onto the Components page after a design import.
function finalizeDesignMasters() {
  if (!RUN.pendingMasters.length) return Promise.resolve(null);
  return ensureComponentsPage().then(function (page) {
    var registry = loadRegistry();
    var grid = newGrid(page);
    RUN.pendingMasters.forEach(function (item) {
      addElementProps(item.component, item.overrides);
      item.component.name = item.name + (item.value && item.value !== 'Default' ? ' / ' + item.value : '');
      page.appendChild(item.component);
      placeInGrid(grid, item.component);
      registry[item.key] = item.component.id;
    });
    saveRegistry(registry);
    return { registered: RUN.pendingMasters.length };
  });
}

function ensureComponentsPage() {
  var pages = figma.root.children;
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].name === 'Components') {
      var p = pages[i];
      return p.loadAsync ? p.loadAsync().then(function () { return p; }) : Promise.resolve(p);
    }
  }
  var page = figma.createPage();
  page.name = 'Components';
  return Promise.resolve(page);
}

function newGrid(page) { return { page: page, x: 0, y: 0, rowH: 0, max: 1200, gap: 56 }; }
function placeInGrid(g, node) {
  if (g.x > 0 && g.x + node.width > g.max) { g.x = 0; g.y += g.rowH + g.gap; g.rowH = 0; }
  node.x = g.x;
  node.y = g.y;
  g.x += node.width + g.gap;
  if (node.height > g.rowH) g.rowH = node.height;
}

// ── Tier 3: colour variables (only when bindVariables is on) ──────────────────

function hexOf(color) {
  function h(n) { var s = Math.max(0, Math.min(255, Math.round(n * 255))).toString(16); return s.length === 1 ? '0' + s : s; }
  return '#' + h(color.r) + h(color.g) + h(color.b);
}

function ensureTokenCollection() {
  if (!RUN.tokens || !RUN.tokens.length) return Promise.resolve();
  return figma.variables.getLocalVariableCollectionsAsync().then(function (cols) {
    var collection = null;
    for (var i = 0; i < cols.length; i++) if (cols[i].name === 'M-PESA Tokens') collection = cols[i];
    if (!collection) collection = figma.variables.createVariableCollection('M-PESA Tokens');
    var modeId = collection.modes[0].modeId;
    return figma.variables.getLocalVariablesAsync('COLOR').then(function (existing) {
      var byName = {};
      for (var j = 0; j < existing.length; j++) byName[existing[j].name] = existing[j];
      var map = {};
      RUN.tokens.forEach(function (tok) {
        var varName = tok.name.replace(/^--/, '').replace(/-/g, '/');
        var v = byName[varName];
        if (!v) {
          v = figma.variables.createVariable(varName, collection, 'COLOR');
          v.setValueForMode(modeId, { r: tok.color.r, g: tok.color.g, b: tok.color.b, a: tok.color.a === undefined ? 1 : tok.color.a });
        }
        map[hexOf(tok.color)] = v;
      });
      RUN.varMap = map;
    });
  }).catch(function () { /* variables unavailable — skip Tier 3 */ });
}

// Replace solid fills whose colour matches a token with a variable-bound paint.
function bindFillsToVariables(root) {
  if (!RUN.varMap) return;
  var nodes = [root];
  if (root.findAll) nodes = nodes.concat(root.findAll(function () { return true; }));
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var fills = node.fills;
    if (!fills || fills === figma.mixed || !fills.length) continue;
    var changed = false;
    var next = fills.slice();
    for (var f = 0; f < next.length; f++) {
      if (next[f].type !== 'SOLID') continue;
      var v = RUN.varMap[hexOf(next[f].color)];
      if (!v) continue;
      try { next[f] = figma.variables.setBoundVariableForPaint(next[f], 'color', v); changed = true; } catch (e) { /* skip */ }
    }
    if (changed) node.fills = next;
  }
}

function renderTextNode(nodeData, parent) {
  if (!nodeData.text) return Promise.resolve();

  var family = nodeData.fontFamily || 'Inter';
  var weight = nodeData.fontWeight || 400;
  var styleName = mapWeightToStyle(weight);

  return ensureFont(family, styleName).then(function (loaded) {
    var useFamily = (loaded && loadedFonts[family + '::' + styleName]) ? family : 'Inter';
    var useStyle = loadedFonts[useFamily + '::' + styleName] ? styleName : 'Regular';

    var text = figma.createText();
    text.name = nodeData.name || 'text';
    text.fontName = { family: useFamily, style: useStyle };
    text.characters = nodeData.text;
    text.fontSize = nodeData.fontSize || 14;

    if (nodeData.color) {
      text.fills = [{ type: 'SOLID', color: figmaColor(nodeData.color), opacity: figmaOpacity(nodeData.color) }];
    }

    if (nodeData.letterSpacing) {
      text.letterSpacing = { value: nodeData.letterSpacing, unit: 'PIXELS' };
    }
    if (nodeData.lineHeight) {
      text.lineHeight = { value: nodeData.lineHeight, unit: 'PIXELS' };
    }
    if (nodeData.textAlign) {
      var alignMap = { LEFT: 'LEFT', CENTER: 'CENTER', RIGHT: 'RIGHT', JUSTIFIED: 'JUSTIFIED' };
      text.textAlignHorizontal = alignMap[nodeData.textAlign] || 'LEFT';
    }

    text.x = nodeData.x || 0;
    text.y = nodeData.y || 0;
    // The exporter measures the exact glyph box with DOM ranges — keep it fixed
    if (nodeData.w) text.resize(Math.max(1, nodeData.w), Math.max(1, nodeData.h || nodeData.fontSize * 1.5));
    text.textAutoResize = 'NONE';

    parent.appendChild(text);
  });
}
