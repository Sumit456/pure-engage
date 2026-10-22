// Fails if any contract element lacks a valid `x-evidence` label (see CLAUDE.md).
// Checked: info, OpenAPI operations / schemas / security schemes, AsyncAPI channels /
// operations / messages / schemas. INFERRED must cite an ID in ASSUMPTIONS.md;
// CONFIRMED must cite a source.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const DIR = 'docs/contracts';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const assumptionIds = new Set(readFileSync(join(DIR, 'ASSUMPTIONS.md'), 'utf8').match(/^\| (A-\d{3}) /gm)?.map((s) => s.slice(2, 7)));

function elements(doc) {
  const out = [['info', doc.info]];
  const named = (prefix, obj) => Object.entries(obj || {}).forEach(([k, v]) => out.push([`${prefix}.${k}`, v]));
  if (doc.openapi) {
    for (const [path, item] of Object.entries(doc.paths || {})) {
      for (const m of METHODS) if (item[m]) out.push([`${m.toUpperCase()} ${path}`, item[m]]);
    }
    named('components.securitySchemes', doc.components?.securitySchemes);
  } else {
    named('channels', doc.channels);
    named('operations', doc.operations);
    named('components.messages', doc.components?.messages);
  }
  named('components.schemas', doc.components?.schemas);
  return out;
}

function problem(ev) {
  if (!ev) return 'missing x-evidence';
  if (ev.status === 'CONFIRMED') return ev.source ? null : 'CONFIRMED without source';
  if (ev.status === 'INFERRED') {
    if (!ev.assumption) return 'INFERRED without assumption';
    return assumptionIds.has(ev.assumption) ? null : `unknown assumption ${ev.assumption}`;
  }
  return `invalid status ${JSON.stringify(ev.status)}`;
}

let failures = 0;
for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const counts = { CONFIRMED: 0, INFERRED: 0 };
  for (const [name, el] of elements(parse(readFileSync(join(DIR, file), 'utf8')))) {
    const ev = el?.['x-evidence'];
    const err = problem(ev);
    if (err) { failures++; console.error(`✗ ${file}: ${name}: ${err}`); } else counts[ev.status]++;
  }
  console.log(`${file}: ${counts.CONFIRMED} CONFIRMED, ${counts.INFERRED} INFERRED`);
}
if (failures) { console.error(`${failures} element(s) without valid x-evidence`); process.exit(1); }
