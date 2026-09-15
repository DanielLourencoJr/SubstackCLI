/**
 * Minimal YAML frontmatter parser (no deps).
 * Parses `---` block at start of file:
 * ---
 * title: Hello
 * subtitle: Sub
 * audience: everyone
 * slug: my-slug
 * tags: [a, b]
 * cover_image: https://...
 * ---
 * Returns { data, body } where body is markdown without frontmatter.
 * Supports: strings (quoted or not), simple arrays [a, b] or - list (not needed), booleans.
 */

export function parseFrontmatter(markdown) {
  const src = markdown.replace(/\r\n/g, "\n");
  if (!src.startsWith("---")) return { data: {}, body: markdown };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: markdown };
  const fmRaw = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\n/, ""); // skip closing --- line
  const data = {};
  const lines = fmRaw.split("\n");
  let currentKey = null;
  let inArray = false;
  let arrayBuf = [];

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // array continuation: - item
    if (inArray && line.startsWith("-")) {
      const val = line.slice(1).trim().replace(/^["']|["']$/g, "");
      arrayBuf.push(val);
      continue;
    }
    if (inArray && !line.startsWith("-")) {
      // array ended
      data[currentKey] = arrayBuf;
      inArray = false;
      arrayBuf = [];
      currentKey = null;
      // fall through to parse current line as key
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    // array start: key: [a, b]  or key: \n  - a\n  - b
    if (val === "" || val === "[") {
      // look ahead: if next lines are "- " then it's block array
      // peek next lines
      const nextIdx = lines.indexOf(raw) + 1;
      // Simple heuristic: if val empty, start block array
      if (val === "") {
        // check if next non-empty starts with -
        // defer: if next line starts with -, treat as block array
        // We'll set inArray and wait
        // But need to detect inline array vs empty
        // If val==="" and next line is "- ", then array
        // else keep as empty string
        // Quick peek
        let peek = "";
        for (let j = lines.indexOf(raw) + 1; j < lines.length; j++) {
          const nl = lines[j].trim();
          if (!nl) continue;
          peek = nl;
          break;
        }
        if (peek.startsWith("-") || peek.startsWith("[")) {
          inArray = true;
          currentKey = key;
          arrayBuf = [];
          if (peek.startsWith("[")) {
            // will be handled as inline next iteration
            inArray = false;
          }
          continue;
        }
      }
    }
    // inline array: [a, b, "c d"]
    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      if (!inner) data[key] = [];
      else {
        // split by comma not inside quotes (simple)
        const parts = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        data[key] = parts.filter(Boolean);
      }
      continue;
    }
    // quoted string
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
      data[key] = val;
      continue;
    }
    // unquoted string / number / boolean
    if (val === "true") data[key] = true;
    else if (val === "false") data[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) data[key] = Number(val);
    else data[key] = val;
  }
  if (inArray && arrayBuf.length) data[currentKey] = arrayBuf;

  return { data, body };
}

export function stringifyFrontmatter(data) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    } else if (typeof v === "string") {
      // quote if needed
      if (/[:#\[\]{}&*!|>'"%@`,]|\n/.test(v) || /^\s|\s$/.test(v)) lines.push(`${k}: ${JSON.stringify(v)}`);
      else lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}
