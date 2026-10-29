import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// The on-device wake-phrase spotter the strip runs in a Web Worker: sherpa-onnx keyword spotting (Apache-2.0) with the GigaSpeech 3.3M zipformer (Apache-2.0).
export const KWS_SOURCES = {
  npm: "https://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-2.0.1.tgz",
  model: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2",
  model_dir: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
  licence: "Apache-2.0 (sherpa-onnx code and the GigaSpeech KWS model)"
} as const;
export const KWS_MODEL_FILES = ["encoder-epoch-12-avg-2-chunk-16-left-64.onnx", "decoder-epoch-12-avg-2-chunk-16-left-64.onnx", "joiner-epoch-12-avg-2-chunk-16-left-64.onnx", "tokens.txt"] as const;
// The two phrases as the model's BPE tokens; a boost and threshold per phrase, tuned on synthetic voices and kept here so the strip and the measurement agree.
export const KWS_KEYWORDS = {
  wake: ["▁HE Y ▁PI S G A H :1.5 #0.2 @wake", "▁HE Y ▁PI Z G A H :1.5 #0.2 @wake", "▁HE Y ▁PI S G A :1.5 #0.2 @wake"],
  emergency: ["▁E M ER G EN C Y :1.5 #0.2 @emergency"]
} as const;

// The Node build refuses the browser only because it maps the file system to Node; this keeps the in-memory file system there.
const NODE_FS_GUARD = 'if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}var _wrapNodeError=function(func){return function(...args){try{return func(...args)}catch(e){if(e.code){throw new FS.ErrnoError(ERRNO_CODES[e.code])}throw e}}};var VFS={...FS};for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}';
const WEB_FS = 'if(ENVIRONMENT_IS_NODE){var _wrapNodeError=function(func){return function(...args){try{return func(...args)}catch(e){if(e.code){throw new FS.ErrnoError(ERRNO_CODES[e.code])}throw e}}};var VFS={...FS};for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}}';

const PATH_SHIM = `var __posix=(function(){function na(p,a){var o=[];for(var i=0;i<p.length;i++){var x=p[i];if(!x||x===".")continue;if(x===".."){if(o.length&&o[o.length-1]!=="..")o.pop();else if(a)o.push("..")}else o.push(x)}return o}
function abs(p){return p.charAt(0)==="/"}function norm(p){var a=abs(p),t=p.slice(-1)==="/";var s=na(p.split("/"),!a).join("/");if(!s&&!a)s=".";if(s&&t)s+="/";return(a?"/":"")+s}
function join(){return norm(Array.prototype.filter.call(arguments,function(x){return x}).join("/"))}function dir(p){if(!p)return".";var s=p.replace(/\\/+$/,"");var i=s.lastIndexOf("/");if(i<0)return".";if(i===0)return"/";return s.slice(0,i)}
function base(p){var s=p.replace(/\\/+$/,"");return s.slice(s.lastIndexOf("/")+1)}function res(){var r="",a=false;for(var i=arguments.length-1;i>=0&&!a;i--){var p=arguments[i];if(!p)continue;r=p+"/"+r;a=abs(p)}return(a?"/":"")+na(r.split("/"),!a).join("/")||"."}
function rel(f,t){var x=res(f).split("/").filter(Boolean),y=res(t).split("/").filter(Boolean);var i=0;while(i<x.length&&i<y.length&&x[i]===y[i])i++;return x.slice(i).map(function(){return".."}).concat(y.slice(i)).join("/")}
var m={isAbsolute:abs,normalize:norm,join:join,dirname:dir,basename:base,resolve:res,relative:rel};m.posix=m;return m})();
var require=function(n){if(n==="path")return __posix;throw new Error("no module "+n)};`;

// The worker's protocol: init loads the wasm and model into memory; each audio message is 16 kHz samples, and a hit names its phrase and the page time of the audio that carried it.
const WORKER_TAIL = `
var spotters=null;
function cfg(kw){return{featConfig:{sampleRate:16000,featureDim:80},modelConfig:{transducer:{encoder:"/${KWS_MODEL_FILES[0]}",decoder:"/${KWS_MODEL_FILES[1]}",joiner:"/${KWS_MODEL_FILES[2]}"},tokens:"/tokens.txt",numThreads:1,debug:0},keywords:kw,numTrailingBlanks:1,maxActivePaths:4}}
self.onmessage=function(e){var m=e.data;
 if(m.type==="init"){var t0=performance.now();Promise.all([fetch(m.base+"sherpa-onnx-wasm-nodejs.wasm").then(function(r){return r.arrayBuffer()})].concat(${JSON.stringify(KWS_MODEL_FILES)}.map(function(f){return fetch(m.base+f).then(function(r){if(!r.ok)throw new Error(f+" "+r.status);return r.arrayBuffer()})}))).then(function(bufs){
  return Module({wasmBinary:new Uint8Array(bufs[0])}).then(function(M){${JSON.stringify(KWS_MODEL_FILES)}.forEach(function(f,i){M.FS.writeFile("/"+f,new Uint8Array(bufs[i+1]))});
   spotters=[["wake",createKws(M,cfg(m.keywords.wake))],["emergency",createKws(M,cfg(m.keywords.emergency))]].map(function(p){return{name:p[0],kws:p[1],stream:p[1].createStream()}});
   self.postMessage({type:"ready",ms:Math.round(performance.now()-t0)})})}).catch(function(err){self.postMessage({type:"error",message:String(err&&err.message||err)})});return}
 if(m.type==="audio"&&spotters){var t0=performance.now();for(var i=0;i<spotters.length;i++){var s=spotters[i];s.stream.acceptWaveform(16000,m.samples);while(s.kws.isReady(s.stream)){s.kws.decode(s.stream);var r=s.kws.getResult(s.stream);if(r.keyword){s.kws.reset(s.stream);self.postMessage({type:"hit",keyword:s.name,at:m.at,decode_ms:Math.round(performance.now()-t0)})}}}}
};`;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Fetches the spotter once into dir and writes worker.js: path shim, the loader with its browser file system kept, the KWS wrapper and the protocol above.
export function prepareKwsAssets(dir: string): { dir: string; files: Record<string, { bytes: number; sha256: string }> } {
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "hp-kws-"));
  const fetchTo = (url: string, out: string) => execFileSync("curl", ["-sSfL", "-m", "300", "-o", out, url], { stdio: "ignore" });
  const tgz = join(work, "sherpa.tgz");
  fetchTo(KWS_SOURCES.npm, tgz);
  execFileSync("tar", ["xzf", tgz, "-C", work]);
  const tbz = join(work, "model.tar.bz2");
  fetchTo(KWS_SOURCES.model, tbz);
  execFileSync("tar", ["xjf", tbz, "-C", work]);
  const loader = readFileSync(join(work, "package", "sherpa-onnx-wasm-nodejs.js"), "utf8");
  if (!loader.includes(NODE_FS_GUARD)) throw new Error("the sherpa-onnx loader changed; the browser patch no longer applies");
  const wrapper = readFileSync(join(work, "package", "sherpa-onnx-kws.js"), "utf8").replace(/if \(typeof process == 'object'[\s\S]*$/, "");
  writeFileSync(join(dir, "worker.js"), `${PATH_SHIM}\n${loader.replace(NODE_FS_GUARD, WEB_FS)}\n${wrapper}\n${WORKER_TAIL}\n`);
  copyFileSync(join(work, "package", "sherpa-onnx-wasm-nodejs.wasm"), join(dir, "sherpa-onnx-wasm-nodejs.wasm"));
  for (const f of KWS_MODEL_FILES) copyFileSync(join(work, KWS_SOURCES.model_dir, f), join(dir, f));
  writeFileSync(join(dir, "keywords.json"), `${JSON.stringify({ wake: KWS_KEYWORDS.wake.join("\n"), emergency: KWS_KEYWORDS.emergency.join("\n") })}\n`);
  const names = ["worker.js", "sherpa-onnx-wasm-nodejs.wasm", ...KWS_MODEL_FILES, "keywords.json"];
  const files = Object.fromEntries(names.map((n) => { const b = readFileSync(join(dir, n)); return [n, { bytes: b.length, sha256: sha(b) }]; }));
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ sources: KWS_SOURCES, files }, null, 1)}\n`);
  return { dir, files };
}

export const kwsReady = (dir: string): boolean => ["worker.js", "sherpa-onnx-wasm-nodejs.wasm", ...KWS_MODEL_FILES, "keywords.json"].every((f) => existsSync(join(dir, f)));
