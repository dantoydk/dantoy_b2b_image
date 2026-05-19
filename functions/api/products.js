import { verifyJWT } from "../lib/jwt";

// ✅ Rate limit (simple in-memory)
const rateLimitMap = new Map();

function checkRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }

  const record = rateLimitMap.get(ip);

  if (now - record.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }

  record.count++;
  return record.count <= limit;
}

// ✅ Pagination helper (matches your Python)
async function fetchProductsLimited(url, headers, maxLimit = 500) {
  let allData = [];
  let page = 1;

  while (allData.length < maxLimit) {
    const limit = Math.min(100, maxLimit - allData.length);

    const res = await fetch(`${url}?page=${page}&limit=${limit}`, {
      method: "GET",
      headers
    });

    const text = await res.text();

    if (!res.ok) {
      console.error("Product error:", text);
      throw new Error("Failed fetching products");
    }

    const data = JSON.parse(text);
    const pageData = data.data || [];

    console.log(`Products page ${page}: ${pageData.length}`);

    if (!pageData.length) break;

    allData.push(...pageData);

    if (pageData.length < limit) break;

    page++;
  }

  return allData;
}

// ✅ Pagination for product media (your existing improved version)
async function fetchMediaLimited(url, headers, maxLimit = 3000) {
  let allData = [];
  let page = 1;

  while (allData.length < maxLimit) {
    const limit = Math.min(100, maxLimit - allData.length);

    const res = await fetch(`${url}?page=${page}&limit=${limit}`, {
      method: "GET",
      headers
    });

    const text = await res.text();

    if (!res.ok) {
      console.error("Media error:", text);
      throw new Error("Failed fetching media");
    }

    const data = JSON.parse(text);
    const pageData = data.data || [];

    console.log(`Media page ${page}: ${pageData.length}`);

    if (!pageData.length) break;

    allData.push(...pageData);

    if (pageData.length < limit) break;

    page++;
  }

  return allData;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const ip = request.headers.get("cf-connecting-ip");

  // =========================
  // ✅ AUTH
  // =========================
  const auth = request.headers.get("Authorization");

  if (!auth) {
    return new Response("Missing token", { status: 401 });
  }

  const token = auth.replace("Bearer ", "");
  const user = await verifyJWT(token, env.JWT_SECRET);

  if (!user) {
    return new Response("Invalid or expired token", { status: 401 });
  }

  // =========================
  // ✅ RATE LIMIT
  // =========================
  if (!checkRateLimit(ip)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  // =========================
  // ✅ SHOPWARE LOGIC
  // =========================
  const shopwareApiUrl = "https://shop.dantoy.dk/api";
  const clientId = env.client_id;
  const clientSecret = env.client_secret;

  try {
    // ✅ 1. Get Shopware token
    const tokenRes = await fetch(`${shopwareApiUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    });

    const tokenData = await tokenRes.json();
    const shopToken = tokenData.access_token;

    // ✅ 2. Fetch products (FIXED WITH PAGINATION)
    const rawProducts = await fetchProductsLimited(
      `${shopwareApiUrl}/product`,
      {
        "Authorization": `Bearer ${shopToken}`,
        "Accept": "application/json"
      },
      500
    );

    console.log("RAW PRODUCTS COUNT:", rawProducts.length);

    // ✅ 3. Fetch product media
    const mediaData = await fetchMediaLimited(
      `${shopwareApiUrl}/product-media`,
      {
        "Authorization": `Bearer ${shopToken}`,
        "Accept": "application/json"
      },
      3000
    );

    console.log("MEDIA COUNT:", mediaData.length);

    // ✅ 4. Build media map (KEY = product_media.id)
    const mediaMap = {};

    for (const pm of mediaData) {
      if (!pm.id) continue;
      mediaMap[pm.id] = pm.media || {};
    }

    // ✅ 5. Query params
    const urlObj = new URL(request.url);
    const productNumber = urlObj.searchParams.get("productNumber");
    const limit = parseInt(urlObj.searchParams.get("limit")) || 0;
    const skip = parseInt(urlObj.searchParams.get("skip")) || 0;

    // ✅ 6. Build results (matches your Python logic)
    let products = rawProducts
      .filter(p => p.active === true)
      .map(p => {
        const coverId = p.coverId;
        const media = coverId ? mediaMap[coverId] : {};

        const imageUrl = media?.url
          ? media.url.replace(/ /g, "%20")
          : "";

        return {
          productNumber: p.productNumber,
          productId: p.id,
          description: p.description,
          image_link: imageUrl
        };
      });

    // ✅ Sort
    products.sort((a, b) =>
      parseFloat(a.productNumber) - parseFloat(b.productNumber)
    );

    // ✅ Filtering
    let result = products;

    if (productNumber) {
      result = products.filter(p => p.productNumber === productNumber);
    } else if (limit > 0) {
      result = products.slice(skip, skip + limit);
    }

    // ✅ Response
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    console.error("ERROR:", err);

    return new Response(
      `Failed: ${err.message}`,
      { status: 500 }
    );
  }
}