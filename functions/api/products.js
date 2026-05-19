import { verifyJWT } from "../lib/jwt";

// ✅ Rate limit (simple)
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

    // ✅ 2. Fetch products
    const productRes = await fetch(`${shopwareApiUrl}/product`, {
      headers: {
        Authorization: `Bearer ${shopToken}`
      }
    });

    const productData = await productRes.json();
    const rawProducts = productData.data || [];

    // ✅ 3. Fetch media
    async function fetchMedia(url, headers, maxLimit = 3000) {
      let all = [];
      let page = 1;

      while (all.length < maxLimit) {
        const limit = Math.min(100, maxLimit - all.length);

        const res = await fetch(`${url}?page=${page}&limit=${limit}`, {
          headers
        });

        const data = await res.json();
        const pageData = data.data || [];

        if (!pageData.length) break;

        all.push(...pageData);
        if (pageData.length < limit) break;

        page++;
      }

      return all;
    }

    const mediaData = await fetchMedia(
      `${shopwareApiUrl}/product-media`,
      {
        Authorization: `Bearer ${shopToken}`
      }
    );

    // ✅ 4. Map images
    const productImagesMap = {};

    for (const pm of mediaData) {
      if (!pm.productId || !pm.media) continue;
      if (!pm.media.mimeType?.startsWith("image/")) continue;

      const url = pm.media.url?.replace(/ /g, "%20");
      if (!url) continue;

      if (!productImagesMap[pm.productId]) {
        productImagesMap[pm.productId] = [];
      }

      if (productImagesMap[pm.productId].length < 10) {
        productImagesMap[pm.productId].push(url);
      }
    }

    const urlObj = new URL(request.url);
    const productNumber = urlObj.searchParams.get("productNumber");
    const limit = parseInt(urlObj.searchParams.get("limit")) || 0;
    const skip = parseInt(urlObj.searchParams.get("skip")) || 0;

    // ✅ 5. Build response
    const products = rawProducts
      .filter(p => p.active === true)
      .map(p => ({
        productNumber: p.productNumber,
        description: p.name,
        EAN: p.customFields?.eanColli || null,
        updatedAt: p.updatedAt,
        images: productImagesMap[p.id] || []
      }));

    products.sort((a, b) =>
      parseFloat(a.productNumber) - parseFloat(b.productNumber)
    );

    let result = products;

    if (productNumber) {
      result = products.filter(p => p.productNumber === productNumber);
    } else if (limit > 0) {
      result = products.slice(skip, skip + limit);
    }

    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    return new Response(`Failed: ${err.message}`, { status: 500 });
  }
}
