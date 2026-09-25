const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const INLINE_SPECIAL = new Set(["\\", "!", "[", "<", "`", "*", "_", "~", "\n"]);

export function safeLinkTarget(value) {
  const candidate = String(value ?? "").trim();
  if (!/^(?:https?:\/\/|mailto:)/i.test(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return undefined;
  try {
    const parsed = new URL(candidate);
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function parseMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
    if (fence) {
      const marker = fence[1];
      const language = /^[a-z0-9_-]{1,30}$/i.test(fence[2] ?? "") ? fence[2] : undefined;
      const content = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index] ?? "")) {
        content.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", text: content.join("\n"), ...(language ? { language } : {}) });
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && (/^ {0,3}>/.test(lines[index] ?? "") || !(lines[index] ?? "").trim())) {
        const quoteLine = lines[index] ?? "";
        quoteLines.push(quoteLine.replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", children: parseMarkdown(quoteLines.join("\n")) });
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const listMatch = line.match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[1]);
      const items = [];
      const start = ordered ? Number.parseInt(listMatch[1], 10) : undefined;
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
        if (!item || Boolean(item[1]) !== ordered) break;
        items.push(parseInline(item[3]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items, ...(ordered && start !== 1 ? { start } : {}) });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

export function renderMarkdown(markdown, ownerDocument = globalThis.document) {
  if (!ownerDocument) throw new Error("Markdown rendering requires a document");
  const fragment = ownerDocument.createDocumentFragment();
  appendBlocks(fragment, parseMarkdown(markdown), ownerDocument);
  return fragment;
}

function startsBlock(lines, index) {
  const line = lines[index] ?? "";
  return (
    /^ {0,3}(?:`{3,}|~{3,})/.test(line) ||
    /^ {0,3}#{1,6}\s+/.test(line) ||
    /^ {0,3}(?:>|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line) ||
    /^\s*(?:(?:\d+)[.)]|[-+*])\s+/.test(line) ||
    Boolean(parseTable(lines, index))
  );
}

function parseTable(lines, index) {
  const headerLine = lines[index] ?? "";
  const separatorLine = lines[index + 1] ?? "";
  if (!headerLine.includes("|") || !separatorLine.includes("|")) return undefined;

  const headers = splitTableRow(headerLine);
  const separators = splitTableRow(separatorLine);
  if (headers.length === 0 || headers.length !== separators.length || !separators.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return undefined;
  }

  const alignments = separators.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
  const rows = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && (lines[nextIndex] ?? "").includes("|") && (lines[nextIndex] ?? "").trim()) {
    const cells = splitTableRow(lines[nextIndex] ?? "");
    if (cells.length !== headers.length) break;
    rows.push(cells.map(parseInline));
    nextIndex += 1;
  }

  return {
    block: {
      type: "table",
      headers: headers.map(parseInline),
      alignments,
      rows,
    },
    nextIndex,
  };
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

function parseInline(text, depth = 0) {
  if (depth > 8) return [{ type: "text", text }];
  const nodes = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character === "\\" && index + 1 < text.length && /[\\`*_[\]{}()#+.!|>~-]/.test(text[index + 1])) {
      pushText(nodes, text[index + 1]);
      index += 2;
      continue;
    }

    if ((character === "!" && text[index + 1] === "[") || character === "[") {
      const image = character === "!";
      const labelStart = index + (image ? 2 : 1);
      const labelEnd = text.indexOf("](", labelStart);
      if (labelEnd >= 0) {
        const targetEnd = text.indexOf(")", labelEnd + 2);
        if (targetEnd >= 0) {
          const raw = text.slice(index, targetEnd + 1);
          const label = text.slice(labelStart, labelEnd);
          const href = safeLinkTarget(text.slice(labelEnd + 2, targetEnd));
          if (href) {
            nodes.push(image
              ? { type: "link", href, children: [{ type: "text", text: `[image: ${label || "image"}]` }] }
              : { type: "link", href, children: parseInline(label, depth + 1) });
          } else {
            pushText(nodes, raw);
          }
          index = targetEnd + 1;
          continue;
        }
      }
    }

    if (character === "<") {
      const end = text.indexOf(">", index + 1);
      if (end >= 0) {
        const candidate = text.slice(index + 1, end);
        const href = safeLinkTarget(candidate);
        if (href) {
          nodes.push({ type: "link", href, children: [{ type: "text", text: candidate }] });
          index = end + 1;
          continue;
        }
      }
    }

    if (character === "`") {
      let markerLength = 1;
      while (text[index + markerLength] === "`") markerLength += 1;
      const marker = "`".repeat(markerLength);
      const end = text.indexOf(marker, index + markerLength);
      if (end >= 0) {
        nodes.push({ type: "code", text: text.slice(index + markerLength, end) });
        index = end + markerLength;
        continue;
      }
    }

    const delimiter = ["**", "__", "~~", "*", "_"].find((value) => text.startsWith(value, index));
    if (delimiter) {
      const end = text.indexOf(delimiter, index + delimiter.length);
      const inner = end >= 0 ? text.slice(index + delimiter.length, end) : "";
      if (inner && !inner.includes("\n")) {
        const type = delimiter === "~~" ? "delete" : delimiter.length === 2 ? "strong" : "emphasis";
        nodes.push({ type, children: parseInline(inner, depth + 1) });
        index = end + delimiter.length;
        continue;
      }
    }

    if (character === "\n") {
      nodes.push({ type: "break" });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length && !INLINE_SPECIAL.has(text[end])) end += 1;
    pushText(nodes, text.slice(index, end));
    index = end;
  }

  return nodes;
}

function pushText(nodes, text) {
  if (!text) return;
  const previous = nodes.at(-1);
  if (previous?.type === "text") previous.text += text;
  else nodes.push({ type: "text", text });
}

function appendBlocks(parent, blocks, ownerDocument) {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const paragraph = ownerDocument.createElement("p");
      appendInline(paragraph, block.children, ownerDocument);
      parent.append(paragraph);
    } else if (block.type === "heading") {
      const heading = ownerDocument.createElement(`h${block.level}`);
      appendInline(heading, block.children, ownerDocument);
      parent.append(heading);
    } else if (block.type === "code") {
      const pre = ownerDocument.createElement("pre");
      const code = ownerDocument.createElement("code");
      if (block.language) code.className = `language-${block.language}`;
      code.textContent = block.text;
      pre.append(code);
      parent.append(pre);
    } else if (block.type === "rule") {
      parent.append(ownerDocument.createElement("hr"));
    } else if (block.type === "blockquote") {
      const quote = ownerDocument.createElement("blockquote");
      appendBlocks(quote, block.children, ownerDocument);
      parent.append(quote);
    } else if (block.type === "list") {
      const list = ownerDocument.createElement(block.ordered ? "ol" : "ul");
      if (block.start) list.start = block.start;
      for (const item of block.items) {
        const listItem = ownerDocument.createElement("li");
        appendInline(listItem, item, ownerDocument);
        list.append(listItem);
      }
      parent.append(list);
    } else if (block.type === "table") {
      parent.append(renderTable(block, ownerDocument));
    }
  }
}

function appendInline(parent, nodes, ownerDocument) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.append(ownerDocument.createTextNode(node.text));
    } else if (node.type === "break") {
      parent.append(ownerDocument.createElement("br"));
    } else if (node.type === "code") {
      const code = ownerDocument.createElement("code");
      code.textContent = node.text;
      parent.append(code);
    } else if (["strong", "emphasis", "delete"].includes(node.type)) {
      const element = ownerDocument.createElement(node.type === "strong" ? "strong" : node.type === "emphasis" ? "em" : "del");
      appendInline(element, node.children, ownerDocument);
      parent.append(element);
    } else if (node.type === "link") {
      const link = ownerDocument.createElement("a");
      link.href = node.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      appendInline(link, node.children, ownerDocument);
      parent.append(link);
    }
  }
}

function renderTable(block, ownerDocument) {
  const wrapper = ownerDocument.createElement("div");
  wrapper.className = "table-scroll";
  const table = ownerDocument.createElement("table");
  const head = ownerDocument.createElement("thead");
  const headerRow = ownerDocument.createElement("tr");
  block.headers.forEach((children, index) => {
    const cell = ownerDocument.createElement("th");
    cell.className = `align-${block.alignments[index]}`;
    appendInline(cell, children, ownerDocument);
    headerRow.append(cell);
  });
  head.append(headerRow);
  table.append(head);

  const body = ownerDocument.createElement("tbody");
  for (const row of block.rows) {
    const tableRow = ownerDocument.createElement("tr");
    row.forEach((children, index) => {
      const cell = ownerDocument.createElement("td");
      cell.className = `align-${block.alignments[index]}`;
      appendInline(cell, children, ownerDocument);
      tableRow.append(cell);
    });
    body.append(tableRow);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}
