// Small, safe Markdown → DOM for assistant answers: paragraphs, lists, headings, tables,
// **bold**, *italic*, `code`. Builds text nodes only — never innerHTML with model text.

function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    const el = document.createElement(t.startsWith("**") || t.startsWith("__") ? "b" : t.startsWith("`") ? "code" : "i");
    el.textContent = t.startsWith("**") || t.startsWith("__") ? t.slice(2, -2) : t.slice(1, -1);
    out.push(el);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const el = (tag: string, kids: Node[] = []) => {
  const e = document.createElement(tag);
  e.append(...kids);
  return e;
};
const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function markdown(src: string): Node[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: Node[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const p = el("p");
    para.forEach((l, i) => { if (i) p.append(document.createElement("br")); p.append(...inline(l)); });
    out.push(p);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) { flush(); out.push(el("p", [el("b", inline(head[1]))])); continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        list.append(el("li", inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""))));
        i++;
      }
      i--;
      out.push(list);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const table = el("table");
      table.className = "md";
      const hr = el("tr", cells(line).map((c) => el("th", inline(c))));
      table.append(hr);
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        table.append(el("tr", cells(lines[i]).map((c) => {
          const td = el("td", inline(c));
          if (/^[−-]?[\d.,\s]+(%|m²|m|m2)?$/.test(c)) td.className = "num";
          return td;
        })));
        i++;
      }
      i--;
      out.push(table);
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}
