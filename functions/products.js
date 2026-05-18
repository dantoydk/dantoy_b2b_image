// ✅ Rate limit store (simple in-memory)
const rateLimitMap = new Map();

// ✅ Allowed IPs
const allowedIPs = [
  "94.145.168.6",
  "80.198.193.66"
];

function checkIP(request) {
  const ip = request.headers.get("cf-connecting-ip");
  console.log("Client IP:", ip);
  return allowedIPs.includes(ip);
}

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

  if (record.count > limit) {
    return false;
  }

  return true;
}

export async function onRequest(context) {
  const { request, env } = context;
  const { method } = request;

  const shopwareApiUrl = "https://shop.dantoy.dk/api";

  const clientId = env.client_id;
  const clientSecret = env.client_secret;
  const clientKey = env.client_key;

  // ✅ Auth
  function checkAuth(header) {
    try {
      const key = header?.split(" ")[1];
      return key === clientKey;
    } catch {
      return false;
    }
  }

  const authHeader = request.headers.get("Authorization");
  const allowedAuth = checkAuth(authHeader);
  const ip = request.headers.get("cf-connecting-ip");

  // ✅ Security checks
  if (method !== "GET" || !allowedAuth || !checkIP(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!checkRateLimit(ip, 60, 60000)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  try {
    // ✅ 1. Get token
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

    const tokenText = await tokenRes.text();

    if (!tokenRes.ok) {
      console.error("Token error:", tokenText);
      throw new Error("Token request failed");
    }

    const tokenData = JSON.parse(tokenText);
    const token = tokenData.access_token;

    // ✅ 2. Fetch products
    const productRes = await fetch(`${shopwareApiUrl}/product`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json"
      }
    });

    const productText = await productRes.text();

    if (!productRes.ok) {
      console.error("Product error:", productText);
      throw new Error("Product request failed");
    }

    const productData = JSON.parse(productText);
    const rawProducts = Array.isArray(productData.data)
      ? productData.data
      : [];

    // ✅ 3. Fetch product-media (limit 3000)
    async function fetchProductMediaLimited(url, headers, maxLimit = 3000) {
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
          throw new Error("Failed fetching product media");
        }

        const data = JSON.parse(text);
        const pageData = data.data || [];

        if (!pageData.length) break;

        allData.push(...pageData);

        if (pageData.length < limit) break;

        page++;
      }

      return allData;
    }

    const mediaData = await fetchProductMediaLimited(
      `${shopwareApiUrl}/product-media`,
      {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json"
      },
      3000
    );

    // ✅ 4. Build product → images map
    const productImagesMap = {};

    for (const pm of mediaData) {
      const productId = pm.productId;
      const media = pm.media;

      if (!productId || !media) continue;

      // ✅ Only images (no PDFs)
      if (!media.mimeType || !media.mimeType.startsWith("image/")) continue;

      const mediaUrl = media.url;
      if (!mediaUrl) continue;

      const cleanUrl = mediaUrl.replace(/ /g, "%20");

      if (!productImagesMap[productId]) {
        productImagesMap[productId] = [];
      }

      if (productImagesMap[productId].length < 10) {
        productImagesMap[productId].push(cleanUrl);
      }
    }

    // ✅ 5. Query params
    const url = new URL(request.url);
    const productNumber = url.searchParams.get("productNumber");
    const limit = parseInt(url.searchParams.get("limit")) || 0;
    const skip = parseInt(url.searchParams.get("skip")) || 0;

    // ✅ 6. Filter ACTIVE products + map
    const products = rawProducts
      .filter(p => p.active === true)
      .map(product => ({
        productNumber: product.productNumber,
        description: product.name,
        EAN: product.customFields?.eanColli || null,
        //stock: (product.customFields?.stockB2B || 0) > 0,
        updatedAt: product.updatedAt,
        images: productImagesMap[product.id] || []
      }));

    // ✅ 7. Sort
    products.sort((a, b) =>
      parseFloat(a.productNumber) - parseFloat(b.productNumber)
    );

    // ✅ 8. Filter results
    let filteredProducts = products;

    if (productNumber) {
      filteredProducts = products.filter(
        p => p.productNumber === productNumber
      );
    } else if (limit > 0) {
      filteredProducts = products.slice(skip, skip + limit);
    }

    // ✅ 9. Response
    return new Response(JSON.stringify(filteredProducts), {
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Window": "60s"
      }
    });

  } catch (error) {
    console.error("ERROR:", error);

    return new Response(
      `Failed to fetch products: ${error.message}`,
      { status: 500 }
    );
  }
}
