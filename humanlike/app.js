// Humanlike locomotion benchmark: web front end.
// Two runtimes with the same calls (inspect, run): the local server of `humanlike serve` (native Python,
// found at ./api/ping) or Pyodide in a Web Worker (worker.js). Both call humanlike.webapi.
"use strict";

const $ = (id) => document.getElementById(id);
const state = { files: null, info: null, result: null, runtime: null, examples: [], preset: null };
const STAGE_TITLES = {
  events: "Foot strikes", gait_summary: "Speed and stride parameters", gait_scaling: "Feedforward signature",
  foot_placement: "Foot-placement model", feedback: "Feedback signature", energetics: "Energetic signature",
  gait_phases: "Phases of the stride", sagittal: "Sagittal joint angles", kinetic_principles: "Kinetic principles",
};

// ---- runtimes -------------------------------------------------------------------------------------
class ServerRuntime {
  label = "Local server (native Python)";
  async init() { const r = await fetch("api/ping"); if (!r.ok) throw new Error("no server"); }
  async upload(files) {
    const session = (await (await fetch("api/session", { method: "POST" })).json()).session;
    for (const f of files) {
      const rel = relPath(f);
      const r = await fetch(`api/upload?session=${session}&path=${encodeURIComponent(rel)}`, { method: "POST", body: f });
      if (!r.ok) throw new Error(await r.text());
    }
    this.session = session;
  }
  async inspect(files) {
    await this.upload(files);
    const r = await fetch(`api/inspect?session=${this.session}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async minari(options) {
    const r = await fetch(`api/minari?session=${this.session}`, { method: "POST", body: JSON.stringify(options) });
    if (!r.ok) throw new Error(await r.text());
    const name = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "dataset.zip";
    return { name, blob: await r.blob() };
  }
  async run(options, onProgress) {
    const r = await fetch(`api/run?session=${this.session}`, { method: "POST", body: JSON.stringify(options) });
    if (!r.ok) throw new Error(await r.text());
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "", out = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.type === "progress") onProgress(msg);
        else if (msg.type === "error") throw new Error(msg.message);
        else if (msg.type === "result") out = msg.result;
      }
    }
    return out;
  }
}

class PyodideRuntime {
  label = "In your browser (Pyodide) · data stay on this computer";
  init() {
    this.worker = new Worker("worker.js?v=cce6cfa4a6");
    this.pending = new Map(); this.seq = 0;
    this.worker.onmessage = (e) => {
      const m = e.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") p.onProgress && p.onProgress(m);
      else if (m.type === "status") setRuntime(`${this.label} · ${m.text}`);
      else { this.pending.delete(m.id); m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(m.result); }
    };
    return this.call("init");
  }
  call(type, payload = {}, onProgress) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  inspect(files) { return this.call("inspect", { files: [...files].map((f) => ({ file: f, path: relPath(f) })) }); }
  run(options, onProgress) { return this.call("run", { options }, onProgress); }
  async minari(options) {
    const out = await this.call("minari", { options });
    return { name: out.name, blob: new Blob([out.bytes], { type: "application/zip" }) };
  }
}

function setRuntime(text) { $("runtime").textContent = text; }
const relPath = (f) => f.relPath || f.webkitRelativePath || f.name;

async function start() {
  for (const R of [ServerRuntime, PyodideRuntime]) {
    const rt = new R();
    try {
      setRuntime(R === PyodideRuntime ? "Loading the analysis engine in your browser…" : "Looking for a local server…");
      await rt.init();
      state.runtime = rt; setRuntime(rt.label); return;
    } catch (e) { if (R === PyodideRuntime) setRuntime("Could not start the analysis engine: " + e.message); }
  }
}

// ---- step 1: data ---------------------------------------------------------------------------------
async function choose(files, fromUser = false) {
  if (!files || !files.length) return;
  if (fromUser) state.preset = null;
  state.files = files; state.result = null;
  ["step-map", "step-run", "step-results"].forEach((s) => ($(s).hidden = true));
  const first = files[0], dir = relPath(first).includes("/") ? relPath(first).split("/")[0] : null;
  $("file-info").hidden = false;
  $("file-info").textContent = dir && files.length > 1 ? `Folder ${dir} (${files.length} files)` :
    files.length > 1 ? `${files.length} files` : `${first.name} (${(first.size / 1e6).toFixed(1)} MB)`;
  try {
    if (!state.runtime) await waitRuntime();
    $("file-info").textContent += " · reading…";
    state.info = await state.runtime.inspect(files);
    $("file-info").textContent = $("file-info").textContent.replace(" · reading…", ` · ${describe(state.info)}`);
    buildForm(state.info);
    return true;
  } catch (e) { showError(e); return false; }
}

function waitRuntime() {
  return new Promise((res) => { const t = setInterval(() => { if (state.runtime) { clearInterval(t); res(); } }, 200); });
}

function describe(i) {
  const n = i.files && i.files.length > 1 ? `${i.files.length} files; first: ` : "";
  if (i.kind === "c3d") return `C3D, ${n}${i.labels.length} markers, ${i.frames} frames at ${i.rate} Hz, ${i.plates} force plates`;
  if (i.kind === "bvh") return `BVH, ${n}${i.joints.length} joints, ${i.frames} frames at ${i.rate.toFixed(0)} Hz`;
  if (i.kind === "csv") return `CSV, ${i.header.length} columns`;
  if (i.kind === "minari") return `Minari dataset ${i.dataset_id || ""}, ${i.episodes} episodes (${i.data_format})`;
  return `${i.rollouts} rollouts`;
}

// ---- step 2: mapping ------------------------------------------------------------------------------
const field = (label, html, hint) => `<label>${label}${html}${hint ? `<span>${hint}</span>` : ""}</label>`;
const opts = (list, sel, empty) => (empty ? `<option value="">${empty}</option>` : "") +
  list.map((x) => `<option${(Array.isArray(sel) ? sel.includes(x) : sel === x) ? " selected" : ""}>${esc(x)}</option>`).join("");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (name, ph, val = "") => `<input type="number" step="any" name="${name}" placeholder="${ph}" value="${val}">`;

function buildForm(i) {
  const f = [], hint = [];
  f.push(field("Name", `<input type="text" name="name" value="${esc(i.name || "")}">`));
  if (i.kind === "csv") {
    hint.push("Columns for the pelvis and both feet are required; other signals are found by name (see PROFILE.md).");
    for (const [sig, lab] of [["pelvis_pos", "Pelvis"], ["left_foot_pos", "Left foot"], ["right_foot_pos", "Right foot"]]) {
      const p = i.proposal[sig] || [];
      f.push(field(`${lab} x, y, z`, ["x", "y", "z"].map((a, k) =>
        `<select name="col:${sig}:${k}">${opts(i.header, p[k], `${a}…`)}</select>`).join("")));
    }
    const extra = Object.keys(i.proposal).filter((s) => !["pelvis_pos", "left_foot_pos", "right_foot_pos"].includes(s));
    if (extra.length) hint.push("Also found: " + extra.join(", ") + ".");
    if (!i.has_time) f.push(field("Sampling rate (Hz)", num("fs", "e.g. 100"), "no time column"));
    f.push(field("Length unit", `<select name="units">${opts(["m", "cm", "mm"], "m")}</select>`));
    f.push(field("Vertical axis", `<select name="up">${opts(["z", "y", "x"], "z")}</select>`));
  } else if (i.kind === "c3d") {
    hint.push(`Subject ${i.subject || "?"}. Pelvis = mean of the selected markers; feet = heel markers.`);
    f.push(field("Pelvis markers", `<select name="pelvis" multiple>${opts(i.labels, i.proposal.pelvis)}</select>`,
      `<span id="pelvis-sel">${esc(i.proposal.pelvis.join(", ") || "none selected")}</span> · Ctrl/⌘-click to select several`));
    f.push(field("Left heel", `<select name="left_foot">${opts(i.labels, i.proposal.left_foot)}</select>`));
    f.push(field("Right heel", `<select name="right_foot">${opts(i.labels, i.proposal.right_foot)}</select>`));
    f.push(field("Walking", `<select name="treadmill_mode">${opts(["over ground", "treadmill, estimate belt speed", "treadmill, belt speed below"], "over ground")}</select>`,
      i.plates ? `${i.plates} force plates: used for treadmill trials` : "no force plates"));
    f.push(field("Belt speed (m/s)", num("treadmill_value", "e.g. 1.2")));
  } else if (i.kind === "bvh") {
    f.push(field("Pelvis joint", `<select name="pelvis">${opts(i.joints, i.proposal.pelvis)}</select>`));
    f.push(field("Left foot joint", `<select name="left_foot">${opts(i.joints, i.proposal.left_foot)}</select>`));
    f.push(field("Right foot joint", `<select name="right_foot">${opts(i.joints, i.proposal.right_foot)}</select>`));
    f.push(field("Vertical axis", `<select name="up">${opts(["y", "z", "x"], "y")}</select>`));
    f.push(field("Length unit", `<select name="units">${opts(["auto", "m", "cm", "mm"], "auto")}</select>`));
  } else if (i.kind === "minari") {
    if (!i.profile) {
      hint.push("This Minari dataset has no humanlike profile metadata. Add it with humanlike.adapters.minari_io.annotate (see PROFILE.md).");
    } else {
      const p = i.profile;
      hint.push(`Profile ${p.version}: ${p.samples_per_step} sample(s) per step at ${p.fs} Hz, up = ${p.up}` +
        (p.mass_kg ? `, mass ${(+p.mass_kg).toFixed(1)} kg` : "") + ".");
    }
  }
  const known = i.kind === "minari" && i.profile && i.profile.mass_kg;
  f.push(field("Body mass (kg)", num("mass_kg", known ? "from the dataset" : "needed for energetics and kinetics",
    i.mass_kg ? (+i.mass_kg).toFixed(1) : ""), i.mass_kg ? "from the file" : ""));
  f.push(field("Leg length (m)", num("leg_length_m", "optional"), "hip joint centre to sole"));
  $("map-form").innerHTML = f.join("");
  for (const [k, v] of Object.entries(state.preset || {})) {    // the example's mapping
    const el = $("map-form").querySelector(`[name="${k}"]`);
    if (el) el.value = v;
  }
  const ps = $("map-form").querySelector('select[name="pelvis"][multiple]');
  if (ps) ps.onchange = () => ($("pelvis-sel").textContent = [...ps.selectedOptions].map((o) => o.value).join(", ") || "none selected");
  $("map-hint").textContent = hint.join(" ");
  $("step-map").hidden = false; $("step-run").hidden = false;
  $("run").disabled = i.kind === "minari" && !i.profile;
}

function readForm() {
  const fd = new FormData($("map-form")), o = {}, cols = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("col:")) { const [, sig, idx] = k.split(":"); (cols[sig] ||= [])[+idx] = v; continue; }
    if (k === "pelvis" && state.info.kind === "c3d") { (o.pelvis ||= []).push(v); continue; }
    if (v !== "") o[k] = v;
  }
  if (Object.keys(cols).length) {
    for (const [sig, c] of Object.entries(cols)) if (c.filter(Boolean).length !== 3) throw new Error(`Choose three columns for ${sig}`);
    o.columns = { ...state.info.proposal, ...cols };
  }
  if (state.info.kind === "c3d") {
    const m = o.treadmill_mode || "";
    if (m.includes("estimate")) o.treadmill_speed = "auto";
    else if (m.includes("below")) { if (!o.treadmill_value) throw new Error("Enter the belt speed"); o.treadmill_speed = o.treadmill_value; }
    delete o.treadmill_mode; delete o.treadmill_value;
  }
  return o;
}

// ---- step 3: run ----------------------------------------------------------------------------------
async function run() {
  $("error").hidden = true; $("progress").innerHTML = ""; $("step-results").hidden = true;
  let options;
  try { options = readForm(); } catch (e) { return showError(e); }
  state.options = options;
  $("run").disabled = true;
  const t0 = performance.now();
  try {
    const res = await state.runtime.run(options, (m) => {
      const li = document.createElement("li");
      const st = m.status.split(" ")[0];
      li.className = st; li.textContent = `${STAGE_TITLES[m.stage] || m.stage}: ${m.status}`;
      $("progress").appendChild(li);
    });
    state.result = res;
    showResults(res, (performance.now() - t0) / 1000);
  } catch (e) { showError(e); }
  $("run").disabled = false;
}

function showResults(res, seconds) {
  const st = res.results.stages, v = res.results.validation;
  const card = (title, body) => `<div class="card">${title}<b>${body}</b></div>`;
  const cards = [card("Rollouts", res.summary.rollouts), card("Time", `${seconds.toFixed(1)} s`)];
  const g = st.gait_scaling && st.gait_scaling.result;
  if (g) for (const [ref, r] of Object.entries(g)) if (r.js_stride_length != null)
    cards.push(card(`Feedforward JS (${ref.split("/")[0]})`, `${r.js_stride_length.toFixed(2)} / ${r.js_stride_frequency.toFixed(2)}`));
  const fb = st.feedback && st.feedback.result;
  if (fb) for (const [ref, r] of Object.entries(fb.references)) cards.push(card(`FPGD (${ref.split("/")[0]})`, r.fpgd_mean.toFixed(1)));
  const en = st.energetics && st.energetics.result;
  if (en) cards.push(card("Energetic signature", en.label));
  const kp = st.kinetic_principles && st.kinetic_principles.result;
  if (kp) cards.push(card("Kinetic principles", `${kp.consistent} / ${kp.evaluated}`));
  const sg = st.sagittal && st.sagittal.result;
  if (sg) cards.push(card("Sagittal features", `${sg.consistent_features} / 8`));
  const skipped = Object.entries(st).filter(([, s]) => s.status !== "ok");
  let notes = "";
  if (skipped.length) notes += `<p class="hint">Not run (the data do not include what they need; see the report): ` +
    skipped.map(([k]) => esc(STAGE_TITLES[k] || k)).join(", ") + ".</p>";
  if (!v.ok) notes += `<p class="error">${esc(v.errors.join("; "))}</p>`;
  $("summary").innerHTML = cards.join("");
  $("notes").innerHTML = notes;
  $("report").srcdoc = res.report_html;
  $("step-results").hidden = false;
  $("step-results").scrollIntoView({ behavior: "smooth" });
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showError(e) {
  $("step-run").hidden = false;
  $("error").hidden = false; $("error").textContent = String(e.message || e);
}

const FORMAT = { "amp-kinetics": "AMP · Minari", "amp-positions": "AMP · Minari", "camargo-c3d": "C3D", "cmu-bvh": "BVH" };

async function loadExamples() {
  try {
    const r = await fetch("examples/examples.json");
    if (!r.ok) throw new Error();
    state.examples = (await r.json()).examples;
    $("example-list").innerHTML = state.examples.map((e, k) =>
      `<button class="example" type="button" data-k="${k}"><span class="tag">${esc(FORMAT[e.id] || e.id)}</span>` +
      `<b>${esc(e.title)}</b><span class="d">${esc(e.description)}</span><span class="d">${(e.bytes / 1e6).toFixed(1)} MB</span></button>`).join("");
    $("example-list").querySelectorAll(".example").forEach((b) => (b.onclick = () => runExample(+b.dataset.k)));
    $("examples").hidden = !state.examples.length;
  } catch { $("examples").hidden = true; }
}

async function runExample(k) {
  const buttons = $("example-list").querySelectorAll(".example");
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (!state.runtime) await waitRuntime();
    if (await demo(k)) await run();
  } finally { buttons.forEach((b) => (b.disabled = false)); }
}

async function demo(index) {
  const e = state.examples[index];
  if (!e) { showError(new Error("no example in this deployment")); return false; }
  try {
    $("file-info").hidden = false; $("file-info").textContent = `Downloading the example (${(e.bytes / 1e6).toFixed(1)} MB)…`;
    const files = await Promise.all(e.files.map(async (rel) => {
      const f = new File([await (await fetch("examples/" + rel)).blob()], rel.split("/").pop());
      f.relPath = rel;
      return f;
    }));
    state.preset = e.options || null;
    return await choose(files);
  } catch (err) { showError(err); return false; }
}

// ---- wiring ---------------------------------------------------------------------------------------
$("pick-file").onchange = (e) => choose(e.target.files, true);
$("pick-dir").onchange = (e) => choose(e.target.files, true);
$("run").onclick = run;
$("dl-report").onclick = () => download(`${state.result.summary.name}_report.html`, state.result.report_html, "text/html");
$("dl-minari").onclick = async () => {
  const b = $("dl-minari"); b.disabled = true; const label = b.textContent; b.textContent = "Writing the dataset…";
  try {
    const { name, blob } = await state.runtime.minari(state.options || {});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { showError(e); }
  b.disabled = false; b.textContent = label;
};
$("dl-json").onclick = () => download(`${state.result.summary.name}_results.json`, JSON.stringify(state.result.results, null, 1), "application/json");
const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); choose(e.dataTransfer.files, true); };
start();
loadExamples().then(() => {                      // ?demo=<example id> runs that example (tests)
  const q = new URLSearchParams(location.search);
  if (q.has("demo")) runExample(Math.max(0, state.examples.findIndex((e) => e.id === q.get("demo"))));
});
