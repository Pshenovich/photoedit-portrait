import {
  ensureFaceLandmarker,
  detectLandmarks,
  buildSkinMaskCanvas,
  buildLipMaskCanvas,
  maskAlphaFromCanvas,
  maskValueAt,
  getLandmarker,
} from "./engine.js";
import { applyFaceAdjust } from "./adjustEngine.js";
import { applyLightPipeline, rotateCanvas90CW, rotateCanvas90CCW } from "./filters.js";
import { runCometEdit, getCometPresetPrompt } from "./cometClient.js";

const fileInput = document.getElementById("fileInput");
const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const hint = document.getElementById("hint");
const statusEl = document.getElementById("status");
const undoBtn = document.getElementById("undoBtn");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const brushSize = document.getElementById("brushSize");
const intensity = document.getElementById("intensity");
const lipColor = document.getElementById("lipColor");
const lipColorWrap = document.getElementById("lipColorWrap");
const brushPanelHint = document.getElementById("brushPanelHint");
const viewport = document.getElementById("viewport");
const resetAdjustSliders = document.getElementById("resetAdjustSliders");
const resetLightSliders = document.getElementById("resetLightSliders");
const rotCwBtn = document.getElementById("rotCwBtn");
const rotCcwBtn = document.getElementById("rotCcwBtn");
const cometApplyBtn = document.getElementById("cometApplyBtn");
const cometPrompt = document.getElementById("cometPrompt");
const cometModel = document.getElementById("cometModel");
const cometPresetSelect = document.getElementById("cometPresetSelect");
const cometPromptRow = document.getElementById("cometPromptRow");
const dockTabs = document.querySelectorAll(".dock-tab");
const panelNose = document.getElementById("panelNose");
const panelFace = document.getElementById("panelFace");
const panelEyes = document.getElementById("panelEyes");
const panelMouth = document.getElementById("panelMouth");
const panelBrush = document.getElementById("panelBrush");
const panelLight = document.getElementById("panelLight");

const DOCK_PANEL = {
  nose: panelNose,
  face: panelFace,
  eyes: panelEyes,
  mouth: panelMouth,
  skin: panelBrush,
  heal: panelBrush,
  lip: panelBrush,
  light: panelLight,
};

const FACE_DOCK_TABS = new Set(["nose", "face", "eyes", "mouth"]);
const BRUSH_DOCK = { skin: "smooth", heal: "heal", lip: "lip" };
const BRUSH_HINTS = {
  smooth: "Кисть: сглаживание кожи по лицу",
  heal: "Кисть: точечно убрать прыщи",
  lip: "Кисть: помада по губам",
};

/** @type {string | null} */
let activeDock = null;

canvas.style.touchAction = "none";
if (viewport) viewport.style.touchAction = "none";
const MAX_EDGE = 1536;
const UNDO_MAX = 24;

let tool = "smooth";
let drawing = false;
let lastX = 0;
let lastY = 0;

/** @type {HTMLImageElement | null} */
let sourceImg = null;
/** @type {ImageData | null} */
let originalSnapshot = null;
const undoStack = [];

/** @type {Array<{x:number,y:number,z?:number}> | null} */
let faceLandmarks = null;
/** @type {Uint8ClampedArray | null} */
let skinMaskAlpha = null;
/** @type {HTMLCanvasElement | null} */
let lipMaskCanvas = null;
/** @type {Uint8ClampedArray | null} */
let lipMaskAlpha = null;

/** База пикселей до текущей сессии «Свет и цвет» (без накопления фильтра). */
let lightPipelineBase = null;
/** База для коррекций лица + точки на момент первого ненулевого значения в сессии. */
let faceAdjustBaseImageData = null;
/** @type {Array<{ x: number; y: number; z?: number }> | null} */
let faceAdjustBaseLandmarks = null;
let lightApplyTimer = null;
let faceApplyTimer = null;
let rangeGesturePointerId = null;
let rangeGestureUndoPushed = false;

const LIGHT_DEBOUNCE_MS = 95;
const FACE_DEBOUNCE_MS = 115;

function setAdjustSlidersEnabled(on) {
  document.querySelectorAll('input[type="range"][id^="adj_"]').forEach((inp) => {
    inp.disabled = !on;
  });
}

function hideAllToolPanels() {
  for (const p of Object.values(DOCK_PANEL)) {
    if (p) p.classList.add("hidden");
  }
}

function showDockPanel(dock) {
  hideAllToolPanels();
  const panel = DOCK_PANEL[dock];
  if (panel) panel.classList.remove("hidden");
  if (BRUSH_DOCK[dock]) {
    tool = BRUSH_DOCK[dock];
    if (brushPanelHint) brushPanelHint.textContent = BRUSH_HINTS[tool] || "";
    if (lipColorWrap) lipColorWrap.classList.toggle("hidden", tool !== "lip");
  } else if (lipColorWrap) {
    lipColorWrap.classList.add("hidden");
  }
}

function setActiveDock(dock) {
  if (activeDock === dock) {
    activeDock = null;
    dockTabs.forEach((btn) => {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    });
    hideAllToolPanels();
    return;
  }
  activeDock = dock;
  dockTabs.forEach((btn) => {
    const id = btn.getAttribute("data-dock");
    const on = id === dock;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  showDockPanel(dock);
}

function bindDockTabs() {
  dockTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const dock = btn.getAttribute("data-dock");
      if (dock) setActiveDock(dock);
    });
  });
}

function bindCometSelect() {
  if (!cometPresetSelect) return;
  cometPresetSelect.addEventListener("change", () => {
    const key = cometPresetSelect.value;
    if (!key) {
      if (cometPromptRow) cometPromptRow.classList.add("hidden");
      return;
    }
    if (cometPromptRow) cometPromptRow.classList.remove("hidden");
    if (cometPrompt) {
      const text = getCometPresetPrompt(key);
      if (text) cometPrompt.value = text;
    }
  });
}

const ADJ_KEYS = [
  "nose_size",
  "nose_lift",
  "nose_bridge",
  "nose_tip",
  "face_size",
  "head_narrow",
  "v_shape",
  "chin_width",
  "chin_len",
  "chin_point",
  "eye_bags",
  "eye_lashes",
  "eye_liner",
  "eye_brows",
  "eye_shadow",
  "teeth_white",
  "smile",
  "lip_plump",
];

function readAdjustParams() {
  /** @type {Record<string, number>} */
  const p = {};
  for (const k of ADJ_KEYS) {
    const el = document.getElementById(`adj_${k}`);
    p[k] = el ? Number(el.value) || 0 : 0;
  }
  return p;
}

function hasAdjustParams(p) {
  return ADJ_KEYS.some((k) => (p[k] || 0) > 0);
}

function invalidateAdjustBases() {
  lightPipelineBase = null;
  faceAdjustBaseImageData = null;
  faceAdjustBaseLandmarks = null;
  if (lightApplyTimer) {
    clearTimeout(lightApplyTimer);
    lightApplyTimer = null;
  }
  if (faceApplyTimer) {
    clearTimeout(faceApplyTimer);
    faceApplyTimer = null;
  }
}

/** @param {Array<{ x: number; y: number; z?: number }>} lm */
function cloneLandmarks(lm) {
  return lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

function ensureSliderGestureUndo() {
  if (!rangeGestureUndoPushed && canvas.width) {
    pushUndo();
    rangeGestureUndoPushed = true;
  }
}

function runLightApplyLive() {
  if (!canvas.width) return;
  const w = canvas.width;
  const h = canvas.height;
  const p = readLightParams();
  try {
    if (!hasLightEffect(p)) {
      if (lightPipelineBase) {
        ctx.putImageData(lightPipelineBase, 0, 0);
        lightPipelineBase = null;
      }
      invalidateFaceAdjustOnlyBase();
      if (getLandmarker()) refreshFaceFromCanvas();
      return;
    }
    if (!lightPipelineBase) {
      lightPipelineBase = ctx.getImageData(0, 0, w, h);
    }
    ctx.putImageData(lightPipelineBase, 0, 0);
    applyLightPipeline(ctx, canvas, p);
    invalidateFaceAdjustOnlyBase();
    if (getLandmarker()) refreshFaceFromCanvas();
  } catch (e) {
    console.warn("runLightApplyLive", e);
  }
}

/** Сбрасываем только базу коррекций лица (пиксели изменились светом). */
function invalidateFaceAdjustOnlyBase() {
  faceAdjustBaseImageData = null;
  faceAdjustBaseLandmarks = null;
}

function scheduleLightApply() {
  if (!canvas.width) return;
  if (lightApplyTimer) clearTimeout(lightApplyTimer);
  lightApplyTimer = setTimeout(() => {
    lightApplyTimer = null;
    runLightApplyLive();
  }, LIGHT_DEBOUNCE_MS);
}

function runFaceAdjustLive() {
  if (!canvas.width || !faceLandmarks) return;
  const w = canvas.width;
  const h = canvas.height;
  const p = readAdjustParams();
  try {
    if (!hasAdjustParams(p)) {
      if (faceAdjustBaseImageData && faceAdjustBaseLandmarks) {
        ctx.putImageData(faceAdjustBaseImageData, 0, 0);
        faceLandmarks = cloneLandmarks(faceAdjustBaseLandmarks);
        const skinCv = buildSkinMaskCanvas(faceLandmarks, w, h);
        skinMaskAlpha = maskAlphaFromCanvas(skinCv);
        lipMaskCanvas = buildLipMaskCanvas(faceLandmarks, w, h);
        lipMaskAlpha = maskAlphaFromCanvas(lipMaskCanvas);
        faceAdjustBaseImageData = null;
        faceAdjustBaseLandmarks = null;
        lightPipelineBase = null;
        updateDockState();
      }
      return;
    }
    if (!faceAdjustBaseImageData || !faceAdjustBaseLandmarks) {
      faceAdjustBaseImageData = ctx.getImageData(0, 0, w, h);
      faceAdjustBaseLandmarks = cloneLandmarks(faceLandmarks);
    }
    ctx.putImageData(faceAdjustBaseImageData, 0, 0);
    const ok = applyFaceAdjust(canvas, ctx, faceAdjustBaseLandmarks, p);
    if (!ok) return;
    lightPipelineBase = null;
    refreshFaceFromCanvas();
  } catch (e) {
    console.warn("runFaceAdjustLive", e);
  }
}

function scheduleFaceAdjustApply() {
  if (!canvas.width || !faceLandmarks) return;
  if (faceApplyTimer) clearTimeout(faceApplyTimer);
  faceApplyTimer = setTimeout(() => {
    faceApplyTimer = null;
    runFaceAdjustLive();
  }, FACE_DEBOUNCE_MS);
}

function resetLightSlidersUI() {
  for (const id of [
    "light_exposure",
    "light_contrast",
    "light_warmth",
    "light_saturation",
    "light_sharpen",
    "light_vignette",
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = "0";
  }
}

function resetAdjustSlidersUI() {
  for (const k of ADJ_KEYS) {
    const el = document.getElementById(`adj_${k}`);
    if (el) el.value = "0";
  }
}

function bindLiveAdjustSliders() {
  const sliderPanels = [
    panelNose,
    panelFace,
    panelEyes,
    panelMouth,
    panelLight,
  ].filter(Boolean);

  for (const panel of sliderPanels) {
    panel.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target;
        if (t instanceof HTMLInputElement && t.type === "range") {
          rangeGesturePointerId = e.pointerId;
          ensureSliderGestureUndo();
        }
      },
      true
    );
    panel.addEventListener(
      "focusout",
      (e) => {
        if (e.target instanceof HTMLInputElement && e.target.type === "range") {
          rangeGestureUndoPushed = false;
        }
      },
      true
    );
  }

  document.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId === rangeGesturePointerId) {
        rangeGesturePointerId = null;
        rangeGestureUndoPushed = false;
      }
    },
    true
  );
  document.addEventListener(
    "pointercancel",
    (e) => {
      if (e.pointerId === rangeGesturePointerId) {
        rangeGesturePointerId = null;
        rangeGestureUndoPushed = false;
      }
    },
    true
  );

  const keyNav = (e) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== "range") return;
    if (!sliderPanels.some((p) => p.contains(e.target))) return;
    const nav = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
    if (!nav.includes(e.key) || e.repeat) return;
    if (rangeGesturePointerId == null) ensureSliderGestureUndo();
  };
  document.addEventListener("keydown", keyNav, true);

  if (panelLight) {
    panelLight.querySelectorAll('input[type="range"]').forEach((el) => {
      el.addEventListener("input", () => scheduleLightApply());
    });
  }
  document.querySelectorAll('input[type="range"][id^="adj_"]').forEach((el) => {
    el.addEventListener("input", () => scheduleFaceAdjustApply());
  });
}

function refreshFaceFromCanvas() {
  if (!canvas.width || !getLandmarker()) return;
  const det = detectLandmarks(canvas);
  if (!det || !det.landmarks) return;
  faceLandmarks = det.landmarks;
  const w = canvas.width;
  const h = canvas.height;
  const skinCv = buildSkinMaskCanvas(faceLandmarks, w, h);
  skinMaskAlpha = maskAlphaFromCanvas(skinCv);
  lipMaskCanvas = buildLipMaskCanvas(faceLandmarks, w, h);
  lipMaskAlpha = maskAlphaFromCanvas(lipMaskCanvas);
  updateDockState();
}

if (resetAdjustSliders) {
  resetAdjustSliders.addEventListener("click", () => {
    resetAdjustSlidersUI();
    runFaceAdjustLive();
  });
}

function applyDataUrlToCanvasMaxEdge(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      let w = w0;
      let h = h0;
      const sc = Math.min(1, MAX_EDGE / Math.max(w, h));
      w = Math.round(w * sc);
      h = Math.round(h * sc);
      canvas.width = w;
      canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(img, 0, 0, w, h);
      resolve();
    };
    img.onerror = () => reject(new Error("Не удалось декодировать ответ ИИ"));
    img.src = dataUrl;
  });
}

async function onRotate(cw) {
  if (!canvas.width) return;
  setStatus("Поворот…");
  await new Promise((r) => requestAnimationFrame(r));
  pushUndo();
  try {
    if (cw) rotateCanvas90CW(canvas, ctx);
    else rotateCanvas90CCW(canvas, ctx);
    resetViewportPanZoom();
    invalidateAdjustBases();
    await analyzeFace();
    setStatus("Поворот выполнен.");
    setTimeout(() => {
      if (statusEl && statusEl.textContent.includes("Поворот выполнен")) setStatus("");
    }, 2000);
  } catch (e) {
    console.warn(e);
    popUndo();
    setStatus("Ошибка поворота.");
  }
}

async function onCometApply() {
  if (!canvas.width || !cometPrompt) return;
  const prompt = cometPrompt.value.trim();
  if (!prompt) {
    setStatus("Введите промпт или нажмите пресет.");
    return;
  }
  const model = cometModel ? cometModel.value : "gpt-image-2";
  setStatus("ИИ ретушь (до ~1 мин, зависит от API)…");
  pushUndo();
  try {
    const dataUrl = await runCometEdit(canvas, { prompt, model });
    await applyDataUrlToCanvasMaxEdge(dataUrl);
    resetViewportPanZoom();
    invalidateAdjustBases();
    resetLightSlidersUI();
    resetAdjustSlidersUI();
    await analyzeFace();
    setStatus("ИИ готово. ↩ — отмена.");
    setTimeout(() => {
      if (statusEl && statusEl.textContent.includes("ИИ готово")) setStatus("");
    }, 3200);
  } catch (e) {
    console.warn(e);
    popUndo();
    setStatus(e && e.message ? String(e.message) : "ИИ недоступен (ключ / сеть / таймаут).");
  }
}

if (resetLightSliders) {
  resetLightSliders.addEventListener("click", () => {
    resetLightSlidersUI();
    runLightApplyLive();
  });
}
if (rotCwBtn) rotCwBtn.addEventListener("click", () => void onRotate(true));
if (rotCcwBtn) rotCcwBtn.addEventListener("click", () => void onRotate(false));
if (cometApplyBtn) cometApplyBtn.addEventListener("click", () => void onCometApply());

function readLightParams() {
  return {
    exposure: Number(document.getElementById("light_exposure")?.value) || 0,
    contrast: Number(document.getElementById("light_contrast")?.value) || 0,
    warmth: Number(document.getElementById("light_warmth")?.value) || 0,
    saturation: Number(document.getElementById("light_saturation")?.value) || 0,
    sharpen: Number(document.getElementById("light_sharpen")?.value) || 0,
    vignette: Number(document.getElementById("light_vignette")?.value) || 0,
  };
}

function hasLightEffect(p) {
  return (
    p.exposure !== 0 ||
    p.contrast !== 0 ||
    p.warmth !== 0 ||
    p.saturation !== 0 ||
    p.sharpen > 0 ||
    p.vignette > 0
  );
}

function updateDockState() {
  const hasImg = !!(canvas && canvas.width && canvas.height);
  const hasFace = !!faceLandmarks;

  if (cometPresetSelect) cometPresetSelect.disabled = !hasImg;
  if (cometApplyBtn) cometApplyBtn.disabled = !hasImg;
  if (cometPrompt) cometPrompt.disabled = !hasImg;
  if (cometModel) cometModel.disabled = !hasImg;
  if (resetLightSliders) resetLightSliders.disabled = !hasImg;
  if (resetAdjustSliders) resetAdjustSliders.disabled = !hasFace;
  if (rotCwBtn) rotCwBtn.disabled = !hasImg;
  if (rotCcwBtn) rotCcwBtn.disabled = !hasImg;

  if (panelLight) {
    panelLight.querySelectorAll('input[type="range"]').forEach((inp) => {
      inp.disabled = !hasImg;
    });
  }

  dockTabs.forEach((btn) => {
    const dock = btn.getAttribute("data-dock");
    if (!dock) return;
    if (!hasImg) {
      btn.disabled = true;
      return;
    }
    if (FACE_DOCK_TABS.has(dock)) {
      btn.disabled = !hasFace;
    } else {
      btn.disabled = false;
    }
  });

  if (!hasImg && activeDock) {
    activeDock = null;
    dockTabs.forEach((btn) => {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    });
    hideAllToolPanels();
  } else if (hasImg && !hasFace && activeDock && FACE_DOCK_TABS.has(activeDock)) {
    activeDock = null;
    dockTabs.forEach((btn) => {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    });
    hideAllToolPanels();
  }
}

function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("hidden", !msg);
}

function pushUndo() {
  try {
    if (!canvas.width || !canvas.height) return;
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    undoStack.push(snap);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    undoBtn.disabled = false;
  } catch (e) {
    console.warn("pushUndo", e);
  }
}

function popUndo() {
  const prev = undoStack.pop();
  if (!prev) {
    undoBtn.disabled = true;
    return;
  }
  ctx.putImageData(prev, 0, 0);
  undoBtn.disabled = undoStack.length === 0;
  invalidateAdjustBases();
  if (getLandmarker()) void refreshFaceFromCanvas();
  updateDockState();
}

function setHintVisible(v) {
  hint.classList.toggle("hidden", !v);
}

undoBtn.addEventListener("click", () => popUndo());

resetBtn.addEventListener("click", () => {
  if (originalSnapshot) {
    pushUndo();
    ctx.putImageData(originalSnapshot, 0, 0);
    invalidateAdjustBases();
    resetLightSlidersUI();
    resetAdjustSlidersUI();
    void analyzeFace();
  }
});

saveBtn.addEventListener("click", () => {
  downloadEditedPhoto();
});

async function downloadEditedPhoto() {
  if (!canvas.width) return;
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.93);
  });
  if (!blob) return;
  const name = `photoedit-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, "")}.jpg`;
  const file = new File([blob], name, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Фото", text: "Отредактированное фото" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function fitImageToCanvas(src) {
  const w0 = "naturalWidth" in src && src.naturalWidth ? src.naturalWidth : src.width;
  const h0 = "naturalHeight" in src && src.naturalHeight ? src.naturalHeight : src.height;
  let w = w0;
  let h = h0;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(src, 0, 0, w, h);
  originalSnapshot = ctx.getImageData(0, 0, w, h);
  undoStack.length = 0;
  undoBtn.disabled = true;
  resetBtn.disabled = false;
  saveBtn.disabled = false;
  invalidateAdjustBases();
  resetLightSlidersUI();
  resetAdjustSlidersUI();
  setHintVisible(false);
  updateDockState();
}

async function analyzeFace() {
  faceLandmarks = null;
  skinMaskAlpha = null;
  lipMaskCanvas = null;
  lipMaskAlpha = null;
  updateDockState();
  setAdjustSlidersEnabled(false);
  if (!canvas.width) return;

  setStatus("Ищем лицо и строим маски…");
  try {
    await ensureFaceLandmarker();
    await new Promise((r) => setTimeout(r, 80));
    let det = detectLandmarks(canvas);
    if (!det) {
      await new Promise((r) => setTimeout(r, 120));
      det = detectLandmarks(canvas);
    }
    if (det && det.landmarks) {
      faceLandmarks = det.landmarks;
      const w = canvas.width;
      const h = canvas.height;
      const skinCv = buildSkinMaskCanvas(faceLandmarks, w, h);
      skinMaskAlpha = maskAlphaFromCanvas(skinCv);
      lipMaskCanvas = buildLipMaskCanvas(faceLandmarks, w, h);
      lipMaskAlpha = maskAlphaFromCanvas(lipMaskCanvas);
      setStatus("Лицо найдено — доступны коррекции носа, лица, глаз и рта.");
    } else {
      setStatus(
        "Лицо не найдено. Коррекции лица недоступны; кисть «Кожа» и «Свет» работают. Попробуйте крупнее лицо в кадре."
      );
      lipMaskAlpha = null;
    }
  } catch (e) {
    console.warn(e);
    lipMaskAlpha = null;
    setStatus("Детектор лица недоступен. Кисти и свет работают без масок лица.");
  } finally {
    updateDockState();
    setAdjustSlidersEnabled(!!faceLandmarks);
  }
}

fileInput.addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    let src = null;
    if (typeof createImageBitmap === "function") {
      try {
        src = await createImageBitmap(f, { imageOrientation: "from-image" });
      } catch (_) {
        src = null;
      }
    }
    if (!src) {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      if (img.decode) await img.decode();
      URL.revokeObjectURL(url);
      src = img;
    }
    if (src instanceof ImageBitmap) {
      sourceImg = null;
    } else {
      sourceImg = src;
    }
    fitImageToCanvas(src);
    if (src instanceof ImageBitmap) {
      try {
        src.close();
      } catch (_) {
        /* ignore */
      }
    }
    await analyzeFace();
  } catch (err) {
    console.warn(err);
    setStatus("Не удалось открыть файл. Попробуйте JPEG или PNG.");
  }
  e.target.value = "";
});

function getIntensity() {
  return Number(intensity.value) / 100;
}

function canvasCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

/**
 * @param {number} strengthMul 0..1 softens brush when off-skin
 */
function stampFilteredDisk(cx, cy, r, filterCss, strengthMul = 1) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(canvas.width, Math.ceil(cx + r));
  const y1 = Math.min(canvas.height, Math.ceil(cy + r));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  const sm = Math.max(0, Math.min(1, strengthMul));

  const orig = document.createElement("canvas");
  orig.width = rw;
  orig.height = rh;
  orig.getContext("2d").drawImage(canvas, x0, y0, rw, rh, 0, 0, rw, rh);

  const filt = document.createElement("canvas");
  filt.width = rw;
  filt.height = rh;
  const fctx = filt.getContext("2d");
  try {
    fctx.filter = filterCss;
    fctx.drawImage(orig, 0, 0);
  } catch (_) {
    fctx.filter = "none";
    fctx.drawImage(orig, 0, 0);
  }
  fctx.filter = "none";

  const mask = document.createElement("canvas");
  mask.width = rw;
  mask.height = rh;
  const mctx = mask.getContext("2d");
  const grd = mctx.createRadialGradient(
    cx - x0,
    cy - y0,
    0,
    cx - x0,
    cy - y0,
    r
  );
  grd.addColorStop(0, `rgba(255,255,255,${0.96 * sm})`);
  grd.addColorStop(0.72, `rgba(255,255,255,${0.88 * sm})`);
  grd.addColorStop(1, "rgba(255,255,255,0)");
  mctx.fillStyle = grd;
  mctx.fillRect(0, 0, rw, rh);

  const maskedFilt = document.createElement("canvas");
  maskedFilt.width = rw;
  maskedFilt.height = rh;
  const mf = maskedFilt.getContext("2d");
  mf.drawImage(filt, 0, 0);
  mf.globalCompositeOperation = "destination-in";
  mf.drawImage(mask, 0, 0);

  const out = document.createElement("canvas");
  out.width = rw;
  out.height = rh;
  const octx = out.getContext("2d");
  octx.drawImage(orig, 0, 0);
  octx.globalCompositeOperation = "source-over";
  octx.drawImage(maskedFilt, 0, 0);

  ctx.drawImage(out, x0, y0);
}

function applySmooth(cx, cy, r) {
  let mul = 1;
  if (skinMaskAlpha) {
    mul = 0.2 + 0.8 * maskValueAt(canvas.width, canvas.height, cx, cy, skinMaskAlpha);
    if (mul < 0.06) return;
  }
  stampFilteredDisk(cx, cy, r, "blur(2.5px) contrast(1.03) saturate(1.04)", mul);
}

function applyEyes(cx, cy, r) {
  stampFilteredDisk(cx, cy, r, "brightness(1.1) contrast(0.94) saturate(0.86)", 1);
}

/**
 * Локальный «heal»: цвет из кольца вокруг точки, мягкая заливка внутри (прыщи).
 */
function applyHeal(cx, cy, R) {
  const w = canvas.width;
  const h = canvas.height;
  if (R < 2 || !w || !h) return;

  const ringHi = Math.min(R * 2.15, Math.min(w, h) * 0.2);
  const rIn = Math.max(1.5, R * 0.4);
  const rRingLo = rIn * 1.1;
  const rRingHi = ringHi;

  const cx0 = Math.max(0, Math.floor(cx - rRingHi - 2));
  const cy0 = Math.max(0, Math.floor(cy - rRingHi - 2));
  const cx1 = Math.min(w - 1, Math.ceil(cx + rRingHi + 2));
  const cy1 = Math.min(h - 1, Math.ceil(cy + rRingHi + 2));
  const pw = cx1 - cx0 + 1;
  const ph = cy1 - cy0 + 1;
  if (pw < 3 || ph < 3) return;

  let img;
  try {
    img = ctx.getImageData(cx0, cy0, pw, ph);
  } catch (e) {
    console.warn("applyHeal getImageData", e);
    return;
  }
  const d = img.data;
  const pcx = cx - cx0;
  const pcy = cy - cy0;

  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sn = 0;
  const collect = (lo, hi) => {
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const dist = Math.hypot(px - pcx, py - pcy);
        if (dist >= lo && dist <= hi) {
          const i = (py * pw + px) * 4;
          sr += d[i];
          sg += d[i + 1];
          sb += d[i + 2];
          sn++;
        }
      }
    }
  };
  collect(rRingLo, rRingHi);
  if (sn < 8) {
    sr = 0;
    sg = 0;
    sb = 0;
    sn = 0;
    collect(rIn * 1.05, rRingHi * 1.12);
  }
  if (sn < 1) return;
  const ar = sr / sn;
  const ag = sg / sn;
  const ab = sb / sn;

  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const dist = Math.hypot(px - pcx, py - pcy);
      if (dist > rIn) continue;
      const t = 1 - dist / rIn;
      const smooth = t * t * (3 - 2 * t);
      let skinM = 1;
      if (skinMaskAlpha) {
        skinM = 0.12 + 0.88 * maskValueAt(w, h, cx0 + px, cy0 + py, skinMaskAlpha);
      }
      const a = smooth * skinM * 0.9;
      const i = (py * pw + px) * 4;
      d[i] = d[i] * (1 - a) + ar * a;
      d[i + 1] = d[i + 1] * (1 - a) + ag * a;
      d[i + 2] = d[i + 2] * (1 - a) + ab * a;
    }
  }
  ctx.putImageData(img, cx0, cy0);
}

function applyLipLine(x0, y0, x1, y1, width, hex) {
  let m0 = 1;
  let m1 = 1;
  if (lipMaskAlpha) {
    m0 = 0.25 + 0.75 * maskValueAt(canvas.width, canvas.height, x0, y0, lipMaskAlpha);
    m1 = 0.25 + 0.75 * maskValueAt(canvas.width, canvas.height, x1, y1, lipMaskAlpha);
  }
  const mul = (m0 + m1) * 0.5;
  if (mul < 0.08) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = hex;
  ctx.globalAlpha = 0.52 * mul;
  ctx.globalCompositeOperation = "multiply";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.28 * mul;
  ctx.stroke();
  ctx.restore();
}

function applyLipDot(cx, cy, width, hex) {
  let mul = 1;
  if (lipMaskAlpha) {
    mul = 0.25 + 0.75 * maskValueAt(canvas.width, canvas.height, cx, cy, lipMaskAlpha);
  }
  if (mul < 0.08) return;
  ctx.save();
  ctx.fillStyle = hex;
  ctx.globalAlpha = 0.48 * mul;
  ctx.globalCompositeOperation = "multiply";
  ctx.beginPath();
  ctx.arc(cx, cy, width * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function distance(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

function strokeBegin(clientX, clientY) {
  if (!canvas.width) return;
  const { x, y } = canvasCoords(clientX, clientY);
  drawing = true;
  lastX = x;
  lastY = y;
  const r = Number(brushSize.value);
  try {
    invalidateAdjustBases();
    pushUndo();
    if (tool === "smooth") applySmooth(x, y, r);
    else if (tool === "eyes") applyEyes(x, y, r);
    else if (tool === "heal") applyHeal(x, y, r);
    else if (tool === "lip") applyLipDot(x, y, r, lipColor.value);
  } catch (err) {
    console.warn("strokeBegin", err);
  }
}

function strokeDrag(clientX, clientY) {
  if (!drawing || !canvas.width) return;
  const { x, y } = canvasCoords(clientX, clientY);
  const r = Number(brushSize.value);
  const step = Math.max(3, r * 0.32);

  try {
    if (tool === "lip") {
      const d = distance(lastX, lastY, x, y);
      if (d < 0.8) return;
      applyLipLine(lastX, lastY, x, y, r * 0.82, lipColor.value);
      lastX = x;
      lastY = y;
      return;
    }

    const dist = distance(lastX, lastY, x, y);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const px = lastX + ((x - lastX) * i) / n;
      const py = lastY + ((y - lastY) * i) / n;
      if (tool === "smooth") applySmooth(px, py, r);
      else if (tool === "eyes") applyEyes(px, py, r);
      else if (tool === "heal") applyHeal(px, py, r);
    }
    lastX = x;
    lastY = y;
  } catch (err) {
    console.warn("strokeDrag", err);
  }
}

function strokeFinish(ev) {
  if (!drawing) return;
  if (ev && ev.cancelable) ev.preventDefault();
  if (ev && typeof ev.pointerId === "number" && canvas.releasePointerCapture) {
    try {
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) {
        canvas.releasePointerCapture(ev.pointerId);
      }
    } catch (_) {
      /* ignore */
    }
  }
  drawing = false;
}

function onPointerDown(ev) {
  if (!canvas.width) return;
  if (ev.pointerType === "touch") return;
  ev.preventDefault();
  if (typeof ev.pointerId === "number" && canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
  }
  strokeBegin(ev.clientX, ev.clientY);
}

function onPointerMove(ev) {
  if (!drawing || !canvas.width) return;
  if (ev.pointerType === "touch") return;
  ev.preventDefault();
  strokeDrag(ev.clientX, ev.clientY);
}

function onPointerUp(ev) {
  if (ev.pointerType === "touch") return;
  strokeFinish(ev);
}

function onPointerCancel(ev) {
  if (ev.pointerType === "touch") return;
  strokeFinish(ev);
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerCancel);

canvas.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 2) {
      if (drawing) strokeFinish(null);
      return;
    }
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    strokeBegin(t.clientX, t.clientY);
  },
  { passive: false }
);

canvas.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length === 2) {
      if (drawing) strokeFinish(null);
      return;
    }
    if (!drawing || e.touches.length !== 1) return;
    e.preventDefault();
    strokeDrag(e.touches[0].clientX, e.touches[0].clientY);
  },
  { passive: false }
);

canvas.addEventListener(
  "touchend",
  (e) => {
    if (!drawing) return;
    if (e.touches.length > 0) return;
    e.preventDefault();
    strokeFinish(null);
  },
  { passive: false }
);

canvas.addEventListener("touchcancel", () => {
  strokeFinish(null);
});

/** Pinch zoom / pan on preview */
let pinchDist0 = 0;
let pinchScale0 = 1;
let scale = 1;
let panX = 0;
let panY = 0;

function applyViewportTransform() {
  if (!viewport) return;
  viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function resetViewportPanZoom() {
  scale = 1;
  panX = 0;
  panY = 0;
  applyViewportTransform();
}

if (viewport) {
  viewport.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        pinchDist0 = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        pinchScale0 = scale;
      }
    },
    { passive: true }
  );
  viewport.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && pinchDist0 > 10) {
        const a = e.touches[0];
        const b = e.touches[1];
        const d = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const next = Math.min(4, Math.max(1, (pinchScale0 * d) / pinchDist0));
        scale = next;
        applyViewportTransform();
      }
    },
    { passive: true }
  );
  viewport.addEventListener("touchend", () => {
    pinchDist0 = 0;
  });
}

hideAllToolPanels();
bindDockTabs();
bindCometSelect();
bindLiveAdjustSliders();
updateDockState();
setAdjustSlidersEnabled(!!faceLandmarks);
setStatus("");
