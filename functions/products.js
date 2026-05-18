const shopwareApiUrl = 'https://shop.dantoy.dk/api';

const allowedOrigins = [
  'https://b2b-api-test.pages.dev',
  'http://localhost:3000',
  '80.198.193.66',
  '94.145.168.6'
];

// ✅ CORS headers
const corsHeaders = (origin) => ({
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Origin': origin
});

// ✅ Check origin (fixed)
function checkOrigin(request) {
  const origin = request.headers.get("Origin");
  const isAllowed = allowedOrigins.includes(origin);
  console.log(`Origin: ${origin}, allowed: ${isAllowed}`);
  return isAllowed ? origin : null;
}

// ✅ Check API key auth
function checkAuth(list, header) {
  let foundAuth = false;
  try {
    const parsedAuth = header?.split(" ")[1];
    foundAuth = list.includes(parsedAuth);
  } catch (error) {
    console.error('Unauthorized:', error);
  }
  return foundAuth;
}

// ✅ Get Shopware token (fetch version)
async function getShopwareApiToken(id, secret) {
  const response = await fetch(`${shopwareApiUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret
    })
  });

  if (!response.ok) {
    throw new Error("Failed to get token");
  }

  const data = await response.json();
  return data.access_token;
}
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
    console.log(`Media page ${page}`);

    if (!res.ok) {
      console.error("Media fetch failed:", text);
      throw new Error("Failed fetching product media");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON from product-media");
    }

    const pageData = data.data || [];

    if (pageData.length === 0) break;

    allData.push(...pageData);

    if (pageData.length < limit) break;

    page++;
  }

  return allData;
}

// ✅ Main handler
export async function onRequest(context) {
  const { request, env } = context;
  const { method } = request;

  const shopwareApiUrl = "https://shop.dantoy.dk/api";

  const clientId = env.client_id;
  const clientSecret = env.client_secret;
  const clientKey = env.client_key;

  // ✅ Auth check
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

  if (method !== "GET" || !allowedAuth) {
    return new Response("Unauthorized", { status: 401 });
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
    console.log("Token response:", tokenText);

    if (!tokenRes.ok) {
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
    console.log("Product API response:", productText);

    if (!productRes.ok) {
      throw new Error("Product request failed");
    }

    const productData = JSON.parse(productText);
    const rawProducts = Array.isArray(productData.data)
      ? productData.data
      : [];

    // ✅ 3. Fetch product-media (max 3000)
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
        console.log(`Media page ${page}`);

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
      const mediaUrl = pm.media?.url;

      if (!productId || !mediaUrl) continue;

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

    // ✅ 6. Map products
    const products = rawProducts.map((product) => ({
      productNumber: product.productNumber,
      description: product.name,
      EAN: product.customFields?.eanColli || null,
      stock: (product.customFields?.stockB2B || 0) > 0,
      updatedAt: product.updatedAt,
      images: productImagesMap[product.id] || []
    }));

    // ✅ 7. Sort
    products.sort((a, b) => {
      return parseFloat(a.productNumber) - parseFloat(b.productNumber);
    });

    // ✅ 8. Filter
    let filteredProducts = products;

    if (productNumber) {
      filteredProducts = products.filter(
        (p) => p.productNumber === productNumber
      );
    } else if (limit > 0) {
      filteredProducts = products.slice(skip, skip + limit);
    }

    // ✅ 9. Return
    return new Response(JSON.stringify(filteredProducts), {
      headers: {
        "Content-Type": "application/json"
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