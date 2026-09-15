import fs from "node:fs";

export function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const txt = fs.readFileSync(filePath, "utf8");
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function getSid({ envFile, token } = {}) {
  if (envFile) loadEnvFile(envFile);
  // also try default .env in cwd then central
  if (!process.env.SUBSTACK_SID) {
    // try Projects central files
    for (const p of [".env", "/mnt/HD/Junior/Projects/.substack.test.env", "/mnt/HD/Junior/Projects/.substack-credentials.env"]) {
      if (fs.existsSync(p)) {
        const c = fs.readFileSync(p, "utf8");
        // handle suffixed names in central file
        const m = c.match(/SUBSTACK_SID_TEST\s*=\s*(.+)/);
        if (p.endsWith(".substack-credentials.env") && m && !process.env.SUBSTACK_SID) {
          let v = m[1].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          process.env.SUBSTACK_SID = v;
        } else {
          loadEnvFile(p);
        }
        if (process.env.SUBSTACK_SID) break;
      }
    }
  }
  const sid = token || process.env.SUBSTACK_SID || process.env.SUBSTACK_SID_TEST || "";
  if (!sid) throw new Error("SUBSTACK_SID missing. Use --env .env or set SUBSTACK_SID. Central: /mnt/HD/Junior/Projects/.substack.test.env (TEST)");
  // ensure s%3A prefix is decoded? API wants raw cookie value; test file uses s%3A... encoded, .env uses s:... decoded.
  // Both work if sent as Cookie: substack.sid=<value>. We'll pass as-is.
  return sid;
}

export async function fetchProfileSelf(sid) {
  const r = await fetch("https://substack.com/api/v1/user/profile/self", {
    headers: { Cookie: `substack.sid=${sid}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`profile/self HTTP ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

export async function resolveBylines(sid, publicationUrl) {
  const profile = await fetchProfileSelf(sid);
  // profile.publications or publicationUsers
  const pubs = profile.publications || profile.publicationUsers || [];
  // try to match by URL subdomain
  let targetPubId = null;
  let userId = profile.id;
  let pubUserId = null;

  // Extract subdomain from publicationUrl like danielloureno.substack.com
  let wantedSub = null;
  if (publicationUrl) {
    try {
      const u = publicationUrl.startsWith("http") ? new URL(publicationUrl) : new URL(`https://${publicationUrl}`);
      wantedSub = u.hostname.split(".")[0];
    } catch { wantedSub = publicationUrl.split(".")[0]; }
  }

  // Find matching pub
  let found = null;
  for (const p of pubs) {
    // shapes: {id, subdomain} or {publication:{id, subdomain}}
    const pub = p.publication || p;
    const sub = pub.subdomain || pub.handle || "";
    if (wantedSub && sub === wantedSub) { found = p; break; }
  }
  if (!found) found = pubs[0];

  if (found) {
    const pub = found.publication || found;
    targetPubId = pub.id || pub.publication_id || null;
    // publicationUserId is the join id
    pubUserId = found.id && found.publication_id ? found.id : found.publicationUserId || found.id || null;
    // fallback: fetch publicationUsers array
    if (!pubUserId && profile.publicationUsers) {
      const pu = profile.publicationUsers.find((x) => (x.publication?.id || x.publication_id) === targetPubId);
      if (pu) pubUserId = pu.id;
    }
  }

  // bylines required per AGENTS.md: [{id: userId, publicationUserId: puId}]
  // Tests show [] also works for TEST account, but we try to provide correct one.
  const bylines = [];
  if (userId && pubUserId) bylines.push({ id: userId, publicationUserId: pubUserId });
  else if (userId) bylines.push({ id: userId });

  // If still unresolved, fallback to empty (allowed per test suite)
  return { userId, publicationId: targetPubId, pubUserId, bylines, profile };
}
