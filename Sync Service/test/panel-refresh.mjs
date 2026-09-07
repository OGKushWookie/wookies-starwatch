import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../overlay.js", import.meta.url), "utf8");
const start = source.indexOf("  const replaceAroundAnchor =");
const end = source.indexOf("  const updatePanelContent =", start);
assert(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}\nglobalThis.replace = replaceAroundAnchor;`, context);

// A minimal DOM fixture records removal of the live control or its ancestors.
class Node {
  constructor(name, children = []) {
    this.name = name;
    this.parentNode = null;
    this.childNodes = [];
    this.protected = false;
    for (const child of children) this.appendChild(child);
  }
  remove() {
    assert(!this.protected, `The live ${this.name} was disconnected`);
    if (this.parentNode) {
      const list = this.parentNode.childNodes;
      list.splice(list.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  insertBefore(node, anchor) {
    if (node.parentNode) node.remove();
    const at = anchor ? this.childNodes.indexOf(anchor) : this.childNodes.length;
    assert(at >= 0);
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
  }
  appendChild(node) { this.insertBefore(node, null); }
}
const resource = new Node("select");
const query = new Node("search");
const controls = new Node("controls", [resource, query]);
const finder = new Node("finder", [new Node("heading"), controls, new Node("results")]);
const content = new Node("content", [new Node("metrics"), finder, new Node("route timer")]);
for (const node of [resource, query, controls, finder]) node.protected = true;
for (let tick = 1; tick <= 120; tick++) {
  const nextControls = new Node("unused controls", [new Node("unused select")]);
  const nextFinder = new Node("incoming finder", [new Node("heading"), nextControls, new Node(`results ${tick}`)]);
  const incoming = new Node("fragment", [new Node(`metrics ${tick}`), nextFinder, new Node(`route timer ${tick}`)]);
  context.replace(finder, controls, nextFinder, nextControls);
  context.replace(content, finder, incoming, nextFinder);
  assert.deepEqual(content.childNodes.map(n => n.name), [`metrics ${tick}`, "finder", `route timer ${tick}`]);
  assert.deepEqual(finder.childNodes.map(n => n.name), ["heading", "controls", `results ${tick}`]);
  assert.equal(resource.parentNode, controls);
  assert.equal(query.parentNode, controls);
}
assert(source.includes('updatePanelContent(root.querySelector(".so-content"), panelContent())'));
assert(source.includes('document.activeElement !== control && control.value !== nextControl.value'));
assert(source.includes('data-section="perfect-finder"'));
console.log("Panel refresh tests passed: 120 updates retain connected filter controls and update results/timers in order.");
