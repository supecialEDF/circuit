// ワイヤ → ネット名の決め方（src/ui/netsync.js）の単体テスト。
// 使い方: node tools/test_netsync.mjs
// 「画面に見えている接続」と「シミュレーションに渡す接続」が一致することを確かめる。
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import fs from "fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { computeConnects } = await imp("src/ui/netsync.js");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "data/components.json"), "utf-8")).components;
const pinNamesOf = (t) => catalog.find((c) => c.type === t)?.pinNames ?? [];

let pass = 0;
let fail = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else {
    fail += 1;
    console.log(`NG ${name}\n   実際: ${a}\n   期待: ${e}`);
  }
};
const w = (a, ap, b, bp) => ({ from: { componentId: a, pin: ap }, to: { componentId: b, pin: bp } });

// J-01 の固定部品
const fixed = [
  { id: "V1", type: "V_DC", locked: true, connect: ["vin", "gnd"] },
  { id: "TPV", type: "TP", locked: true, connect: ["vin"] },
  { id: "RL", type: "R", locked: true, connect: ["out", "gnd"] },
  { id: "TPO", type: "TP", locked: true, connect: ["out"] },
];
const original = new Map(fixed.map((c) => [c.id, [...c.connect]]));
const run = (components, wires) =>
  Object.fromEntries(computeConnects({ components, wires, pinNamesOf, originalConnectOf: (id) => original.get(id) ?? null }));

// 1. 今回の不具合: V2 の p に以前の "vin" が残っていても、ワイヤで ctrl_p とつないだら vin にならない
{
  const comps = [
    ...fixed,
    { id: "SWV1", type: "SW_V", connect: [] },
    { id: "V2", type: "V_PULSE", connect: ["vin", ""] }, // 古いネット名が残った状態
    { id: "GND1", type: "GND", connect: [] },
    { id: "GND2", type: "GND", connect: [] },
  ];
  const wires = [w("TPV", "p", "SWV1", "1"), w("SWV1", "2", "TPO", "p"), w("SWV1", "ctrl_p", "V2", "p"), w("SWV1", "ctrl_n", "GND1", "gnd"), w("V2", "n", "GND2", "gnd")];
  const r = run(comps, wires);
  eq("1. SW_V", r.SWV1, ["vin", "out", "net1", "gnd"]);
  eq("1. V2 は vin にならない", r.V2, ["net1", "gnd"]);
}

// 2. ワイヤがつながっていない端子は未接続（以前の名前が残っていても消える）
{
  const r = run([...fixed, { id: "R1", type: "R", connect: ["vin", "out"] }], []);
  eq("2. 配線なしの R1", r.R1, ["", ""]);
}

// 3. 固定部品どうしをワイヤでつなぐと合流し、ワイヤを消すと元の名前に戻る
{
  const comps = fixed.map((c) => ({ ...c }));
  const merged = run(comps, [w("TPV", "p", "TPO", "p")]);
  eq("3. 合流（vin と out が同じネット）", [merged.TPV[0], merged.TPO[0], merged.RL[0]], ["vin", "vin", "vin"]);
  // 合流した名前が connect に書き込まれた後でも、ワイヤを消せば問題データの名前に戻る
  const after = run(comps.map((c) => ({ ...c, connect: merged[c.id] })), []);
  eq("3. 元に戻る", [after.TPO[0], after.RL], ["out", ["out", "gnd"]]);
}

// 4. GND 記号につないだ端子は gnd。電源の ＋ を GND につなげば（見た目どおり）短絡になる
{
  const comps = [...fixed, { id: "GND1", type: "GND", connect: [] }];
  const r = run(comps, [w("TPV", "p", "GND1", "gnd")]);
  eq("4. vin を GND につなぐと V1 の両端が gnd", r.V1, ["gnd", "gnd"]);
}

// 5. プレイヤーのネット名は、つなぎ方が変わらなければ同じ名前を保つ
{
  const comps = [...fixed, { id: "R1", type: "R", connect: ["vin", "x7"] }, { id: "C1", type: "C", connect: ["x7", "gnd"] }];
  const r = run(comps, [w("TPV", "p", "R1", "1"), w("R1", "2", "C1", "1"), w("C1", "2", "RL", "2")]);
  eq("5. 名前 x7 を保つ", [r.R1, r.C1], [["vin", "x7"], ["x7", "gnd"]]);
}

// 6. ワイヤを消して 2 つに分かれたら、片方は別の名前になる（同じ名前のままにしない）
{
  const comps = [
    { id: "R1", type: "R", connect: ["", "net1"] },
    { id: "R2", type: "R", connect: ["net1", "net1"] },
    { id: "R3", type: "R", connect: ["net1", ""] },
  ];
  const r = run(comps, [w("R1", "2", "R2", "1"), w("R2", "2", "R3", "1")]);
  eq("6. 2 つのグループは別の名前", [r.R1[1], r.R2[0], r.R2[1], r.R3[0]], ["net1", "net1", "net2", "net2"]);
}

// 7. プレイヤーの古い名前が固定ネットの名前（vin, out, gnd）なら使わない
{
  const comps = [...fixed, { id: "R1", type: "R", connect: ["out", "gnd"] }, { id: "R2", type: "R", connect: ["out", ""] }];
  const r = run(comps, [w("R1", "1", "R2", "1")]);
  eq("7. out ではなく net1", [r.R1, r.R2], [["net1", ""], ["net1", ""]]);
}

// 8. 実際の J-01 の回路として解析し、ワイヤを消してつなぎ直した場合も合格する
{
  const { simulate } = await imp("src/sim/simulator.js");
  const { setupReady } = await imp("src/sim/setup.js");
  await setupReady;
  const { componentRegistry } = await imp("src/components/registry.js");
  componentRegistry.load({ components: catalog });
  const { runChecks } = await imp("src/checks/runner.js");
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "data/problems/J/J-01.json"), "utf-8"));
  const comps = [
    ...p.fixedComponents.map((c) => ({ ...c })),
    { id: "SWV1", type: "SW_V", params: {}, connect: [] },
    { id: "V2", type: "V_PULSE", params: { Vlow: 0, Vhigh: 5, widthSec: 1.25e-5, periodSec: 5e-5 }, connect: ["vin", "gnd"] },
    { id: "GND1", type: "GND", params: {}, connect: [] },
  ];
  const wires = [w("TPV", "p", "SWV1", "1"), w("SWV1", "2", "TPO", "p"), w("SWV1", "ctrl_p", "V2", "p"), w("SWV1", "ctrl_n", "GND1", "gnd"), w("V2", "n", "GND1", "gnd")];
  const next = computeConnects({ components: comps, wires, pinNamesOf, originalConnectOf: (id) => p.fixedComponents.find((c) => c.id === id)?.connect ?? null });
  const board = { components: comps.map((c) => ({ position: { x: 0, y: 0 }, rotation: 0, params: {}, ...c, connect: next.get(c.id) })), wires: [], nodes: [] };
  const sim = await simulate(board, { mode: p.judge, checks: p.checks, problem: p });
  const res = await runChecks(p, sim, board, { answers: {} });
  eq("8. J-01 がすべて合格", res.map((x) => x.ok), p.checks.map(() => true));
}

console.log(`[test_netsync] 合格 ${pass} / 失敗 ${fail}`);
process.exit(fail ? 1 : 0);
