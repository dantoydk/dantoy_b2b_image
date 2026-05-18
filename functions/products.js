//const https = require('https');
//const querystring = require('querystring');

const axios = require('axios');

const shopwareApiUrl = 'https://shop.dantoy.dk/api';

const allowedOrigins = [
    'https://b2b-api-test.pages.dev/',
    "http://localhost:3000",
    "87.61.102.172",
    "80.62.116.17",
    "80.198.193.66"
  ]
  
  // A function that returns a set of CORS headers
const corsHeaders = origin => ({
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Origin': origin
  })

const checkOrigin = request => {
    const origin = request.headers.get("x-real-ip")
    const foundOrigin = allowedOrigins.includes(origin)
    console.log(`cors origin ${JSON.stringify(origin)}`)
    return foundOrigin
  }

function  checkAuth(list, header) {
    let foundAuth = false
    try {
        const parsedAuth = header.split(" ")[1]
        foundAuth = list.includes(parsedAuth)
    } catch (error) {
        console.error('Nonauthorized:', error);
    }

    return foundAuth
  }


async function getShopwareApiToken(id, secret) {
   
    try {
        const response = await axios.post(`${shopwareApiUrl}/oauth/token`, {
            grant_type: 'client_credentials',
            client_id: id,
            client_secret: secret
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Error obtaining API token:', error);
        throw new Error('Error obtaining API token');
    }
}
// let productsGlobal = []

// const pollingInterval = 10000; // 5 seconds in milliseconds
// const maxPollingDuration = 300000; // 300 seconds (5 minutes) in milliseconds

// async function pollApi(pollingInterval, maxPollingDuration, context) {
//     const startTime = Date.now(); // Record the start time
//     const clientId = context.env.client_id;
//     const clientSecret = context.env.client_secret;

//     const makeRequest = async () => {
//         try {
//             const token = await getShopwareApiToken(clientId, clientSecret);
//             const response = await axios.get(`${shopwareApiUrl}/product`, {
//             headers: {
//                 'Authorization': `Bearer ${token}`
//             }
//         });

//         // Extract product ID and custom fields
//             const products = response.data.data.map(product => ({
//             //id: product.id,
//             productNumber: parseInt(product.productNumber),
//             description: product.name,
//             width: product.width,
//             stock: ((product.customFields.stockB2B > 0) ? true : false)
            
//         }));
//         console.log('products received')
//         products.sort(function(a, b) {
//             return parseFloat(a.productNumber) - parseFloat(b.productNumber);
//         });
//         console.log('products sorted')
//         productsGlobal = products;
//         console.log('Request made.')
//         const elapsedTime = Date.now() - startTime;
        
//         if (elapsedTime < maxPollingDuration) {
//             setTimeout(makeRequest, pollingInterval); // Schedule next request
//         } else {
//             console.log('Maximum polling duration reached. Stopping polling.');
//         }
//         return
//         } catch (error) {
//             console.error('Error making API request:', error);
//             const elapsedTime = Date.now() - startTime;

//             if (elapsedTime < maxPollingDuration) {
//                 setTimeout(makeRequest, pollingInterval); // Schedule next request
//             } else {
//                 console.log('Maximum polling duration reached. Stopping polling.');
//             }
//         }
//     };

//     makeRequest(); // Start the first request
// }
// export default {
//     async fetch(request, env, context) {
//     productsGlobal = [1]
//     pollApi(pollingInterval,maxPollingDuration, context)
//     }
// }


export async function onRequest(context) {
    const {request} = context;
    const {method} = request;
    const clientId = context.env.client_id;
    const clientSecret = context.env.client_secret;
    const clientKey = context.env.client_key;
    const allowedKeys = [clientKey]
    const authHeader = request.headers.get("Authorization")
    const allowedOrigin = checkOrigin(request)
    const allowedAuth  = checkAuth(allowedKeys, authHeader)
    console.log(`allowed auth ${allowedAuth}`)
    console.log(`allowed origin ${allowedOrigin}`)
    // if (method === "OPTIONS") {
    //     // Check that the request's origin is a valid origin, allowed to access this API
    //     const allowedOrigin = checkOrigin(request)
    //     console.log(`check ${allowedOrigin}`)
    //     return new Response("OK", { headers: corsHeaders(allowedOrigin) })
    //   }
    
    if(method === "GET" && allowedOrigin === true) {
        let fail = 'Failed to fetch products';
        try {
            const token = await getShopwareApiToken(clientId, clientSecret);
            const response = await axios.get(`${shopwareApiUrl}/product`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            const url = new URL(request.url)
            const productNumber = url.searchParams.get('productNumber')
            const limit = parseInt(url.searchParams.get('limit')) || 0
            const skip = parseInt(url.searchParams.get('skip')) || 0
    
            // Extract product ID and custom fields
            const products = response.data.data.map(product => ({
                //id: product.id,
                productNumber: product.productNumber,
                description: product.name,

                EAN: product.customFields.eanColli,
                stock: ((product.customFields.stockB2B > 0) ? true : false),
                updatedAt: product.updatedAt
                
            }));
            products.sort(function(a, b) {
                return parseFloat(a.productNumber) - parseFloat(b.productNumber);
            });
            let filteredProducts = products
            if (productNumber) {
                filteredProducts = products.filter(product => product.productNumber === productNumber.toString())
                
              } else if (limit > 0) {
                filteredProducts = products.slice(skip, skip + limit)
              }
            // if (productsGlobal.length === 0) {
            //     console.log('running poll')
            //     pollApi(pollingInterval,maxPollingDuration, context)
            // }
            // const allowedOrigin = checkOrigin(request)
           return new Response(JSON.stringify(filteredProducts))
        } catch (error) {
            return new Response(fail.concat(" ",error),{
                status:404
            });
        }
    } else {
        return new Response(`Method or origin not allowed`,{
            status:500
        });
    }
}