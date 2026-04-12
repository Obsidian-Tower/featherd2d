
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ✅ CORS preflight
    if (request.method === "OPTIONS") {
      return handleCORS();
    }
    if (request.method === "POST" && url.pathname === "/update-parcel-status") {
      return handleUpdateParcelStatus(request, env);
    }
    if (url.pathname === "/get-current-parcels") {
      return handleGetCurrentParcels(request, env);
    }

    if (request.method === "POST" && url.pathname === "/update-property-disposition") {
      return handleUpdatePropertyDisposition(request, env);
    }
    
    if (url.pathname === "/") {
      return serveStatic("index.html", env);
    }

    if (url.pathname === "/polygons") {
      return serveStatic("polygons.html", env);
    }

    if (request.method === "POST" && url.pathname === "/get-property-dispositions") {
      return handleGetPropertyDispositions(request, env);
    }

    if (request.method === "POST" && url.pathname === "/get-properties-for-active-polygons") {
      return handleGetPropertiesForActivePolygons(request, env);
    }

    if (request.method === "POST" && url.pathname === "/update-area") {
      return handleUpdateArea(request, env);
    }

    if (request.method === "POST" && url.pathname === "/add-note") {
      return handleAddNote(request, env);
    }

    if (request.method === "POST" && url.pathname === "/get-notes") {
      return handleGetNotes(request, env);
    }

    // 🔥 USER LOCATION UPDATE
    if (request.method === "POST" && url.pathname === "/update-location") {
      return handleUpdateLocation(request, env);
    }

    // 🔥 GET ALL ACTIVE USERS
    if (request.method === "GET" && url.pathname === "/get-locations") {
      return handleGetLocations(env);
    }

    if (url.pathname === "/get-polygons") {
      return handleGetPolygons(request, env);
    }

    if (url.pathname === "/get-active-polygons") {
      return handleGetActivePolygons(request, env);
    }

    if (request.method === "POST" && url.pathname === "/update-active-polygons") {
      return handleUpdateActivePolygons(request, env);
    }

    if (request.method === "POST" && url.pathname === "/save-polygon") {
      return handleSavePolygon(request, env);
    }

    if (url.pathname === "/get-parcels") {
      return handleGetParcels(request, env);
    }

    try {
      // 🔹 Batch insert (PRIMARY)
      if (request.method === "POST" && url.pathname === "/init-parcels") {
        return handleInitParcels(request, env);
      }

      // 🔹 Single insert (fallback)
      if (request.method === "POST" && url.pathname === "/init-parcel") {
        return handleInitParcel(request, env);
      }


      return json({ error: "Not found" }, 404);

    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};


// ================================
// 🔥 HANDLERS
// ================================

async function handleUpdatePropertyDisposition(request, env) {
  try {
    const body = await request.json();
    const { property_id, user, disposition } = body;

    console.log("📥 update-property-disposition:", body);

    if (!property_id || !user || !disposition) {
      return json({ error: "Missing property_id, user, or disposition" }, 400);
    }

    // 🔥 insert new history row
    const result = await env.DB.prepare(`
      INSERT INTO property_disposition_history
      (property_id, user, disposition)
      VALUES (?, ?, ?)
    `)
      .bind(
        Number(property_id),
        user,
        disposition
      )
      .run();

    console.log("✅ Insert result:", result);

    // 🔥 fetch the row we just inserted (ground truth)
    const inserted = await env.DB.prepare(`
      SELECT *
      FROM property_disposition_history
      WHERE id = ?
      LIMIT 1
    `)
      .bind(result.meta.last_row_id)
      .first();

    return json({
      success: true,
      record: inserted
    });

  } catch (err) {
    console.error("❌ update-property-disposition error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleGetPropertyDispositions(request, env) {
  console.log("🚀 ENTER handleGetPropertyDispositions");

  try {
    const body = await request.json();
    const property_ids = body.property_ids;

    if (!Array.isArray(property_ids) || property_ids.length === 0) {
      console.log("⚠️ No property_ids → returning []");
      return json([]);
    }

    const normalizedIds = property_ids
      .map(id => Number(id))
      .filter(id => Number.isFinite(id));

    if (normalizedIds.length === 0) {
      console.log("⚠️ No valid IDs after filtering → returning []");
      return json([]);
    }

    console.log("📊 Total IDs:", normalizedIds.length);

    const CHUNK_SIZE = 80; // 🔥 safe limit
    let allResults = [];

    for (let i = 0; i < normalizedIds.length; i += CHUNK_SIZE) {
      const chunk = normalizedIds.slice(i, i + CHUNK_SIZE);

      console.log(`🧩 Processing chunk ${i} → ${i + chunk.length}`);

      const placeholders = chunk.map(() => "?").join(",");

      const query = `
        SELECT pdh.*
        FROM property_disposition_history pdh
        INNER JOIN (
          SELECT property_id, MAX(id) AS max_id
          FROM property_disposition_history
          WHERE property_id IN (${placeholders})
          GROUP BY property_id
        ) latest
        ON pdh.id = latest.max_id
      `;

      let rows;

      try {
        rows = await env.DB
          .prepare(query)
          .bind(...chunk)
          .all();

        console.log(`✅ Chunk returned ${rows.results?.length || 0} rows`);
      } catch (err) {
        console.error("💥 Chunk query failed:", err);
        continue; // 🔥 skip bad chunk, don't crash whole request
      }

      if (Array.isArray(rows.results)) {
        allResults = allResults.concat(rows.results);
      }
    }

    console.log("📦 Total results:", allResults.length);

    return json(allResults);

  } catch (err) {
    console.error("💥 FULL HANDLER ERROR:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleGetPropertiesForActivePolygons(request, env) {
  try {
    const body = await request.json();
    const { user } = body;

    if (!user) {
      return json({ error: "Missing user" }, 400);
    }

    // 1. Load active polygon ids for this user
    const activeRow = await env.DB.prepare(`
      SELECT active_polygons
      FROM user_active_polygons
      WHERE user = ?
      LIMIT 1
    `)
      .bind(user)
      .first();

    if (!activeRow) {
      return json({ properties: [] });
    }

    let activePolygonIds = [];
    try {
      activePolygonIds = JSON.parse(activeRow.active_polygons || "[]");
    } catch (err) {
      console.error("Failed to parse active polygon JSON:", err);
      return json({ properties: [] });
    }

    if (!Array.isArray(activePolygonIds) || activePolygonIds.length === 0) {
      return json({ properties: [] });
    }

    // 2. Load polygon rows
    const placeholders = activePolygonIds.map(() => "?").join(",");

    const polygonRows = await env.DB.prepare(`
      SELECT id, name, coords
      FROM polygons
      WHERE id IN (${placeholders})
    `)
      .bind(...activePolygonIds)
      .all();

    const polygons = (polygonRows.results || [])
      .map(row => {
        try {
          return {
            id: row.id,
            name: row.name,
            coords: JSON.parse(row.coords)
          };
        } catch (err) {
          console.error("Bad polygon coords for polygon", row.id, err);
          return null;
        }
      })
      .filter(Boolean)
      .filter(p => Array.isArray(p.coords) && p.coords.length >= 3);

    if (!polygons.length) {
      return json({ properties: [] });
    }

    // 3. Query candidate properties by bbox, then point-in-polygon filter
    const deduped = new Map();

    for (const polygon of polygons) {
      const { minLat, maxLat, minLng, maxLng } = getBoundingBox(polygon.coords);

      const propertyRows = await env.DB.prepare(`
        SELECT
          property_id,
          OWN_NAME,
          lat,
          lng,
          PHY_ADDR1,
          PHY_ADDR2,
          PHY_CITY,
          PHY_ZIPCD,
          ALT_KEY,
          PARCEL_ID,
          data_from,
          created_at,
          updated_at
        FROM properties
        WHERE lat BETWEEN ? AND ?
          AND lng BETWEEN ? AND ?
      `)
        .bind(minLat, maxLat, minLng, maxLng)
        .all();

      const candidates = propertyRows.results || [];

      for (const property of candidates) {
        if (property.lat == null || property.lng == null) continue;

        const inside = pointInPolygon(
          [Number(property.lat), Number(property.lng)],
          polygon.coords
        );

        if (!inside) continue;

        const dedupeKey = property.property_id ?? property.PARCEL_ID ?? `${property.lat},${property.lng}`;
        if (!deduped.has(dedupeKey)) {
          deduped.set(dedupeKey, property);
        }
      }
    }

    return json({
      properties: Array.from(deduped.values())
    });

  } catch (err) {
    console.error("get-properties-for-active-polygons error:", err);
    return json({ error: err.message }, 500);
  }
}

function getBoundingBox(coords) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of coords) {
    const lat = Array.isArray(point) ? Number(point[0]) : Number(point.lat);
    const lng = Array.isArray(point) ? Number(point[1]) : Number(point.lng);

    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  return { minLat, maxLat, minLng, maxLng };
}

function pointInPolygon(point, polygon) {
  const y = point[0]; // lat
  const x = point[1]; // lng
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = Array.isArray(polygon[i]) ? Number(polygon[i][0]) : Number(polygon[i].lat);
    const xi = Array.isArray(polygon[i]) ? Number(polygon[i][1]) : Number(polygon[i].lng);
    const yj = Array.isArray(polygon[j]) ? Number(polygon[j][0]) : Number(polygon[j].lat);
    const xj = Array.isArray(polygon[j]) ? Number(polygon[j][1]) : Number(polygon[j].lng);

    const intersects =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}

async function handleUpdateArea(request, env) {
  try {
    const body = await request.json();
    const { id, action, name } = body;

    if (!id || !action) {
      return json({ error: "Missing id or action" }, 400);
    }

    // 🔥 UPDATE NAME
    if (action === "update_name") {
      if (!name || !name.trim()) {
        return json({ error: "Name required" }, 400);
      }

      await env.DB.prepare(`
        UPDATE polygons
        SET name = ?
        WHERE id = ?
      `)
        .bind(name.trim(), id)
        .run();

      return json({ success: true });
    }

    // 🔥 DELETE AREA
    if (action === "delete") {
      await env.DB.prepare(`
        DELETE FROM polygons
        WHERE id = ?
      `)
        .bind(id)
        .run();

      return json({ success: true });
    }

    return json({ error: "Invalid action" }, 400);

  } catch (err) {
    console.error("update-area error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleGetNotes(request, env) {
  try {
    const body = await request.json();
    const { property_ids } = body;

    if (!property_ids || !property_ids.length) {
      return json({ error: "No property_ids provided" }, 400);
    }

    const placeholders = property_ids.map(() => "?").join(",");

    const query = `
      SELECT *
      FROM property_notes
      WHERE property_id IN (${placeholders})
      ORDER BY created_at ASC
    `;

    const normalizedIds = property_ids.map(id => id.toString());

    const rows = await env.DB
      .prepare(query)
      .bind(...normalizedIds)
      .all();

    return json(rows.results || []);

  } catch (err) {
    console.error("get-notes error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleAddNote(request, env) {
  try {
    const body = await request.json();

    const { property_id, user, note } = body;

    if (!property_id || !user || !note) {
      return json({ error: "Missing property_id, user, or note" }, 400);
    }

    const id = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO property_notes (id, property_id, user, note, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
      .bind(
        id,
        property_id.toString(),
        user,
        note
      )
      .run();

    const inserted = await env.DB.prepare(`
      SELECT *
      FROM property_notes
      WHERE id = ?
      LIMIT 1
    `)
      .bind(id)
      .first();

    return json({
      success: true,
      note: inserted
    });

  } catch (err) {
    console.error("add-note error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleUpdateLocation(request, env) {
  try {
    const body = await request.json();

    const {
      user,
      lat,
      lng,
      accuracy = null,
      heading = null,
      speed = null
    } = body;

    if (!user || lat == null || lng == null) {
      return json({ error: "Missing required fields" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO user_locations (user, lat, lng, accuracy, heading, speed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user) DO UPDATE SET
        lat = excluded.lat,
        lng = excluded.lng,
        accuracy = excluded.accuracy,
        heading = excluded.heading,
        speed = excluded.speed,
        updated_at = excluded.updated_at
    `)
      .bind(user, lat, lng, accuracy, heading, speed, now)
      .run();

    return json({ success: true });

  } catch (err) {
    console.error("update-location error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleGetLocations(env) {
  try {
    const now = Math.floor(Date.now() / 1000);

    // 🔥 only return users active in last 10 seconds
    const result = await env.DB.prepare(`
      SELECT user, lat, lng, accuracy, heading, speed, updated_at
      FROM user_locations
      WHERE updated_at > ?
    `)
      .bind(now - 100)
      .all();

    return json(result.results || []);

  } catch (err) {
    console.error("get-locations error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleGetPolygons(request, env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT id, user, name, coords, created_at
      FROM polygons
      ORDER BY id ASC
    `).all();

    const results = rows.results.map(row => ({
      id: row.id,
      user: row.user,
      name: row.name || `area-${row.id}`, // fallback safety
      coords: JSON.parse(row.coords),
      created_at: row.created_at
    }));

    return json(results);

  } catch (err) {
    console.error("get-polygons error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleSavePolygon(request, env) {
  try {
    const body = await request.json();
    const { user, coords } = body;

    if (!user || !coords) {
      return json({ error: "Missing user or coords" }, 400);
    }

    // 🔥 insert into DB
    const result = await env.DB.prepare(`
      INSERT INTO polygons (user, coords)
      VALUES (?, ?)
    `)
      .bind(user, JSON.stringify(coords))
      .run();

    // 🔥 get inserted row id
    const id = result.meta.last_row_id;

    return json({
      success: true,
      id
    });

  } catch (err) {
    console.error("save-polygon error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleGetActivePolygons(request, env) {
  try {
    const url = new URL(request.url);
    const user = url.searchParams.get("user");

    if (!user) {
      return json({ error: "Missing user" }, 400);
    }

    const row = await env.DB.prepare(`
      SELECT active_polygons
      FROM user_active_polygons
      WHERE user = ?
      LIMIT 1
    `)
      .bind(user)
      .first();

    if (!row) {
      // 🔥 no row yet → return empty list
      return json({ active_polygons: [] });
    }

    return json({
      active_polygons: JSON.parse(row.active_polygons || "[]")
    });

  } catch (err) {
    console.error("get-active-polygons error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleUpdateActivePolygons(request, env) {
  try {
    const body = await request.json();
    const { user, active_polygons } = body;

    if (!user || !Array.isArray(active_polygons)) {
      return json({ error: "Missing user or active_polygons" }, 400);
    }

    const jsonList = JSON.stringify(active_polygons);

    // 🔥 UPSERT (insert or update)
    await env.DB.prepare(`
      INSERT INTO user_active_polygons (user, active_polygons, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user) DO UPDATE SET
        active_polygons = excluded.active_polygons,
        updated_at = CURRENT_TIMESTAMP
    `)
      .bind(user, jsonList)
      .run();

    return json({
      success: true
    });

  } catch (err) {
    console.error("update-active-polygons error:", err);
    return json({ error: err.message }, 500);
  }
}

async function handleUpdateParcelStatus(request, env) {
  try {
    const body = await request.json();

    const { parcel_id, status, user } = body;

    if (!parcel_id || !status || !user) {
      return json({ error: "Missing parcel_id, status, or user" }, 400);
    }

    const normalizedId = parcel_id.toString();

    // 🔥 INSERT new row
    await env.DB.prepare(`
      INSERT INTO parcel_status (id, parcel_id, status, updated_by, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
      .bind(
        crypto.randomUUID(),
        normalizedId,
        status,
        user
      )
      .run();

    // 🔥 IMMEDIATELY fetch the TRUE latest row (same logic as your read endpoint)
    const latest = await env.DB.prepare(`
      SELECT *
      FROM parcel_status
      WHERE parcel_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `)
      .bind(normalizedId)
      .first();

    // 🔥 return actual DB truth
    return json({
      success: true,
      parcel: latest
    });

  } catch (err) {
    console.error("update-parcel-status error:", err);
    return json({ error: err.message }, 500);
  }
}

// add to your Worker
async function handleGetParcels(request, env) {
  
  const rows = await env.DB.prepare(`
    SELECT * FROM parcel_status
    ORDER BY created_at DESC
  `).all();

  return new Response(JSON.stringify(rows.results), {
    headers: { "Content-Type": "application/json" }
  });
}

async function handleInitParcels(request, env) {
  try {
    const body = await request.json();
    const parcel_ids = body.parcel_ids;

    if (!parcel_ids || !parcel_ids.length) {
      return new Response(JSON.stringify({ error: "No parcel_ids provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const inserts = [];

    for (const pid of parcel_ids) {
      if (!pid) continue;

      inserts.push(
        env.DB.prepare(`
          INSERT INTO parcel_status (id, parcel_id, status, updated_by)
          SELECT ?, ?, 'prospect', 'system'
          WHERE NOT EXISTS (
            SELECT 1 FROM parcel_status WHERE parcel_id = ?
          )
        `).bind(
          crypto.randomUUID(),
          String(pid),
          String(pid)
        )
      );
    }

    await env.DB.batch(inserts);

    return new Response(JSON.stringify({
      success: true,
      inserted_attempted: parcel_ids.length
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("ERROR:", err);
    return new Response(err.stack || err.message, { status: 500 });
  }
}

// ✅ Single insert (fallback)
async function handleInitParcel(request, env) {
  const { parcel_id } = await request.json();

  if (!parcel_id) {
    return json({ error: "Missing parcel_id" }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM parcel_status WHERE parcel_id = ? LIMIT 1"
  )
    .bind(parcel_id.toString())
    .first();

  if (existing) {
    return json({ success: true, message: "Already exists" });
  }

  await env.DB.prepare(`
    INSERT INTO parcel_status (id, parcel_id, status, updated_by)
    VALUES (?, ?, 'prospect', 'system')
  `)
    .bind(crypto.randomUUID(), parcel_id.toString())
    .run();

  return json({ success: true, created: true });
}

async function handleGetCurrentParcels(request, env) {
  try {
    const body = await request.json();
    const parcel_ids = body.parcel_ids;

    if (!parcel_ids || !parcel_ids.length) {
      return json({ error: "No parcel_ids provided" }, 400);
    }

    // 🔥 Build dynamic placeholders (?, ?, ?, ...)
    const placeholders = parcel_ids.map(() => "?").join(",");
    console.log(placeholders)
    const query = `
      SELECT ps.*
      FROM parcel_status ps
      INNER JOIN (
        SELECT parcel_id, MAX(rowid) AS max_rowid
        FROM parcel_status
        WHERE parcel_id IN (${placeholders})
        GROUP BY parcel_id
      ) latest
      ON ps.rowid = latest.max_rowid
    `;

    const normalizedIds = parcel_ids.map(id => id.toString());

    const stmt = env.DB.prepare(query).bind(...normalizedIds);
    const rows = await stmt.all();
    console.log(rows)
    return json(rows.results);

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
// ================================
// 🧰 HELPERS
// ================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}