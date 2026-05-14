import {
  ensureFaceLandmarker,
  detectLandmarks,
  buildSkinMaskCanvas,
  buildLipMaskCanvas,
  maskAlphaFromCanvas,
  applyAutoSkin,
  applyAutoEyes,
  applyAutoLip,
  maskValueAt,
} from "./engine.js";

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
const toolButtons = document.querySelectorAll(".tool");
const autoSkinBtn = document.getElementById("autoSkinBtn");
const autoEyesBtn = document.getElementById("autoEyesBtn");
const autoLipsBtn = document.getElementById("autoLipsBtn");
const viewport = document.getElementById("viewport");

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

function updateAutoButtonState() {
  const hasImg = !!(canvas && canvas.width && canvas.height);
  if (autoSkinBtn) autoSkinBtn.disabled = !hasImg;
  if (autoEyesBtn) autoEyesBtn.disabled = !hasImg || !faceLandmarks;
  if (autoLipsBtn) autoLipsBtn.disabled = !hasImg || !lipMaskCanvas;
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
}

function setHintVisible(v) {
  hint.classList.toggle("hidden", !v);
}

function syncToolsUI() {
  toolButtons.forEach((btn) => {
    const t = btn.getAttribute("data-tool");
    const on = t === tool;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  lipColorWrap.classList.toggle("hidden", tool !== "lip");
}

toolButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tool = btn.getAttribute("data-tool") || "smooth";
    syncToolsUI();
  });
});

undoBtn.addEventListener("click", () => popUndo());

resetBtn.addEventListener("click", () => {
  if (originalSnapshot) {
    pushUndo();
    ctx.putImageData(originalSnapshot, 0, 0);
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

function fitImageToCanvas(img) {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  originalSnapshot = ctx.getImageData(0, 0, w, h);
  undoStack.length = 0;
  undoBtn.disabled = true;
  resetBtn.disabled = false;
  saveBtn.disabled = false;
  setHintVisible(false);
  updateAutoButtonState();
}

async function analyzeFace() {
  faceLandmarks = null;
  skinMaskAlpha = null;
  lipMaskCanvas = null;
  lipMaskAlpha = null;
  updateAutoButtonState();
  if (!canvas.width) return;

  setStatus("Ищем лицо и строим маски…");
  try {
    await ensureFaceLandmarker();
    const det = detectLandmarks(canvas);
    if (det && det.landmarks) {
      faceLandmarks = det.landmarks;
      const w = canvas.width;
      const h = canvas.height;
      const skinCv = buildSkinMaskCanvas(faceLandmarks, w, h);
      skinMaskAlpha = maskAlphaFromCanvas(skinCv);
      lipMaskCanvas = buildLipMaskCanvas(faceLandmarks, w, h);
      lipMaskAlpha = maskAlphaFromCanvas(lipMaskCanvas);
      setStatus("Лицо найдено: «Авто» и кисть «Кожа» только по коже лица.");
    } else {
      setStatus("Лицо не найдено — «Авто кожа» по всему кадру, кисть по всему фото.");
      lipMaskAlpha = null;
    }
  } catch (e) {
    console.warn(e);
    lipMaskAlpha = null;
    setStatus("Детектор лица недоступен (сеть/CORS). «Авто кожа» и кисть по всему фото.");
  } finally {
    updateAutoButtonState();
  }
}

fileInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = async () => {
    URL.revokeObjectURL(url);
    sourceImg = img;
    fitImageToCanvas(img);
    await analyzeFace();
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
  e.target.value = "";
});

function getIntensity() {
  return Number(intensity.value) / 100;
}

function fullSkinMaskAlpha() {
  const w = canvas.width;
  const h = canvas.height;
  const a = new Uint8ClampedArray(w * h);
  a.fill(255);
  return a;
}

/** Если маска кожи пустая/битая — иначе «Авто кожа» визуально «ничего». */
function effectiveSkinMaskForAuto() {
  const w = canvas.width;
  const h = canvas.height;
  const n = w * h;
  const full = fullSkinMaskAlpha();
  if (!skinMaskAlpha || skinMaskAlpha.length !== n) return full;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += skinMaskAlpha[i];
  const mean = sum / (n * 255);
  if (mean < 0.04) return full;
  return skinMaskAlpha;
}

async function autoSkin() {
  if (!canvas.width) return;
  setStatus("Авто кожа: обработка…");
  await new Promise((r) => requestAnimationFrame(r));
  const mask = effectiveSkinMaskForAuto();
  try {
    pushUndo();
    applyAutoSkin(canvas, mask, getIntensity() * 0.92, {
      fine: 4 + getIntensity() * 2,
      coarse: 11 + getIntensity() * 10,
    });
    setStatus("Кожа обновлена. ↩ — отмена.");
    setTimeout(() => {
      if (statusEl && statusEl.textContent.includes("Кожа обновлена")) setStatus("");
    }, 2800);
  } catch (e) {
    console.warn("autoSkin", e);
    setStatus("Не удалось обработать (память/размер). Попробуйте меньшее фото.");
  }
}

function autoEyes() {
  if (!canvas.width || !faceLandmarks) return;
  pushUndo();
  applyAutoEyes(canvas, faceLandmarks, getIntensity() * 0.95);
}

function autoLips() {
  if (!canvas.width || !lipMaskCanvas) return;
  pushUndo();
  applyAutoLip(canvas, lipMaskCanvas, lipColor.value, getIntensity() * 0.88);
}

if (autoSkinBtn) autoSkinBtn.addEventListener("click", () => void autoSkin());
if (autoEyesBtn) autoEyesBtn.addEventListener("click", autoEyes);
if (autoLipsBtn) autoLipsBtn.addEventListener("click", autoLips);

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

syncToolsUI();
updateAutoButtonState();
setStatus("");
