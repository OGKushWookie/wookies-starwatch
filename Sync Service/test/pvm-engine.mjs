import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../overlay.js", import.meta.url), "utf8");
const start = source.indexOf("  const pvmIsEngine =");
const end = source.indexOf("  const pvmRng =", start);
assert(start > 0 && end > start);
const block = source.slice(start, end);
assert(!block.includes("gameModule.yt"), "Do not hard-code the obsolete export");
const bundle = (factory = "$u", alias = "It", module = "t", lib = "n") =>
  `var ${factory}=r(((e,${module})=>{var ${lib}=Shared();${module}.exports=${lib},${module}.exports.default=${lib},${module}.exports.stellarlib=${lib}}));export{Other as yt,${factory} as ${alias}};`;
const engine = {
  simulateBattle() {}, getWinrate() {}, findMaxLevelAtThreshold() {}, findOptimalBuild() {},
  battlingNPCs: [{name: "brutes", weakness: ["kinetic"]}],
};
let factoryCalls = 0, wrongCalls = 0, reads = 0, imports = 0, failRead = false;
const context = vm.createContext({URL, AbortController, setTimeout, clearTimeout,
  document: {scripts: [{src: "file:///game/assets/index-new.js"}]},
  fetch: async url => {
    assert.equal(new URL(url).protocol, "file:");
    reads++;
    if (failRead) throw new Error("temporary read failure");
    return {ok: true, text: async () => bundle()};
  },
  importGame: async () => {
    imports++;
    return {It: () => {factoryCalls++; return engine;}, yt: () => {wrongCalls++; throw Error("wrong export invoked");}};
  },
});
vm.runInContext(`
  let pvmEnginePromise = null;
  const state = {pvmLab: {engineSource: 'index-old.js', job: 'idle', build: {power: 42},
    result: {stale: true}, maxResult: {stale: true}, optimizer: {stale: true}}};
  let dirty = 0; const markDirty = () => dirty++;
  const refreshPvmPanel = () => {};
  ${block.replace("await import(mainUrl)", "await importGame(mainUrl)")}
`, context);
const run = code => vm.runInContext(code, context);
context.fixture = bundle();
assert.equal(run("pvmLibraryExport(fixture)"), "It");
for (const [factory, alias, module, lib] of [["Pc", "yt", "t", "n"], ["$x", "$new", "module$", "lib$"]]) {
  context.fixture = bundle(factory, alias, module, lib);
  assert.equal(run("pvmLibraryExport(fixture)"), alias, "Minified identifiers must be independent");
}
context.fixture = bundle().replace("var n=Shared();", "const n = Shared( ); ").replaceAll(",", " , ");
assert.equal(run("pvmLibraryExport(fixture)"), "It");
for (const malformed of ["export{Other as yt};", bundle().replace("stellarlib", "notTheLibrary"), bundle().replace("t.exports=n,", "sendAction(),t.exports=n,"), bundle() + bundle("second", "second")]) {
  context.fixture = malformed;
  assert.throws(() => run("pvmLibraryExport(fixture)"), /compatibility update/);
}
context.engine = engine;
assert(run("pvmIsEngine(engine)"));
for (const key of ["simulateBattle", "getWinrate", "findMaxLevelAtThreshold", "findOptimalBuild", "battlingNPCs"]) {
  context.invalid = {...engine, [key]: null};
  assert.equal(run("pvmIsEngine(invalid)"), false);
}
context.invalid = {...engine, battlingNPCs: []};
assert.equal(run("pvmIsEngine(invalid)"), false);
for (const url of ["https://steam.stellarodyssey.app/assets/index-a.js", "http://localhost/assets/index-a.js", "file://server/game/assets/index-a.js", "file:///game/assets/PlayerPage-a.js"]) {
  context.url = url;
  await assert.rejects(run("pvmReadLocalBundle(url)"), /installed Steam/);
}
assert.equal(reads, 0, "Rejected URLs must not perform any I/O");
await Promise.all([run("loadPvmEngine()"), run("loadPvmEngine()")]);
assert.equal(factoryCalls, 1); assert.equal(wrongCalls, 0); assert.equal(reads, 1); assert.equal(imports, 1);
assert.equal(run("state.pvmLab.engineStatus"), "ready");
assert.equal(run("state.pvmLab.engineSource"), "index-new.js");
assert.equal(run("state.pvmLab.result"), null);
assert.equal(run("state.pvmLab.maxResult"), null);
assert.equal(run("state.pvmLab.optimizer"), null);
assert.equal(run("state.pvmLab.build.power"), 42);
await run("loadPvmEngine()"); assert.equal(reads, 1, "Reuse the resolved engine");
run("pvmEnginePromise = null"); failRead = true;
await assert.rejects(run("loadPvmEngine()"), /temporary read failure/);
assert.equal(run("state.pvmLab.engineStatus"), "error");
failRead = false;
await run("loadPvmEngine()");
assert.equal(run("state.pvmLab.engineStatus"), "ready", "Failures must allow retry");
assert.equal(wrongCalls, 0);
console.log("PvM engine tests passed: renamed exports, strict library discovery, interface checks, local-file-only reads, shared/cached load, stale-result invalidation, safe failure and retry.");
