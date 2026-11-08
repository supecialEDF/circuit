/**
 * 波形ビューア（過渡解析の結果をボードの下にグラフ表示する）。
 *
 * - app.js の renderBoard から renderWaveDockHtml() を呼んで枠を出し、
 *   DOM に入った後で bindWaveDock() がグラフ（SVG）を描く。
 * - app.js は状態が変わるたびに画面全体を innerHTML で作り直すので、
 *   ビューアの表示状態（開閉・高さ・選んだ信号・表示範囲）はこのモジュールの変数に持つ。
 * - 前半は DOM に依存しない純粋関数（tools/test_waveform.mjs で単体テストする）。
 */

import { formatMetricValue } from "../core/units.js";
import { getStorageKey } from "../config.js";

/* ==========================================================================
   純粋関数（テスト対象）
   ========================================================================== */

/** 表示色（暗い背景で区別しやすい順）。 */
export const TRACE_COLORS = ["#38bdf8", "#fbbf24", "#34d399", "#f472b6", "#a78bfa", "#fb923c", "#e5e7eb", "#22d3ee"];

/**
 * 過渡解析の結果から、表示できる信号の一覧を作ります。
 * - ノード電圧 V(net)（gnd は除く）
 * - 素子電流 I(id)（素子の 1 番目の端子から素子に流れ込む向きが正）
 * - 素子の両端電圧 V(id)（1 番目の端子 − 2 番目の端子）
 *
 * @param {object} tr  simulate() の結果の transient
 * @returns {{key:string, group:"node"|"current"|"elemV", name:string, label:string, unit:"V"|"A", values:number[]}[]}
 */
export function listSignals(tr) {
  const out = [];
  if (!tr || !Array.isArray(tr.time)) return out;
  const n = tr.time.length;
  const ok = (arr) => Array.isArray(arr) && arr.length === n;

  for (const [net, values] of Object.entries(tr.nodes ?? {})) {
    if (net === "gnd" || !ok(values)) continue;
    out.push({ key: `n:${net}`, group: "node", name: net, label: `V(${net})`, unit: "V", values });
  }
  for (const [id, arr] of Object.entries(tr.elements ?? {})) {
    if (ok(arr?.i)) out.push({ key: `i:${id}`, group: "current", name: id, label: `I(${id})`, unit: "A", values: arr.i });
  }
  for (const [id, arr] of Object.entries(tr.elements ?? {})) {
    if (ok(arr?.v)) out.push({ key: `v:${id}`, group: "elemV", name: id, label: `V(${id})`, unit: "V", values: arr.v });
  }
  return out;
}

/**
 * 判定（checks）から、波形に重ねて示す「判定区間」と「判定時刻」を集めます。
 *
 * @param {object | null} problem
 * @returns {{windows: {t0:number, t1:number}[], points: number[]}}
 */
export function checkMarkers(problem) {
  const windows = [];
  const points = [];
  for (const c of problem?.checks ?? []) {
    const t0 = Number(c.fromSec);
    const t1 = Number(c.toSec);
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
      if (!windows.some((w) => Math.abs(w.t0 - t0) < 1e-12 && Math.abs(w.t1 - t1) < 1e-12)) windows.push({ t0, t1 });
    }
    const tp = Number(c.timeSec);
    if (c.type === "transientPoint" && Number.isFinite(tp) && !points.includes(tp)) points.push(tp);
  }
  windows.sort((a, b) => a.t0 - b.t0);
  return { windows, points: points.sort((a, b) => a - b) };
}

/**
 * 最初に表示する信号を選びます（最大 4 本）。
 * 1. 判定で見ているノード（node / nodeRef / input / output）
 * 2. 判定で電流を見ている素子（element、または match.type が一致する素子）
 * 3. テストポイント（TP）のノード
 * 4. それでも無ければ、gnd 以外の最初のノード 2 本
 *
 * @param {ReturnType<typeof listSignals>} signals
 * @param {object | null} problem
 * @param {{type:string, id:string, connect?:string[]}[]} components
 * @returns {string[]}
 */
export function defaultSelection(signals, problem, components = []) {
  const keys = new Set(signals.map((s) => s.key));
  const picked = [];
  const add = (k) => {
    if (keys.has(k) && !picked.includes(k) && picked.length < 4) picked.push(k);
  };

  const checks = problem?.checks ?? [];
  for (const c of checks) {
    for (const f of ["node", "nodeRef", "output", "input"]) {
      if (typeof c[f] === "string") add(`n:${c[f]}`);
    }
  }
  for (const c of checks) {
    if (c.quantity !== "i") continue;
    if (typeof c.element === "string") add(`i:${c.element}`);
    const t = c.match?.type;
    if (t) for (const comp of components) if (comp.type === t) add(`i:${comp.id}`);
  }
  for (const comp of components) {
    if (comp.type === "TP" && Array.isArray(comp.connect) && comp.connect[0]) add(`n:${comp.connect[0]}`);
  }
  if (picked.length === 0) {
    for (const s of signals) if (s.group === "node" && picked.length < 2) picked.push(s.key);
  }
  return picked;
}

/** time（単調増加）で t 以上になる最初の添字。 */
export function lowerIndex(time, t) {
  let lo = 0;
  let hi = time.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 時刻 t の値（線形補間。範囲外は端の値）。 */
export function valueAt(time, values, t) {
  const n = Math.min(time.length, values.length);
  if (n === 0) return NaN;
  if (t <= time[0]) return values[0];
  if (t >= time[n - 1]) return values[n - 1];
  const j = lowerIndex(time, t);
  const t0 = time[j - 1];
  const t1 = time[j];
  if (t1 === t0) return values[j];
  return values[j - 1] + ((values[j] - values[j - 1]) * (t - t0)) / (t1 - t0);
}

/**
 * 区間 [t0, t1] の統計（時間で重みをつけた台形積分。刻みが不等間隔でも正しい）。
 *
 * @returns {{avg:number, rms:number, min:number, max:number, pp:number}}
 */
export function windowStats(time, values, t0, t1) {
  const nan = { avg: NaN, rms: NaN, min: NaN, max: NaN, pp: NaN };
  const n = Math.min(time.length, values.length);
  if (n < 2 || !(t1 > t0)) return nan;
  const a = Math.max(t0, time[0]);
  const b = Math.min(t1, time[n - 1]);
  if (!(b > a)) return nan;

  // 区間の端は補間した点、中は元のサンプル
  const ts = [a];
  const vs = [valueAt(time, values, a)];
  for (let j = lowerIndex(time, a); j < n && time[j] < b; j += 1) {
    if (time[j] > a) {
      ts.push(time[j]);
      vs.push(values[j]);
    }
  }
  ts.push(b);
  vs.push(valueAt(time, values, b));

  let s1 = 0;
  let s2 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < ts.length; k += 1) {
    const v = vs[k];
    if (v < min) min = v;
    if (v > max) max = v;
    if (k > 0) {
      const dt = ts[k] - ts[k - 1];
      const p = vs[k - 1];
      s1 += ((p + v) / 2) * dt;
      // 区間内で直線とみなした v² の厳密な積分
      s2 += ((p * p + p * v + v * v) / 3) * dt;
    }
  }
  const T = b - a;
  return { avg: s1 / T, rms: Math.sqrt(Math.max(s2 / T, 0)), min, max, pp: max - min };
}

/**
 * 描画用に間引きます。1 ピクセル列ごとに「最初・最小・最大・最後」を時刻順に残すので、
 * PWM のような細いパルスや急な切り替わりも消えません。
 * サンプルがピクセル数の 2 倍以下なら間引かずに返します（区間の端は補間した点を足す）。
 *
 * @returns {{t:number, v:number}[]}
 */
export function decimate(time, values, t0, t1, columns) {
  const n = Math.min(time.length, values.length);
  if (n === 0 || !(t1 > t0)) return [];
  const i0 = Math.max(lowerIndex(time, t0) - 1, 0);
  const i1 = Math.min(lowerIndex(time, t1) + 1, n);
  const cols = Math.max(1, Math.floor(columns));

  const pts = [];
  if (time[i0] < t0) pts.push({ t: t0, v: valueAt(time, values, t0) });

  if (i1 - i0 <= cols * 2) {
    for (let j = i0; j < i1; j += 1) if (time[j] >= t0 && time[j] <= t1) pts.push({ t: time[j], v: values[j] });
  } else {
    const span = (t1 - t0) / cols;
    let j = i0;
    for (let c = 0; c < cols; c += 1) {
      const cEnd = t0 + span * (c + 1);
      let first = -1;
      let last = -1;
      let jMin = -1;
      let jMax = -1;
      for (; j < i1 && time[j] <= cEnd; j += 1) {
        if (time[j] < t0) continue;
        if (first < 0) first = j;
        last = j;
        if (jMin < 0 || values[j] < values[jMin]) jMin = j;
        if (jMax < 0 || values[j] > values[jMax]) jMax = j;
      }
      if (first < 0) continue;
      const idx = [...new Set([first, jMin, jMax, last])].sort((p, q) => p - q);
      for (const k of idx) pts.push({ t: time[k], v: values[k] });
    }
  }

  if (time[i1 - 1] > t1) pts.push({ t: t1, v: valueAt(time, values, t1) });
  return pts;
}

/**
 * 見やすい目盛り（1, 2, 5 × 10^k 刻み）。
 *
 * @returns {{min:number, max:number, step:number, ticks:number[]}}
 */
export function niceScale(lo, hi, target = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-15 * Math.max(1, Math.abs(hi))) {
    const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = min; v <= max + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { min, max, step, ticks };
}

/** 数値を単位つきで短く表示（有効数字 3〜4 桁）。 */
export function fmt(value, unit) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1e-12) value = 0; // 数値誤差（1e-20 V など）は 0 と表示
  return formatMetricValue(Number(value.toPrecision(4)), unit, { maxDecimals: 3 });
}

/* ==========================================================================
   表示状態（モジュール変数）
   ========================================================================== */

const DOCK_MIN_H = 160;
const DOCK_DEFAULT_H = 330;
const PLOT_PAD_L = 64;
const PLOT_PAD_R = 14;

const view = {
  open: true,
  height: DOCK_DEFAULT_H,
  problemId: null,
  resultRef: null,
  selected: null, // string[]（null なら自動選択）
  userSelected: false,
  range: null, // {t0, t1}（null なら全体）
  cursorT: null,
};

try {
  const saved = JSON.parse(localStorage.getItem(getStorageKey("waveDock")) ?? "null");
  if (saved && typeof saved === "object") {
    if (typeof saved.open === "boolean") view.open = saved.open;
    if (Number.isFinite(saved.height)) view.height = Math.max(DOCK_MIN_H, saved.height);
  }
} catch {
  /* 保存できない環境でも動作は続ける */
}

function saveDock() {
  try {
    localStorage.setItem(getStorageKey("waveDock"), JSON.stringify({ open: view.open, height: view.height }));
  } catch {
    /* 無視 */
  }
}

let plotObserver = null;
let svgCache = { key: "", html: "", layout: null };

function judgeHasTransient(problem) {
  const j = problem?.judge;
  return Array.isArray(j) ? j.includes("transient") : j === "transient";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 結果・問題が変わったときに表示状態を合わせる。 */
function syncView(state, tr, signals) {
  const problemId = state.currentProblem?.id ?? null;
  if (problemId !== view.problemId) {
    view.problemId = problemId;
    view.selected = null;
    view.userSelected = false;
    view.range = null;
    view.cursorT = null;
  }
  if (tr !== view.resultRef) {
    view.resultRef = tr;
    view.range = null;
    view.cursorT = null;
    if (!view.userSelected) view.selected = null;
  }
  const keys = new Set(signals.map((s) => s.key));
  if (view.selected) view.selected = view.selected.filter((k) => keys.has(k));
  if (!view.selected || view.selected.length === 0) {
    view.selected = defaultSelection(signals, state.currentProblem, state.board?.components ?? []);
  }
}

function fullRange(tr) {
  const n = tr.time.length;
  return { t0: tr.time[0], t1: tr.time[n - 1] };
}

function currentRange(tr) {
  const full = fullRange(tr);
  const r = view.range;
  if (!r) return full;
  const t0 = Math.max(full.t0, r.t0);
  const t1 = Math.min(full.t1, r.t1);
  return t1 > t0 ? { t0, t1 } : full;
}

/* ==========================================================================
   HTML（枠）
   ========================================================================== */

/**
 * ボードの下に置く波形パネルの HTML。過渡解析が関係ない問題では空文字。
 *
 * @param {object} state getState()
 */
export function renderWaveDockHtml(state) {
  const tr = state.simulation?.result?.transient;
  const hasData = Boolean(tr && Array.isArray(tr.time) && tr.time.length > 1);
  if (!hasData && !judgeHasTransient(state.currentProblem)) return "";

  const head = (extra = "") => `
    <div class="wave-head">
      <button type="button" class="wave-toggle" data-wave="toggle" aria-expanded="${view.open}">
        ${view.open ? "▾" : "▸"} 波形
      </button>
      ${extra}
    </div>`;

  if (!hasData) {
    return `
      <section class="wave-dock is-empty" id="wave-dock">
        ${head(`<span class="wave-hint">「シミュレーション」または「チェック」を押すと、ここに電圧・電流の波形が表示されます。</span>`)}
      </section>`;
  }

  const signals = listSignals(tr);
  syncView(state, tr, signals);
  const markers = checkMarkers(state.currentProblem);
  const freq = Number(tr.waveformFrequencyHz);
  const full = fullRange(tr);

  const btn = (id, label, title, enabled = true) =>
    `<button type="button" class="wave-range-btn" data-wave-range="${id}" title="${escapeHtml(title)}" ${enabled ? "" : "disabled"}>${label}</button>`;
  const hasWindow = markers.windows.length > 0;
  const hasFreq = Number.isFinite(freq) && freq > 0 && 5 / freq < full.t1 - full.t0;

  const rangeBtns = `
    <span class="wave-range" role="group" aria-label="表示範囲">
      ${btn("all", "全体", "解析した全時間を表示")}
      ${btn("check", "判定区間", "チェックが値を測る区間を表示", hasWindow)}
      ${btn("last5", "最後の5周期", "定常に入った後の最後の 5 周期を表示", hasFreq)}
      ${btn("zoomout", "縮小", "表示範囲を 2 倍に広げる", Boolean(view.range))}
    </span>
    <span class="wave-hint" title="表の平均・実効値などは表示範囲の値です。「判定区間」を表示すると、チェックが測る区間と同じになります。">ドラッグで拡大・ダブルクリックで全体</span>`;

  const groups = [
    ["node", "ノード電圧"],
    ["current", "素子の電流"],
    ["elemV", "素子の両端電圧"],
  ];
  const colorOf = (key) => TRACE_COLORS[view.selected.indexOf(key) % TRACE_COLORS.length];
  const signalsHtml = groups
    .map(([g, title]) => {
      const items = signals.filter((s) => s.group === g);
      if (items.length === 0) return "";
      const open = g === "node" || items.some((s) => view.selected.includes(s.key));
      return `
        <details class="wave-group" ${open ? "open" : ""}>
          <summary>${title}<span class="wave-count">${items.length}</span></summary>
          <div class="wave-chips">
            ${items
              .map((s) => {
                const on = view.selected.includes(s.key);
                return `<label class="wave-chip ${on ? "is-on" : ""}" ${on ? `style="--trace:${colorOf(s.key)}"` : ""} title="${escapeHtml(
                  s.group === "current" ? `${s.label}: 素子の 1 番目の端子から流れ込む向きが正` : s.group === "elemV" ? `${s.label}: 1 番目の端子 − 2 番目の端子` : `${s.label}: gnd 基準`
                )}">
                  <input type="checkbox" data-wave-signal="${escapeHtml(s.key)}" ${on ? "checked" : ""} />
                  <span>${escapeHtml(s.label)}</span>
                </label>`;
              })
              .join("")}
          </div>
        </details>`;
    })
    .join("");

  return `
    <section class="wave-dock ${view.open ? "" : "is-collapsed"}" id="wave-dock" style="${view.open ? `height:${view.height}px` : ""}">
      ${view.open ? `<div class="wave-resize" data-wave="resize" title="ドラッグで高さを変更（ダブルクリックで元に戻す）"></div>` : ""}
      ${head(view.open ? rangeBtns : `<span class="wave-hint">${signals.length} 個の信号（クリックで開く）</span>`)}
      ${
        view.open
          ? `<div class="wave-body">
               <div class="wave-signals">${signalsHtml}</div>
               <div class="wave-main">
                 <div class="wave-plots" id="wave-plots"></div>
                 <div class="wave-stats" id="wave-stats"></div>
               </div>
             </div>`
          : ""
      }
    </section>`;
}

/* ==========================================================================
   グラフ（SVG）
   ========================================================================== */

function buildPlots(tr, signals, width, height, markers) {
  const { t0, t1 } = currentRange(tr);
  const sel = view.selected.map((k) => signals.find((s) => s.key === k)).filter(Boolean);
  const panels = ["V", "A"]
    .map((unit) => ({ unit, traces: sel.filter((s) => s.unit === unit) }))
    .filter((p) => p.traces.length > 0);

  const axisH = 22;
  const gap = 16;
  const padTop = 8;
  const plotW = Math.max(40, width - PLOT_PAD_L - PLOT_PAD_R);
  const xOf = (t) => PLOT_PAD_L + ((t - t0) / (t1 - t0)) * plotW;

  if (panels.length === 0) {
    return {
      html: `<div class="wave-empty">左の一覧から、表示する信号を選んでください。</div>`,
      layout: null,
    };
  }

  const panelH = Math.max(40, (height - padTop - axisH - gap * (panels.length - 1)) / panels.length);
  const time = tr.time;
  let svg = "";
  const layoutPanels = [];

  panels.forEach((p, pi) => {
    const top = padTop + pi * (panelH + gap);
    const lines = p.traces.map((s) => ({ s, pts: decimate(time, s.values, t0, t1, plotW) }));
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of lines) for (const q of l.pts) {
      if (q.v < lo) lo = q.v;
      if (q.v > hi) hi = q.v;
    }
    const sc = niceScale(lo, hi, Math.max(2, Math.min(6, Math.round(panelH / 30))));
    const yOf = (v) => top + panelH - ((v - sc.min) / (sc.max - sc.min)) * panelH;

    svg += `<rect class="wave-bg" x="${PLOT_PAD_L}" y="${top}" width="${plotW}" height="${panelH}"></rect>`;
    // 判定区間（網かけ）と判定時刻
    for (const w of markers.windows) {
      const a = Math.max(w.t0, t0);
      const b = Math.min(w.t1, t1);
      if (b > a) svg += `<rect class="wave-window" x="${xOf(a)}" y="${top}" width="${Math.max(1, xOf(b) - xOf(a))}" height="${panelH}"><title>判定区間 ${fmt(w.t0, "s")}〜${fmt(w.t1, "s")}</title></rect>`;
    }
    for (const tp of markers.points) {
      if (tp >= t0 && tp <= t1) svg += `<line class="wave-checkpoint" x1="${xOf(tp)}" x2="${xOf(tp)}" y1="${top}" y2="${top + panelH}"><title>判定時刻 ${fmt(tp, "s")}</title></line>`;
    }
    // 目盛りの数は高さに合わせ、ラベル同士が 14px 以上離れるものだけ書く
    let lastLabelY = -Infinity;
    for (const v of [...sc.ticks].reverse()) {
      const y = yOf(v);
      svg += `<line class="${v === 0 ? "wave-zero" : "wave-grid"}" x1="${PLOT_PAD_L}" x2="${PLOT_PAD_L + plotW}" y1="${y}" y2="${y}"></line>`;
      if (y - lastLabelY >= 14) {
        svg += `<text class="wave-ylabel" x="${PLOT_PAD_L - 6}" y="${y + 4}" text-anchor="end">${escapeHtml(fmt(v, p.unit))}</text>`;
        lastLabelY = y;
      }
    }
    for (const l of lines) {
      if (l.pts.length === 0) continue;
      const color = TRACE_COLORS[view.selected.indexOf(l.s.key) % TRACE_COLORS.length];
      const d = l.pts.map((q, k) => `${k ? "L" : "M"}${xOf(q.t).toFixed(1)} ${yOf(q.v).toFixed(1)}`).join("");
      svg += `<path class="wave-trace" d="${d}" stroke="${color}"></path>`;
    }
    svg += `<text class="wave-unit" x="6" y="${top + panelH / 2 + 4}">${p.unit === "V" ? "電圧" : "電流"}</text>`;
    layoutPanels.push({ top, height: panelH, unit: p.unit, sc, traces: p.traces });
  });

  // 時間軸
  const bottom = padTop + panels.length * panelH + gap * (panels.length - 1);
  const xs = niceScale(t0, t1, Math.max(2, Math.round(plotW / 90)));
  for (const t of xs.ticks) {
    if (t < t0 - 1e-15 || t > t1 + 1e-15) continue;
    const x = xOf(t);
    svg = `<line class="wave-grid" x1="${x}" x2="${x}" y1="${padTop}" y2="${bottom}"></line>` + svg;
    svg += `<text class="wave-xlabel" x="${x}" y="${bottom + 15}" text-anchor="middle">${escapeHtml(fmt(t, "s"))}</text>`;
  }
  svg += `<line class="wave-cursor" id="wave-cursor" x1="0" x2="0" y1="0" y2="${bottom}" visibility="hidden"></line>`;
  svg += `<rect class="wave-select" id="wave-select" x="0" y="0" width="0" height="${bottom}" visibility="hidden"></rect>`;

  return {
    html: `<svg class="wave-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`,
    layout: { t0, t1, plotW, bottom, panels: layoutPanels },
  };
}

function buildStats(tr, signals) {
  const { t0, t1 } = currentRange(tr);
  const sel = view.selected.map((k) => signals.find((s) => s.key === k)).filter(Boolean);
  if (sel.length === 0) return "";
  const cursor = view.cursorT;
  const rows = sel
    .map((s) => {
      const st = windowStats(tr.time, s.values, t0, t1);
      const color = TRACE_COLORS[view.selected.indexOf(s.key) % TRACE_COLORS.length];
      const cur = cursor === null ? "—" : fmt(valueAt(tr.time, s.values, cursor), s.unit);
      return `<tr>
        <td><span class="wave-swatch" style="background:${color}"></span>${escapeHtml(s.label)}</td>
        <td class="wave-cur" data-wave-cur="${escapeHtml(s.key)}">${cur}</td>
        <td>${fmt(st.avg, s.unit)}</td><td>${fmt(st.rms, s.unit)}</td>
        <td>${fmt(st.min, s.unit)}</td><td>${fmt(st.max, s.unit)}</td><td>${fmt(st.pp, s.unit)}</td>
      </tr>`;
    })
    .join("");
  return `
    <table class="wave-table">
      <thead><tr>
        <th title="統計は表示範囲（${fmt(t0, "s")}〜${fmt(t1, "s")}）の値。「判定区間」を表示すると、チェックが測る値とほぼ同じになる">信号（${fmt(t0, "s")}〜${fmt(t1, "s")}）</th><th id="wave-cur-head">${cursor === null ? "カーソル" : `t = ${fmt(cursor, "s")}`}</th>
        <th title="表示範囲の時間平均">平均</th><th title="表示範囲の実効値（RMS）">実効値</th>
        <th>最小</th><th>最大</th><th title="最大 − 最小">p-p</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
`;
}

/* ==========================================================================
   イベント
   ========================================================================== */

/**
 * 波形パネルを描画し、操作を結び付けます（renderBoard の後に呼ぶ）。
 *
 * @param {HTMLElement} root
 * @param {object} state getState()
 * @param {{ rerender: () => void }} hooks
 */
export function bindWaveDock(root, state, hooks) {
  const dock = root.querySelector("#wave-dock");
  if (plotObserver) {
    plotObserver.disconnect();
    plotObserver = null;
  }
  if (!dock) return;

  dock.querySelector('[data-wave="toggle"]')?.addEventListener("click", () => {
    view.open = !view.open;
    saveDock();
    hooks.rerender();
  });

  const tr = state.simulation?.result?.transient;
  if (!view.open || !tr || !Array.isArray(tr.time) || tr.time.length < 2) return;

  const signals = listSignals(tr);
  const markers = checkMarkers(state.currentProblem);
  const plotsEl = dock.querySelector("#wave-plots");
  const statsEl = dock.querySelector("#wave-stats");

  const draw = () => {
    // 表を先に入れてから、残った高さでグラフを描く（後から表を入れるとグラフの下が切れる）
    statsEl.innerHTML = buildStats(tr, signals);
    const w = Math.floor(plotsEl.clientWidth);
    const h = Math.floor(plotsEl.clientHeight);
    if (w < 60 || h < 60) {
      plotsEl.innerHTML = "";
      return;
    }
    const key = [view.selected.join(","), JSON.stringify(currentRange(tr)), w, h, tr.time.length].join("|");
    if (svgCache.key !== key || svgCache.tr !== tr) {
      const built = buildPlots(tr, signals, w, h, markers);
      svgCache = { key, tr, html: built.html, layout: built.layout };
    }
    plotsEl.innerHTML = svgCache.html;
    // 拡大・全体表示はボタンの状態（「縮小」の有効・無効）も変わるので画面全体を描き直す
    bindPlotPointer(plotsEl, statsEl, tr, signals, () => hooks.rerender());
  };

  // 信号の選択
  dock.querySelectorAll("[data-wave-signal]").forEach((box) => {
    box.addEventListener("change", () => {
      const k = box.dataset.waveSignal;
      view.userSelected = true;
      if (box.checked) {
        if (!view.selected.includes(k)) view.selected = [...view.selected, k];
      } else {
        view.selected = view.selected.filter((x) => x !== k);
      }
      hooks.rerender();
    });
  });

  // 表示範囲のボタン
  dock.querySelectorAll("[data-wave-range]").forEach((b) => {
    b.addEventListener("click", () => {
      const full = fullRange(tr);
      const id = b.dataset.waveRange;
      if (id === "all") view.range = null;
      if (id === "check" && markers.windows.length > 0) {
        const t0 = Math.min(...markers.windows.map((w) => w.t0));
        const t1 = Math.max(...markers.windows.map((w) => w.t1));
        view.range = { t0, t1 };
      }
      if (id === "last5") {
        const T = 1 / Number(tr.waveformFrequencyHz);
        view.range = { t0: full.t1 - 5 * T, t1: full.t1 };
      }
      if (id === "zoomout" && view.range) {
        const { t0, t1 } = currentRange(tr);
        const mid = (t0 + t1) / 2;
        const half = t1 - t0;
        const next = { t0: Math.max(full.t0, mid - half), t1: Math.min(full.t1, mid + half) };
        view.range = next.t0 <= full.t0 && next.t1 >= full.t1 ? null : next;
      }
      view.cursorT = null;
      hooks.rerender();
    });
  });

  // 高さの変更
  const handle = dock.querySelector('[data-wave="resize"]');
  if (handle) {
    handle.addEventListener("dblclick", () => {
      view.height = DOCK_DEFAULT_H;
      saveDock();
      hooks.rerender();
    });
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startY = ev.clientY;
      const startH = dock.getBoundingClientRect().height;
      const boardH = root.querySelector("#board")?.clientHeight ?? 800;
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        /* 無視 */
      }
      const move = (e) => {
        view.height = Math.round(Math.max(DOCK_MIN_H, Math.min(boardH - 160, startH + (startY - e.clientY))));
        dock.style.height = `${view.height}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        saveDock();
        draw();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  draw();
  if (typeof ResizeObserver === "function") {
    let lastW = plotsEl.clientWidth;
    let lastH = plotsEl.clientHeight;
    plotObserver = new ResizeObserver(() => {
      if (plotsEl.clientWidth !== lastW || plotsEl.clientHeight !== lastH) {
        lastW = plotsEl.clientWidth;
        lastH = plotsEl.clientHeight;
        draw();
      }
    });
    plotObserver.observe(plotsEl);
  }
}

/** カーソル（値の読み取り）とドラッグによる拡大。 */
function bindPlotPointer(plotsEl, statsEl, tr, signals, redraw) {
  const svg = plotsEl.querySelector("svg");
  const layout = svgCache.layout;
  if (!svg || !layout) return;
  const cursor = svg.querySelector("#wave-cursor");
  const sel = svg.querySelector("#wave-select");
  const toT = (x) => layout.t0 + ((x - PLOT_PAD_L) / layout.plotW) * (layout.t1 - layout.t0);
  const localX = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.max(PLOT_PAD_L, Math.min(PLOT_PAD_L + layout.plotW, e.clientX - r.left));
  };

  const showCursor = (x) => {
    const t = toT(x);
    view.cursorT = t;
    cursor.setAttribute("x1", x);
    cursor.setAttribute("x2", x);
    cursor.setAttribute("visibility", "visible");
    const head = statsEl.querySelector("#wave-cur-head");
    if (head) head.textContent = `t = ${fmt(t, "s")}`;
    statsEl.querySelectorAll("[data-wave-cur]").forEach((td) => {
      const s = signals.find((q) => q.key === td.dataset.waveCur);
      if (s) td.textContent = fmt(valueAt(tr.time, s.values, t), s.unit);
    });
  };
  if (view.cursorT !== null && view.cursorT >= layout.t0 && view.cursorT <= layout.t1) {
    showCursor(PLOT_PAD_L + ((view.cursorT - layout.t0) / (layout.t1 - layout.t0)) * layout.plotW);
  }

  let dragX = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragX = localX(e);
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* 無視 */
    }
  });
  svg.addEventListener("pointermove", (e) => {
    const x = localX(e);
    showCursor(x);
    if (dragX !== null) {
      sel.setAttribute("x", Math.min(dragX, x));
      sel.setAttribute("width", Math.abs(x - dragX));
      sel.setAttribute("visibility", "visible");
    }
  });
  svg.addEventListener("pointerup", (e) => {
    if (dragX === null) return;
    const x = localX(e);
    const a = Math.min(dragX, x);
    const b = Math.max(dragX, x);
    dragX = null;
    sel.setAttribute("visibility", "hidden");
    if (b - a >= 6) {
      view.range = { t0: toT(a), t1: toT(b) };
      redraw();
    }
  });
  svg.addEventListener("dblclick", () => {
    view.range = null;
    redraw();
  });
}
