// ==========================
// ✅ JWT HELPERS (NO LIBRARY)
// ==========================
function base64url(input) {
  return btoa(JSON.stringify(input))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function createJWT(payload, secret, expiresInSeconds = 600) {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

  const fullPayload = { ...payload, exp };

  const encodedHeader = base64url(header);
  const encodedPayload = base64url(fullPayload);
  const data = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature))
  )
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${data}.${encodedSignature}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const data = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")),
      c => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(data)
    );

    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64));

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

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
// ✅ MAIN HANDLER
// ==========================
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;
  const ip = request.headers.get("cf-connecting-ip");

  // =========================
  // ✅ LOGIN
  // =========================
  if (url.pathname === "/products/login" && method === "POST") {
    try {
      const { username, password } = await request.json();

      const storedPassword = await env.B2B_IMAGE_USERS.get(username);

      if (!storedPassword || storedPassword !== password) {
        return new Response("Invalid credentials", { status: 401 });
      }

      const token = await createJWT(
        { user: username },
        env.JWT_SECRET,
        600 // 10 minutes
      );

      return new Response(JSON.stringify({ token }), {
        headers: { "Content-Type": "application/json" }
      });

    } catch {
      return new Response("Bad request", { status: 400 });
    }
  }

  // =========================
  // ✅ AUTH FUNCTION
  // =========================
  async function authenticate() {
    const auth = request.headers.get("Authorization");
    if (!auth) return null;

    const token = auth.replace("Bearer ", "");
    return await verifyJWT(token, env.JWT_SECRET);
  }

  // =========================
  // ✅ PROTECTED API
  // =========================
  if (url.pathname === "/products/images" && method === "GET") {

    const user = await authenticate();

    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!checkRateLimit(ip)) {
      return new Response("Too Many Requests", { status: 429 });
    }

    const shopwareApiUrl = "https://shop.dantoy.dk/api";
    const clientId = env.client_id;
    const clientSecret = env.client_secret;

    try {
      // ✅ 1. Get Shopware token
      const tokenRes = await fetch(`${shopwareApiUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      const tokenData = await tokenRes.json();
      const shopToken = tokenData.access_token;

      // ✅ 2. Products
      const productRes = await fetch(`${shopwareApiUrl}/product`, {
        headers: { Authorization: `Bearer ${shopToken}` }
      });

      const productData = await productRes.json();
      const rawProducts = productData.data || [];

      // ✅ 3. Media
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
        { Authorization: `Bearer ${shopToken}` }
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

      // ✅ 5. Query params
      const productNumber = url.searchParams.get("productNumber");
      const limit = parseInt(url.searchParams.get("limit")) || 0;
      const skip = parseInt(url.searchParams.get("skip")) || 0;

      // ✅ 6. Build result
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
      return new Response(
        `Failed: ${err.message}`,
        { status: 500 }
      );
    }
  }

  return new Response("Not found", { status: 404 });
}