/*
  Reg lookup worker for the Workshop app. Runs on Cloudflare Workers (free plan).
  It keeps your API credentials private and adds the CORS headers a web app needs.
  The app calls it as:   https://YOUR-WORKER.workers.dev/?reg=AB12CDE

  Secrets to set in the worker (Settings > Variables and Secrets):

  DVSA MOT history API (free, gives make, model, colour, fuel, engine, year, MOT due, last mileage):
      MOT_CLIENT_ID       from the DVSA email
      MOT_CLIENT_SECRET   from the DVSA email (expires every 2 years, they email you before it does)
      MOT_TOKEN_URL       the full token URL from the DVSA email (contains your tenant id)
      MOT_API_KEY         from the DVSA email
      MOT_SCOPE           optional, defaults to https://tapi.dvsa.gov.uk/.default

  UK Vehicle Data / Vehicle Data Global (paid, instant signup, used only if the MOT ones are not set):
      UKVD_KEY            API key from their control panel
      UKVD_PACKAGE        optional, defaults to VehicleData

  DVLA Vehicle Enquiry Service (optional, used only if none of the above are set):
      DVLA_KEY

  ALLOWED_ORIGIN          optional, e.g. https://b0bert1us.github.io (blocks anyone else using your credentials)
*/
let tokenCache = { token: '', exp: 0 };

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (env.ALLOWED_ORIGIN) {
      const origin = request.headers.get('Origin') || '';
      if (origin !== env.ALLOWED_ORIGIN) return json({ error: 'Not allowed from here' }, 403, cors);
    }
    const reg = (new URL(request.url).searchParams.get('reg') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!reg) return json({ error: 'No reg given' }, 400, cors);
    try {
      if (env.MOT_CLIENT_ID && env.MOT_CLIENT_SECRET && env.MOT_TOKEN_URL && env.MOT_API_KEY) return json(await lookupMot(reg, env), 200, cors);
      if (env.UKVD_KEY) return json(await lookupUkvd(reg, env), 200, cors);
      if (env.DVLA_KEY) return json(await lookupDvla(reg, env.DVLA_KEY), 200, cors);
      return json({ error: 'No lookup credentials set on the worker yet' }, 500, cors);
    } catch (e) {
      return json({ error: e.message || 'Lookup failed' }, e.status || 502, cors);
    }
  }
};

/* ---- DVSA MOT history API ---- */
async function motToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.MOT_CLIENT_ID,
    client_secret: env.MOT_CLIENT_SECRET,
    scope: env.MOT_SCOPE || 'https://tapi.dvsa.gov.uk/.default'
  });
  const r = await fetch(env.MOT_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw Object.assign(new Error('Could not sign in to the DVSA (' + r.status + '). Check MOT_CLIENT_ID, MOT_CLIENT_SECRET and MOT_TOKEN_URL.'), { status: 502 });
  const t = await r.json();
  tokenCache = { token: t.access_token, exp: Date.now() + Math.max(60, (t.expires_in || 600) - 60) * 1000 };
  return tokenCache.token;
}

async function lookupMot(reg, env) {
  const token = await motToken(env);
  const r = await fetch('https://history.mot.api.gov.uk/v1/trade/vehicles/registration/' + encodeURIComponent(reg), {
    headers: { 'Authorization': 'Bearer ' + token, 'X-API-Key': env.MOT_API_KEY, 'Accept': 'application/json' }
  });
  if (r.status === 404) throw Object.assign(new Error('No vehicle found for ' + reg), { status: 404 });
  if (!r.ok) throw Object.assign(new Error('DVSA lookup failed (' + r.status + ')'), { status: 502 });
  const v = await r.json();
  const tests = (v.motTests || []).slice().sort((a, b) => String(b.completedDate || '').localeCompare(String(a.completedDate || '')));
  const last = tests[0] || null;
  const lastPass = tests.find(t => String(t.testResult || '').toUpperCase() === 'PASSED' && t.expiryDate) || null;
  const year = String(v.manufactureDate || v.registrationDate || v.firstUsedDate || '').slice(0, 4);
  return {
    reg: v.registration || reg,
    make: title(v.make),
    model: title(v.model),
    colour: title(v.primaryColour),
    fuel: title(v.fuelType),
    engine: v.engineSize || '',
    year: /^\d{4}$/.test(year) ? Number(year) : '',
    motDue: isoDate(lastPass ? lastPass.expiryDate : v.motTestDueDate),
    mileage: last && last.odometerValue ? String(last.odometerValue).replace(/[^0-9]/g, '') : '',
    mileageUnit: last ? (last.odometerUnit || '') : '',
    lastMotDate: last ? isoDate(last.completedDate) : '',
    lastMotResult: last ? title(last.testResult) : '',
    advisories: last ? (last.defects || []).filter(d => ['ADVISORY', 'MINOR'].includes(String(d.type || '').toUpperCase())).map(d => d.text) : [],
    failures: last ? (last.defects || []).filter(d => ['MAJOR', 'DANGEROUS', 'FAIL', 'PRS'].includes(String(d.type || '').toUpperCase())).map(d => d.text) : [],
    tests: tests.slice(0, 5).map(t => ({ date: isoDate(t.completedDate), result: title(t.testResult), mileage: t.odometerValue ? String(t.odometerValue).replace(/[^0-9]/g, '') : '', unit: t.odometerUnit || '' })),
    recall: v.hasOutstandingRecall || ''
  };
}

/* ---- UK Vehicle Data / Vehicle Data Global (paid, pay as you go) ----
   Written from their published URL format. If a lookup errors, open the worker's Logs in Cloudflare,
   compare the reply with the field names below and adjust. */
async function lookupUkvd(reg, env) {
  const pkg = env.UKVD_PACKAGE || 'VehicleData';
  const url = 'https://uk1.ukvehicledata.co.uk/api/datapackage/' + pkg + '?v=2&api_nullitems=1&auth_apikey=' + encodeURIComponent(env.UKVD_KEY) + '&key_VRM=' + encodeURIComponent(reg);
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error('UKVD lookup failed (' + r.status + ')'), { status: 502 });
  const data = await r.json();
  const resp = data.Response || {};
  if (resp.StatusCode && resp.StatusCode !== 'Success') throw Object.assign(new Error('UKVD: ' + (resp.StatusMessage || resp.StatusCode)), { status: resp.StatusCode === 'KeyInvalid' ? 500 : 404 });
  const items = resp.DataItems || {};
  const v = items.VehicleRegistration || {};
  const mot = items.VehicleStatus || items.MotVed || {};
  return {
    reg: v.Vrm || reg,
    make: title(v.Make),
    model: title(v.Model),
    colour: title(v.Colour),
    fuel: title(v.FuelType),
    engine: v.EngineCapacity || '',
    year: v.YearOfManufacture || String(v.DateFirstRegistered || '').slice(0, 4) || '',
    motDue: isoDate(mot.MotDueDate || mot.MotExpiryDate || ''),
    transmission: title(v.Transmission)
  };
}

/* ---- DVLA Vehicle Enquiry Service (kept for when their registrations reopen) ---- */
async function lookupDvla(reg, key) {
  const r = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationNumber: reg })
  });
  if (r.status === 404) throw Object.assign(new Error('No vehicle found for ' + reg), { status: 404 });
  if (!r.ok) throw Object.assign(new Error('DVLA lookup failed (' + r.status + ')'), { status: 502 });
  const v = await r.json();
  return {
    reg: v.registrationNumber || reg, make: title(v.make), model: '', colour: title(v.colour), fuel: title(v.fuelType),
    engine: v.engineCapacity || '', year: v.yearOfManufacture || '', motDue: v.motExpiryDate || '',
    motStatus: v.motStatus || '', taxStatus: v.taxStatus || '', taxDue: v.taxDueDate || ''
  };
}

function isoDate(s) { s = String(s || '').replace(/\./g, '-').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
function title(s) { return s ? String(s).toLowerCase().replace(/(^|[\s-])[a-z]/g, c => c.toUpperCase()) : ''; }
function json(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) }); }
