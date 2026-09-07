import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../overlay.js", import.meta.url), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Missing section ${start}`);
  return source.slice(from, to);
};
const node = (type, quality = 100) => ({ type, quality, body: "Planet" });
const context = vm.createContext({ Math, Number, Map, Date, Set });
vm.runInContext(`
  let nodeDataRevision = 0;
  let position = {x: 0, y: 0, z: 1};
  const currentCoordinates = () => position;
  const publicAtlas = {fetchedAt: 1000, systems: []};
  const state = {systems: {}, nodeObservations: {}, nodeFinder: {resource: 'all', query: ''}, seen: {}, officialApi: {}};
  const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  const ingested = [];
  const ingestSystems = (rows) => ingested.push(...rows);
  const officialPayload = (result) => result.data;
  const queueSyncSystem = () => {};
  const markDirty = () => {};
  ${section("  let perfectMapRevision =", "  const renderPerfectFinder =")}
  ${section("  const filteredPerfectSystems =", "  const routeCoordinateKey =")}
  ${section("  const applyOfficialJournal =", "  const applyOfficialStations =")}
`, context);
const run = (code) => vm.runInContext(code, context);
const set = (code, value) => run(`${code} = ${JSON.stringify(value)}; nodeDataRevision++;`);
set("publicAtlas.systems", [
  { name: "Gas", x: 10, y: 0, z: 1, nodes: [node("gas")], seenAt: 1000 },
  { name: "Rocky", x: 30, y: 0, z: 1, nodes: [node("rocky"), node("icy")], seenAt: 1000 },
]);
set("state.systems", { "1:10,0": { name: "Gas personal", x: 10, y: 0, z: 1, nodes: [node("gas"), node("gas", 99)], seenAt: 1500 } });
set("state.nodeObservations", { "1:10,0": 1500 });
assert.equal(run("nodeRows().length"), 2, "Public/personal duplicate must collapse");
assert.equal(run("nodeRows()[0].nodes.length"), 1, "A 99% node must never appear");
assert.equal(run("nodeRows()[0].distanceFromCurrent"), 10);
assert.equal(run("nodeRows() === nodeRows()"), true, "Repeated render must reuse ranked rows");
run("position = {x: 29, y: 0, z: 1}");
assert.equal(run("nodeRows()[0].name"), "Rocky", "Jump must recalculate nearest destination");
assert.equal(run("nodeRows()[0].distanceFromCurrent"), 1);
run("state.nodeFinder.resource = 'gas'");
assert.equal(run("filteredPerfectSystems().length"), 1);
assert.equal(run("filteredPerfectSystems()[0].name"), "Gas personal");
run("state.nodeFinder.resource = 'crystal'");
assert.equal(run("filteredPerfectSystems().length"), 0);
run("state.nodeFinder.resource = 'all'; state.nodeFinder.query = '30,0'");
assert.equal(run("filteredPerfectSystems()[0].name"), "Rocky");
run("position = {x: 29, y: 0, z: 2}");
assert.equal(run("nodeRows().every(row => row.distanceFromCurrent === null)"), true, "Main-galaxy index must not match another layer");
assert.equal(run("Object.keys(state.seen).length"), 0, "Public atlas must not inflate personal travel");
set("state.nodeObservations", { "1:10,0": 1500, "1:30,0": 2000 });
assert.equal(run("nodeRows().length"), 1, "Newer personal non-perfect observation must suppress stale public match");
set("publicAtlas.systems", []);
assert.equal(run("nodeRows().length"), 1, "Public replacement must retain independently observed personal records");
set("state.systems", {});
assert.equal(run("nodeRows().length"), 0, "Reset must invalidate the cached merge");

const at = 1788809599016;
run(`applyOfficialJournal({fetchedAt:${at + 1000}, data:{jumps:1, hasMore:false, fullJournal:[{systemName:'Journal planet', coordinate_x:1, coordinate_y:2, date:${at}, bodies:[{hasNodes:true,nodeType:'gas',nodeQuality:100,type:'Nebula'}]}]}})`);
assert.equal(run("state.seen['1:1,2']"), at, "Journal milliseconds must not be multiplied by 1000");
assert.equal(run("ingested[0].name"), "Journal planet");
assert.equal(run("ingested[0].bodies[0].nodeQuality"), 100, "Journal bodies must reach ingestion");
assert.equal(run("state.officialApi.journalSystems"), 1);
assert.equal(run("state.officialApi.jumps"), 1);
console.log("Perfect finder tests passed: exact quality, merged coordinates, all resource filters, movement, cached ranking, layer isolation, public/personal separation, replacements, and journal bodies/timestamps.");
