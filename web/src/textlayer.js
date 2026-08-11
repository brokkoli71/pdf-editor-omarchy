// The page's words, for the caret tool.
//
// pdf.js hands back text RUNS, not words — a run is however much text the
// content stream emitted at one position, which can be a whole line or a single
// glyph. The caret needs words, so runs are split on whitespace and each word
// given the share of the run's width its characters occupy. That is wrong for a
// proportional font and close enough to select with; measuring real glyph
// advances would mean loading the font, which is a lot of machinery for a
// highlight that is one pixel off.
//
// Everything here is in DOCUMENT units (y DOWN from the top-left), converted
// once on the way in, so nothing downstream has to juggle two coordinate
// spaces.

/** Words on a page, in reading order. */
export async function pageWords(page, pageHeight) {
  const content = await page.getTextContent();
  const words = [];
  for (const item of content.items) {
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const tr = item.transform;
    const x = tr[4];
    const h = item.height || Math.abs(tr[3]) || 10;
    const y = pageHeight - tr[5] - h;      // PDF is y-up; documents are y-down
    const w = item.width || 0;
    const len = item.str.length;
    if (!len) continue;

    // walk the run, emitting a word per non-space span
    let at = 0;
    while (at < len) {
      while (at < len && /\s/.test(item.str[at])) at++;
      let end = at;
      while (end < len && !/\s/.test(item.str[end])) end++;
      if (end > at) {
        words.push({
          str: item.str.slice(at, end),
          x: x + (w * at) / len,
          y,
          w: (w * (end - at)) / len,
          h,
        });
      }
      at = end;
    }
  }
  return orderForReading(words);
}

/** Group into lines by vertical overlap, then order lines top-down and words
 * left-right within each. The content stream's own order is usually reading
 * order and occasionally is not — a two-column layout emitted column by column
 * still reads correctly this way, because the columns do not share lines. */
function orderForReading(words) {
  const lines = [];
  for (const word of words) {
    const line = lines.find((l) =>
      Math.abs(l.y - word.y) < Math.max(l.h, word.h) * 0.5);
    if (line) {
      line.words.push(word);
      line.y = (line.y * (line.words.length - 1) + word.y) / line.words.length;
      line.h = Math.max(line.h, word.h);
    } else {
      lines.push({ y: word.y, h: word.h, words: [word] });
    }
  }
  lines.sort((a, b) => a.y - b.y);
  const out = [];
  for (const line of lines) {
    line.words.sort((a, b) => a.x - b.x);
    for (const w of line.words) out.push(w);
  }
  return out;
}

/** Squared distance from a point to a word's box (0 inside it). */
function distance2(word, px, py) {
  const dx = Math.max(word.x - px, 0, px - (word.x + word.w));
  const dy = Math.max(word.y - py, 0, py - (word.y + word.h));
  return dx * dx + dy * dy;
}

/** The word nearest a point — the caret's anchor. Never null when there are
 * words, so a drag that starts in a margin still selects from somewhere
 * sensible rather than doing nothing. */
export function nearestWord(words, px, py) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < words.length; i++) {
    const d = distance2(words[i], px, py);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** The words a drag from one point to another covers, in READING order — from
 * the first anchor to the second, whichever way round they were made. This is
 * what makes dragging down a column select the lines between, rather than the
 * rectangle they happen to span. */
export function wordsBetween(words, a, b) {
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return words.slice(lo, hi + 1);
}

/** Words whose boxes fall inside a rectangle — the other selection style, for
 * when reading order is not what you want (a table column, a figure caption
 * beside a paragraph). */
export function wordsInRect(words, x0, y0, x1, y1) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  return words.filter((w) =>
    w.x < bx && w.x + w.w > ax && w.y < by && w.y + w.h > ay);
}

/** The selected words as text, with a line break wherever the words step down
 * a line — so a paragraph copies as a paragraph and a column does not come out
 * as one endless line. */
export function selectionText(selected) {
  let out = "";
  let prev = null;
  for (const w of selected) {
    if (prev) {
      const sameLine = Math.abs(w.y - prev.y) < Math.max(w.h, prev.h) * 0.5;
      out += sameLine ? " " : "\n";
    }
    out += w.str;
    prev = w;
  }
  return out;
}

/** One rectangle per LINE of the selection rather than one per word, so the
 * highlight reads as a block of text instead of a row of separate stamps. */
export function selectionRects(selected) {
  const rects = [];
  let cur = null;
  for (const w of selected) {
    if (cur && Math.abs(w.y - cur.y) < Math.max(w.h, cur.h) * 0.5) {
      cur.x1 = Math.max(cur.x1, w.x + w.w);
      cur.h = Math.max(cur.h, w.h);
      cur.y = Math.min(cur.y, w.y);
    } else {
      if (cur) rects.push([cur.x0, cur.y, cur.x1 - cur.x0, cur.h]);
      cur = { x0: w.x, y: w.y, x1: w.x + w.w, h: w.h };
    }
  }
  if (cur) rects.push([cur.x0, cur.y, cur.x1 - cur.x0, cur.h]);
  return rects;
}
