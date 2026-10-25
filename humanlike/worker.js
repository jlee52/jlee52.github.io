// Pyodide runtime of the web app: the humanlike package and the reference bundle run in a Web Worker;
// the uploaded files are written to Pyodide's in-memory file system and never leave the browser.
// Deployment layout (scripts/build_web.py): py/wheel.json -> the humanlike wheel; references/manifest.json
// and the reference files.
"use strict";
const VER = new URL(self.location.href).search;     // ?v=<build version> (scripts/build_web.py), or empty
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
importScripts(PYODIDE + "pyodide.js");

let py = null;
const base = new URL(".", self.location).href;

async function init(id) {
  const status = (text) => postMessage({ id, type: "status", text });
  status("loading Python");
  py = await loadPyodide({ indexURL: PYODIDE });
  status("loading numpy, scipy, pandas, statsmodels");
  await py.loadPackage(["numpy", "scipy", "pandas", "statsmodels", "micropip"]);
  const wheel = (await (await fetch(base + "py/wheel.json" + VER)).json()).file;
  status("loading humanlike");
  await py.pyimport("micropip").install(base + "py/" + wheel, { deps: false });
  const man = await (await fetch(base + "references/manifest.json" + VER)).json();
  py.FS.mkdirTree("/refs");
  py.FS.writeFile("/refs/manifest.json", JSON.stringify(man));
  for (const ref of Object.values(man.references)) {
    const r = await fetch(base + "references/" + ref.file + VER);
    if (r.ok) py.FS.writeFile("/refs/" + ref.file, new Uint8Array(await r.arrayBuffer()));
  }
  py.runPython("import os; os.environ['HUMANLIKE_REFERENCES'] = '/refs'");
}

let target = null;   // path of the uploaded data in the in-memory file system

async function inspect(files) {
  py.runPython("import shutil, os; shutil.rmtree('/data', ignore_errors=True)");
  for (const { file, path } of files) {
    const dst = "/data/" + path;
    py.FS.mkdirTree(dst.slice(0, dst.lastIndexOf("/")));
    py.FS.writeFile(dst, new Uint8Array(await file.arrayBuffer()));
  }
  const first = files[0].path;
  // a folder (Minari dataset, or files of one type), several files (a folder of them), or one file
  target = first.includes("/") ? "/data/" + first.split("/")[0] : files.length > 1 ? "/data" : "/data/" + first;
  const meta = files.find((f) => /(^|\/)(data\/)?metadata\.json$/.test(f.path) && f.path.split("/").length <= 3);
  if (meta) {                                         // Minari: h5py or pyarrow on demand
    const fmt = JSON.parse(await meta.file.text()).data_format;
    await py.loadPackage(fmt === "arrow" ? ["pyarrow"] : ["h5py"]);
  }
  py.globals.set("target", target);
  return JSON.parse(py.runPython("import json; from humanlike import webapi; json.dumps(webapi.inspect(target), default=str)"));
}

async function run(id, options) {
  py.globals.set("options_json", JSON.stringify(options));
  py.globals.set("report", (i, n, stage, status) => postMessage({ id, type: "progress", i, n, stage, status }));
  const out = await py.runPythonAsync(`
from humanlike import webapi
webapi.run_json(target, webapi.kind_of(target), options_json, progress=report)
`);
  return JSON.parse(out);
}

async function minari(options) {
  py.globals.set("options_json", JSON.stringify(options));
  const out = py.runPython(`
import json
from humanlike import webapi
name, data = webapi.minari_zip(target, webapi.kind_of(target), json.loads(options_json))
(name, data)
`).toJs();
  return { name: out[0], bytes: out[1] };
}

onmessage = async (e) => {
  const m = e.data;
  try {
    let result = null;
    if (m.type === "init") await init(m.id);
    else if (m.type === "inspect") result = await inspect(m.files);
    else if (m.type === "run") result = await run(m.id, m.options);
    else if (m.type === "minari") result = await minari(m.options);
    postMessage({ id: m.id, type: "done", result });
  } catch (err) {
    postMessage({ id: m.id, type: "error", message: String(err.message || err).split("\n").slice(-6).join("\n") });
  }
};
