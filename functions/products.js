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

// ✅ Main handler
export async function onRequest(context) {
  const { request, env } = context;
  const { method } = request;

  const clientId = env.client_id;
  const clientSecret = env.client_secret;
  const clientKey = env.client_key;

  const allowedKeys = [clientKey];
  const authHeader = request.headers.get("Authorization");

  const origin = checkOrigin(request);
  const allowedAuth = checkAuth(allowedKeys, authHeader);

  console.log(`Auth OK: ${allowedAuth}`);

  // ✅ Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response("OK", {
      headers: corsHeaders(origin || "*")
    });
  }

  // ✅ Only allow GET + valid origin + auth
  if (method === "GET" && allowedAuth) {
    try {
      const token = await getShopwareApiToken(clientId, clientSecret);

      const response = await fetch(`${shopwareApiUrl}/product`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error("API request failed");
      }

      const responseData = await response.json();

      const url = new URL(request.url);
      const productNumber = url.searchParams.get('productNumber');
      const limit = parseInt(url.searchParams.get('limit')) || 0;
      const skip = parseInt(url.searchParams.get('skip')) || 0;

      // ✅ Transform products
      const products = responseData.data.map(product => ({
        productNumber: product.productNumber,
        description: product.name,
        EAN: product.customFields?.eanColli || null,
        stock: (product.customFields?.stockB2B || 0) > 0,
        updatedAt: product.updatedAt
      }));

      // ✅ Sort
      products.sort((a, b) => parseFloat(a.productNumber) - parseFloat(b.productNumber));

      // ✅ Filtering
      let filteredProducts = products;

      if (productNumber) {
        filteredProducts = products.filter(p => p.productNumber === productNumber);
      } else if (limit > 0) {
        filteredProducts = products.slice(skip, skip + limit);
      }

      return new Response(JSON.stringify(filteredProducts), {
        headers: {
          ...corsHeaders(origin),
          'Content-Type': 'application/json'
        }
      });

    } catch (error) {
      return new Response(`Failed to fetch products: ${error.message}`, {
        status: 500,
        headers: corsHeaders(origin || "*")
      });
    }
  }

  return new Response('Unauthorized or invalid request', {
    status: 403,
    headers: corsHeaders(origin || "*")
  });
}