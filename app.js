"use strict";
// koto-hinan v2: 事前に計算した格子と経路の木を引くだけ（サーバを置かない）。外から来た文字は textContent でだけ入れる
// 地図: MapLibre GL JS 5.21.0（jsDelivr・SRI）＋ OpenFreeMap のベクトル（明るい＝positron・暗い＝dark）。浸水深は公式のラスタを重ねる
const SPEEDS = [1.0, 0.5];
const FLOOD = "https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png";
const OFM = "https://tiles.openfreemap.org";
const STYLE = { light: OFM + "/styles/positron", dark: OFM + "/styles/dark" };
const DEFAULT_REGION = "11222";  // 既定は越谷市（SPEC の体験 S2）
const $ = (id) => document.getElementById(id);
function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function minutes(m, v) { return Math.ceil(m / (v * 60)); }
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function shortMuni(s) { return (s || "").replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, "").replace(/^.+郡/, ""); }
function depthText(label) { return label.replace(/(\d)m/g, "$1 m"); }
const dark = matchMedia("(prefers-color-scheme: dark)");
const FLOOD_OPACITY = () => (dark.matches ? 0.85 : 0.7);  // 暗い表示でも 0.5〜3 m と 3〜5 m が分かれる値（画素で確かめた）
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const OLD_CLASSES = ["0.3m未満", "0.5〜1m"];

let G = null, R = null, OFF = null, CODE = null, BASE = null, routeP = null, BND = null, SITES = null, BOUNDS = null, FLOOD_ON = true;
const EMPTY = { type: "FeatureCollection", features: [] };
const state = { route: EMPTY, tap: EMPTY, dest: EMPTY };

dark.addEventListener("change", () => { if (map) map.setStyle(dark.matches ? STYLE.dark : STYLE.light); });
function setData(id, data) { state[id] = data; const s = map && map.getSource(id); if (s) s.setData(data); }
let map = null, lastFit = null;
function fit(b, opts) {
  const { t, b: sb } = view();
  const o = { ...opts, padding: { top: Math.round(t) + 40, bottom: Math.max(16, Math.round(innerHeight - sb) + 48 + $("keys").offsetHeight), left: 24, right: 84 } };
  lastFit = [b, o]; placeCross(); if (map) map.fitBounds(b, o);
}
function initMap() {
if (map || !window.maplibregl) return;
try {
  map = new maplibregl.Map({
    container: "map", style: dark.matches ? STYLE.dark : STYLE.light, center: [139.79, 35.8], zoom: 10,
    attributionControl: false, localIdeographFontFamily: '"Hiragino Sans", "Noto Sans JP", sans-serif', fadeDuration: reduce ? 0 : 150,
    maxPitch: 0, dragRotate: false, touchPitch: false,
  });
} catch (e) {
  $("map").append(el("p", "この端末では地図を描けません（WebGL が要ります）。結果は下に出ます。", "sub"));
}
if (!map) return;
map.touchZoomRotate.disableRotation();
// ベースの見た目を DESIGN の token に寄せ、地名は日本語を先に出す。重ねる物（浸水深・境界・点・経路）は毎回足す
map.on("style.load", () => {
  for (const l of map.getStyle().layers) {
    if (l.type === "background") map.setPaintProperty(l.id, "background-color", css("--bg"));
    const tf = l.layout && l.layout["text-field"];
    if (tf && JSON.stringify(tf).includes("name")) map.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:ja"], ["get", "name"]]);
    const ff = l.layout && l.layout["text-font"];
    if (Array.isArray(ff) && ff.some((f) => typeof f === "string" && /Italic/.test(f))) map.setLayoutProperty(l.id, "text-font", ff.map((f) => f.replace("Italic", "Regular")));
  }
  const ls = map.getStyle().layers;
  let k = ls.length; while (k > 0 && ls[k - 1].type === "symbol") k--;
  const labels = ls[k] && ls[k].id;
  const fonts = ls.map((l) => l.layout && l.layout["text-font"]).filter((f) => Array.isArray(f) && f.every((x) => typeof x === "string"));
  const font = fonts.find((f) => f.some((x) => /Bold/.test(x))) || fonts[0];
  map.addSource("flood", { type: "raster", tiles: [FLOOD], tileSize: 256, maxzoom: 17, attribution: "" });
  map.addLayer({ id: "flood", type: "raster", source: "flood", paint: { "raster-opacity": FLOOD_OPACITY() }, layout: { visibility: FLOOD_ON ? "visible" : "none" } }, labels);
  for (const [id, data] of [["boundary", BND || EMPTY], ["sites", SITES || EMPTY], ["route", state.route], ["tap", state.tap], ["dest", state.dest]])
    map.addSource(id, { type: "geojson", data });
  map.addLayer({ id: "boundary", type: "line", source: "boundary", paint: { "line-color": css("--ink"), "line-width": 2 } });
  map.addLayer({ id: "sites-other", type: "circle", source: "sites", filter: ["!=", ["get", "flood"], "対応"],
    paint: { "circle-radius": 4, "circle-color": css("--surface"), "circle-stroke-color": css("--muted"), "circle-stroke-width": 2 } });
  map.addLayer({ id: "sites-flood", type: "circle", source: "sites", filter: ["==", ["get", "flood"], "対応"],
    paint: { "circle-radius": 4, "circle-color": css("--ink"), "circle-stroke-color": css("--surface"), "circle-stroke-width": 1 } });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": css("--bg"), "line-width": 8 } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": css("--accent"), "line-width": 5 } });
  map.addLayer({ id: "dest", type: "circle", source: "dest", paint: { "circle-radius": 9, "circle-color": css("--ink"), "circle-stroke-color": css("--surface"), "circle-stroke-width": 3 } });
  map.addLayer({ id: "tap", type: "circle", source: "tap", paint: { "circle-radius": 8, "circle-color": css("--accent"), "circle-stroke-color": css("--surface"), "circle-stroke-width": 3 } });
  if (font) map.addLayer({ id: "dest-name", type: "symbol", source: "dest",
    layout: { "text-field": ["get", "name"], "text-font": font, "text-size": 14, "text-anchor": ["get", "anchor"], "text-max-width": 10,
      "text-offset": ["match", ["get", "anchor"], "bottom-right", ["literal", [-0.8, -0.8]], "bottom-left", ["literal", [0.8, -0.8]], "top-right", ["literal", [-0.8, 0.8]], ["literal", [0.8, 0.8]]] },
    paint: { "text-color": css("--ink"), "text-halo-color": css("--surface"), "text-halo-width": 2 } });
});
let mapNoted = false;
map.on("error", () => { if (mapNoted) return; mapNoted = true; $("mapnote").textContent = "地図の一部を読めませんでした。結果は出ます。"; });
map.on("load", () => { const c = map.getCanvas(); c.setAttribute("aria-label", "地図。矢印の鍵で動かし、「地図の中心で調べる」で結果を出します。"); });
map.on("click", "sites-flood", (e) => popup(e));
map.on("click", "sites-other", (e) => popup(e));
function popup(e) {
  const p = e.features[0].properties, d = el("div");
  d.append(el("strong", p.name), el("br"), el("span", "洪水の指定: " + ({ 対応: "あり", 非対応: "なし" }[p.flood] || p.flood) + (p.in_ward ? "" : "（" + (p.municipality || KIND() + "の外") + "）")));
  new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setDOMContent(d).addTo(map);
}
map.on("click", (e) => { if (!map.queryRenderedFeatures(e.point, { layers: ["sites-flood", "sites-other"] }).length) query(e.lngLat.lat, e.lngLat.lng); });
if (lastFit) map.fitBounds(lastFit[0], { ...lastFit[1], animate: false });
}
const mlTag = document.querySelector("script[data-maplibre]");
if (window.maplibregl) initMap(); else if (mlTag) mlTag.addEventListener("load", initMap);

// 地図の上の自前の丸い釦と、地図の中心（印の所）で調べる釦
$("zin").addEventListener("click", () => map && map.zoomIn());
$("zout").addEventListener("click", () => map && map.zoomOut());
$("here").addEventListener("click", () => {
  if (!navigator.geolocation) { say("この端末では現在地を使えません。地図をタップしてください。"); return; }
  navigator.geolocation.getCurrentPosition((p) => { if (map) map.jumpTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 15 }); query(p.coords.latitude, p.coords.longitude); },
    (e) => say(e.code === 1 ? "現在地の使用が許可されていません。地図をタップしてください。" : e.code === 3 ? "現在地の取得が時間切れです。地図をタップしてください。" : "現在地を取れませんでした。地図をタップしてください。"),
    { enableHighAccuracy: true, timeout: 10000 });
});
$("floodbtn").addEventListener("click", () => {
  FLOOD_ON = !FLOOD_ON; $("floodbtn").setAttribute("aria-pressed", String(FLOOD_ON));
  if (map && map.getLayer("flood")) map.setLayoutProperty("flood", "visibility", FLOOD_ON ? "visible" : "none");
});
$("center").addEventListener("click", () => {
  if (!map) { say("この端末では地図を描けません。"); return; }
  const r = $("cross").getBoundingClientRect(), c = map.unproject([r.left + r.width / 2, r.top + r.height / 2]);
  query(c.lat, c.lng);
});
// 見えている地図（上の帯と下のシートの間）の真ん中に印を置き、寄せる時の余白もそこから決める
function view() { const t = $("top").getBoundingClientRect().bottom, b = $("sheet").getBoundingClientRect().top; return { t, b }; }
function placeCross() {
  const { t, b } = view();
  $("cross").style.top = Math.round((t + b) / 2) + "px";
  $("mapbtns").style.top = Math.round(t) + 12 + "px";
  $("mapnote").style.top = Math.round(t) + 12 + "px";
  $("keys").style.bottom = Math.round(innerHeight - b) + 8 + "px";
}
addEventListener("resize", placeCross);
function say(text) { const o = $("out"); o.textContent = ""; o.append(el("p", text, "sub")); }

// 市区の一覧と市区のデータを同時に取る（地図の初期化も待たない）
const want = (new URLSearchParams(location.search).get("r") || "").replace(/[^0-9]/g, "");
CODE = want || DEFAULT_REGION; BASE = "data/" + CODE + "/";
const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const regionsP = getJSON("data/regions.json").catch(() => []).then((regs) => {
  if (regs.length && !regs.some((x) => x.code === CODE)) { location.replace("?r=" + DEFAULT_REGION); return; }
  const box = $("region");
  for (const x of regs) {
    const i = el("input"); i.type = "radio"; i.name = "region"; i.id = "r" + x.code; i.value = x.code; i.checked = x.code === CODE;
    i.addEventListener("change", () => { location.href = "?r=" + x.code; });
    const l = el("label", shortMuni(x.name)); l.htmlFor = i.id;
    box.append(i, l);
  }
  placeCross();
});
Promise.all(["grid.json", "boundary.geojson", "sites.geojson"].map((u) => getJSON(BASE + u)))
  .then(([grid, bnd, sites]) => {
    G = grid; BND = bnd; SITES = sites;
    setData("boundary", bnd); setData("sites", sites);
    BOUNDS = bboxOf(bnd);
    fit(BOUNDS, { animate: false });
    const lk = $("lk-city");
    if (G.official && G.official.city) { lk.href = G.official.city; lk.textContent = G.region + "の公式の頁"; lk.hidden = false; }
    banner();
    about();
    example();
  })
  .catch(() => say("データを読めませんでした。回線を確かめて、もう一度開いてください。"));

function bboxOf(fc) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  fc.features.forEach((f) => walk(f.geometry.coordinates));
  return [[w, s], [e, n]];
}

function loadRoute() {
  // 経路の木は最初の照会の時に読む（最初の読み込みを軽くする）
  if (!routeP) routeP = fetch(BASE + "route.json").then((r) => r.json()).then((route) => {
    R = route; OFF = [0]; for (const n of R.n_inner) OFF.push(OFF[OFF.length - 1] + n); return R;
  });
  return routeP;
}

function KIND() { return G.kind || G.region.slice(-1); }
function links(box) {
  if (G.official && G.official.city) { const a = el("a", G.region + "の公式の頁"); a.href = G.official.city; a.target = "_blank"; a.rel = "noopener"; box.append(a, document.createTextNode("・")); }
  const w = el("a", "わがまちハザードマップ"); w.href = (G.official && G.official.wagamachi) || "https://disaportal.gsi.go.jp/hazardmap/"; w.target = "_blank"; w.rel = "noopener"; box.append(w);
}

function banner() {
  // 判断を書かない（審判 F-4）: 数と出所と、確かめる先だけ。1 文 40 字以内
  const box = $("banner"); box.textContent = "";
  if (!G.few_flood) return;
  const p = G.gsi_publication || {}, d = el("div", null, "warn stack");
  d.append(el("div", "国土地理院のデータでは、この" + KIND() + "の洪水対応の避難場所は " + G.n_flood_ward + " か所です。"));
  if (p.note) d.append(el("div", "地理院の公開一覧では「" + p.note + "」の" + KIND() + "です。"));
  const wide = G.official && G.official.wide;
  if (wide) {
    const wl = el("div", wide.text + " "), a = el("a", G.region + "の広域避難の頁"); a.href = wide.url; a.target = "_blank"; a.rel = "noopener";
    wl.append(a); d.append(wl);
  }
  const l = el("div", "避難の方法は "); links(l); l.append(document.createTextNode(" で確かめてください。")); d.append(l);
  box.append(d);
}

function about() {
  // 地理院の注意 1〜3（ichiran.html の原文）と取得日は閉じない所に出す（審判 F-3）
  const g = $("gsi"); g.textContent = "";
  g.append(el("strong", "国土地理院の指定緊急避難場所データの注意（原文）"));
  g.append(el("div", "1. 本データは、災害対策基本法第49条の4・第49条の7に基づき市町村長が指定した指定緊急避難場所・指定避難所の情報を各市町村に登録いただいたものです。なお、最新でない場合や未掲載の場合があるため、最新かつ詳細の状況などは必ず当該市町村にご確認ください。"));
  g.append(el("div", "2. 「指定緊急避難場所」と「指定避難所」の違いや、指定緊急避難場所が災害種別ごとに指定されていることを理解した上でご利用ください。"));
  g.append(el("div", "3. 本データは随時更新されますので、ダウンロードや印刷等を行い利用される場合は、ご注意ください。"));
  g.append(el("div", "この頁のデータの取得日: 避難場所 " + G.source.evac.fetched + "・想定浸水深 " + G.source.flood.fetched + "・道路 " + G.source.osm.fetched + "。"));
  const a = $("sources"); a.textContent = "";
  for (const k of Object.keys(G.source)) a.append(el("div", "・" + G.source[k].name + "（取得 " + G.source[k].fetched + "）"));
}

function nearestRow(lat, lng) {
  // 最寄りの格子点を選ぶだけ（距離の値は build.py が EPSG:6677 で出した物を使う）
  let best = -1, bd = Infinity;
  const c = Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < G.rows.length; i++) {
    const r = G.rows[i], dy = r[0] - lat, dx = (r[1] - lng) * c, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  const r = G.rows[best];
  return (Math.abs(r[0] - lat) > 0.0007 || Math.abs(r[1] - lng) > 0.0009) ? null : r;
}

function inWard(lat, lng) {
  const ring = (r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c; } return c; };
  return !!BND && BND.features.some((f) => {
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    return polys.some((q) => ring(q[0]) && !q.slice(1).some(ring));
  });
}

function routeOf(row) {
  // 格子点 → 木の節点 → 親 … → 場所。返り値: [緯度, 経度] の列と、渡る川の番号（出発側から順に、重ねない）
  const pts = [[row[0], row[1]]], rivers = [];
  let k = row[7], unnamed = 0, prev = -1;
  for (let guard = 0; guard < 100000; guard++) {
    pts.push([R.lat[k] / R.scale, R.lon[k] / R.scale]);
    const rv = R.river[k];
    if (rv >= 0 && R.rivers[rv] === "名前の無い川") { if (rv !== prev) unnamed++; }
    else if (rv >= 0 && !rivers.includes(rv)) rivers.push(rv);
    prev = rv;
    for (let q = OFF[k]; q < OFF[k + 1]; q++) pts.push([R.ilat[q] / R.scale, R.ilon[q] / R.scale]);
    const p = R.par[k];
    if (p < 0) { const s = G.sites[-p - 1]; pts.push([s[4], s[5]]); break; }
    k = p;
  }
  return { pts, rivers, unnamed };
}

function example() {
  // 例の地点（SPEC の体験 S2）: 洪水対応の避難場所に届く格子点の真ん中の 1 点
  const rows = G.rows.filter((r) => r[2] >= 0 && !r[8]), r = rows[Math.floor(rows.length / 2)] || G.rows[0];
  query(r[0], r[1], true);
}

async function query(lat, lng, isExample) {
  if (!G) return;
  const out = $("out");
  window.__route = null;
  setData("route", EMPTY); setData("dest", EMPTY);
  setData("tap", { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: {} }] });
  const r = nearestRow(lat, lng);
  out.textContent = "";
  if (!r || r[8]) {
    out.append(el("p", r || inWard(lat, lng) ? "川や海の上です。近くの陸をタップしてください。" : "範囲の外です。" + G.region + "の中をタップしてください。", "warn"));
    document.body.dataset.result = "out"; return;
  }
  const [, , fs, fm, as, am, dc] = r;
  let routeBox = null;
  if (isExample) out.append(el("p", "例の地点の結果です。地図をタップすると、その地点の結果に変わります。", "lead"));
  const head = el("div", null, "stack");
  if (fs >= 0) {
    const h = el("h1", null, "h"); h.id = "result-head";
    h.append(document.createTextNode("洪水対応の避難場所まで"), el("br"), document.createTextNode("歩いて " + minutes(fm, SPEEDS[0]) + " 分"));
    head.append(h, el("div", "ゆっくりなら " + minutes(fm, SPEEDS[1]) + " 分・道路沿いに " + fm.toLocaleString() + " m（平時の道で計算）", "sub"));
  } else {
    head.append(el("h1", "洪水対応の避難場所が道路で届く所にありません", "h"));
  }
  out.append(head);
  if (fs >= 0) {
    await loadRoute();
    const s = G.sites[fs];  // [name, address, flag, remarks, lat, lon, in_ward, municipality]
    const dest = el("div", null, "stack"); dest.id = "flood-site"; dest.dataset.m = fm;
    dest.append(el("div", s[0], "dest"));
    const rt = routeOf(r), named = rt.rivers.map((i) => R.rivers[i]);
    if (rt.unnamed) named.push("名前の分からない水路 " + rt.unnamed + " か所");
    const river = named.join("・");
    if (!s[6]) {
      const w = el("div", null, "warn stack"), mu = shortMuni(s[7]) || "その市区町村";
      w.append(el("div", KIND() + "の外（" + (s[7] || "所在不明") + "）です。"));
      if (river) w.append(el("div", "経路は" + river + "を渡ります。洪水の時に渡れるか確かめてください。"));
      w.append(el("div", mu + "が指定した場所です。"), el("div", mu + "の情報を見てから使ってください。"));
      dest.append(w);
    } else {
      dest.append(el("div", (s[1] || "") + (s[3] ? "・" + s[3] : ""), "sub"));
      if (river) dest.append(el("div", "経路は" + river + "を渡ります。洪水の時に渡れるか確かめてください。", "warn"));
    }
    out.append(dest);
    window.__route = rt.pts;
    const line = rt.pts.map(([a, b]) => [b, a]);
    setData("route", { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: {} }] });
    const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
    const prev = line[Math.max(0, line.length - 2)], anchor = (prev[1] > s[4] ? "top-" : "bottom-") + (s[5] > (Math.min(...xs) + Math.max(...xs)) / 2 ? "right" : "left");
    setData("dest", { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [s[5], s[4]] }, properties: { name: s[0], anchor } }] });
    routeBox = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  }
  const rgb = G.depth_rgb[dc], label = G.depth_classes[dc], dep = el("div", null, "depth"), sw = el("span", null, "sw");
  sw.id = "swatch"; sw.dataset.label = label;
  sw.style.background = rgb ? "rgb(" + rgb.join(",") + ")" : "transparent";
  dep.append(sw, el("span", (isExample ? "例の地点" : "押した所") + "の想定浸水深 " + (rgb ? depthText(label) : "着色なし")));
  const depBox = el("div", null, "stack");
  depBox.append(dep, el("div", "家の目安: 0.5 m で 1 階の床、3 m で 2 階の床下、5 m で 2 階が水没（国土地理院）", "sub"));
  out.append(depBox);
  const used = new Set(G.rows.map((x) => x[6])), shown = G.depth_classes.filter((lab, i) => G.depth_rgb[i] && used.has(i));
  const scale = el("div", null, "scale"); scale.setAttribute("aria-label", "浸水深の凡例（ハザードマップポータルの色）");
  G.depth_classes.forEach((lab, i) => {
    const c = G.depth_rgb[i]; if (!c || !used.has(i)) return;
    const it = el("span", null, i === dc ? "now" : null), s2 = el("span", null, "sw sm"); s2.style.background = "rgb(" + c.join(",") + ")";
    it.append(s2, el("span", depthText(lab))); scale.append(it);
  });
  const old = shown.filter((x) => OLD_CLASSES.includes(x)).length;
  const scaleBox = el("div", null, "stack");
  scaleBox.append(scale, el("div", "色と階級は国土地理院の凡例のままです。" + (old && old < shown.length ? "基準の違う 2 つの区分が混ざります。" : ""), "src"));
  out.append(scaleBox);
  if (!rgb) out.append(el("div", "着色なしは、想定区域外・未配信・0.1 m 未満を区別できません。", "sub"));
  if (as >= 0 && as !== fs && (fs < 0 || am < fm)) {
    const n = G.sites[as];
    out.append(el("div", "近くの" + n[0] + "（歩いて " + minutes(am, SPEEDS[0]) + " 分）は" + (n[2] === "非対応" ? "洪水の指定がありません。" : "洪水の指定の有無が不明です。"), "warn"));
  }
  out.append(el("div", "避難場所は国土地理院（取得 " + G.source.evac.fetched + "）。浸水深は近くの 50 m 格子点の値です。", "src"));
  if (routeBox) fit(routeBox, { maxZoom: 16, duration: reduce || isExample ? 0 : 300 }); else placeCross();
  document.body.dataset.result = "ok";
  document.body.dataset.sw = document.documentElement.scrollWidth;
}
