/**
 * ワイヤからネット名（各部品の connect）を決める純粋関数（DOM に依存しない）。
 *
 * 方針: 「画面に見えている接続」と「シミュレーションに渡す接続」を必ず一致させる。
 * - プレイヤーが置いた部品（locked でない部品）の接続は、ワイヤだけで決まる。
 *   ワイヤがつながっていない端子は未接続（空文字）。以前に付いていたネット名は、
 *   名前を安定させるための候補としてだけ使い、ほかのネットと合流させる根拠にはしない。
 * - 固定部品（locked）の名前は、問題データの元の connect（originalConnectOf）から毎回取り直す。
 *   プレイヤーが固定部品どうしをワイヤでつないで名前が合流しても、ワイヤを消せば元に戻る。
 * - 同じ名前の固定ネットは画面のガイド線でつながって見えるので、最初から 1 つのネットにまとめる。
 *   プレイヤーがワイヤで別の固定ネットとつなげば、両方のネットの端子がすべて合流する（見た目どおり）。
 * - GND 部品と固定部品の gnd 端子は、どこにあっても 1 つの接地ネット "gnd"（接地記号の約束どおり）。
 *   接地とつながったグループは、ほかの固定ネットの名前を含んでいても "gnd"（見た目どおりの短絡）。
 *
 * tools/test_netsync.mjs で単体テストする。
 */

/**
 * @param {object} args
 * @param {{id:string, type:string, locked?:boolean, connect?:string[]}[]} args.components
 * @param {{from?:{componentId:string, pin:string|number}, to?:{componentId:string, pin:string|number}}[]} args.wires
 * @param {(type:string) => string[]} args.pinNamesOf  部品種別 → ピン名の配列（connect の順）
 * @param {(id:string) => (string[] | null)} [args.originalConnectOf]  固定部品の元の connect（無ければ現在の connect を使う）
 * @returns {Map<string, string[]>}  部品 ID → 新しい connect（ピン数と同じ長さ）
 */
export function computeConnects({ components, wires, pinNamesOf, originalConnectOf = () => null }) {
  const keyOf = (id, i) => `${id}::${i}`;
  const parent = new Map();
  const pinsOf = new Map();

  for (const c of components) {
    const names = pinNamesOf(c.type) ?? [];
    pinsOf.set(c.id, names);
    for (let i = 0; i < names.length; i += 1) parent.set(keyOf(c.id, i), keyOf(c.id, i));
  }

  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let cur = k;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur);
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const pinIndex = (end) => {
    if (!end) return -1;
    const names = pinsOf.get(end.componentId);
    if (!names) return -1;
    if (typeof end.pin === "number") return end.pin >= 0 && end.pin < names.length ? end.pin : -1;
    return names.indexOf(String(end.pin));
  };

  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  const fixedNameOf = (c, i) => {
    const orig = originalConnectOf(c.id);
    return clean(Array.isArray(orig) ? orig[i] : Array.isArray(c.connect) ? c.connect[i] : "");
  };

  // 画面で最初からつながって見えるもの（同じ名前の固定ネットはガイド線、GND 記号はどこでも同じ接地）を
  // 先に 1 つにまとめる。仮想の節点 "net::<名前>" に結び付ける。
  const netKey = (name) => {
    const k = `net::${name}`;
    if (!parent.has(k)) parent.set(k, k);
    return k;
  };
  for (const c of components) {
    const names = pinsOf.get(c.id);
    for (let i = 0; i < names.length; i += 1) {
      if (c.type === "GND") union(keyOf(c.id, i), netKey("gnd"));
      else if (c.locked) {
        const n = fixedNameOf(c, i);
        if (n) union(keyOf(c.id, i), netKey(n));
      }
    }
  }

  for (const w of wires ?? []) {
    const a = pinIndex(w.from);
    const b = pinIndex(w.to);
    if (a < 0 || b < 0) continue;
    if (w.from.componentId === w.to.componentId && a === b) continue;
    union(keyOf(w.from.componentId, a), keyOf(w.to.componentId, b));
  }

  // 固定部品が使っている名前（プレイヤーのネットには付けない）
  const fixedNames = new Set(["gnd"]);
  for (const c of components) {
    if (!c.locked) continue;
    const names = pinsOf.get(c.id);
    for (let i = 0; i < names.length; i += 1) {
      const n = fixedNameOf(c, i);
      if (n) fixedNames.add(n);
    }
  }

  // グループごとの情報（部品の並び順で集める＝結果が決定的になる）
  const groups = new Map();
  const order = [];
  for (const c of components) {
    const names = pinsOf.get(c.id);
    for (let i = 0; i < names.length; i += 1) {
      const root = find(keyOf(c.id, i));
      if (!groups.has(root)) {
        groups.set(root, { size: 0, ground: false, fixedName: "", previous: [], name: "" });
        order.push(root);
      }
      const g = groups.get(root);
      g.size += 1;
      if (c.type === "GND") g.ground = true;
      if (c.locked) {
        const n = fixedNameOf(c, i);
        if (n === "gnd") g.ground = true;
        if (n && !g.fixedName) g.fixedName = n;
      } else {
        const prev = clean(Array.isArray(c.connect) ? c.connect[i] : "");
        if (prev && !fixedNames.has(prev) && !g.previous.includes(prev)) g.previous.push(prev);
      }
    }
  }

  // 1) グラウンド・固定ネットの名前
  for (const root of order) {
    const g = groups.get(root);
    if (g.ground) g.name = "gnd";
    else if (g.fixedName) g.name = g.fixedName;
  }

  // 2) プレイヤーだけのネット（2 端子以上がワイヤでつながったもの）。
  //    以前の名前が他のグループと重ならなければ引き継ぎ、無ければ net1, net2, … を付ける。
  const used = new Set(fixedNames);
  const pending = [];
  for (const root of order) {
    const g = groups.get(root);
    if (g.name || g.size < 2) continue;
    const keep = g.previous.find((p) => !used.has(p));
    if (keep) {
      g.name = keep;
      used.add(keep);
    } else {
      pending.push(g);
    }
  }
  let auto = 1;
  for (const g of pending) {
    while (used.has(`net${auto}`)) auto += 1;
    g.name = `net${auto}`;
    used.add(g.name);
  }

  const result = new Map();
  for (const c of components) {
    const names = pinsOf.get(c.id);
    const connect = [];
    for (let i = 0; i < names.length; i += 1) {
      connect.push(groups.get(find(keyOf(c.id, i))).name || "");
    }
    result.set(c.id, connect);
  }
  return result;
}
