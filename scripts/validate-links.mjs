#!/usr/bin/env node
/**
 * validate-links.mjs — strict schema validation for links.json.
 *
 * Used by .github/workflows/links-update.yml. Exits 0 if valid, 1 if not.
 * Fail-mode is STRICT (operator confirmed 2026-05-22): the workflow fails
 * red on any schema violation so bad data never deploys.
 *
 * Schema is INLINED here (not imported from @levr/builder) because the
 * V3 site template is a standalone repo — it gets cloned to a new repo
 * by the agentic builder and runs without the LEVR monorepo on disk.
 * Mirror of V3LinksAssignment / V3LinksJson in
 * packages/builder/src/agents/agentic-build-v3/types.ts.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
// links.json lives under public/ so the deployed Worker serves it via ASSETS
// (env.ASSETS.fetch('/links.json')). Keep in lockstep with finish.ts + the
// affiliate-manager API, which read/write public/links.json.
const LINKS_PATH = path.join(ROOT, 'public', 'links.json')

function fail(msg) {
  console.error(`[validate-links] ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(LINKS_PATH)) {
  // No links.json yet — that's fine on a freshly-built site. The runtime
  // worker falls back to unresolved spans for every placeholder.
  console.log('[validate-links] links.json missing — nothing to validate (ok).')
  process.exit(0)
}

let raw
try {
  raw = fs.readFileSync(LINKS_PATH, 'utf8')
} catch (e) {
  fail(`Failed to read links.json: ${e.message}`)
}

let data
try {
  data = JSON.parse(raw)
} catch (e) {
  fail(`links.json is not valid JSON: ${e.message}`)
}

// ── Root shape ─────────────────────────────────────────────────────────────
if (typeof data !== 'object' || data === null) {
  fail('links.json root must be an object')
}
if (data.schema_version !== '1.0') {
  fail(`schema_version must be "1.0" (got ${JSON.stringify(data.schema_version)})`)
}
if (!Array.isArray(data.assignments)) {
  fail('assignments must be an array')
}

// ── Per-assignment validation ──────────────────────────────────────────────
const seenIds = new Set()
const seenCodes = new Set()
const errors = []

for (let i = 0; i < data.assignments.length; i++) {
  const a = data.assignments[i]
  const prefix = `assignments[${i}]`
  if (!a || typeof a !== 'object') {
    errors.push(`${prefix}: must be an object`)
    continue
  }
  if (typeof a.assignment_id !== 'string' || !a.assignment_id) {
    errors.push(`${prefix}: assignment_id missing or not a string`)
  } else if (seenIds.has(a.assignment_id)) {
    errors.push(`${prefix}: duplicate assignment_id "${a.assignment_id}"`)
  } else {
    seenIds.add(a.assignment_id)
  }

  if (typeof a.code !== 'string' || !a.code) {
    errors.push(`${prefix}: code missing or not a string`)
  } else if (seenCodes.has(a.code)) {
    errors.push(`${prefix}: duplicate code "${a.code}"`)
  } else {
    seenCodes.add(a.code)
  }

  if (a.direction !== 'outgoing') {
    errors.push(`${prefix}: direction must be the literal "outgoing" (got ${JSON.stringify(a.direction)})`)
  }

  if (typeof a.target_url !== 'string' || !a.target_url) {
    errors.push(`${prefix}: target_url missing or not a string`)
  } else {
    let u
    try {
      u = new URL(a.target_url)
    } catch {
      errors.push(`${prefix}: target_url is not a valid URL`)
      continue
    }
    if (!u.protocol.startsWith('http')) {
      errors.push(`${prefix}: target_url must be http(s), got ${u.protocol}`)
    }
  }

  if (a.label !== undefined && typeof a.label !== 'string') {
    errors.push(`${prefix}: label must be a string if present`)
  }
}

if (errors.length > 0) {
  console.error('[validate-links] FAILED — schema violations:')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}

console.log(
  `[validate-links] ok — ${data.assignments.length} assignment(s) validated.`,
)
process.exit(0)
