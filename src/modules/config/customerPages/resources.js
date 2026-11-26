const { parseFragment, serialize } = require("parse5");
function imageAttributes(html) {
  const fragment = parseFragment(html), attributes = [];
  const visit = (node) => {
    if (node.tagName === "img")
      attributes.push(...node.attrs.filter((a) => a.name === "data-asset" && !a.namespace));
    (node.childNodes || []).forEach(visit);
    if (node.content) visit(node.content);
  };
  visit(fragment);
  return { fragment, attributes };
}
function remapImageReferences(html, names) {
  const { fragment, attributes } = imageAttributes(html);
  for (const a of attributes)
    if (Object.hasOwn(names, a.value)) a.value = names[a.value];
  return serialize(fragment);
}
function referencedResources(design, nodes) {
  const images = new Set(), blocks = new Set();
  const visit = (list) => {
    for (const n of list) {
      if (n.type === "Image") images.add(n.props.resource);
      if (n.type === "Gallery") for (const key of n.props.resources || []) images.add(key);
      if (n.type === "CustomVisual") blocks.add(n.props.blockId);
      visit(n.children);
    }
  };
  visit(nodes);
  for (const key of blocks) {
    const block = design.customBlocks[key];
    if (block) for (const a of imageAttributes(block.html).attributes) images.add(a.value);
  }
  return {
    resources: Object.fromEntries(Object.entries(design.resources).filter(([key]) => images.has(key))),
    customBlocks: Object.fromEntries(Object.entries(design.customBlocks).filter(([key]) => blocks.has(key))),
  };
}
module.exports = { remapImageReferences, referencedResources };
