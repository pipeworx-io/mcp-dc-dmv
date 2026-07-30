interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * District of Columbia DMV MCP — DMV service centers, the record-level vehicle-inspection
 * file, and traffic-conviction records. Keyless.
 *
 * One pack per state agency: DC's grain is unlike any state's. The District publishes
 * 766,879 individual vehicle inspections keyed by VIN and 330,728 individual traffic
 * convictions keyed by citation, both as ArcGIS tables on the DCGIS server — not the
 * county-aggregated counts other states publish — so the tools take VINs, citation codes
 * and date ranges rather than a county argument.
 *
 * Sources (verified live 2026-07-30):
 *   DCGIS Public_Service_WebMercator/MapServer/4  — District agency locations, filtered to
 *       the 9 rows whose DEPARTMENT is "Department of Motor Vehicles"
 *   DCGIS Transportation_DMV_WebMercator/MapServer/1   — "DMV Vehicle Inspections", 766,879
 *       rows, inspections from 2020-11-01 to 2026-06-30, still being appended
 *   DCGIS Transportation_DMV_WebMercator/MapServer/151 — "DMV Convictions", 330,728 rows,
 *       citations from 2002 to 2026 with violation and disposition text
 *
 * COORDINATE TRAP: the office layer's XCOORD/YCOORD columns are Maryland State Plane metres
 * (394380.55, 137456.23), which look like plausible numbers and are not lat/lng. Every query
 * here asks arcgisQuery for `geometry: true` (which sets outSR=4326) and reads latitude and
 * longitude off the returned geometry. Never read XCOORD/YCOORD as coordinates.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-dc-dmv/1.0 (+https://pipeworx.io)';
const OFFICES_LAYER =
  'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Service_WebMercator/MapServer/4';
const DMV_SERVICE =
  'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Transportation_DMV_WebMercator/MapServer';
const INSPECTIONS_LAYER = `${DMV_SERVICE}/1`;
const CONVICTIONS_LAYER = `${DMV_SERVICE}/151`;

/** The DCGIS server caps a single response at 2,000 rows, grouped statistics included. */
const ARCGIS_PAGE = 2000;

const tools: McpToolExport['tools'] = [
  {
    name: 'dc_dmv_offices',
    description:
      'Find a Washington DC DMV location — the District of Columbia Department of Motor Vehicles service centers where residents renew a license, register a vehicle or get a REAL ID, plus the Half Street inspection station, the two self-service emissions-inspection kiosks, the Deanwood road-test and CDL center, and Adjudication Services for ticket hearings. Returns street address, coordinates and the DMV website. Answers "DC DMV near Georgetown", "where is the DC vehicle inspection station", "DC DMV road test location", and "how many DMV service centers does Washington DC have". Covers all 9 published DMV locations.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Location-name substring, e.g. "Georgetown", "Benning", "Inspection", "Adjudication".' },
        office_type: { type: 'string', description: 'Category substring: "service center", "inspection station", "kiosk", "road test", "adjudication".' },
        limit: { type: ['number', 'string'], description: 'Max locations to return (default 25, max 50).' },
      },
    },
  },
  {
    name: 'dc_dmv_vehicle_inspections',
    description:
      'Look up Washington DC vehicle safety and emissions inspections by VIN, or count DC inspection volume over time. The District of Columbia DMV publishes 766,879 individual inspection records, each carrying the submitted VIN, the date the vehicle was inspected and the date that inspection expires, covering November 2020 to June 2026 and still being appended. Answers "when was VIN 1FMCU9BZ5NUA87486 last inspected in DC", "when does this car\'s DC inspection expire", "how many vehicles did DC inspect last month", and "DC inspection volume by month". A VIN prefix matches every vehicle of the same make, model and plant, so vin_prefix="1FMCU9BZ" counts one model line.',
    inputSchema: {
      type: 'object',
      properties: {
        vin: { type: 'string', description: 'Full 17-character VIN, e.g. "W1KAF4GB5SR257239". Case-insensitive.' },
        vin_prefix: { type: 'string', description: 'Leading characters of a VIN, e.g. "1FMCU9BZ" — the first 8 identify make, model line and body, so this counts one model.' },
        inspected_since: { type: 'string', description: 'Earliest inspection date, YYYY-MM-DD, e.g. "2026-01-01".' },
        inspected_before: { type: 'string', description: 'Latest inspection date, YYYY-MM-DD, e.g. "2026-07-01".' },
        expires_before: { type: 'string', description: 'Keep inspections expiring before this date, YYYY-MM-DD — the way to find vehicles due for re-inspection.' },
        group_by: { type: 'string', description: 'none (default) returns individual inspection records; month or year returns inspection counts per period.' },
        limit: { type: ['number', 'string'], description: 'Max records or periods to return (default 25, max 200).' },
      },
    },
  },
  {
    name: 'dc_dmv_convictions',
    description:
      'Count Washington DC traffic convictions by violation and court disposition, from the District of Columbia DMV conviction file — 330,728 citation records running from 2002 to 2026, each with the violation text (speeding, failure to use a seat belt, driving under the influence, no DC permit), the court disposition, and whether points were assessed. Answers "most common traffic violations in DC", "how many DUI convictions did DC record last year", "DC seat belt ticket convictions", and "what happens to DC speeding tickets in court". Group by violation or disposition, and narrow with a citation date range.',
    inputSchema: {
      type: 'object',
      properties: {
        violation: { type: 'string', description: 'Violation-text substring, e.g. "SPEED", "SEAT BELT", "INFLUENCE", "INSURANCE".' },
        code: { type: 'string', description: 'DC violation code, e.g. "T001", "T005".' },
        disposition: { type: 'string', description: 'Court-disposition substring, e.g. "GUILTY", "LIABLE", "SUPERIOR".' },
        since: { type: 'string', description: 'Earliest citation date, YYYY-MM-DD, e.g. "2025-01-01".' },
        before: { type: 'string', description: 'Latest citation date, YYYY-MM-DD, e.g. "2026-01-01".' },
        group_by: { type: 'string', description: 'violation (default) counts convictions per violation; disposition counts them per court outcome; none returns individual citation records.' },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200).' },
      },
    },
  },
];

// ── Shared query plumbing ───────────────────────────────────────────

/** Strip everything a VIN or code cannot contain, so a value is safe inside a SQL literal. */
function alnum(v: string): string {
  return v.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Escape a value for a single-quoted ArcGIS SQL literal. */
function sqlEsc(v: string): string {
  return v.replace(/'/g, "''");
}

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function dateLiteral(v: string): string {
  return `timestamp '${v} 00:00:00'`;
}

/** ArcGIS epoch-milliseconds → YYYY-MM-DD, or null. */
function isoDay(v: unknown): string | null {
  const n = govNumber(v);
  if (n === null) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

interface StatFeature {
  attributes: Record<string, unknown>;
}

/** Grouped counts. Returns the raw features so each caller can shape its own labels. */
async function groupedCount(
  layerUrl: string,
  groupField: string,
  where: string,
): Promise<StatFeature[]> {
  const p = new URLSearchParams({
    where,
    groupByFieldsForStatistics: groupField,
    outStatistics: JSON.stringify([
      { statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' },
    ]),
    orderByFields: 'n DESC',
    f: 'json',
  });
  const body = await govFetchJson<{ features?: StatFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    { userAgent: UA, timeoutMs: 20_000 },
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'grouped query rejected'}`);
  return body.features ?? [];
}

async function rowCount(layerUrl: string, where: string): Promise<number | null> {
  try {
    const body = await govFetchJson<{ count?: number }>(
      `${layerUrl}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`,
      { userAgent: UA, retries: 0 },
    );
    return typeof body.count === 'number' ? body.count : null;
  } catch {
    return null;
  }
}

/** Earliest and latest value of a date column, for an honest `coverage` field. */
async function dateCoverage(layerUrl: string, field: string): Promise<{ from: string | null; to: string | null }> {
  try {
    const p = new URLSearchParams({
      where: '1=1',
      outStatistics: JSON.stringify([
        { statisticType: 'min', onStatisticField: field, outStatisticFieldName: 'mn' },
        { statisticType: 'max', onStatisticField: field, outStatisticFieldName: 'mx' },
      ]),
      f: 'json',
    });
    const body = await govFetchJson<{ features?: StatFeature[] }>(`${layerUrl}/query?${p.toString()}`, {
      userAgent: UA,
      retries: 0,
    });
    const a = body.features?.[0]?.attributes ?? {};
    return { from: isoDay(a.MN ?? a.mn), to: isoDay(a.MX ?? a.mx) };
  } catch {
    return { from: null, to: null };
  }
}

// ── Offices ─────────────────────────────────────────────────────────

/** DC encodes what a location does in its name; turn that into a type plus service tags. */
function classifyOffice(name: string): { type: string; services: string[] } {
  const n = name.toLowerCase();
  if (n.includes('kiosk')) {
    return { type: 'Self-service emissions inspection kiosk', services: ['vehicle emissions inspection', 'self-service'] };
  }
  if (n.includes('inspection')) {
    return { type: 'Vehicle inspection station', services: ['vehicle safety inspection', 'vehicle emissions inspection'] };
  }
  if (n.includes('road test') || n.includes('cdl')) {
    return { type: 'Road test and CDL center', services: ['road test', 'CDL test'] };
  }
  if (n.includes('adjudication')) {
    return { type: 'Adjudication services', services: ['ticket hearings', 'adjudication'] };
  }
  return {
    type: 'DMV service center',
    services: ['driver license', 'ID card', 'REAL ID', 'vehicle registration', 'title'],
  };
}

async function offices(args: Record<string, unknown>): Promise<unknown> {
  // The layer holds every District agency location; DMV rows are tagged both ways, and the
  // two conditions disagree on a handful of rows historically, so keep the OR.
  const feats = await arcgisQuery(OFFICES_LAYER, {
    where: "DEPARTMENT LIKE '%Motor Vehicle%' OR ABBREV = 'DMV'",
    limit: 200,
    geometry: true,
    userAgent: UA,
  });
  if (!feats.length) {
    return govNotFound(
      'upstream_empty',
      'DCGIS returned no DMV rows from the District agency layer; retry once — the layer normally carries 9 DMV locations.',
    );
  }

  let list = feats.map((f) => {
    const a = f.attributes;
    const name = String(a.NAME ?? '');
    const { type, services } = classifyOffice(name);
    return {
      state: 'DC',
      name,
      office_type: type,
      address: (a.MATCHADDR as string) ?? (a.ADDRESS as string) ?? null,
      city: 'Washington',
      county: 'District of Columbia',
      // The layer carries no ZIP; MATCHADDR is the District's own geocoded street address.
      zip: null,
      phone: null,
      hours: null,
      // Read coordinates from the reprojected geometry, never from XCOORD/YCOORD —
      // those are Maryland State Plane metres.
      latitude: govNumber(f.geometry?.y),
      longitude: govNumber(f.geometry?.x),
      services,
      url: (a.WEBURL as string) ?? null,
      department: (a.DEPARTMENT as string) ?? null,
      mar_id: govNumber(a.MAR_ID),
      gis_id: (a.GIS_ID as string) ?? null,
    };
  });

  const name = govString(args, 'name');
  if (name) list = list.filter((o) => govContains(o.name, name));
  const type = govString(args, 'office_type');
  if (type) list = list.filter((o) => govContains(o.office_type, type) || o.services.some((s) => govContains(s, type)));

  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      `No DC DMV location matched those filters. There are only ${feats.length}; call with no arguments for the full list, or try name="Georgetown" or office_type="service center".`,
      { filters_applied: { name, office_type: type }, total_offices: feats.length },
    );
  }

  const limit = govLimit(args.limit, 25, 50);
  return {
    state: 'DC',
    agency: 'District of Columbia Department of Motor Vehicles',
    source: 'DCGIS Public_Service layer 4 — District agency locations, DMV rows',
    office_count: list.length,
    truncated: list.length > limit,
    offices: list.slice(0, limit),
    note: 'Coordinates are reprojected to WGS84 by the query; the layer\'s own XCOORD/YCOORD columns are Maryland State Plane metres and are omitted so they cannot be mistaken for lat/lng. Hours are not published in this layer — dmv.dc.gov posts them per location.',
  };
}

// ── Vehicle inspections ─────────────────────────────────────────────

async function vehicleInspections(args: Record<string, unknown>): Promise<unknown> {
  const clauses: string[] = [];
  const applied: Record<string, unknown> = {};

  const vin = govString(args, 'vin');
  if (vin) {
    const clean = alnum(vin);
    clauses.push(`UPPER(SUBMITTED_VIN) = '${sqlEsc(clean)}'`);
    applied.vin = clean;
  }
  const vinPrefix = govString(args, 'vin_prefix');
  if (vinPrefix) {
    const clean = alnum(vinPrefix);
    clauses.push(`UPPER(SUBMITTED_VIN) LIKE '${sqlEsc(clean)}%'`);
    applied.vin_prefix = clean;
  }
  for (const [arg, field, op] of [
    ['inspected_since', 'INSPECTION_DATE', '>='],
    ['inspected_before', 'INSPECTION_DATE', '<'],
    ['expires_before', 'INSPECTION_EXPIRATION_DATE', '<'],
  ] as const) {
    const v = govString(args, arg);
    if (!v) continue;
    if (!isIsoDate(v)) {
      return govNotFound(
        'bad_date',
        `${arg} must be a YYYY-MM-DD date, e.g. "2026-01-01". DC inspections run from 2020-11-01 onward.`,
        { [arg]: v },
      );
    }
    clauses.push(`${field} ${op} ${dateLiteral(v)}`);
    applied[arg] = v;
  }

  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  const groupKey = (govString(args, 'group_by') ?? 'none').toLowerCase();
  const limit = govLimit(args.limit, 25, 200);
  const coverage = await dateCoverage(INSPECTIONS_LAYER, 'INSPECTION_DATE');
  const source = 'DCGIS Transportation_DMV layer 1 — DC DMV Vehicle Inspections';

  if (groupKey === 'month' || groupKey === 'year') {
    // DC stores one row per inspection with a day-grained date; group by day upstream
    // (1,874 distinct days over the whole file, inside the 2,000-row cap) and roll up here.
    const feats = await groupedCount(INSPECTIONS_LAYER, 'INSPECTION_DATE', where);
    if (!feats.length) {
      return govNotFound(
        'no_matching_inspections',
        'No DC inspections matched those filters. Widen the date range — the file starts 2020-11-01 — or drop vin_prefix.',
        { filters_applied: applied },
      );
    }
    const buckets = new Map<string, number>();
    for (const f of feats) {
      const day = isoDay(f.attributes.INSPECTION_DATE);
      if (!day) continue;
      const key = groupKey === 'year' ? day.slice(0, 4) : day.slice(0, 7);
      buckets.set(key, (buckets.get(key) ?? 0) + (govNumber(f.attributes.n ?? f.attributes.N) ?? 0));
    }
    const rows = [...buckets.entries()]
      .map(([period, inspections]) => ({ [groupKey]: period, inspections }))
      .sort((a, b) => String(b[groupKey]).localeCompare(String(a[groupKey])));
    const shown = rows.slice(0, limit);
    return {
      state: 'DC',
      agency: 'District of Columbia Department of Motor Vehicles',
      grain: `count of vehicle inspections per ${groupKey}`,
      as_of: coverage.to,
      source,
      coverage,
      sum_of_returned_rows: shown.reduce((a, r) => a + (Number(r.inspections) || 0), 0),
      truncated: rows.length > limit || feats.length >= ARCGIS_PAGE,
      rows: shown,
      ...(feats.length >= ARCGIS_PAGE
        ? { note: 'The upstream day-level grouping hit the 2,000-row server cap, so the earliest periods may be understated — narrow with inspected_since.' }
        : {}),
    };
  }

  const total = await rowCount(INSPECTIONS_LAYER, where);
  const feats = await arcgisQuery(INSPECTIONS_LAYER, {
    where,
    outFields: 'OBJECTID,SUBMITTED_VIN,INSPECTION_DATE,INSPECTION_EXPIRATION_DATE,STATUS',
    orderBy: 'INSPECTION_DATE DESC',
    limit,
    userAgent: UA,
    timeoutMs: 20_000,
  });
  if (!feats.length) {
    return govNotFound(
      'no_matching_inspections',
      vin
        ? `No DC inspection record carries VIN ${applied.vin}. DC only publishes vehicles inspected in the District from 2020-11-01 onward; try vin_prefix with the first 8 characters to see whether the same model appears.`
        : 'No DC inspections matched those filters. Widen the date range — the file runs 2020-11-01 to 2026-06-30 — or drop vin_prefix.',
      { filters_applied: applied },
    );
  }

  return {
    state: 'DC',
    agency: 'District of Columbia Department of Motor Vehicles',
    grain: 'one row per vehicle inspection, keyed by submitted VIN',
    as_of: coverage.to,
    source,
    coverage,
    matching_records: total,
    returned: feats.length,
    truncated: total !== null && total > feats.length,
    inspections: feats.map((f) => ({
      vin: (f.attributes.SUBMITTED_VIN as string) ?? null,
      inspection_date: isoDay(f.attributes.INSPECTION_DATE),
      inspection_expiration_date: isoDay(f.attributes.INSPECTION_EXPIRATION_DATE),
      status: (f.attributes.STATUS as string) ?? null,
    })),
    note: 'The file records that an inspection happened and when the resulting certificate expires. DC leaves the STATUS column empty on every row, so a pass/fail outcome is not published here — an expiration date roughly two years out is the usual sign of a passed inspection, and a short one of a re-inspection window. For per-test pass/fail detail with make and model, New Jersey publishes it via nj_mvc_vehicle_inspections.',
  };
}

// ── Convictions ─────────────────────────────────────────────────────

/**
 * Roughly half the conviction rows prefix the violation text with a four-digit internal
 * code, so "SPEED IN EXCESS OF LIMIT" and "0201SPEED IN EXCESS OF LIMIT" are the same
 * offence split across two buckets. Strip the prefix and merge, or every ranking is wrong.
 */
function normaliseViolation(label: string): string {
  return label.replace(/^\d{4}(?=[A-Z])/, '').trim();
}

async function convictions(args: Record<string, unknown>): Promise<unknown> {
  const clauses: string[] = [];
  const applied: Record<string, unknown> = {};

  const violation = govString(args, 'violation');
  if (violation) {
    clauses.push(`UPPER(CODE_DESCRIPTION) LIKE '%${sqlEsc(violation.toUpperCase())}%'`);
    applied.violation = violation;
  }
  const code = govString(args, 'code');
  if (code) {
    clauses.push(`UPPER(CODE) = '${sqlEsc(alnum(code))}'`);
    applied.code = alnum(code);
  }
  const disposition = govString(args, 'disposition');
  if (disposition) {
    clauses.push(`UPPER(DISPO_CODE_DESCRIPTION) LIKE '%${sqlEsc(disposition.toUpperCase())}%'`);
    applied.disposition = disposition;
  }
  for (const [arg, op] of [['since', '>='], ['before', '<']] as const) {
    const v = govString(args, arg);
    if (!v) continue;
    if (!isIsoDate(v)) {
      return govNotFound('bad_date', `${arg} must be a YYYY-MM-DD date, e.g. "2025-01-01". DC citations run from 2002 onward.`, {
        [arg]: v,
      });
    }
    clauses.push(`CITATION_DATE ${op} ${dateLiteral(v)}`);
    applied[arg] = v;
  }

  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  const groupKey = (govString(args, 'group_by') ?? 'violation').toLowerCase();
  const limit = govLimit(args.limit, 25, 200);
  const coverage = await dateCoverage(CONVICTIONS_LAYER, 'CITATION_DATE');
  const source = 'DCGIS Transportation_DMV layer 151 — DC DMV Convictions';

  if (groupKey === 'violation' || groupKey === 'disposition') {
    const field = groupKey === 'violation' ? 'CODE_DESCRIPTION' : 'DISPO_CODE_DESCRIPTION';
    const feats = await groupedCount(CONVICTIONS_LAYER, field, where);
    if (!feats.length) {
      return govNotFound(
        'no_matching_convictions',
        'No DC convictions matched those filters. Violation text is upper case and terse — try violation="SPEED" or violation="SEAT BELT" — and citations only run from 2002.',
        { filters_applied: applied },
      );
    }
    const buckets = new Map<string, number>();
    for (const f of feats) {
      const raw = String(f.attributes[field] ?? '').trim();
      if (!raw) continue;
      const label = groupKey === 'violation' ? normaliseViolation(raw) : raw;
      buckets.set(label, (buckets.get(label) ?? 0) + (govNumber(f.attributes.n ?? f.attributes.N) ?? 0));
    }
    const rows = [...buckets.entries()]
      .map(([label, convictions_count]) => ({ [groupKey]: label, convictions: convictions_count }))
      .sort((a, b) => (b.convictions ?? 0) - (a.convictions ?? 0));
    const shown = rows.slice(0, limit);
    return {
      state: 'DC',
      agency: 'District of Columbia Department of Motor Vehicles',
      grain: `count of traffic convictions per ${groupKey}`,
      as_of: coverage.to,
      source,
      coverage,
      distinct_groups: rows.length,
      sum_of_returned_rows: shown.reduce((a, r) => a + (Number(r.convictions) || 0), 0),
      truncated: rows.length > limit,
      rows: shown,
      ...(groupKey === 'violation'
        ? { note: 'Upstream prefixes about half the violation strings with a four-digit internal code ("0201SPEED IN EXCESS OF LIMIT"); those buckets are merged with their unprefixed twin here, so counts are higher than a raw group-by on the layer returns.' }
        : {}),
    };
  }

  const total = await rowCount(CONVICTIONS_LAYER, where);
  const feats = await arcgisQuery(CONVICTIONS_LAYER, {
    where,
    outFields:
      'OBJECTID,CITATION_ID,CITATION_DATE,CODE,CODE_DESCRIPTION,DISPOSITION_DATE,DISPOSITION_CODE,DISPO_CODE_DESCRIPTION,FINAL_DISP_CODE,FINAL_DISP_CODE_DESCRIPTION',
    orderBy: 'CITATION_DATE DESC',
    limit,
    userAgent: UA,
    timeoutMs: 20_000,
  });
  if (!feats.length) {
    return govNotFound(
      'no_matching_convictions',
      'No DC conviction records matched those filters. Try violation="SPEED" with no date range first, then narrow.',
      { filters_applied: applied },
    );
  }
  return {
    state: 'DC',
    agency: 'District of Columbia Department of Motor Vehicles',
    grain: 'one row per traffic-conviction citation',
    as_of: coverage.to,
    source,
    coverage,
    matching_records: total,
    returned: feats.length,
    truncated: total !== null && total > feats.length,
    convictions: feats.map((f) => {
      const a = f.attributes;
      return {
        citation_id: govNumber(a.CITATION_ID),
        citation_date: isoDay(a.CITATION_DATE),
        code: (a.CODE as string) ?? null,
        violation: normaliseViolation(String(a.CODE_DESCRIPTION ?? '')) || null,
        disposition_date: isoDay(a.DISPOSITION_DATE),
        disposition_code: (a.DISPOSITION_CODE as string) ?? null,
        disposition: (a.DISPO_CODE_DESCRIPTION as string) ?? null,
        final_disposition: (a.FINAL_DISP_CODE_DESCRIPTION as string) ?? null,
      };
    }),
    note: 'Rows are convictions, so a citation that was dismissed or never adjudicated does not appear. final_disposition says whether points were assessed against the licence.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'dc_dmv_offices': return await offices(args);
      case 'dc_dmv_vehicle_inspections': return await vehicleInspections(args);
      case 'dc_dmv_convictions': return await convictions(args);
      default:
        return govNotFound('unknown_tool', `dc-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `dc-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'The DCGIS ArcGIS server timed out. Retry once, and add a date range or lower `limit` — the inspection and conviction tables are large enough that an unfiltered scan is slow.'
        : 'DCGIS refused the request or changed shape. Retry once; if it persists the DMV MapServer layer ids may have been renumbered.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
