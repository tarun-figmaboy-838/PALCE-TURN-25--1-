/* =========================================================================
   debug.js — per-screen layout overlay for the juice-pouring game.

   Activates only when the page URL contains ?debug=1 (see the conditional
   loader at the bottom of lbd.1.html). Purely additive: it never runs in the
   shipped game and removing the loader fully restores original behavior.

   What it does:
     - Draws drag + 8-point resize handles over every POSITIONED asset inside
       #game-stage (full-bleed backgrounds are excluded).
     - Shows a live "id | x%,y% | w%×h%" label on each instrumented element.
     - A floating panel offers a screen navigator (jump to any GAME_STATES
       state / juice LEVEL without playing through), a per-element list with
       Reset, and a "Download Layout JSON" button.

   Coordinates are reported in PERCENT of #game-stage — the same unit the
   source uses for left/top/width — so exported values drop straight back into
   the CSS. A secondary frame-px readout (×1920/1080) is shown for the Figma
   guide engine's benefit.

   Self-contained IIFE, zero dependencies, file:// safe.
   ========================================================================= */
(function () {
  "use strict";

  // --- config ---------------------------------------------------------------
  // Design frame the Figma engine uses; mirrors __juiceGame.FIGMA_FRAME.
  const FRAME = { width: 1920, height: 1080 };

  // Any element covering at least this fraction of the stage is treated as a
  // full-bleed background and is NOT instrumented (defensive guard on top of
  // the explicit id/class deny-list below).
  const FULL_FRAME_COVERAGE = 0.97;

  // Explicit deny-list: backgrounds, scene layers, and the curtain/loader that
  // are not positioned assets to be aligned.
  // NOTE: the pour images (#html-pour-img / #pour-scene) are NO LONGER excluded —
  // they are real positioned assets (juice-pour.svg / juice-pour-overflow.svg) and
  // the visibility gate means they only get handles while actually on screen.
  const EXCLUDE_IDS = [
    "bg", "table", "level-curtain",
    "loading-screen", "loading-banner", "game-stage", "jar-stop-mask"
  ];
  const EXCLUDE_CLASSES = ["bg", "lc-panel", "lc-valance", "quiz-panel-bg"];

  // Asset-bearing elements that live INSIDE overlays / cards the direct-child
  // scan can't reach (the intro genie, quiz choices, celebration + completion
  // art, and the legacy fs-*/mg-*/go-* screens). scan() looks each up by id and
  // instruments it ONLY while it is effectively visible on the current screen —
  // so every asset in ASSETS/ that the game shows can be dragged, resized, and
  // exported, without cluttering the overlay with handles for hidden screens.
  // (Live gameplay assets — #juice, #tall-wrap, #wide-wrap, #guide-wrap,
  // #hand-hint — are already covered by the direct-child scan.)
  const DEEP_INCLUDE_IDS = [
    // Guide unit internals (so the speech bubble / Dialoage Box.svg, Gogo, and the
    // text region can be positioned/resized individually — #guide-wrap still moves
    // as a whole unit, these add per-part control on top).
    "genie", "speech-wrap", "dialogue", "dialogue-text",
    // Container art INSIDE the jar wraps (the fill SVGs swap onto these — e.g.
    // tall_container_orange_juice.svg). The wraps still move as a unit; these add
    // per-image control. base reports as tall-wrap / wide-wrap.
    "tall", "wide",
    // Pre-LBD intro + title card
    "pre-lbd-intro-genie", "pre-lbd-genie",
    // Capacity quiz choices (tutorial)
    "quiz-choice-tall", "quiz-choice-wide",
    // Celebration + completion characters
    "tutorial-celebrate-img", "capacity-complete-gogo",
    // Game-over / complete screens
    "go-gogo", "go-complete-gogo",
    // Legacy full-screen (fs-*) main-game screen
    "fs-dispenser", "fs-pour", "fs-char", "fs-bubble", "fs-quiz-tall", "fs-quiz-wide",
    // Legacy main-game (mg-*) screen
    "mg-dispenser", "mg-large", "mg-small", "mg-gogo", "mg-quiz-bg",
    "mg-card-large", "mg-card-small", "mg-celebrate-img", "mg-final-gogo"
  ];

  // The intro genie art the game swaps per screen, exposed as quick chips so the
  // new GIF / genie-2 assets can be shown statically, positioned, and exported
  // WITHOUT playing through the timed intro sequence.
  const INTRO_GENIE_ASSETS = [
    { label: "S1 · welcome gif", src: "ASSETS/animate-genie.1.gif" },
    { label: "S2 · fun gif",     src: "ASSETS/animate-genie.gif" },
    { label: "S3-6 · genie-2",   src: "ASSETS/genie-2.png" }
  ];

  const MIN_SIZE_PX = 10;   // resize floor

  // --- state ----------------------------------------------------------------
  let stage = null;            // #game-stage element (the coordinate frame)
  let layer = null;            // overlay layer appended into the stage
  let panel = null;            // fixed control panel
  let listBody = null;         // panel element list container
  const items = [];            // [{ el, id, box, handle, label, resizers[], original }]
  let active = null;           // element currently being dragged/resized

  // --- boot -----------------------------------------------------------------
  // Wait until the stage + game API exist before instrumenting.
  function boot() {
    stage = document.getElementById("game-stage");
    if (!stage || !window.__juiceGame) {
      window.setTimeout(boot, 120);
      return;
    }
    injectStyles();
    buildLayer();
    buildPanel();
    scan();
    bindGlobalEvents();
    log("debug overlay ready");
  }

  // --- styles ---------------------------------------------------------------
  function injectStyles() {
    const css = `
      .dbg-layer { position:absolute; inset:0; z-index:99990; pointer-events:none; }
      .dbg-handle {
        position:absolute; box-sizing:border-box; pointer-events:auto;
        border:1.5px dashed #00e5ff; background:rgba(0,229,255,0.06);
        cursor:move; touch-action:none;
      }
      .dbg-handle:hover { background:rgba(0,229,255,0.14); }
      .dbg-label {
        position:absolute; left:0; top:-18px; white-space:nowrap;
        font:11px/14px monospace; color:#001018; background:#00e5ff;
        padding:1px 5px; border-radius:3px; pointer-events:none;
      }
      .dbg-resizer {
        position:absolute; width:10px; height:10px; box-sizing:border-box;
        background:#fff; border:1.5px solid #00e5ff; pointer-events:auto;
        touch-action:none;
      }
      .dbg-nw{left:-5px;top:-5px;cursor:nwse-resize}
      .dbg-n {left:50%;top:-5px;margin-left:-5px;cursor:ns-resize}
      .dbg-ne{right:-5px;top:-5px;cursor:nesw-resize}
      .dbg-e {right:-5px;top:50%;margin-top:-5px;cursor:ew-resize}
      .dbg-se{right:-5px;bottom:-5px;cursor:nwse-resize}
      .dbg-s {left:50%;bottom:-5px;margin-left:-5px;cursor:ns-resize}
      .dbg-sw{left:-5px;bottom:-5px;cursor:nesw-resize}
      .dbg-w {left:-5px;top:50%;margin-top:-5px;cursor:ew-resize}

      .dbg-panel {
        position:fixed; top:10px; right:10px; width:300px; max-height:92vh;
        overflow:auto; z-index:99999; background:rgba(14,18,24,0.95);
        color:#e8f6ff; font:12px/1.45 system-ui,sans-serif; border-radius:8px;
        box-shadow:0 6px 24px rgba(0,0,0,0.5); border:1px solid #00485a;
      }
      .dbg-panel h4 { margin:0; padding:8px 10px; font-size:12px;
        background:#00303d; border-radius:8px 8px 0 0; letter-spacing:.3px; }
      .dbg-sec { padding:8px 10px; border-top:1px solid #062b36; }
      .dbg-sec b { color:#7fe9ff; font-weight:600; display:block; margin-bottom:5px; }
      .dbg-state { color:#ffd27f; font-family:monospace; word-break:break-all; }
      .dbg-chips { display:flex; flex-wrap:wrap; gap:4px; }
      .dbg-chip {
        cursor:pointer; padding:2px 7px; border-radius:10px; font-size:11px;
        background:#063442; color:#bdeeff; border:1px solid #0a5366;
      }
      .dbg-chip:hover { background:#0a5366; }
      .dbg-chip.is-current { background:#00e5ff; color:#001018; font-weight:600; }
      .dbg-chip.lvl { background:#3a2a08; border-color:#7a5a14; color:#ffd27f; }
      .dbg-chip.lvl:hover { background:#7a5a14; }
      .dbg-row {
        display:flex; align-items:center; justify-content:space-between;
        gap:6px; padding:2px 0; border-bottom:1px solid #062b36;
      }
      .dbg-row code { color:#bdeeff; font-size:10px; }
      .dbg-row .id { color:#fff; font-weight:600; cursor:pointer; }
      .dbg-btn {
        cursor:pointer; border:none; border-radius:5px; padding:5px 9px;
        font-size:11px; background:#00485a; color:#e8f6ff;
      }
      .dbg-btn:hover { background:#006a85; }
      .dbg-btn.primary { background:#00e5ff; color:#001018; font-weight:700; width:100%; }
      .dbg-mini { background:#3a1e1e; padding:2px 6px; font-size:10px; }
      .dbg-mini:hover { background:#5a2e2e; }
    `;
    const style = document.createElement("style");
    style.id = "dbg-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // --- overlay layer ---------------------------------------------------------
  function buildLayer() {
    layer = document.createElement("div");
    layer.className = "dbg-layer";
    stage.appendChild(layer);
  }

  // --- exclusion test ---------------------------------------------------------
  // True if the element is a full-bleed background / non-positioned layer that
  // should not get drag/resize handles.
  function isExcluded(el) {
    if (EXCLUDE_IDS.indexOf(el.id) !== -1) return true;
    for (const c of EXCLUDE_CLASSES) {
      if (el.classList.contains(c)) return true;
    }
    const cs = getComputedStyle(el);
    if (cs.position === "static") return true;          // not a positioned asset
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return true;        // collapsed / off-screen
    const sr = stage.getBoundingClientRect();
    const cover = (r.width * r.height) / (sr.width * sr.height);
    if (cover >= FULL_FRAME_COVERAGE) return true;       // full-frame guard
    return false;
  }

  // True only if the element AND every ancestor up to <body> is actually shown
  // (no display:none / visibility:hidden / near-zero opacity anywhere up the
  // tree) and it has a real box. Overlays hide via opacity:0 on a still-laid-out
  // parent, so a child's OWN computed style looks visible — we must walk up.
  function isEffectivelyVisible(el) {
    let n = el;
    while (n && n !== document.body && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (parseFloat(cs.opacity || "1") < 0.05) return false;
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  // --- scan: (re)instrument the currently visible positioned assets ----------
  function scan() {
    teardownItems();
    // Direct children of the stage are the positioned assets/groups. We do not
    // descend into groups so a group (e.g. #guide-wrap) moves as one unit.
    const kids = Array.from(stage.children);
    kids.forEach(function (el) {
      if (el === layer || el === panel) return;
      if (!el.id) return;                 // only named assets are instrumentable
      if (isExcluded(el)) return;
      registerItem(el);
    });
    // Deep includes: asset elements nested inside overlays/cards that the
    // direct-child scan can't reach. Instrument each ONLY while it is
    // effectively visible (it + all ancestors shown) so the current screen's
    // assets get handles and hidden screens stay clean. Jump to a state /
    // use the Intro controls to reveal a screen, then Rescan.
    const skippedStatic = [];
    DEEP_INCLUDE_IDS.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (items.some(function (it) { return it.el === el; })) return;
      if (EXCLUDE_IDS.indexOf(el.id) !== -1) return;
      if (!isEffectivelyVisible(el)) return;
      // A static (flex/grid-flowed) element can't be moved by left/top, so the
      // drag model doesn't apply. Flag it instead of silently dropping it.
      if (getComputedStyle(el).position === "static") { skippedStatic.push(id); return; }
      registerItem(el);
    });
    if (skippedStatic.length) {
      warn("these visible assets are flex/grid-positioned (static) so the left/top "
        + "drag tool can't move them: " + skippedStatic.join(", "));
    }
    refreshAll();
    renderList();
  }

  function registerItem(el) {
    const handle = document.createElement("div");
    handle.className = "dbg-handle";

    const label = document.createElement("div");
    label.className = "dbg-label";
    handle.appendChild(label);

    const resizers = [];
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(function (dir) {
      const rz = document.createElement("div");
      rz.className = "dbg-resizer dbg-" + dir;
      rz.dataset.dir = dir;
      handle.appendChild(rz);
      resizers.push(rz);
    });

    layer.appendChild(handle);

    const item = { el: el, id: el.id, handle: handle, label: label, resizers: resizers,
                   original: el.getAttribute("style") || "" };
    items.push(item);

    handle.addEventListener("pointerdown", function (e) { startDrag(e, item); });
    resizers.forEach(function (rz) {
      rz.addEventListener("pointerdown", function (e) { startResize(e, item, rz.dataset.dir); });
    });
  }

  function teardownItems() {
    items.forEach(function (it) { it.handle.remove(); });
    items.length = 0;
  }

  // --- geometry helpers -------------------------------------------------------
  // Element box in PERCENT of the stage (top-left origin). Used to PLACE the drag
  // handle, which lives in the stage-frame overlay layer.
  function boxPercent(el) {
    const r = el.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    return {
      x: (r.left - sr.left) / sr.width * 100,
      y: (r.top - sr.top) / sr.height * 100,
      w: r.width / sr.width * 100,
      h: r.height / sr.height * 100
    };
  }

  // The rect an element's CSS left/top/width/height % are resolved AGAINST — its
  // offset parent (nearest positioned ancestor). For a direct stage child this is
  // the stage itself, so behaviour is unchanged; for a NESTED asset (e.g.
  // #speech-wrap inside #guide-wrap) it is the wrapper. Using this base is what
  // makes dragging/exporting nested assets correct instead of jumping.
  function baseEl(el) {
    const op = el.offsetParent;
    if (op && op !== document.body && stage.contains(op)) return op;
    return stage;
  }
  function baseRect(el) { return baseEl(el).getBoundingClientRect(); }
  function baseId(el)   { const b = baseEl(el); return b === stage ? "game-stage" : (b.id || "(unnamed)"); }

  // Element box in PERCENT of its OWN base (offset parent) — the unit its inline
  // left/top/width/height must be written in, and the unit we export.
  function boxInBase(el) {
    const r = el.getBoundingClientRect();
    const br = baseRect(el);
    return {
      x: (r.left - br.left) / br.width * 100,
      y: (r.top - br.top) / br.height * 100,
      w: r.width / br.width * 100,
      h: r.height / br.height * 100
    };
  }

  function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

  // Position a handle over its element (handles live in the stage frame, so
  // they share the same % coordinate space).
  function refreshItem(it) {
    // Handle is drawn in the stage frame, so place it with stage-relative %.
    const s = boxPercent(it.el);
    it.handle.style.left = s.x + "%";
    it.handle.style.top = s.y + "%";
    it.handle.style.width = s.w + "%";
    it.handle.style.height = s.h + "%";
    // Label reports the BASE-relative box (the CSS-relevant numbers) and names the
    // base so a nested asset's values are unambiguous.
    const b = boxInBase(it.el);
    const base = baseId(it.el);
    const baseTag = base === "game-stage" ? "" : " @" + base;
    it.label.textContent = it.id + " | " + fmt(b.x) + "%," + fmt(b.y) + "% | "
      + fmt(b.w) + "×" + fmt(b.h) + "%" + baseTag;
  }

  function refreshAll() { items.forEach(refreshItem); }

  // --- drag -------------------------------------------------------------------
  function startDrag(e, it) {
    if (e.target.classList.contains("dbg-resizer")) return;  // resizer wins
    e.preventDefault();
    e.stopPropagation();
    active = it;
    // Convert pointer motion into % of the element's OWN base (offset parent), so
    // nested assets move WYSIWYG instead of jumping by the wrong coordinate scale.
    const br = baseRect(it.el);
    const start = boxInBase(it.el);
    const ox = e.clientX, oy = e.clientY;

    function move(ev) {
      const dx = (ev.clientX - ox) / br.width * 100;
      const dy = (ev.clientY - oy) / br.height * 100;
      // Plain left/top in % keeps WYSIWYG for the common case (genie, jars).
      // Neutralize any translate() so the dragged corner lands where shown.
      stripTranslate(it.el);
      it.el.style.left = fmt(start.x + dx) + "%";
      it.el.style.top = fmt(start.y + dy) + "%";
      refreshItem(it);
      updateRow(it);
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      active = null;
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // --- resize -----------------------------------------------------------------
  function startResize(e, it, dir) {
    e.preventDefault();
    e.stopPropagation();
    active = it;
    const br = baseRect(it.el);
    const start = boxInBase(it.el);
    const ox = e.clientX, oy = e.clientY;
    const minW = MIN_SIZE_PX / br.width * 100;
    const minH = MIN_SIZE_PX / br.height * 100;

    function move(ev) {
      const dx = (ev.clientX - ox) / br.width * 100;
      const dy = (ev.clientY - oy) / br.height * 100;
      let x = start.x, y = start.y, w = start.w, h = start.h;
      if (dir.indexOf("e") !== -1) w = Math.max(minW, start.w + dx);
      if (dir.indexOf("s") !== -1) h = Math.max(minH, start.h + dy);
      if (dir.indexOf("w") !== -1) { w = Math.max(minW, start.w - dx); x = start.x + dx; }
      if (dir.indexOf("n") !== -1) { h = Math.max(minH, start.h - dy); y = start.y + dy; }
      stripTranslate(it.el);
      it.el.style.left = fmt(x) + "%";
      it.el.style.top = fmt(y) + "%";
      it.el.style.width = fmt(w) + "%";
      it.el.style.height = fmt(h) + "%";
      refreshItem(it);
      updateRow(it);
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      active = null;
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // Remove a translate(...) from the inline transform while preserving any
  // rotate/scale, so dragging a transform-centered group (e.g. #guide-wrap) is
  // WYSIWYG instead of fighting the centering offset.
  function stripTranslate(el) {
    const t = el.style.transform;
    if (!t || t.indexOf("translate") === -1) return;
    el.style.transform = t.replace(/translate[XY]?\([^)]*\)/g, "").trim();
  }

  // --- control panel ----------------------------------------------------------
  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "dbg-panel";

    const states = window.__juiceGame.GAME_STATES || {};
    const levels = window.__juiceGame.LEVELS || {};

    panel.innerHTML =
      '<h4>🛠 Layout Debug — ?debug=1</h4>' +
      '<div class="dbg-sec"><b>Current screen</b>' +
        '<div class="dbg-state" id="dbg-current">—</div></div>' +
      '<div class="dbg-sec"><b>Jump to level</b>' +
        '<div class="dbg-chips" id="dbg-levels"></div></div>' +
      '<div class="dbg-sec"><b>Jump to state</b>' +
        '<div class="dbg-chips" id="dbg-states"></div></div>' +
      '<div class="dbg-sec"><b>Pre-LBD intro (new art)</b>' +
        '<div class="dbg-chips" id="dbg-intro-assets"></div>' +
        '<div style="height:5px"></div>' +
        '<div class="dbg-chips" id="dbg-intro-pos"></div></div>' +
      '<div class="dbg-sec"><b>Assets <span id="dbg-count"></span></b>' +
        '<div id="dbg-list"></div></div>' +
      '<div class="dbg-sec">' +
        '<button class="dbg-btn" id="dbg-rescan" style="width:48%">Rescan</button> ' +
        '<button class="dbg-btn" id="dbg-resetall" style="width:48%">Reset all</button>' +
        '<div style="height:6px"></div>' +
        '<button class="dbg-btn primary" id="dbg-download">⬇ Download Layout JSON</button>' +
      '</div>';
    document.body.appendChild(panel);
    listBody = panel.querySelector("#dbg-list");

    // Level chips → startLevel(id). Re-scan after the new screen renders.
    const levelWrap = panel.querySelector("#dbg-levels");
    Object.keys(levels).forEach(function (id) {
      const chip = makeChip(id, "dbg-chip lvl", function () {
        dismissBlockers();
        try { window.__juiceGame.startLevel(id); } catch (err) { warn(err); }
        afterNav();
      });
      levelWrap.appendChild(chip);
    });

    // State chips → goToState(name). De-dupe alias values that resolve to the
    // same canonical state so we list each jump once.
    const stateWrap = panel.querySelector("#dbg-states");
    const seen = {};
    Object.keys(states).forEach(function (key) {
      if (seen[key]) return;
      seen[key] = true;
      const chip = makeChip(key, "dbg-chip", function () {
        dismissBlockers();
        try { window.__juiceGame.goToState(key); } catch (err) { warn(err); }
        afterNav();
      });
      chip.dataset.state = key;
      stateWrap.appendChild(chip);
    });

    // Intro-art chips → show that genie asset statically, then re-instrument so
    // it gets handles. Position chips reposition the currently-shown genie.
    const introWrap = panel.querySelector("#dbg-intro-assets");
    INTRO_GENIE_ASSETS.forEach(function (a) {
      introWrap.appendChild(makeChip(a.label, "dbg-chip", function () {
        showIntroGenie(a.src, panel.dataset.introPos || "center");
      }));
    });
    const posWrap = panel.querySelector("#dbg-intro-pos");
    ["center", "left", "right"].forEach(function (p) {
      posWrap.appendChild(makeChip(p, "dbg-chip", function () {
        panel.dataset.introPos = p;
        const genie = document.getElementById("pre-lbd-intro-genie");
        if (genie && genie.classList.contains("show")) {
          showIntroGenie(genie.currentSrc || genie.src, p);
        }
      }));
    });
    posWrap.appendChild(makeChip("hide intro", "dbg-chip lvl", hideIntroGenie));

    panel.querySelector("#dbg-rescan").onclick = function () { scan(); syncCurrent(); };
    panel.querySelector("#dbg-resetall").onclick = resetAll;
    panel.querySelector("#dbg-download").onclick = downloadJSON;

    syncCurrent();
  }

  function makeChip(text, cls, onClick) {
    const c = document.createElement("span");
    c.className = cls;
    c.textContent = text;
    c.onclick = onClick;
    return c;
  }

  // With ?debug=1 the player never taps "Start", so the boot loading/title
  // screen (and any boot-time intro card) is never hidden — it covers the
  // stage and makes every jump look like a no-op. Force-hide those gates the
  // same way the game's Start handler does, so a jumped-to screen is visible.
  function dismissBlockers() {
    const loading = document.getElementById("loading-screen");
    if (loading) {
      loading.classList.add("hide");
      loading.style.display = "none";
      loading.setAttribute("aria-hidden", "true");
    }
    // The pre-LBD intro card hides the genie via this body class; clear it so
    // gameplay screens render their normal pose.
    document.body.classList.remove("pre-lbd-intro");
  }

  // Force-show the pre-LBD intro overlay + genie STATICALLY (no timed typing /
  // poof) so the new intro art can be dragged, resized, and exported. Mirrors
  // the setup showPreLBDSequence() builds, minus the animation.
  function showIntroGenie(src, position) {
    const pre   = document.getElementById("pre-lbd");
    const genie = document.getElementById("pre-lbd-intro-genie");
    if (!pre || !genie) { warn("pre-lbd intro elements not found"); return; }
    dismissBlockers();                     // clear the loading screen gate first
    document.body.classList.add("pre-lbd-intro");
    pre.classList.add("show");
    pre.setAttribute("aria-hidden", "false");
    if (src) genie.src = src;
    genie.classList.add("show");
    genie.setAttribute("aria-hidden", "false");
    const x = position === "left" ? "26%" : position === "right" ? "74%" : "50%";
    genie.style.setProperty("--intro-genie-x", x);
    genie.dataset.introPosition = position || "center";
    panel.dataset.introPos = position || "center";
    // Let the (possibly fresh) image lay out, then instrument it.
    window.setTimeout(function () { scan(); syncCurrent(); }, 140);
  }

  function hideIntroGenie() {
    const pre   = document.getElementById("pre-lbd");
    const genie = document.getElementById("pre-lbd-intro-genie");
    if (genie) { genie.classList.remove("show"); genie.setAttribute("aria-hidden", "true"); }
    if (pre)   { pre.classList.remove("show"); pre.setAttribute("aria-hidden", "true"); }
    document.body.classList.remove("pre-lbd-intro");
    scan();
  }

  // After a navigation jump, let the new screen settle, then re-instrument it
  // and highlight the current state chip.
  function afterNav() {
    window.setTimeout(function () { scan(); syncCurrent(); }, 350);
  }

  function syncCurrent() {
    const cur = (window.__juiceGame.getState && window.__juiceGame.getState()) || "—";
    const el = panel.querySelector("#dbg-current");
    if (el) el.textContent = cur;
    panel.querySelectorAll("#dbg-states .dbg-chip").forEach(function (c) {
      c.classList.toggle("is-current", c.dataset.state === cur);
    });
  }

  // --- panel element list -----------------------------------------------------
  function renderList() {
    listBody.innerHTML = "";
    panel.querySelector("#dbg-count").textContent = "(" + items.length + ")";
    items.forEach(function (it) {
      const row = document.createElement("div");
      row.className = "dbg-row";
      row.dataset.id = it.id;
      const b = boxInBase(it.el);
      row.innerHTML =
        '<span class="id" title="flash element">' + it.id + '</span>' +
        '<code>' + fmt(b.x) + "," + fmt(b.y) + " · " + fmt(b.w) + "×" + fmt(b.h) + '</code>' +
        '<button class="dbg-btn dbg-mini">reset</button>';
      row.querySelector(".id").onclick = function () { flash(it); };
      row.querySelector("button").onclick = function () { resetItem(it); };
      listBody.appendChild(row);
    });
  }

  function updateRow(it) {
    const row = listBody.querySelector('.dbg-row[data-id="' + it.id + '"]');
    if (!row) return;
    const b = boxInBase(it.el);
    row.querySelector("code").textContent =
      fmt(b.x) + "," + fmt(b.y) + " · " + fmt(b.w) + "×" + fmt(b.h);
  }

  function flash(it) {
    const o = it.handle.style.background;
    it.handle.style.background = "rgba(255,210,127,0.5)";
    window.setTimeout(function () { it.handle.style.background = o; }, 450);
  }

  // --- reset ------------------------------------------------------------------
  function resetItem(it) {
    if (it.original) it.el.setAttribute("style", it.original);
    else it.el.removeAttribute("style");
    refreshItem(it);
    updateRow(it);
  }
  function resetAll() { items.forEach(resetItem); }

  // --- export -----------------------------------------------------------------
  function downloadJSON() {
    const screen = (window.__juiceGame.getState && window.__juiceGame.getState()) || "screen";
    const data = {
      screen: screen,
      units: "percent",
      // Each asset's x/y/w/h are PERCENT of its own `base` (offset parent). Direct
      // stage assets have base "game-stage"; nested assets (e.g. speech-wrap) are
      // relative to their wrapper, matching how their CSS left/top/width resolve.
      origin: "top-left of each asset's base element",
      frame: FRAME,
      assets: items.map(function (it) {
        const b = boxInBase(it.el);
        return { id: it.id, base: baseId(it.el),
                 x: +fmt(b.x), y: +fmt(b.y), w: +fmt(b.w), h: +fmt(b.h) };
      })
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "layout_" + screen + "_" + stamp() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log("downloaded layout for " + screen);
  }

  // Timestamp without Date math dependencies in the hot path — readable suffix.
  function stamp() {
    const d = new Date();
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_"
      + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // --- global events ----------------------------------------------------------
  function bindGlobalEvents() {
    // Keep handles aligned when the responsive stage resizes.
    window.addEventListener("resize", function () { refreshAll(); });
    // Poll the live state so the navigator highlights the right chip even when
    // the game advances on its own.
    window.setInterval(syncCurrent, 800);
  }

  // --- tiny logging -----------------------------------------------------------
  function log(m) { console.log("[debug.js] " + m); }
  function warn(e) { console.warn("[debug.js]", e); }

  // Expose a manual re-scan hook for the console.
  window.__layoutDebug = { scan: scan, items: items };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
