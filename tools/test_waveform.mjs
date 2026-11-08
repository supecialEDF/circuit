// 波形ビューア（src/ui/waveform.js）の純粋関数の単体テスト。
// 使い方: node tools/test_waveform.mjs
// localStorage が無い Node でも読み込めることも確認する。
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import fs from "fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const W = await imp("src/ui/waveform.js");

let pass = 0;
let fail = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function ok(name, cond, info = "") {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log("NG", name, info);
  }
}

// --- 不等間隔の刻みでも平均・実効値が正しい ---
{
  // 0〜1 s の正弦波 1 周期、刻みは前半を細かく後半を粗く
  const time = [];
  for (let k = 0; k <= 400; k += 1) time.push((k / 400) * 0.5);
  for (let k = 1; k <= 100; k += 1) time.push(0.5 + (k / 100) * 0.5);
  const sine = time.map((t) => 10 * Math.sin(2 * Math.PI * t));
  const st = W.windowStats(time, sine, 0, 1);
  ok("sine avg≈0", Math.abs(st.avg) < 0.01, st.avg);
  ok("sine rms≈7.07", near(st.rms, 10 / Math.SQRT2, 2e-3), st.rms);
  ok("sine pp≈20", near(st.pp, 20, 1e-3), st.pp);

  const sq = time.map((t) => (t < 0.25 ? 5 : 0)); // デューティ 25%
  const s2 = W.windowStats(time, sq, 0, 1);
  ok("pulse avg≈1.25", near(s2.avg, 1.25, 0.02), s2.avg);

  // 区間の端が刻みの途中でも補間する
  const ramp = time.map((t) => t);
  const s3 = W.windowStats(time, ramp, 0.1234, 0.8765);
  ok("ramp avg = midpoint", near(s3.avg, (0.1234 + 0.8765) / 2, 1e-9), s3.avg);
  ok("ramp min", near(s3.min, 0.1234, 1e-9), s3.min);
}

// --- 間引きで細いパルスが消えない ---
{
  const N = 100000;
  const time = Array.from({ length: N }, (_, k) => k * 1e-6);
  const v = time.map((_, k) => (k % 1000 < 3 ? 12 : 0)); // 1 kHz、幅 3 µs のパルス
  const pts = W.decimate(time, v, 0, time[N - 1], 400);
  ok("decimate reduces points", pts.length < 400 * 4 + 4, pts.length);
  ok("decimate keeps narrow pulses", pts.filter((p) => p.v === 12).length >= 90, pts.filter((p) => p.v === 12).length);
  ok("decimate time-ordered", pts.every((p, k) => k === 0 || p.t >= pts[k - 1].t));
  const few = W.decimate([0, 1, 2], [0, 1, 0], 0.5, 1.5, 400);
  ok("decimate interpolates edges", few[0].t === 0.5 && near(few[0].v, 0.5, 1e-12) && few[few.length - 1].t === 1.5, JSON.stringify(few));
}

// --- 目盛り ---
{
  const s = W.niceScale(-0.03, 11.7, 5);
  ok("niceScale covers", s.min <= -0.03 && s.max >= 11.7, JSON.stringify(s));
  ok("niceScale step 1-2-5", [1, 2, 5].includes(Math.round(s.step / 10 ** Math.floor(Math.log10(s.step)))), s.step);
  const flat = W.niceScale(5, 5, 4);
  ok("niceScale flat signal", flat.max > flat.min, JSON.stringify(flat));
}

// --- 実際の問題で、チェックの値と表の統計が一致する ---
{
  const { simulate } = await imp("src/sim/simulator.js");
  const { setupReady } = await imp("src/sim/setup.js");
  await setupReady;
  const { componentRegistry } = await imp("src/components/registry.js");
  componentRegistry.load(JSON.parse(fs.readFileSync(path.join(ROOT, "data/components.json"), "utf-8")));
  const { runChecks } = await imp("src/checks/runner.js");

  let compared = 0;
  for (const id of ["J-07", "F-05", "J-16"]) {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, `data/problems/${id[0]}/${id}.json`), "utf-8"));
    const comps = [...p.fixedComponents, ...p.referenceSolution].map((c) => ({ params: {}, position: { x: 0, y: 0 }, rotation: 0, ...c }));
    const board = { components: comps, wires: [], nodes: [] };
    const res = await simulate(board, { mode: p.judge, checks: p.checks, problem: p });
    const tr = res.transient;
    const signals = W.listSignals(tr);
    ok(`${id} signals`, signals.length > 0);
    const sel = W.defaultSelection(signals, p, comps);
    ok(`${id} default selection non-empty`, sel.length > 0, sel);
    const results = await runChecks(p, res, board, { answers: p.referenceAnswers ?? {} });
    p.checks.forEach((c, k) => {
      if (c.type !== "transientMeasure" || !["average", "rms", "pp", "max", "min"].includes(c.measure) || !c.node || c.nodeRef) return;
      const s = signals.find((q) => q.key === `n:${c.node}`);
      const st = W.windowStats(tr.time, s.values, c.fromSec, c.toSec);
      const mine = { average: st.avg, rms: st.rms, pp: st.pp, max: st.max, min: st.min }[c.measure];
      const theirs = results[k]?.actual;
      compared += 1;
      ok(`${id} ${c.measure}(${c.node}) matches checker`, Number.isFinite(theirs) && near(mine, theirs, 0.01), `${mine} vs ${theirs}`);
    });
    const m = W.checkMarkers(p);
    ok(`${id} check windows`, m.windows.length > 0, JSON.stringify(m));
  }
  ok("compared with checker at least 3 times", compared >= 3, compared);
}

console.log(`[test_waveform] 合格 ${pass} / 失敗 ${fail}`);
process.exit(fail ? 1 : 0);
