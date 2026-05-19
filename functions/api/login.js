
import { createJWT } from "../lib/jwt";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    // ✅ Normalize username (optional but recommended)
    const username = body.username?.toLowerCase();
    const password = body.password;

    if (!username || !password) {
      return new Response("Missing username or password", { status: 400 });
    }

    // ✅ Get user from KV (key = username, value = password)
    const storedPassword = await env.B2B_IMAGE_USERS.get(username);

    if (!storedPassword || storedPassword !== password) {
      return new Response("Invalid credentials", { status: 401 });
    }

    // ✅ Create JWT token (10 minutes expiry = 600 seconds)
    const token = await createJWT(
      { user: username },
      env.JWT_SECRET,
      600
    );

    // ✅ Return token
    return new Response(JSON.stringify({ token }), {
      headers: {
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);

    return new Response("Invalid request body", { status: 400 });
  }
}
