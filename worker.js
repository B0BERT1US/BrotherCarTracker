/*
  Reg lookup worker for the Workshop app.
  Runs on Cloudflare Workers (free plan). It keeps the DVLA key private and
  adds the CORS headers a web app needs. The app calls it as:
      https://YOUR-WORKER.workers.dev/?reg=AB12CDE

  Secrets to set in the worker's Settings > Variables:
      DVLA_KEY        your key from the DVLA Vehicle Enquiry Service (free)
      ALLOWED_ORIGIN  optional, e.g. https://b0bert1us.github.io  (blocks anyone else using your key)

  To swap in a paid provider later (Total Car Check, UK Vehicle Data...), replace the
  fetch in lookupDvla with their API call and map their fields into the same shape.
*/
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
    if (!env.DVLA_KEY) return json({ error: 'DVLA_KEY is not set on the worker' }, 500, cors);
    try {
      return json(await lookupDvla(reg, env.DVLA_KEY), 200, cors);
    } catch (e) {
      return json({ error: e.message || 'Lookup failed' }, e.status || 502, cors);
    }
  }
};

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
    reg: v.registrationNumber || reg,
    make: title(v.make),
    model: '',                       /* the DVLA service does not give the model, the DVSA MOT history API does */
    colour: title(v.colour),
    year: v.yearOfManufacture || '',
    fuel: title(v.fuelType),
    engine: v.engineCapacity || '',
    motDue: v.motExpiryDate || '',
    motStatus: v.motStatus || '',
    taxStatus: v.taxStatus || '',
    taxDue: v.taxDueDate || '',
    firstRegistered: v.monthOfFirstRegistration || ''
  };
}

function title(s) { return s ? String(s).toLowerCase().replace(/(^|[\s-])[a-z]/g, c => c.toUpperCase()) : ''; }
function json(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) }); }
