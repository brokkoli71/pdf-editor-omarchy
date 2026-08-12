// Anchors and callouts.
//
// An anchor is not a separate object with text of its own — it IS a paragraph
// of the page's notes, marked with where on the page it points:
//
//     <!-- anchor:120:340 -->
//     The bit about eigenvalues.
//     <!-- callout:200:260 -->
//
// The paragraph runs to the next blank line, and the optional callout marker
// says where the box sits; without one the anchor is just a dot on the page.
// So the text is edited where all the other text is — in the notes panel — and
// there is no second place for it to live, get out of step, or fail to save.
//
// The markers are HTML comments, which the notes view hides like its own page
// markers, and they ride in the `.md` sidecar the desktop reads.

const ANCHOR_RE = /<!--\s*anchor:(\d+):(\d+)\s*-->/;
const CALLOUT_RE = /<!--\s*callout:(\d+):(\d+)\s*-->/;
const ANCHOR_RE_G = new RegExp(ANCHOR_RE.source, "g");
const CALLOUT_RE_G = new RegExp(CALLOUT_RE.source, "g");

const STRIP = [
  [/^#{1,6}\s+/gm, ""],
  [/\*\*(.+?)\*\*/g, "$1"],
  [/\*([^*\n]+?)\*/g, "$1"],
  [/`([^`\n]+?)`/g, "$1"],
  [/<!--[\s\S]*?-->/g, ""],
];

/** The text a callout shows: its paragraph with the markup taken off. The box
 * is a label on a page, not a rendering surface. */
export function stripMarkers(text) {
  let out = String(text ?? "");
  for (const [re, to] of STRIP) out = out.replace(re, to);
  return out.split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
}

/** Every anchor in a page's notes: `{x, y, callout, text, line, paraEnd}`.
 *
 * The paragraph ends at the first blank line, or at the next anchor — whichever
 * comes first, so two anchors written back to back keep their own text. */
export function parseAnchors(text) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const lineStart = [];
  let at = 0;
  for (const l of lines) { lineStart.push(at); at += l.length + 1; }

  const matches = [...src.matchAll(ANCHOR_RE_G)];
  const out = [];
  matches.forEach((m, i) => {
    const ln = src.slice(0, m.index).split("\n").length - 1;
    let paraEnd = lines.length - 1;
    for (let j = ln + 1; j < lines.length; j++) {
      if (!lines[j].trim()) { paraEnd = j - 1; break; }
    }
    const paraEndOff = lineStart[paraEnd] + lines[paraEnd].length;
    let regionEnd = paraEndOff;
    if (i + 1 < matches.length) regionEnd = Math.min(regionEnd, matches[i + 1].index);
    const after = m.index + m[0].length;
    let callout = null;
    if (regionEnd > after) {
      const cm = CALLOUT_RE.exec(src.slice(after, regionEnd));
      if (cm) callout = [Number(cm[1]), Number(cm[2])];
    }
    out.push({
      x: Number(m[1]), y: Number(m[2]),
      callout,
      text: stripMarkers(lines.slice(ln, paraEnd + 1).join("\n")),
      line: ln, paraEnd,
    });
  });
  return out;
}

/** Notes text with a new anchor appended — and a callout marker too when one is
 * given. Appended rather than inserted: a new note belongs at the end of the
 * page's notes, where you would have typed it. */
export function addAnchor(text, x, y, callout = null) {
  const body = String(text ?? "").replace(/\s+$/, "");
  const marker = `<!-- anchor:${Math.round(x)}:${Math.round(y)} -->`;
  const call = callout
    ? `\n<!-- callout:${Math.round(callout[0])}:${Math.round(callout[1])} -->` : "";
  return (body ? `${body}\n\n` : "") + marker + call + "\n";
}

/** Notes text with one anchor's position rewritten. Identified by its LINE,
 * which is what the parser reports and what a drag has in hand. */
export function moveAnchor(text, line, x, y) {
  const lines = String(text ?? "").split("\n");
  if (!lines[line]) return text;
  lines[line] = lines[line].replace(ANCHOR_RE,
    `<!-- anchor:${Math.round(x)}:${Math.round(y)} -->`);
  return lines.join("\n");
}

/** Notes text with one anchor's CALLOUT moved, adding the marker when the
 * anchor has none yet. */
export function moveCallout(text, anchor, x, y) {
  const lines = String(text ?? "").split("\n");
  const marker = `<!-- callout:${Math.round(x)}:${Math.round(y)} -->`;
  for (let i = anchor.line; i <= anchor.paraEnd && i < lines.length; i++) {
    if (CALLOUT_RE.test(lines[i])) {
      lines[i] = lines[i].replace(CALLOUT_RE, marker);
      return lines.join("\n");
    }
  }
  lines.splice(Math.min(anchor.paraEnd + 1, lines.length), 0, marker);
  return lines.join("\n");
}

/** Notes text with one anchor and its paragraph removed. */
export function removeAnchor(text, anchor) {
  const lines = String(text ?? "").split("\n");
  lines.splice(anchor.line, anchor.paraEnd - anchor.line + 1);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export const ANCHOR_R = 7.0;          // the dot's radius, in screen px
export const CALLOUT_MAX_W = 220.0;   // before the text wraps, in screen px
export const CALLOUT_PAD = 7.0;

/** Lay out a callout box for some text, in screen px. Returns null when there
 * is nothing to say — an empty box is a smudge, not a label. */
export function calloutBox(ctx, text, cx, cy) {
  if (!text) return null;
  ctx.font = "13px Cantarell, system-ui, sans-serif";
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > CALLOUT_MAX_W && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  if (!lines.length) return null;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + CALLOUT_PAD * 2;
  const h = lines.length * 17 + CALLOUT_PAD * 2;
  return { x: cx, y: cy, w, h, lines };
}

/** Paint an anchor: its dot, and its callout with a line back to it. */
export function drawAnchor(ctx, screen, box, accent, dim) {
  const [ax, ay] = screen;
  ctx.save();
  ctx.setLineDash([]);
  if (box) {
    // the leader first, so the box covers where it meets it
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(box.x + box.w / 2, box.y + box.h / 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = dim;
    ctx.font = "13px Cantarell, system-ui, sans-serif";
    ctx.textBaseline = "top";
    box.lines.forEach((l, i) => {
      ctx.fillText(l, box.x + CALLOUT_PAD, box.y + CALLOUT_PAD + i * 17);
    });
  }
  ctx.beginPath();
  ctx.arc(ax, ay, ANCHOR_R, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ax, ay, 2.2, 0, 2 * Math.PI);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.restore();
}
