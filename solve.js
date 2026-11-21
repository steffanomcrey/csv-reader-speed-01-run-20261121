// SPDX-License-Identifier: MIT
// Fast single-pass CSV reader, exact csv-reader 1.0.0 broken-row semantics.
//
// Design: one left-to-right scan of the whole text. A plain field is taken
// with one slice, cut at the nearest comma or line break found by indexOf.
// A quoted field is taken with one slice too, from its opening quote to the
// first closing quote, whenever the content holds no doubled quote and no
// line break. Only the rare broken shapes fall back to a segment walk:
// doubled quotes, a line break inside quotes, a stray CR, junk after a
// closing quote, or a quote that never closes. No state is kept between
// calls, no imports, no WASM, no native code.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** One CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  // Index of the next LF at or after pos, or n when none is left; -1 means
  // unknown. It stays valid across plain fields of one record (a plain
  // field never passes a line break), so the line break is searched once
  // per record instead of once per field. Quoted fields and the slow paths
  // may pass line breaks, so they clear it.
  let lfPos = -1;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at `start`, on top of `value`, the
  // segment way: slice to the next comma or line break, drop a stray CR
  // (one stray_cr error each) and keep going. Returns the field, how it
  // ended, and how many characters were kept on top of `value`.
  function readUnquotedSlow(start, value) {
    lfPos = -1;
    let added = 0;
    pos = start;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const li = text.indexOf('\n', pos);
      let end;
      let kind;
      if (ci === -1 && li === -1) {
        end = n;
        kind = END;
      } else if (ci !== -1 && (li === -1 || ci < li)) {
        end = ci;
        kind = COMMA;
      } else {
        end = li;
        kind = LINE_BREAK;
      }
      const seg = text.slice(pos, end);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        if (seg.length !== 0) {
          value += seg;
          added += seg.length;
        }
        if (kind === COMMA) {
          pos = end + 1;
          return { value, ended: COMMA, added };
        }
        if (kind === LINE_BREAK) {
          pos = end + 1;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        pos = end;
        return { value, ended: END, added };
      }
      const cr = pos + ri;
      if (text.charCodeAt(cr + 1) === 10) {
        // The CR sits right before the line break: CRLF, one line break.
        if (ri !== 0) {
          value += seg.slice(0, ri);
          added += ri;
        }
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      error('stray_cr');
      if (ri !== 0) {
        value += seg.slice(0, ri);
        added += ri;
      }
      pos = cr + 1;
    }
  }

  // What follows a closing quote: comma, line break, end of text, or junk
  // read as an unquoted field (quote_junk when the junk kept anything).
  function afterClose(value) {
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    const junk = readUnquotedSlow(pos, value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Reads a quoted field whose opening quote is at pos, the segment way:
  // doubled quotes collapse to one, a CR or CRLF inside becomes one LF and
  // counts a line, a lone LF counts a line. A quote that never closes is a
  // literal character and the rest is re-read as unquoted. The scan jumps
  // from quote to quote with indexOf instead of walking every character:
  // the stretch up to the next quote is sliced at once, and only a stretch
  // that actually holds a line break is walked break by break.
  function readQuotedSlow(open, openLine) {
    lfPos = -1;
    pos = open + 1;
    line = openLine;
    const parts = [];
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquotedSlow(open + 1, '"');
      }
      const seg = text.slice(pos, q);
      const ni = seg.indexOf('\n');
      const ri = seg.indexOf('\r');
      if (ni === -1 && ri === -1) {
        if (text.charCodeAt(q + 1) === 34) {
          parts.push(seg);
          parts.push('"');
          pos = q + 2;
          continue;
        }
        parts.push(seg);
        pos = q + 1;
        return afterClose(parts.join(''));
      }
      // Line breaks inside this stretch: fold each one to a single LF.
      let j = 0;
      for (;;) {
        const a = seg.indexOf('\n', j);
        const b = seg.indexOf('\r', j);
        let bi = -1;
        let isCr = false;
        if (a !== -1 && (b === -1 || a < b)) bi = a;
        else if (b !== -1) {
          bi = b;
          isCr = true;
        }
        if (bi === -1) break;
        parts.push(seg.slice(j, bi));
        parts.push('\n');
        line += 1;
        j = bi + (isCr && seg.charCodeAt(bi + 1) === 10 ? 2 : 1);
      }
      parts.push(seg.slice(j));
      if (text.charCodeAt(q + 1) === 34) {
        parts.push('"');
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      return afterClose(parts.join(''));
    }
  }

  // Reads a quoted field whose opening quote is at pos. Fast path: the
  // first quote found closes the field and the content holds no line
  // break, so the field is a single slice.
  function readQuoted() {
    lfPos = -1;
    const open = pos;
    const openLine = line;
    pos += 1;
    const q = text.indexOf('"', pos);
    if (q === -1) {
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquotedSlow(open + 1, '"');
    }
    if (text.charCodeAt(q + 1) === 34) return readQuotedSlow(open, openLine);
    const content = text.slice(pos, q);
    if (content.indexOf('\n') !== -1 || content.indexOf('\r') !== -1) {
      return readQuotedSlow(open, openLine);
    }
    pos = q + 1;
    return afterClose(content);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    lfPos = -1;
    const fields = [];
    let ended;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const field = readQuoted();
        fields.push(field.value);
        ended = field.ended;
      } else {
        // Plain field, inlined: one slice to the nearest comma or to the
        // cached line break, no call and no result object per field.
        lastQuoted = false;
        if (lfPos < pos) {
          const l = text.indexOf('\n', pos);
          lfPos = l === -1 ? n : l;
        }
        const ci = text.indexOf(',', pos);
        let end;
        let kind;
        if (ci !== -1 && ci < lfPos) {
          end = ci;
          kind = COMMA;
        } else {
          end = lfPos;
          kind = lfPos === n ? END : LINE_BREAK;
        }
        const seg = text.slice(pos, end);
        const ri = seg.indexOf('\r');
        if (ri === -1) {
          fields.push(seg);
          if (kind === COMMA) pos = end + 1;
          else if (kind === LINE_BREAK) {
            pos = end + 1;
            line += 1;
          } else pos = end;
          ended = kind;
        } else if (kind === LINE_BREAK && ri === seg.length - 1) {
          // Trailing CR before the LF: a CRLF line break, not a stray CR.
          fields.push(seg.slice(0, ri));
          pos = end + 1;
          line += 1;
          ended = LINE_BREAK;
        } else {
          // A stray CR sits inside the field: the segment path drops it.
          const field = readUnquotedSlow(pos, '');
          fields.push(field.value);
          ended = field.ended;
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
