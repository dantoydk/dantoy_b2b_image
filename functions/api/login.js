import { createJWT } from "../lib/jwt";

// ==========================
// ✅ LOGIN RATE LIMIT
// ==========================
const loginRateLimit = new Map();

function checkLoginRateLimit(ip, limit = 10, windowMs = 60000) {
  const now = Date.now();

  if (!loginRateLimit.has(ip)) {
    loginRateLimit.set(ip, { count: 1, start: now });
    return true;
  }

  const record = loginRateLimit.get(ip);

  if (now - record.start > windowMs) {
    loginRateLimit.set(ip, { count: 1, start: now });
    return true;
  }

  record.count++;
  return record.count <= limit;
}

// ==========================
// ✅ PASSWORD HASH (OPTIONAL but recommended)
// ==========================
async function hash(password) {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ==========================
// ✅ MAIN LOGIN HANDLER
// ==========================
export async function onRequestPost(context) {
  const { request, env } = context;

  const ip = request.headers.get("cf-connecting-ip");

  // ✅ Rate limit login attempts
  if (!checkLoginRateLimit(ip, 10, 60000)) {
    return new Response("Too Many Login Requests", { status: 429 });
  }

  try {
    const body = await request.json();

    // ✅ normalize username
    const username = body.username?.toLowerCase();
    const password = body.password;

    if (!username || !password) {
      return new Response("Missing username or password", { status: 400 });
    }

    // ✅ fetch stored password (from KV)
    const storedPassword = await env.B2B_IMAGE_USERS.get(username);

    if (!storedPassword) {
      return new Response("Invalid credentials", { status: 401 });
    }

    // =========================
    // ✅ PASSWORD CHECK
    // =========================

    // Option A — plain text (your current setup)
    let valid = storedPassword === password;

    // Option B — hashed (if you switch later)
    // const hashedInput = await hash(password);
    // let valid = storedPassword === hashedInput;

    if (!valid) {
      return new Response("Invalid credentials", { status: 401 });
    }

    // =========================
    // ✅ CREATE TOKEN
    // =========================
    const expiresIn = 600; // 10 minutes
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

    const token = await createJWT(
      { user: username },
      env.JWT_SECRET,
      expiresIn
    );

    return new Response(
      JSON.stringify({
        token,
        expires_in: expiresIn,
        expires_at: expiresAt
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  } catch (err) {
    console.error("LOGIN ERROR:", err);

    return new Response("Invalid request body", { status: 400 });
  }
}