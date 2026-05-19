import { SignJWT, jwtVerify } from "jose";

// ✅ Rate limit store (simple in-memory)
const rateLimitMap = new Map();

// ✅ Allowed IPs (optional — you can remove later if you want)
const allowedIPs = [
  "94.145.168.6",
  "80.198.193.66"
];

function checkIP(request) {
  const ip = request.headers.get("cf-connecting-ip");
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

  return record.count <= limit;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  const ip = request.headers.get("cf-connecting-ip");

  // =========================
  // ✅ LOGIN ENDPOINT
  // =========================
  if (url.pathname === "/api/login" && method === "POST") {
  try {
    const { username, password } = await request.json();

    // ✅ Get password directly (string)
    const storedPassword = await env.B2B_IMAGE_USERS.get(username);

    if (!storedPassword || storedPassword !== password) {
      return new Response("Invalid credentials", { status: 401 });
    }

    // ✅ Create token (10 minutes expiry)
    const token = await new SignJWT({ user: username })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(env.JWT_SECRET));

    return new Response(JSON.stringify({ token }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch {
    return new Response("Bad request", { status: 400 });
  }
}

  // =========================
  // ✅ AUTH CHECK FUNCTION
  // =========================
  async function authenticate() {
    const auth = request.headers.get("Authorization");

    if (!auth) return null;

    const token = auth.replace("Bearer ", "");

    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(env.JWT_SECRET)
      );
      return payload;
    } catch {
      return null;
    }
  }

  // =========================
  // ✅ PROTECTED API
  // =========================
  if (url.pathname === "/api/images" && method === "GET") {

    // ✅ Auth required
    const user = await authenticate();

    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    // ✅ Optional IP restriction
    if (!checkIP(request)) {
      return new Response("Unauthorized IP", { status: 401 });
    }

    // ✅ Rate limit
    if (!checkRateLimit(ip, 60, 60000)) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // ===================================
    // ✅ YOUR EXISTING SHOPWARE LOGIC
    // ===================================

    const shopwareApiUrl = "https://shop.dantoy.dk/api";

    const clientId = env.client_id;
    const clientSecret = env.client_secret;

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

      const tokenData = await tokenRes.json();
      const shopToken = tokenData.access_token;

      // ✅ 2. Fetch products
      const productRes = await fetch(`${shopwareApiUrl}/product`, {
        headers: {
          "Authorization": `Bearer ${shopToken}`
        }
      });

      const productData = await productRes.json();
      const rawProducts = productData.data || [];

      // ✅ 3. Fetch media
      async function fetchProductMediaLimited(url, headers, maxLimit = 3000) {
        let allData = [];
        let page = 1;

        while (allData.length < maxLimit) {
          const limit = Math.min(100, maxLimit - allData.length);

          const res = await fetch(`${url}?page=${page}&limit=${limit}`, {
            headers
          });

          const data = await res.json();
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
          "Authorization": `Bearer ${shopToken}`
        }
      );

      // ✅ 4. Map images
      const productImagesMap = {};

      for (const pm of mediaData) {
        const media = pm.media;

        if (!pm.productId || !media) continue;
        if (!media.mimeType?.startsWith("image/")) continue;

        const url = media.url?.replace(/ /g, "%20");

        if (!url) continue;

        if (!productImagesMap[pm.productId]) {
          productImagesMap[pm.productId] = [];
        }

        if (productImagesMap[pm.productId].length < 10) {
          productImagesMap[pm.productId].push(url);
        }
      }

      // ✅ 5. Query params
      const productNumber = url.searchParams.get("productNumber");
      const limit = parseInt(url.searchParams.get("limit")) || 0;
      const skip = parseInt(url.searchParams.get("skip")) || 0;

      // ✅ 6. Build response
      const products = rawProducts
        .filter(p => p.active === true)
        .map(product => ({
          productNumber: product.productNumber,
          description: product.name,
          EAN: product.customFields?.eanColli || null,
          updatedAt: product.updatedAt,
          images: productImagesMap[product.id] || []
        }));

      products.sort((a, b) =>
        parseFloat(a.productNumber) - parseFloat(b.productNumber)
      );

      let filteredProducts = products;

      if (productNumber) {
        filteredProducts = products.filter(
          p => p.productNumber === productNumber
        );
      } else if (limit > 0) {
        filteredProducts = products.slice(skip, skip + limit);
      }

      return new Response(JSON.stringify(filteredProducts), {
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Window": "60s"
        }
      });

    } catch (error) {
      return new Response(
        `Failed: ${error.message}`,
        { status: 500 }
      );
    }
  }

  return new Response("Not found", { status: 404 });
}