import { verifyJWT } from "../lib/jwt";

// ==========================
// ✅ RATE LIMIT
// ==========================
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

// ==========================
// ✅ FETCH PRODUCTS (WITH TRANSLATIONS)
// ==========================
async function fetchProductsLimited(url, headers, maxLimit = 500) {
  let allData = [];
  let page = 1;

  while (allData.length < maxLimit) {
    const limit = Math.min(100, maxLimit - allData.length);

    const res = await fetch(`${url}&page=${page}&limit=${limit}`, {
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

// ==========================
// ✅ FETCH PRODUCT MEDIA
// ==========================
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

// ==========================
// ✅ MAIN HANDLER
// ==========================
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
  // ✅ SHOPWARE CONFIG
  // =========================
  const shopwareApiUrl = "https://shop.dantoy.dk/api";
  const clientId = env.client_id;
  const clientSecret = env.client_secret;

  // ✅ Language IDs
  const LANG_DE = "01900cb1f3fc70539bddaf5d90028e77";
  const LANG_EN = "01900cd6fae6726b934a666f981223d3";

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

    // ✅ 2. Fetch products WITH translations
    const rawProducts = await fetchProductsLimited(
      `${shopwareApiUrl}/product?associations[translations][]`,
      {
        "Authorization": `Bearer ${shopToken}`,
        "Accept": "application/json"
      },
      500
    );

    console.log("RAW PRODUCTS:", rawProducts.length);

    // ✅ 3. Fetch media
    const mediaData = await fetchMediaLimited(
      `${shopwareApiUrl}/product-media`,
      {
        "Authorization": `Bearer ${shopToken}`,
        "Accept": "application/json"
      },
      3000
    );

    console.log("MEDIA COUNT:", mediaData.length);

    // =========================
    // ✅ MAP PRODUCT → IMAGES
    // =========================
    const productImagesMap = {};

    for (const pm of mediaData) {
      const productId = pm.productId;
      const media = pm.media;

      if (!productId || !media) continue;
      if (!media.mimeType?.startsWith("image/")) continue;

      const url = media.url?.replace(/ /g, "%20");
      if (!url) continue;

      if (!productImagesMap[productId]) {
        productImagesMap[productId] = [];
      }

      if (productImagesMap[productId].length < 10) {
        productImagesMap[productId].push(url);
      }
    }

    // =========================
    // ✅ QUERY PARAMS
    // =========================
    const urlObj = new URL(request.url);
    const productNumber = urlObj.searchParams.get("productNumber");
    const limit = parseInt(urlObj.searchParams.get("limit")) || 0;
    const skip = parseInt(urlObj.searchParams.get("skip")) || 0;

    // =========================
    // ✅ BUILD RESULT
    // =========================
    let products = rawProducts
      .filter(p => p.active === true)
      .map(p => {
        let name_de = "";
        let name_en = "";

        const translations = p.translations || [];

        for (const t of translations) {
          if (t.languageId === LANG_DE) {
            name_de = t.name || "";
          }
          if (t.languageId === LANG_EN) {
            name_en = t.name || "";
          }
        }

        return {
          productNumber: p.productNumber,
          productId: p.id,
          description: p.name,
          description_de: name_de,
          description_en: name_en,
          updatedAt: p.updatedAt,
          images: productImagesMap[p.id] || []
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

    // =========================
    // ✅ RESPONSE
    // =========================
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
