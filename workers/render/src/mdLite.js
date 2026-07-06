// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Tiny, dependency-free Markdown → HTML renderer for static, TRUSTED content
// (the terms-of-use string only). Not a general-purpose/safe renderer — do not
// feed user input. Supports: # / ## / ### headings, --- rules, > blockquotes,
// - lists, | pipe | tables, **bold**, `code`, and paragraphs.

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// inline: **bold** and `code` (run after escaping, on already-escaped text)
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function cells(line) {
  // split a "| a | b |" row into trimmed cell texts
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // blank
    if (!line.trim()) { i++; continue; }

    // horizontal rule
    if (/^---+\s*$/.test(line)) { out.push("<hr/>"); i++; continue; }

    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(h[1].length, 6);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    // table: a header row followed by a |---|---| separator
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(cells(lines[i]));
        i++;
      }
      let t = "<table><thead><tr>";
      t += head.map((c) => `<th>${inline(c)}</th>`).join("");
      t += "</tr></thead><tbody>";
      for (const r of rows) {
        t += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      }
      t += "</tbody></table>";
      out.push(t);
      continue;
    }

    // blockquote (collapse consecutive > lines)
    if (line.trim().startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${buf.map(inline).join("<br/>")}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*-\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*-\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${buf.join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${buf.join("")}</ol>`);
      continue;
    }

    // paragraph
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join("\n");
}
